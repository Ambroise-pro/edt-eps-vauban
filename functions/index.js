const functions = require("firebase-functions");
const admin = require("firebase-admin");
const axios = require("axios");
const { onCall } = require("firebase-functions/v2/https");

// Initialize Firebase Admin
admin.initializeApp();

const db = admin.firestore();

// Configuration Brevo
const BREVO_API_KEY = process.env.BREVO_API_KEY;
const BREVO_SENDER_EMAIL = "ambroise.lepannerer@gmail.com";
const BREVO_SENDER_NAME = "EDT EPS Vauban";

/**
 * Envoyer un email via Brevo
 */
async function sendEmailWithBrevo(to, subject, htmlContent) {
  try {
    console.log(`Envoi email à ${to} avec clé API:`, BREVO_API_KEY.substring(0, 20) + "...");

    const response = await axios.post(
      "https://api.brevo.com/v3/smtp/email",
      {
        to: [{ email: to }],
        sender: {
          name: BREVO_SENDER_NAME,
          email: BREVO_SENDER_EMAIL,
        },
        subject,
        htmlContent,
      },
      {
        headers: {
          "api-key": BREVO_API_KEY,
          "Content-Type": "application/json",
        },
      }
    );

    console.log(`Email envoyé à ${to}:`, response.status);
    return response.data;
  } catch (error) {
    console.error(`Erreur envoi email à ${to}:`, error.response?.status, error.response?.data || error.message);
    throw error;
  }
}

/**
 * Obtenir l'email d'un prof
 */
async function getTeacherEmail(teacherId) {
  const teacher = await db.collection("teachers").doc(teacherId).get();
  if (!teacher.exists) return null;
  return teacher.data()?.email;
}

/**
 * Obtenir les préférences de notification d'un utilisateur
 */
async function getUserNotificationPreferences(userId) {
  const prefs = await db
    .collection("users")
    .doc(userId)
    .collection("settings")
    .doc("notificationPreferences")
    .get();

  return prefs.exists
    ? prefs.data()
    : {
        taskAssigned: true,
        taskStatusChange: true,
        commentNotifications: true,
        deadlineReminders: true,
        digestFrequency: "immediate",
      };
}

/**
 * Template HTML pour email de tâche assignée
 */
function getTaskAssignedEmailTemplate(task, teacherName) {
  return `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="UTF-8">
      <style>
        body { font-family: Arial, sans-serif; color: #333; }
        .container { max-width: 600px; margin: 0 auto; padding: 20px; }
        .header { background: #002b5b; color: white; padding: 20px; border-radius: 8px 8px 0 0; }
        .header h1 { margin: 0; font-size: 24px; }
        .content { background: #f8f9fa; padding: 20px; border: 1px solid #ddd; }
        .task-card { background: white; padding: 15px; border-left: 4px solid #002b5b; margin: 15px 0; }
        .task-title { font-size: 18px; font-weight: bold; color: #002b5b; margin: 0 0 10px 0; }
        .task-desc { color: #666; margin: 0 0 10px 0; }
        .footer { background: #f0f0f0; padding: 15px; text-align: center; font-size: 12px; color: #999; }
        .button { background: #002b5b; color: white; padding: 10px 20px; text-decoration: none; border-radius: 4px; display: inline-block; margin-top: 10px; }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="header">
          <h1>📋 Nouvelle tâche assignée</h1>
        </div>
        <div class="content">
          <p>Bonjour ${teacherName},</p>
          <p>Une nouvelle tâche vous a été assignée :</p>

          <div class="task-card">
            <p class="task-title">${task.title}</p>
            <p class="task-desc">${task.description || "Pas de description"}</p>
            <p><strong>Priorité :</strong> ${task.priority}</p>
            <p><strong>Catégorie :</strong> ${task.category}</p>
            ${task.dueDate ? `<p><strong>Date limite :</strong> ${new Date(task.dueDate).toLocaleDateString("fr-FR")}</p>` : ""}
          </div>

          <a href="https://eps.ovh/edt?taskId=${task.id}" class="button">Voir la tâche</a>
        </div>
        <div class="footer">
          <p>EDT EPS Vauban © 2026</p>
          <p>Vous recevez cet email car une tâche vous a été assignée.</p>
        </div>
      </div>
    </body>
    </html>
  `;
}

