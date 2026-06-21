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

// Charger automatiquement toutes les sessions existantes au démarrage
function loadExistingSessions() {
    const authFolder = process.cwd();
    fs.readdirSync(authFolder).forEach(file => {
        if (file.startsWith('auth_')) {
            const clientId = file.replace('auth_', '');
            initInstance(clientId, null); // Chargement silencieux
        }
    });
}

async function initInstance(clientId, phoneNumber) {
    if (instances.has(clientId)) return instances.get(clientId);

    const authDir = path.join(process.cwd(), `auth_${clientId}`);
    const { state, saveCreds } = await useMultiFileAuthState(authDir);

    const sock = makeWASocket({
        auth: state,
        logger: pino({ level: 'silent' }),
        browser: Browsers.ubuntu('Chrome'),
        printQRInTerminal: false
    });

    const instance = { sock, qr: null, connected: false };
    instances.set(clientId, instance);

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, qr, lastDisconnect } = update;
        if (qr) instance.qr = qr;
        if (connection === 'open') {
            instance.connected = true;
            instance.qr = null;
        }
        if (connection === 'close') {
            instance.connected = false;
            // Si déconnecté, on tente de reconnecter automatiquement
            if (lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut) {
                setTimeout(() => initInstance(clientId, phoneNumber), 5000);
            }
        }
    });

    return instance;
}

// Route pour générer le QR
app.get('/scan-qr', async (req, res) => {
    const { id: clientId, phone } = req.query;
    if (!clientId) return res.status(400).send('ID client requis');
    
    let instance = instances.get(clientId) || await initInstance(clientId, phone);
    
    if (instance.connected) return res.send('✅ Déjà connecté');
    if (instance.qr) {
        const url = await qrcode.toDataURL(instance.qr);
        res.send(`<img src="${url}"> <script>setTimeout(()=>location.reload(), 5000)</script>`);
    } else {
        res.send('🔄 Initialisation... patientez et rafraîchissez.');
    }
});

// Route POST pour n8n
app.post('/send-alert', async (req, res) => {
    const { clientId, phone, message } = req.body;
    const instance = instances.get(clientId);

    if (!instance || !instance.connected) {
        return res.status(503).json({ error: 'Instance non prête. Scannez le QR.' });
    }

    try {
        const jid = phone.replace(/\D/g, '') + '@s.whatsapp.net';
        await instance.sock.sendMessage(jid, { text: message });
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Serveur actif`);
    loadExistingSessions();
});