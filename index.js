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

let sock;
const pendingOrders = new Map();
let currentQRCode = null;
const ADMIN_PHONE = process.env.ADMIN_PHONE_NUMBER || "+22791848270";

// Utilisation stricte de /tmp pour Railway
const AUTH_DIR = path.join('/tmp', 'auth_info_baileys');

// ====== 2. FONCTIONS UTILITAIRES ======
function cleanAuthFiles() {
  if (fs.existsSync(AUTH_DIR)) {
    try {
      fs.rmSync(AUTH_DIR, { recursive: true, force: true });
      console.log('Base de session réinitialisée.');
    } catch (e) {
      console.log(' Erreur nettoyage temporaire :', e.message);
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
          console.log(' Session rejetée. Nettoyage complet...');
          cleanAuthFiles();
          setTimeout(connectToWhatsApp, 10000);
        }
      }
    });

    // ÉCOUTE DES RÉPONSES TEXTUELLES DE L'UTILISATEUR
    sock.ev.on('messages.upsert', async (m) => {
      const message = m.messages[0];
      if (!message.key.fromMe && message.message) {
        const from = message.key.remoteJid;
        
        // Récupère le texte du message qu'il soit simple ou étendu
        const textResponse = message.message.conversation || message.message.extendedTextMessage?.text;
        
        if (textResponse) {
          const cleanText = textResponse.trim().toLowerCase();

          // On cherche s'il y a une commande en attente pour ce numéro
          let foundOrderId = null;
          let foundOrder = null;

          for (const [orderId, orderData] of pendingOrders.entries()) {
            if (orderData.phone === from) {
              foundOrderId = orderId;
              foundOrder = orderData;
              break;
            }
          }

          if (foundOrder) {
            try {
              if (cleanText === '1' || cleanText === 'oui') {
                await sock.sendMessage(from, {
                  text: `✅ *COMMANDE CONFIRMÉE* \nLe processus d'achat a été déclenché pour le produit : *${foundOrder.product}*.`
                });
                pendingOrders.delete(foundOrderId);
              } else if (cleanText === '2' || cleanText === 'non') {
                await sock.sendMessage(from, {
                  text: `❌ *COMMANDE ANNULÉE* \nL'alerte pour le produit *${foundOrder.product}* a été ignorée.`
                });
                pendingOrders.delete(foundOrderId);
              } else {
                await sock.sendMessage(from, {
                  text: `⚠️ *Option invalide.*\n\nVeuillez répondre uniquement :\n👉 *1* ou *Oui* (Pour commander)\n👉 *2* ou *Non* (Pour annuler)`
                });
              }
            } catch (err) {
              console.error('Erreur réponse utilisateur :', err);
            }
          }
        }
      }
    });

  } catch (error) {
    console.error('❌ Erreur WhatsApp:', error);
    setTimeout(connectToWhatsApp, 10000);
  }
}

// ====== 3. MIDDLEWARE ======
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
  res.json({
    status: 'success',
    whatsappConnected: !!sock && sock.ws?.readyState === 1,
    qrCodeAvailable: !!currentQRCode
  });
});

app.get('/qrcode', async (req, res) => {
  if (!currentQRCode) {
    return res.status(404).json({
      status: 'error',
      message: 'Aucun QR code disponible ou déjà associé.'
    });
  }
  try {
    const qrBuffer = await qrcode.toBuffer(currentQRCode, { width: 400, margin: 2 });
    res.writeHead(200, { 'Content-Type': 'image/png' });
    res.end(qrBuffer);
  } catch (error) {
    res.status(500).json({ error: 'Erreur QR.' });
  }
});

// ENVOI DE L'ALERTE DEPUIS N8N
app.post('/send-order-alert', async (req, res) => {
  try {
    if (!sock || sock.ws?.readyState !== 1) {
      return res.status(503).json({ error: 'WhatsApp non connecté.' });
    }

    const { phone, product, quantity, supplier, threshold, orderId } = req.body;
    
    const finalPhone = phone || ADMIN_PHONE;
    // Formatage propre du JID WhatsApp
    const formattedPhone = finalPhone.replace(/[^0-9]/g, '') + '@s.whatsapp.net';
    const orderIdentifier = orderId || `ORDER-${product}-${Date.now()}`;

    pendingOrders.set(formattedPhone, {
      product,
      quantity,
      supplier,
      threshold
    });

    // Format textuel ultra-propre et interactif (Remplace les boutons obsolètes)
    const alertMessage = `🚨 *ALERTE STOCK FAIBLE* 🚨\n\n` +
                         `📦 *Produit* : ${product}\n` +
                         `📊 *Quantité actuelle* : ${quantity}\n` +
                         `⚠️ *Seuil d'alerte* : ${threshold}\n` +
                         `🏪 *Fournisseur* : ${supplier}\n\n` +
                         `*Voulez-vous déclencher la commande ?*\n` +
                         `👉 Répondez *1* (ou *Oui*)\n` +
                         `👉 Répondez *2* (ou *Non*)`;

    await sock.sendMessage(formattedPhone, { text: alertMessage });

    return res.json({
      success: true,
      message: 'Alerte textuelle envoyée.',
      orderId: orderIdentifier
    });

  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Serveur actif sur le port ${PORT}`);
  connectToWhatsApp();
});