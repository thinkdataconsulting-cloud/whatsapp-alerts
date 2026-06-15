// --- 1. DÉPENDANCES ET INITIALISATIONS ---
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const qrcode = require('qrcode');
const express = require('express');
const bodyParser = require('body-parser');
const pino = require('pino');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Fix pour "crypto is not defined"
if (!globalThis.crypto) {
  globalThis.crypto = {
    getRandomValues: (buffer) => crypto.randomBytes(buffer.length),
    subtle: crypto.webcrypto?.subtle || {
      digest: async (algorithm, data) => {
        const hash = crypto.createHash(algorithm.toLowerCase().replace('-', ''));
        hash.update(data);
        return new Uint8Array(hash.digest());
      },
    },
  };
}

// Initialise Express
const app = express();
app.use(bodyParser.json());
app.use(express.static('public'));

// Variables globales
let sock;
const pendingOrders = new Map();
let currentQRCode = null;

// --- 2. FONCTIONS UTILITAIRES ---
function cleanAuthFiles() {
  const authDir = path.join(__dirname, 'auth_info_baileys');
  if (fs.existsSync(authDir)) {
    fs.rmSync(authDir, { recursive: true, force: true });
    console.log('🧹 Anciennes sessions supprimées.');
  }
}

async function connectToWhatsApp() {
  try {
    cleanAuthFiles();
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
    const { version } = await fetchLatestBaileysVersion();

    sock = makeWASocket({
      auth: state,
      printQRInTerminal: false,
      logger: pino({ level: 'error' }),
      browser: ['WhatsApp Alerts Bot', 'Chrome', '1.0.0'],
      version: version,
    });

    sock.ev.on('creds.update', saveCreds);
    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;
      if (qr) {
        currentQRCode = await qrcode.toDataURL(qr, { width: 400, margin: 2 });
        console.log('\n🔴 NOUVEAU QR CODE GÉNÉRÉ 🔴');
      }
      if (connection === 'close') {
        const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
        if (shouldReconnect) {
          setTimeout(connectToWhatsApp, 5000);
        } else {
          cleanAuthFiles();
          setTimeout(connectToWhatsApp, 10000);
        }
      } else if (connection === 'open') {
        console.log('\n✅ CONNECTÉ À WHATSAPP ! ✅');
        currentQRCode = null;
      }
    });
  } catch (error) {
    console.error('❌ Erreur dans connectToWhatsApp :', error);
    setTimeout(connectToWhatsApp, 10000);
  }
}

// --- 3. ENDPOINTS ---
app.get('/', (req, res) => {
  res.status(200).json({
    status: 'success',
    message: 'Serveur WhatsApp Alerts en ligne.',
    whatsappConnected: !!sock,
    qrCodeAvailable: !!currentQRCode,
  });
});

app.get('/qrcode', (req, res) => {
  if (!currentQRCode) {
    return res.status(404).json({ status: 'error', message: 'Aucun QR code disponible.' });
  }
  const base64Data = currentQRCode.replace(/^data:image\/png;base64,/, '');
  const imgBuffer = Buffer.from(base64Data, 'base64');
  res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': imgBuffer.length });
  res.end(imgBuffer);
});

app.all('/send-order-alert', async (req, res) => {
  try {
    // --- DÉBOGAGE AVANCÉ ---
    console.log('🔍 HEADERS:', req.headers);
    console.log('🔍 BODY (raw):', req.body);
    console.log('🔍 BODY (string):', JSON.stringify(req.body));
    // --- FIN DÉBOGAGE ---

    if (req.method === 'GET') {
      return res.status(200).json({
        status: 'success',
        message: 'Endpoint OK. Utilise POST pour envoyer une alerte.',
        whatsappConnected: !!sock
      });
    }

    // Vérifie que req.body n'est pas vide
    if (!req.body || Object.keys(req.body).length === 0) {
      return res.status(400).json({
        status: 'error',
        message: 'Body vide ! Vérifie que tu envoies bien un JSON avec Content-Type: application/json'
      });
    }

    const { phone, product, quantity, supplier, threshold, orderld } = req.body;

    // Affiche les valeurs extraites
    console.log('🔍 Champs extraits:', { phone, product, quantity, supplier, threshold, orderld });

    if (!phone || !product || quantity === undefined || !supplier || threshold === undefined || !orderld) {
      return res.status(400).json({
        status: 'error',
        message: `Données manquantes: ${Object.entries({ phone, product, quantity, supplier, threshold, orderld })
          .filter(([_, value]) => !value && value !== 0)
          .map(([key]) => key)
          .join(', ')}`
      });
    }

    // ... reste du code ...
  } catch (error) {
    console.error('❌ Erreur dans /send-order-alert :', error);
    return res.status(500).json({
      status: 'error',
      message: error.message || 'Erreur interne du serveur'
    });
  }
});
// --- 4. DÉMARRAGE DU SERVEUR (TOUT À LA FIN) ---
const PORT = process.env.PORT || 8080;  // <-- Utilise le port 8080
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Serveur démarré sur http://localhost:${PORT}`);
  connectToWhatsApp();
});