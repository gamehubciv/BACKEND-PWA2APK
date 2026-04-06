'use strict';
const express  = require('express');
const cors     = require('cors');
const multer   = require('multer');
const { exec, execSync } = require('child_process');
const fs       = require('fs');
const path     = require('path');
const https    = require('https');
const crypto   = require('crypto');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname)));

const TMP          = path.join(__dirname, 'tmp');
const JAVA_HOME    = '/opt/java/openjdk';
const ANDROID_HOME = '/opt/android-sdk';
const SDK_MANAGER  = `${ANDROID_HOME}/cmdline-tools/latest/bin/sdkmanager`;

if (!fs.existsSync(TMP)) fs.mkdirSync(TMP, { recursive: true });

const upload = multer({ dest: path.join(TMP, 'uploads') });

/* ══════════════════════════════════════════
   UTILITAIRES
══════════════════════════════════════════ */

async function fetchManifest(pwaUrl) {
  return new Promise((resolve, reject) => {
    const url = new URL(pwaUrl);
    const get = url.protocol === 'https:' ? https.get : require('http').get;
    get(pwaUrl, { headers: { 'User-Agent': 'PWA2APK/3.0' }, timeout: 15000 }, (res) => {
      let html = '';
      res.on('data', d => html += d);
      res.on('end', () => {
        const m = html.match(/<link[^>]+rel=["']manifest["'][^>]+href=["']([^"']+)["']/i)
               || html.match(/<link[^>]+href=["']([^"']+)["'][^>]+rel=["']manifest["']/i);
        if (!m) return reject(new Error('Manifest link introuvable dans la page HTML'));
        const mUrl = m[1].startsWith('http') ? m[1] : new URL(m[1], pwaUrl).href;
        get(mUrl, { headers: { 'User-Agent': 'PWA2APK/3.0' } }, (r2) => {
          let json = '';
          r2.on('data', d => json += d);
          r2.on('end', () => {
            try { resolve({ manifest: JSON.parse(json), manifestUrl: mUrl }); }
            catch(e) { reject(new Error('Manifest JSON invalide : ' + e.message)); }
          });
        }).on('error', reject);
      });
    }).on('error', reject);
  });
}

function domainToPackage(domain) {
  const clean = domain.replace(/^www\./, '').replace(/[^a-z0-9.]/gi, '_');
  const parts = clean.split('.').filter(Boolean).reverse();
  if (parts.length < 2) parts.push('app');
  return parts.map(p => /^\d/.test(p) ? 'a' + p : p).join('.').toLowerCase();
}

function bestIcon(icons, baseUrl) {
  if (!icons?.length) return null;
  const sorted = [...icons].sort((a, b) => {
    const sa = parseInt((a.sizes || '0x0').split('x')[0]) || 0;
    const sb = parseInt((b.sizes || '0x0').split('x')[0]) || 0;
    return sb - sa;
  });
  const ico = sorted[0];
  return ico.src.startsWith('http') ? ico.src : new URL(ico.src, baseUrl).href;
}

function findBuildTools() {
  const btDir = path.join(ANDROID_HOME, 'build-tools');
  if (!fs.existsSync(btDir)) return null;
  const versions = fs.readdirSync(btDir).filter(v => /^\d/.test(v)).sort().reverse();
  return versions.length ? path.join(btDir, versions[0]) : null;
}

function run(cmd, cwd, timeoutMs = 300000, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const env = {
      ...process.env,
      JAVA_HOME,
      ANDROID_HOME,
      ANDROID_SDK_ROOT: ANDROID_HOME,
      PATH: `${JAVA_HOME}/bin:${ANDROID_HOME}/cmdline-tools/latest/bin:${ANDROID_HOME}/platform-tools:${ANDROID_HOME}/build-tools/34.0.0:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`,
      ...extraEnv,
    };
    exec(cmd, { cwd, timeout: timeoutMs, maxBuffer: 50 * 1024 * 1024, env },
      (err, stdout, stderr) => {
        if (err) reject(new Error(`Command failed: ${cmd.slice(0, 80)}\n${[stderr, stdout, err.message].filter(Boolean).join('\n').slice(0, 4000)}`));
        else resolve(stdout);
      }
    );
  });
}

async function generateKeystore(dir, alias, password, dname) {
  const ksPath = path.join(dir, 'release.keystore');
  await run(
    `"${JAVA_HOME}/bin/keytool" -genkeypair -alias "${alias}" -keyalg RSA -keysize 2048 -validity 9125 -keystore "${ksPath}" -storepass "${password}" -keypass "${password}" -dname "${dname}" -noprompt`,
    dir
  );
  return ksPath;
}

function writeBubblewrapConfig() {
  const dir = path.join(process.env.HOME || '/root', '.bubblewrap');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({
    jdkPath:        JAVA_HOME,
    androidSdkPath: ANDROID_HOME,
    sdkManagerPath: SDK_MANAGER,
  }, null, 2));
}

/* ══════════════════════════════════════════
   ROUTES
══════════════════════════════════════════ */

app.get('/api/analyze', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'URL manquante' });
  try {
    const { manifest, manifestUrl } = await fetchManifest(url);
    const domain = new URL(url).hostname;
    res.json({
      ok: true,
      appName:     manifest.name || manifest.short_name || domain,
      shortName:   manifest.short_name || manifest.name || domain,
      packageName: domainToPackage(domain),
      themeColor:  manifest.theme_color || '#1a73e8',
      bgColor:     manifest.background_color || '#ffffff',
      startUrl:    manifest.start_url || '/',
      iconUrl:     bestIcon(manifest.icons, manifestUrl),
      display:     manifest.display || 'standalone',
      description: manifest.description || '',
    });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/build', upload.single('keystore'), async (req, res) => {
  const jobId  = crypto.randomBytes(8).toString('hex');
  const jobDir = path.join(TMP, jobId);
  fs.mkdirSync(jobDir, { recursive: true });
  res.json({ ok: true, jobId });
  _buildJob(jobId, jobDir, req.body, req.file).catch(err => {
    _writeStatus(jobDir, { status: 'error', message: err.message });
    console.error('[Build Error]', err.message);
  });
});

