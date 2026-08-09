// PWA Update Notification System
function showUpdateNotification() {
  // Créer le container de notification
  let updateContainer = document.getElementById('pwaUpdateNotification');
  if (!updateContainer) {
    updateContainer = document.createElement('div');
    updateContainer.id = 'pwaUpdateNotification';
    updateContainer.style.cssText = `
      position: fixed;
      bottom: 20px;
      left: 20px;
      right: 20px;
      max-width: 500px;
      padding: 16px;
      background: linear-gradient(135deg, #002b5b 0%, #004a8f 100%);
      color: white;
      border-radius: 12px;
      box-shadow: 0 8px 24px rgba(0, 0, 0, 0.25);
      z-index: 10000;
      display: flex;
      align-items: center;
      gap: 12px;
      font-family: inherit;
      animation: slideUp 0.3s ease-out;
    `;

    const style = document.createElement('style');
    style.textContent = `
      @keyframes slideUp {
        from {
          transform: translateY(100px);
          opacity: 0;
        }
        to {
          transform: translateY(0);
          opacity: 1;
        }
      }
      #pwaUpdateNotification button {
        padding: 8px 16px;
        background: white;
        color: #002b5b;
        border: none;
        border-radius: 6px;
        font-weight: 600;
        cursor: pointer;
        transition: all 0.2s ease;
        white-space: nowrap;
        flex-shrink: 0;
      }
      #pwaUpdateNotification button:hover {
        background: #f0f0f0;
        transform: translateY(-2px);
        box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
      }
      #pwaUpdateNotification button:active {
        transform: translateY(0);
      }
      #pwaUpdateText {
        flex-grow: 1;
      }
    `;
    document.head.appendChild(style);
    document.body.appendChild(updateContainer);
  }

  updateContainer.innerHTML = `
    <span id="pwaUpdateText">📦 Une nouvelle version est disponible</span>
    <button id="pwaReloadBtn">Actualiser</button>
  `;

  document.getElementById('pwaReloadBtn').addEventListener('click', () => {
    window.location.reload();
  });
}

// Register Service Worker for PWA
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').then(registration => {
    // Vérifier les mises à jour toutes les heures
    setInterval(() => {
      registration.update();
    }, 60 * 60 * 1000);

    // Écouter les mises à jour disponibles
    registration.addEventListener('updatefound', () => {
      const newWorker = registration.installing;

      newWorker.addEventListener('statechange', () => {
        if (newWorker.state === 'activated' && navigator.serviceWorker.controller) {
          // Une nouvelle version a été activée
          showUpdateNotification();
        }
      });
    });
  }).catch(err => {
    console.log('SW registration failed:', err);
  });

  // Écouter aussi les messages du service worker
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    // Vérifier si une nouvelle version est prête
    if (navigator.serviceWorker.controller) {
      showUpdateNotification();
    }
  });
}

// Install PWA - Show native install prompt
let deferredPrompt = null;
let pwaInstallShown = false;

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredPrompt = e;
  console.log('PWA install prompt available');

  // Afficher la notification après 3 secondes
  if (!pwaInstallShown) {
    setTimeout(() => {
      showInstallPrompt();
    }, 3000);
  }
});

function showInstallPrompt() {
  if (deferredPrompt && !pwaInstallShown) {
    pwaInstallShown = true;

    // Créer la notification d'installation
    let installContainer = document.getElementById('pwaInstallNotification');
    if (!installContainer) {
      installContainer = document.createElement('div');
      installContainer.id = 'pwaInstallNotification';
      installContainer.style.cssText = `
        position: fixed;
        bottom: 20px;
        left: 20px;
        right: 20px;
        max-width: 500px;
        padding: 16px;
        background: linear-gradient(135deg, #006b5f 0%, #009978 100%);
        color: white;
        border-radius: 12px;
        box-shadow: 0 8px 24px rgba(0, 0, 0, 0.25);
        z-index: 9999;
        display: flex;
        align-items: center;
        gap: 12px;
        font-family: inherit;
        animation: slideUp 0.3s ease-out;
      `;

      const style = document.createElement('style');
      style.textContent = `
        @keyframes slideUp {
          from {
            transform: translateY(100px);
            opacity: 0;
          }
          to {
            transform: translateY(0);
            opacity: 1;
          }
        }
        #pwaInstallNotification button {
          padding: 8px 16px;
          background: white;
          color: #006b5f;
          border: none;
          border-radius: 6px;
          font-weight: 600;
          cursor: pointer;
          transition: all 0.2s ease;
          white-space: nowrap;
          flex-shrink: 0;
        }
        #pwaInstallNotification button:hover {
          background: #f0f0f0;
          transform: translateY(-2px);
          box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
        }
        #pwaInstallNotification button:active {
          transform: translateY(0);
        }
        #pwaInstallText {
          flex-grow: 1;
        }
        #pwaInstallClose {
          background: rgba(255, 255, 255, 0.2) !important;
          color: white !important;
          padding: 6px 12px !important;
          font-size: 1.2em;
          line-height: 1;
        }
      `;
      if (!document.head.querySelector('style[data-pwa-install]')) {
        style.setAttribute('data-pwa-install', 'true');
        document.head.appendChild(style);
      }
      document.body.appendChild(installContainer);
    }

    installContainer.innerHTML = `
      <span id="pwaInstallText">📱 Installer l'app pour un accès rapide</span>
      <button id="pwaInstallInstallBtn">Installer</button>
      <button id="pwaInstallClose">✕</button>
    `;

    document.getElementById('pwaInstallInstallBtn').addEventListener('click', async () => {
      if (deferredPrompt) {
        deferredPrompt.prompt();
        const { outcome } = await deferredPrompt.userChoice;
        console.log(`User choice: ${outcome}`);
        deferredPrompt = null;
        installContainer.remove();
      }
    });

    document.getElementById('pwaInstallClose').addEventListener('click', () => {
      installContainer.remove();
    });
  }
}

