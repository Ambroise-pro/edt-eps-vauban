import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock state and utils before importing rules
vi.mock('../state.js', () => ({
  state: {
    teachers: [],
    classes: [],
    sessions: [],
    swimSlotKeys: new Set(),
  },
}));

vi.mock('../utils.js', () => ({
  toSlotKey: (day, slot) => `${day}|${slot}`,
}));

import {
  getCoveredSlots,
  slotsOverlap,
  sessionsConflict,
  sessionsCanOccurSameWeek,
  normalizeCadence,
  normalizeWeekType,
  weeklyEquivalentHours,
  toWeekStartHour,
  isASLike,
  isSpecialAssignmentId,
  validateSession,
} from '../rules.js';

import { state } from '../state.js';

// ─── getCoveredSlots ─────────────────────────────────────────────────────────

describe('getCoveredSlots', () => {
  it('retourne les créneaux couverts pour une durée de 2h', () => {
    const result = getCoveredSlots('Lundi', '08:00', 2);
    expect(result).toEqual(['Lundi|08:00', 'Lundi|09:00']);
  });

  it('retourne [] si le start est inconnu', () => {
    expect(getCoveredSlots('Lundi', '07:00', 2)).toEqual([]);
  });

  it('retourne [] si la durée dépasse les créneaux disponibles', () => {
    expect(getCoveredSlots('Lundi', '16:00', 5)).toEqual([]);
  });
});

// ─── slotsOverlap ────────────────────────────────────────────────────────────

describe('slotsOverlap', () => {
  it('détecte un chevauchement', () => {
    expect(slotsOverlap(['Lundi|08:00', 'Lundi|09:00'], ['Lundi|09:00', 'Lundi|10:00'])).toBe(true);
  });

  it('retourne false sans chevauchement', () => {
    expect(slotsOverlap(['Lundi|08:00', 'Lundi|09:00'], ['Lundi|10:00', 'Lundi|11:00'])).toBe(false);
  });
});

// ─── normalizeCadence / normalizeWeekType ────────────────────────────────────

describe('normalizeCadence', () => {
  it('retourne BIWEEKLY si BIWEEKLY', () => expect(normalizeCadence('BIWEEKLY')).toBe('BIWEEKLY'));
  it('retourne WEEKLY sinon', () => expect(normalizeCadence('WEEKLY')).toBe('WEEKLY'));
  it('retourne WEEKLY pour une valeur inconnue', () => expect(normalizeCadence(null)).toBe('WEEKLY'));
});

describe('normalizeWeekType', () => {
  it('retourne B si B', () => expect(normalizeWeekType('B')).toBe('B'));
  it('retourne A sinon', () => expect(normalizeWeekType('A')).toBe('A'));
  it('retourne A pour null', () => expect(normalizeWeekType(null)).toBe('A'));
});

// ─── sessionsConflict ─────────────────────────────────────────────────────────

describe('sessionsConflict', () => {
  const sessionA = { day: 'Lundi', start: '08:00', duration: 2, cadence: 'WEEKLY', weekType: 'A' };
  const sessionB = { day: 'Lundi', start: '09:00', duration: 2, cadence: 'WEEKLY', weekType: 'A' };
  const sessionC = { day: 'Lundi', start: '10:00', duration: 2, cadence: 'WEEKLY', weekType: 'A' };
  const sessionD = { day: 'Lundi', start: '08:00', duration: 2, cadence: 'BIWEEKLY', weekType: 'A' };
  const sessionE = { day: 'Lundi', start: '08:00', duration: 2, cadence: 'BIWEEKLY', weekType: 'B' };

  it('conflicte si même créneau, deux WEEKLY', () => expect(sessionsConflict(sessionA, sessionA)).toBe(true));
  it('conflicte si chevauchement partiel', () => expect(sessionsConflict(sessionA, sessionB)).toBe(true));
  it('ne conflicte pas si pas de chevauchement', () => expect(sessionsConflict(sessionA, sessionC)).toBe(false));
  it('conflicte si WEEKLY vs BIWEEKLY sur même créneau', () => expect(sessionsConflict(sessionA, sessionD)).toBe(true));
  it('ne conflicte pas si BIWEEKLY A vs BIWEEKLY B sur même créneau', () => expect(sessionsConflict(sessionD, sessionE)).toBe(false));
});

// ─── sessionsCanOccurSameWeek ────────────────────────────────────────────────

