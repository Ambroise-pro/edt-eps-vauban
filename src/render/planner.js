import { ui } from '../dom.js';
import { state } from '../state.js';
import { DAYS, SLOT_BANDS } from '../constants.js';
import { escapeHtml, toSlotKey, formatHours } from '../utils.js';
import { getTeacherBlockStyle, getClassLabelById, getTeacherDisplayLabel } from './common.js';
import { normalizeCadence, normalizeWeekType, getCoveredSlots, weeklyEquivalentHours, getSessionBandSegments } from '../rules.js';

export function renderSessionBlockHtml({ sessionId, text, style, className, cadence, weekType }) {
  const biClass = normalizeCadence(cadence) === "BIWEEKLY" ? ` biweekly-half biweekly-${normalizeWeekType(weekType).toLowerCase()}` : "";
  return `
    <div class="${className}${biClass}" style="${escapeHtml(style)}">
      <div class="session-block-row">
        <span>${escapeHtml(text)}</span>
        <button class="session-remove-btn" data-session-id="${escapeHtml(sessionId)}" type="button" title="Désaffecter">x</button>
      </div>
    </div>
  `;
}

export function renderPlannerGrid() {
  const teacherCards = state.selectedAdminTeacherIds.map((id) => {
    const t = state.teachers.find((x) => x.id === id);
    if (!t) return "";
    return `
      <div class="card">
        <h3>Affectation rapide (${escapeHtml(t.name)})</h3>
        <p id="adminPlannerHint-${escapeHtml(id)}" class="summary-box"></p>
        <div id="adminPlannerContainer-${escapeHtml(id)}" class="table-wrap"></div>
      </div>
    `;
  }).join("");

  const globalCard = state.showGlobalPlanner ? `
    <div class="card">
      <h3>Planning général</h3>
      <p id="globalPlannerHint" class="summary-box"></p>
      <div id="globalPlannerContainer" class="table-wrap"></div>
    </div>
  ` : "";

  // Dynamic grid calculation: 2 rows layout (2x2, 3x2, 4x2...)
  const count = state.selectedAdminTeacherIds.length + (state.showGlobalPlanner ? 1 : 0);
  const cols = count <= 1 ? 1 : count <= 4 ? 2 : Math.ceil(count / 2);
  ui.plannerGrid.style.setProperty('--grid-cols', cols);
  ui.plannerGrid.classList.toggle('compact', count > 2);

  ui.plannerGrid.innerHTML = teacherCards + globalCard || `<div class="card"><p>Aucun affichage sélectionné.</p></div>`;

  state.selectedAdminTeacherIds.forEach(id => {
    const container = document.getElementById(`adminPlannerContainer-${id}`);
    const hint = document.getElementById(`adminPlannerHint-${id}`);
    if (container) renderAdminPlanner(id, container, hint);
  });

  if (state.showGlobalPlanner) {
    const container = document.getElementById("globalPlannerContainer");
    const hint = document.getElementById("globalPlannerHint");
    if (container) renderGlobalPlanner(container, hint);
  }
}

function renderAdminPlanner(teacherId, container, hint) {
  const teacher = state.teachers.find(t => t.id === teacherId);
  if (!teacher) return;

  const sessions = state.sessions.filter(s => s.teacherId === teacherId);
  const usedHours = sessions.reduce((acc, s) => acc + weeklyEquivalentHours(s), 0);
  const maxHours = Number(teacher.maxHours || 0);
  
  if (hint) {
    hint.innerHTML = `Heures: <span class="${usedHours > maxHours ? "hours-over" : "hours-ok"}">${formatHours(usedHours)}/${formatHours(maxHours)}h</span>`;
  }

  const grid = new Map();
  for (const day of DAYS) for (const band of SLOT_BANDS) grid.set(toSlotKey(day, band.start), []);
  
  for (const s of sessions) {
    const blockStyle = getTeacherBlockStyle(s.teacherId);
    const segments = getSessionBandSegments(s);
    const cadenceTag = normalizeCadence(s.cadence) === "BIWEEKLY" ? ` (${s.weekType})` : "";
    const text = `${getClassLabelById(s.classId)}${cadenceTag}`;
    
    for (const seg of segments) {
      grid.get(toSlotKey(seg.day, seg.bandStart))?.push(
        renderSessionBlockHtml({
          sessionId: s.id,
          text,
          style: blockStyle,
          className: `slot-block band-seg-${seg.segment}`,
          cadence: s.cadence,
          weekType: s.weekType
        })
      );
    }
  }

  const head = `<tr><th>Heure</th>${DAYS.map(d => `<th>${d}</th>`).join("")}</tr>`;
  const rows = SLOT_BANDS.map(band => {
    const cells = DAYS.map(day => {
      const key = toSlotKey(day, band.start);
      const blocks = grid.get(key) || [];
      return `<td class="slot">${blocks.join("")}<button class="slot-action" data-day="${day}" data-slot="${band.start}">+</button></td>`;
    }).join("");
    return `<tr><th>${band.label}</th>${cells}</tr>`;
  }).join("");

  container.innerHTML = `<table>${head}${rows}</table>`;
}

function renderGlobalPlanner(container, hint) {
  const grid = new Map();
  for (const day of DAYS) for (const band of SLOT_BANDS) grid.set(toSlotKey(day, band.start), []);

  for (const s of state.sessions) {
    const teacher = state.teachers.find((t) => t.id === s.teacherId);
    const blockStyle = getTeacherBlockStyle(s.teacherId);
    const segments = getSessionBandSegments(s);
    const cadenceTag = normalizeCadence(s.cadence) === "BIWEEKLY" ? ` (${normalizeWeekType(s.weekType)})` : "";
    const label = `${getTeacherDisplayLabel(teacher)} - ${getClassLabelById(s.classId)}${cadenceTag}`;
    for (const seg of segments) {
      grid.get(toSlotKey(seg.day, seg.bandStart))?.push({
        sessionId: s.id,
        teacherId: s.teacherId,
        classId: s.classId,
        label,
        blockStyle,
        cadence: s.cadence,
        weekType: s.weekType,
        segment: seg.segment,
      });
    }
  }

  const head = `<tr><th>Heure</th>${DAYS.map((d) => `<th>${d}</th>`).join("")}</tr>`;
  const rows = SLOT_BANDS.map((band) => {
    const cells = DAYS.map((day) => {
      const key = toSlotKey(day, band.start);
      const entries = grid.get(key) || [];
      
      const blocks = entries.map((e) => {
        return renderSessionBlockHtml({
          sessionId: e.sessionId,
          text: e.label,
          style: e.blockStyle,
          className: `slot-block band-seg-${e.segment}`,
          cadence: e.cadence,
          weekType: e.weekType,
        });
      }).join("");

      return `<td class="slot">${blocks}<button class="slot-action global-slot-action" data-day="${escapeHtml(day)}" data-slot="${escapeHtml(band.start)}" type="button">+</button></td>`;
    }).join("");
    return `<tr><th>${band.label}</th>${cells}</tr>`;
  }).join("");

  container.innerHTML = `<table>${head}${rows}</table>`;
}