/**
 * Cloud Function : Envoyer un email quand une tâche est créée
 */
exports.sendTaskAssignedEmail = functions.firestore.onDocumentCreated("tasks/{taskId}", async (event) => {
  const task = event.data.data();
  const taskId = event.data.id;

  console.log(`Nouvelle tâche créée: ${taskId}`);

  // Envoyer un email à chaque prof assigné
  if (task.assignedTeachers && Array.isArray(task.assignedTeachers)) {
    for (const teacherId of task.assignedTeachers) {
      try {
        const email = await getTeacherEmail(teacherId);
        if (!email) {
          console.warn(`Email non trouvé pour le prof ${teacherId}`);
          continue;
        }

        const prefs = await getUserNotificationPreferences(teacherId);
        if (!prefs.taskAssigned) {
          console.log(`Notifications désactivées pour ${teacherId}`);
          continue;
        }

        const teacher = await db.collection("teachers").doc(teacherId).get();
        const teacherName = teacher.data()?.name || "Enseignant";

        const htmlContent = getTaskAssignedEmailTemplate(task, teacherName);

        await sendEmailWithBrevo(
          email,
          `🎯 Nouvelle tâche : ${task.title}`,
          htmlContent
        );
      } catch (error) {
        console.error(`Erreur envoi email pour ${teacherId}:`, error);
      }
    }
  }

  return null;
});

/**
 * Cloud Function : Envoyer un email quand le statut change
 */
exports.sendTaskStatusChangeEmail = functions.firestore.onDocumentUpdated("tasks/{taskId}", async (event) => {
  const before = event.data.before.data();
  const after = event.data.after.data();
  const taskId = event.data.after.id;

  // Vérifier si le statut a changé
  if (before.status === after.status) {
    return null;
  }

  console.log(`Statut de tâche changé: ${taskId}`);

  // Envoyer un email à chaque prof assigné
  if (after.assignedTeachers && Array.isArray(after.assignedTeachers)) {
    for (const teacherId of after.assignedTeachers) {
      try {
        const email = await getTeacherEmail(teacherId);
        if (!email) continue;

        const prefs = await getUserNotificationPreferences(teacherId);
        if (!prefs.taskStatusChange) continue;

        const htmlContent = `
          <!DOCTYPE html>
          <html>
          <head>
            <meta charset="UTF-8">
            <style>
              body { font-family: Arial, sans-serif; color: #333; }
              .container { max-width: 600px; margin: 0 auto; padding: 20px; }
              .header { background: #002b5b; color: white; padding: 20px; border-radius: 8px 8px 0 0; }
              .content { background: #f8f9fa; padding: 20px; }
              .status-badge { display: inline-block; padding: 8px 16px; border-radius: 4px; font-weight: bold; margin: 10px 0; }
              .status-en-cours { background: #fff3cd; color: #856404; }
              .status-terminee { background: #d4edda; color: #155724; }
            </style>
          </head>
          <body>
            <div class="container">
              <div class="header">
                <h1>📊 Mise à jour de tâche</h1>
              </div>
              <div class="content">
                <p>La tâche <strong>${after.title}</strong> a changé de statut.</p>
                <p><span class="status-badge status-${after.status.toLowerCase()}">${after.status.replace("_", " ")}</span></p>
              </div>
            </div>
          </body>
          </html>
        `;

        await sendEmailWithBrevo(
          email,
          `📊 Mise à jour tâche : ${after.title}`,
          htmlContent
        );
      } catch (error) {
        console.error(`Erreur envoi email de statut:`, error);
      }
    }
  }

  return null;
});

