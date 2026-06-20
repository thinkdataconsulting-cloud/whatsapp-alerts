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
const axios = require('axios');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 8080;
const AUTH_DIR = path.join(process.cwd(), 'auth_info_baileys');

let sock = null;
let isWhatsAppConnected = false;
let currentQRCode = null;

// --- GESTION DE LA CONNEXION ---
async function connectToWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    auth: state,
    version,
    logger: pino({ level: 'silent' }),
    browser: ['StockAlert', 'Desktop', '1.0.0']
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;
    
    if (qr) currentQRCode = qr; // Stockage du QR brut
    
    if (connection === 'open') {
      isWhatsAppConnected = true;
      console.log('✅ Connecté');
    }
    
    if (connection === 'close') {
      const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
      if (shouldReconnect) connectToWhatsApp();
      else console.log('🔒 Déconnecté');
    }
  });

  // --- LOGIQUE DE RÉPONSE ---
  sock.ev.on('messages.upsert', async ({ messages }) => {
    const m = messages[0];
    if (!m.message || m.key.fromMe) return;

    const text = (m.message.conversation || m.message.extendedTextMessage?.text || '').trim().toLowerCase();
    const from = m.key.remoteJid;

    if (text === '1' || text === 'oui') {
      await sock.sendMessage(from, { text: '✅ Commande confirmée.' });
      // Envoi du callback à n8n (adaptez l'URL)
      await axios.post(process.env.N8N_WEBHOOK_URL, { phone: from, status: 'CONFIRMED' }).catch(console.error);
    }
  });
}

// --- API POUR N8N ---
app.post('/send-order-alert', async (req, res) => {
  try {
    const { phone, product, quantity, supplier, threshold } = req.body;
    
    if (!phone || !product) return res.status(400).json({ error: 'Données manquantes' });

    const jid = phone.includes('@s.whatsapp.net') ? phone : `${phone.replace(/\D/g, '')}@s.whatsapp.net`;
    
    const message = `🚨 *ALERTE STOCK*\n\n📦 *Produit :* ${product}\n📊 *Quantité :* ${quantity}\n⚠️ *Seuil :* ${threshold}\n🏪 *Fournisseur :* ${supplier}`;
    
    await sock.sendMessage(jid, { text: message });
    return res.json({ status: 'success' });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  connectToWhatsApp();
});