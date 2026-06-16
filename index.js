// --- Dans l'endpoint /send-order-alert ---
app.all('/send-order-alert', async (req, res) => {
  try {
    console.log('\n📩 NOUVELLE ALERTE STOCK');
    console.log('🔍 Body reçu:', req.body);

    if (req.method === 'GET') {
      return res.status(200).json({
        status: 'success',
        message: 'Endpoint OK. Utilisez POST pour envoyer une alerte.',
        whatsappConnected: !!sock
      });
    }

    // Vérifie que le body n'est pas vide
    if (!req.body || Object.keys(req.body).length === 0) {
      return res.status(400).json({
        status: 'error',
        message: 'Body vide !'
      });
    }

    // Extrait les champs
    const { phone, product, quantity, supplier, threshold, orderld } = req.body;
    const finalPhone = phone || ADMIN_PHONE;
    const orderIdentifier = orderld || `ORDER-${product}-${Date.now()}`;

    // Vérifie que WhatsApp est connecté
    if (!sock || sock.ws?.readyState !== 1) {  // <-- Vérifie que la connexion est active
      return res.status(503).json({
        status: 'error',
        message: 'WhatsApp non connecté. Scannez le QR code à /qrcode',
        whatsappStatus: !!sock,
        sockStatus: sock?.ws?.readyState
      });
    }

    // Formate le numéro de téléphone
    const formattedPhone = finalPhone.replace(/[^0-9]/g, '').replace(/^0+/, '') + '@s.whatsapp.net';
    console.log('📱 Numéro formaté:', formattedPhone);

    // Stocke la commande en attente
    pendingOrders.set(orderIdentifier, {
      phone: formattedPhone,
      product,
      quantity,
      supplier,
      threshold
    });

    // Envoie le message WhatsApp
    try {
      const messageContent = {
        text: `🚨 *ALERTE RUPTURE DE STOCK* 🚨\n\n📦 *Produit* : ${product}\n📊 *Quantité* : ${quantity}\n⚠️ *Seuil* : ${threshold}\n🏪 *Fournisseur* : ${supplier}`,
        buttons: [
          { buttonId: 'confirm_order', buttonText: { displayText: '✅ Commander' }, type: 1 },
          { buttonId: 'cancel_order', buttonText: { displayText: '❌ Ignorer' }, type: 1 }
        ]
      };

      // Attend que le message soit envoyé
      await sock.sendMessage(formattedPhone, messageContent);
      console.log('✅ Message envoyé à:', formattedPhone);

      return res.status(200).json({
        status: 'success',
        message: 'Alerte envoyée avec succès !',
        orderId: orderIdentifier,
        sentTo: formattedPhone
      });

    } catch (whatsappError) {
      console.error('❌ ÉCHEC WhatsApp:', whatsappError);
      return res.status(500).json({
        status: 'error',
        message: 'Échec de l\'envoi WhatsApp',
        error: whatsappError.message,
        formattedPhone: formattedPhone
      });
    }

  } catch (error) {
    console.error('❌ Erreur:', error);
    return res.status(500).json({
      status: 'error',
      message: error.message
    });
  }
});