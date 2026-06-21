const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    Browsers
} = require('@whiskeysockets/baileys');

const express = require('express');
const qrcode = require('qrcode');
const pino = require('pino');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Désactive le cache
app.use((req, res, next) => {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    next();
});

const PORT = process.env.PORT || 8080;
const instances = new Map();

// Fix pour "crypto is not defined"
if (!globalThis.crypto) {
    globalThis.crypto = {
        getRandomValues: (buffer) => require('crypto').randomBytes(buffer.length),
        subtle: {
            digest: async (algorithm, data) => {
                const hash = require('crypto').createHash(algorithm.toLowerCase().replace('-', ''));
                hash.update(data);
                return new Uint8Array(hash.digest());
            },
        },
    };
}

async function initInstance(clientId, phoneNumber) {
    if (instances.has(clientId)) {
        const instance = instances.get(clientId);
        if (instance.connected) return instance;
        instances.delete(clientId); // Supprime l'instance déconnectée
    }

    console.log(`🚀 Initialisation de ${clientId} (${phoneNumber})`);

    const authDir = path.join(process.cwd(), `auth_${clientId}`);
    if (!fs.existsSync(authDir)) {
        fs.mkdirSync(authDir, { recursive: true });
    }

    const { state, saveCreds } = await useMultiFileAuthState(authDir);

    const sock = makeWASocket({
        auth: state,
        logger: pino({ level: 'error' }),
        browser: Browsers.ubuntu('Chrome'),
        syncFullHistory: false,
        markOnlineOnConnect: false,
        generateHighQualityLinkPreview: false
    });

    const instance = {
        sock,
        qr: null,
        connected: false,
        authDir,
        phoneNumber
    };

    instances.set(clientId, instance);

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            console.log(`📱 QR reçu pour ${clientId}`);
            instance.qr = qr;
        }

        if (connection === 'open') {
            console.log(`✅ ${clientId} connecté avec succès !`);
            instance.connected = true;
            instance.qr = null;
        }

        if (connection === 'close') {
            instance.connected = false;
            const statusCode = lastDisconnect?.error?.output?.statusCode;

            if (statusCode === DisconnectReason.loggedOut) {
                console.log(`🔴 ${clientId} déconnecté (logout)`);
                try { fs.rmSync(authDir, { recursive: true, force: true }); } catch (e) {}
                instances.delete(clientId);
            } else {
                console.log(`🟡 ${clientId} déconnecté temporairement`);
            }
        }
    });

    return instance;
}

// Endpoint pour obtenir le QR code d'un client
app.get('/qr', async (req, res) => {
    try {
        const clientId = req.query.id;
        const phoneNumber = req.query.phone;

        if (!clientId || !phoneNumber) {
            return res.status(400).json({
                error: 'ID et phone sont requis',
                example: '/qr?id=Client_A&phone=+22791848270'
            });
        }

        let instance = instances.get(clientId);
        if (!instance) {
            instance = await initInstance(clientId, phoneNumber);
        }

        // Attend le QR pendant 15 secondes max
        const startTime = Date.now();
        while (!instance.qr && !instance.connected && (Date.now() - startTime) < 15000) {
            await new Promise(resolve => setTimeout(resolve, 300));
        }

        instance = instances.get(clientId);
        if (!instance) {
            return res.status(500).json({ error: 'Instance perdue' });
        }

        if (instance.connected) {
            return res.json({
                status: 'connected',
                message: 'WhatsApp est déjà connecté'
            });
        }

        if (instance.qr) {
            const qrImage = await qrcode.toDataURL(instance.qr);
            return res.json({
                status: 'qr_ready',
                qrCode: qrImage,
                message: `Scannez ce QR code avec WhatsApp pour ${clientId}`,
                clientId: clientId,
                phoneNumber: instance.phoneNumber
            });
        }

        return res.status(500).json({
            error: 'Échec de la génération du QR code',
            details: 'Le QR code n\'a pas été généré dans le temps imparti (15s)'
        });

    } catch (err) {
        console.error('Erreur /qr:', err);
        res.status(500).json({ error: err.message });
    }
});

// Endpoint pour envoyer une alerte
app.post('/send-alert', async (req, res) => {
    try {
        const { clientId, phone, message } = req.body;

        if (!clientId || !phone || !message) {
            return res.status(400).json({
                error: 'clientId, phone et message sont requis'
            });
        }

        let instance = instances.get(clientId);
        if (!instance) {
            // Initialise l'instance si elle n'existe pas
            instance = await initInstance(clientId, phone);
            // Attend 2 secondes pour laisser le temps de générer le QR
            await new Promise(resolve => setTimeout(resolve, 2000));
        }

        if (!instance.connected) {
            return res.status(503).json({
                error: 'WhatsApp non connecté pour ce client',
                solution: `Scannez d'abord le QR code via /qr?id=${clientId}&phone=${encodeURIComponent(phone)}`
            });
        }

        const jid = phone.replace(/\D/g, '') + '@s.whatsapp.net';

        await instance.sock.sendMessage(jid, {
            text: message,
            buttons: [
                { buttonId: 'confirm_order', buttonText: { displayText: '✅ Oui' }, type: 1 },
                { buttonId: 'cancel_order', buttonText: { displayText: '❌ Non' }, type: 1 }
            ]
        });

        res.json({
            success: true,
            message: 'Alerte envoyée avec succès',
            clientId: clientId,
            sentTo: jid
        });

    } catch (err) {
        console.error('Erreur /send-alert:', err);
        res.status(500).json({
            error: err.message,
            stack: process.env.NODE_ENV === 'development' ? err.stack : undefined
        });
    }
});

// Endpoint pour vérifier le statut
app.get('/status/:clientId', async (req, res) => {
    const clientId = req.params.clientId;
    const instance = instances.get(clientId);

    if (!instance) {
        return res.json({ exists: false });
    }

    res.json({
        exists: true,
        connected: instance.connected,
        phoneNumber: instance.phoneNumber
    });
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Serveur démarré sur le port ${PORT}`);
    console.log(`🌐 URL: https://whatsapp-alerts-production-7426.up.railway.app`);
});