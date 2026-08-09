import { state } from './state.js';
import { SLOTS, SLOT_BANDS, LEVEL_RULES, SPECIAL_ASSIGNMENTS, DAYS } from './constants.js';
import { toSlotKey } from './utils.js';

export function getCoveredSlots(day, start, duration) {
  const startIndex = SLOTS.indexOf(start);
  if (startIndex < 0) return [];
  const covered = [];
  for (let i = 0; i < duration; i += 1) {
    const slot = SLOTS[startIndex + i];
    if (!slot) return [];
    covered.push(toSlotKey(day, slot));
  }
  return covered;
}

export function slotsOverlap(a, b) {
  const setB = new Set(b);
  return a.some((x) => setB.has(x));
}

export function normalizeCadence(cadence) {
  return cadence === "BIWEEKLY" ? "BIWEEKLY" : "WEEKLY";
}

export function normalizeWeekType(weekType) {
  return weekType === "B" ? "B" : "A";
}

export function sessionsConflict(a, b) {
  const aSlots = getCoveredSlots(a.day, a.start, Number(a.duration || 0));
  const bSlots = getCoveredSlots(b.day, b.start, Number(b.duration || 0));
  if (!slotsOverlap(aSlots, bSlots)) return false;

  const aCadence = normalizeCadence(a.cadence);
  const bCadence = normalizeCadence(b.cadence);
  if (aCadence === "WEEKLY" || bCadence === "WEEKLY") return true;
  return normalizeWeekType(a.weekType) === normalizeWeekType(b.weekType);
}

export function sessionsCanOccurSameWeek(a, b) {
  const aCadence = normalizeCadence(a?.cadence);
  const bCadence = normalizeCadence(b?.cadence);
  if (aCadence === "WEEKLY" || bCadence === "WEEKLY") return true;
  return normalizeWeekType(a?.weekType) === normalizeWeekType(b?.weekType);
}

export function toWeekStartHour(day, start) {
  const dayIndex = Math.max(0, DAYS.indexOf(day));
  const [hStr, mStr] = String(start || "00:00").split(":");
  const hour = Number(hStr || 0);
  const minute = Number(mStr || 0);
  return dayIndex * 24 + hour + minute / 60;
}

export function getLevelRule(level) {
  return LEVEL_RULES[level] || null;
}

export function isSpecialAssignmentId(id) {
  return SPECIAL_ASSIGNMENTS.some(x => x.id === id);
}

export function isASLike(entry) {
  if (!entry) return false;
  return String(entry.type || "").toUpperCase() === "AS" || String(entry.classId || "") === "__AS__";
}

export function getSessionBandSegments(session) {
  const covered = getCoveredSlots(session.day, session.start, Number(session.duration || 0));
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

export function weeklyEquivalentHours(session) {
  const duration = Number(session?.duration || 0);
  return normalizeCadence(session?.cadence) === "BIWEEKLY" ? duration / 2 : duration;
}

export function hasSwimSlot(day, slot) {
  return state.swimSlotKeys.has(`${day}|${slot}`);
}

export function validateSession(payload) {
  const { teacherId, classId, type, day, start, duration } = payload;
  const cadence = normalizeCadence(payload.cadence);
  const weekType = normalizeWeekType(payload.weekType);

  if (!teacherId || !classId || !type || !day || !start || !duration) {
    return { ok: false, error: "Informations incomplètes pour créer le créneau." };
  }

  const teacher = state.teachers.find((t) => t.id === teacherId);
  const cls = state.classes.find((c) => c.id === classId);
  const special = SPECIAL_ASSIGNMENTS.find((x) => x.id === classId);

  if (!teacher) return { ok: false, error: "Professeur introuvable." };
  if (!cls && !special) return { ok: false, error: "Classe introuvable." };

  const plannedSlots = getCoveredSlots(day, start, Number(duration));
  if (!plannedSlots.length) return { ok: false, error: "Créneau invalide (fin de journée dépassée)." };

  if (type === "EPS" && cls) {
    const rule = getLevelRule(cls.level);
    if (rule?.group === "CINQUIEME") {
      if (Number(duration) !== 3) return { ok: false, error: "Règle EPS 5e: une séance doit durer 3h." };
      if (cadence !== "WEEKLY") return { ok: false, error: "Règle EPS 5e: la planification se fait toutes les semaines." };
    } else {
      if (Number(duration) !== 2) return { ok: false, error: "Règle EPS: une séance EPS doit durer 2h." };
    }
    if ((rule?.group === "SIXIEME" || rule?.group === "LYCEE") && cadence !== "WEEKLY") {
      return { ok: false, error: "Règle EPS: ce niveau doit être planifié chaque semaine." };
    }
    if (rule?.group !== "ALT_43" && cadence === "BIWEEKLY") {
      return { ok: false, error: "Les créneaux Semaine A/B sont autorisés uniquement pour les classes de 4e et 3e." };
    }
  }

  const candidate = { day, start, duration: Number(duration), cadence, weekType };
  const isUnavailable = plannedSlots.some((slotKey) => (teacher.unavailable || []).includes(slotKey));
  if (isUnavailable) return { ok: false, error: "Conflit: professeur indisponible sur ce créneau." };

  const teacherConflict = state.sessions.some((s) => s.teacherId === teacherId && sessionsConflict(candidate, s));
  if (teacherConflict) return { ok: false, error: "Conflit: ce professeur a déjà un cours sur ce créneau." };

  if (!special) {
    const classConflict = state.sessions.some((s) => s.classId === classId && sessionsConflict(candidate, s));
    if (classConflict) return { ok: false, error: "Conflit: cette classe est déjà occupée sur ce créneau." };
  }

  const minGapConflict = state.sessions.some((s) => {
    if (special || isSpecialAssignmentId(s.classId)) return false;
    if (s.classId !== classId || s.teacherId !== teacherId || s.type !== "EPS") return false;
    if (!sessionsCanOccurSameWeek(candidate, s)) return false;
    const diffHours = Math.abs(toWeekStartHour(candidate.day, candidate.start) - toWeekStartHour(s.day, s.start));
    return diffHours < 24;
  });
  if (minGapConflict) {
    return {
      ok: false,
      error: "Conflit: pour une classe avec le même enseignant, il faut au moins 24h entre les débuts des cours.",
    };
  }

  return { ok: true, normalized: { teacherId, classId, type, day, start, duration: Number(duration), cadence, weekType } };
}
