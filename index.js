const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const qrcode = require('qrcode-terminal');
const express = require('express');
const bodyParser = require('body-parser');
const pino = require('pino');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Fix pour "crypto is not defined" dans certains environnements distants
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

// Nettoie les anciennes sessions pour éviter les conflits de jetons obsolètes
function cleanAuthFiles() {
  const authDir = path.join(__dirname, 'auth_info_baileys');
  if (fs.existsSync(authDir)) {
    fs.rmSync(authDir, { recursive: true, force: true });
    console.log('实用 🧹 Anciennes sessions nettoyées.');
  }
}

async function connectToWhatsApp() {
  try {
    cleanAuthFiles();

    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
    const { version } = await fetchLatestBaileysVersion();

    sock = makeWASocket({
      auth: state,
      printQRInTerminal: false, // On gère l'affichage nous-mêmes ci-dessous
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
        console.log('\n🔴🔴🔴 NOUVEAU QR CODE (A SCANNER SUR RAILWAY) 🔴🔴🔴');
        // Génère le QR code directement en blocs de texte scannables dans les logs de Railway
        qrcode.generate(qr, { small: true });
        console.log('🔗 Chaîne de texte brute Baileys (si besoin) :', qr);
      }

      if (connection === 'close') {
        const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
        if (shouldReconnect) {
          console.log('🔄 Reconnexion dans 5 secondes...');
          setTimeout(connectToWhatsApp, 5000);
        } else {
          console.log('⚠️ Déconnecté définitivement. Régénération d\'une session...');
          cleanAuthFiles();
          setTimeout(connectToWhatsApp, 10000);
        }
      } else if (connection === 'open') {
        console.log('\n✅✅✅ CONNECTÉ À WHATSAPP AVEC SUCCÈS ! ✅✅✅');
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
            const formattedPhone = `${order.phone.replace(/\D/g, '')}@s.whatsapp.net`;
            if (selectedButtonId === 'confirm_order') {
              await sock.sendMessage(formattedPhone, { text: `✅ COMMANDE CONFIRMÉE pour ${order.product}` });
            } else if (selectedButtonId === 'cancel_order') {
              await sock.sendMessage(formattedPhone, { text: '❌ Commande annulée.' });
            }
            pendingOrders.delete(orderId);
          }
        }
      }
    });

  } catch (error) {
    console.error('❌ Erreur générale dans connectToWhatsApp :', error);
    cleanAuthFiles();
    setTimeout(connectToWhatsApp, 10000);
  }
}

// ===== ENDPOINTS HTTP =====

// Page d'accueil pour le monitoring Railway
app.get('/', (req, res) => {
  res.status(200).json({
    status: 'success',
    message: 'Serveur Baileys en ligne.',
    whatsappConnected: !!sock
  });
});

// Endpoint POST pour la réception des alertes de n8n
app.post('/send-order-alert', async (req, res) => {
  try {
    const { phone, product, quantity, supplier, threshold, orderId } = req.body;
    
    // Vérification stricte des variables reçues
    if (!phone || !product || !quantity || !supplier || !threshold || !orderId) {
      return res.status(400).json({ status: 'error', message: 'Données manquantes dans le JSON.' });
    }

    if (!sock) {
      return res.status(500).json({ status: 'error', message: 'WhatsApp n\'est pas encore prêt/connecté.' });
    }

    pendingOrders.set(orderId, { phone, product, quantity, supplier, threshold });
    const formattedPhone = phone.replace(/\D/g, '') + '@s.whatsapp.net';

    await sock.sendMessage(formattedPhone, {
      text: `🚨 *ALERTE STOCK FAIBLE* 🚨\n\n📦 *Produit* : ${product}\n📊 *Quantité Actuelle* : ${quantity} (Seuil critique : ${threshold})\n🏪 *Fournisseur* : ${supplier}\n\nVoulez-vous valider une commande de réapprovisionnement ?`,
      buttons: [
        { buttonId: 'confirm_order', buttonText: { displayText: '✅ Oui, commander' }, type: 1 },
        { buttonId: 'cancel_order', buttonText: { displayText: '❌ Non, ignorer' }, type: 1 }
      ],
      footer: 'Gestion de Stock Automatique'
    });

    return res.status(200).json({ status: 'success', message: 'Alerte transmise au téléphone.' });
  } catch (error) {
    console.error('❌ Échec de l\'envoi du message WhatsApp :', error);
    return res.status(500).json({ status: 'error', message: error.message });
  }
});

// Sécurité : évite l'erreur si n8n appelle accidentellement en GET
app.get('/send-order-alert', (req, res) => {
  res.status(200).json({
    status: 'success',
    message: 'L\'endpoint fonctionne ! Utilisez la méthode POST pour envoyer des données.',
    whatsappConnected: !!sock
  });
});

// ===== DEMARRAGE DU SERVEUR =====
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Serveur démarré avec succès sur le port ${PORT}`);
  console.log(`🌐 Endpoint cible pour n8n : https://whatsapp-alerts-08d227b3.up.railway.app/send-order-alert`);
  connectToWhatsApp();
});