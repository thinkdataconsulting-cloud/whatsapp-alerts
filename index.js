const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const qrcode = require('qrcode');
const express = require('express');
const bodyParser = require('body-parser');
const pino = require('pino');

// Fix pour "crypto is not defined" dans Railway
if (!globalThis.crypto) {
  const crypto = require('crypto');
  globalThis.crypto = {
    getRandomValues: (buffer) => crypto.randomBytes(buffer.length),
    subtle: crypto.webcrypto?.subtle || require('crypto').webcrypto?.subtle,
  };
}

const app = express();
app.use(bodyParser.json());

let sock;
const pendingOrders = new Map();

async function connectToWhatsApp() {
  try {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
    const { version } = await fetchLatestBaileysVersion();

    sock = makeWASocket({
      auth: state,
      printQRInTerminal: false, // Désactive le QR en ASCII
      logger: pino({ level: 'error' }),
      browser: ['Gestion Stock Bot', 'Chrome', '1.0.0'],
      version: version,
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        // Génère un QR code au format image (base64)
        const qrCodeDataURL = await qrcode.toDataURL(qr, { width: 400, margin: 2 });
        console.log('\n🔴 NOUVEAU QR CODE 🔴');
        console.log('📱 Ouvre ce lien dans ton navigateur pour scanner :');
        console.log(qrCodeDataURL); // Lien data:image/png;base64,...
        console.log('\n⚠️ Ce QR code expire dans 2 minutes !');
      }

      if (connection === 'close') {
        const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
        if (shouldReconnect) {
          console.log('🔄 Reconnexion dans 5 secondes...');
          setTimeout(connectToWhatsApp, 5000);
        } else {
          console.log('⚠️ Déconnecté. Rescanne le QR code.');
          setTimeout(connectToWhatsApp, 10000);
        }
      } else if (connection === 'open') {
        console.log('\n✅ CONNECTÉ À WHATSAPP !');
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
    setTimeout(connectToWhatsApp, 10000);
  }
}

app.all('/send-order-alert', async (req, res) => {
  try {
    if (req.method === 'GET') {
      return res.status(200).json({
        status: 'success',
        message: 'Endpoint OK.',
        whatsappConnected: !!sock
      });
    }

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

// Utilise le port dynamique de Railway
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Serveur démarré sur http://localhost:${PORT}`);
  console.log(`🌐 Endpoint : https://whatsapp-alerts-21a2b265.up.railway.app/send-order-alert`);
  connectToWhatsApp();
});