'use strict';
const express      = require('express');
const cors         = require('cors');
const multer       = require('multer');
const { exec } = require('child_process');
const fs           = require('fs');
const path         = require('path');
const https        = require('https');
const crypto       = require('crypto');
const { runBubblewrapWithAI } = require('./bubblewrap_ai');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

/* ── Dossier temporaire pour les builds ── */
const TMP = path.join(__dirname, 'tmp');
if (!fs.existsSync(TMP)) fs.mkdirSync(TMP, { recursive: true });

/* ── Multer (upload keystore optionnel) ── */
const upload = multer({ dest: path.join(TMP, 'uploads') });

/* ══════════════════════════════════════════
   UTILITAIRES
══════════════════════════════════════════ */

/** Fetch manifest.json depuis une URL PWA */
async function fetchManifest(pwaUrl) {
  return new Promise((resolve, reject) => {
    // On récupère d'abord la page HTML pour trouver le lien du manifest
    const url = new URL(pwaUrl);
    const get = url.protocol === 'https:' ? https.get : require('http').get;

    const reqOpts = { headers: { 'User-Agent': 'PWA2APK-Builder/1.0' }, timeout: 15000 };
    get(pwaUrl, reqOpts, (res) => {
      let html = '';
      res.on('data', d => html += d);
      res.on('end', () => {
        // Chercher <link rel="manifest" href="...">
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
    let outBuf = '';
    let errBuf = '';
    const proc = exec(cmd, {
      cwd,
      timeout: timeoutMs,
      maxBuffer: 20 * 1024 * 1024,
      env: {
        ...process.env,
        JAVA_HOME: '/opt/java/openjdk',
        ANDROID_HOME: '/opt/android-sdk',
        ANDROID_SDK_ROOT: '/opt/android-sdk',
        // Répondre "oui" automatiquement aux prompts Bubblewrap
        CI: 'true',
      }
    }, (err, stdout, stderr) => {
      if (err) {
        // Inclure stdout ET stderr pour un message d'erreur complet
        const msg = [stderr, stdout, err.message].filter(Boolean).join('\n').slice(0, 2000);
        reject(new Error(`Command failed: ${cmd.slice(0,80)}\n${msg}`));
      } else {
        resolve(stdout);
      }
    });
    proc.stdout?.on('data', d => { outBuf += d; process.stdout.write(d); });
    proc.stderr?.on('data', d => { errBuf += d; process.stderr.write(d); });
  });
}

/** Générer un keystore JKS avec keytool */
async function generateKeystore(dir, alias, password, dname) {
  const ksPath = path.join(dir, 'release.keystore');
  const cmd = [
    'keytool -genkeypair',
    `-alias "${alias}"`,
    `-keyalg RSA -keysize 2048`,
    `-validity 9125`,
    `-keystore "${ksPath}"`,
    `-storepass "${password}"`,
    `-keypass "${password}"`,
    `-dname "${dname}"`,
    '-noprompt'
  ].join(' ');
  await run(cmd, dir);
  return ksPath;
}

/* ══════════════════════════════════════════
   ROUTES
══════════════════════════════════════════ */

/** GET /api/analyze — analyser une PWA et retourner ses infos */
app.get('/api/analyze', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'URL manquante' });

  try {
    const { manifest, manifestUrl } = await fetchManifest(url);
    const domain   = new URL(url).hostname;
    const pkg      = domainToPackage(domain);
    const iconUrl  = bestIcon(manifest.icons, manifestUrl);

    res.json({
      ok: true,
      appName:     manifest.name || manifest.short_name || domain,
      shortName:   manifest.short_name || manifest.name || domain,
      packageName: pkg,
      themeColor:  manifest.theme_color || '#1a73e8',
      bgColor:     manifest.background_color || '#ffffff',
      startUrl:    manifest.start_url || '/',
      iconUrl,
      display:     manifest.display || 'standalone',
      description: manifest.description || '',
    });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

/** POST /api/build — construire l'APK signé */
app.post('/api/build', upload.single('keystore'), async (req, res) => {
  const jobId  = crypto.randomBytes(8).toString('hex');
  const jobDir = path.join(TMP, jobId);
  fs.mkdirSync(jobDir, { recursive: true });

  // Envoyer jobId immédiatement pour que le client puisse poller
  res.json({ ok: true, jobId });

  // Build asynchrone
  _buildJob(jobId, jobDir, req.body, req.file).catch(err => {
    _writeStatus(jobDir, { status: 'error', message: err.message });
    console.error('[Build Error]', err);
  });
});

/** GET /api/status/:jobId — vérifier l'avancement du build */
app.get('/api/status/:jobId', (req, res) => {
  const statusFile = path.join(TMP, req.params.jobId, 'status.json');
  if (!fs.existsSync(statusFile)) return res.json({ status: 'pending', message: 'En attente…' });
  res.json(JSON.parse(fs.readFileSync(statusFile, 'utf8')));
});

/** GET /api/download/:jobId — télécharger l'APK */
app.get('/api/download/:jobId', (req, res) => {
  const jobDir = path.join(TMP, req.params.jobId);
  const apk    = path.join(jobDir, 'app', 'app', 'build', 'outputs', 'apk', 'release', 'app-release.apk');
  const apkSigned = path.join(jobDir, 'app-signed.apk');

  const file = fs.existsSync(apkSigned) ? apkSigned
             : fs.existsSync(apk)       ? apk
             : null;

  if (!file) return res.status(404).json({ error: 'APK non trouvé' });

  const statusFile = path.join(jobDir, 'status.json');
  const status     = JSON.parse(fs.readFileSync(statusFile, 'utf8'));
  const filename   = (status.appName || 'app').replace(/[^a-z0-9]/gi, '_') + '.apk';

  res.download(file, filename);
});


/* ══════════════════════════════════════════
   BUILD JOB (asynchrone)
══════════════════════════════════════════ */

function _writeStatus(dir, data) {
  fs.writeFileSync(path.join(dir, 'status.json'), JSON.stringify(data));
}

async function _buildJob(jobId, jobDir, body, keystoreFile) {
  // Normaliser l'URL (supprimer slash final)
  body.pwaUrl = (body.pwaUrl || '').replace(/\/+$/, '');

  const {
    pwaUrl, appName, shortName, packageName,
    themeColor, bgColor, startUrl,
    // Keystore params
    ksAlias    = 'release',
    ksPassword = 'classepro2024',
    ksDname    = 'CN=ClassePro, OU=Apps, O=ClassePro, L=Abidjan, ST=Lagunes, C=CI',
    // Optionnel: version
    versionCode = '1',
    versionName = '1.0.0',
  } = body;

  try {
    /* ── Étape 1 : Valider les inputs + récupérer les icônes du manifest ── */
    _writeStatus(jobDir, { status: 'building', step: 1, message: '🔍 Validation des paramètres…', appName });
    if (!pwaUrl || !appName || !packageName) throw new Error('Paramètres manquants');

    // Récupérer les icônes depuis le vrai manifest
    let iconUrl512 = `${pwaUrl}/icon-512.png`; // fallback
    try {
      const { manifest: mf } = await fetchManifest(pwaUrl);
      const icons = mf.icons || [];
      const best  = bestIcon(icons, pwaUrl);
      if (best) iconUrl512 = best;
    } catch(e) { console.warn('Icône non récupérée:', e.message); }

    /* ── Étape 2 : Keystore ── */
    _writeStatus(jobDir, { status: 'building', step: 2, message: '🔑 Génération du keystore…', appName });
    let ksPath;
    if (keystoreFile && fs.existsSync(keystoreFile.path)) {
      ksPath = keystoreFile.path;
    } else {
      ksPath = await generateKeystore(jobDir, ksAlias, ksPassword, ksDname);
    }

    /* ── Étape 3 : Préparer le contexte pour bubblewrap ── */
    _writeStatus(jobDir, { status: 'building', step: 3, message: '📦 Initialisation du projet TWA…', appName });
    const appDir    = path.join(jobDir, 'app');
    const host      = new URL(pwaUrl).hostname;
    const cleanUrl  = pwaUrl.replace(/\/+$/, '');
    const manifestUrl = cleanUrl + '/manifest.json';
    fs.mkdirSync(appDir, { recursive: true });

    // Contexte complet passé à Claude pour répondre aux questions bubblewrap
    const bwContext = {
      domain:          host,
      startUrl:        startUrl || '/',
      appName:         appName,
      shortName:       shortName || appName,
      packageId:       packageName,
      themeColor:      themeColor || '#1a73e8',
      backgroundColor: bgColor || '#ffffff',
      iconUrl:         iconUrl512,
      versionName:     versionName,
      versionCode:     parseInt(versionCode),
      keystorePath:    ksPath,
      keystoreAlias:   ksAlias,
      keystorePassword: ksPassword,
      display:         'standalone',
      orientation:     'default',
    };

    /* ── Étape 4 : bubblewrap init piloté par l'IA Anthropic ── */
    _writeStatus(jobDir, { status: 'building', step: 4, message: '🤖 Génération du projet Android (IA)…', appName });
    await runBubblewrapWithAI(manifestUrl, appDir, bwContext, 180000);

    /* ── Étape 5 : Bubblewrap build ── */
    _writeStatus(jobDir, { status: 'building', step: 5, message: '⚙️ Compilation de l\'APK (2-5 min)…', appName });
    await run(`bubblewrap build --skipSigning`, appDir, 600000);

    /* ── Étape 6 : Signer l'APK avec apksigner ── */
    _writeStatus(jobDir, { status: 'building', step: 6, message: '✍️ Signature de l\'APK…', appName });

    // Bubblewrap génère l'APK dans app/build/outputs (structure Gradle standard)
    const unsignedApk = path.join(appDir, 'app', 'build', 'outputs', 'apk', 'release', 'app-release-unsigned.apk');
    const releasApk   = path.join(appDir, 'app', 'build', 'outputs', 'apk', 'release', 'app-release.apk');
    // Chemins alternatifs selon la version de Bubblewrap
    const altApk1 = path.join(appDir, 'build', 'outputs', 'apk', 'release', 'app-release.apk');
    const altApk2 = path.join(appDir, 'build', 'outputs', 'bundle', 'release', 'app-release.aab');
    const signedApk   = path.join(jobDir, 'app-signed.apk');

    // Chercher l'APK dans tous les emplacements possibles
    const srcApk = [unsignedApk, releasApk, altApk1].find(p => fs.existsSync(p)) || null;

    if (srcApk) {
      // Utiliser apksigner (Android Build Tools)
      const btPath = _findBuildTools();
      if (btPath) {
        await run(
          `"${path.join(btPath,'apksigner')}" sign --ks "${ksPath}" --ks-pass "pass:${ksPassword}" --ks-key-alias "${ksAlias}" --key-pass "pass:${ksPassword}" --out "${signedApk}" "${srcApk}"`,
          jobDir
        );
      } else {
        // Fallback: jarsigner
        await run(
          `jarsigner -verbose -sigalg SHA256withRSA -digestalg SHA-256 -keystore "${ksPath}" -storepass "${ksPassword}" -keypass "${ksPassword}" -signedjar "${signedApk}" "${srcApk}" "${ksAlias}"`,
          jobDir
        );
      }
    }

    /* ── Étape 7 : Copier le keystore pour que l'user puisse le télécharger ── */
    fs.copyFileSync(ksPath, path.join(jobDir, 'release.keystore'));

    _writeStatus(jobDir, {
      status: 'done',
      step: 7,
      message: '✅ APK signé et prêt !',
      appName,
      jobId,
    });

  } catch (err) {
    _writeStatus(jobDir, { status: 'error', message: err.message, appName });
    throw err;
  }
}

/** Trouver le dossier Android Build Tools */
function _findBuildTools() {
  const bases = [
    process.env.ANDROID_HOME,
    process.env.ANDROID_SDK_ROOT,
    path.join(process.env.HOME || '/root', 'Android/Sdk'),
    '/opt/android-sdk',
  ].filter(Boolean);

  for (const base of bases) {
    const btDir = path.join(base, 'build-tools');
    if (!fs.existsSync(btDir)) continue;
    const versions = fs.readdirSync(btDir).sort().reverse();
    if (versions.length) return path.join(btDir, versions[0]);
  }
  return null;
}

/* ── Download keystore ── */
app.get('/api/keystore/:jobId', (req, res) => {
  const ksFile = path.join(TMP, req.params.jobId, 'release.keystore');
  if (!fs.existsSync(ksFile)) return res.status(404).json({ error: 'Keystore non trouvé' });
  res.download(ksFile, 'release.keystore');
});

/* ── Cleanup job (après 2h) ── */
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

/* ── Health check ── */
app.get('/health', (_, res) => res.json({ ok: true, version: '1.0.0' }));

app.listen(PORT, () => console.log(`✅ PWA2APK Server running on port ${PORT}`));
