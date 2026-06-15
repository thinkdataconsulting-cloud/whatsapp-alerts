// ====== POLYFILL CRITICAL CRYPTO (DOIT ÊTRE EN TOUT DÉBUT DE FICHIER) ======
const crypto = require('crypto');
if (!global.crypto) {
  global.crypto = crypto.webcrypto || {
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
// ===========================================================================

const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const express = require('express');
const bodyParser = require('body-parser');
const pino = require('pino');
const fs = require('fs');
const path = require('path');
const qrcodeImg = require('qrcode');

const app = express();
app.use(bodyParser.json());

let sock;
let currentQrCodeHtml = ""; 
const pendingOrders = new Map();

function cleanAuthFiles() {
  const authDir = path.join(__dirname, 'auth_info_baileys');
  if (fs.existsSync(authDir)) {
    fs.rmSync(authDir, { recursive: true, force: true });
    console.log(' Ancien jeton de session expiré nettoyé.');
  }
}

async function connectToWhatsApp() {
  try {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
    const { version } = await fetchLatestBaileysVersion();

    sock = makeWASocket({
      auth: state,
      printQRInTerminal: false,
      logger: pino({ level: 'error' }),
      browser: ['Gestion Stock Bot', 'Chrome', '1.0.0'],
      version: version,
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        qrcodeImg.toDataURL(qr, (err, url) => {
          if (!err) {
            currentQrCodeHtml = `
              <html>
                <body style="background: #111b21; color: white; text-align: center; font-family: sans-serif; padding-top: 50px;">
                  <h2>🔴 SCANNEZ CE QR CODE AVEC WHATSAPP 🔴</h2>
                  <div style="background: white; display: inline-block; padding: 20px; border-radius: 10px; margin-top: 20px;">
                    <img src="${url}" style="width: 300px; height: 300px; image-rendering: pixelated;"/>
                  </div>
                  <p style="margin-top: 20px; color: #a9b1b6;">Lien actif. Recharge automatique intégrée.</p>
                  <script>setInterval(() => { location.reload(); }, 20000);</script>
                </body>
              </html>
            `;
          }
        });

        console.log('\n==================================================');
        console.log('🔗 LIEN DE SCAN : https://whatsapp-alerts-production-f810.up.railway.app/qrcode');
        console.log('==================================================\n');
      }

      if (connection === 'close') {
        currentQrCodeHtml = "";
        const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
        if (shouldReconnect) {
          setTimeout(connectToWhatsApp, 5000);
        } else {
          cleanAuthFiles();
          setTimeout(connectToWhatsApp, 10000);
        }
      } else if (connection === 'open') {
        currentQrCodeHtml = "";
        console.log('\n✅✅✅ CONNECTÉ À WHATSAPP AVEC SUCCÈS ! ✅✅✅');
      }
    });

  } catch (error) {
    console.error(' Erreur connexion Baileys :', error);
    setTimeout(connectToWhatsApp, 10000);
  }
}

// ===== ENDPOINTS HTTP =====
app.get('/qrcode', (req, res) => {
  if (currentQrCodeHtml) {
    res.send(currentQrCodeHtml);
  } else {
    res.send(`
      <html>
        <body style="background: #111b21; color: white; text-align: center; font-family: sans-serif; padding-top: 50px;">
          <h2>✅ WhatsApp est connecté ou en cours d'initialisation...</h2>
          <p style="color: #a9b1b6;">Veuillez patienter ou vérifier vos logs Railway.</p>
        </body>
      </html>
    `);
  }
});

app.get('/', (req, res) => {
  res.status(200).json({ status: 'success', whatsappConnected: !!sock });
});

app.post('/send-order-alert', async (req, res) => {
  try {
    const { phone, product, quantity, supplier, threshold, orderId } = req.body;
    
    if (!phone || !product || !quantity || !supplier || !threshold || !orderId) {
      return res.status(400).json({ status: 'error', message: 'Données JSON incomplètes.' });
    }

    if (!sock || currentQrCodeHtml !== "") {
      return res.status(500).json({ status: 'error', message: 'WhatsApp n\'est pas connecté. Scannez d\'abord le QR code.' });
    }

    pendingOrders.set(orderId, { phone, product, quantity, supplier, threshold });
    const formattedPhone = phone.replace(/\D/g, '') + '@s.whatsapp.net';

    await sock.sendMessage(formattedPhone, {
      text: `🚨 *ALERTE STOCK FAIBLE* 🚨\n\n📦 *Produit* : ${product}\n📊 *Quantité Actuelle* : ${quantity} (Seuil : ${threshold})\n🏪 *Fournisseur* : ${supplier}\n\nVoulez-vous commander ?`
    });

    return res.status(200).json({ status: 'success', message: 'Alerte transmise.' });
  } catch (error) {
    return res.status(500).json({ status: 'error', message: error.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Serveur actif sur le port ${PORT}`);
  connectToWhatsApp();
});