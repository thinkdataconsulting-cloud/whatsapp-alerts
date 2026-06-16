// --- 1. DÉPENDANCES ET INITIALISATIONS ---
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const qrcode = require('qrcode');
const express = require('express');
const pino = require('pino');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Fix pour "crypto is not defined"
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

// Initialise Express
const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

// Variables globales
let sock;
const pendingOrders = new Map();
let currentQRCode = null;
const ADMIN_PHONE = process.env.ADMIN_PHONE_NUMBER || "+22791848270";

// --- 2. FONCTIONS UTILITAIRES ---
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
      printQRInTerminal: true,  // Affiche le QR dans les logs
      logger: pino({ level: 'error' }),
      browser: ['WhatsApp Alerts Bot', 'Chrome', '1.0.0'],
      version: version,
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        // Génère le QR code UNE SEULE FOIS
        if (!currentQRCode) {
          currentQRCode = qr; // Stocke l'objet QR, pas l'URL
          console.log('\n🔴 NOUVEAU QR CODE GÉNÉRÉ 🔴');
          console.log('🌐 URL : https://whatsapp-alerts-production-af15.up.railway.app/qrcode');
        }
      }

      if (connection === 'open') {
        console.log('\n✅ CONNECTÉ À WHATSAPP ! ✅');
        currentQRCode = null; // Réinitialise le QR code
      }

      if (connection === 'close') {
        const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
        if (shouldReconnect) {
          console.log('🔄 Reconnexion dans 5 secondes...');
          setTimeout(connectToWhatsApp, 5000);
        } else {
          console.log('⚠️ Déconnecté. Scannez un nouveau QR code.');
          cleanAuthFiles();
          currentQRCode = null; // Réinitialise avant de reconnecter
          setTimeout(connectToWhatsApp, 10000);
        }
      }
    });

    sock.ev.on('messages.upsert', async (m) => {
      // ... (garde ton code existant)
    });

  } catch (error) {
    console.error('❌ Erreur WhatsApp:', error);
    setTimeout(connectToWhatsApp, 10000);
  }
}
    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('messages.upsert', async (m) => {
      const message = m.messages[0];
      if (!message.key.fromMe && message.pushName) {
        const buttonResponse = message.message?.buttonsResponseMessage;
        if (buttonResponse) {
          const { selectedButtonId, id: orderId } = buttonResponse;
          const order = pendingOrders.get(orderId);
          if (order) {
            try {
              const formattedPhone = order.phone.replace(/[^0-9]/g, '') + '@s.whatsapp.net';
              if (selectedButtonId === 'confirm_order') {
                await sock.sendMessage(formattedPhone, {
                  text: `✅ COMMANDE CONFIRMÉE pour ${order.product}`
                });
              } else if (selectedButtonId === 'cancel_order') {
                await sock.sendMessage(formattedPhone, {
                  text: `❌ Commande annulée pour ${order.product}`
                });
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

// --- 3. MIDDLEWARE ---
app.use((req, res, next) => {
  req.setTimeout(30000, () => {
    if (!res.headersSent) {
      res.status(408).json({ error: 'Request Timeout' });
    }
  });
  res.setTimeout(30000, () => {
    if (!res.headersSent) {
      res.status(504).json({ error: 'Response Timeout' });
    }
  });
  next();
});

// --- 4. ENDPOINTS ---
app.get('/', (req, res) => {
  res.json({
    status: 'success',
    message: 'Serveur WhatsApp Alerts en ligne.',
    whatsappConnected: !!sock && sock.ws?.readyState === 1,
    qrCodeAvailable: !!currentQRCode
  });
});

app.get('/qrcode', async (req, res) => {
  if (!currentQRCode) {
    return res.status(404).json({
      status: 'error',
      message: 'Aucun QR code disponible. Attendez qu\'un nouveau soit généré.'
    });
  }

  try {
    // Génère l'image QR à partir de l'objet
    const qrBuffer = await qrcode.toBuffer(currentQRCode, { width: 400, margin: 2 });
    res.writeHead(200, { 'Content-Type': 'image/png' });
    res.end(qrBuffer);
  } catch (error) {
    console.error('❌ Erreur QR code:', error);
    res.status(500).json({ error: 'Erreur lors de la génération du QR code' });
  }
});
app.post('/send-order-alert', async (req, res) => {
  try {
    if (!sock || sock.ws?.readyState !== 1) {
      return res.status(503).json({
        error: 'WhatsApp non connecté. Scannez le QR code à /qrcode',
        sockStatus: sock?.ws?.readyState
      });
    }

    const { phone, product, quantity, supplier, threshold, orderld } = req.body;
    const finalPhone = phone || ADMIN_PHONE;
    const formattedPhone = finalPhone.replace(/[^0-9]/g, '') + '@s.whatsapp.net';
    const orderIdentifier = orderld || `ORDER-${product}-${Date.now()}`;

    // Stocke la commande
    pendingOrders.set(orderIdentifier, {
      phone: formattedPhone,
      product,
      quantity,
      supplier,
      threshold
    });

    // Envoie le message
    await sock.sendMessage(formattedPhone, {
      text: `🚨 ALERTE STOCK FAIBLE 🚨\n\n📦 Produit: ${product}\n📊 Quantité: ${quantity}\n⚠️ Seuil: ${threshold}\n🏪 Fournisseur: ${supplier}`,
      buttons: [
        { buttonId: 'confirm_order', buttonText: { displayText: '✅ Oui' }, type: 1 },
        { buttonId: 'cancel_order', buttonText: { displayText: '❌ Non' }, type: 1 }
      ]
    });

    return res.json({
      success: true,
      message: 'Alerte envoyée avec succès !',
      orderId: orderIdentifier,
      sentTo: formattedPhone
    });

  } catch (error) {
    console.error('❌ Erreur:', error);
    return res.status(500).json({
      error: error.message,
      stack: error.stack
    });
  }
});

// --- 5. DÉMARRAGE ---
const PORT = process.env.PORT || 8080;
const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Serveur démarré sur le port ${PORT}`);
  console.log(`🌐 URL: https://whatsapp-alerts-production-af15.up.railway.app`);
  connectToWhatsApp();
});

server.on('error', (error) => {
  console.error('❌ Erreur serveur:', error);
  if (error.code === 'EADDRINUSE') {
    setTimeout(() => server.listen(3000, '0.0.0.0', connectToWhatsApp), 1000);
  }
});