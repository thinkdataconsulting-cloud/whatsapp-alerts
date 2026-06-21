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

async function initInstance(clientId) {
    // Si l'instance existe déjà et est connectée, on la retourne
    if (instances.has(clientId)) {
        const instance = instances.get(clientId);
        if (instance.connected) {
            return instance;
        }
        // Si elle existe mais n'est pas connectée, on la supprime pour en créer une nouvelle
        instances.delete(clientId);
    }

    console.log(`🚀 Initialisation de ${clientId}`);

    const authDir = path.join(process.cwd(), `auth_${clientId}`);
    if (!fs.existsSync(authDir)) {
        fs.mkdirSync(authDir, { recursive: true });
    }

    const { state, saveCreds } = await useMultiFileAuthState(authDir);

    const sock = makeWASocket({
        auth: state,
        printQRInTerminal: true,  // IMPORTANT: Active la génération du QR
        logger: pino({ level: 'error' }),
        browser: Browsers.ubuntu('Chrome'),
        syncFullHistory: false,
        markOnlineOnConnect: false,  // Désactive pour éviter les problèmes
        generateHighQualityLinkPreview: false
    });

    const instance = {
        sock,
        qr: null,
        connected: false,
        authDir
    };

    instances.set(clientId, instance);

    // Événement pour les crédentials
    sock.ev.on('creds.update', saveCreds);

    // Événement principal pour la connexion
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
                try {
                    fs.rmSync(authDir, { recursive: true, force: true });
                } catch (e) {}
                instances.delete(clientId);
            } else {
                console.log(`🟡 ${clientId} déconnecté temporairement, reconnexion...`);
                // On ne relance PAS automatiquement ici pour éviter les boucles
            }
        }
    });

    return instance;
}

app.get('/', (req, res) => {
    res.json({
        status: 'active',
        message: 'WhatsApp Alerts API Active',
        endpoints: {
            status: '/status/:clientId',
            qr: '/qr?id=clientId',
            sendAlert: '/send-alert/:clientId'
        }
    });
});

app.get('/status/:clientId', async (req, res) => {
    const clientId = req.params.clientId;
    const instance = instances.get(clientId);

    if (!instance) {
        return res.json({ exists: false });
    }

    res.json({
        exists: true,
        connected: instance.connected,
        hasQr: !!instance.qr
    });
});

app.get('/qr', async (req, res) => {
    try {
        const clientId = req.query.id;

        if (!clientId) {
            return res.status(400).json({ error: 'ID manquant' });
        }

        // Initialise l'instance si elle n'existe pas
        let instance = instances.get(clientId);
        if (!instance) {
            instance = await initInstance(clientId);
        }

        // Attend jusqu'à 10 secondes pour le QR
        const startTime = Date.now();
        while (!instance.qr && !instance.connected && (Date.now() - startTime) < 10000) {
            await new Promise(resolve => setTimeout(resolve, 500));
        }

        // Vérifie à nouveau
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
                message: 'Scannez ce QR code avec WhatsApp',
                clientId: clientId
            });
        }

        return res.status(500).json({
            error: 'Échec de la génération du QR code',
            details: 'Le QR code n\'a pas été généré dans le temps imparti'
        });

    } catch (err) {
        console.error('Erreur /qr:', err);
        res.status(500).json({ error: err.message });
    }
});

app.post('/send-alert/:clientId', async (req, res) => {
    try {
        const clientId = req.params.clientId;
        const { phone, product, quantity, supplier, threshold, orderld } = req.body;

        const instance = instances.get(clientId);
        if (!instance) {
            return res.status(404).json({ error: 'Instance inexistante' });
        }

        if (!instance.connected) {
            return res.status(503).json({
                error: 'WhatsApp non connecté',
                solution: `Scannez d'abord le QR code via /qr?id=${clientId}`
            });
        }

        const jid = phone.replace(/\D/g, '') + '@s.whatsapp.net';

        const messageContent = {
            text: `🚨 *ALERTE STOCK FAIBLE* 🚨\n\n📦 *Produit*: ${product}\n📊 *Quantité*: ${quantity}\n⚠️ *Seuil*: ${threshold}\n🏪 *Fournisseur*: ${supplier}\n\nPasser une commande ?`,
            buttons: [
                { buttonId: 'confirm_order', buttonText: { displayText: '✅ Oui, commander' }, type: 1 },
                { buttonId: 'cancel_order', buttonText: { displayText: '❌ Non, ignorer' }, type: 1 }
            ],
            footer: 'StockAlert System'
        };

        await instance.sock.sendMessage(jid, messageContent);

        res.json({
            success: true,
            message: 'Alerte envoyée avec succès',
            orderId: orderld || `ORDER-${product}-${Date.now()}`
        });

    } catch (err) {
        console.error('Erreur /send-alert:', err);
        res.status(500).json({
            error: err.message,
            details: process.env.NODE_ENV === 'development' ? err.stack : undefined
        });
    }
});

// Endpoint pour forcer la reconnexion
app.post('/reconnect/:clientId', async (req, res) => {
    try {
        const clientId = req.params.clientId;
        instances.delete(clientId);
        await initInstance(clientId);
        res.json({ success: true, message: 'Reconnexion initiée' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Serveur démarré sur le port ${PORT}`);
    console.log(`🌐 URL: https://whatsapp-alerts-production-af15.up.railway.app`);
});