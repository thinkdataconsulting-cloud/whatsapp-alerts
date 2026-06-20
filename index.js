// 1. Polyfill pour corriger l'erreur 'crypto is not defined'
const crypto = require('crypto');
if (!globalThis.crypto) {
    globalThis.crypto = crypto.webcrypto;
}

const { default: makeWASocket, useMultiFileAuthState } = require('@whiskeysockets/baileys');
const express = require('express');
const qrcode = require('qrcode');
const app = express();
app.use(express.json());

const PORT = process.env.PORT || 8080;
let currentQRCode = '';
let sock = null;

// ROUTE QR CODE
app.get('/qr', (req, res) => {
    if (!currentQRCode) return res.send('<h2>Génération du QR... rechargez la page dans quelques secondes.</h2>');
    res.send(`<div style="text-align:center; margin-top:50px;"><h2>Scannez ce QR Code avec WhatsApp</h2><img src="${currentQRCode}"/><script>setTimeout(()=>location.reload(), 5000)</script></div>`);
});

// ROUTE ENVOI MESSAGE
app.post('/send-order-alert', async (req, res) => {
    try {
        const { phone, message } = req.body;
        
        // VÉRIFICATION DE SÉCURITÉ
        // On vérifie si sock existe ET si sock.user est défini (ce qui confirme la connexion)
        if (!sock || !sock.user || !sock.user.id) {
            return res.status(503).json({ 
                status: 'error', 
                message: 'Le bot n\'est pas encore connecté à WhatsApp. Attendez quelques secondes et réessayez.' 
            });
        }
        
        const whatsappId = phone.replace(/\D/g, '') + '@s.whatsapp.net';
        await sock.sendMessage(whatsappId, { text: message });
        
        return res.json({ status: 'success' });
    } catch (e) {
        console.error('Erreur lors de l\'envoi :', e);
        return res.status(500).json({ status: 'error', message: e.message });
    }
});
// INITIALISATION BOT
const startBot = async () => {
    try {
        const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
        sock = makeWASocket({ auth: state, printQRInTerminal: false });
        
        sock.ev.on('creds.update', saveCreds);
        sock.ev.on('connection.update', (update) => {
            const { qr, connection } = update;
            if (qr) qrcode.toDataURL(qr).then(url => currentQRCode = url);
            if (connection === 'open') {
                console.log('✅ WhatsApp connecté !');
                currentQRCode = '';
            }
        });
        console.log('Bot WhatsApp initialisé');
    } catch (err) {
        console.error('Erreur critique:', err);
    }
};

app.listen(PORT, '0.0.0.0', () => {
    console.log('Serveur actif sur le port ' + PORT);
    startBot();
});