/**
 * Cloud Function : Envoyer un email quand un commentaire est ajouté
 */
exports.sendCommentNotificationEmail = functions.firestore.onDocumentCreated("taskComments/{commentId}", async (event) => {
  const comment = event.data.data();
  const taskId = comment.taskId;

  console.log(`Nouveau commentaire sur tâche ${taskId}`);

  try {
    // Obtenir la tâche
    const task = await db.collection("tasks").doc(taskId).get();
    if (!task.exists) return null;

    const taskData = task.data();
    const authorId = comment.authorId;

    // Envoyer à chaque prof assigné (sauf l'auteur)
    if (taskData.assignedTeachers && Array.isArray(taskData.assignedTeachers)) {
      for (const teacherId of taskData.assignedTeachers) {
        if (teacherId === authorId) continue; // Ne pas notifier l'auteur

        try {
          const email = await getTeacherEmail(teacherId);
          if (!email) continue;

          const prefs = await getUserNotificationPreferences(teacherId);
          if (!prefs.commentNotifications) continue;

          const author = await db.collection("teachers").doc(authorId).get();
          const authorName = author.data()?.name || "Un utilisateur";

          const htmlContent = `
            <!DOCTYPE html>
            <html>
            <body style="font-family: Arial, sans-serif;">
              <div style="max-width: 600px; margin: 0 auto; padding: 20px;">
                <div style="background: #002b5b; color: white; padding: 20px; border-radius: 8px 8px 0 0;">
                  <h1>💬 Nouveau commentaire</h1>
                </div>
                <div style="background: #f8f9fa; padding: 20px; border: 1px solid #ddd;">
                  <p><strong>${authorName}</strong> a commenté la tâche <strong>${taskData.title}</strong> :</p>
                  <div style="background: white; padding: 15px; border-left: 4px solid #002b5b; margin: 15px 0;">
                    <p>${comment.text}</p>
                  </div>
                </div>
              </div>
            </body>
            </html>
          `;

          await sendEmailWithBrevo(
            email,
            `💬 Nouveau commentaire sur ${taskData.title}`,
            htmlContent
          );
        } catch (error) {
          console.error(`Erreur envoi email de commentaire:`, error);
        }
      }
    }
  } catch (error) {
    console.error(`Erreur traitement commentaire:`, error);
  }

  return null;
});

/**
 * Cloud Function : Envoyer une notification quand un remplacement est créé
 */
