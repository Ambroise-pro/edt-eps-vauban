/**
 * Web Worker – Moteur de génération EDT EPS Vauban
 *
 * Reçoit toutes les données nécessaires via postMessage, exécute la simulation
 * (greedy + backtracking + hill climbing), renvoie le résultat au thread principal.
 *
 * Messages entrants : { type: 'run', payload: AlgoPayload }
 * Messages sortants :
 *   { type: 'progress', attempt, total, strategy, created, score }
 *   { type: 'result',   best: AttemptResult }
 *   { type: 'error',    message: string }
 */

// ─── Constantes (miroir de app.js) ──────────────────────────────────────────
const DAYS = ["Lundi", "Mardi", "Mercredi", "Jeudi", "Vendredi"];
const SLOTS = ["08:15","09:05","10:20","11:10","12:10","13:00","14:00","15:00","16:05","16:55"];
const SLOT_BANDS = [
  { label:"08h15",  start:"08:15", end:"10:00", slots:["08:15","09:05"] },
  { label:"10h20",  start:"10:20", end:"12:05", slots:["10:20","11:10"] },
  { label:"12h10",  start:"12:10", end:"13:00", slots:["12:10"] },
  { label:"13h00",  start:"13:00", end:"14:00", slots:["13:00"] },
  { label:"14h00",  start:"14:00", end:"16:00", slots:["14:00","15:00"] },
  { label:"16h05",  start:"16:05", end:"17:50", slots:["16:05","16:55"] },
];
const FRIDAY_DISABLED_STARTS = new Set(["14:00","16:05"]);
const LEVEL_RULES = {
  "Sixième":   { weeklyHours:4, group:"SIXIEME" },
  "Cinquième": { weeklyHours:3, group:"CINQUIEME" },
  "Quatrième": { weeklyHours:3, group:"ALT_43" },
  "Troisième": { weeklyHours:3, group:"ALT_43" },
  "Seconde":   { weeklyHours:2, group:"LYCEE" },
  "Première":  { weeklyHours:2, group:"LYCEE" },
  "Terminale": { weeklyHours:2, group:"LYCEE" },
};
const SPECIAL = [
  { id:"__AS__",    label:"AS",    type:"AS"    },
  { id:"__DANSE__", label:"Danse", type:"DANSE" },
];

// ─── État local du Worker ────────────────────────────────────────────────────
let W = {}; // payload complet reçu
let simSessions = []; // sessions simulées (sessions existantes + créées)
let simSeq = 0;
let pendingSessions = []; // sessions à appliquer

// ─── Helpers purs ────────────────────────────────────────────────────────────
function getLevelRule(level) { return LEVEL_RULES[level] || null; }
function getSpecial(classId) { return SPECIAL.find(x => x.id === classId) || null; }
function isSpecialId(id) { return SPECIAL.some(x => x.id === id); }
function isASLike(s) { return String(s?.type||"").toUpperCase()==="AS" || String(s?.classId||"").startsWith("__AS"); }

function normCadence(c) { return c === "BIWEEKLY" ? "BIWEEKLY" : "WEEKLY"; }
function normWeekType(w) { return w === "B" ? "B" : "A"; }

function toSlotKey(day, slot) { return `${day}|${slot}`; }

function getCoveredSlots(day, start, duration) {
  const i = SLOTS.indexOf(start);
  if (i < 0) return [];
  const out = [];
  for (let k = 0; k < duration; k++) {
    const s = SLOTS[i + k];
    if (!s) return [];
    out.push(toSlotKey(day, s));
  }
  return out;
}

function slotsOverlap(a, b) {
  const sb = new Set(b);
  return a.some(x => sb.has(x));
}

function sessionsConflict(a, b) {
  const as = getCoveredSlots(a.day, a.start, Number(a.duration||0));
  const bs = getCoveredSlots(b.day, b.start, Number(b.duration||0));
  if (!slotsOverlap(as, bs)) return false;
  const ac = normCadence(a.cadence), bc = normCadence(b.cadence);
  if (ac === "WEEKLY" || bc === "WEEKLY") return true;
  return normWeekType(a.weekType) === normWeekType(b.weekType);
}

function canOccurSameWeek(a, b) {
  const ac = normCadence(a?.cadence), bc = normCadence(b?.cadence);
  if (ac === "WEEKLY" || bc === "WEEKLY") return true;
  return normWeekType(a?.weekType) === normWeekType(b?.weekType);
}

