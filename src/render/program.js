import { ui } from '../dom.js';
import { state } from '../state.js';
import { DAYS, SLOT_BANDS } from '../constants.js';
import { escapeHtml, toSlotKey } from '../utils.js';
import { getTeacherDisplayLabel, getClassLabelById } from './common.js';
import { normalizeWeekType, getSessionBandSegments } from '../rules.js';

export function renderProgrammingPanel() {
  if (!ui.programPlannerContainer) return;

  const weekType = normalizeWeekType(state.selectedProgramWeekType);
  const selectedDay = DAYS.includes(state.selectedProgramDay) ? state.selectedProgramDay : "Lundi";

  const daySessions = state.sessions.filter(s => s.day === selectedDay);
  
  // Basic rendering of programming grid
  const dayTeacherIds = Array.from(new Set(daySessions.map(s => s.teacherId).filter(Boolean)));
  const dayTeachers = dayTeacherIds
    .map(id => state.teachers.find(t => t.id === id))
    .filter(Boolean)
    .sort((a, b) => String(a.name || "").localeCompare(String(b.name || ""), "fr"));

  const rows = SLOT_BANDS.map(band => {
    const teacherCells = dayTeachers.map(teacher => {
      const cellSessions = daySessions
        .filter(s => s.teacherId === teacher.id)
        .map(s => {
          const segs = getSessionBandSegments(s);
          const seg = segs.find(x => x.day === selectedDay && x.bandStart === band.start);
          return seg ? { session: s, segment: seg.segment } : null;
        }).filter(Boolean);

      const html = cellSessions.map(({ session, segment }) => {
        return `
          <div class="program-session-row band-seg-${segment}">
            <div>${escapeHtml(getClassLabelById(session.classId))} - ${escapeHtml(getTeacherDisplayLabel(teacher))}</div>
            <div>${escapeHtml(session.activityLabel || '---')} / ${escapeHtml(session.locationName || '---')}</div>
          </div>
        `;
      }).join("");

      return `<td class="slot">${html || '<span class="slot-picker-empty">Libre</span>'}</td>`;
    }).join("");

    return `<tr><th>${band.label}</th>${teacherCells}</tr>`;
  }).join("");

  const head = `<tr><th>Heure</th>${dayTeachers.map(t => `<th>${escapeHtml(getTeacherDisplayLabel(t))}</th>`).join("")}</tr>`;
  ui.programPlannerContainer.innerHTML = `<table>${head}${rows}</table>`;
}