exports.sendReplacementNotification = functions.firestore.onDocumentCreated("replacements/{replacementId}", async (event) => {
  const replacement = event.data.data();
  const toTeacherId = replacement.toTeacherId;

  if (!toTeacherId) {
    console.warn("toTeacherId manquant dans le remplacement");
    return null;
  }

  try {
    // Récupérer les infos du prof remplaçant
    const replacerDoc = await db.collection("teachers").doc(toTeacherId).get();
    if (!replacerDoc.exists) {
      console.warn(`Prof remplaçant ${toTeacherId} non trouvé`);
      return null;
    }

    const replacer = replacerDoc.data();
    const email = replacer.email;
    const name = replacer.name || "Enseignant";

    if (!email) {
      console.warn(`Email du remplaçant ${toTeacherId} non trouvé`);
      return null;
    }

    // Récupérer les préférences de notification
    const prefs = await getUserNotificationPreferences(toTeacherId);
    if (!prefs.replacementNotifications) {
      console.log(`Notifications de remplacement désactivées pour ${toTeacherId}`);
      return null;
    }

    // Récupérer l'absence pour plus de détails
    const absenceDoc = await db.collection("absences").doc(replacement.absenceId).get();
    const absence = absenceDoc.exists ? absenceDoc.data() : null;

    // Récupérer le prof absent
    let absentTeacherName = "Un professeur";
    if (absence && absence.teacherId) {
      const absentTeacherDoc = await db.collection("teachers").doc(absence.teacherId).get();
      if (absentTeacherDoc.exists) {
        absentTeacherName = absentTeacherDoc.data().name || "Un professeur";
      }
    }

    const startDate = new Date(replacement.startDate).toLocaleDateString("fr-FR");
    const endDate = new Date(replacement.endDate).toLocaleDateString("fr-FR");

    const htmlContent = `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="UTF-8">
        <style>
          body { font-family: Arial, sans-serif; color: #333; }
          .container { max-width: 600px; margin: 0 auto; padding: 20px; }
          .header { background: #28a745; color: white; padding: 20px; border-radius: 8px 8px 0 0; }
          .header h1 { margin: 0; font-size: 24px; }
          .content { background: #f8f9fa; padding: 20px; border: 1px solid #ddd; }
          .detail-box { background: white; padding: 15px; border-left: 4px solid #28a745; margin: 15px 0; }
          .button { background: #28a745; color: white; padding: 10px 20px; text-decoration: none; border-radius: 4px; display: inline-block; margin-top: 10px; }
          .footer { background: #f0f0f0; padding: 15px; text-align: center; font-size: 12px; color: #999; }
          .info { margin: 8px 0; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <h1>🎯 Opportunité de remplacement</h1>
          </div>
          <div class="content">
            <p>Bonjour ${name},</p>
            <p>Une opportunité de remplacement vous a été proposée :</p>

            <div class="detail-box">
              <p><strong>Prof absent :</strong> ${absentTeacherName}</p>
              <p><strong>Du :</strong> ${startDate}</p>
              <p><strong>Au :</strong> ${endDate}</p>
              ${absence?.reason ? `<p><strong>Motif :</strong> ${absence.reason}</p>` : ""}
            </div>

            <a href="https://eps.ovh/edt" class="button">Consulter les détails</a>
          </div>
          <div class="footer">
            <p>EDT EPS Vauban © 2026</p>
            <p>Vous recevez cet email car un remplacement vous a été proposé.</p>
          </div>
        </div>
      </body>
      </html>
    `;

    await sendEmailWithBrevo(
      email,
      `🎯 Opportunité de remplacement : ${startDate}`,
      htmlContent
    );

    console.log(`Notification de remplacement envoyée à ${email}`);
  } catch (error) {
    console.error(`Erreur envoi notification remplacement:`, error);
  }

  return null;
});

/**
 * Cloud Function : Envoyer une invitation à consulter l'EDT
 */
