'use strict';
const express  = require('express');
const cors     = require('cors');
const multer   = require('multer');
const { exec } = require('child_process');
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
    get(pwaUrl, { headers: { 'User-Agent': 'PWA2APK/2.0' }, timeout: 15000 }, (res) => {
      let html = '';
      res.on('data', d => html += d);
      res.on('end', () => {
        const m = html.match(/<link[^>]+rel=["']manifest["'][^>]+href=["']([^"']+)["']/i)
               || html.match(/<link[^>]+href=["']([^"']+)["'][^>]+rel=["']manifest["']/i);
        if (!m) return reject(new Error('Manifest link introuvable dans la page HTML'));
        const mUrl = m[1].startsWith('http') ? m[1] : new URL(m[1], pwaUrl).href;
        get(mUrl, { headers: { 'User-Agent': 'PWA2APK/2.0' } }, (r2) => {
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

function run(cmd, cwd, timeoutMs = 300000) {
  return new Promise((resolve, reject) => {
    exec(cmd, {
      cwd,
      timeout: timeoutMs,
      maxBuffer: 50 * 1024 * 1024,
      env: {
        ...process.env,
        JAVA_HOME,
        ANDROID_HOME,
        ANDROID_SDK_ROOT: ANDROID_HOME,
        // Variables d'env pour bypass les prompts de bubblewrap build
        BUBBLEWRAP_KEYSTORE_PASSWORD: '',
        BUBBLEWRAP_KEY_PASSWORD: '',
        PATH: `${JAVA_HOME}/bin:${ANDROID_HOME}/cmdline-tools/latest/bin:${ANDROID_HOME}/platform-tools:${ANDROID_HOME}/build-tools/34.0.0:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`,
      },
    }, (err, stdout, stderr) => {
      if (err) {
        const msg = [stderr, stdout, err.message].filter(Boolean).join('\n').slice(0, 4000);
        reject(new Error(`Command failed: ${cmd.slice(0, 80)}\n${msg}`));
      } else {
        resolve(stdout);
      }
    });
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

function findBuildTools() {
  const btDir = path.join(ANDROID_HOME, 'build-tools');
  if (!fs.existsSync(btDir)) return null;
  const versions = fs.readdirSync(btDir).filter(v => /^\d/.test(v)).sort().reverse();
  return versions.length ? path.join(btDir, versions[0]) : null;
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
      ok:          true,
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
  const statusFile = path.join(jobDir, 'status.json');
  const status = fs.existsSync(statusFile) ? JSON.parse(fs.readFileSync(statusFile, 'utf8')) : {};
  res.download(file, (status.appName || 'app').replace(/[^a-z0-9]/gi, '_') + '.apk');
});

app.get('/api/keystore/:jobId', (req, res) => {
  const f = path.join(TMP, req.params.jobId, 'release.keystore');
  if (!fs.existsSync(f)) return res.status(404).json({ error: 'Keystore non trouvé' });
  res.download(f, 'release.keystore');
});

app.get('/health', (_, res) => res.json({ ok: true, version: '3.0.0' }));

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
    _writeStatus(jobDir, { status: 'building', step: 1, message: '🔍 Validation des paramètres…', appName });
    if (!pwaUrl || !appName || !packageName) throw new Error('Paramètres manquants : pwaUrl, appName, packageName requis');

    const host     = new URL(pwaUrl).hostname;
    const cleanUrl = pwaUrl.replace(/\/+$/, '');

    // Récupérer l'icône
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

    /* ── Étape 3 : Config bubblewrap + twa-manifest.json ── */
    _writeStatus(jobDir, { status: 'building', step: 3, message: '📦 Préparation du projet TWA…', appName });

    writeBubblewrapConfig();

    const appDir = path.join(jobDir, 'app');
    fs.mkdirSync(appDir, { recursive: true });

    // twa-manifest.json — format exact de bubblewrap 1.21
    // Référence : https://github.com/GoogleChromeLabs/bubblewrap/blob/main/packages/core/src/lib/TwaManifest.ts
    const twaManifest = {
      packageId:                    packageName,
      host,
      name:                         appName,
      launcherName:                 shortName,
      display:                      'standalone',
      orientation:                  'default',
      themeColor:                   themeColor,
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
      signingKey: {
        path:  ksPath,
        alias: ksAlias,
      },
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

    fs.writeFileSync(
      path.join(appDir, 'twa-manifest.json'),
      JSON.stringify(twaManifest, null, 2)
    );

    // local.properties pour Gradle
    const localProps = `sdk.dir=${ANDROID_HOME}\n`;
    fs.writeFileSync(path.join(appDir, 'local.properties'), localProps);

    /* ── Étape 4 : bubblewrap update (génère les fichiers Gradle depuis twa-manifest.json) ── */
    // "update" est NON-INTERACTIF contrairement à "init".
    // Il régénère tout le projet Android depuis twa-manifest.json.
    _writeStatus(jobDir, { status: 'building', step: 4, message: '🔧 Génération du projet Android (bubblewrap update)…', appName });

    console.log('[Build] Lancement de bubblewrap update dans', appDir);
    await run(
      `bubblewrap update --skipVersionUpgrade --manifest="${appDir}"`,
      appDir,
      120000
    );

    // Vérifier que les fichiers Gradle ont bien été générés
    const gradleFiles = ['build.gradle', 'settings.gradle', 'gradlew'];
    const missing = gradleFiles.filter(f => !fs.existsSync(path.join(appDir, f)));
    if (missing.length > 0) {
      const files = fs.readdirSync(appDir).join(', ');
      throw new Error(
        `bubblewrap update n'a pas généré les fichiers Gradle attendus (manquants: ${missing.join(', ')}). ` +
        `Fichiers présents: ${files}`
      );
    }

    // Réécrire local.properties après update (update peut le recréer incorrectement)
    fs.writeFileSync(path.join(appDir, 'local.properties'), localProps);
    const innerApp = path.join(appDir, 'app');
    if (fs.existsSync(innerApp)) {
      fs.writeFileSync(path.join(innerApp, 'local.properties'), localProps);
    }

    /* ── Étape 5 : bubblewrap build ── */
    _writeStatus(jobDir, { status: 'building', step: 5, message: '⚙️ Compilation Gradle (3-6 min)…', appName });
    console.log('[Build] Lancement de bubblewrap build dans', appDir);

    // BUBBLEWRAP_KEYSTORE_PASSWORD et BUBBLEWRAP_KEY_PASSWORD permettent
    // de bypasser les prompts interactifs du build
    await run(
      `BUBBLEWRAP_KEYSTORE_PASSWORD="${ksPassword}" BUBBLEWRAP_KEY_PASSWORD="${ksPassword}" bubblewrap build --skipSigning`,
      appDir,
      600000
    );

    /* ── Étape 6 : Signer l'APK ── */
    _writeStatus(jobDir, { status: 'building', step: 6, message: '✍️ Signature de l\'APK…', appName });

    const apkCandidates = [
      path.join(appDir, 'app', 'build', 'outputs', 'apk', 'release', 'app-release-unsigned.apk'),
      path.join(appDir, 'app', 'build', 'outputs', 'apk', 'release', 'app-release.apk'),
      path.join(appDir, 'app-release-signed.apk'),
    ];
    const srcApk    = apkCandidates.find(p => fs.existsSync(p));
    const signedApk = path.join(jobDir, 'app-signed.apk');

    if (srcApk) {
      const btPath = findBuildTools();
      if (btPath) {
        await run(
          `"${path.join(btPath, 'apksigner')}" sign --ks "${ksPath}" --ks-pass "pass:${ksPassword}" --ks-key-alias "${ksAlias}" --key-pass "pass:${ksPassword}" --out "${signedApk}" "${srcApk}"`,
          jobDir
        );
        console.log('[Build] APK signé avec apksigner :', signedApk);
      } else {
        await run(
          `jarsigner -verbose -sigalg SHA256withRSA -digestalg SHA-256 -keystore "${ksPath}" -storepass "${ksPassword}" -keypass "${ksPassword}" -signedjar "${signedApk}" "${srcApk}" "${ksAlias}"`,
          jobDir
        );
        console.log('[Build] APK signé avec jarsigner :', signedApk);
      }
    } else {
      console.warn('[Build] Aucun APK trouvé pour signature, on cherche un APK déjà signé...');
    }

    /* ── Étape 7 : Finalisation ── */
    fs.copyFileSync(ksPath, path.join(jobDir, 'release.keystore'));
    _writeStatus(jobDir, { status: 'done', step: 7, message: '✅ APK prêt !', appName, jobId });

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
    try {
      if (Date.now() - fs.statSync(full).mtimeMs > 7200000) {
        fs.rmSync(full, { recursive: true, force: true });
      }
    } catch {}
  });
}, 1800000);

app.listen(PORT, () => console.log(`✅ PWA2APK v3 running on port ${PORT}`));
