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

// Initialise Express avec les middlewares corrects
const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

// --- VARIABLES GLOBALES ---
let sock;
const pendingOrders = new Map();
let currentQRCode = null;

// Numéro de téléphone par défaut (ton numéro admin)
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
        console.log('📱 Bot prêt à envoyer des alertes !');
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
                console.log(`✅ Commande confirmée pour ${order.product} (${order.phone})`);
              } else if (selectedButtonId === 'cancel_order') {
                await sock.sendMessage(order.phone, {
                  text: `❌ Commande annulée pour ${order.product}`
                });
                console.log(`❌ Commande annulée pour ${order.product} (${order.phone})`);
              }
            } catch (error) {
              console.error('❌ Erreur lors de l\'envoi de la confirmation:', error);
            }
            pendingOrders.delete(orderId);
          }
        }
      }
    });

    sock.ev.on('connection.error', (error) => {
      console.error('❌ Erreur de connexion WhatsApp:', error);
    });

  } catch (error) {
    console.error('❌ Erreur dans connectToWhatsApp :', error);
    cleanAuthFiles();
    setTimeout(connectToWhatsApp, 10000);
  }
}

// --- 3. MIDDLEWARE POUR LES TIMEOUTS ET LOGGING ---
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

// --- 4. ENDPOINTS ---
app.get('/', (req, res) => {
  res.status(200).json({
    status: 'success',
    message: 'Serveur Stock Alert en ligne.',
    whatsappConnected: !!sock,
    qrCodeAvailable: !!currentQRCode,
    adminPhone: ADMIN_PHONE,
    endpoints: {
      qrcode: '/qrcode',
      sendAlert: '/send-order-alert'
    }
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
        whatsappConnected: !!sock,
        adminPhone: ADMIN_PHONE,
        examplePayload: {
          product: "Farine 25kg",
          quantity: 5,
          supplier: "Societe B",
          threshold: 5,
          orderld: "ORDER-123456",
          phone: ADMIN_PHONE // Numéro par défaut
        }
      });
    }

    // Vérifie que le body n'est pas vide
    if (!req.body || Object.keys(req.body).length === 0) {
      return res.status(400).json({
        status: 'error',
        message: 'Body vide ! Vérifiez que vous envoyez un JSON valide.'
      });
    }

    // Extrait les champs
    const { phone, product, quantity, supplier, threshold, orderld } = req.body;

    // Utilise le numéro du body ou le numéro admin par défaut
    const finalPhone = phone || ADMIN_PHONE;
    const orderIdentifier = orderld || `ORDER-${product}-${Date.now()}`;

    console.log('🔍 Données traitées:', {
      phone: finalPhone,
      product,
      quantity,
      supplier,
      threshold,
      orderIdentifier
    });

    // Vérifie que tous les champs requis sont présents
    if (!product || quantity === undefined || !supplier || threshold === undefined) {
      return res.status(400).json({
        status: 'error',
        message: `Données manquantes: ${Object.entries({ product, quantity, supplier, threshold })
          .filter(([_, value]) => !value && value !== 0)
          .map(([key]) => key)
          .join(', ')}`,
        receivedData: req.body
      });
    }

    // Vérifie que WhatsApp est connecté
    if (!sock) {
      return res.status(503).json({
        status: 'error',
        message: 'WhatsApp non connecté. Scannez d\'abord le QR code à /qrcode',
        receivedData: req.body
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

    // Contenu du message
    const messageContent = {
      text: `🚨 *ALERTE RUPTURE DE STOCK* 🚨\n\n📦 *Produit* : ${product}\n📊 *Quantité actuelle* : ${quantity}\n⚠️ *Seuil minimal* : ${threshold}\n🏪 *Fournisseur* : ${supplier}\n\n💡 *Action requise* : Passer une commande ?`,
      buttons: [
        { buttonId: 'confirm_order', buttonText: { displayText: '✅ Oui, commander' }, type: 1 },
        { buttonId: 'cancel_order', buttonText: { displayText: '❌ Non, ignorer' }, type: 1 }
      ],
      footer: 'StockAlert - Gestion des stocks'
    };

    // Envoie le message WhatsApp
    try {
      await sock.sendMessage(formattedPhone, messageContent);
      console.log('✅ Alerte envoyée à:', formattedPhone);

      return res.status(200).json({
        status: 'success',
        message: 'Alerte de rupture de stock envoyée avec succès !',
        orderId: orderIdentifier,
        sentTo: formattedPhone,
        whatsappConnected: true
      });
    } catch (whatsappError) {
      console.error('❌ ÉCHEC de l\'envoi WhatsApp:', whatsappError);
      return res.status(500).json({
        status: 'error',
        message: 'Échec de l\'envoi du message WhatsApp',
        errorDetails: whatsappError.message,
        formattedPhone: formattedPhone,
        whatsappConnected: !!sock
      });
    }

  } catch (error) {
    console.error('❌ Erreur dans /send-order-alert :', error);
    return res.status(500).json({
      status: 'error',
      message: error.message || 'Erreur interne du serveur',
      errorDetails: error.stack
    });
  }
});

// --- 5. DÉMARRAGE DU SERVEUR ---
const PORT = process.env.PORT || 8080;
const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🚀🚀🚀 SERVEUR STOCK ALERT DÉMARRÉ 🚀🚀🚀`);
  console.log(`🌐 URL locale: http://localhost:${PORT}`);
  console.log(`🌐 URL publique: https://whatsapp-alerts-production-af15.up.railway.app`);
  console.log(`📞 Numéro admin: ${ADMIN_PHONE}`);
  console.log(`📡 Endpoints:`);
  console.log(`   - GET  /          → État du serveur`);
  console.log(`   - GET  /qrcode    → QR Code pour la connexion WhatsApp`);
  console.log(`   - POST /send-order-alert → Envoyer une alerte`);
  console.log(`\n🔹 Prochaine étape: Scannez le QR code à /qrcode pour connecter WhatsApp !\n`);
  connectToWhatsApp();
});

// Gère les erreurs du serveur
server.on('error', (error) => {
  console.error('❌ Erreur du serveur:', error);
  if (error.code === 'EADDRINUSE') {
    console.log('⚠️ Port déjà utilisé. Essayons le port 3000...');
    setTimeout(() => {
      server.close();
      server.listen(3000, '0.0.0.0', () => {
        console.log(`🚀 Serveur démarré sur http://localhost:3000`);
        connectToWhatsApp();
      });
    }, 1000);
  }
});