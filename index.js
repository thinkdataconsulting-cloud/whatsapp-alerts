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
    const { phone, product, quantity, supplier, threshold, orderId, orderld } = req.body;

    // Accepte orderId OU orderld
    const orderIdentifier = orderId || orderld;
    if (!phone || !product || quantity === undefined || !supplier || threshold === undefined || !orderIdentifier) {
      return res.status(400).json({
        status: 'error',
        message: `Données manquantes: ${Object.entries({ phone, product, quantity, supplier, threshold, orderIdentifier })
          .filter(([_, value]) => !value && value !== 0)
          .map(([key]) => key)
          .join(', ')}`
      });
    }

    // Utilise orderIdentifier dans la suite du code
    pendingOrders.set(orderIdentifier, { phone, product, quantity, supplier, threshold });
    // ... reste du code ...
  } catch (error) {
    console.error('❌ Erreur:', error);
    res.status(500).json({ error: error.message });
  }
});
// --- 4. DÉMARRAGE DU SERVEUR (TOUT À LA FIN) ---
const PORT = process.env.PORT || 8080;  // <-- Utilise le port 8080
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Serveur démarré sur http://localhost:${PORT}`);
  connectToWhatsApp();
});