app.get('/api/status/:jobId', (req, res) => {
  const f = path.join(TMP, req.params.jobId, 'status.json');
  if (!fs.existsSync(f)) return res.json({ status: 'pending', message: 'En attente…' });
  res.json(JSON.parse(fs.readFileSync(f, 'utf8')));
});

app.get('/api/download/:jobId', (req, res) => {
  const jobDir = path.join(TMP, req.params.jobId);
  const candidates = [
    path.join(jobDir, 'app-signed.apk'),
    path.join(jobDir, 'app', 'app', 'build', 'outputs', 'apk', 'release', 'app-release-signed.apk'),
    path.join(jobDir, 'app', 'app', 'build', 'outputs', 'apk', 'release', 'app-release.apk'),
    path.join(jobDir, 'app', 'app', 'build', 'outputs', 'apk', 'release', 'app-release-unsigned.apk'),
  ];
  const file = candidates.find(p => fs.existsSync(p));
  if (!file) return res.status(404).json({ error: 'APK non trouvé' });
  const status = (() => { try { return JSON.parse(fs.readFileSync(path.join(jobDir, 'status.json'), 'utf8')); } catch { return {}; } })();
  res.download(file, (status.appName || 'app').replace(/[^a-z0-9]/gi, '_') + '.apk');
});

app.get('/api/keystore/:jobId', (req, res) => {
  const f = path.join(TMP, req.params.jobId, 'release.keystore');
  if (!fs.existsSync(f)) return res.status(404).json({ error: 'Keystore non trouvé' });
  res.download(f, 'release.keystore');
});

app.get('/health', (_, res) => res.json({ ok: true, version: '4.0.0' }));

/* ══════════════════════════════════════════
   BUILD JOB
══════════════════════════════════════════ */

function _writeStatus(dir, data) {
  fs.writeFileSync(path.join(dir, 'status.json'), JSON.stringify(data));
}

