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

/* ── Dossier temporaire pour les builds ── */
const TMP = path.join(__dirname, 'tmp');
if (!fs.existsSync(TMP)) fs.mkdirSync(TMP, { recursive: true });

/* ── Multer (upload keystore optionnel) ── */
const upload = multer({ dest: path.join(TMP, 'uploads') });

/* ── Constantes SDK ── */
const JAVA_HOME    = '/opt/java/openjdk';
const ANDROID_HOME = '/opt/android-sdk';

/* ══════════════════════════════════════════
   UTILITAIRES
══════════════════════════════════════════ */

/** Fetch manifest.json depuis une URL PWA */
async function fetchManifest(pwaUrl) {
  return new Promise((resolve, reject) => {
    const url = new URL(pwaUrl);
    const get = url.protocol === 'https:' ? https.get : require('http').get;
    const reqOpts = { headers: { 'User-Agent': 'PWA2APK-Builder/1.0' }, timeout: 15000 };

    get(pwaUrl, reqOpts, (res) => {
      let html = '';
      res.on('data', d => html += d);
      res.on('end', () => {
        const match = html.match(/<link[^>]+rel=["']manifest["'][^>]+href=["']([^"']+)["']/i)
                   || html.match(/<link[^>]+href=["']([^"']+)["'][^>]+rel=["']manifest["']/i);
        if (!match) { reject(new Error('Manifest introuvable dans la page HTML')); return; }

        const manifestHref = match[1];
        const manifestUrl  = manifestHref.startsWith('http')
          ? manifestHref
          : new URL(manifestHref, pwaUrl).href;

        get(manifestUrl, { headers: { 'User-Agent': 'PWA2APK-Builder/1.0' } }, (r2) => {
          let json = '';
          r2.on('data', d => json += d);
          r2.on('end', () => {
            try { resolve({ manifest: JSON.parse(json), manifestUrl }); }
            catch(e) { reject(new Error('Manifest JSON invalide : ' + e.message)); }
          });
        }).on('error', reject);
      });
    }).on('error', reject);
  });
}

/** Générer un package name Android à partir d'un domaine */
function domainToPackage(domain) {
  const clean = domain.replace(/^www\./, '').replace(/[^a-z0-9.]/gi, '_');
  const parts = clean.split('.').filter(Boolean).reverse();
  if (parts.length < 2) parts.push('app');
  return parts.map(p => /^\d/.test(p) ? 'a' + p : p).join('.').toLowerCase();
}

/** Trouver la meilleure icône (la plus grande) */
function bestIcon(icons, baseUrl) {
  if (!icons || !icons.length) return null;
  const sorted = [...icons].sort((a, b) => {
    const sa = parseInt((a.sizes || '0x0').split('x')[0]) || 0;
    const sb = parseInt((b.sizes || '0x0').split('x')[0]) || 0;
    return sb - sa;
  });
  const icon = sorted[0];
  return icon.src.startsWith('http') ? icon.src : new URL(icon.src, baseUrl).href;
}

/** Exécuter une commande shell avec Promise */
function run(cmd, cwd, timeoutMs = 300000) {
  return new Promise((resolve, reject) => {
    const proc = exec(cmd, {
      cwd,
      timeout: timeoutMs,
      maxBuffer: 50 * 1024 * 1024,
      env: {
        ...process.env,
        JAVA_HOME,
        ANDROID_HOME,
        ANDROID_SDK_ROOT: ANDROID_HOME,
        PATH: `${JAVA_HOME}/bin:${ANDROID_HOME}/cmdline-tools/latest/bin:${ANDROID_HOME}/platform-tools:${ANDROID_HOME}/build-tools/34.0.0:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`,
      },
    }, (err, stdout, stderr) => {
      if (err) {
        const msg = [stderr, stdout, err.message].filter(Boolean).join('\n').slice(0, 3000);
        reject(new Error(`Command failed: ${cmd.slice(0, 80)}\n${msg}`));
      } else {
        resolve(stdout);
      }
    });
    proc.stdout?.on('data', d => process.stdout.write(d));
    proc.stderr?.on('data', d => process.stderr.write(d));
  });
}

/** Générer un keystore JKS avec keytool */
async function generateKeystore(dir, alias, password, dname) {
  const ksPath = path.join(dir, 'release.keystore');
  const cmd = [
    `${JAVA_HOME}/bin/keytool -genkeypair`,
    `-alias "${alias}"`,
    `-keyalg RSA -keysize 2048`,
    `-validity 9125`,
    `-keystore "${ksPath}"`,
    `-storepass "${password}"`,
    `-keypass "${password}"`,
    `-dname "${dname}"`,
    '-noprompt',
  ].join(' ');
  await run(cmd, dir);
  return ksPath;
}

/** Trouver le dossier Android Build Tools */
function findBuildTools() {
  const btDir = path.join(ANDROID_HOME, 'build-tools');
  if (!fs.existsSync(btDir)) return null;
  const versions = fs.readdirSync(btDir).filter(v => /^\d/.test(v)).sort().reverse();
  return versions.length ? path.join(btDir, versions[0]) : null;
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
  const statusFile = path.join(TMP, req.params.jobId, 'status.json');
  if (!fs.existsSync(statusFile)) return res.json({ status: 'pending', message: 'En attente…' });
  res.json(JSON.parse(fs.readFileSync(statusFile, 'utf8')));
});

app.get('/api/download/:jobId', (req, res) => {
  const jobDir    = path.join(TMP, req.params.jobId);
  const candidates = [
    path.join(jobDir, 'app-signed.apk'),
    path.join(jobDir, 'app', 'app', 'build', 'outputs', 'apk', 'release', 'app-release.apk'),
    path.join(jobDir, 'app', 'app', 'build', 'outputs', 'apk', 'release', 'app-release-unsigned.apk'),
  ];
  const file = candidates.find(p => fs.existsSync(p));
  if (!file) return res.status(404).json({ error: 'APK non trouvé' });

  const statusFile = path.join(jobDir, 'status.json');
  const status     = fs.existsSync(statusFile) ? JSON.parse(fs.readFileSync(statusFile, 'utf8')) : {};
  const filename   = (status.appName || 'app').replace(/[^a-z0-9]/gi, '_') + '.apk';
  res.download(file, filename);
});

app.get('/api/keystore/:jobId', (req, res) => {
  const ksFile = path.join(TMP, req.params.jobId, 'release.keystore');
  if (!fs.existsSync(ksFile)) return res.status(404).json({ error: 'Keystore non trouvé' });
  res.download(ksFile, 'release.keystore');
});

/* ══════════════════════════════════════════
   BUILD JOB
══════════════════════════════════════════ */

function _writeStatus(dir, data) {
  fs.writeFileSync(path.join(dir, 'status.json'), JSON.stringify(data));
}

async function _buildJob(jobId, jobDir, body, keystoreFile) {
  body.pwaUrl = (body.pwaUrl || '').replace(/\/+$/, '');

  const {
    pwaUrl, appName, shortName, packageName,
    themeColor = '#1a73e8', bgColor = '#ffffff', startUrl = '/',
    ksAlias    = 'release',
    ksPassword = 'classepro2024',
    ksDname    = 'CN=ClassePro, OU=Apps, O=ClassePro, L=Abidjan, ST=Lagunes, C=CI',
    versionCode = '1',
    versionName = '1.0.0',
  } = body;

  try {
    /* ── Étape 1 : Validation ── */
    _writeStatus(jobDir, { status: 'building', step: 1, message: '🔍 Validation des paramètres…', appName });
    if (!pwaUrl || !appName || !packageName) throw new Error('Paramètres manquants : pwaUrl, appName, packageName requis');

    /* ── Étape 1b : Récupérer l'icône ── */
    let iconUrl = `${pwaUrl}/icon-512.png`;
    try {
      const { manifest: mf, manifestUrl: mUrl } = await fetchManifest(pwaUrl);
      const best = bestIcon(mf.icons || [], mUrl);
      if (best) iconUrl = best;
    } catch(e) { console.warn('[Build] Icône non récupérée:', e.message); }

    /* ── Étape 2 : Keystore ── */
    _writeStatus(jobDir, { status: 'building', step: 2, message: '🔑 Génération du keystore…', appName });
    let ksPath;
    if (keystoreFile && fs.existsSync(keystoreFile.path)) {
      ksPath = keystoreFile.path;
    } else {
      ksPath = await generateKeystore(jobDir, ksAlias, ksPassword, ksDname);
    }

    /* ── Étape 3 : Écrire la config bubblewrap ── */
    _writeStatus(jobDir, { status: 'building', step: 3, message: '📦 Configuration de l\'environnement…', appName });

    // Config globale bubblewrap (~/.bubblewrap/config.json)
    const bwConfigDir = path.join(process.env.HOME || '/root', '.bubblewrap');
    fs.mkdirSync(bwConfigDir, { recursive: true });
    fs.writeFileSync(path.join(bwConfigDir, 'config.json'), JSON.stringify({
      jdkPath:        JAVA_HOME,
      androidSdkPath: ANDROID_HOME,
      sdkManagerPath: `${ANDROID_HOME}/cmdline-tools/latest/bin/sdkmanager`,
    }, null, 2));

    /* ── Étape 4 : Construire twa-manifest.json MANUELLEMENT ── */
    // C'est la clé : on contourne totalement bubblewrap init (qui est interactif)
    // en écrivant directement le fichier que bubblewrap build attend.
    _writeStatus(jobDir, { status: 'building', step: 4, message: '🔧 Génération du projet Android (TWA)…', appName });

    const appDir    = path.join(jobDir, 'app');
    const host      = new URL(pwaUrl).hostname;
    const cleanUrl  = pwaUrl.replace(/\/+$/, '');
    const shortNameSafe = (shortName || appName).slice(0, 12);
    fs.mkdirSync(appDir, { recursive: true });

    // twa-manifest.json — format exact attendu par bubblewrap 1.21
    const twaManifest = {
      packageId:              packageName,
      host,
      name:                   appName,
      launcherName:           shortNameSafe,
      display:                'standalone',
      orientation:            'default',
      themeColor:             themeColor || '#1a73e8',
      navigationColor:        themeColor || '#1a73e8',
      navigationColorDark:    themeColor || '#1a73e8',
      navigationDividerColor: '#000000',
      navigationDividerColorDark: '#000000',
      backgroundColor:        bgColor || '#ffffff',
      enableNotifications:    false,
      startUrl:               startUrl || '/',
      iconUrl,
      maskableIconUrl:        iconUrl,
      monochromeIconUrl:      '',
      appVersion:             versionName,
      appVersionCode:         parseInt(versionCode, 10) || 1,
      signingKey: {
        path:  ksPath,
        alias: ksAlias,
      },
      splashScreenFadeOutDuration: 300,
      enableSiteSettingsShortcut:  true,
      isChromeOSOnly:              false,
      isMetaQuest:                 false,
      fullScopeUrl:                `https://${host}/`,
      minSdkVersion:               19,
      targetSdkVersion:            34,
      generatorApp:                'bubblewrap-cli',
      generatorAppVersion:         '1.21.0',
      shortcuts:                   [],
      features:                    {},
      alphaDependencies:           { enabled: false },
      enableSiteSettingsShortcutV2: false,
      webManifestUrl:              `${cleanUrl}/manifest.json`,
    };

    fs.writeFileSync(
      path.join(appDir, 'twa-manifest.json'),
      JSON.stringify(twaManifest, null, 2)
    );

    // local.properties — Gradle a besoin de sdk.dir
    const localProps = `sdk.dir=${ANDROID_HOME}\n`;
    fs.writeFileSync(path.join(appDir, 'local.properties'), localProps);

    // Lancer bubblewrap init avec --manifest pour générer les fichiers Gradle
    // (build.gradle, settings.gradle, gradle wrapper, etc.)
    const manifestJsonUrl = `${cleanUrl}/manifest.json`;
    console.log('[Build] Lancement bubblewrap init --directory=' + appDir);
    try {
      // On tente d'abord avec --directory si la version le supporte
      await run(
        `bubblewrap init --manifest="${manifestJsonUrl}" --directory="${appDir}" --skipPwaValidation`,
        appDir,
        120000
      );
    } catch (initErr) {
      console.warn('[Build] bubblewrap init a retourné une erreur (probablement interactif), on continue :', initErr.message.slice(0, 200));
    }

    // Que bubblewrap init ait réussi ou échoué, on ré-écrit twa-manifest.json
    // et local.properties car init peut les avoir écrasés avec de mauvaises valeurs
    fs.writeFileSync(
      path.join(appDir, 'twa-manifest.json'),
      JSON.stringify(twaManifest, null, 2)
    );
    fs.writeFileSync(path.join(appDir, 'local.properties'), localProps);

    // Vérifier que les fichiers Gradle essentiels ont été générés
    const gradleFile = path.join(appDir, 'build.gradle');
    const settingsFile = path.join(appDir, 'settings.gradle');
    if (!fs.existsSync(gradleFile) || !fs.existsSync(settingsFile)) {
      throw new Error(
        'bubblewrap init n\'a pas généré les fichiers Gradle. ' +
        'Vérifiez que la cmdline-tools version 9477386 est installée et que le SDK est valide. ' +
        'Fichiers dans appDir: ' + fs.readdirSync(appDir).join(', ')
      );
    }

    // Réécrire local.properties dans le sous-dossier app/ de Gradle (généré par init)
    const innerAppDir = path.join(appDir, 'app');
    if (fs.existsSync(innerAppDir)) {
      fs.writeFileSync(path.join(innerAppDir, 'local.properties'), localProps);
    }

    /* ── Étape 5 : bubblewrap build ── */
    _writeStatus(jobDir, { status: 'building', step: 5, message: '⚙️ Compilation de l\'APK (3-6 min)…', appName });
    await run(`bubblewrap build --skipSigning`, appDir, 600000);

    /* ── Étape 6 : Signer l'APK ── */
    _writeStatus(jobDir, { status: 'building', step: 6, message: '✍️ Signature de l\'APK…', appName });

    const apkCandidates = [
      path.join(appDir, 'app', 'build', 'outputs', 'apk', 'release', 'app-release-unsigned.apk'),
      path.join(appDir, 'app', 'build', 'outputs', 'apk', 'release', 'app-release.apk'),
      path.join(appDir, 'build', 'outputs', 'apk', 'release', 'app-release.apk'),
    ];
    const srcApk   = apkCandidates.find(p => fs.existsSync(p));
    const signedApk = path.join(jobDir, 'app-signed.apk');

    if (srcApk) {
      const btPath = findBuildTools();
      if (btPath) {
        const apksigner = path.join(btPath, 'apksigner');
        await run(
          `"${apksigner}" sign --ks "${ksPath}" --ks-pass "pass:${ksPassword}" --ks-key-alias "${ksAlias}" --key-pass "pass:${ksPassword}" --out "${signedApk}" "${srcApk}"`,
          jobDir
        );
      } else {
        await run(
          `jarsigner -verbose -sigalg SHA256withRSA -digestalg SHA-256 -keystore "${ksPath}" -storepass "${ksPassword}" -keypass "${ksPassword}" -signedjar "${signedApk}" "${srcApk}" "${ksAlias}"`,
          jobDir
        );
      }
    } else {
      console.warn('[Build] Aucun APK trouvé pour signature — APK unsigned utilisé directement');
    }

    /* ── Étape 7 : Finalisation ── */
    fs.copyFileSync(ksPath, path.join(jobDir, 'release.keystore'));

    _writeStatus(jobDir, {
      status:  'done',
      step:    7,
      message: '✅ APK signé et prêt !',
      appName,
      jobId,
    });

  } catch (err) {
    _writeStatus(jobDir, { status: 'error', message: err.message, appName });
    throw err;
  }
}

/* ── Cleanup (après 2h) ── */
setInterval(() => {
  if (!fs.existsSync(TMP)) return;
  const now = Date.now();
  fs.readdirSync(TMP).forEach(dir => {
    const full = path.join(TMP, dir);
    try {
      const stat = fs.statSync(full);
      if (now - stat.mtimeMs > 2 * 60 * 60 * 1000) {
        fs.rmSync(full, { recursive: true, force: true });
      }
    } catch {}
  });
}, 30 * 60 * 1000);

/* ── Servir index.html ── */
app.use(express.static(path.join(__dirname)));

/* ── Health check ── */
app.get('/health', (_, res) => res.json({ ok: true, version: '2.0.0' }));

app.listen(PORT, () => console.log(`✅ PWA2APK Server running on port ${PORT}`));
