const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
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
    console.log(`[INIT] Tentative d'initialisation pour: ${clientId}`);
    const authDir = path.join(process.cwd(), `auth_${clientId}`);
    if (!fs.existsSync(authDir)) fs.mkdirSync(authDir, { recursive: true });

    const { state, saveCreds } = await useMultiFileAuthState(authDir);
    
    const sock = makeWASocket({ 
        auth: state, 
        logger: pino({ level: 'debug' }) // Debug pour voir les détails
    });

    instances.set(clientId, { sock, qr: null, connected: false });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;
        if (qr) {
            console.log(`[QR] Code reçu pour ${clientId}`);
            instances.get(clientId).qr = qr;
        }
        if (connection === 'open') {
            console.log(`[CONN] ${clientId} connecté !`);
            instances.get(clientId).connected = true;
        }
    });
}

app.get('/qr', async (req, res) => {
    const clientId = req.query.id;
    if (!clientId) return res.send('ID manquant');
    
    if (!instances.has(clientId)) await initInstance(clientId);
    const instance = instances.get(clientId);

    if (instance.connected) return res.send('Déjà connecté');
    if (instance.qr) {
        const url = await qrcode.toDataURL(instance.qr);
        res.send(`<img src="${url}">`);
    } else {
        res.send('QR en cours de génération, rafraîchissez dans 5 secondes...');
    }
});

app.listen(PORT, () => console.log('Serveur prêt'));