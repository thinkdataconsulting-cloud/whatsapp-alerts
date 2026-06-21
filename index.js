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
app.use(express.json({ limit: '10mb' }));
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
            }
        }
    };
}

async function initInstance(clientId, phoneNumber) {
    if (instances.has(clientId)) {
        const instance = instances.get(clientId);
        if (instance.connected) return instance;
        instances.delete(clientId);
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
        markOnlineOnConnect: false
    });

    const instance = {
        sock,
        qr: null,
        connected: false,
        authDir,
        phoneNumber,
        clientId
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
                try {
                    fs.rmSync(authDir, { recursive: true, force: true });
                } catch (e) {}
                instances.delete(clientId);
            }
        }
    });

    return instance;
}

// Endpoint pour afficher le QR dans le navigateur
app.get('/scan-qr', async (req, res) => {
    try {
        const clientId = req.query.id;
        const phoneNumber = req.query.phone;

        if (!clientId || !phoneNumber) {
            return res.send(`
                <!DOCTYPE html>
                <html>
                <head>
                    <meta charset="UTF-8">
                    <title>Erreur - StockAlert</title>
                    <style>
                        body { font-family: Arial; text-align: center; margin-top: 50px; }
                        .error { color: red; }
                        .form { margin: 20px; }
                        input { padding: 8px; margin: 5px; width: 200px; }
                        button { padding: 10px 20px; background: #25D366; color: white; border: none; border-radius: 5px; cursor: pointer; }
                    </style>
                </head>
                <body>
                    <h2>⚠️ Paramètres manquants</h2>
                    <p class="error">Veuillez fournir un ID client et un numéro de téléphone.</p>
                    <div class="form">
                        <form action="/scan-qr" method="get">
                            <div>
                                <label>ID Client:</label><br>
                                <input type="text" name="id" placeholder="Stock_Client_A" required>
                            </div>
                            <div>
                                <label>Numéro WhatsApp:</label><br>
                                <input type="tel" name="phone" placeholder="+22791848270" required>
                            </div>
                            <button type="submit">Générer QR Code</button>
                        </form>
                    </div>
                </body>
                </html>
            `);
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
            return res.status(500).send(`
                <!DOCTYPE html>
                <html>
                <head>
                    <meta charset="UTF-8">
                    <title>Erreur - StockAlert</title>
                </head>
                <body>
                    <h2>❌ Erreur interne</h2>
                    <p>Instance perdue. Veuillez réessayer.</p>
                </body>
                </html>
            `);
        }

        if (instance.connected) {
            return res.send(`
                <!DOCTYPE html>
                <html>
                <head>
                    <meta charset="UTF-8">
                    <title>Connecté - StockAlert</title>
                    <style>
                        body { font-family: Arial; text-align: center; margin-top: 50px; }
                        .success { color: #25D366; }
                    </style>
                </head>
                <body>
                    <h2>✅ WhatsApp connecté !</h2>
                    <p class="success">Le client <strong>${clientId}</strong> est connecté avec le numéro <strong>${phoneNumber}</strong>.</p>
                    <p>Vous pouvez maintenant recevoir des alertes.</p>
                </body>
                </html>
            `);
        }

        if (instance.qr) {
            const qrImage = await qrcode.toDataURL(instance.qr);
            return res.send(`
                <!DOCTYPE html>
                <html>
                <head>
                    <meta charset="UTF-8">
                    <title>QR Code - StockAlert</title>
                    <style>
                        body { font-family: Arial; text-align: center; margin: 20px; }
                        .container { max-width: 400px; margin: 0 auto; }
                        .qr-code img { max-width: 100%; border: 1px solid #ddd; border-radius: 5px; }
                        button { padding: 10px 20px; background: #25D366; color: white; border: none; border-radius: 5px; cursor: pointer; }
                    </style>
                </head>
                <body>
                    <div class="container">
                        <h2>📱 Scannez le QR Code</h2>
                        <p><strong>Client:</strong> ${clientId} | <strong>Numéro:</strong> ${phoneNumber}</p>
                        <div class="qr-code">
                            <img src="${qrImage}" alt="QR Code">
                        </div>
                        <p>Ouvrez WhatsApp → Paramètres → Appareils connectés → Connecter un appareil</p>
                        <button onclick="location.reload()">↻ Actualiser</button>
                    </div>
                </body>
                </html>
            `);
        }

        return res.send(`
            <!DOCTYPE html>
            <html>
            <head>
                <meta charset="UTF-8">
                <title>Génération QR - StockAlert</title>
            </head>
            <body>
                <h2>⏳ Génération du QR Code en cours...</h2>
                <p>Veuillez patienter...</p>
                <script>setTimeout(() => location.reload(), 3000);</script>
            </body>
            </html>
        `);

    } catch (err) {
        console.error('Erreur /scan-qr:', err);
        return res.status(500).send(`
            <!DOCTYPE html>
            <html>
            <head>
                <meta charset="UTF-8">
                <title>Erreur - StockAlert</title>
            </head>
            <body>
                <h2>❌ Erreur serveur</h2>
                <p>${err.message}</p>
            </body>
            </html>
        `);
    }
});

// Endpoint pour envoyer une alerte
app.post('/send-alert', async (req, res) => {
    try {
        const { clientId, phone, message } = req.body;

        if (!clientId || !phone || !message) {
            return res.status(400).json({ error: 'clientId, phone et message sont requis' });
        }

        let instance = instances.get(clientId);
        if (!instance) {
            instance = await initInstance(clientId, phone);
            await new Promise(resolve => setTimeout(resolve, 2000));
        }

        if (!instance.connected) {
            return res.status(503).json({
                error: 'WhatsApp non connecté',
                solution: `Scannez d'abord le QR: https://whatsapp-alerts-production-7426.up.railway.app/scan-qr?id=${clientId}&phone=${encodeURIComponent(phone)}`
            });
        }

        const jid = phone.replace(/\D/g, '') + '@s.whatsapp.net';
        await instance.sock.sendMessage(jid, { text: message });

        res.json({
            success: true,
            message: 'Alerte envoyée avec succès',
            clientId: clientId,
            sentTo: jid
        });

    } catch (err) {
        console.error('Erreur /send-alert:', err);
        res.status(500).json({ error: err.message });
    }
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Serveur démarré sur le port ${PORT}`);
    console.log(`🌐 URL: https://whatsapp-alerts-production-7426.up.railway.app`);
});