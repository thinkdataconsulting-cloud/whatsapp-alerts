// ====== 1. DÉPENDANCES ET INITIALISATIONS ======
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const qrcode = require('qrcode');
const express = require('express');
const pino = require('pino');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Fix pour "crypto is not defined" dans les conteneurs distants
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

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

// Variables globales
let sock;
const pendingOrders = new Map();
let currentQRCode = null;
const ADMIN_PHONE = process.env.ADMIN_PHONE_NUMBER || "+22791848270";

// CORRECTION CLOUD : Écriture impérative dans /tmp pour contourner le mode Read-Only de Railway
const AUTH_DIR = path.join('/tmp', 'auth_info_baileys');

// ====== 2. FONCTIONS UTILITAIRES ======
function cleanAuthFiles() {
  if (fs.existsSync(AUTH_DIR)) {
    try {
      fs.rmSync(AUTH_DIR, { recursive: true, force: true });
      console.log('🧹 Session temporaire déconnectée nettoyée.');
    } catch (e) {
      console.log('⚠️ Impossible de nettoyer /tmp :', e.message);
    }
  }
}

async function connectToWhatsApp() {
  try {
    if (!fs.existsSync(AUTH_DIR)) {
      fs.mkdirSync(AUTH_DIR, { recursive: true });
    }

    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    const { version } = await fetchLatestBaileysVersion();

    sock = makeWASocket({
      auth: state,
      printQRInTerminal: true,  
      logger: pino({ level: 'error' }),
      browser: ['WhatsApp Alerts Bot', 'Chrome', '1.0.0'],
      version: version,
    });

    sock.ev.on('creds.update', saveCreds);

    // Gestion de l'état de la connexion
    sock.ev.on('connection.update', (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        if (!currentQRCode) {
          currentQRCode = qr; 
          console.log('\n🔴 NOUVEAU QR CODE GÉNÉRÉ 🔴');
          console.log('🌐 URL DE SCAN : https://whatsapp-alerts-production-af15.up.railway.app/qrcode');
        }
      }

      if (connection === 'open') {
        console.log('\n✅ CONNECTÉ À WHATSAPP AVEC SUCCÈS ! ✅');
        currentQRCode = null; 
      }

      if (connection === 'close') {
        currentQRCode = null; 
        const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
        if (shouldReconnect) {
          console.log('🔄 Reconnexion dans 5 secondes...');
          setTimeout(connectToWhatsApp, 5000);
        } else {
          console.log('⚠️ Session rejetée. Réinitialisation complète...');
          cleanAuthFiles();
          setTimeout(connectToWhatsApp, 10000);
        }
      }
    });

    // Gestion des réponses aux boutons (Reçu une seule fois)
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
              console.error('❌ Erreur lors de la réponse au bouton :', error);
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

// ====== 3. MIDDLEWARE TIMEOUT ======
app.use((req, res, next) => {
  req.setTimeout(30000, () => {
    if (!res.headersSent) res.status(408).json({ error: 'Request Timeout' });
  });
  res.setTimeout(30000, () => {
    if (!res.headersSent) res.status(504).json({ error: 'Response Timeout' });
  });
  next();
});

// ====== 4. ENDPOINTS HTTP ======
app.get('/', (req, res) => {
  res.json({
    status: 'success',
    message: 'Serveur WhatsApp Alerts en ligne.',
    whatsappConnected: !!sock && sock.ws?.readyState === 1,
    qrCodeAvailable: !!currentQRCode
  });
});

// Endpoint d'affichage du QR Code sous forme d'image PNG claire
app.get('/qrcode', async (req, res) => {
  if (!currentQRCode) {
    return res.status(404).json({
      status: 'error',
      message: 'Aucun QR code disponible. S\'il est déjà connecté, visitez la racine /'
    });
  }

  try {
    const qrBuffer = await qrcode.toBuffer(currentQRCode, { width: 400, margin: 2 });
    res.writeHead(200, { 'Content-Type': 'image/png' });
    res.end(qrBuffer);
  } catch (error) {
    console.error('❌ Erreur génération image QR code:', error);
    res.status(500).json({ error: 'Erreur de traitement de l\'image QR.' });
  }
});

// CORRECTION 'orderld' -> 'orderId' : Réception des flux n8n
app.post('/send-order-alert', async (req, res) => {
  try {
    if (!sock || sock.ws?.readyState !== 1) {
      return res.status(503).json({
        error: 'WhatsApp non connecté. Veuillez flasher le code sur /qrcode',
        sockStatus: sock?.ws?.readyState
      });
    }

    // Extraction des paramètres du JSON (Correction de l'ID)
    const { phone, product, quantity, supplier, threshold, orderId } = req.body;
    
    const finalPhone = phone || ADMIN_PHONE;
    const formattedPhone = finalPhone.replace(/[^0-9]/g, '') + '@s.whatsapp.net';
    const orderIdentifier = orderId || `ORDER-${product}-${Date.now()}`;

    // Sauvegarde en mémoire vive pour gérer les interactions de l'utilisateur
    pendingOrders.set(orderIdentifier, {
      phone: formattedPhone,
      product,
      quantity,
      supplier,
      threshold
    });

    // Envoi de l'alerte interactive avec boutons vers l'appareil cible
    await sock.sendMessage(formattedPhone, {
      text: `🚨 *ALERTE STOCK FAIBLE* 🚨\n\n📦 *Produit*: ${product}\n📊 *Quantité Actuelle*: ${quantity}\n⚠️ *Seuil Alerte*: ${threshold}\n🏪 *Fournisseur*: ${supplier}\n\nVoulez-vous déclencher la commande ?`,
      buttons: [
        { buttonId: 'confirm_order', buttonText: { displayText: '✅ Oui, commander' }, type: 1 },
        { buttonId: 'cancel_order', buttonText: { displayText: '❌ Non, ignorer' }, type: 1 }
      ],
      footer: 'Système d\'automatisation de stock'
    });

    return res.json({
      success: true,
      message: 'Alerte envoyée avec succès !',
      orderId: orderIdentifier,
      sentTo: formattedPhone
    });

  } catch (error) {
    console.error('❌ Erreur envoi message HTTP :', error);
    return res.status(500).json({
      error: error.message,
      stack: error.stack
    });
  }
});

// ====== 5. DÉMARRAGE DU PROCESSEUR ======
const PORT = process.env.PORT || 8080;
const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Serveur démarré sur le port ${PORT}`);
  console.log(`🌐 URL cible n8n : https://whatsapp-alerts-production-af15.up.railway.app/send-order-alert`);
  connectToWhatsApp();
});

server.on('error', (error) => {
  console.error('❌ Erreur fatale serveur:', error);
  if (error.code === 'EADDRINUSE') {
    setTimeout(() => server.listen(3000, '0.0.0.0', connectToWhatsApp), 1000);
  }
});