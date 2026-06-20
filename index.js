const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
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
const N8N_WEBHOOK_URL = process.env.N8N_WEBHOOK_URL || 'https://votre-instance-n8n.railway.app/webhook/whatsapp-callback';
const AUTH_DIR = path.join(process.cwd(), 'auth_info_baileys');

let sock = null;
let isWhatsAppConnected = false;
let currentQRCode = null;
const pendingOrders = new Map();

function cleanAuthFiles() {
  try { if (fs.existsSync(AUTH_DIR)) fs.rmSync(AUTH_DIR, { recursive: true, force: true }); } 
  catch (error) { console.error('Erreur nettoyage session :', error.message); }
}

async function connectToWhatsApp() {
  try {
    if (!fs.existsSync(AUTH_DIR)) fs.mkdirSync(AUTH_DIR, { recursive: true });
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    const { version } = await fetchLatestBaileysVersion();

    sock = makeWASocket({
      auth: state,
      version,
      printQRInTerminal: false,
      logger: pino({ level: 'silent' }),
      browser: ['Stock Alert Bot', 'Chrome', '1.0.0']
    });

    sock.ev.on('creds.update', saveCreds);
    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;
      if (qr) currentQRCode = await qrcode.toDataURL(qr, { width: 400, margin: 2 });
      if (connection === 'open') { isWhatsAppConnected = true; currentQRCode = null; }
      if (connection === 'close') {
        isWhatsAppConnected = false;
        const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
        if (shouldReconnect) setTimeout(connectToWhatsApp, 5000);
        else { cleanAuthFiles(); setTimeout(connectToWhatsApp, 10000); }
      }
    });

    sock.ev.on('messages.upsert', async ({ messages }) => {
      try {
        const message = messages[0];
        if (!message || message.key.fromMe || !message.message) return;
        const from = message.key.remoteJid;
        const text = (message.message.conversation || message.message.extendedTextMessage?.text || '').trim().toLowerCase();
        
        const senderDigits = from.replace(/\D/g, '');
        let foundOrder = null;
        for (const [orderId, order] of pendingOrders.entries()) {
          if (order.phoneJid.replace(/\D/g, '') === senderDigits) {
            foundOrder = { orderId, ...order };
            break;
          }
        }

        if (!foundOrder) return;
        if (text === '1' || text === 'oui') {
          await sock.sendMessage(from, { text: '✅ Commande confirmée.' });
          await axios.post(N8N_WEBHOOK_URL, { orderId: foundOrder.orderId, status: 'CONFIRMED', phone: senderDigits }).catch(console.error);
          pendingOrders.delete(foundOrder.orderId);
        } else if (text === '2' || text === 'non') {
          await sock.sendMessage(from, { text: '❌ Commande annulée.' });
          pendingOrders.delete(foundOrder.orderId);
        }
      } catch (err) { console.error('Erreur upsert:', err); }
    });
  } catch (error) { console.error('Erreur connexion :', error.message); setTimeout(connectToWhatsApp, 10000); }
}

// ROUTE AJUSTÉE POUR NE PLUS AVOIR D'ERREUR 400
app.post('/send-order-alert', async (req, res) => {
  try {
    const { phone, telephone, product, quantity, supplier, threshold, orderId, message } = req.body;
    const finalPhone = phone || telephone;

    if (!finalPhone) return res.status(400).json({ status: 'error', message: 'Numéro manquant' });
    if (!message && !product) return res.status(400).json({ status: 'error', message: 'Contenu manquant' });
    if (!isWhatsAppConnected) return res.status(503).json({ status: 'error', message: 'WhatsApp déconnecté' });

    const whatsappId = finalPhone.replace(/\D/g, '') + '@s.whatsapp.net';
    const finalMessage = message || `🚨 *ALERTE STOCK*\n\n📦 *Produit :* ${product}\n📊 *Qté :* ${quantity}\n⚠️ *Seuil :* ${threshold}`;

    if (orderId) {
      pendingOrders.set(String(orderId).trim(), { phoneJid: whatsappId, product, quantity });
    }

    await sock.sendMessage(whatsappId, { text: finalMessage });
    return res.json({ status: 'success' });
  } catch (error) {
    return res.status(500).json({ status: 'error', message: error.message });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Serveur actif sur le port ${PORT}`);
  connectToWhatsApp();
});