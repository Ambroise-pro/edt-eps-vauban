export const DAYS = ["Lundi", "Mardi", "Mercredi", "Jeudi", "Vendredi"];
export const SLOTS = ["08:00", "09:00", "10:00", "11:00", "12:00", "13:00", "14:00", "15:00", "16:00", "17:00"];

export const SLOT_BANDS = [
  { label: "8h - 10h", start: "08:00", end: "10:00", slots: ["08:00", "09:00"] },
  { label: "10h - 12h", start: "10:00", end: "12:00", slots: ["10:00", "11:00"] },
  { label: "12h - 14h", start: "12:00", end: "14:00", slots: ["12:00", "13:00"] },
  { label: "14h - 16h", start: "14:00", end: "16:00", slots: ["14:00", "15:00"] },
  { label: "16h - 18h", start: "16:00", end: "18:00", slots: ["16:00", "17:00"] },
];

export const SPECIAL_ASSIGNMENTS = [
  { id: "__AS__", label: "AS", type: "AS" },
  { id: "__DANSE__", label: "Danse", type: "DANSE" },
];

export const LEVEL_RULES = {
  "Sixième": { weeklyHours: 4, hint: "6e: 4h/semaine (2 x 2h)", group: "SIXIEME" },
  "Cinquième": { weeklyHours: 3, hint: "5e: 3h/semaine (créneau de 3h, hebdomadaire)", group: "CINQUIEME" },
  "Quatrième": { weeklyHours: 3, hint: "4e: 3h/semaine (2h hebdo + semaine A/B possible)", group: "ALT_43" },
  "Troisième": { weeklyHours: 3, hint: "3e: 3h/semaine (2h hebdo + semaine A/B possible)", group: "ALT_43" },
  Seconde: { weeklyHours: 2, hint: "2nde/1re/Tle: 2h/semaine", group: "LYCEE" },
  "Première": { weeklyHours: 2, hint: "2nde/1re/Tle: 2h/semaine", group: "LYCEE" },
  Terminale: { weeklyHours: 2, hint: "2nde/1re/Tle: 2h/semaine", group: "LYCEE" },
};
