async function connectToWhatsApp() {
  try {
    // FORCE LE NETTOYAGE : Supprime les résidus de déconnexion avant de charger la session
    cleanAuthFiles();

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
          console.log('⚠️ Session rejetée par WhatsApp. Nettoyage et régénération du QR Code...');
          cleanAuthFiles();
          setTimeout(connectToWhatsApp, 5000); // Réduit à 5s pour aller plus vite
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