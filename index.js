const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, Browsers } = require('@whiskeysockets/baileys');
const express = require('express');
const qrcode = require('qrcode');
const pino = require('pino');
const fs = require('fs');
const path = require('path');
const { HttpsProxyAgent } = require('https-proxy-agent'); // NOUVEAU : npm install https-proxy-agent

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 8080;
const instances = new Map();

// Ajoutez ici l'URL de votre proxy si vous en avez un : "http://user:pass@host:port"
const PROXY_URL = process.env.PROXY_URL || null; 

async function initInstance(clientId) {
    if (instances.has(clientId)) return instances.get(clientId);

    const authDir = path.join(process.cwd(), `auth_${clientId}`);
    if (!fs.existsSync(authDir)) fs.mkdirSync(authDir, { recursive: true });

    const { state, saveCreds } = await useMultiFileAuthState(authDir);
    
    // Configuration du socket avec options de connexion
    const sockOptions = { 
        auth: state, 
        logger: pino({ level: 'silent' }),
        browser: ['Chrome', 'Chrome', '124.0.6367.207'],
        patchMessageBeforeSending: (msg) => {
            const needsPatch = !!(msg.buttonsMessage || msg.templateMessage || msg.listMessage);
            if (needsPatch) {
                msg = { ...msg, ...{ viewOnceMessage: { message: { messageContextInfo: { deviceListMetadataVersion: 2, deviceListMetadata: {} }, ...msg } } } };
            }
            return msg;
        }
    };

    // Injection du proxy si présent
    if (PROXY_URL) {
        sockOptions.agent = new HttpsProxyAgent(PROXY_URL);
    }

    const sock = makeWASocket(sockOptions);
    const instance = { sock, qr: null, connected: false };
    instances.set(clientId, instance);

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;
        if (qr) instance.qr = qr;
        if (connection === 'open') {
            instance.connected = true;
            instance.qr = null;
            console.log(`✅ [CONN] ${clientId} connecté`);
        }
        if (connection === 'close') {
            instance.connected = false;
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            if (statusCode !== DisconnectReason.loggedOut) {
                setTimeout(() => {
                    instances.delete(clientId);
                    initInstance(clientId);
                }, 10000); // Augmenté à 10s pour éviter le spam
            } else {
                fs.rmSync(authDir, { recursive: true, force: true });
                instances.delete(clientId);
            }
        }
    });
    return instance;
}

app.post('/send-alert/:clientId', async (req, res) => {
    const { clientId } = req.params;
    const { phone, message } = req.body;
    const instance = instances.get(clientId);
    if (!instance || !instance.connected) return res.status(503).json({ error: 'Non connecté' });
    
    await instance.sock.sendMessage(phone.replace(/\D/g, '') + '@s.whatsapp.net', { text: message });
    res.json({ status: 'success' });
});

app.get('/qr', async (req, res) => {
    const clientId = req.query.id;
    if (!clientId) return res.status(400).send('ID manquant');
    
    let instance = instances.get(clientId);
    if (!instance) await initInstance(clientId);
    instance = instances.get(clientId);
    
    if (instance.connected) return res.send('✅ Déjà connecté');
    if (instance.qr) {
        const url = await qrcode.toDataURL(instance.qr);
        res.send(`<img src="${url}">`);
    } else {
        res.send('🔄 Initialisation... patientez et rafraîchissez.');
    }
});

app.listen(PORT, '0.0.0.0', () => console.log(`🚀 Serveur actif`));