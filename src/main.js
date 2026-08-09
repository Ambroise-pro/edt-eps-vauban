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
