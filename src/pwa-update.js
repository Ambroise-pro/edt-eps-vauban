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

    navigator.serviceWorker.ready.then((registration) => {
      // Vérifier s'il y a une mise à jour en attente
      if (registration.waiting) {
        showUpdateButton(registration.waiting);
        waitingServiceWorker = registration.waiting;
      }

      // Écouter les nouvelles mises à jour
      registration.addEventListener('updatefound', () => {
        const newWorker = registration.installing;
        newWorker.addEventListener('statechange', () => {
          if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
            // Une nouvelle version est prête (il y a déjà une version active)
            showUpdateButton(newWorker);
            waitingServiceWorker = newWorker;
          }
        });
      });
    });
  }

  function showUpdateButton(worker) {
    updateBtn.classList.remove('hidden');

    updateBtn.addEventListener('click', () => {
      // Envoyer un message au service worker pour qu'il se mette à jour
      worker.postMessage({ type: 'SKIP_WAITING' });

      // Le controllerchange event se déclenchera et reloadera la page
      updateBtn.textContent = '⏳ Actualisation...';
      updateBtn.disabled = true;
    });
  }
}
