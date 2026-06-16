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
app.use(express.json({ limit: '10mb' })); // Remplace bodyParser.json()
app.use(express.urlencoded({ extended: true })); // Pour les requêtes URL-encoded
app.use(express.static('public'));

// Variables globales
let sock;
const pendingOrders = new Map();
let currentQRCode = null;

// --- 2. FONCTIONS UTILITAIRES ---
function cleanAuthFiles() {
  const authDir = path.join(__dirname, 'auth_info_baileys');
  if (fs.existsSync(authDir)) {
    fs.rmSync(authDir, { recursive: true, force: true });
    console.log('🧹 Anciennes sessions supprimées.');
  }
}

// --- Remplace ta fonction connectToWhatsApp() par ceci ---
async function connectToWhatsApp() {
  try {
    cleanAuthFiles();
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
    const { version } = await fetchLatestBaileysVersion();

    sock = makeWASocket({
      auth: state,
      printQRInTerminal: true,
      logger: pino({ level: 'error' }),
      browser: ['WhatsApp Alerts Bot', 'Chrome', '1.0.0'],
      version: version,
    });

    // Utilise sock.ev.on au lieu de sock.ev.once
    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        currentQRCode = await qrcode.toDataURL(qr, { width: 400, margin: 2 });
        console.log('\n🔴 NOUVEAU QR CODE GÉNÉRÉ 🔴');
        console.log('🌐 URL : https://whatsapp-alerts-production-af15.up.railway.app/qrcode');
      }

      if (connection === 'open') {
        console.log('\n✅ CONNECTÉ À WHATSAPP ! ✅');
        currentQRCode = null;
      }

      if (connection === 'close') {
        const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
        if (shouldReconnect) {
          setTimeout(connectToWhatsApp, 5000);
        } else {
          cleanAuthFiles();
          setTimeout(connectToWhatsApp, 10000);
        }
      }
    });

    sock.ev.on('creds.update', saveCreds);

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
                await sock.sendMessage(
                  `${order.phone.replace(/[^0-9]/g, '')}@s.whatsapp.net`,
                  { text: `✅ COMMANDE CONFIRMÉE pour ${order.product}` }
                );
              } else if (selectedButtonId === 'cancel_order') {
                await sock.sendMessage(
                  `${order.phone.replace(/[^0-9]/g, '')}@s.whatsapp.net`,
                  { text: '❌ Commande annulée.' }
                );
              }
            } catch (error) {
              console.error('❌ Erreur confirmation:', error);
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
    sock.ev.on('messages.upsert', async (m) => {
      // ... (garde ton code existant)
    });

  } catch (error) {
    console.error('❌ Erreur WhatsApp:', error);
    setTimeout(connectToWhatsApp, 10000);
  }
}
// --- 3. MIDDLEWARE POUR LES TIMEOUTS ---
app.use((req, res, next) => {
  // Timeout pour la requête (30 secondes)
  req.setTimeout(30000, () => {
    console.log('⏰ Timeout requête pour:', req.path);
    if (!res.headersSent) {
      res.status(408).json({ error: 'Request Timeout' });
    }
  });

  // Timeout pour la réponse (30 secondes)
  res.setTimeout(30000, () => {
    console.log('⏰ Timeout réponse pour:', req.path);
    if (!res.headersSent) {
      res.status(504).json({ error: 'Response Timeout' });
    }
  });

  next();
});

// --- 4. ENDPOINTS ---
app.get('/', (req, res) => {
  res.status(200).json({
    status: 'success',
    message: 'Serveur WhatsApp Alerts en ligne.',
    whatsappConnected: !!sock,
    qrCodeAvailable: !!currentQRCode,
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
    // Logs de débogage
    console.log('🔍 [NEW REQUEST] Headers:', req.headers);
    console.log('🔍 [NEW REQUEST] Body:', req.body);

    if (req.method === 'GET') {
      return res.status(200).json({
        status: 'success',
        message: 'Endpoint OK. Utilise POST pour envoyer une alerte.',
        whatsappConnected: !!sock,
        examplePayload: {
          phone: "+22791848270",
          product: "Farine 25kg",
          quantity: 5,
          supplier: "Societe B",
          threshold: 5,
          orderld: "ORDER-123456"
        }
      });
    }

    // Vérifie que le body n'est pas vide
    if (!req.body || Object.keys(req.body).length === 0) {
      return res.status(400).json({
        status: 'error',
        message: 'Body vide ! Vérifie que tu envoies bien un JSON avec Content-Type: application/json'
      });
    }

    // Extrait les champs (accepte orderld OU orderId)
    const { phone, product, quantity, supplier, threshold, orderld, orderId } = req.body;
    const orderIdentifier = orderld || orderId;

    console.log('🔍 [EXTRACTED FIELDS]:', { phone, product, quantity, supplier, threshold, orderIdentifier });

    // Vérifie que tous les champs requis sont présents
    if (!phone || !product || quantity === undefined || !supplier || threshold === undefined || !orderIdentifier) {
      return res.status(400).json({
        status: 'error',
        message: `Données manquantes: ${Object.entries({ phone, product, quantity, supplier, threshold, orderIdentifier })
          .filter(([_, value]) => !value && value !== 0)
          .map(([key]) => key)
          .join(', ')}`,
        receivedData: req.body // Renvoie les données reçues pour débogage
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

    // Stocke la commande en attente
    pendingOrders.set(orderIdentifier, { phone, product, quantity, supplier, threshold });

    // Formate le numéro de téléphone
    // Supprime TOUS les caractères non numériques, puis ajoute @s.whatsapp.net UNE SEULE FOIS
	const formattedPhone = phone.replace(/[^0-9]/g, '') + '@s.whatsapp.net';
	console.log('📱 Numéro final:', formattedPhone); // Ajoute ce log pour vérifier

    // Envoie le message WhatsApp (sans await pour ne pas bloquer la réponse)
    sock.sendMessage(formattedPhone, {
      text: `🚨 ALERTE STOCK FAIBLE 🚨\n\n📦 Produit : ${product}\n📊 Quantité : ${quantity} (Seuil : ${threshold})\n🏪 Fournisseur : ${supplier}\n\nPasser une commande ?`,
      buttons: [
        { buttonId: 'confirm_order', buttonText: { displayText: '✅ Oui' }, type: 1 },
        { buttonId: 'cancel_order', buttonText: { displayText: '❌ Non' }, type: 1 }
      ],
      footer: 'Répondez avec un bouton.'
    }).catch(error => {
      console.error('❌ Erreur WhatsApp:', error);
    });

    // Répond immédiatement (ne pas attendre la livraison du message)
    return res.status(200).json({
      status: 'success',
      message: 'Alerte envoyée avec succès (en arrière-plan).',
      orderId: orderIdentifier,
      whatsappConnected: true
    });

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
  console.log(`🚀 Serveur démarré sur http://localhost:${PORT}`);
  console.log(`🌐 URL publique: https://whatsapp-alerts-production-af15.up.railway.app`);
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