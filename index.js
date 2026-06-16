// ====== 1. DÉPENDANCES ET INITIALISATIONS ======
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const qrcode = require('qrcode');
const express = require('express');
const pino = require('pino');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

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

// SÉCURITÉ CLOUD : Utilisation stricte du répertoire /tmp autorisé en écriture sur Railway
const AUTH_DIR = path.join('/tmp', 'auth_info_baileys');

// ====== 2. FONCTIONS UTILITAIRES ======
function cleanAuthFiles() {
  if (fs.existsSync(AUTH_DIR)) {
    try {
      fs.rmSync(AUTH_DIR, { recursive: true, force: true });
      console.log('🧹 Session temporaire /tmp nettoyée.');
    } catch (e) {
      console.log('⚠️ Erreur lors du nettoyage :', e.message);
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
      printQRInTerminal: false,
      logger: pino({ level: 'error' }),
      browser: ['WhatsApp Alerts Bot', 'Chrome', '1.0.0'],
      version: version,
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        currentQRCode = await qrcode.toDataURL(qr, { width: 400, margin: 2 });
        console.log('\n🔴🔴🔴 NOUVEAU QR CODE GÉNÉRÉ 🔴🔴🔴');
        console.log('📱 QR Code disponible à l\'adresse : /qrcode');
      }

      if (connection === 'close') {
        currentQRCode = null;
        const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
        if (shouldReconnect) {
          console.log('🔄 Reconnexion dans 5 secondes...');
          setTimeout(connectToWhatsApp, 5000);
        } else {
          console.log('⚠️ Déconnecté définitivement. Nettoyage et génération d\'un nouveau QR code...');
          cleanAuthFiles();
          setTimeout(connectToWhatsApp, 10000);
        }
      } else if (connection === 'open') {
        console.log('\n✅✅✅ CONNECTÉ À WHATSAPP AVEC SUCCÈS ! ✅✅✅');
        currentQRCode = null;
      }
    });

    // ÉCOUTEUR INTERACTIF : Traite la réponse de l'utilisateur ('1' ou '2')
    sock.ev.on('messages.upsert', async (m) => {
      const message = m.messages[0];
      if (!message.key.fromMe && message.message) {
        const from = message.key.remoteJid;
        const textResponse = message.message.conversation || message.message.extendedTextMessage?.text;

        if (textResponse) {
          const cleanText = textResponse.trim().toLowerCase();
          
          // Recherche d'une commande en attente liée à ce numéro d'expéditeur
          let foundOrderId = null;
          let foundOrder = null;

          for (const [orderId, orderData] of pendingOrders.entries()) {
            if (orderData.phoneJid === from) {
              foundOrderId = orderId;
              foundOrder = orderData;
              break;
            }
          }

          if (foundOrder) {
            if (cleanText === '1' || cleanText === 'oui') {
              await sock.sendMessage(from, {
                text: `✅ *COMMANDE CONFIRMÉE*\nLe processus d'achat a été validé pour le produit : *${foundOrder.product}*.`
              });
              pendingOrders.delete(foundOrderId);
            } else if (cleanText === '2' || cleanText === 'non') {
              await sock.sendMessage(from, {
                text: `❌ *COMMANDE ANNULÉE*\nL'achat pour le produit *${foundOrder.product}* a été rejeté.`
              });
              pendingOrders.delete(foundOrderId);
            } else {
              await sock.sendMessage(from, {
                text: `⚠️ *Option non reconnue.*\n\nVeuillez répondre uniquement :\n👉 *1* ou *Oui* (Pour confirmer)\n👉 *2* ou *Non* (Pour annuler)`
              });
            }
          }
        }
      }
    });

  } catch (error) {
    console.error('❌ Erreur dans connectToWhatsApp :', error);
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

// ====== 4. ENDPOINTS ======
app.get('/', (req, res) => {
  res.status(200).json({
    status: 'success',
    message: 'Serveur WhatsApp Alerts en ligne.',
    whatsappConnected: !!sock && sock.ws?.readyState === 1,
    qrCodeAvailable: !!currentQRCode
  });
});

app.get('/qrcode', (req, res) => {
  if (!currentQRCode) {
    return res.status(404).json({
      status: 'error',
      message: 'Aucun QR code disponible ou déjà connecté.'
    });
  }
  const base64Data = currentQRCode.replace(/^data:image\/png;base64,/, '');
  const imgBuffer = Buffer.from(base64Data, 'base64');
  res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': imgBuffer.length });
  res.end(imgBuffer);
});

app.all('/send-order-alert', async (req, res) => {
  try {
    if (req.method === 'GET') {
      return res.status(200).json({ status: 'success', message: 'Endpoint fonctionnel. Utilisez POST.' });
    }

    if (!req.body || Object.keys(req.body).length === 0) {
      return res.status(400).json({ status: 'error', message: 'Body de requête JSON vide.' });
    }

    const { phone, product, quantity, supplier, threshold, orderld, orderId } = req.body;
    const orderIdentifier = orderld || orderId;

    if (!phone || !product || quantity === undefined || !supplier || threshold === undefined || !orderIdentifier) {
      return res.status(400).json({ status: 'error', message: 'Données JSON incomplètes pour l\'envoi.' });
    }

    if (!sock || sock.ws?.readyState !== 1) {
      return res.status(503).json({ status: 'error', message: 'WhatsApp non connecté sur le serveur Railway.' });
    }

    const formattedPhone = phone.replace(/\D/g, '') + '@s.whatsapp.net';

    // Sauvegarde en mémoire de l'alerte
    pendingOrders.set(orderIdentifier, {
      phoneJid: formattedPhone,
      product,
      quantity,
      supplier,
      threshold
    });

    // Format textuel interactif ultra-stable (Évite le crash des boutons)
    const alertMessage = `🚨 *ALERTE STOCK FAIBLE* 🚨\n\n` +
                         `📦 *Produit* : ${product}\n` +
                         `📊 *Quantité Actuelle* : ${quantity}\n` +
                         `⚠️ *Seuil Minimal* : ${threshold}\n` +
                         `🏪 *Fournisseur* : ${supplier}\n\n` +
                         `*Souhaitez-vous commander ?*\n` +
                         `👉 Répondez *1* (ou *Oui*)\n` +
                         `👉 Répondez *2* (ou *Non*)`;

    // Envoi effectif
    await sock.sendMessage(formattedPhone, { text: alertMessage });

    return res.status(200).json({
      status: 'success',
      message: 'Alerte WhatsApp transmise avec succès.',
      orderId: orderIdentifier
    });

  } catch (error) {
    console.error('❌ Erreur d\'envoi :', error);
    return res.status(500).json({ status: 'error', message: error.message });
  }
});

// ====== 5. DÉMARRAGE ======
const PORT = process.env.PORT || 8080;
const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Serveur actif sur le port ${PORT}`);
  connectToWhatsApp();
});