function toWeekHour(day, start) {
  const di = Math.max(0, DAYS.indexOf(day));
  const [h,m] = String(start||"00:00").split(":").map(Number);
  return di * 24 + h + m / 60;
}

function weeklyEquiv(s) {
  return normCadence(s?.cadence) === "BIWEEKLY" ? Number(s?.duration||0) / 2 : Number(s?.duration||0);
}

function getSlotBandsForDay(day) {
  if (day !== "Vendredi") return SLOT_BANDS;
  return SLOT_BANDS.filter(b => !FRIDAY_DISABLED_STARTS.has(b.start));
}

function getBandForStart(start) {
  return SLOT_BANDS.find(b => b.start === start) || null;
}

// ─── Accès aux données du payload ────────────────────────────────────────────
function getTeacher(id) { return W.teachers.find(t => t.id === id); }
function getCls(id) { return W.classes.find(c => c.id === id); }
function getDesiderata(teacherId, day, slot) {
  return W.desiderataMap?.[teacherId]?.[day]?.[slot] || null;
}
function isBlocked(day, start) {
  return W.blockedSlots.some(b => b.day === day && b.start === start);
}
function isSwimSlot(day, slot) {
  return W.swimSlotKeys.includes(toSlotKey(day, slot));
}
function getQuota(teacherId, level) {
  return Number(W.quotasMap?.[teacherId]?.[level] || 0);
}
function getRepartitionTeacher(classId) {
  return W.repartitionMap?.[classId] || null;
}

// ─── Calculs heures ──────────────────────────────────────────────────────────
function getAssignedHours(classId) {
  return simSessions
    .filter(s => s.classId === classId && String(s.type||"").toUpperCase() === "EPS")
    .reduce((acc, s) => acc + weeklyEquiv(s), 0);
}

function getTeacherHours(teacherId) {
  return simSessions
    .filter(s => s.teacherId === teacherId)
    .reduce((acc, s) => acc + weeklyEquiv(s), 0);
}

function getClassRemaining(classId) {
  const cls = getCls(classId);
  if (!cls) return 0;
  return Math.max(0, Number(cls.weeklyHours||0) - getAssignedHours(classId));
}

// ─── Vérification qu'un prof peut prendre une classe ─────────────────────────
function teacherCanTakeClass(teacher, classId) {
  const sp = getSpecial(classId);
  const quotas = W.quotasMap?.[teacher.id] || {};
  const totalQuota = Object.values(quotas).reduce((a,b) => a + Number(b||0), 0);
  if (!totalQuota) return true;

  if (sp) {
    const key = sp.type === "AS" ? "AS" : "DANSE";
    const allowed = Number(quotas[key]||0);
    if (!allowed) return false;
    const used = new Set(simSessions.filter(s => s.teacherId===teacher.id && s.classId===sp.id).map(s=>s.classId));
    return used.has(classId) || used.size < allowed;
  }
  const cls = getCls(classId);
  if (!cls) return false;
  const repTeacher = getRepartitionTeacher(classId);
  if (repTeacher) return repTeacher === teacher.id;
  const allowed = Number(quotas[cls.level]||0);
  if (!allowed) return false;
  const usedClasses = new Set(
    simSessions.filter(s => s.teacherId===teacher.id && !isSpecialId(s.classId))
      .filter(s => getCls(s.classId)?.level === cls.level)
      .map(s => s.classId)
  );
  return usedClasses.has(classId) || usedClasses.size < allowed;
}

function teacherIsAssigned(teacher, classId) {
  const quotas = W.quotasMap?.[teacher.id] || {};
  const total = Object.values(quotas).reduce((a,b) => a + Number(b||0), 0);
  if (!total) return true;
  const sp = getSpecial(classId);
  if (sp) return Number(quotas[sp.type==="AS"?"AS":"DANSE"]||0) > 0;
  const cls = getCls(classId);
  if (!cls) return false;
  const rep = getRepartitionTeacher(classId);
  if (rep) return rep === teacher.id;
  return Number(quotas[cls.level]||0) > 0;
}

