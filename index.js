const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const express = require('express');
const qrcode = require('qrcode');
const pino = require('pino');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

if (!globalThis.crypto) {
    globalThis.crypto = { getRandomValues: (buffer) => crypto.randomBytes(buffer.length), subtle: crypto.webcrypto.subtle };
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
    catch (e) { console.error('Erreur nettoyage:', e); }
}

async function connectToWhatsApp() {
    if (!fs.existsSync(AUTH_DIR)) fs.mkdirSync(AUTH_DIR, { recursive: true });
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    const { version } = await fetchLatestBaileysVersion();

    sock = makeWASocket({ auth: state, version, logger: pino({ level: 'silent' }) });
    sock.ev.on('creds.update', saveCreds);
    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;
        if (qr) qrcode.toDataURL(qr).then(url => currentQRCode = url);
        if (connection === 'open') { isWhatsAppConnected = true; currentQRCode = null; }
        if (connection === 'close') {
            isWhatsAppConnected = false;
            const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
            if (shouldReconnect) setTimeout(connectToWhatsApp, 5000);
        }
    });
}

// 1. ROUTE LOGOUT : Pour permettre de re-scanner un nouveau QR code
app.get('/logout', async (req, res) => {
    if (sock) await sock.logout();
    cleanAuthFiles();
    isWhatsAppConnected = false;
    currentQRCode = null;
    connectToWhatsApp();
    res.send('<h2>Déconnecté. Rechargez /qr dans quelques secondes pour un nouveau code.</h2>');
});

app.get('/qr', (req, res) => {
    if (isWhatsAppConnected) return res.send('<h2>✅ Connecté. Si vous voulez changer de compte, allez sur <a href="/logout">/logout</a></h2>');
    if (!currentQRCode) return res.send('<h2>🔄 Génération...</h2><script>setTimeout(()=>location.reload(), 3000)</script>');
    res.send(`<div style="text-align:center"><img src="${currentQRCode}"/><script>setTimeout(()=>location.reload(), 5000)</script></div>`);
});

// 2. ROUTE ALERTE : Envoie uniquement au numéro spécifié dans n8n
app.post('/send-order-alert', async (req, res) => {
    const { phone, message } = req.body;
    if (!phone || !message) return res.status(400).send('Manque phone ou message');
    if (!isWhatsAppConnected) return res.status(503).send('Bot non connecté');

    try {
        const whatsappId = String(phone).replace(/\D/g, '') + '@s.whatsapp.net';
        await sock.sendMessage(whatsappId, { text: message });
        res.json({ status: 'success' });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.listen(PORT, '0.0.0.0', () => connectToWhatsApp());