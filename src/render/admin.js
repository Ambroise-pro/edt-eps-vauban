import { ui } from '../dom.js';
import { state } from '../state.js';
import { escapeHtml, formatHours } from '../utils.js';
import { getTeacherColor, getTeacherDisplayLabel, getClassLabelById } from './common.js';
import { weeklyEquivalentHours, normalizeCadence, normalizeWeekType } from '../rules.js';

export function renderTeacherList() {
  const hoursMap = new Map();
  state.teachers.forEach(t => hoursMap.set(t.id, 0));
  state.sessions.forEach(s => {
    const val = hoursMap.get(s.teacherId) || 0;
    hoursMap.set(s.teacherId, val + weeklyEquivalentHours(s));
  });

  ui.teachersList.innerHTML = state.teachers
    .map((t) => {
      const used = hoursMap.get(t.id) || 0;
      const over = used > Number(t.maxHours || 0);
      const color = getTeacherColor(t);
      return `<li class="data-item">
        <div>
          <span class="teacher-color-dot" style="background:${escapeHtml(color)}"></span>
          <strong>${escapeHtml(t.name)}</strong><br>
          ${formatHours(used)}/${formatHours(t.maxHours)}h <span class="${over ? "hours-over" : "hours-ok"}">${over ? "(dépassement)" : ""}</span>
        </div>
      </li>`;
    })
    .join("");
}

export function renderRecap() {
  if (!ui.adminRecapContainer) return;
  const hoursByTeacher = new Map();
  state.teachers.forEach(t => hoursByTeacher.set(t.id, 0));
  state.sessions.forEach(s => {
    const current = hoursByTeacher.get(s.teacherId) || 0;
    hoursByTeacher.set(s.teacherId, current + weeklyEquivalentHours(s));
  });

  const rows = state.teachers.map((t) => {
    const used = hoursByTeacher.get(t.id) || 0;
    const max = Number(t.maxHours || 0);
    const teacherSessions = state.sessions.filter((s) => s.teacherId === t.id);
    const details = teacherSessions.map((s) => {
      const cadence = normalizeCadence(s.cadence) === "BIWEEKLY" ? ` - Semaine ${normalizeWeekType(s.weekType)}` : "";
      return `${getClassLabelById(s.classId, true)} (${s.day} ${s.start}${cadence})`;
    }).join("<br>");

    return `<tr>
      <td><strong>${escapeHtml(t.name)}</strong></td>
      <td><span class="${used > max ? "hours-over" : "hours-ok"}">${formatHours(used)}/${formatHours(max)}h</span></td>
      <td>${details || "Aucun créneau"}</td>
    </tr>`;
  }).join("");

  ui.adminRecapContainer.innerHTML = `
    <table>
      <tr><th>Professeur</th><th>Heures</th><th>Détails</th></tr>
      ${rows || '<tr><td colspan="3">Aucun professeur</td></tr>'}
    </table>`;
}

export function renderTeacherOptions() {
  const opts = state.teachers.map((t) => `<option value="${t.id}">${escapeHtml(t.name)}</option>`).join("");
  ui.publicTeacherSelect.innerHTML = `<option value="__ALL__">Tous les enseignants</option>${opts}`;
  ui.plannerTeacherSelect.innerHTML = opts;
  ui.desiderataTeacherSelect.innerHTML = opts;
  ui.teacherEditSelect.innerHTML = `<option value="">Nouveau professeur</option>${opts}`;

  // Sync values
  if (state.selectedPublicTeacherId) ui.publicTeacherSelect.value = state.selectedPublicTeacherId;
  const selected = new Set(state.selectedAdminTeacherIds);
  Array.from(ui.plannerTeacherSelect.options).forEach((opt) => {
    opt.selected = selected.has(opt.value);
  });
}

export function syncAdminTeacherSelection() {
  const validIds = new Set(state.teachers.map((t) => t.id));
  state.selectedAdminTeacherIds = state.selectedAdminTeacherIds.filter((id) => validIds.has(id));
  if (!state.selectedAdminTeacherIds.length && state.teachers.length) {
    state.selectedAdminTeacherIds = [state.teachers[0].id];
  }
}

export function setAdminTab(tab) {
  state.selectedAdminTab = tab;
  const tabs = ["creation", "assign", "program", "bus", "manage", "swim", "recap", "repartition"];
  tabs.forEach(t => {
    const panel = ui[`admin${t.charAt(0).toUpperCase() + t.slice(1)}Panel`];
    const btn = ui[`adminTab${t.charAt(0).toUpperCase() + t.slice(1)}Btn`];
    if (panel) panel.classList.toggle("hidden", t !== tab);
    if (btn) btn.classList.toggle("active", t === tab);
  });
}