// ─── Validation d'une session ─────────────────────────────────────────────────
function validateSim(payload) {
  const { teacherId, classId, type, day, start, duration, cadence, weekType } = payload;
  if (!teacherId||!classId||!type||!day||!start||!duration)
    return { ok:false, error:"Champs manquants." };

  const teacher = getTeacher(teacherId);
  const cls = getCls(classId);
  const sp = getSpecial(classId);
  if (!teacher) return { ok:false, error:"Professeur introuvable." };
  if (!cls && !sp) return { ok:false, error:"Classe introuvable." };

  const slots = getCoveredSlots(day, start, Number(duration));
  if (!slots.length) return { ok:false, error:"Créneau invalide." };

  if (type==="EPS" && cls) {
    const rule = getLevelRule(cls.level);
    if (rule?.group==="CINQUIEME") {
      if (Number(duration)!==3) return { ok:false, error:"5e: 3h obligatoires." };
      if (normCadence(cadence)!=="WEEKLY") return { ok:false, error:"5e: hebdomadaire obligatoire." };
    } else {
      if (Number(duration)!==2) return { ok:false, error:"EPS: 2h obligatoires." };
    }
    if ((rule?.group==="SIXIEME"||rule?.group==="LYCEE") && normCadence(cadence)!=="WEEKLY")
      return { ok:false, error:"Ce niveau: hebdomadaire obligatoire." };
    if (rule?.group!=="ALT_43" && normCadence(cadence)==="BIWEEKLY")
      return { ok:false, error:"A/B uniquement pour 4e/3e." };
  }

  const unavail = Array.isArray(teacher.unavailable) ? teacher.unavailable : [];
  if (slots.some(k => unavail.includes(k)))
    return { ok:false, error:"Professeur indisponible." };

  const cand = { day, start, duration:Number(duration), cadence, weekType };
  if (simSessions.some(s => s.teacherId===teacherId && sessionsConflict(cand,s)))
    return { ok:false, error:"Conflit professeur." };
  if (!sp && simSessions.some(s => s.classId===classId && sessionsConflict(cand,s)))
    return { ok:false, error:"Conflit classe." };

  if (!sp) {
    const gap = simSessions.some(s => {
      if (isSpecialId(s.classId)||s.classId!==classId||s.teacherId!==teacherId||s.type!=="EPS") return false;
      if (!canOccurSameWeek(cand,s)) return false;
      return Math.abs(toWeekHour(cand.day,cand.start) - toWeekHour(s.day,s.start)) < 24;
    });
    if (gap) return { ok:false, error:"Moins de 24h entre deux cours du même enseignant pour cette classe." };
  }

  return { ok:true, session:{ teacherId, classId, type, day, start, duration:Number(duration), cadence, weekType } };
}

// ─── Évaluation de la qualité d'une session ───────────────────────────────────
function evalQuality(session, strategy) {
  const teacher = getTeacher(session.teacherId);
  const maxH = Number(teacher?.maxHours||0);
  const currentH = getTeacherHours(session.teacherId);
  const nextH = currentH + weeklyEquiv(session);
  const loadRatio = maxH > 0 ? nextH / maxH : 0;

  const slots = getCoveredSlots(session.day, session.start, Number(session.duration||0));
  let preferredCount = 0;
  for (const k of slots) {
    const [d, sl] = k.split("|");
    if (getDesiderata(session.teacherId, d, sl) === "PREFERRED") preferredCount++;
  }

  let score = 72;

  // Charge du professeur
  if (loadRatio > 1)        score -= 34;
  else if (loadRatio > 0.92) score -= 16;
  else if (loadRatio < 0.75) score += 8;

  // Désidérata
  if (preferredCount === slots.length && slots.length > 0) score += 50;
  else if (preferredCount > 0) score += 25;

  // Amplitude journalière
  const sH = toWeekHour(session.day, session.start) % 24;
  const eH = sH + Number(session.duration||0);
  const daySess = simSessions.filter(s =>
    s.teacherId===session.teacherId && s.day===session.day && isVisibleForWeek(s, normWeekType(session.weekType))
  );
  let minH = sH, maxH2 = eH;
  for (const s of daySess) {
    const h = toWeekHour(s.day, s.start) % 24;
    const e = h + Number(s.duration||0);
    if (h < minH) minH = h;
    if (e > maxH2) maxH2 = e;
  }
  const amp = maxH2 - minH;
  if (amp > 10) score -= 100;
  else if (amp > 9) score -= 60;
  else if (amp > 8) score -= 30;

  // Stratégie SPREAD : bonus si le prof n'a pas encore de cours ce jour
  if (strategy === "SPREAD") {
    const dayH = simSessions
      .filter(s => s.teacherId === session.teacherId && s.day === session.day)
      .reduce((acc, s) => acc + weeklyEquiv(s), 0);
    if (dayH === 0) score += 30;
    else if (dayH <= 2) score += 10;
    else score -= 15;
  }

  // Horaire tardif pénalisé pour collège
  const cls = getCls(session.classId);
  const group = getLevelRule(cls?.level)?.group || "";
  if ((group==="SIXIEME"||group==="CINQUIEME"||group==="ALT_43") && session.start >= "16:05") score -= 12;
  if (group==="ALT_43" && normCadence(session.cadence)!=="WEEKLY") score += 6;

  return score;
}

