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

### Étape 2 : Configurer le compte Gmail expéditeur (2 min)

1. Sur le compte Gmail expéditeur (`ambroise.lepannerer@gmail.com`), activer la
   **validation en 2 étapes** : Compte Google → Sécurité → Validation en 2 étapes.
2. Générer un **mot de passe d'application** (16 caractères) : Compte Google →
   Sécurité → Validation en 2 étapes → Mots de passe des applications.
   Ne jamais utiliser le vrai mot de passe du compte.
3. Stocker ce mot de passe dans Secret Manager :
   ```bash
   firebase functions:secrets:set GMAIL_APP_PASSWORD
   # Coller le mot de passe d'application (16 caractères, sans espaces)
   ```

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
✔ sendReplacementNotification
✔ sendEdtInvitation
✔ sendTestEmail
✔ sendReplacementNotifications
```

### Étape 4 : Vérifier le déploiement (1 min)

1. **Firebase Console** → **Cloud Functions**
2. **Vérifier** que les 7 fonctions sont listées ✅
3. **Status** : ACTIVE (vert)

### Étape 5 : Redéployer l'app OVH

```bash
npm run build
# Copier dist/ vers tondomaine.com/edt/
```

### Étape 6 : Tester dans l'app

1. **Ouvrir l'app**
2. **Aller à** : Préférences de notifications (⚙️ dans le menu)
3. **Cliquer** : "Envoyer un email de test"
4. **Vérifier** : Email arrivé à l'adresse du compte connecté ✅

---

## ✅ C'est bon !

Les notifications sont maintenant **actives** ! 🎉

Les emails seront envoyés automatiquement pour :
- 📋 Tâche assignée
- 📊 Changement de statut
- 💬 Nouveau commentaire
- 🎯 Opportunité de remplacement proposée
- ✅/❌ Décision sur une candidature de remplacement

---

## 🆘 Troubleshooting

### Erreur d'authentification SMTP (535, "Username and Password not accepted")
→ Revérifier étape 2 : validation en 2 étapes activée + mot de passe d'application
régénéré dans Secret Manager, puis redéployer.

### Erreur : "Deploy failed"
→ Vérifier la connexion : `firebase login` puis redéployer

### Pas d'email de test reçu
→ Vérifier le dossier SPAM
→ Vérifier les logs de la fonction dans Firebase Console

### Functions montrent comme "OFFLINE"
→ Attendre 5 minutes après le déploiement
→ Rafraîchir la page Firebase Console

---

## 📞 Support

- **Firebase Docs** : https://firebase.google.com/docs/functions
- **Secret Manager** : https://firebase.google.com/docs/functions/config-env#secret-manager
- **Mots de passe d'application Gmail** : https://support.google.com/accounts/answer/185833
- **Guide complet** : Lire `functions/README.md`
- **Guide utilisateur** : Lire `NOTIFICATIONS_GUIDE.md`

---

**Déploiement facile en 5 minutes** ✨
