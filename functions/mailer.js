// Envoi d'emails via le SMTP de Gmail (Nodemailer), en remplacement de Brevo.
//
// Le mot de passe n'est jamais en clair dans le code : il est stocké dans Secret
// Manager (voir README.md) et injecté à l'exécution via GMAIL_APP_PASSWORD.value().
// Chaque Cloud Function qui appelle sendEmail() doit déclarer `secrets: [GMAIL_APP_PASSWORD]`
// pour que ce secret lui soit effectivement fourni.

const nodemailer = require("nodemailer");
const { defineSecret } = require("firebase-functions/params");

const GMAIL_APP_PASSWORD = defineSecret("GMAIL_APP_PASSWORD");

// Compte Gmail dédié à l'envoi (validation en 2 étapes + mot de passe d'application,
// jamais le vrai mot de passe du compte).
const GMAIL_SENDER_EMAIL = "ambroise.lepannerer@gmail.com";
const GMAIL_SENDER_NAME = "EDT EPS Vauban";

// Le transporteur Nodemailer est recréé à chaque "cold start" d'instance de fonction,
// puis réutilisé pour les invocations suivantes sur la même instance (warm start) —
// on évite de reconstruire la connexion SMTP à chaque email.
let cachedTransporter = null;

function getTransporter() {
  if (cachedTransporter) return cachedTransporter;
  cachedTransporter = nodemailer.createTransport({
    host: "smtp.gmail.com",
    port: 465,
    secure: true,
    auth: {
      user: GMAIL_SENDER_EMAIL,
      pass: GMAIL_APP_PASSWORD.value(),
    },
  });
  return cachedTransporter;
}

// Dérive une version texte minimale depuis le HTML, pour les clients mail qui
// n'affichent pas le HTML (meilleure délivrabilité, pas de dépendance ajoutée).
function htmlToPlainText(html) {
  return String(html || "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<[^>]+>/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Envoie un email via le SMTP de Gmail.
 * @param {string} to Adresse destinataire.
 * @param {string} subject Sujet de l'email.
 * @param {string} htmlContent Corps HTML (styles en ligne recommandés).
 * @returns {Promise<import("nodemailer").SentMessageInfo>}
 */
async function sendEmail(to, subject, htmlContent) {
  if (!to) {
    throw new Error("Adresse destinataire manquante.");
  }
  const transporter = getTransporter();
  try {
    const info = await transporter.sendMail({
      from: `"${GMAIL_SENDER_NAME}" <${GMAIL_SENDER_EMAIL}>`,
      to,
      subject,
      html: htmlContent,
      text: htmlToPlainText(htmlContent),
    });
    console.log(`Email envoyé à ${to} (messageId: ${info.messageId})`);
    return info;
  } catch (error) {
    console.error(`Erreur envoi email à ${to}:`, error.message);
    throw error;
  }
}

module.exports = { sendEmail, GMAIL_APP_PASSWORD };