function isVisibleForWeek(s, weekType) {
  const c = normCadence(s.cadence);
  if (c === "WEEKLY") return true;
  return normWeekType(s.weekType) === weekType;
}

// ─── Construction d'une proposition de session ────────────────────────────────
function buildProposal(teacherId, classId, day, start, cadencePref, strategy) {
  const sp = getSpecial(classId);
  if (sp) {
    const duration = sp.type==="AS" ? 1 : 2;
    const session = {
      teacherId, classId, type: sp.type, day, start, duration,
      cadence:"WEEKLY", weekType:"A",
    };
    const r = validateSim(session);
    return r.ok ? { ok:true, session:r.session, score:evalQuality(r.session, strategy) } : { ok:false };
  }

  const cls = getCls(classId);
  if (!cls) return { ok:false };
  const rule = getLevelRule(cls.level);

  let proposals = [];
  if (normCadence(cadencePref) === "BIWEEKLY" || cadencePref === "WEEK_A") {
    proposals.push({ teacherId, classId, type:"EPS", day, start, duration:rule?.group==="CINQUIEME"?3:2, cadence:"BIWEEKLY", weekType:"A" });
  }
  if (cadencePref === "WEEK_B") {
    proposals.push({ teacherId, classId, type:"EPS", day, start, duration:2, cadence:"BIWEEKLY", weekType:"B" });
  }
  if (proposals.length === 0 || cadencePref === "WEEKLY" || cadencePref === "AUTO") {
    proposals.push({ teacherId, classId, type:"EPS", day, start, duration:rule?.group==="CINQUIEME"?3:2, cadence:"WEEKLY", weekType:"A" });
  }

  for (const p of proposals) {
    const r = validateSim(p);
    if (r.ok) return { ok:true, session:r.session, score:evalQuality(r.session, strategy) };
  }
  return { ok:false };
}

// ─── Contraintes manuelles ────────────────────────────────────────────────────
function normKey(v) { return String(v||"").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g,""); }

function evalManualConstraints(session) {
  const rows = W.constraintRows || [];
  if (!rows.length) return { blocked:false, scoreDelta:0 };
  const cls = getCls(session.classId);
  const level = String(cls?.level||"");
  const covered = getCoveredSlots(session.day, session.start, Number(session.duration||0)).map(k=>k.split("|")[1]);
  const isAs = isASLike(session);

  let blocked = false, scoreDelta = 0;
  for (const raw of rows) {
    const key = normKey(raw);
    const teacherMatch = W.teachers.filter(t => {
      const n = normKey(t.name); const a = normKey(t.abbreviation||"");
      return (n && key.includes(n)) || (a && key.includes(a));
    }).map(t=>t.id);
    const levelMatch = Object.keys(LEVEL_RULES).filter(l => key.includes(normKey(l)));
    const mentionsAs = key.includes(" as ") || key.startsWith("as ");

    if (teacherMatch.length && !teacherMatch.includes(session.teacherId)) continue;
    if (levelMatch.length && !levelMatch.includes(level)) continue;
    if (mentionsAs && !isAs) continue;

    const days = DAYS.filter(d => key.includes(normKey(d)));
    const slots = SLOTS.filter(s => key.includes(s));
    const dayMatch = !days.length || days.includes(session.day);
    const slotMatch = !slots.length || covered.some(s => slots.includes(s));
    const where = dayMatch && slotMatch;

    if ((key.includes("interdit")||key.includes("jamais")) && where) { blocked = true; break; }
    if ((key.includes("eviter")||key.includes("limiter")) && where) scoreDelta -= 14;
    if ((key.includes("prefer")||key.includes("favoris")) && where) scoreDelta += 10;
  }
  return { blocked, scoreDelta };
}

// ─── Calcul du nombre de créneaux valides pour une classe (MCF) ───────────────
function countValidSlots(classId, forcedTeacherId) {
  const teacherPool = forcedTeacherId
    ? W.teachers.filter(t => t.id===forcedTeacherId && teacherIsAssigned(t, classId))
    : W.teachers.filter(t => teacherIsAssigned(t, classId));
  let count = 0;
  for (const day of DAYS) {
    for (const band of getSlotBandsForDay(day)) {
      if (isBlocked(day, band.start)) continue;
      for (const t of teacherPool) {
        if (buildProposal(t.id, classId, day, band.start, "AUTO", "MCF").ok) count++;
      }
    }
  }
  return count;
}

