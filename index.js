const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const express = require('express');
const qrcode = require('qrcode');
const pino = require('pino');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Polyfill pour environnement crypto
if (!globalThis.crypto) {
  globalThis.crypto = {
    getRandomValues: (buffer) => crypto.randomBytes(buffer.length),
    subtle: crypto.webcrypto.subtle
  };
}

const app = express();
app.use(express.json({ limit: '10mb' }));

const PORT = process.env.PORT || 8080;
const AUTH_DIR = path.join(process.cwd(), 'auth_info_baileys');

let sock = null;
let isWhatsAppConnected = false;
let currentQRCode = null;

function cleanAuthFiles() {
  try { if (fs.existsSync(AUTH_DIR)) fs.rmSync(AUTH_DIR, { recursive: true, force: true }); } 
  catch (error) { console.error('Erreur nettoyage session :', error.message); }
}

async function connectToWhatsApp() {
  try {
    if (!fs.existsSync(AUTH_DIR)) fs.mkdirSync(AUTH_DIR, { recursive: true });
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    const { version } = await fetchLatestBaileysVersion();

    sock = makeWASocket({
      auth: state,
      version,
      printQRInTerminal: false,
      logger: pino({ level: 'silent' }),
      browser: ['Stock Alert Bot', 'Chrome', '1.0.0']
    });

    sock.ev.on('creds.update', saveCreds);
    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;
      if (qr) currentQRCode = await qrcode.toDataURL(qr, { width: 400, margin: 2 });
      if (connection === 'open') { isWhatsAppConnected = true; currentQRCode = null; }
      if (connection === 'close') {
        isWhatsAppConnected = false;
        const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
        if (shouldReconnect) setTimeout(connectToWhatsApp, 5000);
        else { cleanAuthFiles(); setTimeout(connectToWhatsApp, 10000); }
      }
    });
  } catch (error) { console.error('Erreur connexion :', error.message); setTimeout(connectToWhatsApp, 10000); }
}

app.get('/qr', (req, res) => {
  if (isWhatsAppConnected) return res.send('<h2>✅ Connecté</h2>');
  if (!currentQRCode) return res.send('<h2>🔄 Génération du QR...</h2><script>setTimeout(()=>location.reload(), 5000)</script>');
  res.send(`<div style="text-align:center"><img src="${currentQRCode}"/><script>setTimeout(()=>location.reload(), 15000)</script></div>`);
});

// Endpoint simplifié : accepte juste téléphone et message
app.post('/send-order-alert', async (req, res) => {
  try {
    const { phone, message } = req.body;

    if (!phone || !message) return res.status(400).json({ status: 'error', message: 'Paramètres manquants' });
    if (!isWhatsAppConnected) return res.status(503).json({ status: 'error', message: 'WhatsApp déconnecté' });

    const whatsappId = String(phone).replace(/\D/g, '') + '@s.whatsapp.net';
    await sock.sendMessage(whatsappId, { text: message });
    
    return res.json({ status: 'success' });
  } catch (error) {
    return res.status(500).json({ status: 'error', message: error.message });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Serveur actif sur le port ${PORT}`);
  connectToWhatsApp();
});