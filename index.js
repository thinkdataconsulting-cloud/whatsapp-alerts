const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const qrcode = require('qrcode-terminal');

// Dans votre écouteur d'événement Baileys :
sock.ev.on('connection.update', (update) => {
    const { qr } = update;
    if (qr) {
        // Ceci va dessiner le QR code directement dans les logs Railway
        qrcode.generate(qr, { small: true }); 
    }
});const express = require('express');
const bodyParser = require('body-parser');
const pino = require('pino');
const fs = require('fs');
const path = require('path');

// Fix pour "crypto is not defined"
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
app.use(bodyParser.json());

let sock;
const pendingOrders = new Map();

// Nettoie les anciennes sessions
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
      printQRInTerminal: false,
      logger: pino({ level: 'error' }),
      browser: ['Gestion Stock Bot', 'Chrome', '1.0.0'],
      version: version,
      patchMessageBeforeSending: (message) => {
        if (message.buttonsMessage || message.listMessage || message.templateMessage) {
          return { ...message, patchPolicy: 'patch' };
        }
        return message;
      },
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        const qrCodeDataURL = await qrcode.toDataURL(qr, { width: 400, margin: 2 });
        console.log('\n🔴🔴🔴 NOUVEAU QR CODE 🔴🔴🔴');
        console.log('📱 Ouvre ce lien dans ton navigateur pour scanner :');
        console.log(qrCodeDataURL);
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
            if (selectedButtonId === 'confirm_order') {
              await sock.sendMessage(
                `${order.phone.replace(/\D/g, '')}@s.whatsapp.net`,
                { text: `✅ COMMANDE CONFIRMÉE pour ${order.product}` }
              );
            } else if (selectedButtonId === 'cancel_order') {
              await sock.sendMessage(
                `${order.phone.replace(/\D/g, '')}@s.whatsapp.net`,
                { text: '❌ Commande annulée.' }
              );
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

// ===== ENDPOINTS OBLIGATOIRES =====
// Endpoint principal pour vérifier que le serveur est en ligne
app.get('/', (req, res) => {
  res.status(200).json({
    status: 'success',
    message: 'Serveur Baileys en ligne.',
    whatsappConnected: !!sock
  });
});

// Endpoint pour envoyer une alerte
app.post('/send-order-alert', async (req, res) => {
  try {
    const { phone, product, quantity, supplier, threshold, orderId } = req.body;
    if (!phone || !product || !quantity || !supplier || !threshold || !orderId) {
      return res.status(400).json({ status: 'error', message: 'Données manquantes.' });
    }

    if (!sock) {
      return res.status(500).json({ status: 'error', message: 'WhatsApp non connecté.' });
    }

    pendingOrders.set(orderId, { phone, product, quantity, supplier, threshold });
    const formattedPhone = phone.replace(/\D/g, '') + '@s.whatsapp.net';

    await sock.sendMessage(formattedPhone, {
      text: `🚨 ALERTE STOCK FAIBLE 🚨\n\n📦 Produit : ${product}\n📊 Quantité : ${quantity} (Seuil : ${threshold})\n🏪 Fournisseur : ${supplier}\n\nPasser une commande ?`,
      buttons: [
        { buttonId: 'confirm_order', buttonText: { displayText: '✅ Oui' }, type: 1 },
        { buttonId: 'cancel_order', buttonText: { displayText: '❌ Non' }, type: 1 }
      ],
      footer: 'Répondez avec un bouton.'
    });

    return res.status(200).json({ status: 'success', message: 'Alerte envoyée.' });
  } catch (error) {
    console.error('❌ Erreur :', error);
    return res.status(500).json({ status: 'error', message: error.message });
  }
});

// Endpoint GET pour tester la connexion
app.get('/send-order-alert', (req, res) => {
  res.status(200).json({
    status: 'success',
    message: 'Endpoint OK. Utilise POST pour envoyer une alerte.',
    whatsappConnected: !!sock
  });
});
// =================================

// ===== CORRECTION DU PORT =====
// Railway injecte automatiquement process.env.PORT
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Serveur démarré sur http://localhost:${PORT} (Railway: ${process.env.PORT})`);
  console.log(`🌐 Endpoint: https://whatsapp-alerts-08d227b3.up.railway.app/send-order-alert`);
  connectToWhatsApp();
});
// =============================