import { ui } from '../dom.js';
import { state } from '../state.js';
import { DAYS } from '../constants.js';
import { escapeHtml } from '../utils.js';
import { getTeacherDisplayLabel, getClassLabelById } from './common.js';
import { normalizeCadence, normalizeWeekType } from '../rules.js';
import { updateDoc, doc, db, serverTimestamp } from '../firebase.js';

export function renderBusPanel() {
  if (!ui.busPlannerContainer || !ui.busHint) return;
  
  const dayBlocks = DAYS.map((day) => {
    const sessions = state.sessions
      .filter((s) => s.day === day)
      .sort((a, b) => String(a.start || "").localeCompare(String(b.start || ""), "fr"));
      
    if (!sessions.length) {
      return `<div class="card bus-day-card"><h4>${escapeHtml(day)}</h4><p class="slot-picker-empty">Aucune activité.</p></div>`;
    }

    const rows = sessions.map((s) => {
      const teacher = state.teachers.find((t) => t.id === s.teacherId);
      const classLabel = getClassLabelById(s.classId);
      const activityLabel = s.activityLabel || s.type || "Activité";
      const needsBus = Boolean(s.busRequired);
      
      return `<tr>
        <td>${escapeHtml(s.start)}</td>
        <td>${escapeHtml(getTeacherDisplayLabel(teacher))}</td>
        <td>${escapeHtml(classLabel)}</td>
        <td>${escapeHtml(activityLabel)}</td>
        <td><input type="checkbox" data-bus-required="${s.id}" ${needsBus ? "checked" : ""} /></td>
        <td><input type="time" data-bus-outbound-time="${s.id}" value="${s.busOutboundTime || ""}" /></td>
        <td><input type="time" data-bus-return-time="${s.id}" value="${s.busReturnTime || ""}" /></td>
        <td><button class="secondary-btn save-bus-btn" data-bus-save="${s.id}" type="button">OK</button></td>
      </tr>`;
    }).join("");

    return `
      <div class="card bus-day-card">
        <h4>${escapeHtml(day)}</h4>
        <div class="table-wrap">
          <table class="bus-table">
            <tr><th>Créneau</th><th>Prof</th><th>Classe</th><th>Activité</th><th>Bus</th><th>Aller</th><th>Retour</th><th>Action</th></tr>
            ${rows}
          </table>
        </div>
      </div>`;
  }).join("");

  ui.busPlannerContainer.innerHTML = dayBlocks;
  bindBusActions();
}

function bindBusActions() {
  ui.busPlannerContainer.querySelectorAll(".save-bus-btn").forEach(btn => {
    btn.addEventListener("click", async () => {
      const id = btn.dataset.busSave;
      const payload = {
        busRequired: ui.busPlannerContainer.querySelector(`[data-bus-required="${id}"]`).checked,
        busOutboundTime: ui.busPlannerContainer.querySelector(`[data-bus-outbound-time="${id}"]`).value,
        busReturnTime: ui.busPlannerContainer.querySelector(`[data-bus-return-time="${id}"]`).value,
        updatedAt: serverTimestamp()
      };
      await updateDoc(doc(db, "sessions", id), payload);
    });
  });
}
