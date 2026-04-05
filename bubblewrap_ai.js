/**
 * bubblewrap_ai.js
 * 
 * Lance bubblewrap init dans un pseudo-terminal (PTY),
 * lit chaque question interactive, et utilise l'API Anthropic
 * pour générer la bonne réponse automatiquement.
 */

'use strict';
const pty    = require('node-pty');
const https  = require('https');

/**
 * Appelle l'API Anthropic pour déterminer la réponse à une question bubblewrap.
 * @param {string} question - Le prompt affiché par bubblewrap
 * @param {object} context  - Les paramètres connus (appName, host, etc.)
 * @returns {Promise<string>} - La réponse à taper (sans \n)
 */
function askClaude(question, context) {
  return new Promise((resolve, reject) => {
    const systemPrompt = `Tu es un assistant qui répond aux questions interactives de l'outil CLI "bubblewrap" (Google Trusted Web Activities).
Ton rôle est de retourner UNIQUEMENT la valeur à saisir, sans explication, sans guillemets, sans ponctuation finale.
Si la question propose une valeur par défaut entre parenthèses, retourne cette valeur par défaut sauf si le contexte fourni donne une meilleure valeur.
Règles importantes :
- Pour "Domain" : retourne toujours le hostname sans https:// ni slash
- Pour "Application name" : retourne le nom complet de l'app
- Pour "Short name" : retourne le short name (max 12 chars)
- Pour "Package ID" : retourne l'identifiant Android (ex: com.example.app)
- Pour "Start URL" : retourne le chemin relatif (ex: / ou /app/)
- Pour "Display mode" : retourne "standalone"
- Pour "Orientation" : retourne "default"
- Pour "Theme color" : retourne le code hex (ex: #3D3B8E)
- Pour "Background color" : retourne le code hex (ex: #ffffff)
- Pour "version" ou "versionName" : retourne la version (ex: 1.0.0)
- Pour "versionCode" : retourne un entier (ex: 1)
- Pour toute question de confirmation (y/N ou Y/n) : retourne "y"
- Pour les questions sur les icônes : retourne l'URL fournie dans le contexte
- Pour les questions sur le keystore/signing : retourne les valeurs du contexte`;

    const userPrompt = `Contexte de l'application :
${JSON.stringify(context, null, 2)}

Question posée par bubblewrap :
"${question}"

Réponds avec UNIQUEMENT la valeur à saisir.`;

    const body = JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 100,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
    });

    const req = https.request({
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'anthropic-version': '2023-06-01',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'Content-Length': Buffer.byteLength(body),
      },
    }, (res) => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          const answer = parsed.content?.[0]?.text?.trim() || '';
          console.log(`[AI] Q: "${question.slice(0,80)}" → A: "${answer}"`);
          resolve(answer);
        } catch(e) {
          reject(new Error('Anthropic parse error: ' + e.message));
        }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

/**
 * Détecte si le buffer de sortie contient une question bubblewrap.
 * Retourne la question nettoyée ou null.
 */
function extractQuestion(buffer) {
  // Nettoyer les codes ANSI/escape
  const clean = buffer
    .replace(/\x1b\[[0-9;]*[mGKHFJA-Za-z]/g, '')
    .replace(/\r/g, '')
    .trim();

  // Patterns de questions bubblewrap
  const patterns = [
    /\?\s+(.+?):\s*(?:\([^)]*\))?\s*$/m,   // ? Question: (default)
    /\?\s+(.+?)\s*\(([^)]+)\)\s*$/m,         // ? Question (default)
    />\s+(.+?):\s*$/m,                         // > Question:
  ];

  for (const p of patterns) {
    const m = clean.match(p);
    if (m) return clean.split('\n').filter(l => l.includes('?') || l.includes('>')).pop()?.replace(/^[?>\s]+/, '').trim();
  }

  // Détection simple : ligne se terminant par ":" ou "?" sans être une info
  const lines = clean.split('\n').filter(Boolean);
  const last = lines[lines.length - 1] || '';
  if (/[?:]\s*$/.test(last) && !last.startsWith('✔') && !last.startsWith('✓') && !last.startsWith('-')) {
    return last.replace(/^[?>\s]+/, '').trim();
  }

  return null;
}

/**
 * Lance bubblewrap init en mode PTY avec réponses AI automatiques.
 * 
 * @param {string} manifestUrl  - URL du manifest.json
 * @param {string} directory    - Dossier de sortie du projet Android
 * @param {object} context      - Paramètres connus (appName, host, packageName, etc.)
 * @param {number} timeoutMs    - Timeout global en ms (défaut: 3 min)
 * @returns {Promise<void>}
 */
function runBubblewrapWithAI(manifestUrl, directory, context, timeoutMs = 180000) {
  return new Promise((resolve, reject) => {
    if (!process.env.ANTHROPIC_API_KEY) {
      return reject(new Error('ANTHROPIC_API_KEY manquante dans les variables d\'environnement'));
    }

    console.log('[BubblewrapAI] Démarrage bubblewrap init...');

    const proc = pty.spawn('bubblewrap', [
      'init',
      `--manifest=${manifestUrl}`,
      `--directory=${directory}`,
      '--skipPwaValidation',
    ], {
      name: 'xterm-color',
      cols: 220,
      rows: 30,
      cwd: directory,
      env: {
        ...process.env,
        JAVA_HOME: '/opt/java/openjdk',
        ANDROID_HOME: '/opt/android-sdk',
        ANDROID_SDK_ROOT: '/opt/android-sdk',
        TERM: 'xterm',
      },
    });

    let outputBuffer = '';
    let answering    = false;
    let finished     = false;
    let lastDataTime = Date.now();

    // Timeout global
    const globalTimer = setTimeout(() => {
      if (!finished) {
        finished = true;
        proc.kill();
        reject(new Error('bubblewrap init timeout après ' + (timeoutMs/1000) + 's'));
      }
    }, timeoutMs);

    // Timeout d'inactivité (2s sans nouveau output = question en attente)
    const inactivityCheck = setInterval(async () => {
      if (finished || answering) return;
      if (Date.now() - lastDataTime < 1500) return;
      if (!outputBuffer.trim()) return;

      const question = extractQuestion(outputBuffer);
      if (!question) return;

      answering = true;
      outputBuffer = ''; // reset buffer

      try {
        const answer = await askClaude(question, context);
        // Envoyer la réponse + Entrée au PTY
        proc.write(answer + '\r');
      } catch(e) {
        console.error('[BubblewrapAI] Erreur AI:', e.message);
        // En cas d'erreur AI, on appuie juste sur Entrée (valeur par défaut)
        proc.write('\r');
      } finally {
        answering = false;
      }
    }, 500);

    proc.onData((data) => {
      process.stdout.write(data); // log en console Railway
      outputBuffer += data;
      lastDataTime = Date.now();
    });

    proc.onExit(({ exitCode }) => {
      if (finished) return;
      finished = true;
      clearTimeout(globalTimer);
      clearInterval(inactivityCheck);

      if (exitCode === 0) {
        console.log('[BubblewrapAI] ✅ bubblewrap init terminé avec succès');
        resolve();
      } else {
        reject(new Error(`bubblewrap init a échoué (exit code ${exitCode})\nDernier output: ${outputBuffer.slice(-500)}`));
      }
    });
  });
}

module.exports = { runBubblewrapWithAI };
