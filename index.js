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
            },
        },
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
                try { fs.rmSync(authDir, { recursive: true, force: true }); } catch (e) {}
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
                    <style>
                        body { font-family: Arial; text-align: center; margin-top: 50px; }
                        .error { color: red; }
                    </style>
                </head>
                <body>
                    <h2>❌ Erreur interne</h2>
                    <p class="error">Instance perdue. Veuillez réessayer.</p>
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
                        .phone { font-size: 1.2em; margin: 10px; }
                    </style>
                </head>
                <body>
                    <h2>✅ WhatsApp connecté !</h2>
                    <p class="success">Le client <strong>${clientId}</strong> est connecté avec le numéro <span class="phone">${phoneNumber}</span>.</p>
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
                        h2 { color: #25D366; }
                        .container { max-width: 400px; margin: 0 auto; }
                        .qr-code { margin: 20px; }
                        .qr-code img { max-width: 100%; border: 1px solid #ddd; border-radius: 5px; }
                        .instructions { margin: 20px; padding: 15px; background: #f8f9fa; border-radius: 5px; }
                        .client-info { margin: 10px; font-size: 1.1em; }
                        .refresh-btn { margin: 20px; }
                        button { padding: 10px 20px; background: #25D366; color: white; border: none; border-radius: 5px; cursor: pointer; }
                        button:hover { background: #128C7E; }
                    </style>
                </head>
                <body>
                    <div class="container">
                        <h2>📱 Scannez le QR Code</h2>
                        <div class="client-info">
                            <p><strong>Client:</strong> \${clientId}</p>
                            <p><strong>Numéro:</strong> \${phoneNumber}</p>
                        </div>
                        <div class="instructions">
                            <p>Ouvrez WhatsApp sur votre téléphone et scannez ce QR code pour connecter votre compte.</p>
                        </div>
                        <div class="qr-code">
                            <img src="\${qrImage}" alt="QR Code">
                        </div>
                        <div class="refresh-btn">
                            <button onclick="location.reload()">↻ Actualiser</button>
                        </div>
                        <p>Si le QR code n'apparaît pas, attendez quelques secondes et actualisez la page.</p>
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
                <style>
                    body { font-family: Arial; text-align: center; margin-top: 50px; }
                    .loading { color: #25D366; }
                    .spinner { font-size: 2em; margin: 20px; }
                </style>
            </head>
            <body>
                <h2>⏳ Génération du QR Code en cours...</h2>
                <div class="spinner">⏳</div>
                <p class="loading">Veuillez patienter, cela peut prendre quelques secondes...</p>
                <script>
                    setTimeout(() => {
                        location.reload();
                    }, 3000);
                </script>
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