// Enregistre le service worker et recharge automatiquement la page dès qu'une nouvelle
// version est déployée, sans action de l'utilisateur (registerType: 'autoUpdate' dans
// vite.config.js). Remplace l'ancien bouton "Actualiser" manuel, qui dépendait d'une
// détection de mise à jour maison peu fiable.
import { registerSW } from 'virtual:pwa-register';

// "controllerchange" se déclenche aussi lors de la toute première installation (pas de
// contrôleur avant) : on ne marque une VRAIE mise à jour que si un service worker
// contrôlait déjà la page avant ce changement, sinon le premier visiteur verrait un
// toast "mise à jour appliquée" qui n'a pas de sens pour lui.
if ('serviceWorker' in navigator) {
  const hadControllerAtLoad = Boolean(navigator.serviceWorker.controller);
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadControllerAtLoad) return;
    try {
      sessionStorage.setItem('pwaJustUpdated', '1');
    } catch {
      // sessionStorage indisponible (navigation privée stricte, etc.) : tant pis pour le
      // toast, la mise à jour s'applique quand même.
    }
  });
}

const updateSW = registerSW({
  immediate: true,
  onRegisteredSW(_swUrl, registration) {
    if (!registration) return;
    // Les service workers ne sont revérifiés par le navigateur qu'à la navigation (ou
    // ~24h) : un onglet resté ouvert longtemps ne verrait sinon jamais la mise à jour.
    setInterval(() => {
      registration.update().catch(() => {});
    }, 60 * 60 * 1000);
  },
});

export { updateSW };
