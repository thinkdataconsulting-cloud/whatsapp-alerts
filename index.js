const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const express = require('express');
const qrcode = require('qrcode');
const pino = require('pino');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 8080;
const AUTH_DIR = path.join(process.cwd(), 'auth_info_baileys');

let sock = null;
let isWhatsAppConnected = false;
let currentQRCode = null;

async function connectToWhatsApp() {
  if (!fs.existsSync(AUTH_DIR)) fs.mkdirSync(AUTH_DIR, { recursive: true });
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    auth: state,
    version,
    logger: pino({ level: 'silent' }),
    browser: ['StockAlertBot', 'Chrome', '1.0.0']
  });

  sock.ev.on('creds.update', saveCreds);
  sock.ev.on('connection.update', (update) => {
    const { connection, qr } = update;
    if (qr) qrcode.toDataURL(qr).then(url => currentQRCode = url);
    if (connection === 'open') { isWhatsAppConnected = true; currentQRCode = null; }
    if (connection === 'close') { isWhatsAppConnected = false; setTimeout(connectToWhatsApp, 5000); }
  });
}

// ROUTE QR CODE
app.get('/qr', (req, res) => {
  if (isWhatsAppConnected) return res.send('<h2>✅ WhatsApp est déjà connecté !</h2>');
  if (!currentQRCode) return res.send('<h2>🔄 QR code en cours de génération... Rafraîchissez dans 10 secondes.</h2>');
  res.send(`<div style="text-align:center; margin-top:50px;"><h2>Scannez ce QR Code</h2><img src="${currentQRCode}"/></div><script>setTimeout(()=>location.reload(), 5000)</script>`);
});

// ROUTE POST POUR N8N
app.post('/send-order-alert', async (req, res) => {
  if (!isWhatsAppConnected) return res.status(503).json({ status: 'error', message: 'WhatsApp non connecté' });
  try {
    const { phone, message } = req.body;
    await sock.sendMessage(phone.replace(/\D/g, '') + '@s.whatsapp.net', { text: message });
    return res.json({ status: 'success' });
  } catch (e) { return res.status(500).json({ error: e.message }); }
});

app.listen(PORT, '0.0.0.0', () => connectToWhatsApp());