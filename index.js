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

// --- 2. INITIALISATION D'EXPRESS ---
const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

// --- 3. VARIABLES GLOBALES ---
let sock;
const pendingOrders = new Map();
let currentQRCode = null;
const ADMIN_PHONE = process.env.ADMIN_PHONE_NUMBER || "+22791848270"; // Ton numéro admin

// --- 4. FONCTIONS UTILITAIRES ---
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
        console.log('\n🔴🔴🔴 NOUVEAU QR CODE GÉNÉRÉ 🔴🔴🔴');
        console.log('📱 Scannez ce QR code avec votre téléphone WhatsApp :');
        console.log('🌐 URL : https://whatsapp-alerts-production-af15.up.railway.app/qrcode');
      }

      if (connection === 'close') {
        const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
        if (shouldReconnect) {
          console.log('🔄 Reconnexion dans 5 secondes...');
          setTimeout(connectToWhatsApp, 5000);
        } else {
          console.log('⚠️ Déconnecté. Un nouveau QR code sera généré.');
          cleanAuthFiles();
          setTimeout(connectToWhatsApp, 10000);
        }
      } else if (connection === 'open') {
        console.log('\n✅✅✅ CONNECTÉ À WHATSAPP ! ✅✅✅');
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
                await sock.sendMessage(order.phone, {
                  text: `✅ COMMANDE CONFIRMÉE pour ${order.product}`
                });
              } else if (selectedButtonId === 'cancel_order') {
                await sock.sendMessage(order.phone, {
                  text: `❌ Commande annulée pour ${order.product}`
                });
              }
            } catch (error) {
              console.error('❌ Erreur lors de l\'envoi de la confirmation:', error);
            }
            pendingOrders.delete(orderId);
          }
        }
      }
    });

  } catch (error) {
    console.error('❌ Erreur dans connectToWhatsApp :', error);
    cleanAuthFiles();
    setTimeout(connectToWhatsApp, 10000);
  }
}

// --- 5. MIDDLEWARE POUR LES TIMEOUTS ET LOGGING ---
app.use((req, res, next) => {
  console.log(`\n📥 [${new Date().toISOString()}] ${req.method} ${req.path}`);
  next();
});

app.use((req, res, next) => {
  req.setTimeout(30000, () => {
    if (!res.headersSent) {
      console.log('⏰ Timeout requête pour:', req.path);
      res.status(408).json({ error: 'Request Timeout' });
    }
  });
  res.setTimeout(30000, () => {
    if (!res.headersSent) {
      console.log('⏰ Timeout réponse pour:', req.path);
      res.status(504).json({ error: 'Response Timeout' });
    }
  });
  next();
});

// --- 6. ENDPOINTS ---
app.get('/', (req, res) => {
  res.status(200).json({
    status: 'success',
    message: 'Serveur Stock Alert en ligne.',
    whatsappConnected: !!sock,
    qrCodeAvailable: !!currentQRCode,
    adminPhone: ADMIN_PHONE
  });
});

app.get('/qrcode', (req, res) => {
  if (!currentQRCode) {
    return res.status(404).json({
      status: 'error',
      message: 'Aucun QR code disponible. Redémarrez le serveur.'
    });
  }
  const base64Data = currentQRCode.replace(/^data:image\/png;base64,/, '');
  const imgBuffer = Buffer.from(base64Data, 'base64');
  res.writeHead(200, {
    'Content-Type': 'image/png',
    'Content-Length': imgBuffer.length
  });
  res.end(imgBuffer);
});

app.all('/send-order-alert', async (req, res) => {
  try {
    console.log('\n📩 NOUVELLE ALERTE STOCK');
    console.log('🔍 Body reçu:', req.body);

    if (req.method === 'GET') {
      return res.status(200).json({
        status: 'success',
        message: 'Endpoint OK. Utilisez POST pour envoyer une alerte.',
        whatsappConnected: !!sock
      });
    }

    if (!req.body || Object.keys(req.body).length === 0) {
      return res.status(400).json({
        status: 'error',
        message: 'Body vide !'
      });
    }

    const { phone, product, quantity, supplier, threshold, orderld } = req.body;
    const finalPhone = phone || ADMIN_PHONE;
    const orderIdentifier = orderld || `ORDER-${product}-${Date.now()}`;

    // Vérifie que WhatsApp est connecté
    if (!sock) {
      return res.status(503).json({
        status: 'error',
        message: 'WhatsApp non connecté. Scannez le QR code à /qrcode',
        whatsappStatus: !!sock
      });
    }

    // Formate le numéro de téléphone
    const formattedPhone = finalPhone.replace(/[^0-9]/g, '').replace(/^0+/, '') + '@s.whatsapp.net';
    console.log('📱 Numéro formaté:', formattedPhone);

    // Stocke la commande en attente
    pendingOrders.set(orderIdentifier, {
      phone: formattedPhone,
      product,
      quantity,
      supplier,
      threshold
    });

    // Envoie le message WhatsApp
    try {
      const messageContent = {
        text: `🚨 *ALERTE RUPTURE DE STOCK* 🚨\n\n📦 *Produit* : ${product}\n📊 *Quantité* : ${quantity}\n⚠️ *Seuil* : ${threshold}\n🏪 *Fournisseur* : ${supplier}`,
        buttons: [
          { buttonId: 'confirm_order', buttonText: { displayText: '✅ Commander' }, type: 1 },
          { buttonId: 'cancel_order', buttonText: { displayText: '❌ Ignorer' }, type: 1 }
        ]
      };

      await sock.sendMessage(formattedPhone, messageContent);
      console.log('✅ Message envoyé à:', formattedPhone);

      return res.status(200).json({
        status: 'success',
        message: 'Alerte envoyée avec succès !',
        orderId: orderIdentifier,
        sentTo: formattedPhone
      });

    } catch (whatsappError) {
      console.error('❌ ÉCHEC WhatsApp:', whatsappError);
      return res.status(500).json({
        status: 'error',
        message: 'Échec de l\'envoi WhatsApp',
        error: whatsappError.message,
        formattedPhone: formattedPhone
      });
    }

  } catch (error) {
    console.error('❌ Erreur:', error);
    return res.status(500).json({
      status: 'error',
      message: error.message
    });
  }
});

// --- 7. DÉMARRAGE DU SERVEUR ---
const PORT = process.env.PORT || 808