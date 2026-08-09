# 📧 Guide - Système de Notifications par Email

## 🎯 Vue d'ensemble

Le système de notifications envoie des emails automatiques quand :
- Une tâche vous est assignée
- Le statut d'une tâche change
- Quelqu'un commente une tâche
- Une tâche est due demain (rappel)

## ⚙️ Configurer vos préférences

### Accéder aux préférences

1. **Dans l'app EDT**
2. Cliquer sur le **menu utilisateur** (coin supérieur droit)
3. Cliquer sur **⚙️ Préférences de notifications**

### Configurer les notifications

Une modale s'ouvre avec 4 cases à cocher :

- **☑️ Nouvelle tâche assignée**
  - Recevez un email quand une tâche vous est assignée
  - Défaut : ✅ Activé

- **☑️ Changement de statut**
  - Recevez un email quand le statut change
  - Défaut : ✅ Activé

- **☑️ Nouveaux commentaires**
  - Recevez un email quand quelqu'un commente
  - Défaut : ✅ Activé

- **☑️ Rappels de date limite**
  - Recevez un email si une tâche est due demain
  - Défaut : ✅ Activé

### Sauvegarder

Après modification, cliquer **"Sauvegarder"** pour valider les changements.

## 🧪 Tester vos emails

### Envoyer un email de test

1. Ouvrir **Préférences de notifications**
2. Cliquer **"Envoyer un email de test"**
3. Un email devrait arriver en quelques secondes

### Vérifier la réception

- Vérifier votre **boîte de réception**
- Si absent, vérifier le **dossier SPAM** (Courrier indésirable)
- Assurer que l'email est bien activé dans **Brevo**

## 📨 Types d'emails

### Email : Nouvelle tâche assignée

```
De : EDT EPS <edt@eps.ovh>
Objet : 🎯 Nouvelle tâche : [Titre]

Corps :
- Titre de la tâche
- Description
- Priorité
- Catégorie
- Date limite
- Lien direct vers la tâche
```

### Email : Changement de statut

```
Objet : 📊 Mise à jour tâche : [Titre]

Corps :
- Notification du changement
- Ancien statut → Nouveau statut
```

### Email : Nouveau commentaire

```
Objet : 💬 Nouveau commentaire sur [Titre]

Corps :
- Qui a commenté
- Texte du commentaire
- Lien vers la tâche
```

### Email : Rappel date limite

```
Objet : ⏰ Rappel : [Titre] due demain

Corps :
- Simple rappel que la tâche est due demain
```

## 🔔 Fréquence des emails

| Événement | Fréquence |
|-----------|-----------|
| Tâche assignée | Immédiat |
| Statut change | Immédiat |
| Nouveau commentaire | Immédiat |
| Rappel date limite | Une fois par jour (9h) |

## ⚡ Cas spéciaux

### Je suis l'auteur du commentaire
- Vous **ne recevez PAS** d'email pour vos propres commentaires

### J'ai désactivé les notifications
- Aucun email pour ce type d'événement
- Vous recevrez toujours les emails des autres types

### Je change les préférences après une tâche assignée
- L'email précédent est déjà parti
- Les nouveaux événements respectent les nouvelles préférences

## 💡 Conseils d'utilisation

### Réduire les emails
- Désactiver les notifications que vous ne souhaitez pas
- Les emails les plus importants sont "Tâche assignée" et "Rappels"

### Ne pas oublier les tâches
- Garder "Rappels de date limite" activé
- Vous recevrez un email si une tâche est due demain

### Participer aux commentaires
- Garder "Nouveaux commentaires" activé
- Sachez quand un collègue commente une tâche

## 🆘 Dépannage

### Je ne reçois pas les emails

**Étape 1 : Vérifier les préférences**
- Ouvrir **Préférences de notifications**
- S'assurer que les bonnes cases sont cochées
- Cliquer **"Sauvegarder"**

**Étape 2 : Vérifier le dossier SPAM**
- Regarder dans le **dossier SPAM** de votre email
- Marquer l'email comme **"Pas du spam"** pour que les prochains arrivent dans la boîte

**Étape 3 : Envoyer un test**
- Cliquer **"Envoyer un email de test"**
- Si l'email de test n'arrive pas, contacter l'administrateur

### L'email a une mauvaise adresse
- L'adresse email utilisée est celle de votre **compte Firebase**
- Pour changer, modifier votre profil dans **Firebase Console**

### Trop d'emails reçus
- Désactiver les notifications que vous ne souhaitez pas
- Les configurer selon vos préférences personnelles

## 📱 Que faire avec les emails reçus

### Email de tâche assignée
1. Lire la description
2. Cliquer le lien **"Voir la tâche"**
3. Ajouter des commentaires ou changer le statut

### Email de commentaire
1. Lire le commentaire
2. Répondre directement dans l'app
3. Continuer la discussion

### Email de rappel
1. Vérifier la date limite
2. Commencer le travail ou ajouter une étape
3. Changer le statut quand c'est fait

## ✅ Résumé de configuration

Pour une expérience optimale :

1. **Ouvrir** Préférences de notifications
2. **Vérifier** les 4 cases (par défaut tout est activé)
3. **Tester** avec "Envoyer un email de test"
4. **Sauvegarder** les préférences
5. **Profiter** des notifications automatiques ! 🎉

---

**Besoin d'aide ?** Contactez l'administrateur EDT.
