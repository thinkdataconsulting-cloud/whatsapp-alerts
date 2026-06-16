const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion
} = require('@whiskeysockets/baileys');

const express = require('express');
const qrcode = require('qrcode');
const pino = require('pino');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const axios = require('axios');

// Polyfill sécurisé pour l'environnement crypto de Baileys
if (!globalThis.crypto) {
  globalThis.crypto = {
    getRandomValues: (buffer) => crypto.randomBytes(buffer.length),
    subtle: crypto.webcrypto.subtle
  };
}

const app = express();

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

const PORT = process.env.PORT || 8080;

// URL finale de votre webhook n8n
const N8N_WEBHOOK_URL =
  process.env.N8N_WEBHOOK_URL ||
  'https://votre-instance-n8n.railway.app/webhook/whatsapp-callback';

const AUTH_DIR = path.join(process.cwd(), 'auth_info_baileys');

let sock = null;
let isWhatsAppConnected = false;
let currentQRCode = null;

const pendingOrders = new Map();

// Fonction de nettoyage propre de la session en cas de déconnexion totale
function cleanAuthFiles() {
  try {
    if (fs.existsSync(AUTH_DIR)) {
      fs.rmSync(AUTH_DIR, { recursive: true, force: true });
      console.log('🗑️ Session obsolète supprimée localement.');
    }
  } catch (error) {
    console.error('Erreur lors de la suppression de la session :', error.message);
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
      version,
      printQRInTerminal: false, // Désactivé pour éviter de casser la console Railway
      logger: pino({ level: 'silent' }),
      browser: ['Stock Alert Bot', 'Chrome', '1.0.0']
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        // Sauvegarde du QR code sous forme d'URL Base64
        currentQRCode = await qrcode.toDataURL(qr, { width: 400, margin: 2 });
        console.log('📱 Un nouveau QR Code est disponible sur l\'interface web.');
      }

      if (connection === 'open') {
        isWhatsAppConnected = true;
        currentQRCode = null;
        console.log('✅ WhatsApp connecté avec succès !');
      }

      if (connection === 'close') {
        isWhatsAppConnected = false;
        currentQRCode = null;
        console.log('❌ WhatsApp déconnecté.');

        const shouldReconnect =
          lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;

        if (shouldReconnect) {
          console.log('🔄 Reconnexion automatique dans 5 secondes...');
          setTimeout(connectToWhatsApp, 5000);
        } else {
          console.log('🔒 Déconnexion définitive demandée. Réinitialisation...');
          cleanAuthFiles();
          setTimeout(connectToWhatsApp, 10000);
        }
      }
    });

    // Gestion de la réception des réponses (Oui/Non ou 1/2)
    sock.ev.on('messages.upsert', async ({ messages }) => {
      try {
        const message = messages[0];
        if (!message || message.key.fromMe || !message.message) return;

        const from = message.key.remoteJid;
        if (!from) return;

        const text =
          message.message.conversation ||
          message.message.extendedTextMessage?.text ||
          '';

        const response = text.trim().toLowerCase();
        if (!response) return;

        const senderDigits = from.replace(/\D/g, '');

        let foundOrderId = null;
        let foundOrder = null;

        // Recherche de la commande en attente associée à ce numéro de téléphone
        for (const [orderId, order] of pendingOrders.entries()) {
          const storedDigits = order.phoneJid.replace(/\D/g, '');
          if (storedDigits === senderDigits) {
            foundOrderId = orderId;
            foundOrder = order;
            break;
          }
        }

        if (!foundOrder) return;

        let status = null;

        if (response === '1' || response === 'oui') {
          status = 'CONFIRMED';
          await sock.sendMessage(from, { text: '✅ Commande confirmée.' });
        } else if (response === '2' || response === 'non') {
          status = 'CANCELLED';
          await sock.sendMessage(from, { text: '❌ Commande annulée.' });
        } else {
          await sock.sendMessage(from, { text: 'Répondez uniquement par *1* (Oui) ou *2* (Non).' });
          return;
        }

        // Envoi de la mise à jour à n8n via Webhook
        try {
          await axios.post(N8N_WEBHOOK_URL, {
            orderId: foundOrderId,
            status,
            product: foundOrder.product,
            supplier: foundOrder.supplier,
            quantity: foundOrder.quantity,
            phone: senderDigits
          });
          console.log(`🚀 Callback envoyé à n8n pour la commande : ${foundOrderId}`);
        } catch (error) {
          console.error('Erreur lors de l\'envoi du callback n8n :', error.message);
        }

        pendingOrders.delete(foundOrderId);
      } catch (error) {
        console.error('Erreur messages.upsert :', error.message);
      }
    });

  } catch (error) {
    console.error('Erreur critique de connexion WhatsApp :', error.message);
    setTimeout(connectToWhatsApp, 10000);
  }
}

