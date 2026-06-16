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

const N8N_WEBHOOK_URL =
  process.env.N8N_WEBHOOK_URL ||
  'https://votre-instance-n8n.railway.app/webhook/whatsapp-callback';

const AUTH_DIR = path.join(
  process.cwd(),
  'auth_info_baileys'
);

let sock = null;
let isWhatsAppConnected = false;
let currentQRCode = null;

const pendingOrders = new Map();

function cleanAuthFiles() {
  try {
    if (fs.existsSync(AUTH_DIR)) {
      fs.rmSync(AUTH_DIR, {
        recursive: true,
        force: true
      });

      console.log('🗑️ Session supprimée');
    }
  } catch (error) {
    console.error(
      'Erreur suppression session :',
      error.message
    );
  }
}

async function connectToWhatsApp() {
  try {
    if (!fs.existsSync(AUTH_DIR)) {
      fs.mkdirSync(AUTH_DIR, {
        recursive: true
      });
    }

    const { state, saveCreds } =
      await useMultiFileAuthState(AUTH_DIR);

    const { version } =
      await fetchLatestBaileysVersion();

    sock = makeWASocket({
      auth: state,
      version,
      printQRInTerminal: false,
      logger: pino({
        level: 'silent'
      }),
      browser: [
        'Stock Alert Bot',
        'Chrome',
        '1.0.0'
      ]
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on(
      'connection.update',
      async (update) => {
        const {
          connection,
          lastDisconnect,
          qr
        } = update;

        if (qr) {
          currentQRCode =
            await qrcode.toDataURL(qr, {
              width: 400,
              margin: 2
            });

          console.log(
            '📱 Nouveau QR généré'
          );
        }

        if (connection === 'open') {
          isWhatsAppConnected = true;
          currentQRCode = null;

          console.log(
            '✅ WhatsApp connecté'
          );
        }

        if (connection === 'close') {
          isWhatsAppConnected = false;
          currentQRCode = null;

          console.log(
            '❌ WhatsApp déconnecté'
          );

          const shouldReconnect =
            lastDisconnect?.error?.output
              ?.statusCode !==
            DisconnectReason.loggedOut;

          if (shouldReconnect) {
            console.log(
              '🔄 Reconnexion dans 5 secondes'
            );

            setTimeout(
              connectToWhatsApp,
              5000
            );
          } else {
            cleanAuthFiles();

            setTimeout(
              connectToWhatsApp,
              10000
            );
          }
        }
      }
    );

    sock.ev.on(
      'messages.upsert',
      async ({ messages }) => {
        try {
          const message = messages[0];

          if (
            !message ||
            message.key.fromMe ||
            !message.message
          ) {
            return;
          }

          const from =
            message.key.remoteJid;

          if (!from) return;

          const text =
            message.message.conversation ||
            message.message
              .extendedTextMessage?.text ||
            '';

          const response =
            text.trim().toLowerCase();

          if (!response) return;

          const senderDigits =
            from.replace(/\D/g, '');

          let foundOrderId = null;
          let foundOrder = null;

          for (const [
            orderId,
            order
          ] of pendingOrders.entries()) {
            const storedDigits =
              order.phoneJid.replace(
                /\D/g,
                ''
              );

            if (
              storedDigits ===
              senderDigits
            ) {
              foundOrderId = orderId;
              foundOrder = order;
              break;
            }
          }

          if (!foundOrder) return;

          let status = null;

          if (
            response === '1' ||
            response === 'oui'
          ) {
            status = 'CONFIRMED';

            await sock.sendMessage(from, {
              text:
                '✅ Commande confirmée.'
            });
          } else if (
            response === '2' ||
            response === 'non'
          ) {
            status = 'CANCELLED';

            await sock.sendMessage(from, {
              text:
                '❌ Commande annulée.'
            });
          } else {
            await sock.sendMessage(from, {
              text:
                'Répondez uniquement par 1/Oui ou 2/Non.'
            });

            return;
          }

          try {
            await axios.post(
              N8N_WEBHOOK_URL,
              {
                orderId:
                  foundOrderId,
                status,
                product:
                  foundOrder.product,
                supplier:
                  foundOrder.supplier,
                quantity:
                  foundOrder.quantity,
                phone:
                  senderDigits
              }
            );

            console.log(
              '🚀 Callback n8n envoyé'
            );
          } catch (error) {
            console.error(
              'Erreur callback n8n :',
              error.message
            );
          }

          pendingOrders.delete(
            foundOrderId
          );
        } catch (error) {
          console.error(
            'Erreur messages.upsert :',
            error.message
          );
        }
      }
    );
  } catch (error) {
    console.error(
      'Erreur WhatsApp :',
      error
    );

    setTimeout(
      connectToWhatsApp,
      10000
    );
  }
}

app.use((req, res, next) => {
  req.setTimeout(30000);
  res.setTimeout(30000);
  next();
});

app.get('/', (req, res) => {
  res.json({
    status: 'success',
    whatsappConnected:
      isWhatsAppConnected
  });
});

app.get('/status', (req, res) => {
  res.json({
    whatsappConnected:
      isWhatsAppConnected,
    qrAvailable:
      !!currentQRCode,
    pendingOrders:
      pendingOrders.size,
    uptime:
      process.uptime()
  });
});

app.get('/qrcode', (req, res) => {
  if (!currentQRCode) {
    return res.status(404).json({
      status: 'error',
      message:
        'QR absent ou déjà utilisé'
    });
  }

  const base64 =
    currentQRCode.replace(
      /^data:image\/png;base64,/,
      ''
    );

  const buffer = Buffer.from(
    base64,
    'base64'
  );

  res.writeHead(200, {
    'Content-Type': 'image/png',
    'Content-Length':
      buffer.length
  });

  res.end(buffer);
});

app.post(
  '/send-order-alert',
  async (req, res) => {
    try {
      console.log(
        '📥 Requête reçue',
        req.body
      );

      const {
        phone,
        telephone,
        product,
        quantity,
        supplier,
        threshold,
        orderId,
        orderID,
        orderld
      } = req.body;

      const finalPhone =
        phone || telephone;

      const finalOrderId =
        orderId ||
        orderID ||
        orderld;

      if (
        !finalPhone ||
        !product ||
        quantity === undefined ||
        !supplier ||
        threshold === undefined ||
        !finalOrderId
      ) {
        return res.status(400).json({
          status: 'error',
          message:
            'Données incomplètes'
        });
      }

      if (!isWhatsAppConnected) {
        return res.status(503).json({
          status: 'error',
          message:
            'WhatsApp déconnecté'
        });
      }

      const cleanedPhone =
        String(finalPhone).replace(
          /\D/g,
          ''
        );

      if (
        cleanedPhone.length < 10
      ) {
        return res.status(400).json({
          status: 'error',
          message:
            'Numéro invalide'
        });
      }

      const whatsappId =
        cleanedPhone +
        '@s.whatsapp.net';

      pendingOrders.set(
        String(finalOrderId).trim(),
        {
          phoneJid: whatsappId,
          product,
          quantity,
          supplier,
          threshold
        }
      );

      const message = `
🚨 *ALERTE STOCK FAIBLE*

📦 Produit : ${product}
📊 Quantité : ${quantity}
⚠️ Seuil : ${threshold}
🏪 Fournisseur : ${supplier}

Souhaitez-vous commander ?

1️⃣ Oui
2️⃣ Non
`;

      console.log(
        '📤 Envoi WhatsApp',
        whatsappId
      );

      await sock.sendMessage(
        whatsappId,
        {
          text: message
        }
      );

      return res.json({
        status: 'success',
        orderId:
          finalOrderId
      });
    } catch (error) {
      console.error(error);

      return res.status(500).json({
        status: 'error',
        message:
          error.message
      });
    }
  }
);

app.listen(
  PORT,
  '0.0.0.0',
  () => {
    console.log(
      `🚀 Serveur actif sur le port ${PORT}`
    );

    connectToWhatsApp();
  }
);