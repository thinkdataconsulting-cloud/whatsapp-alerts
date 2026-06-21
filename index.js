const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, Browsers } = require('@whiskeysockets/baileys');
const express = require('express');
const qrcode = require('qrcode');
const pino = require('pino');

const app = express();
app.use(express.json());
const PORT = process.env.PORT || 8080;

const authDir = './auth_store';
let sock;
let qrCodeValue = null;
let isConnected = false;
let clientNumber = null; // Stocke le numéro autorisé

async function startSock() {
    const { state, saveCreds } = await useMultiFileAuthState(authDir);

    sock = makeWASocket({
        auth: state,
        logger: pino({ level: 'silent' }),
        browser: Browsers.ubuntu('Chrome')
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, qr, lastDisconnect } = update;
        
        if (qr) {
            qrCodeValue = qr;
            isConnected = false;
        }
        
        if (connection === 'open') {
            isConnected = true;
            qrCodeValue = null;
            // On récupère le numéro une fois connecté
            clientNumber = sock.user.id.split(':')[0];
            console.log(`✅ WhatsApp connecté pour : ${clientNumber}`);
        }
        
        if (connection === 'close') {
            isConnected = false;
            const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
            if (shouldReconnect) {
                console.log('🔄 Session perdue, en attente de reconnexion...');
                startSock(); 
            }
        }
    });
}

// Endpoint pour scanner (regenerable si deconnecté)
app.get('/scan-qr', async (req, res) => {
    if (isConnected) return res.send(`<h1>✅ Déjà connecté avec le numéro : ${clientNumber}</h1>`);
    if (!qrCodeValue) return res.send('<h1>🔄 Génération du QR... patientez.</h1><script>setTimeout(()=>location.reload(), 2000)</script>');
    
    const url = await qrcode.toDataURL(qrCodeValue);
    res.send(`<h1>Scan QR pour votre numéro</h1><img src="${url}"><p>Une fois scanné, la page sera confirmée.</p><script>setTimeout(()=>location.reload(), 3000)</script>`);
});

// Endpoint sécurisé avec vérification de numéro
app.post('/send-alert', async (req, res) => {
    const { phone, message, authorizedPhone } = req.body;
    
    if (!isConnected) return res.status(503).json({ error: 'WhatsApp non connecté.' });

    // Sécurité : Vérifie que le numéro qui envoie est bien le numéro autorisé (celui du client)
    if (authorizedPhone && phone.replace(/\D/g, '') !== authorizedPhone.replace(/\D/g, '')) {
        return res.status(403).json({ error: 'Numéro non autorisé pour cette session.' });
    }
    
    try {
        const jid = phone.replace(/\D/g, '') + '@s.whatsapp.net';
        await sock.sendMessage(jid, { text: message });
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Serveur actif`);
    startSock();
});