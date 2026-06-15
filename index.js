app.all('/send-order-alert', async (req, res) => {
  try {
    if (req.method === 'GET') {
      return res.status(200).json({
        status: 'success',
        message: 'Endpoint OK. Utilise POST pour envoyer une alerte.',
        whatsappConnected: !!sock
      });
    }

    // --- CORRECTION ICI ---
    const { phone, product, quantity, supplier, threshold, orderld } = req.body;  // <-- orderld au lieu de orderId

    if (!phone || !product || !quantity || !supplier || !threshold || !orderld) {  // <-- orderld au lieu de orderId
      return res.status(400).json({
        status: 'error',
        message: 'Données manquantes: phone, product, quantity, supplier, threshold, orderld'  // <-- orderld
      });
    }
    // --- FIN DE CORRECTION ---

    if (!sock) {
      return res.status(500).json({
        status: 'error',
        message: 'WhatsApp non connecté. Scannez d\'abord le QR code.'
      });
    }

    pendingOrders.set(orderld, { phone, product, quantity, supplier, threshold });  // <-- orderld
    const formattedPhone = phone.replace(/\D/g, '') + '@s.whatsapp.net';

    await sock.sendMessage(formattedPhone, {
      text: `🚨 ALERTE STOCK FAIBLE 🚨\n\n📦 Produit : ${product}\n📊 Quantité : ${quantity} (Seuil : ${threshold})\n🏪 Fournisseur : ${supplier}\n\nPasser une commande ?`,
      buttons: [
        { buttonId: 'confirm_order', buttonText: { displayText: '✅ Oui' }, type: 1 },
        { buttonId: 'cancel_order', buttonText: { displayText: '❌ Non' }, type: 1 }
      ],
      footer: 'Répondez avec un bouton.'
    });

    return res.status(200).json({
      status: 'success',
      message: 'Alerte envoyée avec succès.',
      orderId: orderld  // <-- orderld
    });
  } catch (error) {
    console.error('❌ Erreur dans /send-order-alert :', error);
    return res.status(500).json({
      status: 'error',
      message: error.message || 'Erreur interne du serveur'
    });
  }
});