// Afficher le prompt si déjà disponible (page rechargée)
if (deferredPrompt) {
  showInstallPrompt();
}

window.addEventListener('appinstalled', () => {
  console.log('App installed successfully');
  deferredPrompt = null;
  pwaInstallShown = false;
  const installContainer = document.getElementById('pwaInstallNotification');
  if (installContainer) {
    installContainer.remove();
  }
});

import { ui } from './dom.js';
import { state } from './state.js';
import { subscribeData } from './db.js';
import { renderPublic } from './render/public.js';
import { renderPlannerGrid } from './render/planner.js';
import { renderTeacherList, renderTeacherOptions, syncAdminTeacherSelection, setAdminTab, renderRecap } from './render/admin.js';
import { renderProgrammingPanel } from './render/program.js';
import { renderBusPanel } from './render/bus.js';
import { renderSwimPlanner } from './render/swim.js';

function init() {
  setupModeSwitch();
  setupAdminTabs();
  setupPlannerListeners();
  setupProgramListeners();
  
  subscribeData(() => {
    syncAdminTeacherSelection();
    render();
  });
}

function setupModeSwitch() {
  ui.publicModeBtn.addEventListener("click", () => setMode("public"));
  ui.adminModeBtn.addEventListener("click", () => setMode("admin"));
  ui.desiderataModeBtn.addEventListener("click", () => setMode("desiderata"));
}

function setupAdminTabs() {
  const tabs = ["creation", "assign", "program", "bus", "manage", "swim", "recap", "repartition"];
  tabs.forEach(t => {
    const btn = ui[`adminTab${t.charAt(0).toUpperCase() + t.slice(1)}Btn`];
    if (btn) btn.addEventListener("click", () => setAdminTab(t));
  });
}

function setupPlannerListeners() {
  ui.plannerTeacherSelect.addEventListener("change", () => {
    state.selectedAdminTeacherIds = Array.from(ui.plannerTeacherSelect.selectedOptions).map(o => o.value);
    render();
  });
}

function setupProgramListeners() {
  if (ui.programWeekType) {
    ui.programWeekType.addEventListener("change", () => {
      state.selectedProgramWeekType = ui.programWeekType.value;
      renderProgrammingPanel();
    });
  }
  if (ui.programDaySelect) {
    ui.programDaySelect.addEventListener("change", () => {
      state.selectedProgramDay = ui.programDaySelect.value;
      renderProgrammingPanel();
    });
  }
}

function setMode(mode) {
  const isPublic = mode === "public";
  const isDesiderata = mode === "desiderata";
  ui.publicSection.classList.toggle("hidden", !isPublic);
  ui.desiderataSection.classList.toggle("hidden", !isDesiderata);
  ui.adminSection.classList.toggle("hidden", isPublic || isDesiderata);
  ui.publicModeBtn.classList.toggle("active", isPublic);
  ui.desiderataModeBtn.classList.toggle("active", isDesiderata);
  ui.adminModeBtn.classList.toggle("active", !isPublic && !isDesiderata);
}

function render() {
  renderTeacherOptions();
  renderPublic();
  renderTeacherList();
  renderPlannerGrid();
  renderProgrammingPanel();
  renderBusPanel();
  renderSwimPlanner();
  renderRecap();
}

init();
