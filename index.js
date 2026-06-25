const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, Browsers } = require('@whiskeysockets/baileys');
const express = require('express');
const qrcode = require('qrcode');
const pino = require('pino');

const app = express();
app.use(express.json());
const PORT = process.env.PORT || 8080;

let sock = null;
let qrCodeValue = null;
let isConnected = false;

async function startSock() {
    // On ne charge pas de session persistante pour éviter les blocages de fichiers
    sock = makeWASocket({
        logger: pino({ level: 'silent' }),
        browser: Browsers.ubuntu('Chrome'),
        auth: null // Force une nouvelle connexion à chaque fois
    });

    sock.ev.on('connection.update', (update) => {
        const { connection, qr } = update;
        
        if (qr) {
            qrCodeValue = qr;
            console.log('📸 QR Code généré !');
        }
        
        if (connection === 'open') {
            isConnected = true;
            qrCodeValue = null;
            console.log('✅ WhatsApp connecté !');
        }
        
        if (connection === 'close') {
            isConnected = false;
            console.log('🔄 Connexion fermée, redémarrage du processus...');
            setTimeout(startSock, 5000);
        }
    });
}

app.get('/scan-qr', async (req, res) => {
    if (isConnected) return res.send('<h1>✅ Connecté</h1>');
    if (!qrCodeValue) return res.send('<h1>🔄 En attente de WhatsApp...</h1><script>setTimeout(()=>location.reload(), 3000)</script>');
    
    const url = await qrcode.toDataURL(qrCodeValue);
    res.send(`<h1>Scan QR</h1><img src="${url}"><script>setTimeout(()=>location.reload(), 3000)</script>`);
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Serveur actif`);
    startSock();
});