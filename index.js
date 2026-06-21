const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, Browsers } = require('@whiskeysockets/baileys');
const express = require('express');
const qrcode = require('qrcode');
const pino = require('pino');

const app = express();
app.use(express.json());
const PORT = process.env.PORT || 8080;

const authDir = './auth_store';
let sock = null;
let qrCodeValue = null;
let isConnected = false;

async function startSock() {
    const { state, saveCreds } = await useMultiFileAuthState(authDir);

    sock = makeWASocket({
        auth: state,
        logger: pino({ level: 'silent' }),
        // Simulation d'un vrai navigateur Chrome Linux
        browser: ["Chrome (Linux)", "Chrome", "116.0.0.0"], 
        patchMessageBeforeSending: (msg) => {
            const needsPatch = !!(msg.buttonsMessage || msg.templateMessage || msg.listMessage);
            if (needsPatch) {
                msg = { ...msg, viewOnceMessage: { message: { messageContextInfo: { deviceListMetadataVersion: 2, deviceListMetadata: {}, }, ...msg } } };
            }
            return msg;
        }
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, qr, lastDisconnect } = update;
        if (qr) qrCodeValue = qr;
        if (connection === 'open') {
            isConnected = true;
            qrCodeValue = null;
            console.log('✅ WhatsApp connecté !');
        }
        if (connection === 'close') {
            isConnected = false;
            if (lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut) {
                setTimeout(startSock, 15000); // 15 secondes pour laisser le temps à l'IP de respirer
            }
        }
    });
}

app.get('/scan-qr', (req, res) => {
    if (isConnected) return res.send('<h1>✅ Connecté</h1>');
    if (!qrCodeValue) return res.send('<h1>🔄 Initialisation...</h1><script>setTimeout(()=>location.reload(), 5000)</script>');
    qrcode.toDataURL(qrCodeValue).then(url => {
        res.send(`<h1>Scan QR</h1><img src="${url}"><script>setTimeout(()=>location.reload(), 5000)</script>`);
    });
});

app.post('/send-alert', async (req, res) => {
    const { phone, message } = req.body;
    if (!isConnected) return res.status(503).json({ error: 'Non connecté' });
    try {
        await sock.sendMessage(phone.replace(/\D/g, '') + '@s.whatsapp.net', { text: message });
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Serveur actif`);
    startSock();
});