exports.sendEdtInvitation = onCall(async (request) => {
  if (!request.auth) {
    throw new functions.https.HttpsError("unauthenticated", "Authentification requise");
  }

  const { teacherIds, schoolYear } = request.data;

  if (!teacherIds || !Array.isArray(teacherIds)) {
    throw new functions.https.HttpsError("invalid-argument", "teacherIds manquant ou invalide");
  }

  try {
    let sentCount = 0;

    // Envoyer un email à chaque prof
    for (const teacherId of teacherIds) {
      try {
        const teacherDoc = await db.collection("teachers").doc(teacherId).get();

        if (!teacherDoc.exists) continue;

        const teacher = teacherDoc.data();
        const email = teacher.email;
        const name = teacher.name || "Enseignant";

        if (!email) continue;

        const edtImageHtml = request.data.edtImage ? `
          <div style="margin: 20px 0; text-align: center;">
            <p style="font-weight: bold; margin-bottom: 10px;">Aperçu de votre emploi du temps :</p>
            <img src="${request.data.edtImage}" style="max-width: 100%; height: auto; border: 1px solid #ddd; border-radius: 4px;">
          </div>
        ` : '';

        const htmlContent = `
          <!DOCTYPE html>
          <html>
          <head>
            <meta charset="UTF-8">
            <style>
              body { font-family: Arial, sans-serif; color: #333; }
              .container { max-width: 600px; margin: 0 auto; padding: 20px; }
              .header { background: #002b5b; color: white; padding: 20px; border-radius: 8px 8px 0 0; }
              .header h1 { margin: 0; font-size: 24px; }
              .content { background: #f8f9fa; padding: 20px; border: 1px solid #ddd; }
              .button { background: #002b5b; color: white; padding: 12px 24px; text-decoration: none; border-radius: 4px; display: inline-block; margin-top: 15px; font-weight: bold; }
              .footer { background: #f0f0f0; padding: 15px; text-align: center; font-size: 12px; color: #999; }
            </style>
          </head>
          <body>
            <div class="container">
              <div class="header">
                <h1>📅 Votre emploi du temps est prêt</h1>
              </div>
              <div class="content">
                <p>Bonjour ${name},</p>
                <p>L'emploi du temps pour l'année scolaire <strong>${schoolYear}</strong> a été finalisé.</p>
                ${edtImageHtml}
                <p>Consultez le planning complet en cliquant sur le lien ci-dessous :</p>
                <a href="https://eps.ovh/edt" class="button">📊 Consulter mon EDT</a>
                <p style="margin-top: 30px; color: #666; font-size: 14px;">
                  Vous pouvez également accéder à votre emploi du temps à tout moment via l'application.
                </p>
              </div>
              <div class="footer">
                <p>EDT EPS Vauban © 2026</p>
                <p>Cet email a été envoyé automatiquement suite à la finalisation de l'emploi du temps.</p>
              </div>
            </div>
          </body>
          </html>
        `;

        await sendEmailWithBrevo(
          email,
          `📅 Votre emploi du temps ${schoolYear} est disponible`,
          htmlContent
        );

        sentCount++;
      } catch (error) {
        console.error(`Erreur envoi invitation à ${teacherId}:`, error);
      }
    }

    console.log(`Invitations envoyées à ${sentCount}/${teacherIds.length} profs`);

    return {
      success: true,
      message: `Invitations envoyées à ${sentCount} profs`,
      sentCount
    };
  } catch (error) {
    console.error("Erreur sendEdtInvitation:", error);
    throw new functions.https.HttpsError("internal", error.message);
  }
});

// TODO: Scheduled function à ajouter après la stabilisation de v7
// exports.sendDeadlineReminders = ...;

// Cloud Function de test (v2 API)
exports.sendTestEmail = onCall(async (request) => {
  if (!request.auth) {
    throw new functions.https.HttpsError("unauthenticated", "Authentification requise");
  }

  const { teacherId } = request.data;

  if (!teacherId) {
    throw new functions.https.HttpsError("invalid-argument", "teacherId manquant");
  }

  try {
    // Récupérer le profil prof par son ID
    const teacherDoc = await db.collection("teachers").doc(teacherId).get();

    if (!teacherDoc.exists) {
      throw new functions.https.HttpsError("not-found", "Profil prof non trouvé");
    }

    const teacher = teacherDoc.data();
    const userEmail = teacher.email;

    if (!userEmail) {
      throw new functions.https.HttpsError("invalid-argument", "Email non configuré dans le profil");
    }

    await sendEmailWithBrevo(
      userEmail,
      "✅ Email de test - EDT EPS",
      `
        <html>
        <body style="font-family: Arial, sans-serif;">
          <div style="max-width: 600px; margin: 0 auto; padding: 20px;">
            <div style="background: #002b5b; color: white; padding: 20px; border-radius: 8px;">
              <h1>✅ Email de test</h1>
              <p>Si vous recevez ce message, le système de notifications par email fonctionne correctement !</p>
            </div>
          </div>
        </body>
        </html>
      `
    );

    return { success: true, message: "Email de test envoyé" };
  } catch (error) {
    console.error("Erreur sendTestEmail:", error);
    throw new functions.https.HttpsError("internal", error.message);
  }
});
