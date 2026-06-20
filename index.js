// Route pour envoyer l'alerte
// On utilise req.params.clientId pour identifier le bot si vous avez plusieurs instances
// Le corps de la requête (req.body) contient maintenant 'phone' et 'message'
app.post('/send-alert/:clientId', async (req, res) => {
    const { clientId } = req.params;
    const { phone, message } = req.body;

    const instance = instances.get(clientId);
    
    if (!instance || !instance.connected) {
        return res.status(503).json({ error: 'Instance non connectée ou introuvable' });
    }
    
    try {
        // Nettoyage du numéro de téléphone
        const whatsappId = String(phone).replace(/\D/g, '') + '@s.whatsapp.net';
        
        // Envoi du message via Baileys
        await instance.sock.sendMessage(whatsappId, { text: message });
        
        res.json({ status: 'success', message: 'Alerte envoyée' });
    } catch (e) {
        console.error(`Erreur lors de l'envoi pour ${clientId}:`, e);
        res.status(500).json({ error: e.message });
    }
});