// Timeout de sécurité pour les requêtes HTTP
app.use((req, res, next) => {
  req.setTimeout(30000);
  res.setTimeout(30000);
  next();
});

app.get('/', (req, res) => {
  res.json({
    status: 'success',
    whatsappConnected: isWhatsAppConnected
  });
});

app.get('/status', (req, res) => {
  res.json({
    whatsappConnected: isWhatsAppConnected,
    qrAvailable: !!currentQRCode,
    pendingOrders: pendingOrders.size,
    uptime: process.uptime()
  });
});

// NOUVELLE ROUTE VISUELLE : Affiche une page web propre contenant le QR Code
app.get('/qr', (req, res) => {
  if (isWhatsAppConnected) {
    return res.send('<h2 style="color: green; text-align: center; margin-top: 50px;">✅ WhatsApp est déjà connecté !</h2>');
  }
  if (!currentQRCode) {
    return res.send('<h2 style="color: orange; text-align: center; margin-top: 50px;">🔄 QR code en cours de génération... Rafraîchissez dans quelques secondes.</h2>');
  }
  
  res.send(`
    <div style="text-align: center; margin-top: 50px; font-family: Arial, sans-serif;">
      <h2>📱 Scannez ce QR Code avec WhatsApp</h2>
      <p>Ouvrez WhatsApp > Appareils connectés > Connecter un appareil</p>
      <img src="${currentQRCode}" alt="WhatsApp QR Code" style="border: 2px solid #333; padding: 10px; border-radius: 8px; margin-top: 20px;"/>
      <script>
        // Rafraîchissement automatique de la page toutes les 15 secondes pour mettre à jour le jeton QR
        setTimeout(() => { location.reload(); }, 15000);
      </script>
    </div>
  `);
});

// Endpoint POST pour la réception des alertes de n8n
app.post('/send-order-alert', async (req, res) => {
  try {
    console.log('📥 Requête reçue de n8n :', req.body);

    const {
      phone, telephone,
      product,
      quantity,
      supplier,
      threshold,
      orderId, orderID, orderld
    } = req.body;

    const finalPhone = phone || telephone;
    const finalOrderId = orderId || orderID || orderld;

    if (!finalPhone || !product || quantity === undefined || !supplier || threshold === undefined || !finalOrderId) {
      return res.status(400).json({ status: 'error', message: 'Données incomplètes' });
    }

    if (!isWhatsAppConnected) {
      return res.status(503).json({ status: 'error', message: 'WhatsApp déconnecté' });
    }

    const cleanedPhone = String(finalPhone).replace(/\D/g, '');
    if (cleanedPhone.length < 10) {
      return res.status(400).json({ status: 'error', message: 'Numéro de téléphone invalide' });
    }

    const whatsappId = cleanedPhone + '@s.whatsapp.net';

    pendingOrders.set(String(finalOrderId).trim(), {
      phoneJid: whatsappId,
      product,
      quantity,
      supplier,
      threshold
    });

    const message = `🚨 *ALERTE STOCK FAIBLE*\n\n📦 *Produit :* ${product}\n📊 *Quantité actuelle :* ${quantity}\n⚠️ *Seuil Minimal :* ${threshold}\n🏪 *Fournisseur :* ${supplier}\n\n ** Veuillez vous réapprovisionnez**`;

    console.log('📤 Envoi du message WhatsApp à :', whatsappId);
    await sock.sendMessage(whatsappId, { text: message });

    return res.json({ status: 'success', orderId: finalOrderId });
  } catch (error) {
    console.error('Erreur lors du traitement de l\'alerte :', error.message);
    return res.status(500).json({ status: 'error', message: error.message });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Serveur actif sur le port ${PORT}`);
  connectToWhatsApp();
});