// ─── Trouver le meilleur slot pour une classe ─────────────────────────────────
function findBest(classId, forcedTeacherId, strategy, cadencePref = "AUTO") {
  const cls = getCls(classId);
  if (!cls) return null;
  const teacherPool = forcedTeacherId
    ? W.teachers.filter(t => t.id===forcedTeacherId && teacherIsAssigned(t, classId))
    : W.teachers.filter(t => teacherIsAssigned(t, classId));
  if (!teacherPool.length) return null;

  const cadences = cadencePref !== "AUTO" ? [cadencePref] : getCadencePrefs(cls);

  let best = null;
  for (const day of DAYS) {
    for (const band of getSlotBandsForDay(day)) {
      if (isBlocked(day, band.start)) continue;
      for (const cad of cadences) {
        for (const t of teacherPool) {
          if (!teacherCanTakeClass(t, classId)) continue;
          const prop = buildProposal(t.id, classId, day, band.start, cad, strategy);
          if (!prop.ok) continue;
          const mc = evalManualConstraints(prop.session);
          if (mc.blocked) continue;
          const score = prop.score + mc.scoreDelta;
          if (!best || score > best.score) {
            best = { session: prop.session, score, day, start: band.start, teacher: t };
          }
        }
      }
    }
  }
  return best;
}

function getCadencePrefs(cls) {
  const group = getLevelRule(cls?.level)?.group || "";
  if (group !== "ALT_43") return ["WEEKLY"];
  const eps = simSessions.filter(s => s.classId===cls.id && s.type==="EPS");
  const hasW = eps.some(s => normCadence(s.cadence)==="WEEKLY");
  const hasB = eps.some(s => normCadence(s.cadence)==="BIWEEKLY");
  if (!hasW) return ["WEEKLY"];
  if (!hasB) return ["WEEK_A","WEEK_B"];
  return [];
}

// ─── Binômes A/B pour 4e/3e ──────────────────────────────────────────────────
function findBestAlt43Pair(classId, forcedTeacherId) {
  const cls = getCls(classId);
  if (!cls || getLevelRule(cls.level)?.group !== "ALT_43") return null;
  if (getClassRemaining(classId) > 1.05) return null;

  const teacherPool = forcedTeacherId
    ? W.teachers.filter(t => t.id===forcedTeacherId && teacherIsAssigned(t, classId))
    : W.teachers.filter(t => teacherIsAssigned(t, classId));

  let best = null;
  for (const teacher of teacherPool) {
    const partners = W.classes.filter(other =>
      other.id !== classId &&
      getLevelRule(other.level)?.group === "ALT_43" &&
      getClassRemaining(other.id) > 0.001 &&
      getClassRemaining(other.id) <= 1.05 &&
      teacherIsAssigned(teacher, other.id)
    );
    for (const partner of partners) {
      for (const day of DAYS) {
        for (const band of getSlotBandsForDay(day)) {
          if (isBlocked(day, band.start)) continue;
          for (const opt of [["WEEK_A","WEEK_B"],["WEEK_B","WEEK_A"]]) {
            const pA = buildProposal(teacher.id, cls.id, day, band.start, opt[0], "MCF");
            if (!pA.ok) continue;
            const pB = buildProposal(teacher.id, partner.id, day, band.start, opt[1], "MCF");
            if (!pB.ok) continue;
            const mcA = evalManualConstraints(pA.session);
            const mcB = evalManualConstraints(pB.session);
            if (mcA.blocked || mcB.blocked) continue;
            const score = pA.score + pB.score + mcA.scoreDelta + mcB.scoreDelta + 8;
            if (!best || score > best.score) {
              best = { score, teacher, primaryClass:cls, partnerClass:partner, primarySession:pA.session, partnerSession:pB.session };
            }
          }
        }
      }
    }
  }
  return best;
}

// ─── Simulation principale ─────────────────────────────────────────────────────
function addSimSession(session) {
  simSeq++;
  const s = { ...session, id:`__sim_${simSeq}` };
  simSessions.push(s);
  return s;
}

function removeSimSession(id) {
  const idx = simSessions.findIndex(s => s.id === id);
  if (idx >= 0) simSessions.splice(idx, 1);
}

