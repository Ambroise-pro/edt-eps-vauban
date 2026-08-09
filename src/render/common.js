import { state } from '../state.js';
import { SPECIAL_ASSIGNMENTS } from '../constants.js';
import { normalizeHexColor, hashString } from '../utils.js';

export function fallbackColorForTeacher(teacher) {
  const palette = ["#0b7285", "#1971c2", "#2b8a3e", "#c92a2a", "#a61e4d", "#5f3dc4", "#e67700", "#087f5b"];
  const seed = `${teacher?.id || ""}|${teacher?.name || ""}`;
  return palette[hashString(seed) % palette.length];
}

export function getTeacherColor(teacher) {
  return normalizeHexColor(teacher?.color || fallbackColorForTeacher(teacher));
}

export function getTeacherColorById(teacherId) {
  const teacher = state.teachers.find((t) => t.id === teacherId);
  return getTeacherColor(teacher);
}

export function getTeacherBlockStyle(teacherId) {
  const color = getTeacherColorById(teacherId);
  return `background:${color}22;border-left:4px solid ${color};`;
}

export function teacherShortCode(name) {
  const parts = String(name || "").trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "PROF";
  if (parts.length === 1) return parts[0].slice(0, 3).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

export function normalizeTeacherAbbreviation(value, fallbackName = "") {
  const raw = String(value || "").trim().replace(/\s+/g, "").toUpperCase().slice(0, 8);
  if (raw) return raw;
  return teacherShortCode(fallbackName);
}

export function getTeacherDisplayLabel(teacher) {
  return normalizeTeacherAbbreviation(teacher?.abbreviation, teacher?.name || "PROF");
}

export function getClassLabelById(classId, withLevel = false) {
  const special = SPECIAL_ASSIGNMENTS.find((x) => x.id === classId);
  if (special) return special.label;
  const cls = state.classes.find((c) => c.id === classId);
  if (!cls) return "Classe inconnue";
  return withLevel ? `${cls.level} ${cls.name}` : cls.name;
}
