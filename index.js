const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const express = require('express');
const qrcode = require('qrcode');
const pino = require('pino');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json({ limit: '10mb' }));

const PORT = process.env.PORT || 8080;
const instances = new Map(); // Stocke toutes les instances actives

async function initInstance(clientId) {
    if (instances.has(clientId)) return instances.get(clientId);

    const authDir = path.join(process.cwd(), `auth_${clientId}`);
    if (!fs.existsSync(authDir)) fs.mkdirSync(authDir, { recursive: true });

    const { state, saveCreds } = await useMultiFileAuthState(authDir);
    
    const sock = makeWASocket({ 
        auth: state, 
        logger: pino({ level: 'silent' }),
        browser: ['StockBot', 'Chrome', '110.0.0']
    });

    const instance = { sock, qr: null, connected: false };
    instances.set(clientId, instance);

    sock.ev.on('creds.update', saveCreds);

    // Événement pour le QR code
    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        if (qr) {
            instance.qr = qr;
            console.log(`📸 QR Code généré pour ${clientId}`);
        }
        
        if (connection === 'open') {
            instance.connected = true;
            instance.qr = null;
            console.log(`✅ ${clientId} connecté avec succès !`);
        }
        
        if (connection === 'close') {
            instance.connected = false;
            // Ne pas tenter de reconnecter si déconnecté volontairement
            if (lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut) {
                setTimeout(() => initInstance(clientId), 5000);
            }
        }
    });

    return instance;
}

// Route d'envoi : l'ID est dans l'URL (ex: /send-alert/Stock_Client_A)
app.post('/send-alert/:clientId', async (req, res) => {
    const { clientId } = req.params;
    const { phone, message } = req.body;

    // Initialisation auto si le client n'existe pas encore en mémoire
    let instance = instances.get(clientId);
    if (!instance) {
        instance = await initInstance(clientId);
    }

    if (!instance.connected) {
        return res.status(503).json({ error: 'Instance non connectée, scannez le QR code' });
    }
    
    try {
        const whatsappId = String(phone).replace(/\D/g, '') + '@s.whatsapp.net';
        await instance.sock.sendMessage(whatsappId, { text: message });
        res.json({ status: 'success' });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Route pour afficher le QR code spécifique au client
app.get('/qr', async (req, res) => {
    const clientId = req.query.id;
    if (!clientId) return res.status(400).send('ID client manquant');
    let instance = instances.get(clientId) || await initInstance(clientId);
    
    if (instance.connected) return res.send(`<h2>✅ ${clientId} connecté.</h2>`);
    if (instance.qr) {
        const qrImage = await qrcode.toDataURL(instance.qr);
        res.send(`<div style="text-align:center"><h2>Scan pour ${clientId}</h2><img src="${qrImage}"/></div>`);
    } else {
        res.send(`<h2>🔄 Initialisation... patientez quelques secondes et rafraîchissez.</h2>`);
    }
});

app.listen(PORT, '0.0.0.0', () => console.log(`🚀 Serveur actif sur le port ${PORT}`));