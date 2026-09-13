// Enregistre le service worker et recharge automatiquement la page dès qu'une nouvelle
// version est déployée, sans action de l'utilisateur (registerType: 'autoUpdate' dans
// vite.config.js). Remplace l'ancien bouton "Actualiser" manuel, qui dépendait d'une
// détection de mise à jour maison peu fiable.
import { registerSW } from 'virtual:pwa-register';

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