async function runAttempt({ strategy, attemptIndex, attemptTotal, targetCount, classTeacherTargets }) {
  simSessions = W.replaceExisting ? [] : W.existingSessions.slice();
  pendingSessions = [];
  simSeq = 0;
  const createdByClass = new Map();
  const errors = [];
  let created = 0, failed = 0;

  // Pré-placements imposés
  for (const pin of (W.pinnedClasses || [])) {
    const teacherPool = W.teachers.filter(t => teacherIsAssigned(t, pin.classId));
    let placed = false;
    for (const t of teacherPool) {
      const prop = buildProposal(t.id, pin.classId, pin.day, pin.start, pin.cadence || "WEEKLY", strategy);
      if (!prop.ok) continue;
      const s = addSimSession(prop.session);
      pendingSessions.push(prop.session);
      createdByClass.set(pin.classId, (createdByClass.get(pin.classId)||0) + 1);
      created++;
      placed = true;
      break;
    }
    if (!placed) { failed++; errors.push(`Pré-placement impossible: ${pin.classId} ${pin.day} ${pin.start}`); }
  }

  // Boucle principale
  let stagnation = 0;
  const maxCycles = Math.max(12, W.classes.length * 3);
  const backtrackHistory = []; // pour backtracking léger

  while (created < targetCount && stagnation < maxCycles) {
    let pending = W.classes
      .filter(cls => getLevelRule(cls.level)?.group !== "CINQUIEME")
      .filter(cls => getClassRemaining(cls.id) > 0.001)
      .map(cls => ({
        cls,
        remaining: getClassRemaining(cls.id),
        options: countValidSlots(cls.id, classTeacherTargets.get(cls.id) || ""),
        priority: getLevelPriority(cls.level),
      }));

    if (!pending.length) break;

    // Tri selon la stratégie
    if (strategy === "CLASSIC") {
      pending.sort((a,b) => b.remaining - a.remaining || String(a.cls.name).localeCompare(b.cls.name,"fr"));
    } else if (strategy === "SPREAD") {
      pending.sort((a,b) => a.priority - b.priority || a.options - b.options);
    } else if (strategy === "DESIDERATA") {
      pending.sort((a,b) => a.priority - b.priority || a.options - b.options);
    } else if (strategy === "RANDOM_A" || strategy === "RANDOM_B") {
      pending.sort(() => pseudoRand(strategy) - 0.5);
    } else {
      // MCF par défaut: priorité de niveau, puis moins d'options
      pending.sort((a,b) => a.priority - b.priority || a.options - b.options || b.remaining - a.remaining);
    }

    let cycleProgress = false;

    for (const item of pending) {
      if (created >= targetCount) break;
      if (getClassRemaining(item.cls.id) <= 0.001) continue;

      const forcedTeacherId = classTeacherTargets.get(item.cls.id) || "";
      const group = getLevelRule(item.cls.level)?.group || "";

      // Classes 4e/3e avec dernier créneau à placer → binôme A/B
      if (group === "ALT_43" && getClassRemaining(item.cls.id) <= 1.05) {
        if (created + 2 > targetCount) continue;
        const pair = findBestAlt43Pair(item.cls.id, forcedTeacherId);
        if (pair) {
          const sA = addSimSession(pair.primarySession);
          const sB = addSimSession(pair.partnerSession);
          pendingSessions.push(pair.primarySession, pair.partnerSession);
          backtrackHistory.push({ ids:[sA.id, sB.id], classIds:[pair.primaryClass.id, pair.partnerClass.id] });
          createdByClass.set(pair.primaryClass.id, (createdByClass.get(pair.primaryClass.id)||0)+1);
          createdByClass.set(pair.partnerClass.id, (createdByClass.get(pair.partnerClass.id)||0)+1);
          created += 2;
          cycleProgress = true;
          continue;
        }
      }

      // Placement standard
      const best = findBest(item.cls.id, forcedTeacherId, strategy);
      if (best) {
        const s = addSimSession(best.session);
        pendingSessions.push(best.session);
        backtrackHistory.push({ ids:[s.id], classIds:[item.cls.id] });
        createdByClass.set(item.cls.id, (createdByClass.get(item.cls.id)||0)+1);
        created++;
        cycleProgress = true;
      } else {
        failed++;
        if (errors.length < 20) errors.push(`${item.cls.level} ${item.cls.name}: aucun créneau valide.`);
      }
    }

    if (!cycleProgress) {
      stagnation++;
      // ─── Backtracking léger ────────────────────────────────────────────────
      if (stagnation >= 2 && backtrackHistory.length >= 4) {
        const toUndo = backtrackHistory.splice(-4);
        for (const entry of toUndo) {
          for (const id of entry.ids) removeSimSession(id);
          const idx = pendingSessions.findLastIndex(s => entry.classIds.includes(s.classId));
          if (idx >= 0) pendingSessions.splice(idx, 1);
          created -= entry.ids.length;
        }
        stagnation = 0;
        errors.push("Backtracking: 4 créneaux défaits, nouvel essai.");
      }
    } else {
      stagnation = 0;
    }
  }

  // ─── 5e : triplets (règle spéciale 12:10) ────────────────────────────────
  for (const cls of W.classes.filter(c => getLevelRule(c.level)?.group === "CINQUIEME")) {
    if (getClassRemaining(cls.id) <= 0.001) continue;
    const teacherPool = W.teachers.filter(t => teacherIsAssigned(t, cls.id));
    let placed = false;
    for (const day of DAYS) {
      if (placed) break;
      for (const t of teacherPool) {
        const prop = buildProposal(t.id, cls.id, day, "12:10", "WEEKLY", strategy);
        if (!prop.ok) continue;
        addSimSession(prop.session);
        pendingSessions.push(prop.session);
        created++;
        placed = true;
        break;
      }
    }
    if (!placed) { failed++; errors.push(`5e ${cls.name}: impossible de placer le triplet.`); }
  }

  // Score
  const remaining = W.classes.reduce((acc, c) => acc + getClassRemaining(c.id), 0);
  const remainingClasses = W.classes.filter(c => getClassRemaining(c.id) > 0.001).length;
  const desiderataBonus = calcDesiderataBonus();
  const spreadPenalty = calcSpreadPenalty();

  const reportData = {
    summary: {
      created, failed, remainingHours:remaining, remainingClasses,
      desiderataBonus, weekSpreadPenalty:spreadPenalty, strategy,
      score: 0,
    },
    errors: [...new Set(errors)],
    remaining: W.classes.filter(c => getClassRemaining(c.id) > 0.001)
      .map(c => ({ level:c.level, name:c.name, remaining:getClassRemaining(c.id) })),
  };
  const score = scoreReport(reportData);
  reportData.summary.score = score;

  return { attemptIndex, strategy, score, pendingSessions: pendingSessions.slice(), reportData };
}

