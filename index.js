const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, Browsers } = require('@whiskeysockets/baileys');
const express = require('express');
const qrcode = require('qrcode');
const pino = require('pino');

const app = express();
app.use(express.json());
const PORT = process.env.PORT || 8080;

const authDir = './auth_store';
let sock = null; // Initialisé à null
let qrCodeValue = null;
let isConnected = false;
let clientNumber = null;

async function startSock() {
    // Si une socket existe déjà, on la ferme avant d'en créer une nouvelle
    if (sock) {
        try { await sock.end(); } catch (e) {}
    }

    const { state, saveCreds } = await useMultiFileAuthState(authDir);

    sock = makeWASocket({
        auth: state,
        logger: pino({ level: 'silent' }),
        browser: Browsers.ubuntu('Chrome'),
        generateHighQualityLinkPreview: true
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
            clientNumber = sock.user?.id?.split(':')[0] || 'Inconnu';
            console.log(`✅ WhatsApp connecté pour : ${clientNumber}`);
        }
        
        if (connection === 'close') {
            isConnected = false;
            const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
            if (shouldReconnect) {
                console.log('🔄 Session perdue, reconnexion dans 10 secondes...');
                // Délai plus long pour éviter de saturer le processeur
                setTimeout(startSock, 10000); 
            }
        }
    });
}

app.get('/scan-qr', async (req, res) => {
    if (isConnected) return res.send(`<h1>✅ Connecté : ${clientNumber}</h1>`);
    if (!qrCodeValue) return res.send('<h1>🔄 Génération du QR... patientez.</h1><script>setTimeout(()=>location.reload(), 5000)</script>');
    
    const url = await qrcode.toDataURL(qrCodeValue);
    res.send(`<h1>Scan QR</h1><img src="${url}"><script>setTimeout(()=>location.reload(), 5000)</script>`);
});

app.post('/send-alert', async (req, res) => {
    const { phone, message } = req.body;
    if (!isConnected) return res.status(503).json({ error: 'WhatsApp non connecté.' });
    
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