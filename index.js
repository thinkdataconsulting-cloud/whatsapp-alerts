const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const qrcode = require('qrcode-terminal');
const express = require('express');
const bodyParser = require('body-parser');
const pino = require('pino');
const { Boom } = require('@hapi/boom');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(bodyParser.json());

let sock;
const pendingOrders = new Map();

// 1. Initialisation et Connexion à WhatsApp
async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');

    const { version, isLatest } = await fetchLatestBaileysVersion();
    console.log(`Utilisation de la version ${version.join('.')} de Baileys`);

    sock = makeWASocket({
        auth: state,
        printQRInTerminal: false,
        logger: pino({ level: 'silent' }),
        browser: ['Gestion Stock Bot', 'Chrome', '1.0.0'],
        version: version,
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr, isNewLogin } = update;

        if (qr) {
            console.log('\n🔄 Un nouveau QR Code a été généré. Scannez-le avec WhatsApp :');
            qrcode.generate(qr, { small: true });
            console.log('\n📱 Si le QR code ne s\'affiche pas, ouvrez ce lien dans votre navigateur :');
            console.log(`https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(qr)}`);
        }

        if (isNewLogin) {
            console.log('\n✅ Nouvelle connexion établie avec succès !');
        }

        if (connection === 'close') {
            const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log('\n❌ Connexion fermée. Raison :', lastDisconnect?.error?.message || 'Inconnue');
            if (shouldReconnect) {
                console.log('🔄 Tentative de reconnexion dans 5 secondes...');
                setTimeout(connectToWhatsApp, 5000);
            } else {
                console.log('⚠️ Déconnecté. Veuillez rescanner le QR code.');
                connectToWhatsApp(); // Relance immédiatement pour générer un nouveau QR code
            }
        } else if (connection === 'open') {
            console.log('\n✅ Connecté à WhatsApp avec succès !');
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
                        await handleOrderConfirmation(order);
                    } else if (selectedButtonId === 'cancel_order') {
                        await sock.sendMessage(
                            `${order.phone}@s.whatsapp.net`,
                            { text: '❌ Commande annulée. Aucune action effectuée.' }
                        );
                    }
                    pendingOrders.delete(orderId);
                }
            }
        }
    });
}

async function handleOrderConfirmation(order) {
    const { phone, product, quantity, supplier } = order;
    await sock.sendMessage(
        `${phone}@s.whatsapp.net`,
        {
            text: `✅ *COMMANDE CONFIRMÉE* ✅\n\n` +
                  `📦 *Produit* : ${product}\n` +
                  `📊 *Quantité* : ${quantity}\n` +
                  `🏪 *Fournisseur* : ${supplier}\n\n` +
                  `📝 La commande a été lancée.`
        }
    );
}

// 2. Endpoint pour envoyer une alerte avec boutons
app.all('/send-order-alert', async (req, res) => {
    try {
        if (req.method === 'GET') {
            return res.status(200).json({
                status: 'success',
                message: 'Endpoint fonctionnel. Utilisez une requête POST pour envoyer une alerte.'
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

        const buttons = [
            { buttonId: 'confirm_order', buttonText: { displayText: '✅ Confirmer la commande' }, type: 1 },
            { buttonId: 'cancel_order', buttonText: { displayText: '❌ Annuler' }, type: 1 }
        ];

        const message = {
            text: `🚨 *ALERTE STOCK FAIBLE* 🚨\n\n` +
                  `📦 *Produit* : ${product}\n` +
                  `📊 *Quantité* : ${quantity} (Seuil : ${threshold})\n` +
                  `🏪 *Fournisseur* : ${supplier}\n\n` +
                  `💡 Souhaitez-vous passer une commande ?`,
            buttons,
            footer: 'Répondez en cliquant sur un bouton.'
        };

        await sock.sendMessage(formattedPhone, message);
        console.log(`📩 Alerte envoyée pour ${product} (ID: ${orderId})`);
        return res.status(200).json({ status: 'success', message: 'Alerte envoyée.' });

    } catch (error) {
        console.error('❌ Erreur :', error);
        return res.status(500).json({ status: 'error', message: error.message });
    }
});

// Lancement du serveur
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Serveur démarré sur http://localhost:${PORT}`);
    console.log(`🌐 Accédez à http://localhost:${PORT}/send-order-alert pour tester l'endpoint.`);
    connectToWhatsApp();
});