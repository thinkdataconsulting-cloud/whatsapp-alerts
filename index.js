const { default: makeWASocket, useMultiFileAuthState } = require('@whiskeysockets/baileys');
const express = require('express');
const app = express();
app.use(express.json());

const PORT = process.env.PORT || 8080;

app.get('/status', (req, res) => res.send('Serveur opérationnel'));

// Lancement simplifié
const startBot = async () => {
    try {
        const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
        const sock = makeWASocket({ auth: state });
        sock.ev.on('creds.update', saveCreds);
        console.log('Bot initialisé');
    } catch (err) {
        console.error('Erreur démarrage:', err);
    }
};

app.listen(PORT, '0.0.0.0', () => {
    console.log('Serveur actif');
    startBot();
});