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

// CORRECTION CLOUD : On utilise le dossier /tmp qui est le seul autorisé en écriture sur Railway
const AUTH_DIR = path.join('/tmp', 'auth_info_baileys');

function cleanAuthFiles() {
  if (fs.existsSync(AUTH_DIR)) {
    try {
      fs.rmSync(AUTH_DIR, { recursive: true, force: true });
      console.log('🧹 Session temporaire /tmp nettoyée.');
    } catch (e) {
      console.log('⚠️ Impossible de nettoyer /tmp :', e.message);
    }
  }
}

async function connectToWhatsApp() {
  try {
    // S'assure que le dossier /tmp existe bien avant de lancer Baileys
    if (!fs.existsSync(AUTH_DIR)) {
      fs.mkdirSync(AUTH_DIR, { recursive: true });
    }

    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
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
                  <p style="margin-top: 20px; color: #a9b1b6;">Le code se rafraîchit automatiquement toutes les 20 secondes.</p>
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
          console.log('🔄 Reconnexion en cours...');
          setTimeout(connectToWhatsApp, 5000);
        } else {
          console.log('⚠️ Session rejetée. Réinitialisation complète...');
          cleanAuthFiles();
          setTimeout(connectToWhatsApp, 10000);
        }
      } else if (connection === 'open') {
        currentQrCodeHtml = "";
        console.log('\n✅✅✅ CONNECTÉ À WHATSAPP AVEC SUCCÈS ! ✅✅✅');
      }
    });

  } catch (error) {
    console.error('❌ Erreur de connexion :', error);
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
          <p style="color: #a9b1b6;">Si le bot ne fonctionne pas encore, rafraîchissez cette page dans 10 secondes.</p>
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
      return res.status(500).json({ status: 'error', message: 'WhatsApp non connecté. Veuillez scanner le QR code.' });
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
  console.log(`🌐 Endpoint cible pour n8n : https://whatsapp-alerts-production-f810.up.railway.app/send-order-alert`);
  connectToWhatsApp();
});