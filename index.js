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

const PORT = process.env.PORT || 8080;

const instances = new Map();

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
        logger: pino({ level: 'info' }),
        browser: Browsers.ubuntu('Chrome'),
        syncFullHistory: false,
        markOnlineOnConnect: false,
        generateHighQualityLinkPreview: false,
        printQRInTerminal: true
    });

    const instance = {
        sock,
        qr: null,
        connected: false
    };

    instances.set(clientId, instance);

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {

        console.log(
            `[${clientId}] UPDATE`,
            JSON.stringify(update, null, 2)
        );

        const {
            connection,
            lastDisconnect,
            qr
        } = update;

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

            const statusCode =
                lastDisconnect?.error?.output?.statusCode;

            console.log(
                `❌ ${clientId} déconnecté`,
                statusCode
            );

            if (statusCode !== DisconnectReason.loggedOut) {

                console.log(
                    `🔄 Reconnexion de ${clientId} dans 10 secondes`
                );

                setTimeout(async () => {

                    instances.delete(clientId);

                    try {
                        await initInstance(clientId);
                    } catch (err) {
                        console.error(err);
                    }

                }, 10000);

            } else {

                console.log(
                    `🗑️ Session supprimée pour ${clientId}`
                );

                try {
                    fs.rmSync(authDir, {
                        recursive: true,
                        force: true
                    });
                } catch (e) {}

                instances.delete(clientId);
            }
        }
    });

    return instance;
}

app.get('/', (req, res) => {
    res.send('WhatsApp Alerts API Active');
});

app.get('/status/:clientId', async (req, res) => {

    const clientId = req.params.clientId;

    const instance = instances.get(clientId);

    if (!instance) {
        return res.json({
            exists: false
        });
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
            return res.status(400).send('ID manquant');
        }

        let instance = instances.get(clientId);

        if (!instance) {
            instance = await initInstance(clientId);
        }

        if (instance.connected) {
            return res.send(`
                <h2>✅ WhatsApp connecté</h2>
            `);
        }

        if (instance.qr) {

            const qrImage =
                await qrcode.toDataURL(instance.qr);

            return res.send(`
                <html>
                <body style="text-align:center;font-family:Arial">
                    <h2>Scanner avec WhatsApp</h2>
                    <img src="${qrImage}" />
                    <br><br>
                    <button onclick="location.reload()">
                        Actualiser
                    </button>
                </body>
                </html>
            `);
        }

        return res.send(`
            <html>
            <body style="text-align:center;font-family:Arial">
                <h2>⏳ Génération du QR...</h2>
                <script>
                    setTimeout(() => {
                        location.reload();
                    }, 3000);
                </script>
            </body>
            </html>
        `);

    } catch (err) {

        console.error(err);

        res.status(500).json({
            error: err.message
        });
    }
});

app.post('/send-alert/:clientId', async (req, res) => {

    try {

        const clientId = req.params.clientId;

        const {
            phone,
            message
        } = req.body;

        const instance =
            instances.get(clientId);

        if (!instance) {
            return res.status(404).json({
                error: 'Instance inexistante'
            });
        }

        if (!instance.connected) {
            return res.status(503).json({
                error: 'WhatsApp non connecté'
            });
        }

        const jid =
            phone.replace(/\D/g, '') +
            '@s.whatsapp.net';

        await instance.sock.sendMessage(
            jid,
            { text: message }
        );

        res.json({
            success: true
        });

    } catch (err) {

        console.error(err);

        res.status(500).json({
            error: err.message
        });
    }
});

app.listen(PORT, '0.0.0.0', () => {

    console.log(
        `🚀 Serveur démarré sur le port ${PORT}`
    );

});