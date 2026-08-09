# 🚀 Déploiement Rapide - Cloud Functions

## ⏱️ 5 minutes pour activer les notifications !

### Étape 1 : Préparer l'environnement (2 min)

```bash
cd "/Users/boulot/Documents/site EPS vauban/edt gemini"

# Installer Firebase CLI (si pas déjà fait)
npm install -g firebase-tools

# Se connecter
firebase login
```

### Étape 2 : Configurer Brevo dans Firebase (1 min)

1. **Ouvrir Firebase Console** : https://console.firebase.google.com/
2. **Sélectionner le projet** : `emploi-du-temps-1644e`
3. **Aller à** : Cloud Functions
4. **Cliquer** : Runtime settings (roue dentée)
5. **Ajouter variable d'environnement** :
   - **Nom** : `BREVO_API_KEY`
   - **Valeur** : Votre clé API Brevo/Sendinblue
6. **Cliquer** : Enregistrer

### Étape 3 : Déployer les functions (2 min)

```bash
firebase deploy --only functions
```

Attendre la confirmation :
```
✔ Deploy complete!
✔ sendTaskAssignedEmail
✔ sendTaskStatusChangeEmail
✔ sendCommentNotificationEmail
✔ sendDeadlineReminders
✔ sendTestEmail
```

### Étape 4 : Vérifier le déploiement (1 min)

1. **Firebase Console** → **Cloud Functions**
2. **Vérifier** que les 5 fonctions sont listées ✅
3. **Status** : ACTIVE (vert)

### Étape 5 : Redéployer l'app OVH

```bash
npm run build
# Copier dist/ vers tondomaine.com/edt/
```

### Étape 6 : Tester dans l'app

1. **Ouvrir l'app** : https://tondomaine.com/edt/
2. **Aller à** : Préférences de notifications (⚙️ dans le menu)
3. **Cliquer** : "Envoyer un email de test"
4. **Vérifier** : Email arrivé à `edt@eps.ovh` ✅

---

## ✅ C'est bon !

Les notifications sont maintenant **actives** ! 🎉

Les emails seront envoyés automatiquement pour :
- 📋 Tâche assignée
- 📊 Changement de statut
- 💬 Nouveau commentaire
- ⏰ Rappel date limite

---

## 🆘 Troubleshooting

### Erreur : "BREVO_API_KEY not defined"
→ Revérifier étape 2, la variable doit être exacte

### Erreur : "Deploy failed"
→ Vérifier la connexion : `firebase login` puis redéployer

### Pas d'email de test reçu
→ Vérifier le dossier SPAM
→ Vérifier l'adresse `edt@eps.ovh` est activée dans Brevo Console

### Functions montrent comme "OFFLINE"
→ Attendre 5 minutes après le déploiement
→ Rafraîchir la page Firebase Console

---

## 📞 Support

- **Brevo Support** : https://www.brevo.com/fr/contact/
- **Firebase Docs** : https://firebase.google.com/docs/functions
- **Guide complet** : Lire `functions/README.md`
- **Guide utilisateur** : Lire `NOTIFICATIONS_GUIDE.md`

---

**Déploiement facile en 5 minutes** ✨