// ─── Hill Climbing (amélioration locale post-greedy) ──────────────────────────
function hillClimb(attempt, strategy, maxIter = 80) {
  const sessions = attempt.pendingSessions;
  if (!sessions.length) return attempt;

  // On remet simSessions dans l'état de la meilleure tentative
  simSessions = W.replaceExisting ? [] : W.existingSessions.slice();
  const simIds = [];
  for (const s of sessions) {
    const added = addSimSession(s);
    simIds.push(added.id);
  }

  let currentScore = attempt.score;
  let improved = true;
  let iter = 0;

  while (improved && iter < maxIter) {
    improved = false;
    iter++;
    // Ordre aléatoire des sessions à tenter de bouger
    const order = sessions.map((_,i) => i).sort(() => pseudoRand("HC") - 0.5);

    for (const idx of order) {
      const s = sessions[idx];
      if (isSpecialId(s.classId)) continue;
      const cls = getCls(s.classId);
      if (!cls) continue;

      // Retirer temporairement la session
      const simId = simIds[idx];
      removeSimSession(simId);

      // Chercher un meilleur slot
      const forcedTeacherId = "";
      const best = findBest(s.classId, forcedTeacherId, strategy);
      if (best && best.score > evalQuality(s, strategy) + 5) {
        // On accepte l'amélioration
        sessions[idx] = best.session;
        const added = addSimSession(best.session);
        simIds[idx] = added.id;
        improved = true;
      } else {
        // On remet la session originale
        const added = addSimSession(s);
        simIds[idx] = added.id;
      }
    }
  }

  // Recalcul du score final
  const remaining = W.classes.reduce((acc, c) => acc + getClassRemaining(c.id), 0);
  const remainingClasses = W.classes.filter(c => getClassRemaining(c.id) > 0.001).length;
  const desiderataBonus = calcDesiderataBonus();
  const spreadPenalty = calcSpreadPenalty();
  const reportData = {
    ...attempt.reportData,
    summary: {
      ...attempt.reportData.summary,
      remainingHours: remaining,
      remainingClasses,
      desiderataBonus,
      weekSpreadPenalty: spreadPenalty,
    },
  };
  const score = scoreReport(reportData);
  reportData.summary.score = score;

  return { ...attempt, score, pendingSessions: sessions.slice(), reportData };
}

