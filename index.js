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

// SÉCURITÉ CLOUD : Répertoire d'écriture temporaire sur Railway
const AUTH_DIR = path.join('/tmp', 'auth_info_baileys');

// ====== 2. FONCTIONS UTILITAIRES ======
function cleanAuthFiles() {
  if (fs.existsSync(AUTH_DIR)) {
    try {
      fs.rmSync(AUTH_DIR, { recursive: true, force: true });
      console.log('🧹 Base de session réinitialisée.');
    } catch (e) {
      console.log('⚠️ Erreur nettoyage temporaire :', e.message);
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
        console.log('\n🔴 NOUVEAU QR CODE GÉNÉRÉ 🔴');
      }

      if (connection === 'close') {
        currentQRCode = null;
        const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
        if (shouldReconnect) {
          console.log('🔄 Reconnexion dans 5 secondes...');
          setTimeout(connectToWhatsApp, 5000);
        } else {
          console.log('⚠️ Session déconnectée. Réinitialisation...');
          cleanAuthFiles();
          setTimeout(connectToWhatsApp, 10000);
        }
      } else if (connection === 'open') {
        console.log('\n✅ CONNECTÉ À WHATSAPP AVEC SUCCÈS ! ✅');
        currentQRCode = null;
      }
    });

    // ÉCOUTEUR INTERACTIF OPTIMISÉ POUR MATCH LES NUMÉROS BRUTS
    sock.ev.on('messages.upsert', async (m) => {
      try {
        const message = m.messages[0];
        if (!message || message.key.fromMe || !message.message) return;

        const from = message.key.remoteJid;
        if (!from) return;

        // Récupération du texte
        const textResponse = message.message.conversation || 
                             message.message.extendedTextMessage?.text || 
                             "";

        const cleanText = textResponse.trim().toLowerCase();
        if (!cleanText) return; 

        // Extraction stricte des chiffres de l'expéditeur (ex: 22791848270)
        const senderDigits = from.replace(/\D/g, '');
        console.log(`📩 Message reçu de [${senderDigits}] : "${cleanText}"`);

        let foundOrderKey = null;
        let foundOrder = null;

        // Parcours global pour trouver une alerte en attente sur ce numéro
        for (const [orderId, orderData] of pendingOrders.entries()) {
          if (orderData && orderData.phoneJid) {
            const storedDigits = orderData.phoneJid.replace(/\D/g, '');
            if (storedDigits === senderDigits) {
              foundOrderKey = orderId;
              foundOrder = orderData;
              break;
            }
          }
        }

        if (foundOrder) {
          console.log(`🎯 Alerte correspondante trouvée pour le produit : ${foundOrder.product}`);
          
          if (cleanText === '1' || cleanText === 'oui') {
            await sock.sendMessage(from, {
              text: `✅ *COMMANDE CONFIRMÉE*\n\nLe processus d'achat a été validé avec succès pour le produit : *${foundOrder.product}*.\n\n_ID de session : ${foundOrderKey}_`
            });
            pendingOrders.delete(foundOrderKey);
            console.log(`✅ Commande ${foundOrderKey} validée et purgée.`);
          } else if (cleanText === '2' || cleanText === 'non') {
            await sock.sendMessage(from, {
              text: `❌ *COMMANDE ANNULÉE*\n\nL'achat pour le produit *${foundOrder.product}* a été rejeté.`
            });
            pendingOrders.delete(foundOrderKey);
            console.log(`❌ Commande ${foundOrderKey} annulée et purgée.`);
          } else {
            // Option d'aide si l'utilisateur répond autre chose
            await sock.sendMessage(from, {
              text: `⚠️ *Choix invalide.*\n\nUne alerte est en cours pour *${foundOrder.product}*.\n\nVeuillez répondre uniquement :\n👉 *1* ou *Oui* (Pour commander)\n👉 *2* ou *Non* (Pour annuler)`
            });
          }
        }
      } catch (upsertError) {
        console.error('⚠️ Erreur écouteur messages :', upsertError.message);
      }
    });

  } catch (error) {
    console.error('❌ Erreur globale WhatsApp :', error);
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
    whatsappConnected: !!sock && sock.ws?.readyState === 1,
    pendingOrdersCount: pendingOrders.size
  });
});

app.get('/qrcode', (req, res) => {
  if (!currentQRCode) {
    return res.status(404).json({ status: 'error', message: 'Aucun QR code disponible ou déjà associé.' });
  }
  const base64Data = currentQRCode.replace(/^data:image\/png;base64,/, '');
  const imgBuffer = Buffer.from(base64Data, 'base64');
  res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': imgBuffer.length });
  res.end(imgBuffer);
});

app.all('/send-order-alert', async (req, res) => {
  try {
    if (req.method === 'GET') {
      return res.status(200).json({ status: 'success', message: 'Utilisez POST.' });
    }

    if (!req.body || Object.keys(req.body).length === 0) {
      return res.status(400).json({ status: 'error', message: 'Body vide.' });
    }

    // Capture exhaustive de toutes les typos possibles d'identifiants ou de numéros
    const { phone, telephone, product, quantity, supplier, threshold, orderld, orderId, orderID } = req.body;
    
    const finalPhone = phone || telephone;
    const orderIdentifier = orderld || orderId || orderID;

    if (!finalPhone || !product || quantity === undefined || !supplier || threshold === undefined || !orderIdentifier) {
      return res.status(400).json({ 
        status: 'error', 
        message: "Données JSON incomplètes.",
        received: req.body
      });
    }

    if (!sock || sock.ws?.readyState !== 1) {
      return res.status(503).json({ status: 'error', message: 'WhatsApp déconnecté sur Railway.' });
    }

    const cleanedPhone = String(finalPhone).replace(/\D/g, '');
    if (!cleanedPhone) {
      return res.status(400).json({ status: 'error', message: 'Numéro de téléphone invalide.' });
    }

    const formattedPhone = cleanedPhone + '@s.whatsapp.net';

    // Stockage persistant standardisé en mémoire vive
    pendingOrders.set(String(orderIdentifier).trim(), {
      phoneJid: formattedPhone,
      product,
      quantity,
      supplier,
      threshold
    });

    const alertMessage = `🚨 *ALERTE STOCK FAIBLE* 🚨\n\n` +
                         `📦 *Produit* : ${product}\n` +
                         `📊 *Quantité Actuelle* : ${quantity}\n` +
                         `⚠️ *Seuil Minimal* : ${threshold}\n` +
                         `🏪 *Fournisseur* : ${supplier}\n\n` +
                         `*Souhaitez-vous commander ?*\n` +
                         `👉 Répondez *1* (ou *Oui*)\n` +
                         `👉 Répondez *2* (ou *Non*)`;

    await sock.sendMessage(formattedPhone, { text: alertMessage });

    return res.status(200).json({
      status: 'success',
      message: 'Alerte WhatsApp transmise avec succès.',
      orderId: orderIdentifier
    });

  } catch (error) {
    console.error('❌ Erreur d\'envoi HTTP :', error);
    return res.status(500).json({ status: 'error', message: error.message });
  }
});

// ====== 5. DÉMARRAGE ======
const PORT = process.env.PORT || 8080;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Serveur actif sur le port ${PORT}`);
  connectToWhatsApp();
});