/**
 * Gère les mises à jour PWA et affiche un bouton de refresh
 */

export function initPWAUpdateHandler() {
  const updateBtn = document.getElementById('pwaSWUpdateBtn');
  if (!updateBtn) return;

  let waitingServiceWorker = null;

  // Écouter les mises à jour du service worker
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (waitingServiceWorker) {
        console.log('🔄 PWA mise à jour appliquée');
        // La nouvelle version est active
        window.location.reload();
      }
    });

    // Ajouter le click listener une seule fois
    updateBtn.addEventListener('click', () => {
      if (waitingServiceWorker) {
        // Envoyer un message au service worker pour qu'il se mette à jour
        waitingServiceWorker.postMessage({ type: 'SKIP_WAITING' });

        // Le controllerchange event se déclenchera et reloadera la page
        updateBtn.innerHTML = '<span class="material-symbols-outlined">refresh</span><span>⏳ Actualisation...</span>';
        updateBtn.disabled = true;
      }
    });

    navigator.serviceWorker.ready.then((registration) => {
      // Vérifier s'il y a une mise à jour en attente
      if (registration.waiting) {
        console.log('📦 Mise à jour en attente détectée');
        waitingServiceWorker = registration.waiting;
        updateBtn.classList.remove('hidden');
      }

      // Écouter les nouvelles mises à jour
      registration.addEventListener('updatefound', () => {
        const newWorker = registration.installing;
        newWorker.addEventListener('statechange', () => {
          if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
            // Une nouvelle version est prête (il y a déjà une version active)
            console.log('✨ Nouvelle mise à jour détectée');
            waitingServiceWorker = newWorker;
            updateBtn.classList.remove('hidden');
          }
        });
      });
    });
  }
}
