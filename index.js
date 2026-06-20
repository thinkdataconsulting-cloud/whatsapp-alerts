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
const instances = new Map();

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

    // Processus de connexion robuste
    // Remplacez votre logique actuelle par celle-ci
sock.ev.process(async (events) => {
    if (events['connection.update']) {
        const update = events['connection.update'];
        const { connection, lastDisconnect, qr } = update;
        
        if (qr) {
            instance.qr = qr; // Le QR est reçu
            console.log(`✅ QR reçu pour ${clientId}`);
        }
        
        if (connection === 'open') {
            instance.connected = true;
            instance.qr = null;
            console.log(`✅ ${clientId} connecté !`);
        }
        
        if (connection === 'close') {
            instance.connected = false;
            // Si la déconnexion n'est pas voulue, on attend avant de retenter
            if (lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut) {
                console.log(`❌ Déconnexion de ${clientId}. Tentative de reconnexion...`);
                setTimeout(() => initInstance(clientId), 5000);
            }
        }
    }
});

    return instance;
}

// ROUTE QR avec génération d'image réelle
app.get('/qr', async (req, res) => {
    const clientId = req.query.id;
    if (!clientId) return res.status(400).send('ID client manquant');
    
    let instance = instances.get(clientId) || await initInstance(clientId);
    
    if (instance.connected) return res.send(`<h2>✅ ${clientId} est connecté.</h2>`);
    
    if (instance.qr) {
        const qrImage = await qrcode.toDataURL(instance.qr);
        res.send(`<div style="text-align:center"><h2>Scan pour ${clientId}</h2><img src="${qrImage}"/><script>setTimeout(()=>location.reload(), 5000)</script></div>`);
    } else {
        res.send(`<h2>🔄 Génération QR...</h2><script>setTimeout(()=>location.reload(), 3000)</script>`);
    }
});

app.get('/logout', async (req, res) => {
    const clientId = req.query.id;
    if (instances.has(clientId)) {
        await instances.get(clientId).sock.logout().catch(() => {});
        fs.rmSync(path.join(process.cwd(), `auth_${clientId}`), { recursive: true, force: true });
        instances.delete(clientId);
    }
    res.send(`<h2>${clientId} déconnecté.</h2>`);
});

app.post('/send-alert/:clientId', async (req, res) => {
    const instance = instances.get(req.params.clientId);
    if (!instance || !instance.connected) return res.status(503).send('Instance non connectée');
    
    try {
        const whatsappId = String(req.body.phone).replace(/\D/g, '') + '@s.whatsapp.net';
        await instance.sock.sendMessage(whatsappId, { text: req.body.message });
        res.json({ status: 'success' });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.listen(PORT, '0.0.0.0', () => console.log(`🚀 Serveur actif`));