async function _buildJob(jobId, jobDir, body, keystoreFile) {
  body.pwaUrl = (body.pwaUrl || '').replace(/\/+$/, '');
  const {
    pwaUrl, appName, packageName,
    themeColor  = '#1a73e8',
    bgColor     = '#ffffff',
    startUrl    = '/',
    ksAlias     = 'release',
    ksPassword  = 'classepro2024',
    ksDname     = 'CN=ClassePro, OU=Apps, O=ClassePro, L=Abidjan, ST=Lagunes, C=CI',
    versionCode = '1',
    versionName = '1.0.0',
  } = body;
  const shortName = (body.shortName || appName).slice(0, 12);

  try {
    /* ── Étape 1 : Validation ── */
    _writeStatus(jobDir, { status: 'building', step: 1, message: '🔍 Validation…', appName });
    if (!pwaUrl || !appName || !packageName) throw new Error('pwaUrl, appName, packageName requis');
    const host     = new URL(pwaUrl).hostname;
    const cleanUrl = pwaUrl.replace(/\/+$/, '');

    let iconUrl = `${cleanUrl}/icon-512.png`;
    try {
      const { manifest: mf, manifestUrl: mUrl } = await fetchManifest(pwaUrl);
      const best = bestIcon(mf.icons || [], mUrl);
      if (best) iconUrl = best;
    } catch(e) { console.warn('[Build] Icône:', e.message); }

    /* ── Étape 2 : Keystore ── */
    _writeStatus(jobDir, { status: 'building', step: 2, message: '🔑 Génération du keystore…', appName });
    let ksPath = keystoreFile?.path && fs.existsSync(keystoreFile.path)
      ? keystoreFile.path
      : await generateKeystore(jobDir, ksAlias, ksPassword, ksDname);

    /* ── Étape 3 : twa-manifest.json + bubblewrap update ── */
    _writeStatus(jobDir, { status: 'building', step: 3, message: '📦 Génération du projet Android…', appName });
    writeBubblewrapConfig();

    const appDir = path.join(jobDir, 'app');
    fs.mkdirSync(appDir, { recursive: true });

    const twaManifest = {
      packageId:                    packageName,
      host,
      name:                         appName,
      launcherName:                 shortName,
      display:                      'standalone',
      orientation:                  'default',
      themeColor,
      themeColorDark:               themeColor,
      navigationColor:              themeColor,
      navigationColorDark:          '#000000',
      navigationDividerColor:       '#000000',
      navigationDividerColorDark:   '#000000',
      backgroundColor:              bgColor,
      enableNotifications:          false,
      startUrl:                     startUrl || '/',
      iconUrl,
      maskableIconUrl:              iconUrl,
      monochromeIconUrl:            '',
      appVersion:                   versionName,
      appVersionCode:               parseInt(versionCode, 10) || 1,
      signingKey: { path: ksPath, alias: ksAlias },
      splashScreenFadeOutDuration:  300,
      enableSiteSettingsShortcut:   true,
      isChromeOSOnly:               false,
      isMetaQuest:                  false,
      fullScopeUrl:                 `https://${host}/`,
      minSdkVersion:                19,
      targetSdkVersion:             34,
      generatorApp:                 'bubblewrap-cli',
      generatorAppVersion:          '1.21.0',
      shortcuts:                    [],
      features:                     {},
      alphaDependencies:            { enabled: false },
      enableSiteSettingsShortcutV2: false,
      webManifestUrl:               `${cleanUrl}/manifest.json`,
      fallbackType:                 'customtabs',
      shareTarget:                  null,
      launchUrl:                    startUrl || '/',
      hostName:                     host,
    };

    fs.writeFileSync(path.join(appDir, 'twa-manifest.json'), JSON.stringify(twaManifest, null, 2));

    // bubblewrap update — non-interactif, génère les fichiers Gradle
    await run(`bubblewrap update --skipVersionUpgrade --manifest="${path.join(appDir, 'twa-manifest.json')}"`, appDir, 120000);

    // Vérifier les fichiers Gradle
    const missing = ['build.gradle', 'settings.gradle', 'gradlew'].filter(f => !fs.existsSync(path.join(appDir, f)));
    if (missing.length) {
      throw new Error(`bubblewrap update incomplet. Manquants: ${missing.join(', ')}. Présents: ${fs.readdirSync(appDir).join(', ')}`);
    }

    /* ── Étape 4 : Écrire local.properties APRÈS update ── */
    _writeStatus(jobDir, { status: 'building', step: 4, message: '⚙️ Configuration Gradle…', appName });
    const localProps = `sdk.dir=${ANDROID_HOME}\n`;
    // Écrire dans tous les dossiers possibles où Gradle peut le chercher
    for (const d of [appDir, path.join(appDir, 'app'), jobDir]) {
      if (fs.existsSync(d)) fs.writeFileSync(path.join(d, 'local.properties'), localProps);
    }
    console.log('[Build] local.properties écrit dans', appDir);

    /* ── Étape 5 : Gradle directement (bypass bubblewrap build) ── */
    _writeStatus(jobDir, { status: 'building', step: 5, message: '⚙️ Compilation Gradle (3-6 min)…', appName });

    const gradlew = path.join(appDir, 'gradlew');
    fs.chmodSync(gradlew, '755');

    // Railway free tier = 512 MB RAM total.
    // Node.js prend ~100 MB → Gradle ne peut pas dépasser ~380 MB.
    // On désactive le daemon, on force un seul worker, on bride la JVM au maximum.
    const gradleProps = [
      'org.gradle.daemon=false',
      'org.gradle.jvmargs=-Xmx256m -Xms64m -XX:MaxMetaspaceSize=128m -XX:+TieredCompilation -XX:TieredStopAtLevel=1',
      'org.gradle.parallel=false',
      'org.gradle.workers.max=1',
      'org.gradle.configureondemand=false',
      'org.gradle.caching=false',
      'android.useAndroidX=true',
      'android.enableJetifier=true',
      'android.enableR8.fullMode=false',
      'kotlin.incremental=false',
    ].join('\n') + '\n';

    // Écrire gradle.properties à la racine du projet ET dans app/
    fs.writeFileSync(path.join(appDir, 'gradle.properties'), gradleProps);
    if (fs.existsSync(path.join(appDir, 'app'))) {
      fs.writeFileSync(path.join(appDir, 'app', 'gradle.properties'), gradleProps);
    }

    const gradleEnv = {
      GRADLE_OPTS: '-Xmx256m -Xms64m -XX:MaxMetaspaceSize=128m',
      JAVA_TOOL_OPTIONS: '-Xmx256m -Xms64m',
      _JAVA_OPTIONS: '-Xmx256m',
    };

    await run(
      `"${gradlew}" assembleRelease --no-daemon --no-parallel --max-workers=1 --no-build-cache`,
      appDir,
      720000,
      gradleEnv
    );

    /* ── Étape 6 : Signer l'APK ── */
    _writeStatus(jobDir, { status: 'building', step: 6, message: '✍️ Signature de l\'APK…', appName });

    // Chercher l'APK généré par Gradle
    const apkCandidates = [
      path.join(appDir, 'app', 'build', 'outputs', 'apk', 'release', 'app-release-unsigned.apk'),
      path.join(appDir, 'app', 'build', 'outputs', 'apk', 'release', 'app-release.apk'),
    ];
    const srcApk    = apkCandidates.find(p => fs.existsSync(p));
    const signedApk = path.join(jobDir, 'app-signed.apk');

    if (!srcApk) {
      // Lister tous les APKs générés pour debug
      let found = '';
      try { found = execSync(`find "${appDir}" -name "*.apk" 2>/dev/null`).toString(); } catch {}
      throw new Error(`Aucun APK trouvé après Gradle. APKs détectés:\n${found || 'aucun'}`);
    }

    const btPath = findBuildTools();
    if (btPath) {
      await run(
        `"${path.join(btPath, 'apksigner')}" sign --ks "${ksPath}" --ks-pass "pass:${ksPassword}" --ks-key-alias "${ksAlias}" --key-pass "pass:${ksPassword}" --out "${signedApk}" "${srcApk}"`,
        jobDir
      );
    } else {
      await run(
        `jarsigner -verbose -sigalg SHA256withRSA -digestalg SHA-256 -keystore "${ksPath}" -storepass "${ksPassword}" -keypass "${ksPassword}" -signedjar "${signedApk}" "${srcApk}" "${ksAlias}"`,
        jobDir
      );
    }

    /* ── Étape 7 : Finalisation ── */
    fs.copyFileSync(ksPath, path.join(jobDir, 'release.keystore'));
    _writeStatus(jobDir, { status: 'done', step: 7, message: '✅ APK signé et prêt !', appName, jobId });

  } catch (err) {
    _writeStatus(jobDir, { status: 'error', message: err.message, appName });
    throw err;
  }
}

/* ── Cleanup après 2h ── */
setInterval(() => {
  if (!fs.existsSync(TMP)) return;
  const now = Date.now();
  fs.readdirSync(TMP).forEach(dir => {
    const full = path.join(TMP, dir);
    try { if (now - fs.statSync(full).mtimeMs > 7200000) fs.rmSync(full, { recursive: true, force: true }); } catch {}
  });
}, 1800000);

app.listen(PORT, () => console.log(`✅ PWA2APK v4 running on port ${PORT}`));
