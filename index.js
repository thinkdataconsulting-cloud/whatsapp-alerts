// --- 1. DÉPENDANCES ---
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const qrcode = require('qrcode');
const express = require('express');
const pino = require('pino');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// --- 2. FIX POUR CRYPTO ---
if (!globalThis.crypto) {
  globalThis.crypto = {
    getRandomValues: (buffer) => crypto.randomBytes(buffer.length),
    subtle: crypto.webcrypto?.subtle || {
      digest: async (algorithm, data) => {
        const hash = crypto.createHash(algorithm.toLowerCase().replace('-', ''));
        hash.update(data);
        return new Uint8Array(hash.digest());
      },
    },
  };
}

// --- 3. INITIALISATION D'EXPRESS (TOUT EN HAUT) ---
const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

// --- 4. VARIABLES GLOBALES ---
let sock;
const pendingOrders = new Map();
let currentQRCode = null;
const ADMIN_PHONE = process.env.ADMIN_PHONE_NUMBER || "+22791848270"; // Ton numéro admin

// --- 5. FONCTIONS UTILITAIRES ---
function cleanAuthFiles() {
  const authDir = path.join(__dirname, 'auth_info_baileys');
  if (fs.existsSync(authDir)) {
    fs.rmSync(authDir, { recursive: true, force: true });
    console.log('🧹 Anciennes sessions supprimées.');
  }
}

async function connectToWhatsApp() {
  try {
    cleanAuthFiles();
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
    const { version } = await fetchLatestBaileysVersion();

    sock = makeWASocket({
      auth: state,
      printQRInTerminal: true,
      logger: pino({ level: 'silent' }),
      browser: ['StockAlert Bot', 'Chrome', '1.0.0'],
      version: version,
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        currentQRCode = await qrcode.toDataURL(qr, { width: 400, margin: 2 });
        console.log('\n🔴 NOUVEAU QR CODE GÉNÉRÉ 🔴');
        console.log('🌐 URL : https://whatsapp-alerts-production-af15.up.railway.app/qrcode');
      }

      if (connection === 'close') {
        const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
        if (shouldReconnect) {
          setTimeout(connectToWhatsApp, 5000);
        } else {
          cleanAuthFiles();
          setTimeout(connectToWhatsApp, 10000);
        }
      } else if (connection === 'open') {
        console.log('\n✅ CONNECTÉ À WHATSAPP ! ✅');
        currentQRCode = null;
      }
    });

    sock.ev.on('messages.upsert', async (m) => {
      const message = m.messages[0];
      if (!message.key.fromMe && message.pushName) {
        const buttonResponse = message.message?.buttonsResponseMessage;
        if (buttonResponse) {
          const { selectedButtonId, id: orderId } = buttonResponse;
          const order = pendingOrders.get(orderId);
          if (order) {
            try {
              if (selectedButtonId === 'confirm_order') {
                await sock.sendMessage(order.phone, { text: `✅ COMMANDE CONFIRMÉE pour ${order.product}` });
              } else if (selectedButtonId === 'cancel_order') {
                await sock.sendMessage(order.phone, { text: `❌ Commande annulée pour ${order.product}` });
              }
            } catch (error) {
              console.error('❌ Erreur confirmation:', error);
            }
            pendingOrders.delete(orderId);
          }
        }
      }
    });

  } catch (error) {
    console.error('❌ Erreur WhatsApp:', error);
    setTimeout(connectToWhatsApp, 10000);
  }
}

// --- 6. MIDDLEWARE ---
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  next();
});

// --- 7. ENDPOINTS (APRÈS L'INITIALISATION DE APP) ---
app.get('/', (req, res) => {
  res.json({
    status: 'success',
    message: 'Serveur en ligne',
    whatsappConnected: !!sock,
    qrCodeAvailable: !!currentQRCode
  });
});

app.get('/qrcode', (req, res) => {
  if (!currentQRCode) return res.status(404).json({ error: 'Aucun QR code' });
  const base64Data = currentQRCode.replace(/^data:image\/png;base64,/, '');
  res.writeHead(200, { 'Content-Type': 'image/png' });
  res.end(Buffer.from(base64Data, 'base64'));
});

app.post('/send-order-alert', async (req, res) => {
  try {
    if (!sock) return res.status(503).json({ error: 'WhatsApp non connecté' });

    const { phone, product, quantity, supplier, threshold, orderld } = req.body;
    const finalPhone = phone || ADMIN_PHONE;
    const formattedPhone = finalPhone.replace(/[^0-9]/g, '') + '@s.whatsapp.net';

    const message = {
      text: `🚨 ALERTE STOCK FAIBLE 🚨\n\nProduit: ${product}\nQuantité: ${quantity}\nSeuil: ${threshold}\nFournisseur: ${supplier}`,
      buttons: [
        { buttonId: 'confirm_order', buttonText: { displayText: '✅ Commander' }, type: 1 },
        { buttonId: 'cancel_order', buttonText: { displayText: '❌ Ignorer' }, type: 1 }
      ]
    };

    await sock.sendMessage(formattedPhone, message);
    res.json({ status: 'success', message: 'Alerte envoyée !', sentTo: formattedPhone });

  } catch (error) {
    console.error('❌ Erreur:', error);
    res.status(500).json({ error: error.message });
  }
});

// --- 8. DÉMARRAGE DU SERVEUR (TOUT À LA FIN) ---
const PORT = process.env.PORT || 8080;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Serveur démarré sur le port ${PORT}`);
  connectToWhatsApp();
});