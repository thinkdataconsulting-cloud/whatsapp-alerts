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
    if (instances.has(clientId)) {
        return instances.get(clientId);
    }

    console.log(`🚀 Initialisation de ${clientId}`);

    const authDir = path.join(process.cwd(), `auth_${clientId}`);
    if (!fs.existsSync(authDir)) {
        fs.mkdirSync(authDir, { recursive: true });
    }

    const { state, saveCreds } = await useMultiFileAuthState(authDir);

    const sock = makeWASocket({
        auth: state,
        logger: pino({ level: 'silent' }),
        browser: Browsers.ubuntu('Chrome'),
        syncFullHistory: false,
        markOnlineOnConnect: true,
        generateHighQualityLinkPreview: false,
        printQRInTerminal: false
    });

    const instance = {
        sock,
        qr: null,
        connected: false
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
            console.log(`✅ ${clientId} connecté`);
            instance.connected = true;
            instance.qr = null;
        }

        if (connection === 'close') {
            instance.connected = false;
            const statusCode = lastDisconnect?.error?.output?.statusCode;

            if (statusCode !== DisconnectReason.loggedOut) {
                console.log(`🔄 Reconnexion de ${clientId} dans 10 secondes`);
                setTimeout(() => initInstance(clientId), 10000);
            } else {
                console.log(`🗑️ Session supprimée pour ${clientId}`);
                try {
                    fs.rmSync(authDir, { recursive: true, force: true });
                } catch (e) {}
                instances.delete(clientId);
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

        let instance = instances.get(clientId);
        if (!instance) {
            instance = await initInstance(clientId);
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
                qrCode: qrImage,
                status: 'qr_ready',
                message: 'Scannez ce QR code avec WhatsApp'
            });
        }

        return res.json({
            status: 'waiting',
            message: 'Génération du QR code en cours...'
        });

    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});

app.post('/send-alert/:clientId', async (req, res) => {
    try {
        const clientId = req.params.clientId;
        const { phone, message, product, quantity, supplier, threshold, orderld } = req.body;

        const instance = instances.get(clientId);
        if (!instance) {
            return res.status(404).json({ error: 'Instance inexistante' });
        }

        if (!instance.connected) {
            return res.status(503).json({
                error: 'WhatsApp non connecté',
                solution: 'Scannez d\'abord le QR code via /qr?id=' + clientId
            });
        }

        const jid = phone.replace(/\D/g, '') + '@s.whatsapp.net';

        // Formatage du message avec boutons
        const messageContent = {
            text: `🚨 *ALERTE STOCK FAIBLE* 🚨\n\n📦 *Produit*: ${product}\n📊 *Quantité*: ${quantity}\n⚠️ *Seuil*: ${threshold}\n🏪 *Fournisseur*: ${supplier}\n\nPasser une commande ?`,
            buttons: [
                { buttonId: 'confirm_order', buttonText: { displayText: '✅ Oui, commander' }, type: 1 },
                { buttonId: 'cancel_order', buttonText: { displayText: '❌ Non, ignorer' }, type: 1 }
            ],
            footer: 'StockAlert System'
        };

        await instance.sock.sendMessage(jid, messageContent);

        // Stocke la commande pour les réponses aux boutons
        if (orderld) {
            instance.sock.ev.on('messages.upsert', async (m) => {
                const msg = m.messages[0];
                if (msg.key.fromMe) return;

                const buttonResponse = msg.message?.buttonsResponseMessage;
                if (buttonResponse && buttonResponse.id === orderld) {
                    const responseText = buttonResponse.selectedButtonId === 'confirm_order'
                        ? `✅ COMMANDE CONFIRMÉE pour ${product}`
                        : `❌ Commande annulée pour ${product}`;
                    await instance.sock.sendMessage(jid, { text: responseText });
                }
            });
        }

        res.json({
            success: true,
            message: 'Alerte envoyée avec succès',
            orderId: orderld || `ORDER-${product}-${Date.now()}`
        });

    } catch (err) {
        console.error(err);
        res.status(500).json({
            error: err.message,
            details: process.env.NODE_ENV === 'development' ? err.stack : undefined
        });
    }
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Serveur démarré sur le port ${PORT}`);
    console.log(`🌐 URL: https://whatsapp-alerts-production-af15.up.railway.app`);
});