describe('sessionsCanOccurSameWeek', () => {
  it("true si l'un est WEEKLY", () => {
    const a = { cadence: 'WEEKLY', weekType: 'A' };
    const b = { cadence: 'BIWEEKLY', weekType: 'B' };
    expect(sessionsCanOccurSameWeek(a, b)).toBe(true);
  });
  it('false si BIWEEKLY A vs BIWEEKLY B', () => {
    const a = { cadence: 'BIWEEKLY', weekType: 'A' };
    const b = { cadence: 'BIWEEKLY', weekType: 'B' };
    expect(sessionsCanOccurSameWeek(a, b)).toBe(false);
  });
});

// ─── weeklyEquivalentHours ───────────────────────────────────────────────────

describe('weeklyEquivalentHours', () => {
  it('retourne la durée brute pour WEEKLY', () => {
    expect(weeklyEquivalentHours({ duration: 2, cadence: 'WEEKLY' })).toBe(2);
  });
  it('retourne durée/2 pour BIWEEKLY', () => {
    expect(weeklyEquivalentHours({ duration: 2, cadence: 'BIWEEKLY' })).toBe(1);
  });
});

// ─── toWeekStartHour ─────────────────────────────────────────────────────────

describe('toWeekStartHour', () => {
  it('Lundi 08:00 → 8', () => expect(toWeekStartHour('Lundi', '08:00')).toBe(8));
  it('Mardi 08:00 → 32 (1*24 + 8)', () => expect(toWeekStartHour('Mardi', '08:00')).toBe(32));
  it('Lundi 08:30 → 8.5', () => expect(toWeekStartHour('Lundi', '08:30')).toBe(8.5));
});

// ─── isASLike / isSpecialAssignmentId ────────────────────────────────────────

describe('isASLike', () => {
  it('vrai pour type AS', () => expect(isASLike({ type: 'AS' })).toBe(true));
  it('vrai pour classId __AS__', () => expect(isASLike({ type: 'EPS', classId: '__AS__' })).toBe(true));
  it('faux sinon', () => expect(isASLike({ type: 'EPS', classId: 'abc' })).toBe(false));
  it('faux pour null', () => expect(isASLike(null)).toBe(false));
});

describe('isSpecialAssignmentId', () => {
  it('vrai pour __AS__', () => expect(isSpecialAssignmentId('__AS__')).toBe(true));
  it('vrai pour __DANSE__', () => expect(isSpecialAssignmentId('__DANSE__')).toBe(true));
  it('faux pour id normal', () => expect(isSpecialAssignmentId('class-1')).toBe(false));
});

// ─── validateSession ──────────────────────────────────────────────────────────

describe('validateSession', () => {
  beforeEach(() => {
    state.teachers = [{ id: 't1', name: 'Dupont', unavailable: [] }];
    state.classes = [{ id: 'c1', name: '6eA', level: 'Sixième' }];
    state.sessions = [];
  });

  it('échoue si champs manquants', () => {
    const r = validateSession({ teacherId: 't1' });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/incompl/i);
  });

  it('échoue si professeur inconnu', () => {
    const r = validateSession({ teacherId: 'unknown', classId: 'c1', type: 'EPS', day: 'Lundi', start: '08:00', duration: 2, cadence: 'WEEKLY' });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/introuvable/i);
  });

  it('échoue si durée incorrecte pour 6e (doit être 2h)', () => {
    const r = validateSession({ teacherId: 't1', classId: 'c1', type: 'EPS', day: 'Lundi', start: '08:00', duration: 1, cadence: 'WEEKLY' });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/2h/i);
  });

  it('réussit pour un créneau valide 6e', () => {
    const r = validateSession({ teacherId: 't1', classId: 'c1', type: 'EPS', day: 'Lundi', start: '08:00', duration: 2, cadence: 'WEEKLY' });
    expect(r.ok).toBe(true);
  });

  it('détecte un conflit professeur', () => {
    state.sessions = [{ id: 's1', teacherId: 't1', classId: 'c2', day: 'Lundi', start: '08:00', duration: 2, cadence: 'WEEKLY', weekType: 'A' }];
    const r = validateSession({ teacherId: 't1', classId: 'c1', type: 'EPS', day: 'Lundi', start: '08:00', duration: 2, cadence: 'WEEKLY' });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/conflit.*professeur/i);
  });
});
