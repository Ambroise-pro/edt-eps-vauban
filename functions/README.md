# Cloud Functions - Notifications par Email

Ce dossier contient les Cloud Functions Firebase pour envoyer des emails. L'envoi
se fait via le SMTP de **Gmail** (Nodemailer), avec un compte Gmail dédié — Brevo
n'est plus utilisé.

## 📋 Configuration requise

### 1. Compte Gmail expéditeur

- Compte : `ambroise.lepannerer@gmail.com` (défini dans `mailer.js`).
- Activer la **validation en 2 étapes** sur ce compte (Compte Google → Sécurité).
- Générer un **mot de passe d'application** (16 caractères) :
  Compte Google → Sécurité → Validation en 2 étapes → Mots de passe des applications.
  On n'utilise **jamais** le vrai mot de passe du compte, uniquement ce mot de passe
  d'application dédié.

### 2. Stocker le mot de passe dans Secret Manager

```bash
firebase functions:secrets:set GMAIL_APP_PASSWORD
# Coller le mot de passe d'application (16 caractères, sans espaces) quand demandé
```

Ce secret est injecté à l'exécution dans chaque fonction qui déclare
`secrets: [GMAIL_APP_PASSWORD]` — il n'apparaît jamais en clair dans le code, les
logs, ni côté front.

## 🚀 Déploiement

### Installation et test local

```bash
# Installer les dépendances
npm install

# Lancer l'émulateur (optionnel, pour tester localement)
npm run serve
```

### Déployer sur Firebase

```bash
# Installer Firebase CLI (une fois)
npm install -g firebase-tools

# Se connecter à Firebase
firebase login

# Déployer les functions
firebase deploy --only functions
```

## 📬 Functions disponibles

Toutes envoient via `sendEmail()` (voir `mailer.js`), et déclarent
`secrets: [GMAIL_APP_PASSWORD]` pour recevoir le mot de passe d'application Gmail.

### 1. `sendTaskAssignedEmail`
- **Déclencheur** : Création de tâche (`onDocumentCreated`, `tasks/{taskId}`)
- **Événement** : Une tâche est créée et assignée
- **Action** : Envoie un email à chaque prof assigné
- **Condition** : Si `taskAssigned` est `true` dans les préférences

### 2. `sendTaskStatusChangeEmail`
- **Déclencheur** : Mise à jour de tâche (`onDocumentUpdated`, `tasks/{taskId}`)
- **Événement** : Le statut change
- **Action** : Envoie un email aux profs assignés
- **Condition** : Si `taskStatusChange` est `true` dans les préférences

### 3. `sendCommentNotificationEmail`
- **Déclencheur** : Création de commentaire (`onDocumentCreated`, `taskComments/{commentId}`)
- **Événement** : Un nouveau commentaire est ajouté
- **Action** : Envoie un email aux profs assignés (sauf l'auteur)
- **Condition** : Si `commentNotifications` est `true` dans les préférences

### 4. `sendReplacementNotification`
- **Déclencheur** : Création d'un remplacement (`onDocumentCreated`, `replacements/{replacementId}`)
- **Événement** : Une opportunité de remplacement est proposée
- **Action** : Envoie un email au prof remplaçant
- **Condition** : Si `replacementNotifications` est `true` dans les préférences

### 5. `sendEdtInvitation` (appelable depuis le front, authentifié)
- **Déclencheur** : Appel `onCall` depuis l'app (admin)
- **Action** : Envoie l'EDT finalisé à une liste de profs

### 6. `sendTestEmail` (appelable depuis le front, authentifié)
- **Déclencheur** : Utilisateur clique "Envoyer un email de test"
- **Action** : Envoie un email de test à l'utilisateur connecté

### 7. `sendReplacementNotifications` (appelable depuis le front, authentifié)
- **Déclencheur** : Décision (acceptée/refusée) sur des candidatures de remplacement
- **Action** : Envoie à chaque candidat sa décision, avec un fichier .ics pour le
  candidat accepté

## 🧪 Tester

### Test 1 : Email de test
1. Ouvrir l'app
2. Cliquer sur ⚙️ (Préférences de notifications)
3. Cliquer "Envoyer un email de test"
4. Vérifier que l'email arrive

### Test 2 : Tâche assignée
1. Créer une tâche
2. Assigner à un prof
3. L'email doit arriver au prof en quelques secondes

### Test 3 : Changement de statut
1. Modifier le statut d'une tâche existante
2. L'email doit arriver au prof en quelques secondes

## 📊 Monitoring

Dans **Firebase Console** → **Cloud Functions** :
- Voir les logs en temps réel
- Vérifier le nombre d'appels
- Vérifier les erreurs éventuelles

## 🔧 Dépannage

### Erreur d'authentification SMTP (535, "Username and Password not accepted")
- Vérifier que la validation en 2 étapes est bien activée sur le compte Gmail
- Régénérer un mot de passe d'application et le remettre dans Secret Manager :
  `firebase functions:secrets:set GMAIL_APP_PASSWORD` puis redéployer

### "Secret GMAIL_APP_PASSWORD not found" / variable vide à l'exécution
- Vérifier que le secret a bien été créé : `firebase functions:secrets:access GMAIL_APP_PASSWORD`
- Vérifier que la fonction en erreur déclare bien `secrets: [GMAIL_APP_PASSWORD]`
- Redéployer après toute modification : `firebase deploy --only functions`

### Pas d'email reçu
- Vérifier les logs dans Firebase Console
- S'assurer que les préférences de notification sont activées
- Vérifier le dossier SPAM/Courrier indésirable
- Gmail limite l'envoi à ~500 destinataires/jour pour un compte personnel (~2000/jour
  en Google Workspace) — largement suffisant pour des notifications internes

## 📝 Structure Firestore

Les préférences de notification sont stockées dans :

```
users/{userId}/settings/notificationPreferences/
├── taskAssigned: boolean
├── taskStatusChange: boolean
├── commentNotifications: boolean
├── replacementNotifications: boolean
└── updatedAt: timestamp
```

## 🔒 Sécurité

- Les Cloud Functions `onCall` utilisent l'authentification Firebase
- Le mot de passe d'application Gmail est stocké dans Secret Manager, jamais en
  clair dans le code ni côté front
- Les utilisateurs ne peuvent voir que leurs propres préférences
- Les emails sont envoyés via une connexion SMTP chiffrée (port 465, `secure: true`)

## 📞 Support

- Firebase Console : https://console.firebase.google.com/
- Documentation Firebase Functions : https://firebase.google.com/docs/functions
- Documentation Secret Manager : https://firebase.google.com/docs/functions/config-env#secret-manager
- Aide Gmail "mots de passe des applications" : https://support.google.com/accounts/answer/185833