// ─── Scoring global ──────────────────────────────────────────────────────────
function scoreReport(data) {
  const s = data?.summary || {};
  return (
    Number(s.created||0) * 100
    - Number(s.remainingHours||0) * 50
    - Number(s.remainingClasses||0) * 60
    - Number(s.failed||0) * 15
    - (data.errors?.length||0) * 20
    - Number(s.weekSpreadPenalty||0)
    + Number(s.desiderataBonus||0)
  );
}

function calcDesiderataBonus() {
  let bonus = 0;
  for (const s of simSessions) {
    if (!s.teacherId) continue;
    const slots = getCoveredSlots(s.day, s.start, Number(s.duration||0));
    for (const k of slots) {
      const [d, sl] = k.split("|");
      if (getDesiderata(s.teacherId, d, sl) === "PREFERRED") { bonus += 25; break; }
    }
  }
  return bonus;
}

function calcSpreadPenalty() {
  let penalty = 0;
  for (const t of W.teachers) {
    const dailyH = DAYS.map(day =>
      simSessions.filter(s => s.teacherId===t.id && s.day===day && !isASLike(s))
        .reduce((acc,s) => acc + weeklyEquiv(s), 0)
    );
    const total = dailyH.reduce((a,b) => a+b, 0);
    if (total <= 0.001) continue;
    const workedDays = dailyH.filter(h => h > 0.001).length;
    const targetDays = Math.min(DAYS.length, Math.ceil(total / 4));
    if (workedDays < targetDays) penalty += (targetDays - workedDays) * 18;
    const avg = total / Math.max(1, workedDays);
    const maxDay = Math.max(...dailyH);
    penalty += Math.max(0, maxDay - avg - 2) * 10;
  }
  return Math.round(penalty);
}

// ─── Priorité de niveau ───────────────────────────────────────────────────────
function getLevelPriority(level) {
  if (level === "Seconde") return 1;
  if (level === "Cinquième") return 2;
  if (["Quatrième","Troisième"].includes(level)) return 3;
  if (level === "Sixième") return 5;
  return 6;
}

// ─── Pseudo-aléatoire reproductible ──────────────────────────────────────────
const _seeds = {};
function pseudoRand(key) {
  if (!_seeds[key]) _seeds[key] = 42 + key.charCodeAt(0);
  _seeds[key] = (_seeds[key] * 1664525 + 1013904223) & 0xffffffff;
  return (_seeds[key] >>> 0) / 0x100000000;
}

// ─── Boucle principale de génération ─────────────────────────────────────────
const STRATEGIES = ["CLASSIC", "MCF", "DESIDERATA", "SPREAD", "RANDOM_A", "RANDOM_B", "BACKTRACK"];

async function generate(payload) {
  W = payload;
  const { targetCount } = W;
  const classTeacherTargets = new Map();

  const total = STRATEGIES.length;
  let best = null;
  const attemptResults = [];

  for (let i = 0; i < total; i++) {
    const strategy = STRATEGIES[i];
    const strategyForRun = strategy === "BACKTRACK" ? "CLASSIC" : strategy;

    let attempt = await runAttempt({
      strategy: strategyForRun,
      attemptIndex: i + 1,
      attemptTotal: total,
      targetCount,
      classTeacherTargets,
    });

    // Hill climbing sur chaque tentative
    attempt = hillClimb(attempt, strategyForRun, strategy === "DESIDERATA" ? 120 : 60);
    attempt.strategy = strategy;

    attemptResults.push({
      attemptIndex: i+1, strategy,
      score: attempt.score,
      created: attempt.reportData.summary.created,
      remainingHours: attempt.reportData.summary.remainingHours,
    });

    // Progrès vers le thread principal
    self.postMessage({
      type: 'progress',
      attempt: i+1,
      total,
      strategy,
      created: attempt.reportData.summary.created,
      score: attempt.score,
      remainingHours: attempt.reportData.summary.remainingHours,
    });

    if (!best || attempt.score > best.score) {
      best = attempt;
    }
  }

  if (!best) {
    self.postMessage({ type:'error', message:"Aucune tentative exploitable." });
    return;
  }

  best.reportData.attemptResults = attemptResults;
  self.postMessage({ type:'result', best });
}

// ─── Point d'entrée ──────────────────────────────────────────────────────────
self.onmessage = async (e) => {
  if (e.data?.type === 'run') {
    try {
      await generate(e.data.payload);
    } catch (err) {
      self.postMessage({ type:'error', message: String(err?.message || err) });
    }
  }
};
