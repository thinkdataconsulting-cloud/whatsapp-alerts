const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const express = require('express');
const bodyParser = require('body-parser');
const pino = require('pino');
const fs = require('fs');
const path = require('path');
const qrcodeImg = require('qrcode'); // Utilisation de qrcode classique pour le web

const app = express();
app.use(bodyParser.json());

let sock;
let currentQrCodeHtml = ""; // Stocke la page HTML du QR code
const pendingOrders = new Map();

function cleanAuthFiles() {
  const authDir = path.join(__dirname, 'auth_info_baileys');
  if (fs.existsSync(authDir)) {
    fs.rmSync(authDir, { recursive: true, force: true });
    console.log('🧹 Anciennes sessions nettoyées.');
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
        // Génère une image QR Code au format DataURL
        qrcodeImg.toDataURL(qr, (err, url) => {
          if (!err) {
            // Crée une page HTML propre pour afficher le QR Code
            currentQrCodeHtml = `
              <html>
                <body style="background: #111b21; color: white; text-align: center; font-family: sans-serif; padding-top: 50px;">
                  <h2>🔴 SCANNEZ CE QR CODE AVEC WHATSAPP 🔴</h2>
                  <div style="background: white; display: inline-block; padding: 20px; border-radius: 10px; margin-top: 20px;">
                    <img src="${url}" style="width: 300px; height: 300px; image-rendering: pixelated;"/>
                  </div>
                  <p style="margin-top: 20px; color: #a9b1b6;">Une fois scanné, cette page deviendra inaccessible et votre bot sera actif.</p>
                  <script>setInterval(() => { location.reload(); }, 20000);</script>
                </body>
              </html>
            `;
          }
        });

        console.log('\n==================================================');
        console.log('🔗 CLIQUEZ SUR CE LIEN POUR SCANNER LE QR CODE :');
        console.log(`https://whatsapp-alerts-production-f810.up.railway.app/qrcode`);
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
    console.error(' Erreur générale :', error);
    setTimeout(connectToWhatsApp, 10000);
  }
}

// ===== ENDPOINTS HTTP =====

// Endpoint pour voir et scanner le QR Code proprement dans le navigateur
app.get('/qrcode', (req, res) => {
  if (currentQrCodeHtml) {
    res.send(currentQrCodeHtml);
  } else {
    res.send(`
      <html>
        <body style="background: #111b21; color: white; text-align: center; font-family: sans-serif; padding-top: 50px;">
          <h2>✅ WhatsApp est déjà connecté ou le QR Code se recharge...</h2>
          <p style="color: #a9b1b6;">Vérifiez vos logs Railway.</p>
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
      return res.status(400).json({ status: 'error', message: 'Données manquantes.' });
    }

    if (!sock || currentQrCodeHtml !== "") {
      return res.status(500).json({ status: 'error', message: 'WhatsApp n\'est pas connecté. Scannez d\'abord le QR code.' });
    }

    pendingOrders.set(orderId, { phone, product, quantity, supplier, threshold });
    const formattedPhone = phone.replace(/\D/g, '') + '@s.whatsapp.net';

    await sock.sendMessage(formattedPhone, {
      text: `🚨 *ALERTE STOCK FAIBLE* 🚨\n\n📦 *Produit* : ${product}\n📊 *Quantité Actuelle* : ${quantity} (Seuil critique : ${threshold})\n🏪 *Fournisseur* : ${supplier}\n\nVoulez-vous valider une commande ?`
    });

    return res.status(200).json({ status: 'success', message: 'Alerte envoyée.' });
  } catch (error) {
    return res.status(500).json({ status: 'error', message: error.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Serveur actif sur le port ${PORT}`);
  connectToWhatsApp();
});