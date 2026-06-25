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
    // 1. Initialisation de l'état d'authentification
    const { state, saveCreds } = await useMultiFileAuthState(authDir);

    // 2. Création de la socket avec les paramètres corrigés
    sock = makeWASocket({
        auth: {
            creds: state.creds,
            keys: state.keys,
        },
        logger: pino({ level: 'silent' }),
        browser: Browsers.ubuntu('Chrome'),
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
            console.log('📸 QR Code généré, prêt à scanner.');
        }
        
        if (connection === 'open') {
            isConnected = true;
            qrCodeValue = null;
            console.log('✅ WhatsApp connecté !');
        }
        
        if (connection === 'close') {
            isConnected = false;
            const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
            if (shouldReconnect) {
                console.log('🔄 Connexion perdue, tentative de reconnexion dans 10s...');
                setTimeout(startSock, 10000);
            }
        }
    });
}

// Route pour afficher le QR code
app.get('/scan-qr', async (req, res) => {
    if (isConnected) return res.send('<h1>✅ WhatsApp est déjà connecté.</h1>');
    if (!qrCodeValue) return res.send('<h1>🔄 Initialisation en cours...</h1><p>Si cela reste bloqué, vérifiez vos logs Railway.</p><script>setTimeout(()=>location.reload(), 5000)</script>');
    
    try {
        const url = await qrcode.toDataURL(qrCodeValue);
        res.send(`<h1>Scan QR</h1><img src="${url}"><script>setTimeout(()=>location.reload(), 5000)</script>`);
    } catch (e) {
        res.status(500).send('Erreur lors de la génération du QR.');
    }
});

// Route pour envoyer un message
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
    console.log(`🚀 Serveur démarré sur le port ${PORT}`);
    startSock();
});