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
const instances = new Map(); // Stocke toutes les instances actives par ID client

async function initInstance(clientId) {
    if (instances.has(clientId)) return instances.get(clientId);

    const authDir = path.join(process.cwd(), `auth_${clientId}`);
    if (!fs.existsSync(authDir)) fs.mkdirSync(authDir, { recursive: true });

    const { state, saveCreds } = await useMultiFileAuthState(authDir);
    
    // Création de la socket
    const sock = makeWASocket({ 
        auth: state, 
        logger: pino({ level: 'silent' }),
        browser: ['StockBot', 'Chrome', '1.0.0']
    });

    const instance = { sock, qr: null, connected: false };
    instances.set(clientId, instance);

    sock.ev.on('creds.update', saveCreds);
    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;
        if (qr) instance.qr = qr; 
        if (connection === 'open') { instance.connected = true; instance.qr = null; }
        if (connection === 'close') {
            instance.connected = false;
            // Si déconnecté, on supprime de la Map pour forcer une ré-initialisation propre au prochain appel
            instances.delete(clientId);
        }
    });

    // C'EST CETTE LIGNE QUI DÉBLOQUE SOUVENT LE PROCESSUS
    sock.ev.process(async (events) => {
        if (events['connection.update']) {
            const { connection, qr } = events['connection.update'];
            if (qr) instance.qr = qr;
            if (connection === 'open') instance.connected = true;
        }
    });

    return instance;
}// ROUTE QR : /qr?id=client_A
app.get('/qr', async (req, res) => {
    const clientId = req.query.id;
    if (!clientId) return res.status(400).send('ID client manquant (ex: /qr?id=client_A)');
    
    let instance = instances.get(clientId) || await initInstance(clientId);
    
    if (instance.connected) return res.send(`<h2>✅ ${clientId} est connecté.</h2>`);
    if (!instance.qr) return res.send(`<h2>🔄 Génération QR pour ${clientId}...</h2><script>setTimeout(()=>location.reload(), 3000)</script>`);
    
    res.send(`<div style="text-align:center"><h2>Scan pour ${clientId}</h2><img src="${instance.qr}"/><script>setTimeout(()=>location.reload(), 5000)</script></div>`);
});

// ROUTE LOGOUT : /logout?id=client_A
app.get('/logout', async (req, res) => {
    const clientId = req.query.id;
    if (instances.has(clientId)) {
        const instance = instances.get(clientId);
        await instance.sock.logout();
        fs.rmSync(path.join(process.cwd(), `auth_${clientId}`), { recursive: true, force: true });
        instances.delete(clientId);
    }
    res.send(`<h2>${clientId} déconnecté.</h2>`);
});

// ROUTE ALERTE : /send-alert/:clientId
app.post('/send-alert/:clientId', async (req, res) => {
    const { clientId } = req.params;
    const { phone, message } = req.body;
    
    const instance = instances.get(clientId);
    if (!instance || !instance.connected) return res.status(503).send('Instance non connectée');

    try {
        const whatsappId = String(phone).replace(/\D/g, '') + '@s.whatsapp.net';
        await instance.sock.sendMessage(whatsappId, { text: message });
        res.json({ status: 'success' });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.listen(PORT, '0.0.0.0', () => console.log(`🚀 Serveur multi-instances actif`));