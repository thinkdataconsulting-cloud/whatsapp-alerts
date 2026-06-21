const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, Browsers } = require('@whiskeysockets/baileys');
const express = require('express');
const qrcode = require('qrcode');
const pino = require('pino');

const app = express();
app.use(express.json());
const PORT = process.env.PORT || 8080;

const authDir = './auth_store';
let sock = null; // Important pour gérer les reconnexions
let qrCodeValue = null;
let isConnected = false;

async function startSock() {
    // Nettoyage de l'ancienne socket si elle existe
    if (sock) {
        try { await sock.end(); } catch (e) {}
        sock = null;
    }

    const { state, saveCreds } = await useMultiFileAuthState(authDir);

    sock = makeWASocket({
        auth: state,
        logger: pino({ level: 'silent' }),
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
        
        if (qr) {
            qrCodeValue = qr;
            isConnected = false;
        }
        
        if (connection === 'open') {
            isConnected = true;
            qrCodeValue = null;
            console.log('✅ WhatsApp connecté !');
        }
        
        if (connection === 'close') {
            isConnected = false;
            // Si ce n'est pas un logout volontaire, on tente de relancer
            if (lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut) {
                console.log('🔄 Connexion perdue, tentative de reconnexion dans 15s...');
                setTimeout(startSock, 15000);
            } else {
                console.log('❌ Déconnecté (Logout).');
            }
        }
    });
}

app.get('/scan-qr', (req, res) => {
    if (isConnected) return res.send('<h1>✅ Connecté</h1>');
    if (!qrCodeValue) return res.send('<h1>🔄 Initialisation...</h1><script>setTimeout(()=>location.reload(), 5000)</script>');
    
    qrcode.toDataURL(qrCodeValue).then(url => {
        res.send(`<h1>Scan QR</h1><img src="${url}"><script>setTimeout(()=>location.reload(), 5000)</script>`);
    }).catch(err => res.status(500).send('Erreur QR'));
});

app.post('/send-alert', async (req, res) => {
    const { phone, message } = req.body;
    if (!isConnected || !sock) return res.status(503).json({ error: 'WhatsApp non connecté' });
    
    try {
        const jid = phone.replace(/\D/g, '') + '@s.whatsapp.net';
        await sock.sendMessage(jid, { text: message });
        res.json({ success: true });
    } catch (e) { 
        res.status(500).json({ error: e.message }); 
    }
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Serveur actif sur le port ${PORT}`);
    startSock();
});