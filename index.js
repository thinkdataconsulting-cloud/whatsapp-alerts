const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, Browsers } = require('@whiskeysockets/baileys');
const express = require('express');
const qrcode = require('qrcode');
const pino = require('pino');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 8080;
const instances = new Map();

async function initInstance(clientId) {
    if (instances.has(clientId)) return instances.get(clientId);

    const authDir = path.join(process.cwd(), `auth_${clientId}`);
    if (!fs.existsSync(authDir)) fs.mkdirSync(authDir, { recursive: true });

    const { state, saveCreds } = await useMultiFileAuthState(authDir);
    
    const sock = makeWASocket({ 
        auth: state, 
        logger: pino({ level: 'silent' }),
        browser: Browsers.windows('Desktop')
    });

    const instance = { sock, qr: null, connected: false };
    instances.set(clientId, instance);

    sock.ev.on('creds.update', saveCreds);
    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;
        if (qr) instance.qr = qr;
        if (connection === 'open') {
            instance.connected = true;
            instance.qr = null;
        }
        if (connection === 'close') {
            instance.connected = false;
            const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
            if (shouldReconnect) setTimeout(() => initInstance(clientId), 5000);
        }
    });

    return instance;
}

// Route d'envoi
app.post('/send-alert/:clientId', async (req, res) => {
    try {
        const { clientId } = req.params;
        const { phone, message } = req.body;
        
        let instance = instances.get(clientId) || await initInstance(clientId);

        if (!instance.connected) {
            return res.status(503).json({ error: 'Instance non connectée, scannez le QR' });
        }
        
        const whatsappId = String(phone).replace(/\D/g, '') + '@s.whatsapp.net';
        await instance.sock.sendMessage(whatsappId, { text: message });
        res.json({ status: 'success' });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Route QR
app.get('/qr', async (req, res) => {
    const clientId = req.query.id;
    if (!clientId) return res.status(400).send('ID manquant');
    
    let instance = instances.get(clientId) || await initInstance(clientId);
    
    if (instance.connected) return res.send('✅ Déjà connecté');
    if (instance.qr) {
        const url = await qrcode.toDataURL(instance.qr);
        res.send(`<img src="${url}">`);
    } else {
        res.send('🔄 Génération en cours... rafraîchissez dans 10 secondes.');
    }
});

app.listen(PORT, '0.0.0.0', () => console.log(`🚀 Serveur actif sur le port ${PORT}`));