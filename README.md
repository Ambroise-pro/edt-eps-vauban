# Application Web - Emploi du Temps EPS

Application web avec:
- `Espace public`: consultation de l'emploi du temps par professeur d'EPS.
- `Espace administrateur`: création des professeurs, classes, créneaux EPS/AS, et suivi des heures.

## Fonctionnalités

- Gestion des professeurs d'EPS:
  - Nom
  - Temps de travail max hebdomadaire
  - Contraintes d'indisponibilité (créneaux)
- Gestion des classes de la Sixième à la Terminale
  - Règles automatiques:
  - 6e: `4h` (2 x 2h)
  - 5e/4e/3e: `3h` (2h hebdo + 2h une semaine sur 2)
  - 2nde/1re/Tle: `2h`
- Planification des créneaux:
  - Attribution classe/professeur
  - Type `EPS` ou `AS`
  - Jour, heure de début, durée
  - Cadence `chaque semaine` ou `1 semaine sur 2` avec semaine `A/B`
- Contrôles métier:
  - Détection des conflits professeur
  - Détection des conflits classe
  - Respect des indisponibilités
- Récapitulatif permanent des heures:
  - Passe en rouge si dépassement des heures max professeur
  - Affiche aussi la consommation horaire par classe

## Structure

- `index.html`: interface public/admin
- `styles.css`: styles
- `app.js`: configuration Firebase + logique métier/UI
- `firebase.json`, `.firebaserc`: configuration Firebase Hosting
- `firestore.rules`, `firestore.indexes.json`: Firestore

## Lancer en local

Servez le dossier via un serveur web local (pas en `file://`), par exemple:

```bash
npx serve .
```

ou

```bash
python3 -m http.server 5173
```

Puis ouvrez l'URL locale affichée.

## Déployer sur Firebase

1. Installer Firebase CLI:
```bash
npm install -g firebase-tools
```

2. Login:
```bash
firebase login
```

3. Déployer règles + index + hosting:
```bash
firebase deploy
```

## Important sécurité

Les règles Firestore sont actuellement ouvertes (`allow write: if true`) pour faciliter le démarrage.
Avant mise en production, activez Firebase Authentication et restreignez l'écriture à un rôle administrateur.
