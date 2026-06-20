// 1. Polyfill pour corriger l'erreur 'crypto is not defined'
const crypto = require('crypto');
if (!globalThis.crypto) {
    globalThis.crypto = crypto.webcrypto;
}

const { default: makeWASocket, useMultiFileAuthState } = require('@whiskeysockets/baileys');
const express = require('express');
const app = express();
app.use(express.json());

const PORT = process.env.PORT || 8080;

// Routes définies AVANT le démarrage du socket
app.get('/status', (req, res) => res.json({ status: 'OK' }));

app.get('/qr', (req, res) => {
    res.send('<h2>Service en cours de configuration.</h2>');
});

app.post('/send-order-alert', async (req, res) => {
    res.json({ status: 'Reçu' });
});

// Démarrage du serveur Express
app.listen(PORT, '0.0.0.0', () => {
    console.log('Serveur Express actif sur le port ' + PORT);
    
    // Initialisation du Bot
    const startBot = async () => {
        try {
            const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
            const sock = makeWASocket({ auth: state });
            sock.ev.on('creds.update', saveCreds);
            console.log('Bot WhatsApp initialisé avec succès');
        } catch (err) {
            console.error('Erreur critique Baileys:', err);
        }
    };
    startBot();
});