import { ui } from '../dom.js';
import { state } from '../state.js';
import { DAYS, SLOT_BANDS } from '../constants.js';
import { escapeHtml, toSlotKey, formatHours } from '../utils.js';
import { getTeacherBlockStyle, getTeacherDisplayLabel, getClassLabelById } from './common.js';
import { normalizeCadence, weeklyEquivalentHours, hasSwimSlot } from '../rules.js';

export function renderPublic() {
  const allMode = state.selectedPublicTeacherId === "__ALL__";
  const teacher = state.teachers.find((t) => t.id === state.selectedPublicTeacherId);
  if (!allMode && !teacher) {
    ui.publicTeacherSummary.innerHTML = "Aucun professeur disponible.";
    ui.publicTimetableContainer.innerHTML = "";
    return;
  }

  const sessions = allMode ? state.sessions : state.sessions.filter((s) => s.teacherId === teacher.id);
  if (allMode) {
    ui.publicTeacherSummary.innerHTML = `<strong>Vue globale</strong><br>${state.teachers.length} enseignants affichés`;
  } else {
    const used = sessions.reduce((acc, s) => acc + weeklyEquivalentHours(s), 0);
    const max = Number(teacher.maxHours || 0);
    const over = used > max;
    ui.publicTeacherSummary.innerHTML = `
      <strong>${escapeHtml(teacher.name)}</strong><br>
      Heures planifiées (équivalent hebdo): <span class="${over ? "hours-over" : "hours-ok"}">${formatHours(used)}/${formatHours(max)}h</span>
    `;
  }

  const grid = new Map();
  for (const day of DAYS) for (const band of SLOT_BANDS) grid.set(toSlotKey(day, band.start), []);
  
  for (const s of sessions) {
    const prof = state.teachers.find((t) => t.id === s.teacherId);
    const blockStyle = getTeacherBlockStyle(s.teacherId);
    const segments = getSessionBandSegments(s);
    const cadenceTag = normalizeCadence(s.cadence) === "BIWEEKLY" ? ` (${s.weekType})` : "";
    const teacherLabel = getTeacherDisplayLabel(prof);
    const classLabel = getClassLabelById(s.classId);
    const text = allMode ? `${teacherLabel} - ${classLabel}${cadenceTag}` : `${classLabel}${cadenceTag}`;
    
    for (const seg of segments) {
      const isBiweekly = normalizeCadence(s.cadence) === "BIWEEKLY";
      const biClass = isBiweekly ? ` biweekly-half biweekly-${String(s.weekType || 'A').toLowerCase()}` : "";
      const segClass = seg.segment === "full" ? "" : ` band-seg-${seg.segment}`;
      const html = `<div class="slot-block${biClass}${segClass}" style="${escapeHtml(blockStyle)}">${escapeHtml(text)}</div>`;
      grid.get(toSlotKey(seg.day, seg.bandStart))?.push(html);
    }
  }

  const head = `<tr><th>Heure</th>${DAYS.map((d) => `<th>${d}</th>`).join("")}</tr>`;
  const rows = SLOT_BANDS.map((band) => {
    const cells = DAYS.map((day) => {
      const key = toSlotKey(day, band.start);
      const isSwim = hasSwimSlot(day, band.slots[0]) || hasSwimSlot(day, band.slots[1]);
      return `<td class="slot${isSwim ? " slot-swim" : ""}">${(grid.get(key) || []).join("")}</td>`;
    }).join("");
    return `<tr><th>${band.label}</th>${cells}</tr>`;
  }).join("");

  ui.publicTimetableContainer.innerHTML = `<table>${head}${rows}</table>`;
}

// Helper needed by public rendering
function getSessionBandSegments(session) {
  const SLOTS = ["08:00", "09:00", "10:00", "11:00", "12:00", "13:00", "14:00", "15:00", "16:00", "17:00"];
  const startIndex = SLOTS.indexOf(session.start);
  const duration = Number(session.duration || 0);
  const covered = [];
  for (let i = 0; i < duration; i++) {
    covered.push(toSlotKey(session.day, SLOTS[startIndex + i]));
  }

  const segments = [];
  for (const band of SLOT_BANDS) {
    const topKey = toSlotKey(session.day, band.slots[0]);
    const bottomKey = toSlotKey(session.day, band.slots[1]);
    const hasTop = covered.includes(topKey);
    const hasBottom = covered.includes(bottomKey);
    if (!hasTop && !hasBottom) continue;
    const segment = hasTop && hasBottom ? "full" : hasTop ? "top" : "bottom";
    segments.push({ day: session.day, bandStart: band.start, segment });
  }
  return segments;
}
