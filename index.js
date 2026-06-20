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
    // Si déjà en cours d'initialisation, on retourne l'instance existante
    if (instances.has(clientId)) return instances.get(clientId);

    const authDir = path.join(process.cwd(), `auth_${clientId}`);
    if (!fs.existsSync(authDir)) fs.mkdirSync(authDir, { recursive: true });

    const { state, saveCreds } = await useMultiFileAuthState(authDir);
    
    const sock = makeWASocket({ 
        auth: state, 
        logger: pino({ level: 'silent' }),
        browser: Browsers.windows('Chrome'), // Plus stable sur serveur
        patchMessageBeforeSending: (msg) => {
            const needsPatch = !!(msg.buttonsMessage || msg.templateMessage || msg.listMessage);
            if (needsPatch) {
                msg = { ...msg, ...{ viewOnceMessage: { message: { messageContextInfo: { deviceListMetadataVersion: 2, deviceListMetadata: {} }, ...msg } } } };
            }
            return msg;
        }
    });

    const instance = { sock, qr: null, connected: false };
    instances.set(clientId, instance);

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        if (qr) {
            instance.qr = qr;
        }

        if (connection === 'open') {
            instance.connected = true;
            instance.qr = null;
            console.log(`✅ [CONN] ${clientId} connecté`);
        }

        if (connection === 'close') {
            instance.connected = false;
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            
            // Si ce n'est pas une déconnexion volontaire, on tente de reconnecter
            if (statusCode !== DisconnectReason.loggedOut) {
                console.log(`🔄 [RECONNECT] ${clientId} suite à l'erreur: ${statusCode}`);
                // Petit délai pour éviter de surcharger le serveur
                setTimeout(() => {
                    instances.delete(clientId);
                    initInstance(clientId);
                }, 5000);
            } else {
                console.log(`❌ [LOGOUT] ${clientId} déconnecté manuellement. Dossier auth nettoyé.`);
                fs.rmSync(authDir, { recursive: true, force: true });
                instances.delete(clientId);
            }
        }
    });

    return instance;
}

// Route d'envoi
app.post('/send-alert/:clientId', async (req, res) => {
    try {
        const { clientId } = req.params;
        const { phone, message } = req.body;
        const instance = instances.get(clientId);

        if (!instance || !instance.connected) {
            return res.status(503).json({ error: 'Instance non connectée ou en cours d\'init.' });
        }
        
        const whatsappId = String(phone).replace(/\D/g, '') + '@s.whatsapp.net';
        await instance.sock.sendMessage(whatsappId, { text: message });
        res.json({ status: 'success' });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Route QR optimisée
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
        res.send('🔄 Initialisation en cours... rafraîchissez dans 5s.');
    }
});

app.listen(PORT, '0.0.0.0', () => console.log(`🚀 Serveur actif sur 0.0.0.0:${PORT}`));