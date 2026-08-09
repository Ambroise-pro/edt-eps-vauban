# Cloud Functions - Notifications par Email

Ce dossier contient les Cloud Functions Firebase pour envoyer des emails via Brevo.

## 📋 Configuration requise

### 1. Variable d'environnement Brevo

Dans **Firebase Console** → **Cloud Functions** → **Variables d'environnement** :

```
BREVO_API_KEY=votre_clé_api_brevo_ici
```

### 2. Email sender Brevo

L'email sender est configuré comme : `edt@eps.ovh`

Vérifiez que cet email est vérifié dans **Brevo Console** → **Emails** → **Senders**.

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

### 1. `sendTaskAssignedEmail`
- **Déclencheur** : Création de tâche
- **Événement** : Une tâche est créée et assignée
- **Action** : Envoie un email à chaque prof assigné
- **Condition** : Si `taskAssigned` est `true` dans les préférences

### 2. `sendTaskStatusChangeEmail`
- **Déclencheur** : Mise à jour de tâche
- **Événement** : Le statut change
- **Action** : Envoie un email aux profs assignés
- **Condition** : Si `taskStatusChange` est `true` dans les préférences

### 3. `sendCommentNotificationEmail`
- **Déclencheur** : Création de commentaire
- **Événement** : Un nouveau commentaire est ajouté
- **Action** : Envoie un email aux profs assignés (sauf l'auteur)
- **Condition** : Si `commentNotifications` est `true` dans les préférences

### 4. `sendDeadlineReminders`
- **Déclencheur** : Chaque jour à 9h (UTC+2 = Paris)
- **Événement** : Tâches avec date limite demain
- **Action** : Envoie un rappel aux profs assignés
- **Condition** : Si `deadlineReminders` est `true` dans les préférences

### 5. `sendTestEmail`
- **Déclencheur** : Appel HTTP depuis l'app
- **Événement** : Utilisateur clique "Envoyer un email de test"
- **Action** : Envoie un email de test à l'utilisateur
- **Nécessite** : Authentification Firebase

## 🧪 Tester

### Test 1 : Email de test
1. Ouvrir l'app
2. Cliquer sur ⚙️ (Préférences de notifications)
3. Cliquer "Envoyer un email de test"
4. Vérifier que l'email arrive à `edt@eps.ovh`

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

### "BREVO_API_KEY not found"
- Vérifier que la variable d'environnement est définie dans Firebase Console
- Redéployer les functions après ajout : `firebase deploy --only functions`

### "Email not verified in Brevo"
- Aller sur **Brevo Console** → **Emails** → **Senders**
- Vérifier que `edt@eps.ovh` est confirmé
- Si nécessaire, ajouter et vérifier l'email

### Pas d'email reçu
- Vérifier les logs dans Firebase Console
- S'assurer que les préférences de notification sont activées
- Vérifier le dossier SPAM/Courrier indésirable

## 📝 Structure Firestore

Les préférences de notification sont stockées dans :

```
users/{userId}/settings/notificationPreferences/
├── taskAssigned: boolean
├── taskStatusChange: boolean
├── commentNotifications: boolean
├── deadlineReminders: boolean
└── updatedAt: timestamp
```

## 🔒 Sécurité

- Les Cloud Functions utilisent l'authentification Firebase
- La clé API Brevo est stockée comme variable d'environnement (jamais visible)
- Les utilisateurs ne peuvent voir que leurs propres préférences
- Les emails sont envoyés de manière sécurisée via HTTPS

## 📞 Support

Pour les problèmes d'email :
- Contacter le support Brevo : https://www.brevo.com/fr/contact/
- Vérifier la documentation : https://developers.brevo.com/

Pour les problèmes Firebase :
- Firebase Console : https://console.firebase.google.com/
- Documentation : https://firebase.google.com/docs/functions
