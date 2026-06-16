// ====== 1. DÉPENDANCES ET INITIALISATIONS ======
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const qrcode = require('qrcode');
const express = require('express');
const pino = require('pino');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const axios = require('axios'); // Ajout d'axios pour communiquer avec n8n

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

// CONFIGURATION : Mettez ici l'URL de votre nœud Webhook de réception n8n
const N8N_WEBHOOK_URL = "https://votre-instance-n8n.railway.app/webhook/whatsapp-callback"; 

// SÉCURITÉ CLOUD : Répertoire d'écriture temporaire sur Railway
const AUTH_DIR = path.join('/tmp', 'auth_info_baileys');

// ====== 2. FONCTIONS UTILITAIRES ======
function cleanAuthFiles() {
  if (fs.existsSync(AUTH_DIR)) {
    try {
      fs.rmSync(AUTH_DIR, { recursive: true, force: true });
      console.log('Base de session réinitialisée.');
    } catch (e) {
      console.log('Erreur nettoyage temporaire :', e.message);
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
      if (qr) currentQRCode = await qrcode.toDataURL(qr, { width: 400, margin: 2 });

      if (connection === 'close') {
        currentQRCode = null;
        const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
        if (shouldReconnect) {
          setTimeout(connectToWhatsApp, 5000);
        } else {
          cleanAuthFiles();
          setTimeout(connectToWhatsApp, 10000);
        }
      } else if (connection === 'open') {
        console.log('\n✅ CONNECTÉ À WHATSAPP AVEC SUCCÈS ! ✅');
        currentQRCode = null;
      }
    });

    // ÉCOUTEUR INTERACTIF COMMUNIQUANT AVEC N8N
    sock.ev.on('messages.upsert', async (m) => {
      try {
        const message = m.messages[0];
        if (!message || message.key.fromMe || !message.message) return;

        const from = message.key.remoteJid;
        if (!from) return;

        const textResponse = message.message.conversation || 
                             message.message.extendedTextMessage?.text || 
                             "";

        const cleanText = textResponse.trim().toLowerCase();
        if (!cleanText) return; 

        const senderDigits = from.replace(/\D/g, '');
        
        let foundOrderKey = null;
        let foundOrder = null;

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
          let statusAction = "";
          
          if (cleanText === '1' || cleanText === 'oui') {
            statusAction = "CONFIRMED";
            await sock.sendMessage(from, { text: `✅ *COMMANDE CONFIRMÉE*\nTransmission de la validation à la base de données...` });
          } else if (cleanText === '2' || cleanText === 'non') {
            statusAction = "CANCELLED";
            await sock.sendMessage(from, { text: `❌ *COMMANDE ANNULÉE*\nLe statut a été mis à jour.` });
          } else {
            await sock.sendMessage(from, {
              text: `⚠️ *Choix invalide.*\nUne alerte est en cours pour *${foundOrder.product}*.\n\nRépondez par *1* (Oui) ou *2* (Non).`
            });
            return;
          }

          // ENVOI DU CALLBACK VERS N8N
          try {
            console.log(`📤 Envoi du statut vers n8n pour la commande ${foundOrderKey}...`);
            await axios.post(N8N_WEBHOOK_URL, {
              orderId: foundOrderKey,
              status: statusAction,
              product: foundOrder.product,
              supplier: foundOrder.supplier,
              quantity: foundOrder.quantity,
              phone: senderDigits
            });
            console.log(`🚀 Statut synchronisé avec succès sur n8n.`);
          } catch (n8nError) {
            console.error(`❌ Échec de la liaison HTTP vers n8n :`, n8nError.message);
            await sock.sendMessage(from, { text: `⚠️ Erreur de synchronisation avec le serveur central n8n.` });
          }

          // Purge de la mémoire vive une fois le traitement n8n envoyé
          pendingOrders.delete(foundOrderKey);
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
  req.setTimeout(30000, () => { if (!res.headersSent) res.status(408).json({ error: 'Request Timeout' }); });
  res.setTimeout(30000, () => { if (!res.headersSent) res.status(504).json({ error: 'Response Timeout' }); });
  next();
});

// ====== 4. ENDPOINTS ======
app.get('/', (req, res) => {
  res.status(200).json({ status: 'success', whatsappConnected: !!sock && sock.ws?.readyState === 1 });
});

app.get('/qrcode', (req, res) => {
  if (!currentQRCode) return res.status(404).json({ status: 'error', message: 'QR absent ou déjà associé.' });
  const base64Data = currentQRCode.replace(/^data:image\/png;base64,/, '');
  const imgBuffer = Buffer.from(base64Data, 'base64');
  res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': imgBuffer.length });
  res.end(imgBuffer);
});

app.all('/send-order-alert', async (req, res) => {
  try {
    if (req.method === 'GET') return res.status(200).json({ status: 'success' });
    if (!req.body || Object.keys(req.body).length === 0) return res.status(400).json({ status: 'error', message: 'Body vide.' });

    const { phone, telephone, product, quantity, supplier, threshold, orderld, orderId, orderID } = req.body;
    const finalPhone = phone || telephone;
    const orderIdentifier = orderld || orderId || orderID;

    if (!finalPhone || !product || quantity === undefined || !supplier || threshold === undefined || !orderIdentifier) {
      return res.status(400).json({ status: 'error', message: "Données incomplètes." });
    }

    if (!sock || sock.ws?.readyState !== 1) return res.status(503).json({ status: 'error', message: 'WhatsApp déconnecté.' });

    const cleanedPhone = String(finalPhone).replace(/\D/g, '');
    const formattedPhone = cleanedPhone + '@s.whatsapp.net';

    pendingOrders.set(String(orderIdentifier).trim(), {
      phoneJid: formattedPhone,
      product,
      quantity,
      supplier,
      threshold
    });

    const alertMessage = `🚨 *ALERTE STOCK FAIBLE* 🚨\n\n📦 *Produit* : ${product}\n📊 *Quantité Actuelle* : ${quantity}\n⚠️ *Seuil Minimal* : ${threshold}\n🏪 *Fournisseur* : ${supplier}\n\n*Souhaitez-vous commander ?*\n👉 Répondez *1* (ou *Oui*)\n👉 Répondez *2* (ou *Non*)`;
    await sock.sendMessage(formattedPhone, { text: alertMessage });

    return res.status(200).json({ status: 'success', orderId: orderIdentifier });
  } catch (error) {
    return res.status(500).json({ status: 'error', message: error.message });
  }
});

// ====== 5. DÉMARRAGE ======
const PORT = process.env.PORT || 8080;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Serveur actif sur le port ${PORT}`);
  connectToWhatsApp();
});