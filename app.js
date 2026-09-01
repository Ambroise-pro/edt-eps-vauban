import firebase from 'firebase/compat/app';
import 'firebase/compat/firestore';
import 'firebase/compat/auth';
import 'firebase/compat/storage';
import 'firebase/compat/functions';
import html2canvas from 'html2canvas';
import { jsPDF } from 'jspdf';
import 'jspdf-autotable';
import * as XLSX from 'xlsx';
import { initPWAUpdateHandler } from './src/pwa-update.js';

const firebaseConfig = {
  apiKey: "AIzaSyChbqOpu-VoGGkmjYptCl0usloYQ1FtSVM",
  authDomain: "emploi-du-temps-1644e.firebaseapp.com",
  projectId: "emploi-du-temps-1644e",
  storageBucket: "emploi-du-temps-1644e.firebasestorage.app",
  messagingSenderId: "84122131462",
  appId: "1:84122131462:web:0648cc735811498c357787",
  measurementId: "G-1Q81J5JYX8",
};

firebase.initializeApp(firebaseConfig);
const db = firebase.firestore();
db.settings({
  experimentalAutoDetectLongPolling: true,
  useFetchStreams: false,
  merge: true,
});

const addDoc = (collectionRef, data) => collectionRef.add(data);
const collection = (dbRef, name) => dbRef.collection(name);
const deleteDoc = (docRef) => docRef.delete();
const doc = (dbRef, name, id) => dbRef.collection(name).doc(id);
const getDoc = (docRef) => docRef.get();
const onSnapshot = (queryRef, callback, errorCallback) =>
  queryRef.onSnapshot(
    callback,
    (error) => {
      console.error("Firestore snapshot error:", error);
      if (typeof errorCallback === "function") errorCallback(error);
    }
  );
const setDoc = (docRef, data, options) => docRef.set(data, options);
const updateDoc = (docRef, data) => docRef.update(data);
const serverTimestamp = () => firebase.firestore.FieldValue.serverTimestamp();

const DAYS = ["Lundi", "Mardi", "Mercredi", "Jeudi", "Vendredi"];
const SLOTS = ["08:15", "09:05", "10:20", "11:10", "12:10", "13:00", "14:00", "15:00", "16:05", "16:55"];
const SLOT_BANDS = [
  { label: "08h15 à 10h00", start: "08:15", end: "10:00", slots: ["08:15", "09:05"] },
  { label: "10h20 à 12h05", start: "10:20", end: "12:05", slots: ["10:20", "11:10"] },
  { label: "12h10 à 13h00", start: "12:10", end: "13:00", slots: ["12:10"] },
  { label: "13h00 à 14h00", start: "13:00", end: "14:00", slots: ["13:00"] },
  { label: "14h00 à 16h00", start: "14:00", end: "16:00", slots: ["14:00", "15:00"] },
  // Bande "15:00" uniquement pour l'affichage vendredi (grille display).
  // Invisible sur Lun-Jeu (getSlotBandsForDay filtre fridayOnly).
  { label: "15h - 17h",     start: "15:00", end: "17:00", slots: ["15:00", "16:05"], fridayOnly: true },
  { label: "16h05 à 17h50", start: "16:05", end: "17:50", slots: ["16:05", "16:55"] },
];
// Bandes spécifiques au vendredi après-midi (13h-15h et 15h-17h)
const FRIDAY_AFTERNOON_BANDS = [
  { label: "13h - 15h", start: "13:00", end: "15:00", slots: ["13:00", "14:00"] },
  { label: "15h - 17h", start: "15:00", end: "17:00", slots: ["15:00", "16:05"] },
];
// Starts toujours interdits comme début de session (ils sont des slots internes des bandes vendredi)
const FRIDAY_DISABLED_BAND_STARTS = new Set(["14:00", "16:05"]);

function isBandStartAllowedOnDay(day, start) {
  if (String(day || "") === "Vendredi" && FRIDAY_DISABLED_BAND_STARTS.has(String(start || ""))) return false;
  return true;
}

function getSlotBandsForDay(day) {
  if (String(day || "") !== "Vendredi") {
    // Lun-Jeu : bandes standard, sans les entrées fridayOnly
    return SLOT_BANDS.filter((b) => !b.fridayOnly);
  }
  // Vendredi matin : bandes identiques aux autres jours (avant 13h, hors fridayOnly)
  const morningBands = SLOT_BANDS.filter((b) => b.start < "13:00" && !b.fridayOnly);
  // Vendredi après-midi : deux blocs de 2h
  return [...morningBands, ...FRIDAY_AFTERNOON_BANDS];
}

// Retourne le label à afficher pour une bande selon le jour
// Vendredi : "13h - 15h" et "15h - 17h" à la place des labels standards
function getBandLabelForDay(band, day) {
  if (!band) return "";
  if (String(day || "") !== "Vendredi") return band.label;
  if (band.start === "13:00") return "13h - 15h ★";
  if (band.start === "15:00") return "15h - 17h ★";
  if (band.start === "14:00" || band.start === "16:05") return "—";
  return band.label;
}
const SPECIAL_ASSIGNMENTS = [
  { id: "__AS__", label: "AS", type: "AS" },
  { id: "__DANSE__", label: "Danse", type: "DANSE" },
];
const LEVEL_RULES = {
  "Sixième": { weeklyHours: 4, hint: "6e: 4h/semaine (2 x 2h)", group: "SIXIEME" },
  "Cinquième": { weeklyHours: 3, hint: "5e: 3h/semaine (créneau de 3h, hebdomadaire)", group: "CINQUIEME" },
  "Quatrième": { weeklyHours: 3, hint: "4e: 3h/semaine (2h hebdo + semaine A/B possible)", group: "ALT_43" },
  "Troisième": { weeklyHours: 3, hint: "3e: 3h/semaine (2h hebdo + semaine A/B possible)", group: "ALT_43" },
  Seconde: { weeklyHours: 2, hint: "2nde/1re/Tle: 2h/semaine", group: "LYCEE" },
  "Première": { weeklyHours: 2, hint: "2nde/1re/Tle: 2h/semaine", group: "LYCEE" },
  Terminale: { weeklyHours: 2, hint: "2nde/1re/Tle: 2h/semaine", group: "LYCEE" },
};

// ─── Système de toasts (remplace les alert()) ────────────────────────────────
let _toastContainer = null;
function getToastContainer() {
  if (!_toastContainer) {
    _toastContainer = document.createElement("div");
    _toastContainer.id = "toast-container";
    _toastContainer.setAttribute("aria-live", "polite");
    document.body.appendChild(_toastContainer);
  }
  return _toastContainer;
}

function showToast(message, type = "info", duration = 4000) {
  const container = getToastContainer();
  const toast = document.createElement("div");
  toast.className = `toast toast-${type}`;
  const icons = { success: "check_circle", error: "error", info: "info", warning: "warning" };
  toast.innerHTML = `<span class="material-symbols-outlined toast-icon">${icons[type] || "info"}</span><span class="toast-msg">${message}</span><button class="toast-close" aria-label="Fermer">&times;</button>`;
  toast.querySelector(".toast-close").addEventListener("click", () => toast.remove());
  container.appendChild(toast);
  requestAnimationFrame(() => toast.classList.add("toast-visible"));
  if (duration > 0) setTimeout(() => { toast.classList.remove("toast-visible"); setTimeout(() => toast.remove(), 300); }, duration);
  return toast;
}

// ─── Historique des modifications ───────────────────────────────────────────
async function logActivity(action, details = {}) {
  try {
    const user = firebase.auth().currentUser;
    await db.collection("activityLog").add({
      action,
      details,
      userEmail: user?.email || "anonymous",
      userName: user?.displayName || details.teacherName || "inconnu",
      createdAt: serverTimestamp(),
    });
  } catch (e) {
    console.warn("logActivity failed:", e);
  }
}

// ─── Notifications temps réel ────────────────────────────────────────────────
let _notifUnsubscribe = null;
let _notifSessionSnapshot = null;

function startRealtimeNotifications(teacherId) {
  stopRealtimeNotifications();
  if (!teacherId) return;
  _notifSessionSnapshot = db.collection("sessions")
    .where("teacherId", "==", teacherId)
    .onSnapshot((snap) => {
      snap.docChanges().forEach((change) => {
        if (change.type === "modified") {
          const s = change.doc.data();
          showToast(`Créneau modifié : ${s.day || ""} ${s.startTime || ""} – ${s.className || ""}`, "info");
        } else if (change.type === "removed") {
          showToast(`Créneau supprimé de votre planning.`, "warning");
        }
      });
    }, () => {});
  _notifUnsubscribe = () => { if (_notifSessionSnapshot) _notifSessionSnapshot(); };
}

function stopRealtimeNotifications() {
  if (_notifUnsubscribe) { _notifUnsubscribe(); _notifUnsubscribe = null; }
}

const ui = {
  publicModeBtn: document.getElementById("publicModeBtn"),
  adminModeBtn: document.getElementById("adminModeBtn"),
  desiderataModeBtn: document.getElementById("desiderataModeBtn"),
  publicSection: document.getElementById("publicSection"),
  desiderataSection: document.getElementById("desiderataSection"),
  adminSection: document.getElementById("adminSection"),
  adminShell: document.getElementById("adminShell"),
  adminTabCreationBtn: document.getElementById("adminTabCreationBtn"),
  adminTabAssignBtn: document.getElementById("adminTabAssignBtn"),
  adminTabProgramBtn: document.getElementById("adminTabProgramBtn"),
  adminTabAIBtn: document.getElementById("adminTabAIBtn"),
  adminTabAlgoBtn: document.getElementById("adminTabAlgoBtn"),
  adminTabBusBtn: document.getElementById("adminTabBusBtn"),
  adminTabManageBtn: document.getElementById("adminTabManageBtn"),
  adminTabAbsenceBtn: document.getElementById("adminTabAbsenceBtn"),
  adminTabEmailTemplatesBtn: document.getElementById("adminTabEmailTemplatesBtn"),
  adminEmailTemplatesPanel: document.getElementById("adminEmailTemplatesPanel"),
  emailTemplateSelect: document.getElementById("emailTemplateSelect"),
  emailTemplateCode: document.getElementById("emailTemplateCode"),
  emailTemplatePreview: document.getElementById("emailTemplatePreview"),
  emailTemplateSaveBtn: document.getElementById("emailTemplateSaveBtn"),
  emailTemplateResetBtn: document.getElementById("emailTemplateResetBtn"),
  adminTabSchoolYearBtn: document.getElementById("adminTabSchoolYearBtn"),
  adminDataMenu: document.getElementById("adminDataMenu"),
  adminTabSwimBtn: document.getElementById("adminTabSwimBtn"),
  adminTabRecapBtn: document.getElementById("adminTabRecapBtn"),
  adminTabRepartitionBtn: document.getElementById("adminTabRepartitionBtn"),
  adminTabRightsBtn: document.getElementById("adminTabRightsBtn"),
  adminTabInventoryBtn: document.getElementById("adminTabInventoryBtn"),
  adminCreationPanel: document.getElementById("adminCreationPanel"),
  creationSubtabTeacherBtn: document.getElementById("creationSubtabTeacherBtn"),
  creationSubtabClassBtn: document.getElementById("creationSubtabClassBtn"),
  creationSubpanelTeacher: document.getElementById("creationSubpanelTeacher"),
  creationSubpanelClass: document.getElementById("creationSubpanelClass"),
  adminAssignPanel: document.getElementById("adminAssignPanel"),
  adminProgramPanel: document.getElementById("adminProgramPanel"),
  adminAIPanel: document.getElementById("adminAIPanel"),
  adminAlgoPanel: document.getElementById("adminAlgoPanel"),
  programSubtabProgrammingBtn: document.getElementById("programSubtabProgrammingBtn"),
  programSubtabActivityBtn: document.getElementById("programSubtabActivityBtn"),
  programSubtabLocationBtn: document.getElementById("programSubtabLocationBtn"),
  programSubtabPeriodsBtn: document.getElementById("programSubtabPeriodsBtn"),
  programSubpanelProgramming: document.getElementById("programSubpanelProgramming"),
  programSubpanelActivity: document.getElementById("programSubpanelActivity"),
  programSubpanelLocation: document.getElementById("programSubpanelLocation"),
  programSubpanelPeriods: document.getElementById("programSubpanelPeriods"),
  adminBusPanel: document.getElementById("adminBusPanel"),
  busCreateNewOrderBtn: document.getElementById("busCreateNewOrderBtn"),
  busOrdersHistoryContainer: document.getElementById("busOrdersHistoryContainer"),
  adminManagePanel: document.getElementById("adminManagePanel"),
  adminAbsencePanel: document.getElementById("adminAbsencePanel"),
  adminSchoolYearPanel: document.getElementById("adminSchoolYearPanel"),
  adminSwimPanel: document.getElementById("adminSwimPanel"),
  adminRecapPanel: document.getElementById("adminRecapPanel"),
  adminRepartitionPanel: document.getElementById("adminRepartitionPanel"),
  repartitionApportsContainer: document.getElementById("repartitionApportsContainer"),
  repartitionBesoinsContainer: document.getElementById("repartitionBesoinsContainer"),
  repartitionResetBtn: document.getElementById("repartitionResetBtn"),
  repartitionExportBtn: document.getElementById("repartitionExportBtn"),
  repartitionExportExcelBtn: document.getElementById("repartitionExportExcelBtn"),
  repartitionExportImageBtn: document.getElementById("repartitionExportImageBtn"),
  adminRightsPanel: document.getElementById("adminRightsPanel"),
  adminInventoryPanel: document.getElementById("adminInventoryPanel"),
  adminRightsContainer: document.getElementById("adminRightsContainer"),
  schoolYearScopeSelect: document.getElementById("schoolYearScopeSelect"),
  schoolYearBadgeMobile: document.getElementById("schoolYearBadgeMobile"),
  schoolYearSelectorModal: document.getElementById("schoolYearSelectorModal"),
  schoolYearSelectorList: document.getElementById("schoolYearSelectorList"),
  schoolYearSelectorCloseBtn: document.getElementById("schoolYearSelectorCloseBtn"),
  appMain: document.querySelector(".app-main"),
  publicTeacherSelect: document.getElementById("publicTeacherSelect"),
  publicTeacherSummary: document.getElementById("publicTeacherSummary"),
  publicDashboardTitle: document.getElementById("publicDashboardTitle"),
  publicDashboardIntro: document.getElementById("publicDashboardIntro"),
  publicDashboardStats: document.getElementById("publicDashboardStats"),
  publicPrevWeekBtn: document.getElementById("publicPrevWeekBtn"),
  publicCurrentWeekBtn: document.getElementById("publicCurrentWeekBtn"),
  publicNextWeekBtn: document.getElementById("publicNextWeekBtn"),
  publicWeekDate: document.getElementById("publicWeekDate"),
  publicWeekLabel: document.getElementById("publicWeekLabel"),
  publicWeekMeta: document.getElementById("publicWeekMeta"),
  publicAbsenceSummary: document.getElementById("publicAbsenceSummary"),
  publicOpenReplacementModalBtn: document.getElementById("publicOpenReplacementModalBtn"),
  publicAbsenceRequestsContainer: document.getElementById("publicAbsenceRequestsContainer"),
  publicReplacementModal: document.getElementById("publicReplacementModal"),
  publicReplacementModalContext: document.getElementById("publicReplacementModalContext"),
  publicReplacementModalBody: document.getElementById("publicReplacementModalBody"),
  publicReplacementModalCloseBtn: document.getElementById("publicReplacementModalCloseBtn"),
  publicTimetableContainer: document.getElementById("publicTimetableContainer"),
  desiderataTeacherSelect: document.getElementById("desiderataTeacherSelect"),
  desiderataYearBadge: document.getElementById("desiderataYearBadge"),
  desiderataHint: document.getElementById("desiderataHint"),
  desiderataGridContainer: document.getElementById("desiderataGridContainer"),
  desiderataComment: document.getElementById("desiderataComment"),
  desiderataPreferredHours: document.getElementById("desiderataPreferredHours"),
  desiderataUnavailableBlocks: document.getElementById("desiderataUnavailableBlocks"),
  desiderataTargetHours: document.getElementById("desiderataTargetHours"),
  desiderataPlannedLevelsContainer: document.getElementById("desiderataPlannedLevelsContainer"),
  desiderataDayOffSelect: document.getElementById("desiderataDayOffSelect"),
  desiderataApplyDayOffBtn: document.getElementById("desiderataApplyDayOffBtn"),
  desiderataClearDayOffBtn: document.getElementById("desiderataClearDayOffBtn"),
  desiderataClearBtn: document.getElementById("desiderataClearBtn"),
  desiderataSaveBtn: document.getElementById("desiderataSaveBtn"),
  desiderataSubmitBtn: document.getElementById("desiderataSubmitBtn"),
  adminSidebarToggleBtn: document.getElementById("adminSidebarToggleBtn"),
  adminSidebarCollapseBtn: document.getElementById("adminSidebarCollapseBtn"),
  adminSidebarCloseBtn: document.getElementById("adminSidebarCloseBtn"),
  adminSidebarOverlay: document.getElementById("adminSidebarOverlay"),
  adminTabsHorizontal: document.querySelector(".admin-tabs-horizontal"),
  teacherForm: document.getElementById("teacherForm"),
  teacherEditSelect: document.getElementById("teacherEditSelect"),
  teacherName: document.getElementById("teacherName"),
  teacherEmail: document.getElementById("teacherEmail"),
  teacherAbbreviation: document.getElementById("teacherAbbreviation"),
  teacherMaxHours: document.getElementById("teacherMaxHours"),
  teacherColor: document.getElementById("teacherColor"),
  teacherSubmitBtn: document.getElementById("teacherSubmitBtn"),
  teacherCancelEditBtn: document.getElementById("teacherCancelEditBtn"),
  magicLinkSection: document.getElementById("magicLinkSection"),
  teacherMagicLink: document.getElementById("teacherMagicLink"),
  generateMagicLinkBtn: document.getElementById("generateMagicLinkBtn"),
  copyMagicLinkBtn: document.getElementById("copyMagicLinkBtn"),
  teacherConstraintsGrid: document.getElementById("teacherConstraintsGrid"),
  classForm: document.getElementById("classForm"),
  classLevel: document.getElementById("classLevel"),
  classCount: document.getElementById("classCount"),
  classWeeklyHours: document.getElementById("classWeeklyHours"),
  classRuleHint: document.getElementById("classRuleHint"),
  classCreateInfo: document.getElementById("classCreateInfo"),
  sessionError: document.getElementById("sessionError"),
  plannerGrid: document.getElementById("plannerGrid"),
  assignTeacherMiniatures: document.getElementById("assignTeacherMiniatures"),
  assignComparisonArea: document.getElementById("assignComparisonArea"),
  assignGlobalLargeArea: document.getElementById("assignGlobalLargeArea"),
  assignWorkspace: document.getElementById("assignWorkspace"),
  assignModeViewBtn: document.getElementById("assignModeViewBtn"),
  assignModeAssignBtn: document.getElementById("assignModeAssignBtn"),
  assignModeReorganizeBtn: document.getElementById("assignModeReorganizeBtn"),
  assignFilterTeacherSelect: document.getElementById("assignFilterTeacherSelect"),
  assignFilterLevelSelect: document.getElementById("assignFilterLevelSelect"),
  assignFilterConflictsOnly: document.getElementById("assignFilterConflictsOnly"),
  assignContextPanel: document.getElementById("assignContextPanel"),
  toggleFullscreenBtn: document.getElementById("toggleFullscreenBtn"),
  adminPlannerHint: null,
  adminPlannerContainer: null,
  globalWeekType: document.getElementById("globalWeekType"),
  globalPlannerLayout: document.getElementById("globalPlannerLayout"),
  globalPlannerHint: document.getElementById("globalPlannerHint"),
  globalPlannerContainer: document.getElementById("globalPlannerContainer"),
  teachersList: document.getElementById("teachersList"),
  classesList: document.getElementById("classesList"),
  creationClassesTableBody: document.getElementById("creationClassesTableBody"),
  sessionsList: document.getElementById("sessionsList"),
  absenceForm: document.getElementById("absenceForm"),
  absenceTeacherSelect: document.getElementById("absenceTeacherSelect"),
  absenceStartDate: document.getElementById("absenceStartDate"),
  absenceEndDate: document.getElementById("absenceEndDate"),
  absenceReason: document.getElementById("absenceReason"),
  absenceSubmitBtn: document.getElementById("absenceSubmitBtn"),
  absenceHint: document.getElementById("absenceHint"),
  absenceListContainer: document.getElementById("absenceListContainer"),
  absenceDetailsContainer: document.getElementById("absenceDetailsContainer"),
  replacementPlansContainer: document.getElementById("replacementPlansContainer"),
  replacementEmailTo: document.getElementById("replacementEmailTo"),
  replacementComposeMailBtn: document.getElementById("replacementComposeMailBtn"),
  replacementCopyMailHtmlBtn: document.getElementById("replacementCopyMailHtmlBtn"),
  replacementMailPreview: document.getElementById("replacementMailPreview"),
  replacementMailHtmlPreview: document.getElementById("replacementMailHtmlPreview"),
  absenceOffersContainer: document.getElementById("absenceOffersContainer"),
  schoolYearStartDate: document.getElementById("schoolYearStartDate"),
  schoolYearEndDate: document.getElementById("schoolYearEndDate"),
  schoolYearAddVacationBtn: document.getElementById("schoolYearAddVacationBtn"),
  schoolYearVacationsContainer: document.getElementById("schoolYearVacationsContainer"),
  schoolYearAddHolidayBtn: document.getElementById("schoolYearAddHolidayBtn"),
  schoolYearHolidaysContainer: document.getElementById("schoolYearHolidaysContainer"),
  schoolYearWeeksContainer: document.getElementById("schoolYearWeeksContainer"),
  schoolYearTeachersContainer: document.getElementById("schoolYearTeachersContainer"),
  schoolYearSaveBtn: document.getElementById("schoolYearSaveBtn"),
  schoolYearIsPublishedCheck: document.getElementById("schoolYearIsPublishedCheck"),
  schoolYearPublishBtn: document.getElementById("schoolYearPublishBtn"),
  schoolYearHint: document.getElementById("schoolYearHint"),
  desiderataConfigYearSelect: document.getElementById("desiderataConfigYearSelect"),
  desiderataConfigEnabled: document.getElementById("desiderataConfigEnabled"),
  desiderataConfigSaveBtn: document.getElementById("desiderataConfigSaveBtn"),
  swimHint: document.getElementById("swimHint"),
  swimPlannerContainer: document.getElementById("swimPlannerContainer"),
  adminRecapContainer: document.getElementById("adminRecapContainer"),
  inventoryForm: document.getElementById("inventoryForm"),
  inventoryItemName: document.getElementById("inventoryItemName"),
  inventoryItemSuggestions: document.getElementById("inventoryItemSuggestions"),
  inventoryCount: document.getElementById("inventoryCount"),
  inventoryDate: document.getElementById("inventoryDate"),
  inventorySummaryContainer: document.getElementById("inventorySummaryContainer"),
  inventoryHistoryContainer: document.getElementById("inventoryHistoryContainer"),
  assignClassesToPlace: document.getElementById("assignClassesToPlace"),
  assignEditLettersBtn: document.getElementById("assignEditLettersBtn"),
  inviteConsultEdtBtn: document.getElementById("inviteConsultEdtBtn"),
  exportEdtGlobalPdfBtn: document.getElementById("exportEdtGlobalPdfBtn"),
  exportEdtGlobalExcelBtn: document.getElementById("exportEdtGlobalExcelBtn"),
  exportEdtIndividualPdfBtn: document.getElementById("exportEdtIndividualPdfBtn"),
  exportEdtIndividualExcelBtn: document.getElementById("exportEdtIndividualExcelBtn"),
  openRepartitionPopupBtn: document.getElementById("openRepartitionPopupBtn"),
  openAssignmentVerificationBtn: document.getElementById("openAssignmentVerificationBtn"),
  repartitionPopupModal: document.getElementById("repartitionPopupModal"),
  repartitionPopupClose: document.getElementById("repartitionPopupClose"),
  repartitionPopupContent: document.getElementById("repartitionPopupContent"),
  floatingAssignContainer: document.getElementById("floatingAssignContainer"),
  floatingAssignToggle: document.getElementById("floatingAssignToggle"),
  floatingAssignBadge: document.getElementById("floatingAssignBadge"),
  closeFloatingBtn: document.getElementById("closeFloatingBtn"),
  programWeekType: document.getElementById("programWeekType"),
  programDaySelect: document.getElementById("programDaySelect"),
  programHint: document.getElementById("programHint"),
  programFilterTeacher: document.getElementById("programFilterTeacher"),
  programFilterPeriod: document.getElementById("programFilterPeriod"),
  programAnnualVisualContainer: document.getElementById("programAnnualVisualContainer"),
  programPlannerContainer: document.getElementById("programPlannerContainer"),
  programActivitiesList: document.getElementById("programActivitiesList"),
  programLocationsList: document.getElementById("programLocationsList"),
  programActivityLabel: document.getElementById("programActivityLabel"),
  programActivityCode: document.getElementById("programActivityCode"),
  programActivityPreferredLocationSelect: document.getElementById("programActivityPreferredLocationSelect"),
  programAddActivityBtn: document.getElementById("programAddActivityBtn"),
  programHighlightPendingBtn: document.getElementById("programHighlightPendingBtn"),
  programResetPlanningBtn: document.getElementById("programResetPlanningBtn"),
  programLocationName: document.getElementById("programLocationName"),
  programAddLocationBtn: document.getElementById("programAddLocationBtn"),
  programStats: document.getElementById("programStats"),
  programTrim1Start: document.getElementById("programTrim1Start"),
  programTrim1End: document.getElementById("programTrim1End"),
  programTrim2Start: document.getElementById("programTrim2Start"),
  programTrim2End: document.getElementById("programTrim2End"),
  programTrim3Start: document.getElementById("programTrim3Start"),
  programTrim3End: document.getElementById("programTrim3End"),
  programSem1Start: document.getElementById("programSem1Start"),
  programSem1End: document.getElementById("programSem1End"),
  programSem2Start: document.getElementById("programSem2Start"),
  programSem2End: document.getElementById("programSem2End"),
  programSavePeriodsBtn: document.getElementById("programSavePeriodsBtn"),
  programPeriodsInfo: document.getElementById("programPeriodsInfo"),
  programClassPlanContainer: document.getElementById("programClassPlanContainer"),
  busHint: document.getElementById("busHint"),
  busPlannerContainer: document.getElementById("busPlannerContainer"),
  busEmailTo: document.getElementById("busEmailTo"),
  busComposeMailBtn: document.getElementById("busComposeMailBtn"),
  busCopyMailBtn: document.getElementById("busCopyMailBtn"),
  busMailPreview: document.getElementById("busMailPreview"),
  aiGeminiApiKey: document.getElementById("aiGeminiApiKey"),
  aiGeminiModel: document.getElementById("aiGeminiModel"),
  aiGenerationTargetCount: document.getElementById("aiGenerationTargetCount"),
  aiReplaceExistingSessions: document.getElementById("aiReplaceExistingSessions"),
  aiConstraintDraft: document.getElementById("aiConstraintDraft"),
  aiAddConstraintBtn: document.getElementById("aiAddConstraintBtn"),
  aiConstraintsList: document.getElementById("aiConstraintsList"),
  aiFillDefaultConstraintsBtn: document.getElementById("aiFillDefaultConstraintsBtn"),
  aiSaveConstraintsBtn: document.getElementById("aiSaveConstraintsBtn"),
  aiConstraintsStatus: document.getElementById("aiConstraintsStatus"),
  aiGenerateEdtBtn: document.getElementById("aiGenerateEdtBtn"),
  aiPromptPreview: document.getElementById("aiPromptPreview"),
  aiGenerationStatus: document.getElementById("aiGenerationStatus"),
  aiGenerationReport: document.getElementById("aiGenerationReport"),
  algoGenerationTargetCount: document.getElementById("algoGenerationTargetCount"),
  algoReplaceExistingSessions: document.getElementById("algoReplaceExistingSessions"),
  algoPinnedClassSelect: document.getElementById("algoPinnedClassSelect"),
  algoPinnedDaySelect: document.getElementById("algoPinnedDaySelect"),
  algoPinnedSlotSelect: document.getElementById("algoPinnedSlotSelect"),
  algoPinnedCadenceSelect: document.getElementById("algoPinnedCadenceSelect"),
  algoAddPinnedClassBtn: document.getElementById("algoAddPinnedClassBtn"),
  algoPinnedClassesList: document.getElementById("algoPinnedClassesList"),
  algoConstraintDraft: document.getElementById("algoConstraintDraft"),
  algoAddConstraintBtn: document.getElementById("algoAddConstraintBtn"),
  algoConstraintsList: document.getElementById("algoConstraintsList"),
  algoBlockedSlotsContainer: document.getElementById("algoBlockedSlotsContainer"),
  algoSaveConstraintsBtn: document.getElementById("algoSaveConstraintsBtn"),
  algoConstraintsStatus: document.getElementById("algoConstraintsStatus"),
  algoActiveRulesPanel: document.getElementById("algoActiveRulesPanel"),
  algoClearExistingSessionsBtn: document.getElementById("algoClearExistingSessionsBtn"),
  algoClearAllSessionsBtn: document.getElementById("algoClearAllSessionsBtn"),
  algoGenerateEdtBtn: document.getElementById("algoGenerateEdtBtn"),
  algoApplyProposalBtn: document.getElementById("algoApplyProposalBtn"),
  algoGenerationStatus: document.getElementById("algoGenerationStatus"),
  algoGenerationReport: document.getElementById("algoGenerationReport"),
  assignModal: document.getElementById("assignModal"),
  assignModalTitle: document.getElementById("assignModalTitle"),
  assignModalContext: document.getElementById("assignModalContext"),
  assignModalTeacherRow: document.getElementById("assignModalTeacherRow"),
  assignModalTeacherSelect: document.getElementById("assignModalTeacherSelect"),
  assignModalLevelSelect: document.getElementById("assignModalLevelSelect"),
  assignModalClassSelect: document.getElementById("assignModalClassSelect"),
  assignModalCadenceSelect: document.getElementById("assignModalCadenceSelect"),
  assignModalHint: document.getElementById("assignModalHint"),
  assignModalCancelBtn: document.getElementById("assignModalCancelBtn"),
  assignModalConfirmBtn: document.getElementById("assignModalConfirmBtn"),
  cadenceChoiceModal: document.getElementById("cadenceChoiceModal"),
  cadenceChoiceModalTitle: document.getElementById("cadenceChoiceModalTitle"),
  cadenceChoiceModalText: document.getElementById("cadenceChoiceModalText"),
  cadenceChoiceModalOptions: document.getElementById("cadenceChoiceModalOptions"),
  cadenceChoiceModalCancelBtn: document.getElementById("cadenceChoiceModalCancelBtn"),
  programRoomsModal: document.getElementById("programRoomsModal"),
  programRoomsModalTitle: document.getElementById("programRoomsModalTitle"),
  programRoomsModalContext: document.getElementById("programRoomsModalContext"),
  programRoomsModalBody: document.getElementById("programRoomsModalBody"),
  programRoomsModalCloseBtn: document.getElementById("programRoomsModalCloseBtn"),
  programPickModal: document.getElementById("programPickModal"),
  programPickModalTitle: document.getElementById("programPickModalTitle"),
  programPickModalContext: document.getElementById("programPickModalContext"),
  programPickModalList: document.getElementById("programPickModalList"),
  programPickModalCloseBtn: document.getElementById("programPickModalCloseBtn"),
  loginBtn: document.getElementById("loginBtn"),
  logoutBtn: document.getElementById("logoutBtn"),
  userInfo: document.getElementById("userInfo"),
  userDisplayName: document.getElementById("userDisplayName"),
  loginModal: document.getElementById("loginModal"),
  loginForm: document.getElementById("loginForm"),
  loginEmail: document.getElementById("loginEmail"),
  loginPassword: document.getElementById("loginPassword"),
  loginError: document.getElementById("loginError"),
  loginMessage: document.getElementById("loginMessage"),
  forgotPasswordBtn: document.getElementById("forgotPasswordBtn"),
  closeLoginBtn: document.getElementById("closeLoginBtn"),

  // Tasks UI
  adminTasksPanel: document.getElementById("adminTasksPanel"),
  adminTabTasksBtn: document.getElementById("adminTabTasksBtn"),
  tasksCreateBtn: document.getElementById("tasksCreateBtn"),
  tasksFilterCategory: document.getElementById("tasksFilterCategory"),
  tasksColumnA_FAIRE: document.getElementById("tasksColumnA_FAIRE"),
  tasksColumnEN_COURS: document.getElementById("tasksColumnEN_COURS"),
  tasksColumnTERMINEE: document.getElementById("tasksColumnTERMINEE"),
  tasksCountA_FAIRE: document.getElementById("tasksCountA_FAIRE"),
  tasksCountEN_COURS: document.getElementById("tasksCountEN_COURS"),
  tasksCountTERMINEE: document.getElementById("tasksCountTERMINEE"),
  tasksEditModal: document.getElementById("tasksEditModal"),
  tasksEditModalTitle: document.getElementById("tasksEditModalTitle"),
  tasksEditModalClose: document.getElementById("tasksEditModalClose"),
  tasksEditForm: document.getElementById("tasksEditForm"),
  tasksEditTitle: document.getElementById("tasksEditTitle"),
  tasksEditDescription: document.getElementById("tasksEditDescription"),
  tasksEditPriority: document.getElementById("tasksEditPriority"),
  tasksEditCategory: document.getElementById("tasksEditCategory"),
  tasksEditDueDate: document.getElementById("tasksEditDueDate"),
  tasksEditAssignedTeachers: document.getElementById("tasksEditAssignedTeachers"),
  tasksEditSaveBtn: document.getElementById("tasksEditSaveBtn"),
  tasksEditCancelBtn: document.getElementById("tasksEditCancelBtn"),
  tasksEditDeleteBtn: document.getElementById("tasksEditDeleteBtn"),
  tasksDetailsModal: document.getElementById("tasksDetailsModal"),
  tasksDetailsTitle: document.getElementById("tasksDetailsTitle"),
  tasksDetailsModalClose: document.getElementById("tasksDetailsModalClose"),
  tasksDetailsContent: document.getElementById("tasksDetailsContent"),
  tasksDetailsMarkDoneBtn: document.getElementById("tasksDetailsMarkDoneBtn"),
  tasksDetailsCloseBtn: document.getElementById("tasksDetailsCloseBtn"),
  tasksNotificationModal: document.getElementById("tasksNotificationModal"),
  tasksNotificationContent: document.getElementById("tasksNotificationContent"),
  tasksNotificationCloseBtn: document.getElementById("tasksNotificationCloseBtn"),
  tasksMyTasksModal: document.getElementById("tasksMyTasksModal"),
  tasksMyTasksContent: document.getElementById("tasksMyTasksContent"),
  tasksMyTasksModalClose: document.getElementById("tasksMyTasksModalClose"),
  tasksMyTasksCloseBtn: document.getElementById("tasksMyTasksCloseBtn"),

  // Notifications
  tasksNotificationBellBtn: document.getElementById("tasksNotificationBellBtn"),
  tasksNotificationBadge: document.getElementById("tasksNotificationBadge"),
  notificationPreferencesBtn: document.getElementById("notificationPreferencesBtn"),

  // Notification Preferences
  notificationPreferencesModal: document.getElementById("notificationPreferencesModal"),
  notificationPreferencesClose: document.getElementById("notificationPreferencesClose"),
  notifTaskAssigned: document.getElementById("notifTaskAssigned"),
  notifTaskStatusChange: document.getElementById("notifTaskStatusChange"),
  notifComments: document.getElementById("notifComments"),
  notifDeadlineReminder: document.getElementById("notifDeadlineReminder"),
  notifReplacements: document.getElementById("notifReplacements"),
  userEmailDisplay: document.getElementById("userEmailDisplay"),
  notificationTestEmailBtn: document.getElementById("notificationTestEmailBtn"),
  notificationSaveBtn: document.getElementById("notificationSaveBtn"),

  // Comments
  tasksCommentsList: document.getElementById("tasksCommentsList"),
  tasksCommentInput: document.getElementById("tasksCommentInput"),
  tasksAddCommentBtn: document.getElementById("tasksAddCommentBtn"),
  tasksMarkInProgressBtn: document.getElementById("tasksMarkInProgressBtn"),
  tasksMarkDoneBtn: document.getElementById("tasksMarkDoneBtn"),
  tasksCommentsSection: document.getElementById("tasksCommentsSection"),

  // Steps
  tasksStepsList: document.getElementById("tasksStepsList"),
  tasksNewStepInput: document.getElementById("tasksNewStepInput"),
  tasksAddStepBtn: document.getElementById("tasksAddStepBtn"),
  tasksStepsSection: document.getElementById("tasksStepsSection"),
  tasksDetailsEditBtn: document.getElementById("tasksDetailsEditBtn"),

  // Documents
  adminDocumentsPanel: document.getElementById("adminDocumentsPanel"),
  adminTabDocumentsBtn: document.getElementById("adminTabDocumentsBtn"),
  documentsNewFolderName: document.getElementById("documentsNewFolderName"),
  documentsCreateFolderBtn: document.getElementById("documentsCreateFolderBtn"),
  documentsFoldersList: document.getElementById("documentsFoldersList"),
  documentsCurrentFolderName: document.getElementById("documentsCurrentFolderName"),
  documentsContent: document.getElementById("documentsContent"),
  documentsUploadZone: document.getElementById("documentsUploadZone"),
  documentsSelectFileBtn: document.getElementById("documentsSelectFileBtn"),
  documentsFileInput: document.getElementById("documentsFileInput"),
  documentsFilesList: document.getElementById("documentsFilesList"),
  documentsDeleteFolderBtn: document.getElementById("documentsDeleteFolderBtn"),
  documentsRenameFolderBtn: document.getElementById("documentsRenameFolderBtn"),
  documentsPreviewModal: document.getElementById("documentsPreviewModal"),
  documentsPreviewTitle: document.getElementById("documentsPreviewTitle"),
  documentsPreviewContent: document.getElementById("documentsPreviewContent"),
  documentsPreviewDownloadBtn: document.getElementById("documentsPreviewDownloadBtn"),
  documentsPreviewModalClose: document.getElementById("documentsPreviewModalClose"),
  documentsPreviewCloseBtn: document.getElementById("documentsPreviewCloseBtn"),
  documentsRenameFolderModal: document.getElementById("documentsRenameFolderModal"),
  documentsRenameFolderInput: document.getElementById("documentsRenameFolderInput"),
  documentsRenameFolderCancelBtn: document.getElementById("documentsRenameFolderCancelBtn"),
  documentsRenameFolderSaveBtn: document.getElementById("documentsRenameFolderSaveBtn"),
};

const state = {
  currentUser: null,
  allTeachers: [],
  teachers: [],
  classes: [],
  sessions: [],
  swimSlots: [],
  swimSlotKeys: new Set(),
  programActivities: [],
  programLocations: [],
  programPeriods: {},
  classActivityPlans: [],
  userRights: [],
  inventory: [],
  absences: [],
  replacements: [],
  replacementOffers: [],
  replacementSelectionByAbsence: {},
  busOrders: [],
  schoolYearConfig: {},
  desiderataConfig: { yearId: "", enabled: false },
  activeSchoolYearId: localStorage.getItem("activeSchoolYearId") || getDefaultSchoolYearId(),
  legacySchoolYearId: localStorage.getItem("legacySchoolYearId") || getDefaultSchoolYearId(),
  selectedAbsenceId: "",
  selectedInventoryItem: "",
  currentUserRole: "SUPER_ADMIN",
  currentUserTeacherId: "",
  selectedProgramWeekType: "A",
  selectedProgramDay: "Lundi",
  selectedProgramSubTab: "programming",
  desiderataSlots: [],
  desiderataSlotStatus: new Map(),
  desiderataCommentsByTeacher: new Map(),
  desiderataDraft: new Map(),
  desiderataCommentDraft: "",
  desiderataCommentDraftTeacherId: "",
  desiderataDraftTeacherId: "",
  desiderataDirty: false,
  desiderataPaintStatus: null,
  desiderataPointerDown: false,
  desiderataMouseupBound: false,
  selectedPublicTeacherId: "__ALL__",
  selectedPublicWeekStart: "",
  selectedAffectationWeekStart: "",
  selectedDesiderataTeacherId: "",
  editingTeacherId: "",
  selectedAdminTeacherId: "",
  comparingTeacherIds: [],
  isAssignFullscreen: false,
  selectedAdminTeacherIds: [],
  showGlobalPlanner: true,
  selectedGlobalWeekType: "A",
  selectedGlobalPlannerLayout: "GRID",
  assignMode: "assign",
  assignFilters: {
    teacherId: "",
    level: "",
    conflictsOnly: false,
  },
  assignSelection: null,
  globalPicker: null,
  assignModal: null,
  selectedAdminTab: "recap",
  assignLettersEditMode: false,
  assignLetterDraftByClass: {},
  selectedCreationSubTab: "teacher",
  busOrderFilterStartDate: null,
  busOrderFilterEndDate: null,
  adminSidebarCollapsed: false,
  highlightPending: false,
  programEditSessionId: "",
  programPickContext: null,
  adminPicker: null,
  aiBusy: false,
  aiLastReportRows: [],
  algoBusy: false,
  algoCurrentStrategy: "CLASSIC",
  algoLastReportRows: [],
  algoLastReportData: null,
  algoConstraints: [],
  algoBlockedSlotsByYear: {},
  algoPinnedClassSlotsByYear: {},
  algoConstraintsLoaded: false,
  algoConstraintsSaving: false,
  algoConstraintsDirty: false,
  algoConstraintsSaveTimer: null,
  algoReplaceArmed: false,
  algoPendingSessions: [],
  algoPendingReplaceExisting: false,
  algoDryRun: false,
  algoSimulationSeq: 0,
  aiConstraints: [],
  aiConstraintsLoaded: false,
  aiConstraintsSaving: false,
  aiConstraintsDirty: false,
  aiConstraintsSaveTimer: null,
  teacherAssignedLevelDraft: {},
  algoSnapshotRenderTimer: null,
  touchAssignPayload: null,
  cadenceChoiceResolver: null,

  // Tasks state
  tasks: [],
  tasksComments: new Map(),
  tasksSteps: new Map(),
  tasksLoaded: false,
  tasksSnapshot: null,
  tasksCommentsSnapshot: new Map(),
  tasksStepsSnapshots: new Map(),
  tasksFilterCategory: "",
  tasksEditingId: null,
  tasksNotifications: [],

  // Documents state
  documentsFolders: [],
  documentsFiles: new Map(),
  documentsSelectedFolderId: null,
  documentsLoaded: false,
  documentsFoldersSnapshot: null,
  documentsFilesSnapshots: new Map(),

  // Notification preferences
  notificationPreferences: {
    taskAssigned: true,
    taskStatusChange: true,
    commentNotifications: true,
    deadlineReminders: true,
    replacementNotifications: true,
  },
};

function buildSchoolYearId(startYear) {
  const y = Number(startYear || 0);
  if (!Number.isFinite(y) || y < 2000) return "";
  return `${y}-${y + 1}`;
}

function getDefaultSchoolYearId() {
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth() + 1;
  const startYear = month >= 8 ? year : year - 1;
  return buildSchoolYearId(startYear);
}

function getAdminSchoolYearId() {
  return localStorage.getItem("adminSchoolYearId") || getDefaultSchoolYearId();
}

function getLegacySchoolYearId() {
  const existing = localStorage.getItem("legacySchoolYearId");
  if (existing) return existing;
  const seeded = getDefaultSchoolYearId();
  localStorage.setItem("legacySchoolYearId", seeded);
  return seeded;
}

function getActiveSchoolYearId() {
  if (!state.activeSchoolYearId) state.activeSchoolYearId = localStorage.getItem("activeSchoolYearId") || getDefaultSchoolYearId();
  if (!state.legacySchoolYearId) state.legacySchoolYearId = getLegacySchoolYearId();
  return state.activeSchoolYearId;
}

function isDocInActiveSchoolYear(docData) {
  const active = getActiveSchoolYearId();
  const docYear = String(docData?.schoolYearId || "").trim();
  if (!docYear) return active === getLegacySchoolYearId();
  return docYear === active;
}

function isDocInSchoolYear(docData, yearId) {
  const target = String(yearId || "").trim();
  if (!target) return false;
  const docYear = String(docData?.schoolYearId || "").trim();
  if (!docYear) return target === getLegacySchoolYearId();
  return docYear === target;
}

function getDesiderataYearId() {
  return String(state.desiderataConfig?.yearId || "").trim() || getActiveSchoolYearId();
}

function withActiveSchoolYear(data) {
  return {
    ...data,
    schoolYearId: getActiveSchoolYearId(),
  };
}

function renderSchoolYearScopeSelector() {
  if (!ui.schoolYearScopeSelect) return;
  const active = getAdminSchoolYearId();
  const [startRaw] = String(active || "").split("-");
  const start = Number(startRaw || 0) || new Date().getFullYear();
  const years = [start - 1, start, start + 1, start + 2];
  ui.schoolYearScopeSelect.innerHTML = years
    .map((y) => {
      const id = buildSchoolYearId(y);
      return `<option value="${id}">${y}/${y + 1}</option>`;
    })
    .join("");
  ui.schoolYearScopeSelect.value = active;

  const label = `${start}/${(start + 1).toString().slice(-2)}`;
  const mobileBadge = document.getElementById("schoolYearBadgeMobile");
  if (mobileBadge) mobileBadge.textContent = label;
  
  const brandSmall = ui.adminTabsHorizontal?.querySelector(".admin-tab-brand small");
  if (brandSmall) brandSmall.textContent = label;
}

function setupAuth() {
  // Le bouton de connexion direct a été supprimé, la connexion est déclenchée par les modes admin/désidérata

  if (ui.closeLoginBtn) {
    ui.closeLoginBtn.addEventListener("click", () => {
      if (ui.loginModal) ui.loginModal.classList.add("hidden");
    });
  }

  if (ui.forgotPasswordBtn) {
    ui.forgotPasswordBtn.addEventListener("click", async () => {
      const email = ui.loginEmail.value.trim();
      if (!email) {
        if (ui.loginError) ui.loginError.textContent = "Veuillez saisir votre adresse e-mail pour réinitialiser votre mot de passe.";
        if (ui.loginMessage) ui.loginMessage.textContent = "";
        return;
      }
      try {
        await firebase.auth().sendPasswordResetEmail(email);
        if (ui.loginMessage) ui.loginMessage.textContent = "Un e-mail de réinitialisation a été envoyé à " + email;
        if (ui.loginError) ui.loginError.textContent = "";
      } catch (err) {
        console.error("Reset password error:", err);
        let msg = "Erreur lors de l'envoi de l'e-mail de réinitialisation.";
        if (err.code === "auth/user-not-found") msg = "Aucun compte trouvé avec cette adresse e-mail.";
        if (ui.loginError) ui.loginError.textContent = msg;
        if (ui.loginMessage) ui.loginMessage.textContent = "";
      }
    });
  }

  if (ui.loginForm) {
    ui.loginForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      const email = ui.loginEmail.value.trim();
      const password = ui.loginPassword.value;
      
      try {
        await firebase.auth().signInWithEmailAndPassword(email, password);
        if (ui.loginModal) ui.loginModal.classList.add("hidden");
        ui.loginForm.reset();
      } catch (err) {
        console.error("Auth error code:", err.code);
        console.error("Full error:", err);
        let msg = "Erreur : identifiants incorrects.";
        if (err.code === "auth/user-disabled") msg = "Erreur : compte désactivé.";
        if (err.code === "auth/too-many-requests") msg = "Trop de tentatives. Réessayez plus tard.";
        if (ui.loginError) ui.loginError.textContent = `${msg} (${err.code})`;
        if (ui.loginMessage) ui.loginMessage.textContent = "";
      }
    });
  }

  if (ui.logoutBtn) {
    ui.logoutBtn.addEventListener("click", () => {
      sessionStorage.removeItem("magicToken");
      firebase.auth().signOut();
    });
  }

  firebase.auth().onAuthStateChanged((user) => {
    state.currentUser = user;
    document.body.classList.toggle("auth-locked", !user);
    if (user) {
      if (ui.userInfo) ui.userInfo.classList.remove("hidden");
      if (ui.userDisplayName) ui.userDisplayName.textContent = user.displayName || user.email;
      if (ui.loginModal) ui.loginModal.classList.add("hidden");
      if (ui.closeLoginBtn) ui.closeLoginBtn.classList.remove("hidden");
      syncCurrentUserRoleFromTeachers().then(() => {
        if (state.currentUserTeacherId) startRealtimeNotifications(state.currentUserTeacherId);
        loadNotificationPreferences();
      });
    } else {
      stopRealtimeNotifications();
      if (ui.userInfo) ui.userInfo.classList.add("hidden");
      state.currentUserRole = "NONE";
      state.currentUserTeacherId = "";
      if (ui.closeLoginBtn) ui.closeLoginBtn.classList.add("hidden");
      if (ui.loginModal) ui.loginModal.classList.remove("hidden");
      if (state.currentMode !== "public") {
        setMode("public");
      }
    }
    render();
  });
}

async function syncCurrentUserRoleFromTeachers() {
  const user = state.currentUser;
  const magicToken = sessionStorage.getItem("magicToken");

  if (!user) {
    if (magicToken) {
      const teacher = state.allTeachers.find((t) => t.loginToken === magicToken);
      if (teacher) {
        try {
          await firebase.auth().signInAnonymously();
        } catch (err) {
          console.error("Anonymous auth failed:", err);
          sessionStorage.removeItem("magicToken");
        }
      } else {
        sessionStorage.removeItem("magicToken");
      }
    }
    state.currentUserRole = "NONE";
    state.currentUserTeacherId = "";
    return;
  }

  if (user.isAnonymous) {
    if (magicToken) {
      const teacher = state.allTeachers.find((t) => t.loginToken === magicToken);
      if (teacher) {
        state.currentUserRole = "CUSTOM";
        state.currentUserTeacherId = teacher.id;
        if (ui.userDisplayName) ui.userDisplayName.textContent = teacher.name + " (Lien)";
        return;
      }
    }
    state.currentUserRole = "NONE";
    state.currentUserTeacherId = "";
    return;
  }

  const email = String(user.email || "").toLowerCase();
  const superAdminEmail = "ambroise.lepannerer@gmail.com";
  const teacher = state.allTeachers.find((t) => String(t.email || "").toLowerCase() === email);
  if (email === superAdminEmail) {
    state.currentUserRole = "SUPER_ADMIN";
    state.currentUserTeacherId = teacher ? teacher.id : "";
  } else if (teacher) {
    state.currentUserRole = "CUSTOM";
    state.currentUserTeacherId = teacher.id;
  } else {
    state.currentUserRole = "NONE";
    state.currentUserTeacherId = "";
  }
}

function isTeacherActiveInYear(teacher, yearId) {
  if (!Array.isArray(teacher?.activeSchoolYears)) return true; // compat legacy uniquement si champ absent
  const years = teacher.activeSchoolYears.map((y) => String(y || "").trim()).filter(Boolean);
  return years.includes(String(yearId || "").trim());
}

function setupModeSwitch() {
  const openLoginModal = () => {
    if (ui.loginModal) ui.loginModal.classList.remove("hidden");
    if (ui.loginError) ui.loginError.textContent = "";
    if (ui.loginMessage) ui.loginMessage.textContent = "";
  };
  const ensureAuthenticated = () => {
    if (state.currentUser) return true;
    openLoginModal();
    return false;
  };
  const openAdminTab = (tab) => {
    if (!ensureAuthenticated()) return;
    const wasFullscreen = state.isAssignFullscreen;
    setMode("admin");
    setAdminTab(tab);
    render();
    // Réappliquer le fullscreen après le changement d'onglet
    if (wasFullscreen && !document.fullscreenElement) {
      setTimeout(() => {
        document.documentElement.requestFullscreen().catch(() => {
          // Si fullscreen natif échoue, le mode CSS remain actif
        });
      }, 100);
    }
  };

  // Rendre la fonction accessible globalement pour les onclick HTML
  window.openAdminTab = openAdminTab;

  if (ui.publicModeBtn) ui.publicModeBtn.addEventListener("click", () => {
    if (!ensureAuthenticated()) return;
    const wasFullscreen = state.isAssignFullscreen;
    setMode("public");
    render();
    if (wasFullscreen && !document.fullscreenElement) {
      setTimeout(() => {
        document.documentElement.requestFullscreen().catch(() => {});
      }, 100);
    }
  });
  if (ui.desiderataModeBtn) ui.desiderataModeBtn.addEventListener("click", () => {
    if (!ensureAuthenticated()) return;
    const wasFullscreen = state.isAssignFullscreen;
    setMode("desiderata");
    render();
    if (wasFullscreen && !document.fullscreenElement) {
      setTimeout(() => {
        document.documentElement.requestFullscreen().catch(() => {});
      }, 100);
    }
  });
  if (ui.adminTabCreationBtn) ui.adminTabCreationBtn.addEventListener("click", () => openAdminTab("creation"));
  if (ui.adminTabAssignBtn) ui.adminTabAssignBtn.addEventListener("click", () => openAdminTab("assign"));
  if (ui.adminTabProgramBtn) ui.adminTabProgramBtn.addEventListener("click", () => openAdminTab("program"));
  if (ui.adminTabAlgoBtn) ui.adminTabAlgoBtn.addEventListener("click", () => openAdminTab("algo"));
  if (ui.adminTabBusBtn) ui.adminTabBusBtn.addEventListener("click", () => openAdminTab("bus"));
  if (ui.adminTabTasksBtn) ui.adminTabTasksBtn.addEventListener("click", () => openAdminTab("tasks"));
  if (ui.adminTabDocumentsBtn) ui.adminTabDocumentsBtn.addEventListener("click", () => openAdminTab("documents"));
  if (ui.adminTabManageBtn) ui.adminTabManageBtn.addEventListener("click", () => openAdminTab("manage"));
  if (ui.adminTabAbsenceBtn) ui.adminTabAbsenceBtn.addEventListener("click", () => openAdminTab("absence"));
  if (ui.adminTabEmailTemplatesBtn) ui.adminTabEmailTemplatesBtn.addEventListener("click", () => openAdminTab("emailTemplates"));
  if (ui.adminTabSchoolYearBtn) ui.adminTabSchoolYearBtn.addEventListener("click", () => openAdminTab("schoolyear"));
  if (ui.adminTabSwimBtn) ui.adminTabSwimBtn.addEventListener("click", () => openAdminTab("swim"));
  if (ui.adminTabRecapBtn) ui.adminTabRecapBtn.addEventListener("click", () => openAdminTab("recap"));
  if (ui.adminTabRepartitionBtn) ui.adminTabRepartitionBtn.addEventListener("click", () => openAdminTab("repartition"));
  if (ui.adminTabRightsBtn) ui.adminTabRightsBtn.addEventListener("click", () => openAdminTab("rights"));
  if (ui.adminTabInventoryBtn) ui.adminTabInventoryBtn.addEventListener("click", () => openAdminTab("inventory"));
}

function setupFloatingAssign() {
  const container = ui.floatingAssignContainer;
  const toggle = ui.floatingAssignToggle;
  const closeBtn = ui.closeFloatingBtn;
  if (!container || !toggle) return;

  // Ouverture / Fermeture
  const toggleContent = (forceClose = false) => {
    if (forceClose) container.classList.add("collapsed");
    else container.classList.toggle("collapsed");
  };

  toggle.addEventListener("click", (e) => {
    // Si on a bougé la bulle de plus de 5px, on ne toggle pas (c'était un drag)
    if (container.dataset.wasDragged === "1") {
      container.dataset.wasDragged = "0";
      return;
    }
    toggleContent();
  });

  if (closeBtn) closeBtn.addEventListener("click", () => toggleContent(true));

  // Gestion du déplacement (Drag de la bulle)
  let isDragging = false;
  let startX, startY, initialRight, initialBottom;

  toggle.addEventListener("mousedown", (e) => {
    isDragging = true;
    startX = e.clientX;
    startY = e.clientY;
    
    const style = window.getComputedStyle(container);
    initialRight = parseInt(style.right, 10);
    initialBottom = parseInt(style.bottom, 10);
    container.dataset.wasDragged = "0";
    
    const onMouseMove = (moveEvent) => {
      if (!isDragging) return;
      const dx = startX - moveEvent.clientX; // Inversé car on utilise 'right'
      const dy = startY - moveEvent.clientY; // Inversé car on utilise 'bottom'
      
      if (Math.abs(dx) > 5 || Math.abs(dy) > 5) {
        container.dataset.wasDragged = "1";
      }

      container.style.right = (initialRight + dx) + "px";
      container.style.bottom = (initialBottom + dy) + "px";
    };

    const onMouseUp = () => {
      isDragging = false;
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
    };

    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
  });

  // Écouteur global pour les commentaires cliquables
  document.addEventListener('click', (e) => {
    const commentBox = e.target.closest('.clickable-comment');
    if (commentBox) {
      const teacherId = commentBox.dataset.teacherId;
      const comment = commentBox.dataset.comment;
      console.log('Clic sur commentaire:', teacherId, comment);
      if (ui.desiderataComment) {
        ui.desiderataComment.value = comment;
        ui.desiderataComment.focus();
        state.desiderataCommentDraft = comment;
        state.desiderataCommentDraftTeacherId = teacherId;
        console.log('Commentaire chargé dans textarea');
      }
    }
  });
}

function setMode(mode) {
  state.currentMode = mode;
  const isPublic = mode === "public";
  const isDesiderata = mode === "desiderata";
  const isAdmin = !isPublic && !isDesiderata;
  document.body.dataset.appView = mode;
  const targetYearId = isAdmin ? getAdminSchoolYearId() : null;
  if (targetYearId && targetYearId !== getActiveSchoolYearId()) {
    console.log("Changement année - isAdmin:", isAdmin, "targetYearId:", targetYearId);
    localStorage.setItem("activeSchoolYearId", targetYearId);
    state.activeSchoolYearId = targetYearId;

    // Sauvegarder dans Firestore pour synchroniser avec tous les clients
    if (isAdmin && db) {
      console.log("Sauvegarde année dans Firestore:", targetYearId);
      db.collection("appConfig").doc("activeSchoolYear").set({ yearId: targetYearId }, { merge: true })
        .then(() => {
          console.log("Année sauvegardée avec succès");
          window.location.reload();
        })
        .catch(err => {
          console.error("Erreur sync année", err);
          window.location.reload();
        });
    } else {
      window.location.reload();
    }
    return;
  }

  if (isDesiderata) {
    if (state.currentUserRole === "CUSTOM" && state.currentUserTeacherId) {
      state.selectedDesiderataTeacherId = state.currentUserTeacherId;
    }
    renderTeacherOptions();
    renderDesiderata();
  }

  if (ui.publicSection) ui.publicSection.classList.toggle("hidden", !isPublic);
  if (ui.desiderataSection) ui.desiderataSection.classList.toggle("hidden", !isDesiderata);
  if (ui.adminSection) ui.adminSection.classList.toggle("hidden", !isAdmin);
  if (ui.publicModeBtn) ui.publicModeBtn.classList.toggle("active", isPublic);
  if (ui.desiderataModeBtn) ui.desiderataModeBtn.classList.toggle("active", isDesiderata);

  if (ui.toggleFullscreenBtn) {
    ui.toggleFullscreenBtn.classList.remove("hidden");
  }

  // Masquer la bulle flottante si on n'est pas en admin + affectation
  if (ui.floatingAssignContainer) {
    const isAssignTab = state.selectedAdminTab === "assign";
    ui.floatingAssignContainer.classList.toggle("hidden", !isAdmin || !isAssignTab);
  }
}

function setAdminTab(tab) {
  if (tab === "ai") tab = "algo";
  state.selectedAdminTab = tab;
  document.body.dataset.adminTab = tab;
  const rights = getCurrentUserRights();
  const isCreation = tab === "creation";
  const isAssign = tab === "assign";
  const isProgram = tab === "program";
  const isAlgo = tab === "algo";
  const isBus = tab === "bus";
  const isManage = tab === "manage";
  const isAbsence = tab === "absence";
  const isEmailTemplates = tab === "emailTemplates";
  const isSchoolYear = tab === "schoolyear";
  const isSwim = tab === "swim";
  const isRecap = tab === "recap";
  const isRepartition = tab === "repartition";
  const isRights = tab === "rights";
  const isInventory = tab === "inventory";
  const isTasks = tab === "tasks";
  const isDocuments = tab === "documents";
  const isDataTab = isCreation || isManage || isSchoolYear || isSwim || isRecap || isRepartition;

  if (ui.adminCreationPanel) ui.adminCreationPanel.classList.toggle("hidden", !isCreation);
  if (ui.adminAssignPanel) ui.adminAssignPanel.classList.toggle("hidden", !isAssign);
  if (ui.adminProgramPanel) ui.adminProgramPanel.classList.toggle("hidden", !isProgram);
  if (ui.adminAlgoPanel) ui.adminAlgoPanel.classList.toggle("hidden", !isAlgo);
  if (ui.adminBusPanel) ui.adminBusPanel.classList.toggle("hidden", !isBus);
  if (ui.adminTasksPanel) ui.adminTasksPanel.classList.toggle("hidden", !isTasks);
  if (ui.adminDocumentsPanel) ui.adminDocumentsPanel.classList.toggle("hidden", !isDocuments);
  if (ui.adminManagePanel) ui.adminManagePanel.classList.toggle("hidden", !isManage);
  if (ui.adminAbsencePanel) ui.adminAbsencePanel.classList.toggle("hidden", !isAbsence);
  if (ui.adminEmailTemplatesPanel) ui.adminEmailTemplatesPanel.classList.toggle("hidden", !isEmailTemplates);
  if (ui.adminSchoolYearPanel) ui.adminSchoolYearPanel.classList.toggle("hidden", !isSchoolYear);
  if (ui.adminSwimPanel) ui.adminSwimPanel.classList.toggle("hidden", !isSwim);
  if (ui.adminRecapPanel) ui.adminRecapPanel.classList.toggle("hidden", !isRecap);
  if (ui.adminRepartitionPanel) ui.adminRepartitionPanel.classList.toggle("hidden", !isRepartition);
  if (ui.adminRightsPanel) ui.adminRightsPanel.classList.toggle("hidden", !isRights);
  if (ui.adminInventoryPanel) ui.adminInventoryPanel.classList.toggle("hidden", !isInventory);
  if (isCreation) setCreationSubTab(state.selectedCreationSubTab);
  if (isRepartition) renderRepartitionPanel();

  if (ui.adminTabCreationBtn) ui.adminTabCreationBtn.classList.toggle("active", isCreation);
  if (ui.adminTabAssignBtn) ui.adminTabAssignBtn.classList.toggle("active", isAssign);
  if (ui.adminTabProgramBtn) ui.adminTabProgramBtn.classList.toggle("active", isProgram);
  if (ui.adminTabAlgoBtn) ui.adminTabAlgoBtn.classList.toggle("active", isAlgo);
  if (ui.adminTabBusBtn) ui.adminTabBusBtn.classList.toggle("active", isBus);
  if (ui.adminTabTasksBtn) ui.adminTabTasksBtn.classList.toggle("active", isTasks);
  if (ui.adminTabDocumentsBtn) ui.adminTabDocumentsBtn.classList.toggle("active", isDocuments);
  if (ui.adminTabManageBtn) ui.adminTabManageBtn.classList.toggle("active", isManage);
  if (ui.adminTabAbsenceBtn) ui.adminTabAbsenceBtn.classList.toggle("active", isAbsence);
  if (ui.adminTabSchoolYearBtn) ui.adminTabSchoolYearBtn.classList.toggle("active", isSchoolYear);
  if (ui.adminTabSwimBtn) ui.adminTabSwimBtn.classList.toggle("active", isSwim);
  if (ui.adminTabRecapBtn) ui.adminTabRecapBtn.classList.toggle("active", isRecap);
  if (ui.adminTabRepartitionBtn) ui.adminTabRepartitionBtn.classList.toggle("active", isRepartition);
  if (ui.adminDataMenu) {
    ui.adminDataMenu.classList.toggle("active", isDataTab);
    ui.adminDataMenu.open = false;
  }
  if (ui.adminTabRightsBtn) ui.adminTabRightsBtn.classList.toggle("active", isRights);
  if (ui.adminTabInventoryBtn) ui.adminTabInventoryBtn.classList.toggle("active", isInventory);

  // Masquer les onglets selon les droits
  if (state.currentUserRole === "SUPER_ADMIN") {
    if (ui.adminTabCreationBtn) ui.adminTabCreationBtn.classList.remove("hidden");
    if (ui.adminTabAssignBtn) ui.adminTabAssignBtn.classList.remove("hidden");
    if (ui.adminTabProgramBtn) ui.adminTabProgramBtn.classList.remove("hidden");
    if (ui.adminTabAlgoBtn) ui.adminTabAlgoBtn.classList.remove("hidden");
    if (ui.adminTabBusBtn) ui.adminTabBusBtn.classList.remove("hidden");
    if (ui.adminTabTasksBtn) ui.adminTabTasksBtn.classList.remove("hidden");
    if (ui.adminTabDocumentsBtn) ui.adminTabDocumentsBtn.classList.remove("hidden");
    if (ui.adminTabManageBtn) ui.adminTabManageBtn.classList.remove("hidden");
    if (ui.adminTabAbsenceBtn) ui.adminTabAbsenceBtn.classList.remove("hidden");
    if (ui.adminTabSchoolYearBtn) ui.adminTabSchoolYearBtn.classList.remove("hidden");
    if (ui.adminTabSwimBtn) ui.adminTabSwimBtn.classList.remove("hidden");
    if (ui.adminTabRecapBtn) ui.adminTabRecapBtn.classList.remove("hidden");
    if (ui.adminTabRepartitionBtn) ui.adminTabRepartitionBtn.classList.remove("hidden");
    if (ui.adminDataMenu) ui.adminDataMenu.classList.remove("hidden");
    if (ui.adminTabRightsBtn) ui.adminTabRightsBtn.classList.remove("hidden");
    if (ui.adminTabInventoryBtn) ui.adminTabInventoryBtn.classList.remove("hidden");
  } else {
  if (ui.adminTabCreationBtn) ui.adminTabCreationBtn.classList.toggle("hidden", rights.creation === "NONE");
  if (ui.adminTabAssignBtn) ui.adminTabAssignBtn.classList.toggle("hidden", rights.assign === "NONE");
  if (ui.adminTabProgramBtn) ui.adminTabProgramBtn.classList.toggle("hidden", rights.program === "NONE");
  if (ui.adminTabAlgoBtn) ui.adminTabAlgoBtn.classList.toggle("hidden", rights.program === "NONE");
  if (ui.adminTabBusBtn) ui.adminTabBusBtn.classList.toggle("hidden", rights.bus === "NONE");
  if (ui.adminTabTasksBtn) ui.adminTabTasksBtn.classList.toggle("hidden", rights.tasks === "NONE");
  if (ui.adminTabDocumentsBtn) ui.adminTabDocumentsBtn.classList.toggle("hidden", rights.documents === "NONE");
  if (ui.adminTabManageBtn) ui.adminTabManageBtn.classList.toggle("hidden", rights.manage === "NONE");
  if (ui.adminTabAbsenceBtn) ui.adminTabAbsenceBtn.classList.toggle("hidden", rights.manage === "NONE");
  if (ui.adminTabSchoolYearBtn) ui.adminTabSchoolYearBtn.classList.toggle("hidden", rights.manage === "NONE");
  if (ui.adminTabEmailTemplatesBtn) ui.adminTabEmailTemplatesBtn.classList.toggle("hidden", rights.emailTemplates === "NONE");
  if (ui.adminTabSwimBtn) ui.adminTabSwimBtn.classList.toggle("hidden", rights.swim === "NONE");
  if (ui.adminTabRecapBtn) ui.adminTabRecapBtn.classList.toggle("hidden", rights.recap === "NONE");
  if (ui.adminTabRepartitionBtn) ui.adminTabRepartitionBtn.classList.toggle("hidden", rights.repartition === "NONE");
  if (ui.adminDataMenu) {
    const hideDataMenu =
      rights.creation === "NONE" &&
      rights.manage === "NONE" &&
      rights.swim === "NONE" &&
      rights.recap === "NONE" &&
      rights.repartition === "NONE";
    ui.adminDataMenu.classList.toggle("hidden", hideDataMenu);
  }
  if (ui.adminTabRightsBtn) ui.adminTabRightsBtn.classList.toggle("hidden", state.currentUserRole !== "SUPER_ADMIN");
  if (ui.adminTabInventoryBtn) ui.adminTabInventoryBtn.classList.toggle("hidden", rights.inventory === "NONE");
  }

  // Gérer la visibilité de la BULLE FLOTTANTE (uniquement en affectation admin)
  if (ui.floatingAssignContainer) {
    ui.floatingAssignContainer.classList.toggle("hidden", !isAssign);
  }
}

function setProgramSubTab(tab) {
  const normalized = tab === "activity" || tab === "location" || tab === "periods" ? tab : "programming";
  state.selectedProgramSubTab = normalized;
  if (ui.programSubpanelProgramming) ui.programSubpanelProgramming.classList.toggle("hidden", normalized !== "programming");
  if (ui.programSubpanelActivity) ui.programSubpanelActivity.classList.toggle("hidden", normalized !== "activity");
  if (ui.programSubpanelLocation) ui.programSubpanelLocation.classList.toggle("hidden", normalized !== "location");
  if (ui.programSubpanelPeriods) ui.programSubpanelPeriods.classList.toggle("hidden", normalized !== "periods");
  if (ui.programSubtabProgrammingBtn) ui.programSubtabProgrammingBtn.classList.toggle("active", normalized === "programming");
  if (ui.programSubtabActivityBtn) ui.programSubtabActivityBtn.classList.toggle("active", normalized === "activity");
  if (ui.programSubtabLocationBtn) ui.programSubtabLocationBtn.classList.toggle("active", normalized === "location");
  if (ui.programSubtabPeriodsBtn) ui.programSubtabPeriodsBtn.classList.toggle("active", normalized === "periods");
}

function setCreationSubTab(tab) {
  const normalized = tab === "class" ? "class" : "teacher";
  state.selectedCreationSubTab = normalized;
  if (ui.creationSubpanelTeacher) ui.creationSubpanelTeacher.classList.toggle("hidden", normalized !== "teacher");
  if (ui.creationSubpanelClass) ui.creationSubpanelClass.classList.toggle("hidden", normalized !== "class");
  if (ui.creationSubtabTeacherBtn) ui.creationSubtabTeacherBtn.classList.toggle("active", normalized === "teacher");
  if (ui.creationSubtabClassBtn) ui.creationSubtabClassBtn.classList.toggle("active", normalized === "class");
}

function getCurrentUserRights() {
  if (state.currentUserRole === "SUPER_ADMIN") {
    return {
      creation: "MODIFY",
      assign: "MODIFY",
      program: "MODIFY",
      bus: "MODIFY",
      tasks: "MODIFY",
      documents: "MODIFY",
      manage: "MODIFY",
      emailTemplates: "MODIFY",
      swim: "MODIFY",
      recap: "MODIFY",
      repartition: "MODIFY",
      inventory: "MODIFY",
    };
  }
  const rights = state.userRights.find((r) => r.id === state.currentUserTeacherId);
  const defaultRights = {
    creation: "NONE",
    assign: "NONE",
    program: "NONE",
    bus: "NONE",
    tasks: "NONE",
    documents: "NONE",
    manage: "NONE",
    emailTemplates: "NONE",
    swim: "NONE",
    recap: "NONE",
    repartition: "NONE",
    inventory: "NONE",
  };
  if (!rights?.permissions) return defaultRights;
  return { ...defaultRights, ...rights.permissions };
}

function buildConstraintsPicker() {
  if (!ui.teacherConstraintsGrid) return;
  const frag = document.createDocumentFragment();
  for (const day of DAYS) {
    const col = document.createElement("div");
    col.className = "constraint-col";
    col.innerHTML = `<h4>${day}</h4>`;

    for (const slot of SLOTS) {
      const key = toSlotKey(day, slot);
      const row = document.createElement("label");
      row.className = "check-row";
      row.innerHTML = `<input type="checkbox" value="${key}" /> <span>${slot}</span>`;
      col.appendChild(row);
    }
    frag.appendChild(col);
  }
  ui.teacherConstraintsGrid.appendChild(frag);
}

function subscribeData() {
  const qTeachers = collection(db, "teachers");
  const qClasses = collection(db, "classes");
  const qSessions = collection(db, "sessions");
  const qSwimSlots = collection(db, "swimSlots");
  const qDesiderata = collection(db, "desiderata");
  const qDesiderataComments = collection(db, "desiderataComments");
  const qProgramActivities = collection(db, "programActivities");
  const qProgramLocations = collection(db, "programLocations");
  const qClassActivityPlans = collection(db, "classActivityPlans");
  const qUserRights = collection(db, "userRights");
  const qAbsences = collection(db, "absences");
  const qReplacements = collection(db, "replacements");
  const qReplacementOffers = collection(db, "replacementOffers");
  const qBusOrders = collection(db, "busOrders");
  const qSchoolYearConfig = doc(db, "planningConfig", "schoolYearCalendar");
  const qProgramPeriods = doc(db, "planningConfig", "periods");
  const qAiConstraints = doc(db, "planningConfig", "aiConstraints");
  const qAlgoConstraints = doc(db, "planningConfig", "algoConstraints");
  const qDesiderataConfig = doc(db, "planningConfig", "desiderataConfig");

  onSnapshot(qTeachers, (snap) => {
    state.allTeachers = snap.docs
      .map((d) => ({ id: d.id, ...d.data() }))
      .sort((a, b) => String(a.name || "").localeCompare(String(b.name || ""), "fr"));
    const activeYear = getActiveSchoolYearId();
    state.teachers = state.allTeachers.filter((t) => isTeacherActiveInYear(t, activeYear));
    syncCurrentUserRoleFromTeachers();
    syncPublicTeacherSelection();
    render();
  });

  onSnapshot(qClasses, (snap) => {
    state.classes = snap.docs
      .map((d) => ({ id: d.id, ...d.data() }))
      .filter((x) => isDocInActiveSchoolYear(x))
      .sort((a, b) => {
        const levelCmp = String(a.level || "").localeCompare(String(b.level || ""), "fr");
        if (levelCmp !== 0) return levelCmp;
        return String(a.name || "").localeCompare(String(b.name || ""), "fr");
      });
    render();
  });

  onSnapshot(qSessions, (snap) => {
    state.sessions = snap.docs
      .map((d) => ({ id: d.id, ...d.data() }))
      .filter((x) => isDocInActiveSchoolYear(x))
      .sort((a, b) => {
        const dayCmp = String(a.day || "").localeCompare(String(b.day || ""), "fr");
        if (dayCmp !== 0) return dayCmp;
        return String(a.start || "").localeCompare(String(b.start || ""), "fr");
      });
    repairASIdentities();
    if (state.algoBusy) {
      if (state.algoSnapshotRenderTimer) clearTimeout(state.algoSnapshotRenderTimer);
      state.algoSnapshotRenderTimer = setTimeout(() => {
        state.algoSnapshotRenderTimer = null;
        render();
      }, 180);
      return;
    }
    render();
  });

  onSnapshot(qSwimSlots, (snap) => {
    state.swimSlots = snap.docs
      .map((d) => ({ id: d.id, ...d.data() }))
      .filter((x) => isDocInActiveSchoolYear(x))
      .filter((x) => x.day && x.slot);
    state.swimSlotKeys = new Set(state.swimSlots.map((s) => daySlotKey(s.day, s.slot)));
    render();
  });

  onSnapshot(qDesiderata, (snap) => {
    const yearId = getDesiderataYearId();
    state.desiderataSlots = snap.docs
      .map((d) => ({ id: d.id, ...d.data() }))
      .filter((x) => isDocInSchoolYear(x, yearId))
      .filter((x) => x.teacherId && x.day && x.slot);
    state.desiderataSlotStatus = new Map(
      state.desiderataSlots.map((s) => [desiderataSlotKey(s.teacherId, s.day, s.slot), normalizeDesiderataStatus(s.status)])
    );
    syncDesiderataDraftWithPersisted();
    render();
  });

  onSnapshot(qDesiderataComments, (snap) => {
    const yearId = getDesiderataYearId();
    state.desiderataCommentsByTeacher = new Map(
      snap.docs
        .map((d) => ({ id: d.id, ...d.data() }))
        .filter((x) => isDocInSchoolYear(x, yearId))
        .map((x) => ({ teacherId: x.teacherId || x.id, comment: String(x.comment || "") }))
        .filter((x) => x.teacherId)
        .map((x) => [x.teacherId, x.comment])
    );
    syncDesiderataCommentDraftWithPersisted();
    render();
  });
  onSnapshot(qDesiderataConfig, (snap) => {
    const data = snap.exists ? snap.data() || {} : {};
    state.desiderataConfig = {
      yearId: String(data.yearId || getAdminSchoolYearId()),
      enabled: Boolean(data.enabled),
    };
    render();
  });

  // Listener pour synchroniser l'année active globale
  const qAppConfig = doc(db, "appConfig", "activeSchoolYear");
  let firstSnapReceived = false;
  onSnapshot(qAppConfig, (snap) => {
    try {
      const data = snap.exists ? snap.data() || {} : {};
      const globalYearId = String(data.yearId || "");
      const localYearId = localStorage.getItem("activeSchoolYearId") || getDefaultSchoolYearId();

      console.log("Listener appConfig - global:", globalYearId, "local:", localYearId, "first:", firstSnapReceived);

      if (!firstSnapReceived) {
        firstSnapReceived = true;
        // Au démarrage, si une année globale existe et diffère du localStorage, synchroniser
        if (globalYearId && globalYearId !== localYearId) {
          console.log("Sync année au démarrage depuis Firestore:", globalYearId);
          localStorage.setItem("activeSchoolYearId", globalYearId);
          state.activeSchoolYearId = globalYearId;
          render();
        }
      } else {
        // Après démarrage, si ça a changé, recharger
        const currentLocal = localStorage.getItem("activeSchoolYearId") || getDefaultSchoolYearId();
        if (globalYearId && globalYearId !== currentLocal) {
          console.log("Année changée globalement, rechargement:", globalYearId);
          localStorage.setItem("activeSchoolYearId", globalYearId);
          window.location.reload();
        }
      }
    } catch (err) {
      console.error("Erreur listener appConfig:", err);
    }
  });

  onSnapshot(qProgramActivities, (snap) => {
    state.programActivities = snap.docs
      .map((d) => ({ id: d.id, ...d.data() }))
      .filter((x) => x.label)
      .sort((a, b) => String(a.label || "").localeCompare(String(b.label || ""), "fr"));
    render();
  });

  onSnapshot(qProgramLocations, (snap) => {
    state.programLocations = snap.docs
      .map((d) => ({ id: d.id, ...d.data() }))
      .filter((x) => x.name)
      .sort((a, b) => String(a.name || "").localeCompare(String(b.name || ""), "fr"));
    render();
  });

  onSnapshot(qClassActivityPlans, (snap) => {
    state.classActivityPlans = snap.docs.map((d) => ({ id: d.id, ...d.data() })).filter((x) => isDocInActiveSchoolYear(x));
    render();
  });

  onSnapshot(qUserRights, (snap) => {
    state.userRights = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    // Refresh admin tab visibility when rights change
    if (state.selectedAdminTab) {
      setAdminTab(state.selectedAdminTab);
    }
    render();
  });

  onSnapshot(qAbsences, (snap) => {
    state.absences = snap.docs
      .map((d) => ({ id: d.id, ...d.data() }))
      .filter((x) => isDocInActiveSchoolYear(x))
      .filter((x) => x.teacherId && x.startDate && x.endDate)
      .sort((a, b) => String(b.startDate || "").localeCompare(String(a.startDate || ""), "fr"));
    if (state.selectedAbsenceId && !state.absences.some((a) => a.id === state.selectedAbsenceId)) {
      state.selectedAbsenceId = "";
    }
    render();
  });

  onSnapshot(qReplacements, (snap) => {
    state.replacements = snap.docs
      .map((d) => ({ id: d.id, ...d.data() }))
      .filter((x) => isDocInActiveSchoolYear(x))
      .filter((x) => x.absenceId && x.sessionId && x.fromTeacherId && x.toTeacherId);
    render();
  });

  onSnapshot(qReplacementOffers, (snap) => {
    state.replacementOffers = snap.docs
      .map((d) => ({ id: d.id, ...d.data() }))
      .filter((x) => isDocInActiveSchoolYear(x))
      .filter((x) => x.absenceId && x.sessionId && x.candidateTeacherId);
    render();
  });

  onSnapshot(qBusOrders, (snap) => {
    state.busOrders = snap.docs
      .map((d) => ({ id: d.id, ...d.data() }))
      .filter((x) => x.schoolYearId === getActiveSchoolYearId());
    render();
  });

  onSnapshot(qSchoolYearConfig, (snap) => {
    const raw = snap.exists ? snap.data() || {} : {};
    const yearsMap = raw?.years && typeof raw.years === "object" ? raw.years : null;
    const active = getActiveSchoolYearId();
    if (yearsMap && yearsMap[active]) {
      state.schoolYearConfig = yearsMap[active] || {};
    } else {
      // Compat legacy: ancien format mono-année.
      state.schoolYearConfig = yearsMap ? {} : raw;
    }
    // Initialiser la semaine d'affectation à la semaine actuelle (indépendante du public)
    if (!state.selectedAffectationWeekStart) {
      state.selectedAffectationWeekStart = toIsoDate(getMonday(new Date()));
    }
    render();
  });

  onSnapshot(qProgramPeriods, (snap) => {
    state.programPeriods = snap.exists ? snap.data() || {} : {};
    render();
  });

  onSnapshot(qAiConstraints, (snap) => {
    const rows = snap.exists ? snap.data()?.constraints : [];
    state.aiConstraints = Array.isArray(rows)
      ? rows.map((x) => String(x || "").trim()).filter(Boolean)
      : [];
    state.aiConstraintsLoaded = true;
    state.aiConstraintsDirty = false;
    render();
  });

  onSnapshot(
    qAlgoConstraints,
    (snap) => {
      const exists = typeof snap?.exists === "function" ? snap.exists() : Boolean(snap?.exists);
      const data = exists ? snap.data() || {} : {};
      const rows = data?.constraints;
      state.algoConstraints = Array.isArray(rows)
        ? rows.map((x) => String(x || "").trim()).filter(Boolean)
        : [];
      const byYearRaw = data?.blockedSlotsByYear;
      state.algoBlockedSlotsByYear =
        byYearRaw && typeof byYearRaw === "object"
          ? Object.fromEntries(
              Object.entries(byYearRaw).map(([yearId, values]) => [
                String(yearId || "").trim(),
                Array.isArray(values) ? values.map((x) => String(x || "").trim()).filter(Boolean) : [],
              ])
            )
          : {};
      const pinnedByYearRaw = data?.pinnedClassSlotsByYear;
      state.algoPinnedClassSlotsByYear =
        pinnedByYearRaw && typeof pinnedByYearRaw === "object"
          ? Object.fromEntries(
              Object.entries(pinnedByYearRaw).map(([yearId, values]) => [
                String(yearId || "").trim(),
                Array.isArray(values) ? values : [],
              ])
            )
          : {};
      state.algoConstraintsLoaded = true;
      state.algoConstraintsDirty = false;
      render();
    },
    (error) => {
      state.algoConstraintsLoaded = true;
      if (ui.algoConstraintsStatus) {
        ui.algoConstraintsStatus.textContent = `Accès Firestore refusé (algoConstraints): ${error?.code || "permission-denied"}`;
      }
    }
  );

  // Démarrer les écoutes temps réel pour les tâches
  startTasksRealtime();

  // Démarrer les écoutes temps réel pour les documents
  startDocumentsRealtime();
}

async function repairASIdentities() {
  // Cette fonction s'assure que chaque séance d'AS a un ID unique (__AS1__, __AS2__...)
  // pour éviter les conflits d'activité.
  const asSessions = state.sessions.filter(s => s.classId === "__AS__" || s.type === "AS");
  if (!asSessions.length) return;

  const usedIds = new Set(state.sessions.filter(s => String(s.classId || "").startsWith("__AS") && s.classId !== "__AS__").map(s => s.classId));
  const batch = db.batch();
  let count = 0;

  for (const session of asSessions) {
    if (session.classId === "__AS__" || !session.classId) {
      let nextNum = 1;
      while (usedIds.has(`__AS${nextNum}__`)) nextNum++;
      const newId = `__AS${nextNum}__`;
      usedIds.add(newId);
      batch.update(doc(db, "sessions", session.id), { classId: newId });
      count++;
    }
  }

  if (count > 0) {
    try {
      await batch.commit();
      console.log(`${count} séances d'AS ont été réparées avec des IDs uniques.`);
    } catch (e) {
      console.error("Erreur migration AS:", e);
    }
  }
}

function setupForms() {
  try {
    localStorage.removeItem("algoReplaceExistingSessions");
  } catch (_error) {}
  if (ui.classLevel) ui.classLevel.addEventListener("change", () => applyClassRule());
  if (ui.classCount) ui.classCount.addEventListener("input", () => applyClassRule());
  if (ui.globalWeekType) {
    ui.globalWeekType.addEventListener("change", () => {
      state.selectedGlobalWeekType = normalizeWeekType(ui.globalWeekType.value);
      renderPlannerGrid();
    });
  }
  if (ui.globalPlannerLayout) {
    ui.globalPlannerLayout.addEventListener("change", () => {
      state.selectedGlobalPlannerLayout = ui.globalPlannerLayout.value === "EXCEL" ? "EXCEL" : "GRID";
      state.globalPicker = null;
      renderPlannerGrid();
    });
  }
  if (ui.programWeekType) {
    ui.programWeekType.addEventListener("change", () => {
      state.selectedProgramWeekType = normalizeWeekType(ui.programWeekType.value);
      renderProgrammingPanel();
    });
  }
  if (ui.programDaySelect) {
    ui.programDaySelect.addEventListener("change", () => {
      state.selectedProgramDay = DAYS.includes(ui.programDaySelect.value) ? ui.programDaySelect.value : "Lundi";
      renderProgrammingPanel();
    });
  }
  if (ui.programSubtabProgrammingBtn) {
    ui.programSubtabProgrammingBtn.addEventListener("click", () => setProgramSubTab("programming"));
  }
  if (ui.programSubtabActivityBtn) {
    ui.programSubtabActivityBtn.addEventListener("click", () => setProgramSubTab("activity"));
  }
  if (ui.programSubtabLocationBtn) {
    ui.programSubtabLocationBtn.addEventListener("click", () => setProgramSubTab("location"));
  }
  if (ui.programSubtabPeriodsBtn) {
    ui.programSubtabPeriodsBtn.addEventListener("click", () => setProgramSubTab("periods"));
  }

  // Écouteurs pour les dates des trimestres et semestres
  const periodFields = ['programTrim1Start', 'programTrim1End', 'programTrim2Start', 'programTrim2End', 'programTrim3Start', 'programTrim3End', 'programSem1Start', 'programSem1End', 'programSem2Start', 'programSem2End'];
  periodFields.forEach((fieldId) => {
    const field = document.getElementById(fieldId);
    if (field) {
      field.addEventListener('change', async () => {
        const payload = {
          t1Start: ui.programTrim1Start?.value || '',
          t1End: ui.programTrim1End?.value || '',
          t2Start: ui.programTrim2Start?.value || '',
          t2End: ui.programTrim2End?.value || '',
          t3Start: ui.programTrim3Start?.value || '',
          t3End: ui.programTrim3End?.value || '',
          s1Start: ui.programSem1Start?.value || '',
          s1End: ui.programSem1End?.value || '',
          s2Start: ui.programSem2Start?.value || '',
          s2End: ui.programSem2End?.value || '',
        };
        try {
          await setDoc(doc(db, "planningConfig", "periods"), payload);
          console.log('Périodes sauvegardées');
          renderProgramPeriodsPanel();
        } catch (e) {
          console.error('Erreur sauvegarde périodes:', e);
        }
      });
    }
  });

  if (ui.creationSubtabTeacherBtn) {
    ui.creationSubtabTeacherBtn.addEventListener("click", () => setCreationSubTab("teacher"));
  }
  if (ui.creationSubtabClassBtn) {
    ui.creationSubtabClassBtn.addEventListener("click", () => setCreationSubTab("class"));
  }
  if (ui.programHighlightPendingBtn) {
    ui.programHighlightPendingBtn.addEventListener("click", () => {
      state.highlightPending = !state.highlightPending;
      render();
    });
  }
  if (ui.programResetPlanningBtn) {
    ui.programResetPlanningBtn.addEventListener("click", async () => {
      const yearLabel = getActiveSchoolYearId();
      const confirmed = confirm(
        `ATTENTION : cette action va effacer DÉFINITIVEMENT toute la programmation des activités et des salles (trimestres, semestres, AS) pour l'année scolaire ${yearLabel}.\n\nCette action est irréversible. Voulez-vous vraiment continuer ?`
      );
      if (!confirmed) return;

      const plansToDelete = state.classActivityPlans.filter((p) => isDocInActiveSchoolYear(p));
      const sessionsToClear = state.sessions.filter(
        (s) => isDocInActiveSchoolYear(s) && (s.activityLabel || s.activityCode || s.locationName)
      );
      if (!plansToDelete.length && !sessionsToClear.length) {
        ui.sessionError.textContent = "Aucune programmation à réinitialiser pour cette année.";
        return;
      }

      const ops = [
        ...plansToDelete.map((p) => ({ type: "delete", ref: doc(db, "classActivityPlans", p.id) })),
        ...sessionsToClear.map((s) => ({
          type: "update",
          ref: doc(db, "sessions", s.id),
          data: { activityLabel: null, activityCode: null, locationName: null },
        })),
      ];

      try {
        for (let i = 0; i < ops.length; i += 450) {
          const chunk = ops.slice(i, i + 450);
          const batch = db.batch();
          chunk.forEach((op) => {
            if (op.type === "delete") batch.delete(op.ref);
            else batch.update(op.ref, op.data);
          });
          await batch.commit();
        }
        state.classActivityPlans = state.classActivityPlans.filter((p) => !isDocInActiveSchoolYear(p));
        sessionsToClear.forEach((s) => {
          s.activityLabel = null;
          s.activityCode = null;
          s.locationName = null;
        });
        ui.sessionError.textContent = "Programmation réinitialisée.";
        renderProgrammingPanel();
      } catch (error) {
        ui.sessionError.textContent = "Erreur lors de la réinitialisation : " + error.message;
      }
    });
  }

  if (ui.programAddActivityBtn) {
    ui.programAddActivityBtn.addEventListener("click", async () => {
      const label = String(ui.programActivityLabel.value || "").trim();
      const code = String(ui.programActivityCode.value || "").trim().toUpperCase();
      const preferredLocationName = String(ui.programActivityPreferredLocationSelect?.value || "").trim();
      if (!label) return;
      await addDoc(collection(db, "programActivities"), {
        label,
        code: code || label.slice(0, 3).toUpperCase(),
        preferredLocationName: preferredLocationName || null,
        createdAt: serverTimestamp(),
      });
      ui.programActivityLabel.value = "";
      ui.programActivityCode.value = "";
      if (ui.programActivityPreferredLocationSelect) ui.programActivityPreferredLocationSelect.value = "";
    });
  }
  if (ui.programAddLocationBtn) {
    ui.programAddLocationBtn.addEventListener("click", async () => {
      const name = String(ui.programLocationName.value || "").trim();
      if (!name) return;
      await addDoc(collection(db, "programLocations"), {
        name,
        createdAt: serverTimestamp(),
      });
      ui.programLocationName.value = "";
    });
  }
  if (ui.programSavePeriodsBtn) {
    ui.programSavePeriodsBtn.addEventListener("click", async () => {
      await saveProgramPeriods();
    });
  }
  if (ui.toggleFullscreenBtn) {
    ui.toggleFullscreenBtn.addEventListener("click", async () => {
      await toggleAppFullscreen();
    });
  }

  if (ui.assignModalCancelBtn) {
    ui.assignModalCancelBtn.addEventListener("click", closeAssignModal);
  }
  if (ui.assignModal) {
    ui.assignModal.addEventListener("click", (e) => {
      if (e.target === ui.assignModal) closeAssignModal();
    });
  }
  if (ui.cadenceChoiceModalCancelBtn) {
    ui.cadenceChoiceModalCancelBtn.addEventListener("click", () => closeCadenceChoiceModal(""));
  }
  if (ui.cadenceChoiceModal) {
    ui.cadenceChoiceModal.addEventListener("click", (e) => {
      if (e.target === ui.cadenceChoiceModal) closeCadenceChoiceModal("");
    });
  }
  if (ui.programRoomsModalCloseBtn) {
    ui.programRoomsModalCloseBtn.addEventListener("click", closeProgramRoomsModal);
  }
  if (ui.programRoomsModal) {
    ui.programRoomsModal.addEventListener("click", (e) => {
      if (e.target === ui.programRoomsModal) closeProgramRoomsModal();
    });
  }
  if (ui.programPickModalCloseBtn) {
    ui.programPickModalCloseBtn.addEventListener("click", closeProgramPickModal);
  }
  if (ui.programPickModal) {
    ui.programPickModal.addEventListener("click", (e) => {
      if (e.target === ui.programPickModal) closeProgramPickModal();
    });
  }
  if (ui.publicOpenReplacementModalBtn) {
    ui.publicOpenReplacementModalBtn.addEventListener("click", () => {
      openPublicReplacementModal();
    });
  }
  if (ui.publicReplacementModalCloseBtn) {
    ui.publicReplacementModalCloseBtn.addEventListener("click", () => closePublicReplacementModal());
  }
  if (ui.publicReplacementModal) {
    ui.publicReplacementModal.addEventListener("click", (e) => {
      if (e.target === ui.publicReplacementModal) closePublicReplacementModal();
    });
  }
  if (ui.busComposeMailBtn) {
    ui.busComposeMailBtn.addEventListener("click", () => {
      composeBusEmail();
    });
  }

  if (ui.inventoryForm) {
    ui.inventoryForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      await saveInventoryRecord();
    });
  }
  if (ui.absenceForm) {
    ui.absenceForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      await saveAbsenceRecord();
    });
  }
  if (ui.absenceTeacherSelect) {
    ui.absenceTeacherSelect.addEventListener("change", () => {
      renderAbsencePanel();
    });
  }
  if (ui.schoolYearAddVacationBtn) {
    ui.schoolYearAddVacationBtn.addEventListener("click", () => {
      addSchoolYearVacationRow();
    });
  }
  if (ui.schoolYearStartDate) {
    ui.schoolYearStartDate.addEventListener("change", () => {
      state.schoolYearConfig = { ...state.schoolYearConfig, startDate: String(ui.schoolYearStartDate.value || "").trim() };
      renderSchoolYearPanel();
    });
  }
  if (ui.schoolYearEndDate) {
    ui.schoolYearEndDate.addEventListener("change", () => {
      state.schoolYearConfig = { ...state.schoolYearConfig, endDate: String(ui.schoolYearEndDate.value || "").trim() };
      renderSchoolYearPanel();
    });
  }
  if (ui.schoolYearAddHolidayBtn) {
    ui.schoolYearAddHolidayBtn.addEventListener("click", () => {
      addSchoolYearHolidayRow();
    });
  }
  if (ui.schoolYearSaveBtn) {
    ui.schoolYearSaveBtn.addEventListener("click", async () => {
      await saveSchoolYearCalendar();
    });
  }
  if (ui.desiderataConfigSaveBtn) {
    ui.desiderataConfigSaveBtn.addEventListener("click", async () => {
      await saveDesiderataConfig();
    });
  }
  if (ui.schoolYearPublishBtn) {
    ui.schoolYearPublishBtn.addEventListener("click", async () => {
      await publishSchoolYearEdt();
    });
  }
  if (ui.schoolYearScopeSelect) {
    ui.schoolYearScopeSelect.addEventListener("change", () => {
      const next = String(ui.schoolYearScopeSelect.value || "").trim();
      if (!next) return;
      localStorage.setItem("adminSchoolYearId", next);
      localStorage.setItem("activeSchoolYearId", next);
      window.location.reload();
    });
  }

  // Écouteur pour le badge mobile - ouvrir le sélecteur d'année
  if (ui.schoolYearBadgeMobile) {
    ui.schoolYearBadgeMobile.addEventListener("click", () => {
      if (ui.schoolYearSelectorModal) {
        ui.schoolYearSelectorModal.classList.remove("hidden");

        // Générer la liste des années
        const years = new Set();
        if (ui.schoolYearScopeSelect) {
          Array.from(ui.schoolYearScopeSelect.options).forEach(o => {
            years.add(String(o.value || ""));
          });
        }

        ui.schoolYearSelectorList.innerHTML = Array.from(years)
          .sort()
          .reverse()
          .map(year => {
            const isActive = year === state.activeSchoolYearId;
            return `<button
              class="primary-btn"
              style="font-weight: ${isActive ? 'bold' : 'normal'}; background: ${isActive ? '#4caf50' : '#cccccc'};"
              data-year="${escapeHtml(year)}"
              type="button">
              ${escapeHtml(year)}
            </button>`;
          })
          .join("");

        // Ajouter écouteurs aux boutons d'année
        ui.schoolYearSelectorList.querySelectorAll("button").forEach(btn => {
          btn.addEventListener("click", () => {
            const year = btn.getAttribute("data-year");
            if (year) {
              localStorage.setItem("adminSchoolYearId", year);
              localStorage.setItem("activeSchoolYearId", year);
              window.location.reload();
            }
          });
        });
      }
    });
  }

  if (ui.schoolYearSelectorCloseBtn) {
    ui.schoolYearSelectorCloseBtn.addEventListener("click", () => {
      if (ui.schoolYearSelectorModal) {
        ui.schoolYearSelectorModal.classList.add("hidden");
      }
    });
  }

  if (ui.busCreateNewOrderBtn) {
    ui.busCreateNewOrderBtn.addEventListener("click", () => {
      openBusOrderModal();
    });
  }
  if (ui.busCopyMailBtn) {
    ui.busCopyMailBtn.addEventListener("click", async () => {
      await copyBusEmailText();
    });
  }
  if (ui.busEmailTo) {
    ui.busEmailTo.addEventListener("input", () => {
      localStorage.setItem("busEmailTo", ui.busEmailTo.value || "");
    });
  }
  if (ui.replacementComposeMailBtn) {
    ui.replacementComposeMailBtn.addEventListener("click", () => {
      composeReplacementEmail();
    });
  }
  if (ui.replacementCopyMailHtmlBtn) {
    ui.replacementCopyMailHtmlBtn.addEventListener("click", async () => {
      await copyReplacementEmailHtml();
    });
  }
  if (ui.replacementEmailTo) {
    ui.replacementEmailTo.addEventListener("input", () => {
      localStorage.setItem("replacementEmailTo", ui.replacementEmailTo.value || "");
    });
  }
  if (ui.aiFillDefaultConstraintsBtn) {
    ui.aiFillDefaultConstraintsBtn.addEventListener("click", () => {
      state.aiConstraints = getDefaultAiConstraints();
      queueSaveAiConstraints();
      renderAIPanel();
    });
  }
  if (ui.aiAddConstraintBtn) {
    ui.aiAddConstraintBtn.addEventListener("click", () => {
      addAiConstraintFromDraft();
    });
  }
  if (ui.aiConstraintDraft) {
    ui.aiConstraintDraft.addEventListener("keydown", (e) => {
      if (e.key !== "Enter") return;
      e.preventDefault();
      addAiConstraintFromDraft();
    });
  }
  if (ui.aiSaveConstraintsBtn) {
    ui.aiSaveConstraintsBtn.addEventListener("click", async () => {
      if (state.aiConstraintsSaveTimer) clearTimeout(state.aiConstraintsSaveTimer);
      await saveAiConstraintsToFirestore();
    });
  }
  if (ui.aiGenerateEdtBtn) {
    ui.aiGenerateEdtBtn.addEventListener("click", async () => {
      await generateEdtWithGemini();
    });
  }
  if (ui.algoAddConstraintBtn) {
    ui.algoAddConstraintBtn.addEventListener("click", () => {
      addAlgoConstraintFromDraft();
    });
  }
  if (ui.algoConstraintDraft) {
    ui.algoConstraintDraft.addEventListener("keydown", (e) => {
      if (e.key !== "Enter") return;
      e.preventDefault();
      addAlgoConstraintFromDraft();
    });
  }
  if (ui.algoSaveConstraintsBtn) {
    ui.algoSaveConstraintsBtn.addEventListener("click", async () => {
      if (state.algoConstraintsSaveTimer) clearTimeout(state.algoConstraintsSaveTimer);
      await saveAlgoConstraintsToFirestore();
    });
  }
  if (ui.algoClearExistingSessionsBtn) {
    ui.algoClearExistingSessionsBtn.addEventListener("click", async () => {
      await clearAllSessionsFromAlgoPanel();
    });
  }
  if (ui.algoClearAllSessionsBtn) {
    let _clearAllArmed = false;
    ui.algoClearAllSessionsBtn.addEventListener("click", async () => {
      if (!_clearAllArmed) {
        _clearAllArmed = true;
        const orig = ui.algoClearAllSessionsBtn.textContent;
        ui.algoClearAllSessionsBtn.textContent = "⚠️ Confirmer (tout supprimer)";
        ui.algoClearAllSessionsBtn.style.opacity = "1";
        setTimeout(() => {
          _clearAllArmed = false;
          ui.algoClearAllSessionsBtn.textContent = orig;
        }, 4000);
        return;
      }
      _clearAllArmed = false;
      ui.algoClearAllSessionsBtn.textContent = "Supprimer tous les créneaux";
      await clearAllSessionsIncludingManual();
    });
  }
  if (ui.algoGenerateEdtBtn) {
    ui.algoGenerateEdtBtn.addEventListener("click", async () => {
      await generateEdtWithAlgorithm();
    });
  }
  if (ui.algoApplyProposalBtn) {
    ui.algoApplyProposalBtn.addEventListener("click", async () => {
      await applyAlgoProposal();
    });
  }
  if (ui.aiGeminiModel) {
    ui.aiGeminiModel.addEventListener("input", () => {
      localStorage.setItem("aiGeminiModel", String(ui.aiGeminiModel.value || "").trim());
    });
  }
  if (ui.aiGenerationTargetCount) {
    ui.aiGenerationTargetCount.addEventListener("input", () => {
      localStorage.setItem("aiGenerationTargetCount", String(ui.aiGenerationTargetCount.value || "160"));
      updateAIPromptPreview();
    });
  }
  if (ui.aiReplaceExistingSessions) {
    ui.aiReplaceExistingSessions.addEventListener("change", () => {
      localStorage.setItem("aiReplaceExistingSessions", ui.aiReplaceExistingSessions.checked ? "1" : "0");
    });
  }
  if (ui.algoGenerationTargetCount) {
    ui.algoGenerationTargetCount.addEventListener("input", () => {
      localStorage.setItem("algoGenerationTargetCount", String(ui.algoGenerationTargetCount.value || "160"));
    });
  }
  if (ui.algoReplaceExistingSessions) {
    ui.algoReplaceExistingSessions.addEventListener("change", () => {
      state.algoReplaceArmed = false;
    });
  }
  if (ui.algoAddPinnedClassBtn) {
    ui.algoAddPinnedClassBtn.addEventListener("click", () => {
      const classId = String(ui.algoPinnedClassSelect?.value || "").trim();
      const day = String(ui.algoPinnedDaySelect?.value || "").trim();
      const slot = String(ui.algoPinnedSlotSelect?.value || "").trim();
      const cadence = String(ui.algoPinnedCadenceSelect?.value || "WEEKLY").trim();
      if (!classId || !day || !slot) return;
      const rows = getAlgoPinnedClassSlotsForActiveYear();
      rows.push({ classId, day, slot, cadence });
      setAlgoPinnedClassSlotsForActiveYear(rows);
      queueSaveAlgoConstraints();
      if (ui.algoConstraintsStatus) {
        ui.algoConstraintsStatus.textContent = `Pré-placement ajouté pour ${getClassLabelById(classId, true)} (${getActiveSchoolYearId()}).`;
      }
      renderAlgoPanel();
    });
  }
  if (ui.assignModalTeacherSelect) {
    ui.assignModalTeacherSelect.addEventListener("change", () => {
      if (state.assignModal) state.assignModal.manualTeacherSelection = true;
      refreshAssignModalClassOptions();
    });
  }
  if (ui.assignModalLevelSelect) {
    ui.assignModalLevelSelect.addEventListener("change", () => {
      refreshAssignModalClassOptions();
    });
  }
  if (ui.assignModalClassSelect) {
    ui.assignModalClassSelect.addEventListener("change", () => {
      refreshAssignModalClassOptions();
    });
  }
  if (ui.assignModalCadenceSelect) {
    ui.assignModalCadenceSelect.addEventListener("change", () => {
      renderAssignDecisionSupport();
    });
  }
  if (ui.assignModalConfirmBtn) {
    ui.assignModalConfirmBtn.addEventListener("click", async () => {
      await confirmAssignModal();
    });
  }
  if (ui.assignEditLettersBtn) {
    ui.assignEditLettersBtn.addEventListener("click", async () => {
      if (!state.assignLettersEditMode) {
        state.assignLettersEditMode = true;
        state.assignLetterDraftByClass = {};
        ui.assignEditLettersBtn.textContent = "Valider les lettres";
        renderGlobalPlanner();
        return;
      }
      const result = await commitAssignLetterDrafts();
      if (!result.ok) {
        showToast(result.error || "Validation impossible.", "error");
        state.assignLettersEditMode = true;
        ui.assignEditLettersBtn.textContent = "Valider les lettres";
        renderGlobalPlanner();
        return;
      }
      if (ui.sessionError) {
        ui.sessionError.textContent = result.message;
        ui.sessionError.className = "error-text hours-ok";
      }
      ui.assignEditLettersBtn.textContent = "Changer les lettres";
      renderGlobalPlanner();
    });
  }
  if (ui.inviteConsultEdtBtn) {
    ui.inviteConsultEdtBtn.addEventListener("click", inviteConsultEdt);
  }
  if (ui.exportEdtGlobalPdfBtn) {
    ui.exportEdtGlobalPdfBtn.addEventListener("click", () => exportEdtGlobalPdf());
  }
  if (ui.exportEdtGlobalExcelBtn) {
    ui.exportEdtGlobalExcelBtn.addEventListener("click", () => exportEdtGlobalExcel());
  }
  if (ui.exportEdtIndividualPdfBtn) {
    ui.exportEdtIndividualPdfBtn.addEventListener("click", () => exportEdtIndividualPdf());
  }
  if (ui.exportEdtIndividualExcelBtn) {
    ui.exportEdtIndividualExcelBtn.addEventListener("click", () => exportEdtIndividualExcel());
  }
  if (ui.openRepartitionPopupBtn) {
    ui.openRepartitionPopupBtn.addEventListener("click", openRepartitionPopup);
  }
  if (ui.openAssignmentVerificationBtn) {
    ui.openAssignmentVerificationBtn.addEventListener("click", openAssignmentVerificationModal);
  }
  if (ui.repartitionPopupClose) {
    ui.repartitionPopupClose.addEventListener("click", closeRepartitionPopup);
  }
  if (ui.assignModeViewBtn) {
    ui.assignModeViewBtn.addEventListener("click", () => {
      state.assignMode = "view";
      render();
    });
  }
  if (ui.assignModeAssignBtn) {
    ui.assignModeAssignBtn.addEventListener("click", () => {
      state.assignMode = "assign";
      render();
    });
  }
  if (ui.assignModeReorganizeBtn) {
    ui.assignModeReorganizeBtn.addEventListener("click", () => {
      state.assignMode = "reorganize";
      render();
    });
  }
  if (ui.assignFilterTeacherSelect) {
    ui.assignFilterTeacherSelect.addEventListener("change", () => {
      state.assignFilters.teacherId = String(ui.assignFilterTeacherSelect.value || "");
      render();
    });
  }
  if (ui.assignFilterLevelSelect) {
    ui.assignFilterLevelSelect.addEventListener("change", () => {
      state.assignFilters.level = String(ui.assignFilterLevelSelect.value || "");
      render();
    });
  }
  if (ui.assignFilterConflictsOnly) {
    ui.assignFilterConflictsOnly.addEventListener("change", () => {
      state.assignFilters.conflictsOnly = Boolean(ui.assignFilterConflictsOnly.checked);
      render();
    });
  }
  if (ui.plannerTeacherSelect) {
    ui.plannerTeacherSelect.addEventListener("change", () => {
      state.selectedAdminTeacherIds = Array.from(ui.plannerTeacherSelect.selectedOptions).map((o) => o.value);
      renderPlannerGrid();
    });
  }
  if (ui.plannerShowGlobal) {
    ui.plannerShowGlobal.addEventListener("change", () => {
      state.showGlobalPlanner = ui.plannerShowGlobal.checked;
      renderPlannerGrid();
    });
  }
  if (ui.desiderataTeacherSelect) {
    ui.desiderataTeacherSelect.addEventListener("change", () => {
      state.selectedDesiderataTeacherId = ui.desiderataTeacherSelect.value;
      state.desiderataDraftTeacherId = "";
      state.desiderataCommentDraftTeacherId = "";
      state.desiderataDirty = false;
      renderDesiderata();
    });
  }
  if (ui.desiderataComment) {
    ui.desiderataComment.addEventListener("input", () => {
      state.desiderataCommentDraft = String(ui.desiderataComment.value || "");
      state.desiderataCommentDraftTeacherId = state.selectedDesiderataTeacherId || "";
      state.desiderataDirty = true;
    });
  }
  if (ui.desiderataClearBtn) {
    ui.desiderataClearBtn.addEventListener("click", () => {
      state.desiderataDraft = new Map();
      state.desiderataDirty = true;
      renderDesiderata();
    });
  }
  if (ui.desiderataApplyDayOffBtn) {
    ui.desiderataApplyDayOffBtn.addEventListener("click", () => {
      const day = String(ui.desiderataDayOffSelect?.value || "");
      if (day) {
        setDesiderataDayOff(day, true);
        renderDesiderata();
      }
    });
  }
  if (ui.desiderataClearDayOffBtn) {
    ui.desiderataClearDayOffBtn.addEventListener("click", () => {
      const day = String(ui.desiderataDayOffSelect?.value || "");
      if (day) {
        setDesiderataDayOff(day, false);
        renderDesiderata();
      }
    });
  }
  if (ui.desiderataSaveBtn) {
    ui.desiderataSaveBtn.addEventListener("click", async () => {
      await persistDesiderataDraft("BROUILLON");
    });
  }
  if (ui.desiderataSubmitBtn) {
    ui.desiderataSubmitBtn.addEventListener("click", async () => {
      const ok = window.confirm("Confirmer l'envoi de vos désidérata ? Vous pourrez toujours les modifier et resoumettre ensuite.");
      if (!ok) return;
      await persistDesiderataDraft("SOUMIS");
    });
  }
  if (ui.repartitionResetBtn) {
    ui.repartitionResetBtn.addEventListener("click", async () => {
      await resetRepartitionForAllTeachers();
    });
  }
  if (ui.repartitionExportBtn) {
    ui.repartitionExportBtn.addEventListener("click", () => {
      exportRepartitionCsv();
    });
  }
  if (ui.repartitionExportExcelBtn) {
    ui.repartitionExportExcelBtn.addEventListener("click", () => {
      exportRepartitionExcelStyled();
    });
  }
  if (ui.repartitionExportImageBtn) {
    ui.repartitionExportImageBtn.addEventListener("click", () => {
      exportRepartitionImagePng();
    });
  }
  if (ui.teacherEditSelect) {
    ui.teacherEditSelect.addEventListener("change", () => {
      const teacherId = ui.teacherEditSelect.value;
      if (!teacherId) {
        resetTeacherForm();
        return;
      }
      startTeacherEdit(teacherId);
    });
  }
  if (ui.teacherCancelEditBtn) {
    ui.teacherCancelEditBtn.addEventListener("click", () => {
      resetTeacherForm();
    });
  }
  if (ui.teacherForm) ui.teacherForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const name = ui.teacherName.value.trim();
    const email = ui.teacherEmail.value.trim().toLowerCase();
    const abbreviation = normalizeTeacherAbbreviation(ui.teacherAbbreviation.value, name);
    const maxHours = Number(ui.teacherMaxHours.value);
    const color = normalizeHexColor(ui.teacherColor.value);

    if (!name || !email || !abbreviation || !maxHours) return;
    try {
      if (state.editingTeacherId) {
        const currentTeacher = state.allTeachers.find((t) => t.id === state.editingTeacherId);
        await updateDoc(doc(db, "teachers", state.editingTeacherId), {
          name,
          email,
          abbreviation,
          maxHours,
          color,
          activeSchoolYears: Array.isArray(currentTeacher?.activeSchoolYears)
            ? currentTeacher.activeSchoolYears
            : [getActiveSchoolYearId()],
          updatedAt: serverTimestamp(),
        });
      } else {
        await addDoc(collection(db, "teachers"), {
          name,
          email,
          abbreviation,
          maxHours,
          color,
          assignedLevelQuotas: {},
          assignedTargets: [],
          activeSchoolYears: [getActiveSchoolYearId()],
          createdAt: serverTimestamp(),
        });
      }
      ui.sessionError.textContent = "";
      resetTeacherForm();
    } catch (error) {
      ui.sessionError.textContent =
        "Erreur Firestore: permissions insuffisantes. Déployez les règles avec `firebase deploy --only firestore:rules`.";
      console.error(error);
    }
  });

  if (ui.generateMagicLinkBtn) {
    ui.generateMagicLinkBtn.addEventListener("click", async () => {
      if (!state.editingTeacherId) return;
      const newToken = crypto.randomUUID();
      try {
        await updateDoc(doc(db, "teachers", state.editingTeacherId), {
          loginToken: newToken,
          updatedAt: serverTimestamp(),
        });
        updateMagicLinkDisplay(newToken);
      } catch (err) {
        console.error("Error generating magic link:", err);
        showToast("Erreur lors de la génération du lien.", "error");
      }
    });
  }

  if (ui.copyMagicLinkBtn) {
    ui.copyMagicLinkBtn.addEventListener("click", () => {
      if (!ui.teacherMagicLink || !ui.teacherMagicLink.value) return;
      ui.teacherMagicLink.select();
      navigator.clipboard.writeText(ui.teacherMagicLink.value);
      
      const originalIcon = ui.copyMagicLinkBtn.innerHTML;
      ui.copyMagicLinkBtn.innerHTML = '<span class="material-symbols-outlined">check</span>';
      setTimeout(() => {
        ui.copyMagicLinkBtn.innerHTML = originalIcon;
      }, 2000);
    });
  }

  if (ui.classForm) ui.classForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const level = ui.classLevel.value;
    const count = Number(ui.classCount.value);
    const rule = getLevelRule(level);
    const weeklyHours = Number(rule?.weeklyHours || 0);
    if (!level || !weeklyHours) return;
    if (!count || count < 1 || count > 26) {
      ui.classCreateInfo.innerHTML = `<span class="hours-over">Le nombre doit être entre 1 et 26.</span>`;
      return;
    }

    const prefix = getLevelPrefix(level);
    const existingNames = state.classes
      .filter((c) => c.level === level)
      .map((c) => String(c.name || "").toUpperCase());

    const prefixUpper = prefix.toUpperCase();
    let maxIdx = -1;
    existingNames.forEach((name) => {
      // On extrait la lettre (ex: "6A" -> "A")
      const letter = name.startsWith(prefixUpper) ? name.slice(prefixUpper.length) : name;
      if (letter.length === 1) {
        const idx = letter.charCodeAt(0) - 65; // A=0, B=1...
        if (idx >= 0 && idx < 26 && idx > maxIdx) maxIdx = idx;
      }
    });

    const startFrom = maxIdx + 1;
    const targetNames = [];
    for (let i = 0; i < count; i += 1) {
      if (startFrom + i >= 26) break; // Sécurité A-Z
      const letter = String.fromCharCode(65 + startFrom + i);
      targetNames.push(`${prefix}${letter}`);
    }

    const existing = new Set(existingNames);

    let created = 0;
    let skipped = 0;
    for (const name of targetNames) {
      if (existing.has(name.toUpperCase())) {
        skipped += 1;
        continue;
      }
      await addDoc(collection(db, "classes"), {
        schoolYearId: getActiveSchoolYearId(),
        level,
        name,
        weeklyHours,
        ruleGroup: rule.group,
        createdAt: serverTimestamp(),
      });
      created += 1;
    }

    ui.classCount.value = "1";
    ui.classCreateInfo.innerHTML = `<span class="${skipped ? "hours-over" : "hours-ok"}">Créées: ${created}${skipped ? `, ignorées (déjà existantes): ${skipped}` : ""}.</span>`;
    applyClassRule();
  });

  if (ui.publicTeacherSelect) {
    ui.publicTeacherSelect.addEventListener("change", () => {
      state.selectedPublicTeacherId = ui.publicTeacherSelect.value;
      renderPublic();
    });
  }
  if (ui.publicPrevWeekBtn) {
    ui.publicPrevWeekBtn.addEventListener("click", () => {
      shiftPublicWeek(-7);
      renderPublic();
    });
  }
  if (ui.publicNextWeekBtn) {
    ui.publicNextWeekBtn.addEventListener("click", () => {
      shiftPublicWeek(7);
      renderPublic();
    });
  }
  if (ui.publicCurrentWeekBtn) {
    ui.publicCurrentWeekBtn.addEventListener("click", () => {
      state.selectedPublicWeekStart = toIsoDate(getMonday(new Date()));
      renderPublic();
    });
  }
  if (ui.publicWeekDate) {
    ui.publicWeekDate.addEventListener("change", () => {
      const dateValue = String(ui.publicWeekDate.value || "");
      if (!dateValue) return;
      const picked = parseIsoDate(dateValue);
      state.selectedPublicWeekStart = toIsoDate(getMonday(picked));
      renderPublic();
    });
  }
}

function updateFullscreenUiState(isFullscreen) {
  state.isAssignFullscreen = Boolean(isFullscreen);
  if (ui.appMain) ui.appMain.classList.toggle("fullscreen-mode", state.isAssignFullscreen);
  if (ui.toggleFullscreenBtn) {
    ui.toggleFullscreenBtn.innerHTML = state.isAssignFullscreen
      ? `<span class="material-symbols-outlined">fullscreen_exit</span>`
      : `<span class="material-symbols-outlined">fullscreen</span>`;
  }
}

async function toggleAppFullscreen() {
  const nativeSupported = typeof document.documentElement?.requestFullscreen === "function";
  const inNativeFullscreen = Boolean(document.fullscreenElement);

  try {
    if (nativeSupported && !inNativeFullscreen) {
      await document.documentElement.requestFullscreen().catch(() => {
        // Si fullscreen échoue, basculer en mode CSS
        updateFullscreenUiState(!state.isAssignFullscreen);
      });
      if (document.fullscreenElement) {
        updateFullscreenUiState(true);
        return;
      }
    } else if (inNativeFullscreen && typeof document.exitFullscreen === "function") {
      await document.exitFullscreen().catch(() => {
        updateFullscreenUiState(!state.isAssignFullscreen);
      });
      if (!document.fullscreenElement) {
        updateFullscreenUiState(false);
        return;
      }
    }
  } catch (_error) {
    console.warn("Fullscreen error:", _error);
  }

  // Fallback CSS-only : basculer l'état
  updateFullscreenUiState(!state.isAssignFullscreen);
}

function syncPublicTeacherSelection() {
  if (!state.selectedPublicTeacherId) state.selectedPublicTeacherId = "__ALL__";
  if (state.selectedPublicTeacherId === "__ALL__") return;
  if (!state.teachers.some((t) => t.id === state.selectedPublicTeacherId)) {
    state.selectedPublicTeacherId = "__ALL__";
  }
}

function syncDesiderataTeacherSelection() {
  const validIds = new Set(state.teachers.map((t) => t.id));
  if (!state.selectedDesiderataTeacherId || !validIds.has(state.selectedDesiderataTeacherId)) {
    state.selectedDesiderataTeacherId = state.teachers[0]?.id || "";
  }
}

function syncAdminTeacherSelection() {
  const validIds = new Set(state.teachers.map((t) => t.id));
  if (state.editingTeacherId && !validIds.has(state.editingTeacherId)) {
    state.editingTeacherId = "";
  }
  state.selectedAdminTeacherIds = state.selectedAdminTeacherIds.filter((id) => validIds.has(id));
  if (!state.selectedAdminTeacherIds.length && state.teachers.length) {
    state.selectedAdminTeacherIds = [state.teachers[0].id];
  }
  state.selectedAdminTeacherId = state.selectedAdminTeacherIds[0] || "";
}

function setTeacherConstraintsSelection(unavailable) {
  if (!ui.teacherConstraintsGrid) return;
  const set = new Set(Array.isArray(unavailable) ? unavailable : []);
  ui.teacherConstraintsGrid.querySelectorAll("input[type='checkbox']").forEach((el) => {
    el.checked = set.has(el.value);
  });
}

function startTeacherEdit(teacherId) {
  const teacher = state.allTeachers.find((t) => t.id === teacherId);
  if (!teacher) {
    resetTeacherForm();
    return;
  }
  if (!ui.teacherEditSelect || !ui.teacherName || !ui.teacherEmail || !ui.teacherAbbreviation || !ui.teacherMaxHours || !ui.teacherColor) return;
  state.editingTeacherId = teacher.id;
  ui.teacherEditSelect.value = teacher.id;
  ui.teacherName.value = teacher.name || "";
  ui.teacherEmail.value = teacher.email || "";
  ui.teacherAbbreviation.value = normalizeTeacherAbbreviation(teacher.abbreviation, teacher.name || "");
  ui.teacherMaxHours.value = String(teacher.maxHours || "");
  ui.teacherColor.value = normalizeHexColor(teacher.color);
  setTeacherConstraintsSelection(teacher.unavailable || []);
  if (ui.teacherSubmitBtn) ui.teacherSubmitBtn.textContent = "Enregistrer les modifications";
  if (ui.teacherCancelEditBtn) ui.teacherCancelEditBtn.classList.remove("hidden");

  // Magic Link Logic
  if (ui.magicLinkSection) {
    ui.magicLinkSection.classList.remove("hidden");
    updateMagicLinkDisplay(teacher.loginToken);
  }
}

function resetTeacherForm() {
  state.editingTeacherId = "";
  if (ui.teacherForm) ui.teacherForm.reset();
  if (ui.teacherEditSelect) ui.teacherEditSelect.value = "";
  if (ui.teacherEmail) ui.teacherEmail.value = "";
  if (ui.teacherColor) ui.teacherColor.value = "#0b7285";
  if (ui.teacherSubmitBtn) ui.teacherSubmitBtn.textContent = "Ajouter professeur";
  if (ui.teacherCancelEditBtn) ui.teacherCancelEditBtn.classList.add("hidden");
  setTeacherConstraintsSelection([]);

  if (ui.magicLinkSection) ui.magicLinkSection.classList.add("hidden");
  if (ui.teacherMagicLink) ui.teacherMagicLink.value = "";
}

function updateMagicLinkDisplay(token) {
  if (!ui.teacherMagicLink) return;
  if (token) {
    const url = new URL(window.location.href);
    url.searchParams.set("token", token);
    ui.teacherMagicLink.value = url.toString();
  } else {
    ui.teacherMagicLink.value = "";
  }
}

function computeTeacherHours() {
  const map = new Map();
  const catalog = getTeacherQuotaCatalog();
  
  for (const t of state.teachers) {
    let total = 0;
    
    // 1. Heures des séances (Timetable)
    const teacherSessions = state.sessions.filter(s => s.teacherId === t.id);
    for (const s of teacherSessions) {
      total += weeklyEquivalentHours(s);
    }
    
    // 2. Heures administratives (Quotas sans séances comme COORD, PROJET)
    const quotas = getTeacherAssignedLevelQuotas(t);
    for (const entry of catalog) {
      if (entry.key === "COORD" || entry.key === "PROJET") {
        const count = Number(quotas[entry.key] || 0);
        total += count * Number(entry.weeklyHours || 0);
      }
    }
    
    map.set(t.id, total);
  }
  return map;
}

function getDefaultAiConstraints() {
  return [
    "Objectif: générer un EDT EPS complet et cohérent.",
    "Pas de conflit enseignant ni classe sur un même créneau.",
    "Respecter les indisponibilités enseignants.",
    "Respecter les règles de niveau (durées/cadences) déjà appliquées dans l'app.",
    "Équilibrer la charge des enseignants (proche de leur maxHours sans dépassement).",
    "Privilégier les créneaux marqués préférés dans les désidérata.",
    "Éviter les créneaux tardifs pour les classes collège quand possible.",
    "Si un enseignant a des 3e et des 4e: placer une 3e et une 4e en parallèle, au même créneau, en alternance semaine A/B.",
    "Utiliser uniquement: jours Lundi à Vendredi et horaires autorisés.",
    "Sortie demandée: JSON strict avec un tableau sessions.",
  ];
}

function normalizeAiConstraint(value) {
  return String(value || "").trim().replace(/\s+/g, " ");
}

function getAiConstraintsPromptText() {
  const rows = (state.aiConstraints || []).map((x) => normalizeAiConstraint(x)).filter(Boolean);
  if (!rows.length) return "(aucune contrainte personnalisée)";
  return rows.map((x) => `- ${x}`).join("\n");
}

function updateAIPromptPreview() {
  if (!ui.aiPromptPreview) return;
  const constraintsText = getAiConstraintsPromptText();
  const targetCount = Math.max(1, Math.min(600, Number(ui.aiGenerationTargetCount?.value || 160)));
  try {
    ui.aiPromptPreview.value = buildGeminiPromptForEdt(constraintsText, targetCount);
  } catch (error) {
    ui.aiPromptPreview.value = `Prompt indisponible: ${error?.message || "erreur inconnue."}`;
  }
}

async function saveAiConstraintsToFirestore() {
  if (state.aiConstraintsSaving) return;
  state.aiConstraintsSaving = true;
  try {
    const constraints = (state.aiConstraints || []).map((x) => normalizeAiConstraint(x)).filter(Boolean);
    await setDoc(
      doc(db, "planningConfig", "aiConstraints"),
      {
        constraints,
        updatedAt: serverTimestamp(),
      },
      { merge: true }
    );
    state.aiConstraintsDirty = false;
    if (ui.aiConstraintsStatus) ui.aiConstraintsStatus.textContent = "Contraintes enregistrées.";
  } catch (error) {
    if (ui.aiConstraintsStatus) ui.aiConstraintsStatus.textContent = `Erreur enregistrement contraintes: ${error?.message || "échec."}`;
  } finally {
    state.aiConstraintsSaving = false;
    renderAIPanel();
  }
}

function queueSaveAiConstraints() {
  state.aiConstraintsDirty = true;
  if (ui.aiConstraintsStatus) ui.aiConstraintsStatus.textContent = "Contraintes modifiées (enregistrement en attente)...";
  if (state.aiConstraintsSaveTimer) clearTimeout(state.aiConstraintsSaveTimer);
  state.aiConstraintsSaveTimer = setTimeout(() => {
    saveAiConstraintsToFirestore();
  }, 600);
}

function addAiConstraintFromDraft() {
  if (!ui.aiConstraintDraft) return;
  const value = normalizeAiConstraint(ui.aiConstraintDraft.value);
  if (!value) return;
  state.aiConstraints = [...(state.aiConstraints || []), value];
  ui.aiConstraintDraft.value = "";
  queueSaveAiConstraints();
  renderAIPanel();
}

function normalizeAlgoConstraint(value) {
  return String(value || "").trim().replace(/\s+/g, " ");
}

function getAlgoConstraintRows() {
  return (state.algoConstraints || []).map((x) => normalizeAlgoConstraint(x)).filter(Boolean);
}

function getAlgoBlockedSlotsForYear(yearId) {
  const key = String(yearId || "").trim() || getActiveSchoolYearId();
  const byYear = state.algoBlockedSlotsByYear && typeof state.algoBlockedSlotsByYear === "object" ? state.algoBlockedSlotsByYear : {};
  const raw = byYear[key];
  if (!Array.isArray(raw)) return new Set();
  return new Set(raw.map((x) => String(x || "").trim()).filter(Boolean));
}

function getAlgoBlockedSlotsForActiveYear() {
  return getAlgoBlockedSlotsForYear(getActiveSchoolYearId());
}

function setAlgoBlockedSlotsForActiveYear(nextSet) {
  const yearId = getActiveSchoolYearId();
  const rows = Array.from(nextSet || [])
    .map((x) => String(x || "").trim())
    .filter(Boolean)
    .sort();
  state.algoBlockedSlotsByYear = {
    ...(state.algoBlockedSlotsByYear || {}),
    [yearId]: rows,
  };
}

function isAlgoBlockedSlot(day, slotBandStart) {
  return getAlgoBlockedSlotsForActiveYear().has(toSlotKey(day, slotBandStart));
}

function isAlgoBlockedBand(day, slotBandStart) {
  return isAlgoBlockedSlot(day, slotBandStart);
}

function getAlgoPinnedClassSlotsForYear(yearId) {
  const key = String(yearId || "").trim() || getActiveSchoolYearId();
  const byYear =
    state.algoPinnedClassSlotsByYear && typeof state.algoPinnedClassSlotsByYear === "object"
      ? state.algoPinnedClassSlotsByYear
      : {};
  const rows = Array.isArray(byYear[key]) ? byYear[key] : [];
  return rows
    .map((x) => ({
      classId: String(x?.classId || "").trim(),
      day: String(x?.day || "").trim(),
      slot: String(x?.slot || "").trim(),
      cadence: String(x?.cadence || "WEEKLY").trim(),
    }))
    .filter((x) => x.classId && DAYS.includes(x.day) && SLOT_BANDS.some((b) => b.start === x.slot));
}

function getAlgoPinnedClassSlotsForActiveYear() {
  return getAlgoPinnedClassSlotsForYear(getActiveSchoolYearId());
}

function setAlgoPinnedClassSlotsForActiveYear(rows) {
  const yearId = getActiveSchoolYearId();
  const cleaned = (rows || [])
    .map((x) => ({
      classId: String(x?.classId || "").trim(),
      day: String(x?.day || "").trim(),
      slot: String(x?.slot || "").trim(),
      cadence: String(x?.cadence || "WEEKLY").trim(),
    }))
    .filter((x) => x.classId && DAYS.includes(x.day) && SLOT_BANDS.some((b) => b.start === x.slot));
  state.algoPinnedClassSlotsByYear = {
    ...(state.algoPinnedClassSlotsByYear || {}),
    [yearId]: cleaned,
  };
}

function getAlgoActiveRules() {
  const hardRules = [
    "Max 4 professeurs simultanés par créneau.",
    "1 classe = 1 seul professeur.",
    "Max 6h de cours par jour et par professeur.",
    "Trou interne max 2h sur une journée professeur.",
    "Si début à 08:15, pas de fin à 18h le même jour.",
    "Créneaux 16h05-17h50 réservés à Seconde (et Seconde uniquement sur ce créneau).",
    "5e: EPS à 12:10, 3h hebdo, avec plafond 3 classes simultanées.",
    "4e/3e: 1 créneau hebdo fixe + 1 créneau A/B.",
    "AS: créneaux 12:10 ou 13:00, durée 1h, hebdo.",
    "Respect des indisponibilités et journées OFF.",
    "Mode classes imposées: si une classe est pré-placée, l'algo attribue automatiquement un professeur compatible.",
  ];
  const manual = getAlgoConstraintRows().map((row) => {
    if (isAlgoSixiemeSwimConstraintRow(row)) return `✅ ${row} (contrainte dédiée: natation 6e)`;
    return compileAlgoManualConstraint(row) ? `✅ ${row}` : `⚠ ${row} (non interprétée automatiquement)`;
  });
  return { hardRules, manual };
}

function isAlgoSixiemeSwimConstraintRow(row) {
  const key = normalizeLookupKey(row);
  const hasSixieme = key.includes("6eme") || key.includes("6e") || key.includes("sixieme");
  const hasSwim = key.includes("natation") || key.includes("nager") || key.includes("piscine");
  const hasMandatory = key.includes("obligatoire") || key.includes("doit") || key.includes("forc");
  return hasSixieme && hasSwim && hasMandatory;
}

function isAlgoSixiemeSwimMandatory() {
  const rows = getAlgoConstraintRows();
  return rows.some((row) => isAlgoSixiemeSwimConstraintRow(row));
}

function extractAlgoConstraintDays(key) {
  const days = [];
  const map = [
    ["lundi", "Lundi"],
    ["mardi", "Mardi"],
    ["mercredi", "Mercredi"],
    ["jeudi", "Jeudi"],
    ["vendredi", "Vendredi"],
  ];
  for (const [needle, day] of map) {
    if (key.includes(needle)) days.push(day);
  }
  return Array.from(new Set(days));
}

function extractAlgoConstraintSlots(rawText, key) {
  const slots = new Set();
  const raw = String(rawText || "");
  const re = /([01]?\d|2[0-3])\s*[:h]\s*([0-5]\d)/g;
  let m = re.exec(raw);
  while (m) {
    const hh = String(m[1]).padStart(2, "0");
    const mm = String(m[2]).padStart(2, "0");
    const v = `${hh}:${mm}`;
    if (SLOTS.includes(v)) slots.add(v);
    m = re.exec(raw);
  }
  if (key.includes("midi")) {
    slots.add("12:10");
    slots.add("13:00");
  }
  if (key.includes("matin")) {
    ["08:15", "09:05", "10:20", "11:10"].forEach((s) => slots.add(s));
  }
  if (key.includes("apres midi") || key.includes("apresmidi")) {
    ["14:00", "14:50", "16:05", "16:55"].forEach((s) => slots.add(s));
  }
  return Array.from(slots);
}

function compileAlgoManualConstraint(rawText) {
  const raw = String(rawText || "").trim();
  if (!raw) return null;
  const key = normalizeLookupKey(raw);

  // Cette contrainte est déjà gérée ailleurs.
  if (isAlgoSixiemeSwimConstraintRow(raw)) {
    return null;
  }

  const days = extractAlgoConstraintDays(key);
  const slots = extractAlgoConstraintSlots(raw, key);
  const hasTeacherScope = state.teachers.some((t) => {
    const name = normalizeLookupKey(t.name);
    const abbr = normalizeLookupKey(t.abbreviation || "");
    return (name && key.includes(name)) || (abbr && key.includes(abbr));
  });
  const hasLevelScope = Object.keys(LEVEL_RULES).some((level) => key.includes(normalizeLookupKey(level)));

  const teacherIds = state.teachers
    .filter((t) => {
      const name = normalizeLookupKey(t.name);
      const abbr = normalizeLookupKey(t.abbreviation || "");
      return (name && key.includes(name)) || (abbr && key.includes(abbr));
    })
    .map((t) => t.id);
  const levels = Object.keys(LEVEL_RULES).filter((level) => key.includes(normalizeLookupKey(level)));

  const mentionsAs = key.includes(" as ") || key.startsWith("as ") || key.includes(" association sportive");
  const mentionsSwim = key.includes("natation") || key.includes("piscine") || key.includes("nager");

  let mode = "";
  if (key.includes("interdit") || key.includes("jamais") || key.includes("ne pas") || key.includes("pas de")) mode = "BLOCK";
  else if (key.includes("eviter") || key.includes("limiter")) mode = "AVOID";
  else if (key.includes("prefer") || key.includes("favoriser") || key.includes("priorit")) mode = "PREFER";
  else if ((key.includes("obligatoire") || key.includes("doit")) && (days.length || slots.length)) mode = "REQUIRE";
  else return null;

  if (!hasTeacherScope && !hasLevelScope && !mentionsAs && !mentionsSwim) return null;

  return {
    raw,
    mode,
    teacherIds,
    levels,
    days,
    slots,
    mentionsAs,
    mentionsSwim,
  };
}

function evaluateAlgoManualConstraintsForSession(session) {
  const rows = getAlgoConstraintRows();
  if (!rows.length || !session) return { blocked: false, scoreDelta: 0, reasons: [] };

  const cls = state.classes.find((c) => c.id === session.classId);
  const level = String(cls?.level || "");
  const covered = getCoveredSlots(session.day, session.start, Number(session.duration || 0))
    .map((k) => String(k).split("|")[1]);
  const isAs = String(session.type || "").toUpperCase() === "AS" || isASLike(session);
  const touchesSwim = sessionTouchesSwimSlot(session);

  let blocked = false;
  let scoreDelta = 0;
  const reasons = [];

  for (const raw of rows) {
    const rule = compileAlgoManualConstraint(raw);
    if (!rule) continue;

    if (rule.teacherIds.length && !rule.teacherIds.includes(session.teacherId)) continue;
    if (rule.levels.length && !rule.levels.includes(level)) continue;
    if (rule.mentionsAs && !isAs) continue;
    if (rule.mentionsSwim && !touchesSwim) continue;

    const dayMatch = !rule.days.length || rule.days.includes(String(session.day || ""));
    const slotMatch = !rule.slots.length || covered.some((s) => rule.slots.includes(s));
    const matchesWhere = dayMatch && slotMatch;

    if (rule.mode === "BLOCK" && matchesWhere) {
      blocked = true;
      reasons.push(`Contrainte manuelle bloquante: ${rule.raw}`);
    } else if (rule.mode === "REQUIRE" && !matchesWhere) {
      blocked = true;
      reasons.push(`Contrainte manuelle obligatoire non respectée: ${rule.raw}`);
    } else if (rule.mode === "AVOID" && matchesWhere) {
      scoreDelta -= 14;
      reasons.push(`Contrainte manuelle (éviter): ${rule.raw}`);
    } else if (rule.mode === "PREFER" && matchesWhere) {
      scoreDelta += 10;
      reasons.push(`Contrainte manuelle (préférer): ${rule.raw}`);
    }
  }

  return { blocked, scoreDelta, reasons };
}

function sessionTouchesSwimSlot(session) {
  if (!session) return false;
  const covered = getCoveredSlots(session.day, session.start, Number(session.duration || 0));
  return covered.some((slotKey) => {
    const [day, slot] = String(slotKey).split("|");
    return hasSwimSlot(day, slot);
  });
}

function classHasAtLeastOneSwimSession(classId) {
  return state.sessions
    .filter((s) => s.classId === classId && String(s.type || "").toUpperCase() === "EPS")
    .some((s) => sessionTouchesSwimSlot(s));
}

async function saveAlgoConstraintsToFirestore() {
  if (state.algoConstraintsSaving) return;
  state.algoConstraintsSaving = true;
  try {
    const constraints = getAlgoConstraintRows();
    await setDoc(
      doc(db, "planningConfig", "algoConstraints"),
      {
        constraints,
        blockedSlotsByYear: state.algoBlockedSlotsByYear || {},
        pinnedClassSlotsByYear: state.algoPinnedClassSlotsByYear || {},
        updatedAt: serverTimestamp(),
      },
      { merge: true }
    );
    state.algoConstraintsDirty = false;
    if (ui.algoConstraintsStatus) ui.algoConstraintsStatus.textContent = "Contraintes Algo enregistrées.";
  } catch (error) {
    if (ui.algoConstraintsStatus) {
      ui.algoConstraintsStatus.textContent = `Erreur enregistrement contraintes Algo: ${error?.message || "échec."}`;
    }
  } finally {
    state.algoConstraintsSaving = false;
    renderAlgoPanel();
  }
}

function queueSaveAlgoConstraints() {
  state.algoConstraintsDirty = true;
  if (ui.algoConstraintsStatus) {
    ui.algoConstraintsStatus.textContent = "Contraintes Algo modifiées (enregistrement en attente)...";
  }
  if (state.algoConstraintsSaveTimer) clearTimeout(state.algoConstraintsSaveTimer);
  state.algoConstraintsSaveTimer = setTimeout(() => {
    saveAlgoConstraintsToFirestore();
  }, 600);
}

function addAlgoConstraintFromDraft() {
  if (!ui.algoConstraintDraft) return;
  const value = normalizeAlgoConstraint(ui.algoConstraintDraft.value);
  if (!value) return;
  state.algoConstraints = [...(state.algoConstraints || []), value];
  ui.algoConstraintDraft.value = "";
  queueSaveAlgoConstraints();
  renderAlgoPanel();
}

function normalizeLookupKey(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function resolveTeacherIdFromAiValue(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  if (state.teachers.some((t) => t.id === raw)) return raw;
  const key = normalizeLookupKey(raw);
  let found = state.teachers.find((t) => normalizeLookupKey(t.abbreviation) === key);
  if (found) return found.id;
  found = state.teachers.find((t) => normalizeLookupKey(t.name) === key);
  if (found) return found.id;
  found = state.teachers.find((t) => normalizeLookupKey(getTeacherDisplayLabel(t)) === key);
  if (found) return found.id;
  return "";
}

function resolveClassIdFromAiValue(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  if (state.classes.some((c) => c.id === raw)) return raw;
  if (isSpecialAssignmentId(raw)) return raw;
  const upper = raw.toUpperCase();
  if (upper === "AS") return "__AS__";
  if (upper === "DANSE") return "__DANSE__";
  const asMatch = upper.match(/^AS[\s_-]*(\d{1,2})$/);
  if (asMatch) return `__AS${asMatch[1]}__`;
  const key = normalizeLookupKey(raw);
  let found = state.classes.find((c) => normalizeLookupKey(c.name) === key);
  if (found) return found.id;
  found = state.classes.find((c) => normalizeLookupKey(`${c.level} ${c.name}`) === key);
  if (found) return found.id;
  return "";
}

function normalizeAiDay(value) {
  const key = normalizeLookupKey(value);
  const map = new Map([
    ["lundi", "Lundi"],
    ["mardi", "Mardi"],
    ["mercredi", "Mercredi"],
    ["jeudi", "Jeudi"],
    ["vendredi", "Vendredi"],
  ]);
  return map.get(key) || "";
}

function normalizeAiStart(value) {
  const raw = String(value || "").trim();
  if (SLOTS.includes(raw)) return raw;
  const normalized = raw.replace("h", ":");
  if (SLOTS.includes(normalized)) return normalized;
  return "";
}

function normalizeAiCadence(value) {
  const key = normalizeLookupKey(value).replace(/\s+/g, "");
  if (key.includes("bi") || key === "a/b" || key === "weekab" || key === "biweekly") return "BIWEEKLY";
  return "WEEKLY";
}

function normalizeAiWeekType(value) {
  const upper = String(value || "").trim().toUpperCase();
  return upper === "B" ? "B" : "A";
}

function extractJsonFromModelText(text) {
  const raw = String(text || "").trim();
  if (!raw) throw new Error("Réponse vide du modèle.");
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  const candidate = fenced ? fenced[1] : raw;
  try {
    return JSON.parse(candidate);
  } catch (_error) {
    const start = candidate.indexOf("{");
    const end = candidate.lastIndexOf("}");
    if (start >= 0 && end > start) {
      return JSON.parse(candidate.slice(start, end + 1));
    }
    throw new Error("JSON invalide retourné par Gemini.");
  }
}

async function listGeminiModels(apiKey) {
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}`;
  const response = await fetch(endpoint, { method: "GET" });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`ListModels ${response.status}: ${text.slice(0, 300)}`);
  }
  const data = await response.json();
  return Array.isArray(data?.models) ? data.models : [];
}

function pickGeminiModelFromList(models, preferredModel = "") {
  const preferred = String(preferredModel || "").trim().replace(/^models\//, "");
  const supportsGenerate = (m) =>
    Array.isArray(m?.supportedGenerationMethods) && m.supportedGenerationMethods.includes("generateContent");
  const candidates = models.filter(supportsGenerate);
  if (!candidates.length) return "";

  const byName = (name) =>
    candidates.find((m) => String(m.name || "").replace(/^models\//, "") === name);

  if (preferred) {
    const exact = byName(preferred);
    if (exact) return String(exact.name || "").replace(/^models\//, "");
  }

  const priorityMatchers = ["gemini-2.5-flash", "gemini-2.0-flash", "gemini-2.5-pro", "gemini-2.0-pro", "flash", "pro"];
  for (const key of priorityMatchers) {
    const found = candidates.find((m) => String(m.name || "").toLowerCase().includes(key));
    if (found) return String(found.name || "").replace(/^models\//, "");
  }

  return String(candidates[0]?.name || "").replace(/^models\//, "");
}

async function resolveGeminiModel(apiKey, preferredModel = "") {
  const models = await listGeminiModels(apiKey);
  return pickGeminiModelFromList(models, preferredModel);
}

function buildGeminiPromptForEdt(constraintsText, targetCount) {
  const teacherRows = state.teachers.map((t) => ({
    id: t.id,
    name: t.name,
    abbreviation: t.abbreviation || getTeacherDisplayLabel(t),
    maxHours: Number(t.maxHours || 0),
    unavailable: Array.isArray(t.unavailable) ? t.unavailable : [],
    assignedLevelQuotas: getTeacherAssignedLevelQuotas(t),
    assignedTargetsLegacy: normalizeTeacherAssignedTargets(t.assignedTargets || []),
  }));
  const classRows = state.classes.map((c) => ({
    id: c.id,
    level: c.level,
    name: c.name,
    weeklyHours: Number(c.weeklyHours || 0),
  }));
  const desiderata = state.desiderataSlots.map((d) => ({
    teacherId: d.teacherId,
    day: d.day,
    slot: d.slot,
    status: d.status,
  }));
  const swim = state.swimSlots.map((s) => ({ day: s.day, slot: s.slot }));
  const existingSessions = state.sessions.slice(0, 500).map((s) => ({
    teacherId: s.teacherId,
    classId: s.classId,
    type: s.type,
    day: s.day,
    start: s.start,
    duration: Number(s.duration || 0),
    cadence: normalizeCadence(s.cadence),
    weekType: normalizeWeekType(s.weekType),
  }));
  const schoolYear = {
    startDate: state.schoolYearConfig?.startDate || "",
    endDate: state.schoolYearConfig?.endDate || "",
    vacations: Array.isArray(state.schoolYearConfig?.vacations) ? state.schoolYearConfig.vacations : [],
    holidays: Array.isArray(state.schoolYearConfig?.holidays) ? state.schoolYearConfig.holidays : [],
  };

  return [
    "Tu es un moteur de génération d'emploi du temps EPS.",
    "Réponds uniquement en JSON strict, sans commentaire, sans markdown.",
    "RÈGLE IMPÉRATIVE: respecte assignedLevelQuotas. Ex: {'Sixième':2,'AS':1,'DANSE':1}.",
    "Si assignedLevelQuotas est vide pour un enseignant, alors il peut enseigner sur tous les niveaux.",
    "RÈGLE IMPÉRATIVE: ne dépasse jamais maxHours pour aucun enseignant.",
    "RÈGLE IMPÉRATIVE: pour chaque créneau horaire (jour + heure), il faut au maximum 4 professeurs simultanés.",
    "RÈGLE IMPÉRATIVE: si un enseignant a à la fois des 3e et des 4e, créer des paires 3e/4e en parallèle au même créneau avec alternance semaine A/B.",
    "Format attendu:",
    '{"sessions":[{"teacher":"<teacherId|abbreviation|name>","class":"<classId|level+name|AS|AS 3|Danse>","type":"EPS|AS|DANSE","day":"Lundi|Mardi|Mercredi|Jeudi|Vendredi","start":"08:15|09:05|10:20|11:10|12:10|13:00|14:00|15:00|16:05|16:55","duration":1|2|3,"cadence":"WEEKLY|BIWEEKLY","weekType":"A|B"}]}',
    `Nombre maximum de sessions à proposer: ${targetCount}.`,
    "Priorise la qualité plutôt que la quantité.",
    "Contraintes métier fournies par l'administrateur:",
    constraintsText || "(aucune contrainte personnalisée)",
    "Données enseignants:",
    JSON.stringify(teacherRows),
    "Données classes:",
    JSON.stringify(classRows),
    "Désidérata:",
    JSON.stringify(desiderata),
    "Créneaux natation:",
    JSON.stringify(swim),
    "Sessions existantes (à respecter si l'option remplacement total n'est pas activée):",
    JSON.stringify(existingSessions),
    "Année scolaire:",
    JSON.stringify(schoolYear),
  ].join("\n");
}

async function deleteAllSessionsForAiGeneration() {
  const sessionsRef = collection(db, "sessions");
  const snap = await sessionsRef.get();
  if (snap.empty) return;
  // Ne supprimer QUE les créneaux posés par l'algorithme (placedBy === "ALGO").
  // Les créneaux manuels (placedBy === "MANUAL" ou champ absent) sont préservés.
  const docs = (snap.docs || [])
    .filter((d) => isDocInActiveSchoolYear(d.data() || {}))
    .filter((d) => d.data()?.placedBy === "ALGO");
  if (!docs.length) return;
  const chunkSize = 380;
  for (let i = 0; i < docs.length; i += chunkSize) {
    const batch = db.batch();
    const chunk = docs.slice(i, i + chunkSize);
    chunk.forEach((d) => batch.delete(d.ref));
    await batch.commit();
  }
  // Attendre que les snapshots Firestore se synchronisent côté UI.
  for (let tries = 0; tries < 12; tries += 1) {
    const check = await sessionsRef.get();
    const remaining = (check.docs || [])
      .filter((d) => isDocInActiveSchoolYear(d.data() || {}))
      .some((d) => d.data()?.placedBy === "ALGO");
    if (!remaining) break;
    await sleep(120);
  }
}

async function clearAllSessionsIncludingManual() {
  if (state.algoBusy) return;
  if (!ui.algoGenerationStatus) return;
  try {
    ui.algoGenerationStatus.textContent = "Suppression de tous les créneaux en cours...";
    // Supprimer TOUS les créneaux de l'année active (algo + manuels)
    const sessionsRef = collection(db, "sessions");
    const snap = await sessionsRef.get();
    const docs = (snap.docs || []).filter((d) => isDocInActiveSchoolYear(d.data() || {}));
    const chunkSize = 380;
    for (let i = 0; i < docs.length; i += chunkSize) {
      const batch = db.batch();
      docs.slice(i, i + chunkSize).forEach((d) => batch.delete(d.ref));
      await batch.commit();
    }
    state.sessions = [];
    state.algoLastReportRows = ["Suppression totale terminée : tous les créneaux (algo et manuels) ont été effacés."];
    state.algoLastReportData = {
      summary: { created: 0, failed: 0, remainingClasses: 0, remainingHours: 0 },
      teachers: [], remaining: [], errors: [],
    };
    ui.algoGenerationStatus.textContent = "Tous les créneaux supprimés (algo + manuels).";
    showToast("Tous les créneaux ont été supprimés.", "success");
    render();
  } catch (error) {
    ui.algoGenerationStatus.textContent = `Erreur suppression : ${error?.message || "échec."}`;
    showToast(`Erreur : ${error?.message || "échec."}`, "error");
  }
}

async function clearAllSessionsFromAlgoPanel() {
  if (state.algoBusy) return;
  if (!ui.algoGenerationStatus) return;
  try {
    ui.algoGenerationStatus.textContent = "Suppression des créneaux algo en cours...";
    await deleteAllSessionsForAiGeneration();
    state.sessions = state.sessions.filter((s) => s.placedBy !== "ALGO");
    state.algoLastReportRows = ["Suppression terminée : seuls les créneaux posés par l'algorithme ont été effacés. Les créneaux manuels sont conservés."];
    state.algoLastReportData = {
      summary: { created: 0, failed: 0, remainingClasses: 0, remainingHours: 0 },
      teachers: [],
      remaining: [],
      errors: [],
    };
    ui.algoGenerationStatus.textContent = "Créneaux algo supprimés. Les créneaux manuels sont conservés.";
  } catch (error) {
    ui.algoGenerationStatus.textContent = `Erreur suppression créneaux: ${error?.message || "échec."}`;
    state.algoLastReportRows = [String(error?.message || "Erreur suppression créneaux.")];
    state.algoLastReportData = {
      summary: { created: 0, failed: 0, remainingClasses: 0, remainingHours: 0 },
      teachers: [],
      remaining: [],
      errors: [String(error?.message || "Erreur suppression créneaux.")],
    };
  } finally {
    renderAlgoPanel();
  }
}

async function applyAiGeneratedSessions(sessions) {
  let created = 0;
  let failed = 0;
  const errors = [];
  for (let index = 0; index < sessions.length; index += 1) {
    const row = sessions[index] || {};
    const teacherId = resolveTeacherIdFromAiValue(row.teacherId || row.teacher || row.prof || row.enseignant);
    const classId = resolveClassIdFromAiValue(row.classId || row.class || row.classe);
    const day = normalizeAiDay(row.day);
    const start = normalizeAiStart(row.start);
    const duration = Number(row.duration || 0);
    const cadence = normalizeAiCadence(row.cadence);
    const weekType = normalizeAiWeekType(row.weekType);
    const special = getSpecialAssignmentById(classId);
    const type = String(row.type || (special?.type || "EPS")).toUpperCase();

    if (!teacherId || !classId || !day || !start || !duration) {
      failed += 1;
      errors.push(`Ligne ${index + 1}: données incomplètes ou non reconnues.`);
      continue;
    }
    const teacher = state.teachers.find((t) => t.id === teacherId);
    if (!teacher) {
      failed += 1;
      errors.push(`Ligne ${index + 1}: professeur introuvable.`);
      continue;
    }
    if (!isTeacherAssignedToClass(teacher, classId)) {
      failed += 1;
      errors.push(
        `Ligne ${index + 1}: hors attribution (${teacher.name || "professeur"} -> ${getClassLabelById(classId, true)}).`
      );
      continue;
    }
    if (!canTeacherTakeClassByLevelQuota(teacher, classId)) {
      failed += 1;
      errors.push(`Ligne ${index + 1}: quota de classes atteint pour ${teacher.name || "professeur"}.`);
      continue;
    }

    let createResult = await createSession({
      teacherId,
      classId,
      type,
      day,
      start,
      duration,
      cadence,
      weekType,
    });

    // Si conflit, on essaie de trouver un autre créneau libre
    if (!createResult.ok && createResult.error?.includes("Conflit:")) {
      let foundAlt = false;
      // On parcourt les jours et les bandes horaires pour trouver une place
      for (const altDay of DAYS) {
        for (const band of SLOT_BANDS) {
          const altStart = band.start;
          const attempt = await createSession({
            teacherId,
            classId,
            type,
            day: altDay,
            start: altStart,
            duration,
            cadence,
            weekType,
          });
          if (attempt.ok) {
            created += 1;
            foundAlt = true;
            break;
          }
        }
        if (foundAlt) break;
      }
      if (!foundAlt) {
        failed += 1;
        errors.push(`Ligne ${index + 1}: ${createResult.error} (Aucun créneau alternatif trouvé)`);
      }
    } else if (createResult.ok) {
      created += 1;
    } else {
      failed += 1;
      errors.push(`Ligne ${index + 1}: ${createResult.error || "échec création"}`);
    }
  }

  return { created, failed, errors };
}

function renderAIPanel() {
  if (!ui.aiGenerationStatus || !ui.aiGenerationReport) return;
  if (ui.aiGeminiModel && !ui.aiGeminiModel.value) {
    ui.aiGeminiModel.value = localStorage.getItem("aiGeminiModel") || "gemini-2.5-flash";
  }
  if (ui.aiGenerationTargetCount && !ui.aiGenerationTargetCount.value) {
    ui.aiGenerationTargetCount.value = localStorage.getItem("aiGenerationTargetCount") || "160";
  }
  if (ui.aiReplaceExistingSessions) {
    ui.aiReplaceExistingSessions.checked = localStorage.getItem("aiReplaceExistingSessions") === "1";
  }
  updateAIPromptPreview();
  if (ui.aiConstraintsList) {
    const activeEl = document.activeElement;
    const isEditingConstraint =
      Boolean(activeEl) &&
      ui.aiConstraintsList.contains(activeEl) &&
      activeEl instanceof HTMLElement &&
      activeEl.hasAttribute("data-ai-constraint-input");

    if (!isEditingConstraint) {
      const rows = (state.aiConstraints || [])
        .map((value, index) => `
          <div class="ai-constraint-row">
            <input type="text" value="${escapeHtml(value)}" data-ai-constraint-input="${index}" />
            <button type="button" class="delete-btn" data-ai-constraint-delete="${index}">Suppr.</button>
          </div>
        `)
        .join("");
      ui.aiConstraintsList.innerHTML = rows || `<p class="summary-box">Aucune contrainte enregistrée.</p>`;
      ui.aiConstraintsList.querySelectorAll("[data-ai-constraint-input]").forEach((input) => {
        input.addEventListener("input", () => {
          const idx = Number(input.dataset.aiConstraintInput);
          if (!Number.isFinite(idx)) return;
          state.aiConstraints[idx] = normalizeAiConstraint(input.value);
          updateAIPromptPreview();
          queueSaveAiConstraints();
        });
        input.addEventListener("blur", () => {
          const idx = Number(input.dataset.aiConstraintInput);
          if (!Number.isFinite(idx)) return;
          const value = normalizeAiConstraint(input.value);
          if (!value) {
            state.aiConstraints = state.aiConstraints.filter((_, i) => i !== idx);
            renderAIPanel();
          }
          updateAIPromptPreview();
          queueSaveAiConstraints();
        });
      });
      ui.aiConstraintsList.querySelectorAll("[data-ai-constraint-delete]").forEach((btn) => {
        btn.addEventListener("click", () => {
          const idx = Number(btn.dataset.aiConstraintDelete);
          if (!Number.isFinite(idx)) return;
          state.aiConstraints = state.aiConstraints.filter((_, i) => i !== idx);
          updateAIPromptPreview();
          queueSaveAiConstraints();
          renderAIPanel();
        });
      });
    }
  }
  if (ui.aiConstraintsStatus) {
    if (!state.aiConstraintsLoaded) ui.aiConstraintsStatus.textContent = "Chargement des contraintes...";
    else if (state.aiConstraintsSaving) ui.aiConstraintsStatus.textContent = "Enregistrement des contraintes...";
    else if (state.aiConstraintsDirty) ui.aiConstraintsStatus.textContent = "Contraintes modifiées (enregistrement en attente)...";
    else if (!ui.aiConstraintsStatus.textContent || ui.aiConstraintsStatus.textContent.includes("Chargement")) {
      ui.aiConstraintsStatus.textContent = "Contraintes prêtes.";
    }
  }
  if (ui.aiGenerateEdtBtn) {
    ui.aiGenerateEdtBtn.disabled = state.aiBusy;
    ui.aiGenerateEdtBtn.textContent = state.aiBusy ? "Génération en cours..." : "Lancer la génération";
  }
  if (!state.aiLastReportRows.length) {
    ui.aiGenerationReport.innerHTML = `<p class="summary-box">Aucun rapport pour le moment.</p>`;
  } else {
    const rows = state.aiLastReportRows.map((x) => `<li>${escapeHtml(x)}</li>`).join("");
    ui.aiGenerationReport.innerHTML = `<ul class="ai-report-list">${rows}</ul>`;
  }
}

function renderAlgoPanel() {
  if (!ui.algoGenerationStatus || !ui.algoGenerationReport) return;
  if (ui.algoGenerationTargetCount && !ui.algoGenerationTargetCount.value) {
    ui.algoGenerationTargetCount.value = localStorage.getItem("algoGenerationTargetCount") || "160";
  }
  if (ui.algoPinnedSlotSelect) {
    ui.algoPinnedSlotSelect.innerHTML = SLOT_BANDS.map((b) => `<option value="${escapeHtml(b.start)}">${escapeHtml(b.label)}</option>`).join("");
  }
  if (ui.algoPinnedClassSelect) {
    const options = state.classes
      .slice()
      .sort((a, b) => getLevelSortWeight(a.level) - getLevelSortWeight(b.level) || String(a.name || "").localeCompare(String(b.name || ""), "fr"))
      .map((c) => `<option value="${escapeHtml(c.id)}">${escapeHtml(getClassLabelById(c.id, true))}</option>`)
      .join("");
    ui.algoPinnedClassSelect.innerHTML = options || `<option value="">Aucune classe</option>`;
  }
  if (ui.algoPinnedClassesList) {
    const rows = getAlgoPinnedClassSlotsForActiveYear();
    ui.algoPinnedClassesList.innerHTML =
      rows.length === 0
        ? `<p class="summary-box">Aucun pré-placement enregistré.</p>`
        : rows
            .map((row, idx) => {
              const cadenceLabel =
                row.cadence === "WEEK_A" ? "Semaine A" : row.cadence === "WEEK_B" ? "Semaine B" : "Hebdo";
              return `<div class="ai-constraint-row">
                <input type="text" value="${escapeHtml(`${getClassLabelById(row.classId, true)} · ${row.day} ${row.slot} · ${cadenceLabel}`)}" readonly />
                <button type="button" class="delete-btn" data-algo-pinned-delete="${idx}">Suppr.</button>
              </div>`;
            })
            .join("");
    ui.algoPinnedClassesList.querySelectorAll("[data-algo-pinned-delete]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const idx = Number(btn.dataset.algoPinnedDelete);
        if (!Number.isFinite(idx)) return;
        const next = getAlgoPinnedClassSlotsForActiveYear().filter((_, i) => i !== idx);
        setAlgoPinnedClassSlotsForActiveYear(next);
        queueSaveAlgoConstraints();
        renderAlgoPanel();
      });
    });
  }
  if (ui.algoGenerateEdtBtn) {
    ui.algoGenerateEdtBtn.disabled = state.algoBusy;
    ui.algoGenerateEdtBtn.textContent = state.algoBusy ? "Simulation en cours..." : "Simuler la génération Algo";
  }
  if (ui.algoClearExistingSessionsBtn) {
    ui.algoClearExistingSessionsBtn.disabled = state.algoBusy;
  }
  if (ui.algoClearAllSessionsBtn) {
    ui.algoClearAllSessionsBtn.disabled = state.algoBusy;
  }
  if (ui.algoApplyProposalBtn) {
    const pendingCount = Array.isArray(state.algoPendingSessions) ? state.algoPendingSessions.length : 0;
    ui.algoApplyProposalBtn.disabled = state.algoBusy || pendingCount === 0;
    ui.algoApplyProposalBtn.textContent = pendingCount
      ? `Appliquer la proposition (${pendingCount})`
      : "Appliquer la proposition";
  }
  if (ui.algoConstraintsList) {
    const activeEl = document.activeElement;
    const isEditingConstraint =
      Boolean(activeEl) &&
      ui.algoConstraintsList.contains(activeEl) &&
      activeEl instanceof HTMLElement &&
      activeEl.hasAttribute("data-algo-constraint-input");
    if (!isEditingConstraint) {
      const rows = (state.algoConstraints || [])
        .map((value, index) => `
          <div class="ai-constraint-row">
            <input type="text" value="${escapeHtml(value)}" data-algo-constraint-input="${index}" />
            <button type="button" class="delete-btn" data-algo-constraint-delete="${index}">Suppr.</button>
          </div>
        `)
        .join("");
      ui.algoConstraintsList.innerHTML = rows || `<p class="summary-box">Aucune contrainte manuelle enregistrée.</p>`;
      ui.algoConstraintsList.querySelectorAll("[data-algo-constraint-input]").forEach((input) => {
        input.addEventListener("input", () => {
          const idx = Number(input.dataset.algoConstraintInput);
          if (!Number.isFinite(idx)) return;
          state.algoConstraints[idx] = normalizeAlgoConstraint(input.value);
          queueSaveAlgoConstraints();
          renderAlgoPanel();
        });
        input.addEventListener("blur", () => {
          const idx = Number(input.dataset.algoConstraintInput);
          if (!Number.isFinite(idx)) return;
          const value = normalizeAlgoConstraint(input.value);
          if (!value) {
            state.algoConstraints = state.algoConstraints.filter((_, i) => i !== idx);
            queueSaveAlgoConstraints();
            renderAlgoPanel();
            return;
          }
          state.algoConstraints[idx] = value;
          queueSaveAlgoConstraints();
        });
      });
      ui.algoConstraintsList.querySelectorAll("[data-algo-constraint-delete]").forEach((btn) => {
        btn.addEventListener("click", () => {
          const idx = Number(btn.dataset.algoConstraintDelete);
          if (!Number.isFinite(idx)) return;
          state.algoConstraints = state.algoConstraints.filter((_, i) => i !== idx);
          queueSaveAlgoConstraints();
          renderAlgoPanel();
        });
      });
    }
  }
  if (ui.algoBlockedSlotsContainer) {
    const blocked = getAlgoBlockedSlotsForActiveYear();
    const head = DAYS.map((day) => `<th>${escapeHtml(day)}</th>`).join("");
    const rows = SLOT_BANDS.map((band) => {
      const cols = DAYS.map((day) => {
        const key = toSlotKey(day, band.start);
        const active = blocked.has(key);
        return `<td>
          <button type="button" class="algo-block-slot-btn ${active ? "is-blocked" : ""}" data-algo-block-slot="${escapeHtml(key)}">
            ${active ? "Bloqué" : "Libre"}
          </button>
        </td>`;
      }).join("");
      return `<tr><th>${escapeHtml(band.label)}</th>${cols}</tr>`;
    }).join("");
    ui.algoBlockedSlotsContainer.innerHTML = `
      <table>
        <thead><tr><th>Créneau</th>${head}</tr></thead>
        <tbody>${rows}</tbody>
      </table>
    `;
    ui.algoBlockedSlotsContainer.querySelectorAll("[data-algo-block-slot]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const key = String(btn.dataset.algoBlockSlot || "").trim();
        if (!key) return;
        const next = getAlgoBlockedSlotsForActiveYear();
        if (next.has(key)) next.delete(key);
        else next.add(key);
        setAlgoBlockedSlotsForActiveYear(next);
        queueSaveAlgoConstraints();
        renderAlgoPanel();
      });
    });
  }
  if (ui.algoConstraintsStatus) {
    if (!state.algoConstraintsLoaded) ui.algoConstraintsStatus.textContent = "Chargement des contraintes Algo...";
    else if (state.algoConstraintsSaving) ui.algoConstraintsStatus.textContent = "Enregistrement des contraintes Algo...";
    else if (state.algoConstraintsDirty) ui.algoConstraintsStatus.textContent = "Contraintes Algo modifiées (enregistrement en attente)...";
    else if (!ui.algoConstraintsStatus.textContent || ui.algoConstraintsStatus.textContent.includes("Chargement")) {
      ui.algoConstraintsStatus.textContent = "Contraintes Algo prêtes.";
    }
  }
  if (ui.algoActiveRulesPanel) {
    const rules = getAlgoActiveRules();
    const hardRows = rules.hardRules.map((x) => `<li>${escapeHtml(x)}</li>`).join("");
    const manualRows = rules.manual.length
      ? rules.manual.map((x) => `<li>${escapeHtml(x)}</li>`).join("")
      : `<li>Aucune contrainte manuelle.</li>`;
    ui.algoActiveRulesPanel.innerHTML = `
      <p><strong>Règles techniques</strong></p>
      <ul class="ai-report-list">${hardRows}</ul>
      <p style="margin-top:0.8rem"><strong>Contraintes manuelles</strong></p>
      <ul class="ai-report-list">${manualRows}</ul>
    `;
  }
  if (state.algoLastReportData) {
    const data = state.algoLastReportData;
    const hasPendingProposal = Array.isArray(state.algoPendingSessions) && state.algoPendingSessions.length > 0;
    const summaryRows = [
      `<li>${hasPendingProposal ? "Créneaux proposés" : "Créneaux créés"}: <strong>${escapeHtml(String(data.summary?.created || 0))}</strong></li>`,
      `<li>Créations rejetées: <strong>${escapeHtml(String(data.summary?.failed || 0))}</strong></li>`,
      `<li>Classes partiellement/non couvertes: <strong>${escapeHtml(String(data.summary?.remainingClasses || 0))}</strong></li>`,
      `<li>Heures restantes: <strong>${escapeHtml(String(formatHours(data.summary?.remainingHours || 0)))}h</strong></li>`,
      `<li>Malus répartition professeurs: <strong>${escapeHtml(String(data.summary?.weekSpreadPenalty || 0))}</strong></li>`,
      `<li>Score global: <strong>${escapeHtml(String(data.summary?.score ?? "—"))}</strong></li>`,
      `<li>Tentative retenue: <strong>${escapeHtml(String(data.summary?.attemptIndex || "—"))}/${escapeHtml(String(data.summary?.attempts || "—"))}</strong></li>`,
    ].join("");
    const teacherRows = (data.teachers || [])
      .map(
        (row) => `<tr>
          <td>${escapeHtml(row.teacherName || "—")}</td>
          <td>${escapeHtml(String(row.sessionsAdded || 0))}</td>
          <td>${escapeHtml(String(formatHours(row.hoursAdded || 0)))}h</td>
          <td>${escapeHtml(String(row.classesTouched || 0))}</td>
        </tr>`
      )
      .join("");
    const remainingRows = (data.remaining || [])
      .map(
        (x) => `<tr>
          <td>${escapeHtml(x.level || "")}</td>
          <td>${escapeHtml(x.name || "")}</td>
          <td>${escapeHtml(String(formatHours(x.remaining || 0)))}h</td>
        </tr>`
      )
      .join("");
    const rejectedRows = (data.rejectedDetails || [])
      .map(
        (x) => `<tr>
          <td>${escapeHtml(x.classLabel || "—")}</td>
          <td>${escapeHtml(x.teacherName || "—")}</td>
          <td>${escapeHtml(x.reason || "—")}</td>
        </tr>`
      )
      .join("");
    const attemptRows = (data.attemptResults || [])
      .map(
        (x) => `<tr>
          <td>${escapeHtml(String(x.attemptIndex || "—"))}</td>
          <td>${escapeHtml(String(x.strategy || "—"))}</td>
          <td><strong>${escapeHtml(String(x.score ?? "—"))}</strong></td>
          <td>${escapeHtml(String(x.created || 0))}</td>
          <td>${escapeHtml(String(formatHours(x.remainingHours || 0)))}h</td>
          <td>${escapeHtml(String(x.remainingClasses || 0))}</td>
        </tr>`
      )
      .join("");
    const nonPlaceableRows = buildAlgoNonPlaceableRows(data)
      .map(
        (x) => `<tr>
          <td>${escapeHtml(x.classLabel || "—")}</td>
          <td>${escapeHtml(String(x.remainingHours || 0))}h</td>
          <td>${escapeHtml((x.reasons || []).join(" | ") || "Aucun créneau valide trouvé avec les contraintes actuelles.")}</td>
        </tr>`
      )
      .join("");
    const errorRows = (data.errors || []).map((x) => `<li>${escapeHtml(x)}</li>`).join("");
    ui.algoGenerationReport.innerHTML = `
      <div class="summary-box">
        <strong>Synthèse</strong>
        <ul class="ai-report-list">${summaryRows}</ul>
      </div>
      <div class="summary-box" style="margin-top:0.6rem">
        <strong>Simulation rapide (3 propositions notées)</strong>
        <div class="table-wrap" style="margin-top:0.4rem">
          <table>
            <thead><tr><th>#</th><th>Stratégie</th><th>Score</th><th>Créneaux</th><th>Heures restantes</th><th>Classes restantes</th></tr></thead>
            <tbody>${attemptRows || `<tr><td colspan="6">Aucune tentative.</td></tr>`}</tbody>
          </table>
        </div>
      </div>
      <div class="table-wrap" style="margin-top:0.6rem">
        <strong>Par enseignant</strong>
        <table>
          <thead><tr><th>Enseignant</th><th>Créneaux ajoutés</th><th>Heures ajoutées</th><th>Classes touchées</th></tr></thead>
          <tbody>${teacherRows || `<tr><td colspan="4">Aucun créneau ajouté.</td></tr>`}</tbody>
        </table>
      </div>
      <div class="summary-box" style="margin-top:0.6rem">
        <strong>Classes partiellement/non couvertes (détail)</strong>
        <div class="table-wrap" style="margin-top:0.4rem">
          <table>
            <thead><tr><th>Niveau</th><th>Classe</th><th>Heures restantes</th></tr></thead>
            <tbody>${remainingRows || `<tr><td colspan="3">Aucune.</td></tr>`}</tbody>
          </table>
        </div>
      </div>
      <div class="summary-box" style="margin-top:0.6rem">
        <strong>Pourquoi non plaçable</strong>
        <div class="table-wrap" style="margin-top:0.4rem">
          <table>
            <thead><tr><th>Classe</th><th>Heures non placées</th><th>Causes probables</th></tr></thead>
            <tbody>${nonPlaceableRows || `<tr><td colspan="3">Aucun blocage détecté.</td></tr>`}</tbody>
          </table>
        </div>
      </div>
      <div class="summary-box" style="margin-top:0.6rem">
        <strong>Créations rejetées (détail)</strong>
        <div class="table-wrap" style="margin-top:0.4rem">
          <table>
            <thead><tr><th>Classe</th><th>Professeur</th><th>Motif du rejet</th></tr></thead>
            <tbody>${rejectedRows || `<tr><td colspan="3">Aucun rejet.</td></tr>`}</tbody>
          </table>
        </div>
      </div>
      <div class="summary-box" style="margin-top:0.6rem">
        <strong>Erreurs rencontrées</strong>
        <ul class="ai-report-list">${errorRows || "<li>Aucune erreur.</li>"}</ul>
      </div>
    `;
  } else if (!state.algoLastReportRows.length) {
    ui.algoGenerationReport.innerHTML = `<p class="summary-box">Aucun rapport pour le moment.</p>`;
  } else {
    const rows = state.algoLastReportRows.map((x) => `<li>${escapeHtml(x)}</li>`).join("");
    ui.algoGenerationReport.innerHTML = `<ul class="ai-report-list">${rows}</ul>`;
  }
}

function buildAlgoNonPlaceableRows(data) {
  const rows = [];
  const byClass = new Map();
  for (const rem of data?.remaining || []) {
    const label = `${String(rem.level || "").trim()} ${String(rem.name || "").trim()}`.trim();
    if (!label) continue;
    byClass.set(label, {
      classLabel: label,
      remainingHours: Number(formatHours(rem.remaining || 0)),
      reasons: new Set(),
    });
  }
  for (const rej of data?.rejectedDetails || []) {
    const label = String(rej.classLabel || "").trim();
    if (!label || label === "—") continue;
    if (!byClass.has(label)) {
      byClass.set(label, { classLabel: label, remainingHours: 0, reasons: new Set() });
    }
    const reason = String(rej.reason || "").trim();
    if (reason) byClass.get(label).reasons.add(reason);
  }
  byClass.forEach((entry) => {
    rows.push({
      classLabel: entry.classLabel,
      remainingHours: Number.isFinite(entry.remainingHours) ? entry.remainingHours : 0,
      reasons: Array.from(entry.reasons).slice(0, 4),
    });
  });
  rows.sort((a, b) => String(a.classLabel).localeCompare(String(b.classLabel), "fr"));
  return rows;
}

function getClassAlgoRemaining(classId) {
  const cls = state.classes.find((c) => c.id === classId);
  if (!cls) return 0;
  return Math.max(0, Number(cls.weeklyHours || 0) - getAssignedHoursForClass(classId));
}

function getCadencePreferencesForClass(cls) {
  const group = getLevelRule(cls?.level)?.group || "";
  if (group === "ALT_43") {
    const classSessions = state.sessions.filter((s) => s.classId === cls.id && String(s.type || "").toUpperCase() === "EPS");
    const hasWeekly = classSessions.some((s) => normalizeCadence(s.cadence) === "WEEKLY");
    const hasBiweekly = classSessions.some((s) => normalizeCadence(s.cadence) === "BIWEEKLY");
    if (!hasWeekly) return ["WEEKLY"];
    if (!hasBiweekly) return ["WEEK_A", "WEEK_B"];
    return [];
  }
  return ["WEEKLY"];
}

function getAssignCadenceChoicesForClass(classId) {
  const cls = state.classes.find((c) => c.id === classId);
  if (!cls) return [{ value: "WEEKLY", label: "Hebdomadaire" }];
  const group = getLevelRule(cls.level)?.group || "";
  if (group !== "ALT_43") return [{ value: "WEEKLY", label: "Hebdomadaire" }];

  const classSessions = state.sessions.filter((s) => s.classId === classId && String(s.type || "").toUpperCase() === "EPS");
  const hasWeekly = classSessions.some((s) => normalizeCadence(s.cadence) === "WEEKLY");
  const hasBiweekly = classSessions.some((s) => normalizeCadence(s.cadence) === "BIWEEKLY");

  if (!hasWeekly && !hasBiweekly) {
    return [
      { value: "WEEKLY", label: "Hebdomadaire" },
      { value: "WEEK_A", label: "Semaine A" },
      { value: "WEEK_B", label: "Semaine B" },
    ];
  }
  if (hasWeekly && !hasBiweekly) {
    return [
      { value: "WEEK_A", label: "Semaine A" },
      { value: "WEEK_B", label: "Semaine B" },
    ];
  }
  if (!hasWeekly && hasBiweekly) {
    return [{ value: "WEEKLY", label: "Hebdomadaire" }];
  }
  return [];
}

function closeCadenceChoiceModal(value = "") {
  if (ui.cadenceChoiceModal) ui.cadenceChoiceModal.classList.add("hidden");
  const resolver = state.cadenceChoiceResolver;
  state.cadenceChoiceResolver = null;
  if (resolver) resolver(String(value || ""));
}

function openCadenceChoiceModal({ title, text, choices }) {
  return new Promise((resolve) => {
    state.cadenceChoiceResolver = resolve;
    if (!ui.cadenceChoiceModal || !ui.cadenceChoiceModalOptions || !ui.cadenceChoiceModalTitle || !ui.cadenceChoiceModalText) {
      resolve("");
      return;
    }
    ui.cadenceChoiceModalTitle.textContent = String(title || "Choisir la cadence");
    ui.cadenceChoiceModalText.textContent = String(text || "");
    ui.cadenceChoiceModalOptions.innerHTML = (choices || [])
      .map(
        (choice) => `
          <button type="button" class="secondary-btn cadence-choice-btn" data-cadence-choice="${escapeHtml(choice.value)}">
            <strong>${escapeHtml(choice.label)}</strong>
            ${choice.description ? `<small>${escapeHtml(choice.description)}</small>` : ""}
          </button>
        `
      )
      .join("");
    ui.cadenceChoiceModalOptions.querySelectorAll("[data-cadence-choice]").forEach((btn) => {
      btn.addEventListener("click", () => closeCadenceChoiceModal(String(btn.dataset.cadenceChoice || "")));
    });
    ui.cadenceChoiceModal.classList.remove("hidden");
  });
}

async function askCadencePreferenceForClass(classId) {
  const choices = getAssignCadenceChoicesForClass(classId);
  const clsLabel = getClassLabelById(classId, true);
  if (!choices.length) {
    return { ok: false, value: "", error: `${clsLabel} a déjà son créneau hebdo et son créneau semaine A/B.` };
  }
  if (choices.length === 1) {
    return { ok: true, value: choices[0].value };
  }
  const picked = await openCadenceChoiceModal({
    title: `Cadence pour ${clsLabel}`,
    text:
      choices.length === 2
        ? `${clsLabel} a déjà son créneau hebdomadaire. Choisis maintenant la semaine complémentaire.`
        : `Choisis le type de créneau à créer pour ${clsLabel}.`,
    choices: choices.map((choice) => ({
      ...choice,
      description:
        choice.value === "WEEKLY"
          ? "Même créneau toutes les semaines."
          : choice.value === "WEEK_A"
          ? "Créneau visible uniquement en semaine A."
          : "Créneau visible uniquement en semaine B.",
    })),
  });
  if (!picked) return { ok: false, value: "", error: "Choix de cadence annulé." };
  return { ok: true, value: picked };
}

function getLevelSortWeight(level) {
  const order = ["Sixième", "Cinquième", "Quatrième", "Troisième", "Seconde", "Première", "Terminale"];
  const idx = order.indexOf(String(level || ""));
  return idx < 0 ? 99 : idx;
}

function getTeacherDistinctLevelClasses(teacherId, level) {
  const set = new Set(
    state.sessions
      .filter((s) => s.teacherId === teacherId && !isSpecialAssignmentId(s.classId))
      .map((s) => s.classId)
      .filter((classId) => {
        const cls = state.classes.find((c) => c.id === classId);
        return Boolean(cls && cls.level === level);
      })
  );
  return set;
}

function getSortedClassesForLevel(level) {
  return state.classes
    .filter((cls) => String(cls.level || "") === String(level || ""))
    .sort((a, b) => String(a.name || "").localeCompare(String(b.name || ""), "fr"));
}

function getClassOwnerTeacherId(classId) {
  if (isSpecialAssignmentId(classId)) return "";
  const sessions = state.sessions.filter((s) => s.classId === classId);
  if (!sessions.length) return "";
  const hoursByTeacher = new Map();
  for (const s of sessions) {
    const teacherId = String(s.teacherId || "");
    if (!teacherId) continue;
    hoursByTeacher.set(teacherId, (hoursByTeacher.get(teacherId) || 0) + weeklyEquivalentHours(s));
  }
  return (
    Array.from(hoursByTeacher.entries())
      .sort((a, b) => b[1] - a[1])[0]?.[0] || ""
  );
}

function getRepartitionClassAssignmentsCacheKey() {
  const teacherPart = state.teachers
    .map((teacher) => `${teacher.id}:${JSON.stringify(getTeacherAssignedLevelQuotas(teacher))}`)
    .join("|");
  const classPart = state.classes
    .map((cls) => `${cls.id}:${cls.level}:${cls.name}`)
    .join("|");
  const sessionPart = state.sessions
    .map((session) => `${session.id}:${session.classId}:${session.teacherId}`)
    .join("|");
  return `${teacherPart}__${classPart}__${sessionPart}`;
}

function buildRepartitionClassAssignments() {
  const assignmentMap = new Map();
  const levels = Object.keys(LEVEL_RULES);

  for (const level of levels) {
    const levelClasses = getSortedClassesForLevel(level);
    if (!levelClasses.length) continue;

    const teachersWithQuota = state.teachers.filter((teacher) => Number(getTeacherAssignedLevelQuotas(teacher)[level] || 0) > 0);
    if (!teachersWithQuota.length) continue;

    const remaining = levelClasses.slice();
    const takeClass = (classId, teacherId) => {
      const index = remaining.findIndex((cls) => cls.id === classId);
      if (index < 0) return false;
      assignmentMap.set(classId, teacherId);
      remaining.splice(index, 1);
      return true;
    };

    for (const teacher of teachersWithQuota) {
      const quota = Math.max(0, Math.floor(Number(getTeacherAssignedLevelQuotas(teacher)[level] || 0)));
      if (!quota) continue;

      const ownedLevelClasses = Array.from(getTeacherDistinctLevelClasses(teacher.id, level))
        .map((classId) => state.classes.find((cls) => cls.id === classId))
        .filter(Boolean)
        .sort((a, b) => String(a.name || "").localeCompare(String(b.name || ""), "fr"));

      let assignedCount = 0;
      for (const cls of ownedLevelClasses) {
        if (assignedCount >= quota) break;
        if (takeClass(cls.id, teacher.id)) assignedCount += 1;
      }

      while (assignedCount < quota && remaining.length) {
        const nextClass = remaining.shift();
        if (!nextClass) break;
        assignmentMap.set(nextClass.id, teacher.id);
        assignedCount += 1;
      }
    }
  }

  return assignmentMap;
}

function getRepartitionClassAssignments() {
  const cacheKey = getRepartitionClassAssignmentsCacheKey();
  if (state.repartitionClassAssignmentsCacheKey === cacheKey && state.repartitionClassAssignmentsCache instanceof Map) {
    return state.repartitionClassAssignmentsCache;
  }
  const next = buildRepartitionClassAssignments();
  state.repartitionClassAssignmentsCacheKey = cacheKey;
  state.repartitionClassAssignmentsCache = next;
  return next;
}

function getRepartitionAssignedTeacherIdForClass(classId) {
  if (isSpecialAssignmentId(classId)) return "";
  return String(getRepartitionClassAssignments().get(classId) || "");
}

function buildAlgoClassTeacherTargets() {
  return new Map(getRepartitionClassAssignments());
}

async function findBestAlgoProposalForClass(classId, classTeacherTargets = new Map()) {
  const cls = state.classes.find((c) => c.id === classId);
  if (!cls) return null;
  const group = getLevelRule(cls.level)?.group || "";
  if (group === "CINQUIEME") return null;
  const enforceSixiemeSwim =
    isAlgoSixiemeSwimMandatory() &&
    String(cls.level || "") === "Sixième" &&
    !classHasAtLeastOneSwimSession(classId);
  const cadencePrefs = getCadencePreferencesForClass(cls);
  if (!cadencePrefs.length) return null;
  const forcedTeacherId = String(classTeacherTargets.get(classId) || "");
  const candidateTeachers = forcedTeacherId
    ? state.teachers.filter((teacher) => teacher.id === forcedTeacherId && isTeacherAssignedToClass(teacher, classId))
    : state.teachers.filter((teacher) => isTeacherAssignedToClass(teacher, classId));
  if (!candidateTeachers.length) return null;
  let evalCount = 0;
  const maxEvaluations = Math.max(120, candidateTeachers.length * DAYS.length * SLOT_BANDS.length * cadencePrefs.length);
  let best = null;
  for (const day of DAYS) {
    for (const band of getSlotBandsForDay(day)) {
      const slot = band.start;
      if (isAlgoBlockedBand(day, slot)) continue;
      for (const cadencePreference of cadencePrefs) {
        for (const teacher of candidateTeachers) {
          evalCount += 1;
          if (evalCount % 120 === 0) await sleep(0);
          if (evalCount > maxEvaluations) break;
          if (!canTeacherTakeClassByLevelQuota(teacher, classId)) continue;
          const proposal = buildBestSessionProposal(teacher.id, classId, day, slot, "A", cadencePreference, true);
          if (!proposal.ok || !proposal.session) continue;
          if (enforceSixiemeSwim && !sessionTouchesSwimSlot(proposal.session)) continue;
          const quality = evaluateAssignmentQuality(proposal.session);
          let score = Number(quality.score || 0);
          const manualEval = evaluateAlgoManualConstraintsForSession(proposal.session);
          if (manualEval.blocked) continue;
          score += Number(manualEval.scoreDelta || 0);
          score += Number(getAlgoBiweeklySlotBalanceImpact(proposal.session).delta || 0);
          const start = String(proposal.session.start || "");
          if ((group === "SIXIEME" || group === "CINQUIEME" || group === "ALT_43") && start >= "16:05") {
            score -= 12;
          }
          if (group === "ALT_43" && cadencePreference !== "WEEKLY") {
            score += 6;
          }
          if (!best || score > best.score) {
            best = {
              classId,
              cls,
              recommendation: { teacher, proposal, quality },
              score,
              cadencePreference,
              day,
              slot,
            };
          }
        }
      }
    }
  }
  return best;
}

function getAlt43PairOrientationBonus(classA, classB) {
  const a = String(classA?.level || "");
  const b = String(classB?.level || "");
  const isCross43 =
    (a === "Quatrième" && b === "Troisième") || (a === "Troisième" && b === "Quatrième");
  return isCross43 ? 12 : 4;
}

async function findBestAlt43PairProposal(classId, classTeacherTargets = new Map()) {
  const cls = state.classes.find((c) => c.id === classId);
  if (!cls) return null;
  if (getLevelRule(cls.level)?.group !== "ALT_43") return null;
  if (getClassAlgoRemaining(classId) > 1.05) return null;

  const forcedTeacherId = String(classTeacherTargets.get(classId) || "");
  const teacherPool = forcedTeacherId
    ? state.teachers.filter((t) => t.id === forcedTeacherId && isTeacherAssignedToClass(t, classId))
    : state.teachers.filter((t) => isTeacherAssignedToClass(t, classId));
  if (!teacherPool.length) return null;

  let best = null;
  let evalCount = 0;
  for (const teacher of teacherPool) {
    const partners = state.classes
      .filter((other) => other.id !== cls.id)
      .filter((other) => getLevelRule(other.level)?.group === "ALT_43")
      .filter((other) => getClassAlgoRemaining(other.id) > 0.001 && getClassAlgoRemaining(other.id) <= 1.05)
      .filter((other) => {
        const forced = String(classTeacherTargets.get(other.id) || "");
        if (forced && forced !== teacher.id) return false;
        return isTeacherAssignedToClass(teacher, other.id);
      });
    if (!partners.length) continue;

    for (const partner of partners) {
      for (const day of DAYS) {
        for (const band of getSlotBandsForDay(day)) {
          const slot = band.start;
          if (isAlgoBlockedBand(day, slot)) continue;
          const options = [
            { a: "WEEK_A", b: "WEEK_B" },
            { a: "WEEK_B", b: "WEEK_A" },
          ];
          for (const opt of options) {
            evalCount += 1;
            if (evalCount % 80 === 0) await sleep(0);
            const pA = buildBestSessionProposal(teacher.id, cls.id, day, slot, "A", opt.a, true);
            if (!pA.ok || !pA.session) continue;
            const pB = buildBestSessionProposal(teacher.id, partner.id, day, slot, "A", opt.b, true);
            if (!pB.ok || !pB.session) continue;
            const mA = evaluateAlgoManualConstraintsForSession(pA.session);
            const mB = evaluateAlgoManualConstraintsForSession(pB.session);
            if (mA.blocked || mB.blocked) continue;

            const qA = evaluateAssignmentQuality(pA.session);
            const qB = evaluateAssignmentQuality(pB.session);
            const score =
              Number(qA.score || 0) +
              Number(qB.score || 0) +
              Number(mA.scoreDelta || 0) +
              Number(mB.scoreDelta || 0) +
              Number(getAlgoBiweeklySlotBalanceImpact([pA.session, pB.session]).delta || 0) +
              getAlt43PairOrientationBonus(cls, partner);
            if (!best || score > best.score) {
              best = {
                score,
                teacher,
                primaryClass: cls,
                partnerClass: partner,
                primarySession: pA.session,
                partnerSession: pB.session,
              };
            }
          }
        }
      }
    }
  }
  return best;
}

function canCreateSessionBatchLocally(sessions) {
  const temp = [];
  for (let i = 0; i < sessions.length; i += 1) {
    const s = sessions[i];
    if (isAlgoBlockedSlot(s?.day, s?.start)) {
      for (let j = temp.length - 1; j >= 0; j -= 1) {
        const idx = state.sessions.findIndex((x) => x.id === temp[j].id);
        if (idx >= 0) state.sessions.splice(idx, 1);
      }
      return { ok: false, error: `Créneau bloqué par l'administrateur: ${s?.day || ""} ${s?.start || ""}.` };
    }
    const check = validateSession(s);
    if (!check.ok) {
      for (let j = temp.length - 1; j >= 0; j -= 1) {
        const idx = state.sessions.findIndex((x) => x.id === temp[j].id);
        if (idx >= 0) state.sessions.splice(idx, 1);
      }
      return check;
    }
    const mock = { ...s, id: `__algo_batch_${Date.now()}_${i}` };
    temp.push(mock);
    state.sessions.push(mock);
  }
  for (let j = temp.length - 1; j >= 0; j -= 1) {
    const idx = state.sessions.findIndex((x) => x.id === temp[j].id);
    if (idx >= 0) state.sessions.splice(idx, 1);
  }
  return { ok: true };
}

async function createAlgoSession(payload) {
  if (isAlgoBlockedSlot(payload?.day, payload?.start)) {
    return { ok: false, error: `Créneau bloqué par l'administrateur: ${payload?.day || ""} ${payload?.start || ""}.` };
  }
  if (!state.algoDryRun) return createSession(payload);
  const manualEval = evaluateAlgoManualConstraintsForSession(payload);
  if (manualEval.blocked) {
    return { ok: false, error: manualEval.reasons[0] || "Contrainte manuelle non respectée." };
  }
  const check = validateSession(payload);
  if (!check.ok) return check;
  const s = check.normalized;
  const staged = {
    teacherId: s.teacherId,
    classId: s.classId,
    type: s.type,
    day: s.day,
    start: s.start,
    duration: s.duration,
    cadence: s.cadence,
    weekType: s.cadence === "BIWEEKLY" ? s.weekType : null,
  };
  state.algoPendingSessions.push(staged);
  return { ok: true, session: staged };
}

function addSimulatedAlgoSession(session) {
  state.algoSimulationSeq += 1;
  state.sessions.push({
    id: `__algo_sim_${state.algoSimulationSeq}`,
    ...session,
  });
}

async function applyAlgoProposal() {
  if (state.algoBusy) return;
  const sessions = Array.isArray(state.algoPendingSessions) ? state.algoPendingSessions.slice() : [];
  if (!sessions.length || !ui.algoGenerationStatus) return;

  state.algoBusy = true;
  ui.algoGenerationStatus.textContent = "Application de la proposition Algo...";
  renderAlgoPanel();
  try {
    if (state.algoPendingReplaceExisting) {
      await deleteAllSessionsForAiGeneration();
      // Conserver en mémoire les créneaux manuels (Firestore a déjà supprimé les ALGO)
      state.sessions = state.sessions.filter((s) => s.placedBy !== "ALGO");
    }
    let created = 0;
    let failed = 0;
    const errors = [];
    for (const session of sessions) {
      const res = await createSession(session, { placedBy: "ALGO" });
      if (res.ok) created += 1;
      else {
        failed += 1;
        if (errors.length < 30) errors.push(`${getClassLabelById(session.classId, true)}: ${res.error || "échec création"}`);
      }
      if ((created + failed) % 10 === 0) await sleep(0);
    }
    state.algoPendingSessions = [];
    state.algoPendingReplaceExisting = false;
    state.algoReplaceArmed = false;
    state.algoLastReportRows = [
      `Application terminée: ${created} créneau(x) créé(s).`,
      `Rejets à l'application: ${failed}.`,
      ...errors,
    ];
    state.algoLastReportData = {
      summary: { created, failed, remainingClasses: 0, remainingHours: 0 },
      teachers: [],
      remaining: [],
      rejectedDetails: errors.map((reason) => ({ classLabel: "—", teacherName: "—", reason })),
      errors,
    };
    ui.algoGenerationStatus.textContent = `Proposition appliquée: ${created} créé(s), ${failed} rejet(s).`;
  } catch (error) {
    ui.algoGenerationStatus.textContent = `Erreur application Algo: ${error?.message || "échec."}`;
  } finally {
    state.algoBusy = false;
    render();
  }
}

async function placeCinquiemeTriplets(classTeacherTargets, context) {
  const { targetCount, createdByClass, errors } = context;
  let created = 0;
  let failed = 0;
  const startSlot = "12:10";

  const getPendingCinquieme = () =>
    state.classes
      .filter((cls) => getLevelRule(cls.level)?.group === "CINQUIEME")
      .filter((cls) => getClassAlgoRemaining(cls.id) > 0.001)
      .sort((a, b) => String(a.name || "").localeCompare(String(b.name || ""), "fr"));

  let progress = true;
  while (progress && created < targetCount) {
    progress = false;
    for (const day of DAYS) {
      if (created >= targetCount) break;
      if (isAlgoBlockedBand(day, startSlot)) continue;
      const pending = getPendingCinquieme();
      if (pending.length < 3) continue;

      const candidates = [];
      for (const cls of pending) {
        const forcedTeacherId = String(classTeacherTargets.get(cls.id) || "");
        const teacherPool = forcedTeacherId
          ? state.teachers.filter((t) => t.id === forcedTeacherId && isTeacherAssignedToClass(t, cls.id))
          : state.teachers.filter((t) => isTeacherAssignedToClass(t, cls.id));
        let best = null;
        for (const teacher of teacherPool) {
          const proposal = buildBestSessionProposal(teacher.id, cls.id, day, startSlot, "A", "WEEKLY", true);
          if (!proposal.ok || !proposal.session) continue;
          const quality = evaluateAssignmentQuality(proposal.session);
          const manualEval = evaluateAlgoManualConstraintsForSession(proposal.session);
          if (manualEval.blocked) continue;
          const score =
            Number(quality.score || 0) +
            Number(manualEval.scoreDelta || 0) +
            Number(getAlgoBiweeklySlotBalanceImpact(proposal.session).delta || 0);
          if (!best || score > best.score) best = { cls, teacher, proposal, score };
        }
        if (best) candidates.push(best);
      }

      if (candidates.length < 3) continue;
      candidates.sort((a, b) => b.score - a.score);
      const chosen = [];
      const usedTeachers = new Set();
      for (const c of candidates) {
        if (usedTeachers.has(c.teacher.id)) continue;
        chosen.push(c);
        usedTeachers.add(c.teacher.id);
        if (chosen.length === 3) break;
      }
      if (chosen.length < 3) continue;

      const sessions = chosen.map((x) => x.proposal.session);
      const batchCheck = canCreateSessionBatchLocally(sessions);
      if (!batchCheck.ok) {
        failed += 1;
        if (errors.length < 20) errors.push(`Groupe 5e ${day} 12:10: ${batchCheck.error || "invalide"}`);
        continue;
      }

      let okCount = 0;
      for (const entry of chosen) {
        const res = await createAlgoSession(entry.proposal.session);
        if (!res.ok) {
          failed += 1;
          if (errors.length < 20) errors.push(`5e ${entry.cls.name}: ${res.error || "échec création"}`);
          continue;
        }
        okCount += 1;
        created += 1;
        createdByClass.set(entry.cls.id, (createdByClass.get(entry.cls.id) || 0) + 1);
        if (typeof context.onSessionCreated === "function") context.onSessionCreated(entry.proposal.session);
        addSimulatedAlgoSession(entry.proposal.session);
      }
      if (okCount === 3) {
        progress = true;
        if (created % 3 === 0 && ui.algoGenerationStatus) {
          ui.algoGenerationStatus.textContent = `Placement des 5e en cours... ${created} créneau(x) ajouté(s).`;
        }
      }
      if (created >= targetCount) break;
      await sleep(0);
    }
  }

  return { created, failed };
}

async function placePinnedClassSlots(context) {
  const { targetCount, createdByClass, errors, onSessionCreated, onSessionRejected } = context;
  let created = 0;
  let failed = 0;
  const pinnedRows = getAlgoPinnedClassSlotsForActiveYear();
  if (!pinnedRows.length) return { created, failed };

  const orderedRows = pinnedRows
    .map((row) => {
      const cls = state.classes.find((c) => c.id === row.classId);
      if (!cls) return { row, cls: null, teacherPool: [], compatibleCount: 0 };
      const teacherPool = state.teachers
        .filter((t) => isTeacherAssignedToClass(t, cls.id))
        .filter((t) => canTeacherTakeClassByLevelQuota(t, cls.id));
      const compatibleCount = teacherPool.filter((teacher) =>
        buildBestSessionProposal(teacher.id, cls.id, row.day, row.slot, "A", row.cadence, true).ok
      ).length;
      return { row, cls, teacherPool, compatibleCount };
    })
    .sort((a, b) => {
      if (a.compatibleCount !== b.compatibleCount) return a.compatibleCount - b.compatibleCount;
      if (a.teacherPool.length !== b.teacherPool.length) return a.teacherPool.length - b.teacherPool.length;
      const aLevel = getLevelSortWeight(a.cls?.level);
      const bLevel = getLevelSortWeight(b.cls?.level);
      if (aLevel !== bLevel) return aLevel - bLevel;
      return String(getClassLabelById(a.row.classId, true)).localeCompare(String(getClassLabelById(b.row.classId, true)), "fr");
    });

  for (const entry of orderedRows) {
    if (created >= targetCount) break;
    const { row, cls } = entry;
    if (!cls) continue;
    if (getClassAlgoRemaining(cls.id) <= 0.001) continue;

    const teacherPool = entry.teacherPool;
    if (!teacherPool.length) {
      failed += 1;
      const msg = `${getClassLabelById(cls.id, true)}: aucun professeur compatible pour ${row.day} ${row.slot}.`;
      if (errors.length < 30) errors.push(msg);
      if (typeof onSessionRejected === "function") onSessionRejected({ classId: cls.id, teacherId: "", reason: msg });
      continue;
    }

    let best = null;
    if (isAlgoBlockedBand(row.day, row.slot)) {
      failed += 1;
      const msg = `${getClassLabelById(cls.id, true)}: créneau imposé bloqué par l'administrateur (${row.day} ${row.slot}).`;
      if (errors.length < 30) errors.push(msg);
      if (typeof onSessionRejected === "function") onSessionRejected({ classId: cls.id, teacherId: "", reason: msg });
      continue;
    }

    for (const teacher of teacherPool) {
      const proposal = buildBestSessionProposal(
        teacher.id,
        cls.id,
        row.day,
        row.slot,
        "A",
        row.cadence,
        true
      );
      if (!proposal.ok || !proposal.session) continue;
      const quality = evaluateAssignmentQuality(proposal.session);
      const manualEval = evaluateAlgoManualConstraintsForSession(proposal.session);
      if (manualEval.blocked) continue;
      const score =
        Number(quality.score || 0) +
        Number(manualEval.scoreDelta || 0) +
        Number(getAlgoBiweeklySlotBalanceImpact(proposal.session).delta || 0) +
        50;
      if (!best || score > best.score) best = { session: proposal.session, score };
    }

    if (!best?.session) {
      failed += 1;
      const cadenceLabel =
        row.cadence === "WEEK_A" ? "Semaine A" : row.cadence === "WEEK_B" ? "Semaine B" : "Hebdo";
      const msg = `${getClassLabelById(cls.id, true)}: impossible de respecter le pré-placement imposé ${row.day} ${row.slot} (${cadenceLabel}).`;
      if (errors.length < 30) errors.push(msg);
      if (typeof onSessionRejected === "function") onSessionRejected({ classId: cls.id, teacherId: "", reason: msg });
      continue;
    }

    const res = await createAlgoSession(best.session);
    if (!res.ok) {
      failed += 1;
      const msg = `${getClassLabelById(cls.id, true)}: ${res.error || "échec création"}`;
      if (errors.length < 30) errors.push(msg);
      if (typeof onSessionRejected === "function") onSessionRejected({ classId: cls.id, teacherId: best.session.teacherId, reason: res.error || "échec création" });
      continue;
    }
    created += 1;
    createdByClass.set(cls.id, (createdByClass.get(cls.id) || 0) + 1);
    addSimulatedAlgoSession(best.session);
    if (typeof onSessionCreated === "function") onSessionCreated(best.session);
    await sleep(0);
  }

  return { created, failed };
}

function getTeacherDailyTeachingHours(teacherId, day, weekTypeRef) {
  return state.sessions
    .filter((s) => s.teacherId === teacherId && String(s.day || "") === day)
    .filter((s) => String(s.type || "").toUpperCase() !== "AS")
    .filter((s) => isSessionVisibleForWeek(s, weekTypeRef))
    .reduce((acc, s) => acc + Number(s.duration || 0), 0);
}

function getAsTargetByDailyLoad(hours) {
  if (hours === 2 || hours === 4 || hours === 6) return 2;
  return 0;
}

async function placeAsSlotsByDailyLoad(context) {
  const { createdByClass, errors } = context;
  let created = 0;
  let failed = 0;
  const asSlots = ["12:10", "13:00"];

  for (const teacher of state.teachers) {
    for (const day of DAYS) {
      const hoursA = getTeacherDailyTeachingHours(teacher.id, day, "A");
      const hoursB = getTeacherDailyTeachingHours(teacher.id, day, "B");
      const referenceLoad = Math.max(hoursA, hoursB);
      const targetAsCount = getAsTargetByDailyLoad(referenceLoad);
      if (!targetAsCount) continue;

      // AMÉLIORATION 6 : Vérifier cours matin (avant 12h) ET après-midi (après 14h)
      const teacherSessionsDay = state.sessions.filter(s => s.teacherId === teacher.id && s.day === day && String(s.type || "").toUpperCase() !== "AS");
      
      const hasMorning = teacherSessionsDay.some(s => {
        const start = toWeekStartHour(s.day, s.start) % 24;
        return start < 12;
      });
      const hasAfternoon = teacherSessionsDay.some(s => {
        const start = toWeekStartHour(s.day, s.start) % 24;
        const end = start + Number(s.duration || 0);
        return end > 14;
      });

      const conditionMet = hasMorning && hasAfternoon;

      const existingAs = state.sessions.filter(
        (s) =>
          s.teacherId === teacher.id &&
          String(s.day || "") === day &&
          String(s.type || "").toUpperCase() === "AS" &&
          asSlots.includes(String(s.start || "")) &&
          normalizeCadence(s.cadence) === "WEEKLY"
      );
      let missing = Math.max(0, targetAsCount - existingAs.length);
      if (!missing) continue;

      for (const slot of asSlots) {
        if (!missing) break;
        if (isAlgoBlockedBand(day, slot)) continue;
        const already = existingAs.some((s) => String(s.start || "") === slot) ||
          state.sessions.some(
            (s) =>
              s.teacherId === teacher.id &&
              String(s.day || "") === day &&
              String(s.type || "").toUpperCase() === "AS" &&
              String(s.start || "") === slot
          );
        if (already) continue;

        // Malus fortement dissuasif si condition non remplie
        if (!conditionMet && Math.random() < 0.8) {
          // On dissuade le placement si la condition n'est pas remplie
          // mais on laisse une petite chance pour que ce soit "non bloquant"
          continue; 
        }

        const asId = findNextAvailableASId();
        const payload = {
          teacherId: teacher.id,
          classId: asId,
          type: "AS",
          day,
          start: slot,
          duration: 1,
          cadence: "WEEKLY",
          weekType: "A",
        };
        const res = await createAlgoSession(payload);
        if (!res.ok) {
          failed += 1;
          if (typeof context.onSessionRejected === "function") {
            context.onSessionRejected({
              classId: asId,
              teacherId: teacher.id,
              reason: res.error || "échec création",
            });
          }
          if (errors.length < 20) {
            errors.push(`AS ${teacher.name} ${day} ${slot}: ${res.error || "échec création"}`);
          }
          continue;
        }
        created += 1;
        missing -= 1;
        createdByClass.set(asId, (createdByClass.get(asId) || 0) + 1);
        if (typeof context.onSessionCreated === "function") context.onSessionCreated(payload);
        addSimulatedAlgoSession(payload);
        await sleep(0);
      }

      if (missing > 0 && errors.length < 20) {
        const reason = !conditionMet ? " (dissuasion: pas de cours matin+aprem)" : "";
        errors.push(
          `AS ${teacher.name} ${day}: ${targetAsCount - missing}/${targetAsCount} créneau(x) placé(s)${reason}.`
        );
      }
    }
  }

  return { created, failed };
}


function checkFeasibility() {
  const errors = [];
  const warnings = [];

  // 1. Check Secondes at 16h05
  const secondesClasses = state.classes.filter(c => c.level === "Seconde");
  const requiredSecondesSlots = secondesClasses.length;
  let available16h05Slots = 0;
  for (const day of DAYS) {
    const slot = "16:05";
    const availableTeachers = state.teachers.filter(t => {
      const isUnavail = hasDesiderataUnavailableSlot(t.id, day, slot) || 
                        hasDesiderataDayOffSlot(t.id, day, slot) ||
                        hasDesiderataUnavailableSlot(t.id, day, "16:55") ||
                        hasDesiderataDayOffSlot(t.id, day, "16:55");
      return !isUnavail;
    }).length;
    available16h05Slots += Math.min(5, availableTeachers);
  }

  if (available16h05Slots < requiredSecondesSlots) {
    errors.push(`Pas assez de créneaux 16h05 pour ${requiredSecondesSlots} Secondes (disponibles: ${available16h05Slots}).`);
  }

  // 2. Check teacher hours coverage by level
  const levels = Object.keys(LEVEL_RULES);
  const hoursByTeacher = computeTeacherHours();
  for (const level of levels) {
    const levelClasses = state.classes.filter(c => c.level === level);
    const totalLevelHoursRequired = levelClasses.reduce((acc, c) => acc + getClassAlgoRemaining(c.id), 0);
    
    if (totalLevelHoursRequired <= 0.001) continue;

    const availableHoursForLevel = state.teachers.reduce((acc, t) => {
      if (!isTeacherAssignedToClass(t, levelClasses[0]?.id)) return acc;
      const current = hoursByTeacher.get(t.id) || 0;
      const remaining = Math.max(0, Number(t.maxHours || 0) - current);
      return acc + remaining;
    }, 0);

    if (availableHoursForLevel < totalLevelHoursRequired - 0.001) {
      warnings.push(`Niveau ${level}: Heures professeurs (${formatHours(availableHoursForLevel)}h) insuffisantes pour couvrir les besoins (${formatHours(totalLevelHoursRequired)}h).`);
    }
  }

  // 3. Check 5e groups (triplets)
  const pending5e = state.classes.filter(c => getLevelRule(c.level)?.group === "CINQUIEME" && getClassAlgoRemaining(c.id) > 0.001);
  if (pending5e.length >= 3) {
    let maxTripletsPossible = 0;
    for (const day of DAYS) {
      const availableAt12 = state.teachers.filter(t => {
        const isUnavail = hasDesiderataUnavailableSlot(t.id, day, "12:10") || 
                          hasDesiderataDayOffSlot(t.id, day, "12:10") ||
                          hasDesiderataUnavailableSlot(t.id, day, "13:00") ||
                          hasDesiderataDayOffSlot(t.id, day, "13:00") ||
                          hasDesiderataUnavailableSlot(t.id, day, "13:50") ||
                          hasDesiderataDayOffSlot(t.id, day, "13:50");
        return !isUnavail;
      }).length;
      maxTripletsPossible += Math.floor(Math.min(3, availableAt12) / 1); // Groupes de 3 max par jour
      // En fait on peut avoir plusieurs groupes de 3 si on a 6 profs? 
      // Mais la regle dit "maximum 3 classes de 5e simultanées".
      if (availableAt12 >= 3) maxTripletsPossible = 3; // On peut placer 3 classes ce jour là.
    }
    // Simplification: si aucun jour n'a 3 profs dispo
    const dayWith3Profs = DAYS.some(day => {
      return state.teachers.filter(t => {
        return !hasDesiderataUnavailableSlot(t.id, day, "12:10") && !hasDesiderataDayOffSlot(t.id, day, "12:10");
      }).length >= 3;
    });
    if (!dayWith3Profs) {
      warnings.push("Groupes 5e: Aucun jour ne dispose de 3 professeurs disponibles simultanément sur le créneau 12h-14h.");
    }
  }

  return { ok: errors.length === 0, errors, warnings };
}

/*
function scoreAlgoSimulationReport(reportData) {
  const summary = reportData?.summary || {};
  const created = Number(summary.created || 0);
  const failed = Number(summary.failed || 0);
  const remainingHours = Number(summary.remainingHours || 0);
  const remainingClasses = Number(summary.remainingClasses || 0);
  const weekSpreadPenalty = Number(summary.weekSpreadPenalty || 0);
  const errors = Array.isArray(reportData?.errors) ? reportData.errors.length : 0;
  return created * 100 - remainingHours * 80 - remainingClasses * 35 - failed * 8 - errors * 5 - weekSpreadPenalty;
}
*/
function scoreAlgoSimulationReport(reportData) {
  const summary = reportData?.summary || {};
  const created = Number(summary.created || 0);
  const failed = Number(summary.failed || 0);
  const remainingHours = Number(summary.remainingHours || 0);
  const remainingClasses = Number(summary.remainingClasses || 0);
  const weekSpreadPenalty = Number(summary.weekSpreadPenalty || 0);
  const desiderataBonus = Number(summary.desiderataBonus || 0);
  const errors = Array.isArray(reportData?.errors) ? reportData.errors.length : 0;

  // Nouvelle formule
  // score = créneauxCréés * 100 - heuresRestantes * 50 - classesRestantes * 60 - créationsRejetées * 15 - erreurs * 20 - malusRépartitionProfesseurs + bonusDesiderata
  return (
    created * 100 -
    remainingHours * 50 -
    remainingClasses * 60 -
    failed * 15 -
    errors * 20 -
    weekSpreadPenalty +
    desiderataBonus
  );
}

function calculateSimulationDesiderataBonus(createdSessionLogs) {
  let bonus = 0;
  for (const s of createdSessionLogs) {
    const slots = getCoveredSlots(s.day, s.start, s.duration);
    const isPreferred = slots.some(slotKey => {
      const { slot } = splitRawSlotKey(slotKey);
      return hasDesiderataSlot(s.teacherId, s.day, slot);
    });
    if (isPreferred) {
      bonus += 25;
    }
  }
  return bonus;
}

function getTeacherWeekDistributionPenalty() {
  let penalty = 0;
  for (const teacher of state.teachers) {
    const dailyHours = DAYS.map((day) =>
      state.sessions
        .filter((s) => s.teacherId === teacher.id && String(s.day || "") === day)
        .filter((s) => String(s.type || "").toUpperCase() !== "AS")
        .reduce((acc, s) => acc + weeklyEquivalentHours(s), 0)
    );
    const total = dailyHours.reduce((acc, h) => acc + h, 0);
    if (total <= 0.001) continue;
    const workedDays = dailyHours.filter((h) => h > 0.001).length;
    const targetDays = Math.max(1, Math.min(DAYS.length, Math.ceil(total / 4)));
    const maxDay = Math.max(...dailyHours);
    const averageWorked = total / Math.max(1, workedDays);
    if (workedDays < targetDays) penalty += (targetDays - workedDays) * 18;
    penalty += Math.max(0, maxDay - averageWorked - 2) * 10;
  }
  return Math.round(penalty);
}

function getLevelCategoryPriority(level, classId) {
  if (level === "Seconde") return 1;
  if (level === "Cinquième") return 2;
  if (["Quatrième", "Troisième"].includes(level)) return 3;
  if (isASLike({ classId })) return 4;
  if (level === "Sixième") return 5;
  return 6;
}

function countValidSlotsForClass(classId, classTeacherTargets) {
  const cls = state.classes.find(c => c.id === classId);
  if (!cls) return 0;
  const forcedTeacherId = classTeacherTargets.get(classId);
  const teacherPool = forcedTeacherId
    ? state.teachers.filter(t => t.id === forcedTeacherId && isTeacherAssignedToClass(t, classId))
    : state.teachers.filter(t => isTeacherAssignedToClass(t, classId));
  
  let options = 0;
  for (const day of DAYS) {
    for (const band of SLOT_BANDS) {
      const slot = band.start;
      for (const teacher of teacherPool) {
        if (canAssignClassInTeacherSlot(teacher.id, classId, day, slot, "A")) {
          options++;
        }
      }
    }
  }
  return options;
}

function getTeacherFlexibility(teacherId) {
  if (!teacherId) return 999;
  let availableSlots = 0;
  for (const day of DAYS) {
    for (const slot of SLOTS) {
      if (!hasDesiderataUnavailableSlot(teacherId, day, slot) && !hasDesiderataDayOffSlot(teacherId, day, slot)) {
        availableSlots++;
      }
    }
  }
  return availableSlots;
}

async function runAlgoSimulationAttempt({
  targetCount,
  originalSessions,
  replaceExisting,
  attemptIndex,
  attemptTotal,
  strategy = "RANDOM",
}) {
  state.sessions = replaceExisting ? [] : originalSessions.slice();
  state.algoPendingSessions = [];
  state.algoSimulationSeq = 0;
  if (ui.algoGenerationStatus) {
    ui.algoGenerationStatus.textContent = `Simulation Algo: tentative ${attemptIndex}/${attemptTotal} [${strategy}]...`;
  }
  await sleep(0);
  const classTeacherTargets = new Map();
  
  // AMÉLIORATION 3: MCF - Pré-calcul des options
  const classOptionsCount = new Map();
  state.classes.forEach(c => {
    classOptionsCount.set(c.id, countValidSlotsForClass(c.id, classTeacherTargets));
  });

  const createdByClass = new Map();
  const createdSessionLogs = [];
  const rejectedDetails = [];
  const addRejectedDetail = ({ classId = "", teacherId = "", reason = "" } = {}) => {
    const classLabel = classId ? getClassLabelById(classId, true) : "—";
    const teacherName = teacherId ? state.teachers.find((t) => t.id === teacherId)?.name || "—" : "—";
    rejectedDetails.push({
      classId,
      classLabel,
      teacherId,
      teacherName,
      reason: String(reason || "échec création"),
    });
  };
  const onSessionCreated = (session) => {
    if (!session) return;
    createdSessionLogs.push({
      teacherId: String(session.teacherId || ""),
      classId: String(session.classId || ""),
      type: String(session.type || ""),
      duration: Number(session.duration || 0),
      cadence: normalizeCadence(session.cadence),
      day: session.day,
      start: session.start,
      weekType: session.weekType
    });
  };
  const onSessionRejected = ({ classId = "", teacherId = "", reason = "" } = {}) => {
    addRejectedDetail({ classId, teacherId, reason });
  };
  const errors = [];
  const alt43PairErrors = new Set();
  let created = 0;
  let failed = 0;
  let stagnationCycles = 0;
  const maxCycles = Math.max(10, state.classes.length * 2);
  const startedAt = Date.now();
  const hardTimeoutMs = Math.max(12000, Math.floor(42000 / Math.max(1, attemptTotal)));

  // Pré-placements imposés par classe (sans prof): l'algo choisit le prof compatible.
  const pinnedResult = await placePinnedClassSlots({
    targetCount,
    createdByClass,
    errors,
    onSessionCreated,
    onSessionRejected,
  });
  created += pinnedResult.created;
  failed += pinnedResult.failed;

  // Règle métier forte: les 5e sont placées entre midi et deux, par groupes de 3.
  const tripletResult = await placeCinquiemeTriplets(classTeacherTargets, {
    targetCount,
    createdByClass,
    errors,
    onSessionCreated,
  });
  created += tripletResult.created;
  failed += tripletResult.failed;

  while (created < targetCount && stagnationCycles < maxCycles) {
    if (Date.now() - startedAt > hardTimeoutMs) {
      errors.push(`Arrêt de sécurité: temps maximum atteint (${Math.round(hardTimeoutMs / 1000)}s).`);
      break;
    }
    let pending = state.classes
      .map((cls) => ({
        cls,
        remaining: getClassAlgoRemaining(cls.id),
        priority: getLevelCategoryPriority(cls.level, cls.id),
        options: classOptionsCount.get(cls.id) || 0,
        teacherFlex: getTeacherFlexibility(classTeacherTargets.get(cls.id) || "")
      }))
      .filter((x) => getLevelRule(x.cls.level)?.group !== "CINQUIEME")
      .filter((x) => x.remaining > 0.001);
    
    // AMÉLIORATION 3 & 5: Choix de l'ordre de traitement selon la stratégie
    if (strategy === "CLASSIC") {
      pending = pending.sort((a, b) => {
        const remCmp = b.remaining - a.remaining;
        if (Math.abs(remCmp) > 1e-9) return remCmp;
        const lvlCmp = getLevelSortWeight(a.cls.level) - getLevelSortWeight(b.cls.level);
        if (lvlCmp !== 0) return lvlCmp;
        return String(a.cls.name || "").localeCompare(String(b.cls.name || ""), "fr");
      });
    } else if (strategy === "INFLEXIBLE") {
      pending = pending.sort((a, b) => a.teacherFlex - b.teacherFlex || a.priority - b.priority || a.options - b.options);
    } else if (strategy === "RANDOM" && attemptIndex > 1) {
      pending = pending.sort(() => Math.random() - 0.5);
    } else {
      // Stratégie par défaut (MCF): Niveau prioritaire, puis moins d'options
      pending = pending.sort((a, b) => a.priority - b.priority || a.options - b.options || b.remaining - a.remaining);
    }

    if (!pending.length) break;
    let cycleProgress = false;
    let scannedInCycle = 0;

    for (const item of pending) {
      if (created >= targetCount) break;
      scannedInCycle += 1;
      if (scannedInCycle % 3 === 0) await sleep(0);
      if (getClassAlgoRemaining(item.cls.id) <= 0.001) continue;

      const group = getLevelRule(item.cls.level)?.group || "";
      if (group === "ALT_43" && getClassAlgoRemaining(item.cls.id) <= 1.05) {
        if (created + 2 > targetCount) continue;
        const pair = await findBestAlt43PairProposal(item.cls.id, classTeacherTargets);
        if (!pair) {
          // Fallback demande utilisateur:
          // si aucun binôme parallèle A/B n'est possible, placer en solo.
          const solo = await findBestAlgoProposalForClass(item.cls.id, classTeacherTargets);
          if (solo?.recommendation?.proposal?.session) {
            const soloSession = solo.recommendation.proposal.session;
            const soloRes = await createAlgoSession(soloSession);
            if (soloRes.ok) {
              created += 1;
              cycleProgress = true;
              createdByClass.set(item.cls.id, (createdByClass.get(item.cls.id) || 0) + 1);
              addSimulatedAlgoSession(soloSession);
              onSessionCreated(soloSession);
              if (errors.length < 20) {
                errors.push(`${getClassLabelById(item.cls.id, true)}: binôme A/B indisponible, placement solo appliqué.`);
              }
              continue;
            }
          }
          if (!alt43PairErrors.has(item.cls.id) && errors.length < 20) {
            const teacherId = String(classTeacherTargets.get(item.cls.id) || "");
            const t = state.teachers.find((x) => x.id === teacherId);
            const msg = `${getClassLabelById(item.cls.id, true)}: impossible de trouver un binôme A/B simultané${t ? ` avec ${t.name}` : ""}, et échec du fallback solo.`;
            errors.push(msg);
            addRejectedDetail({ classId: item.cls.id, teacherId, reason: msg });
            alt43PairErrors.add(item.cls.id);
          }
          continue;
        }
        const batchCheck = canCreateSessionBatchLocally([pair.primarySession, pair.partnerSession]);
        if (!batchCheck.ok) {
          failed += 1;
          const msg = `${getClassLabelById(pair.primaryClass.id, true)} + ${getClassLabelById(pair.partnerClass.id, true)}: ${batchCheck.error || "binôme A/B invalide"}`;
          if (errors.length < 20) errors.push(msg);
          addRejectedDetail({ classId: pair.primaryClass.id, teacherId: pair.teacher?.id || "", reason: msg });
          continue;
        }
        const first = await createAlgoSession(pair.primarySession);
        if (!first.ok) {
          failed += 1;
          const msg = `${getClassLabelById(pair.primaryClass.id, true)}: ${first.error || "échec création"}`;
          if (errors.length < 20) errors.push(msg);
          addRejectedDetail({ classId: pair.primaryClass.id, teacherId: pair.primarySession.teacherId, reason: first.error || "échec création" });
          continue;
        }
        addSimulatedAlgoSession(pair.primarySession);
        onSessionCreated(pair.primarySession);
        created += 1;
        createdByClass.set(pair.primaryClass.id, (createdByClass.get(pair.primaryClass.id) || 0) + 1);

        const second = await createAlgoSession(pair.partnerSession);
        if (!second.ok) {
          failed += 1;
          const msg = `${getClassLabelById(pair.partnerClass.id, true)}: ${second.error || "échec création"}`;
          if (errors.length < 20) errors.push(msg);
          addRejectedDetail({ classId: pair.partnerClass.id, teacherId: pair.partnerSession.teacherId, reason: second.error || "échec création" });
          continue;
        }
        addSimulatedAlgoSession(pair.partnerSession);
        onSessionCreated(pair.partnerSession);
        created += 1;
        createdByClass.set(pair.partnerClass.id, (createdByClass.get(pair.partnerClass.id) || 0) + 1);
        cycleProgress = true;
        if (created % 4 === 0) {
          ui.algoGenerationStatus.textContent = `Tentative ${attemptIndex}/${attemptTotal}: ${created} créneau(x) proposé(s).`;
          renderAlgoPanel();
        }
        continue;
      }

      const best = await findBestAlgoProposalForClass(item.cls.id, classTeacherTargets);
      if (!best) {
        const forcedTeacherId = String(classTeacherTargets.get(item.cls.id) || "");
        if (forcedTeacherId && errors.length < 20) {
          const t = state.teachers.find((x) => x.id === forcedTeacherId);
          const msg = `${getClassLabelById(item.cls.id, true)}: aucun créneau valide pour ${t?.name || "le professeur ciblé"} (répartition).`;
          errors.push(msg);
          addRejectedDetail({ classId: item.cls.id, teacherId: forcedTeacherId, reason: msg });
        }
        continue;
      }

      const proposal = best.recommendation.proposal.session;
      const res = await createAlgoSession(proposal);
      if (res.ok) {
        created += 1;
        cycleProgress = true;
        createdByClass.set(item.cls.id, (createdByClass.get(item.cls.id) || 0) + 1);
        addSimulatedAlgoSession(proposal);
        onSessionCreated(proposal);
        if (created % 5 === 0) {
          ui.algoGenerationStatus.textContent = `Tentative ${attemptIndex}/${attemptTotal}: ${created} créneau(x) proposé(s).`;
          renderAlgoPanel();
        }
      } else {
        failed += 1;
        const msg = `${getClassLabelById(item.cls.id, true)}: ${res.error || "échec création"}`;
        if (errors.length < 20) errors.push(msg);
        addRejectedDetail({ classId: item.cls.id, teacherId: proposal.teacherId, reason: res.error || "échec création" });
      }
    }

    if (!cycleProgress) {
      stagnationCycles += 1;
      await sleep(0);
    } else {
      stagnationCycles = 0;
    }
  }

  // Règle métier AS: entre 12h et 14h, selon charge journalière du professeur.
  const asResult = await placeAsSlotsByDailyLoad({ createdByClass, errors, onSessionCreated, onSessionRejected });
  created += asResult.created;
  failed += asResult.failed;

  const remainingRowsAll = state.classes
    .map((cls) => ({ cls, remaining: getClassAlgoRemaining(cls.id) }))
    .filter((x) => x.remaining > 0.001)
    .sort((a, b) => b.remaining - a.remaining);
  const remainingRows = remainingRowsAll.slice(0, 12);

  const pendingCinquieme = state.classes
    .filter((cls) => getLevelRule(cls.level)?.group === "CINQUIEME")
    .filter((cls) => getClassAlgoRemaining(cls.id) > 0.001);
  if (pendingCinquieme.length) {
    errors.push(
      `5e restantes non placées: ${pendingCinquieme.length} (règle groupe de 3 à 12:10).`
    );
  }
  if (isAlgoSixiemeSwimMandatory()) {
    const missingSwimSixieme = state.classes
      .filter((cls) => String(cls.level || "") === "Sixième")
      .filter((cls) => !classHasAtLeastOneSwimSession(cls.id));
    if (missingSwimSixieme.length) {
      errors.push(
        `6e sans créneau natation: ${missingSwimSixieme.length} (contrainte manuelle active).`
      );
    }
  }

  const teacherStatsMap = new Map();
  for (const entry of createdSessionLogs) {
    const teacherId = entry.teacherId;
    if (!teacherStatsMap.has(teacherId)) {
      teacherStatsMap.set(teacherId, {
        teacherId,
        teacherName: state.teachers.find((t) => t.id === teacherId)?.name || "Professeur inconnu",
        sessionsAdded: 0,
        hoursAdded: 0,
        classes: new Set(),
      });
    }
    const row = teacherStatsMap.get(teacherId);
    row.sessionsAdded += 1;
    row.hoursAdded += weeklyEquivalentHours({ duration: entry.duration, cadence: entry.cadence });
    if (entry.classId && !isSpecialAssignmentId(entry.classId)) row.classes.add(entry.classId);
  }
  const teacherRows = Array.from(teacherStatsMap.values())
    .map((x) => ({
      teacherId: x.teacherId,
      teacherName: x.teacherName,
      sessionsAdded: x.sessionsAdded,
      hoursAdded: x.hoursAdded,
      classesTouched: x.classes.size,
    }))
    .sort((a, b) => b.sessionsAdded - a.sessionsAdded || a.teacherName.localeCompare(b.teacherName, "fr"));
  const uniqueErrors = Array.from(new Set(errors.map((x) => String(x || "").trim()).filter(Boolean)));
  const totalRemaining = state.classes.reduce((acc, cls) => acc + getClassAlgoRemaining(cls.id), 0);
  const weekSpreadPenalty = getTeacherWeekDistributionPenalty();
  const desiderataBonus = calculateSimulationDesiderataBonus(createdSessionLogs);

  state.algoLastReportData = {
    summary: {
      created,
      failed,
      remainingClasses: remainingRowsAll.length,
      remainingHours: totalRemaining,
      weekSpreadPenalty,
      desiderataBonus,
      strategy,
      teacherAssignmentMode: "AUTO",
    },
    teachers: teacherRows,
    remaining: remainingRowsAll.map((x) => ({
      level: String(x.cls.level || ""),
      name: String(x.cls.name || ""),
      remaining: Number(x.remaining || 0),
    })),
    rejectedDetails: rejectedDetails.slice(0, 200),
    errors: uniqueErrors,
  };

  state.algoLastReportRows = [
    `Créneaux créés: ${created}`,
    `Créations rejetées: ${failed}`,
    `Classes partiellement/non couvertes: ${remainingRows.length}`,
    `Malus répartition professeurs: ${weekSpreadPenalty}`,
    `Bonus Désidérata: ${desiderataBonus} [Stratégie: ${strategy}]`,
    ...Array.from(createdByClass.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([classId, count]) => `${getClassLabelById(classId, true)}: ${count} créneau(x) ajouté(s)`),
    ...remainingRows.map((x) => `${x.cls.level} ${x.cls.name}: ${formatHours(x.remaining)}h restantes`),
    ...uniqueErrors,
  ];

  const score = scoreAlgoSimulationReport(state.algoLastReportData);
  state.algoLastReportData.summary.score = score;
  state.algoLastReportData.summary.attemptIndex = attemptIndex;
  state.algoLastReportData.summary.attempts = attemptTotal;
  const statusText = totalRemaining <= 0.001
    ? `Tentative ${attemptIndex}/${attemptTotal} [${strategy}]: ${created} proposé(s), couverture complète, score ${score}.`
    : `Tentative ${attemptIndex}/${attemptTotal} [${strategy}]: ${created} proposé(s), ${formatHours(totalRemaining)}h restantes, score ${score}.`;
  ui.algoGenerationStatus.textContent = statusText;
  return {
    attemptIndex,
    score,
    pendingSessions: state.algoPendingSessions.slice(),
    reportData: state.algoLastReportData,
    reportRows: state.algoLastReportRows.slice(),
    statusText,
  };
}

// ─── Génération EDT ───────────────────────────────────────────────────────────
async function generateEdtWithAlgorithm() {
  if (state.algoBusy) return;
  if (!ui.algoGenerationStatus || !ui.algoGenerationTargetCount) return;
  const targetCount = Math.max(1, Math.min(600, Number(ui.algoGenerationTargetCount.value || 160)));
  const replaceExisting = Boolean(ui.algoReplaceExistingSessions?.checked);

  if (!state.teachers.length || !state.classes.length) {
    ui.algoGenerationStatus.textContent = "Ajoutez d'abord des enseignants et des classes.";
    return;
  }

  // Garde de sécurité suppression massive
  if (replaceExisting && state.sessions.length > 0 && !state.algoReplaceArmed) {
    state.algoReplaceArmed = true;
    ui.algoGenerationStatus.textContent =
      "Sécurité: relancez une 2e fois pour confirmer la suppression des créneaux algo existants.";
    state.algoLastReportRows = [
      "Aucune suppression effectuée.",
      "Vos créneaux manuels seront toujours conservés.",
      "Seuls les créneaux posés par l'algorithme (placedBy=ALGO) seront effacés.",
      "Relancez pour confirmer.",
    ];
    state.algoLastReportData = {
      summary: { created: 0, failed: 0, remainingClasses: 0, remainingHours: 0, score: 0, attempts: 0 },
      teachers: [], remaining: [],
      errors: ["Suppression non confirmée: aucune action destructive n'a été exécutée."],
    };
    renderAlgoPanel();
    return;
  }
  if (!replaceExisting) state.algoReplaceArmed = false;
  if (replaceExisting) { state.algoReplaceArmed = false; state.algoPendingReplaceExisting = true; }

  state.algoBusy = true;
  state.algoLastReportRows = [];
  state.algoLastReportData = null;
  state.algoPendingSessions = [];
  state.algoPendingReplaceExisting = replaceExisting;
  state.algoDryRun = true;
  state.algoSimulationSeq = 0;

  ui.algoGenerationStatus.textContent = "Check de faisabilité en cours...";
  const feasibility = checkFeasibility();
  if (!feasibility.ok) {
    state.algoBusy = false;
    state.algoDryRun = false;
    state.algoLastReportRows = ["ÉCHEC DU CHECK DE FAISABILITÉ", ...feasibility.errors];
    state.algoLastReportData = {
      summary: { created: 0, failed: 0, remainingClasses: 0, remainingHours: 0, score: 0, attempts: 0 },
      teachers: [], remaining: [], errors: feasibility.errors,
    };
    ui.algoGenerationStatus.textContent = "Génération annulée : échec du check de faisabilité.";
    renderAlgoPanel();
    return;
  }

  const originalSessions = state.sessions.slice();

  // 7 stratégies : CLASSIC et INFLEXIBLE sont les plus déterministes et les plus sûres.
  // DESIDERATA, SPREAD = variantes du scoring. RANDOM = diversité d'ordre.
  const STRATEGIES = ["CLASSIC", "DESIDERATA", "SPREAD", "INFLEXIBLE", "RANDOM", "CLASSIC", "INFLEXIBLE"];
  const attemptTotal = STRATEGIES.length;
  const attemptResults = [];
  const attemptSummaries = [];
  let bestAttempt = null;

  // Barre de progression
  ui.algoGenerationStatus.innerHTML =
    `<span>Simulation en cours… <strong id="algoProgLabel">0/${attemptTotal}</strong></span>` +
    `<progress id="algoProgBar" max="${attemptTotal}" value="0" style="width:100%;margin-top:.4rem;display:block"></progress>`;

  try {
    for (let attemptIndex = 1; attemptIndex <= attemptTotal; attemptIndex++) {
      const strategy = STRATEGIES[attemptIndex - 1];
      state.algoCurrentStrategy = strategy;

      const result = await runAlgoSimulationAttempt({
        targetCount,
        originalSessions,
        replaceExisting,
        attemptIndex,
        attemptTotal,
        strategy,
      });

      const s = result?.reportData?.summary || {};
      attemptResults.push({
        attemptIndex,
        strategy,
        score: Number(result?.score || 0),
        created: Number(s.created || 0),
        remainingHours: Number(s.remainingHours || 0),
        remainingClasses: Number(s.remainingClasses || 0),
      });
      attemptSummaries.push(
        `Tentative ${attemptIndex} [${strategy}]: score ${result.score}, ${result.pendingSessions.length} créneau(x)`
      );

      if (!bestAttempt || result.score > bestAttempt.score) {
        bestAttempt = result;
      }

      // Mise à jour barre de progression
      const progLabel = document.getElementById("algoProgLabel");
      const progBar   = document.getElementById("algoProgBar");
      if (progLabel) progLabel.textContent = `${attemptIndex}/${attemptTotal} [${strategy}] – score ${result.score}`;
      if (progBar)   progBar.value = attemptIndex;

      renderAlgoPanel();
      await sleep(0);
    }

    if (!bestAttempt) throw new Error("Aucune tentative Algo exploitable.");

    state.algoPendingSessions = bestAttempt.pendingSessions.slice();
    state.algoPendingReplaceExisting = replaceExisting;
    state.algoLastReportData = bestAttempt.reportData;
    state.algoLastReportData.attemptResults = attemptResults;

    const summary = bestAttempt.reportData?.summary || {};
    const remaining = Number(summary.remainingHours || 0);
    state.algoLastReportRows = [
      `${attemptTotal} stratégies testées. Meilleure: tentative ${bestAttempt.attemptIndex} [${bestAttempt.strategy}], score ${bestAttempt.score}.`,
      "Mode attribution prof: AUTO.",
      "CHECK DE FAISABILITÉ: OK",
      ...feasibility.warnings.map(w => `ATTENTION: ${w}`),
      ...attemptSummaries,
      ...(bestAttempt.reportRows || []),
    ];
    ui.algoGenerationStatus.textContent = remaining <= 0.001
      ? `Couverture complète – ${bestAttempt.pendingSessions.length} créneau(x) à appliquer (score ${bestAttempt.score}).`
      : `${formatHours(remaining)}h restantes – ${bestAttempt.pendingSessions.length} créneau(x) à appliquer (score ${bestAttempt.score}).`;

  } catch (error) {
    state.algoPendingSessions = [];
    state.algoPendingReplaceExisting = false;
    state.algoLastReportRows = [String(error?.message || "Erreur inconnue.")];
    state.algoLastReportData = {
      summary: { created: 0, failed: 0, remainingClasses: 0, remainingHours: 0, score: 0, attempts: 0 },
      teachers: [], remaining: [], errors: [String(error?.message || "Erreur inconnue.")],
    };
    ui.algoGenerationStatus.textContent = `Erreur génération Algo: ${error?.message || "échec."}`;
  } finally {
    state.sessions = originalSessions;
    state.algoDryRun = false;
    state.algoBusy = false;
    state.algoCurrentStrategy = "CLASSIC";
    if (state.algoSnapshotRenderTimer) {
      clearTimeout(state.algoSnapshotRenderTimer);
      state.algoSnapshotRenderTimer = null;
    }
    renderAlgoPanel();
    render();
  }
}

async function generateEdtWithGemini() {
  if (state.aiBusy) return;
  if (!ui.aiGeminiApiKey || !ui.aiGeminiModel || !ui.aiGenerationStatus || !ui.aiGenerationTargetCount) return;
  const apiKey = String(ui.aiGeminiApiKey.value || "").trim();
  let model = String(ui.aiGeminiModel.value || "").trim() || "gemini-2.5-flash";
  const constraintsText = getAiConstraintsPromptText();
  const targetCount = Math.max(1, Math.min(600, Number(ui.aiGenerationTargetCount.value || 160)));
  const replaceExisting = Boolean(ui.aiReplaceExistingSessions?.checked);

  if (!apiKey) {
    ui.aiGenerationStatus.textContent = "Veuillez renseigner une clé API Gemini.";
    return;
  }
  if (!state.teachers.length || !state.classes.length) {
    ui.aiGenerationStatus.textContent = "Ajoutez d'abord des enseignants et des classes.";
    return;
  }

  state.aiBusy = true;
  state.aiLastReportRows = [];
  ui.aiGenerationStatus.textContent = "Génération IA en cours...";
  renderAIPanel();

  try {
    const prompt = buildGeminiPromptForEdt(constraintsText, targetCount);
    const callGenerate = async (modelName) => {
      const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(modelName)}:generateContent?key=${encodeURIComponent(apiKey)}`;
      return fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: prompt }] }],
          generationConfig: {
            temperature: 0.2,
          },
        }),
      });
    };

    let response;
    let responseErrorText = "";
    let retries = 0;
    const maxRetries = 3;

    while (retries <= maxRetries) {
      response = await callGenerate(model);
      if (response.ok) break;

      responseErrorText = await response.text();
      
      // Si 503 (Surchargé), on attend et on réessaie
      if (response.status === 503 && retries < maxRetries) {
        retries++;
        const waitMs = retries * 3000; // 3s, 6s, 9s
        ui.aiGenerationStatus.textContent = `Serveur Gemini surchargé (503). Nouvel essai dans ${waitMs/1000}s... (Tentative ${retries}/${maxRetries})`;
        await sleep(waitMs);
        continue;
      }

      // Si 404 ou modèle non trouvé, on tente de résoudre le nom du modèle
      const shouldResolveModel = response.status === 404 || responseErrorText.includes("is not found for API version");
      if (shouldResolveModel && retries < maxRetries) {
        retries++;
        const resolved = await resolveGeminiModel(apiKey, model);
        if (resolved && resolved !== model) {
          model = resolved;
          if (ui.aiGeminiModel) ui.aiGeminiModel.value = model;
          localStorage.setItem("aiGeminiModel", model);
          ui.aiGenerationStatus.textContent = `Modèle '${model}' détecté. Relance...`;
          continue; 
        }
      }

      // Autre erreur ou trop de tentatives
      throw new Error(`Gemini API ${response.status}: ${responseErrorText.slice(0, 400)}`);
    }

    const data = await response.json();
    const rawText = (data?.candidates || [])
      .flatMap((c) => c?.content?.parts || [])
      .map((p) => p?.text || "")
      .join("\n");
    const parsed = extractJsonFromModelText(rawText);
    const sessions = Array.isArray(parsed?.sessions) ? parsed.sessions : [];
    if (!sessions.length) {
      throw new Error("Aucun créneau renvoyé par Gemini.");
    }

    if (replaceExisting) {
      ui.aiGenerationStatus.textContent = "Suppression des créneaux existants...";
      await deleteAllSessionsForAiGeneration();
    }

    ui.aiGenerationStatus.textContent = "Application des créneaux proposés...";
    const result = await applyAiGeneratedSessions(sessions);
    state.aiLastReportRows = [
      `Sessions reçues: ${sessions.length}`,
      `Créées: ${result.created}`,
      `Rejetées: ${result.failed}`,
      ...result.errors.slice(0, 20),
      ...(result.errors.length > 20 ? [`... ${result.errors.length - 20} erreur(s) supplémentaire(s)`] : []),
    ];
    ui.aiGenerationStatus.textContent = `Génération terminée: ${result.created} créée(s), ${result.failed} rejetée(s).`;
  } catch (error) {
    state.aiLastReportRows = [String(error?.message || "Erreur inconnue.")];
    ui.aiGenerationStatus.textContent = `Erreur génération IA: ${error?.message || "échec."}`;
  } finally {
    state.aiBusy = false;
    renderAIPanel();
  }
}

function render() {
  renderSchoolYearScopeSelector();
  syncAdminTeacherSelection();
  syncDesiderataTeacherSelection();
  renderTeacherOptions();
  renderClassOptions();
  renderAssignExperience();
  renderTeacherMiniatures();
  renderPlannerGrid();
  renderAssignSidebar();
  renderTeacherList();
  renderClassList();
  renderSessionsList();
  renderAbsencePanel();
  renderSchoolYearPanel();
  renderSwimPlanner();
  renderProgrammingPanel();
  renderAIPanel();
  renderAlgoPanel();
  renderBusPanel();
  renderTasksKanban();
  renderDocumentsFolders();
  renderRepartitionPanel();
  renderDesiderata();
  renderAdminSummary();
  renderRightsPanel();
  renderPublic();
  enforcePermissions();
}

function renderAssignExperience() {
  document.body.dataset.assignMode = String(state.assignMode || "assign");
  if (ui.assignModeViewBtn) ui.assignModeViewBtn.classList.toggle("active", state.assignMode === "view");
  if (ui.assignModeAssignBtn) ui.assignModeAssignBtn.classList.toggle("active", state.assignMode === "assign");
  if (ui.assignModeReorganizeBtn) ui.assignModeReorganizeBtn.classList.toggle("active", state.assignMode === "reorganize");

  if (ui.assignFilterTeacherSelect) {
    const options = [`<option value="">Tous les profs</option>`]
      .concat(state.teachers.map((t) => `<option value="${escapeHtml(t.id)}">${escapeHtml(t.name)}</option>`))
      .join("");
    ui.assignFilterTeacherSelect.innerHTML = options;
    ui.assignFilterTeacherSelect.value = String(state.assignFilters.teacherId || "");
  }

  if (ui.assignFilterLevelSelect) {
    const levels = Array.from(new Set(state.classes.map((c) => String(c.level || "")).filter(Boolean))).sort((a, b) =>
      a.localeCompare(b, "fr")
    );
    ui.assignFilterLevelSelect.innerHTML = [`<option value="">Tous les niveaux</option>`, `<option value="AS">AS</option>`]
      .concat(levels.map((level) => `<option value="${escapeHtml(level)}">${escapeHtml(level)}</option>`))
      .join("");
    ui.assignFilterLevelSelect.value = String(state.assignFilters.level || "");
  }

  if (ui.assignFilterConflictsOnly) {
    ui.assignFilterConflictsOnly.checked = Boolean(state.assignFilters.conflictsOnly);
  }

  renderAssignContextPanel();
}

function doesSessionMatchAssignFilters(session) {
  if (!session) return false;
  const teacherFilter = String(state.assignFilters.teacherId || "");
  if (teacherFilter && String(session.teacherId || "") !== teacherFilter) return false;
  const levelFilter = String(state.assignFilters.level || "");
  if (levelFilter) {
    if (levelFilter === "AS") {
      // Filtre AS : vérifier si c'est une session AS
      if (!String(session.classId || "").startsWith("__")) return false;
    } else {
      // Filtre par niveau normal
      const cls = state.classes.find((c) => c.id === session.classId);
      if (String(cls?.level || "") !== levelFilter) return false;
    }
  }
  return true;
}

function selectAssignContext(selection) {
  state.assignSelection = selection ? { ...selection } : null;
  renderAssignContextPanel();
}

function renderAssignContextPanel() {
  if (!ui.assignContextPanel) return;
  const selection = state.assignSelection;
  if (!selection) {
    ui.assignContextPanel.innerHTML = `
      <div class="summary-box">
        <strong>Mode actuel :</strong> ${escapeHtml(state.assignMode === "view" ? "Voir" : state.assignMode === "reorganize" ? "Réorganiser" : "Affecter")}<br>
        Clique un créneau vide pour préparer une affectation, ou un cours pour voir son contexte.
      </div>
    `;
    return;
  }

  if (selection.kind === "session") {
    const session = state.sessions.find((s) => s.id === selection.sessionId);
    const teacher = state.teachers.find((t) => t.id === session?.teacherId);
    const cls = state.classes.find((c) => c.id === session?.classId);
    if (!session || !teacher) {
      ui.assignContextPanel.innerHTML = `<p class="summary-box">Créneau introuvable.</p>`;
      return;
    }
    const quality = evaluateAssignmentQuality(session);
    const cadenceText =
      normalizeCadence(session.cadence) === "BIWEEKLY"
        ? `Semaine ${normalizeWeekType(session.weekType)}`
        : "Toutes les semaines";
    ui.assignContextPanel.innerHTML = `
      <div class="assign-context-card">
        <div class="assign-context-grid">
          <div><span class="assign-context-label">Enseignant</span><strong>${escapeHtml(teacher.name)}</strong></div>
          <div><span class="assign-context-label">Niveau</span><strong>${escapeHtml(cls?.level || session.type || "-")}</strong></div>
          <div><span class="assign-context-label">Classe</span><strong>${escapeHtml(getClassLabelById(session.classId, true))}</strong></div>
          <div><span class="assign-context-label">Créneau</span><strong>${escapeHtml(session.day)} ${escapeHtml(session.start)}</strong></div>
        </div>
        <p class="summary-box">
          <strong>Cadence :</strong> ${escapeHtml(cadenceText)}<br>
          <strong>Score :</strong> <span class="assign-score-badge ${escapeHtml(quality.tone.key)}">${quality.score}/100 · ${escapeHtml(quality.tone.label)}</span>
        </p>
        <ul class="assign-quality-list">
          ${quality.details.map((detail) => `<li>${escapeHtml(detail)}</li>`).join("")}
        </ul>
        <div class="assign-context-actions">
          <button type="button" class="secondary-btn" data-assign-context-action="compare-teacher" data-teacher-id="${escapeHtml(teacher.id)}">Voir EDT prof</button>
          <button type="button" class="secondary-btn" data-assign-context-action="open-slot" data-day="${escapeHtml(session.day)}" data-slot="${escapeHtml(session.start)}">Ouvrir ce créneau</button>
        </div>
      </div>
    `;
  } else {
    const day = String(selection.day || "");
    const slot = String(selection.slot || "");
    const teacherId = String(selection.teacherId || "");
    const slotSessions = state.sessions
      .filter((s) => String(s.day || "") === day)
      .filter((s) => getCoveredSlots(s.day, s.start, Number(s.duration || 0)).includes(toSlotKey(day, slot)))
      .filter((s) => doesSessionMatchAssignFilters(s));
    const visibleTeachers = Array.from(
      new Set(slotSessions.map((s) => state.teachers.find((t) => t.id === s.teacherId)?.name).filter(Boolean))
    );
    const levelFilter = String(state.assignFilters.level || "");
    const availableClasses = state.classes.filter((cls) => {
      if (levelFilter && String(cls.level || "") !== levelFilter) return false;
      if (teacherId) {
        const teacher = state.teachers.find((t) => t.id === teacherId);
        if (teacher && !isTeacherAssignedToClass(teacher, cls.id)) return false;
      }
      return true;
    }).length;
    ui.assignContextPanel.innerHTML = `
      <div class="assign-context-card">
        <div class="assign-context-grid">
          <div><span class="assign-context-label">Créneau</span><strong>${escapeHtml(day)} ${escapeHtml(slot)}</strong></div>
          <div><span class="assign-context-label">Mode</span><strong>${escapeHtml(state.assignMode === "view" ? "Lecture" : state.assignMode === "reorganize" ? "Réorganisation" : "Affectation")}</strong></div>
          <div><span class="assign-context-label">Cours visibles</span><strong>${slotSessions.length}</strong></div>
          <div><span class="assign-context-label">Classes envisageables</span><strong>${availableClasses}</strong></div>
        </div>
        <p class="summary-box">
          ${visibleTeachers.length ? `<strong>Professeurs visibles :</strong> ${escapeHtml(visibleTeachers.join(", "))}` : "Aucun cours visible sur ce créneau avec les filtres actuels."}
        </p>
        <div class="assign-context-actions">
          <button type="button" class="secondary-btn" data-assign-context-action="open-slot" data-day="${escapeHtml(day)}" data-slot="${escapeHtml(slot)}">Affecter ici</button>
          ${teacherId ? `<button type="button" class="secondary-btn" data-assign-context-action="compare-teacher" data-teacher-id="${escapeHtml(teacherId)}">Afficher ce prof</button>` : ""}
        </div>
      </div>
    `;
  }

  ui.assignContextPanel.querySelectorAll("[data-assign-context-action]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const action = String(btn.dataset.assignContextAction || "");
      if (action === "compare-teacher") {
        const teacherId = String(btn.dataset.teacherId || "");
        if (!teacherId) return;
        if (!state.comparingTeacherIds.includes(teacherId)) state.comparingTeacherIds.push(teacherId);
        render();
        return;
      }
      if (action === "open-slot") {
        const day = String(btn.dataset.day || selection.day || "");
        const slot = String(btn.dataset.slot || selection.slot || "");
        if (!day || !slot) return;
        openQuickAssignWizardForSlot({
          day,
          slot,
          weekType: normalizeWeekType(state.selectedGlobalWeekType || "A"),
        });
      }
    });
  });
}

function renderAssignSidebar() {
  if (!ui.assignClassesToPlace) return;

  const groups = new Map();
  const ensureGroup = (key) => {
    if (!groups.has(key)) groups.set(key, []);
    return groups.get(key);
  };

  // Spéciaux (AS/Danse): inchangé
  SPECIAL_ASSIGNMENTS.forEach((s) => {
    ensureGroup(s.label.includes("AS") ? "AS" : "Danse").push({
      label: s.label,
      payload: `CLASS::${s.id}`,
      count: "∞",
      style: "",
      teacherTag: "",
    });
  });

  // Classes EPS en attente: agrégées par niveau
  const pendingClasses = state.classes
    .filter((c) => {
      const levelFilter = String(state.assignFilters.level || "");
      return !levelFilter || String(c.level || "") === levelFilter;
    })
    .map((c) => ({
      id: c.id,
      level: c.level,
      name: c.name,
      remaining: Number(c.weeklyHours || 0) - getAssignedHoursForClass(c.id),
      assignedHours: getAssignedHoursForClass(c.id),
      ownerTeacherId: getClassOwnerTeacherId(c.id),
    }))
    .filter((x) => x.remaining > 0.001);

  const newByLevel = new Map();
  const partialByLevelOwner = new Map();
  for (const row of pendingClasses) {
    if (row.assignedHours > 0) {
      const k = `${row.level}__${row.ownerTeacherId || ""}`;
      partialByLevelOwner.set(k, (partialByLevelOwner.get(k) || 0) + 1);
    } else {
      newByLevel.set(row.level, (newByLevel.get(row.level) || 0) + 1);
    }
  }

  for (const [level, count] of newByLevel.entries()) {
    ensureGroup(level).push({
      label: level,
      payload: `LEVEL::${encodeURIComponent(level)}::NEW`,
      count: String(count),
      style: "",
      teacherTag: "",
    });
  }
  for (const [key, count] of partialByLevelOwner.entries()) {
    const [level, ownerTeacherId] = key.split("__");
    const owner = state.teachers.find((t) => t.id === ownerTeacherId);
    const color = owner ? getTeacherColor(owner) : "";
    ensureGroup(level).push({
      label: level,
      payload: `LEVEL::${encodeURIComponent(level)}::PARTIAL::${ownerTeacherId || ""}`,
      count: String(count),
      style: color ? `border: 2px solid ${color}; background-color: ${color}10;` : "",
      teacherTag:
        owner && ownerTeacherId
          ? `<span class="pill-teacher-tag" style="background: ${color}">${escapeHtml(getTeacherDisplayLabel(owner))}</span>`
          : "",
    });
  }

  const levelOrder = ["Sixième", "Cinquième", "Quatrième", "Troisième", "Seconde", "Première", "Terminale", "AS", "Danse"];
  const sortedKeys = Array.from(groups.keys()).sort((a, b) => {
    const ia = levelOrder.indexOf(a);
    const ib = levelOrder.indexOf(b);
    const va = ia < 0 ? 99 : ia;
    const vb = ib < 0 ? 99 : ib;
    if (va !== vb) return va - vb;
    return String(a).localeCompare(String(b), "fr");
  });

  ui.assignClassesToPlace.innerHTML = sortedKeys
    .map((level) => {
      const items = groups.get(level) || [];
      return `
        <div class="assign-level-group">
          <div class="level-header">${escapeHtml(level)}</div>
          <div class="level-classes-grid">
            ${items
              .map(
                (item) => `
                <div class="assign-class-pill"
                     draggable="true"
                     style="${item.style}"
                     data-assign-payload="${escapeHtml(item.payload)}">
                  <div class="pill-main-info">
                    <span class="pick-label">${escapeHtml(item.label)}</span>
                    ${item.teacherTag}
                  </div>
                  <span class="pill-hours">x${escapeHtml(item.count)}</span>
                </div>
              `
              )
              .join("")}
          </div>
        </div>
      `;
    })
    .join("");

  if (!sortedKeys.length) {
    ui.assignClassesToPlace.innerHTML = `<p class="summary-box">Aucune classe à placer avec les filtres actuels.</p>`;
  }

  if (state.assignMode === "view") {
    ui.assignClassesToPlace.innerHTML = `<p class="summary-box">Mode Voir actif. Passe en mode Affecter pour utiliser les classes à placer.</p>`;
  }

  if (ui.floatingAssignBadge) {
    ui.floatingAssignBadge.textContent = String(pendingClasses.length);
  }

  ui.assignClassesToPlace.querySelectorAll(".assign-class-pill").forEach((pill) => {
    pill.addEventListener("dragstart", (e) => {
      if (state.assignMode === "view") {
        e.preventDefault();
        return;
      }
      e.dataTransfer.setData("text/plain", String(pill.dataset.assignPayload || ""));
      e.dataTransfer.effectAllowed = "move";
      setTimeout(() => {
        if (ui.floatingAssignContainer) ui.floatingAssignContainer.classList.add("collapsed");
      }, 10);
    });
    pill.addEventListener("click", () => {
      const payload = String(pill.dataset.assignPayload || "");
      const label = String(pill.querySelector(".pick-label")?.textContent || payload);
      if (!payload) return;
      setTouchAssignPayload(payload, label);
    });
    pill.addEventListener(
      "touchstart",
      () => {
        const payload = String(pill.dataset.assignPayload || "");
        const label = String(pill.querySelector(".pick-label")?.textContent || payload);
        if (!payload) return;
        setTouchAssignPayload(payload, label);
      },
      { passive: true }
    );
  });
}

function renderAssignLettersTableView() {
  const container = ui.globalPlannerContainer;
  if (!container) return;

  // Group classes by teacher
  const classesByTeacher = new Map();
  const activeYear = getActiveSchoolYearId();

  for (const cls of state.classes) {
    if (!isDocInActiveSchoolYear(cls)) continue;

    // Find teachers who teach this class
    const teachersForClass = state.sessions
      .filter((s) => s.classId === cls.id && isDocInActiveSchoolYear(s))
      .map((s) => state.teachers.find((t) => t.id === s.teacherId))
      .filter((t) => t && isTeacherActiveInYear(t, activeYear));

    for (const teacher of teachersForClass) {
      if (!classesByTeacher.has(teacher.id)) {
        classesByTeacher.set(teacher.id, { teacher, classes: [] });
      }
      if (!classesByTeacher.get(teacher.id).classes.find((c) => c.id === cls.id)) {
        classesByTeacher.get(teacher.id).classes.push(cls);
      }
    }
  }

  // Sort teachers and their classes
  const sortedTeachers = Array.from(classesByTeacher.values())
    .sort((a, b) => String(a.teacher.name || "").localeCompare(String(b.teacher.name || ""), "fr"))
    .map((entry) => ({
      ...entry,
      classes: entry.classes.sort((a, b) => String(a.name || "").localeCompare(String(b.name || ""), "fr")),
    }));

  // Build HTML table
  let tableHtml = `
    <div class="assign-letters-table-container">
      <h3>Modification des noms de classes par enseignant</h3>
      <table class="assign-letters-table">
        <thead>
          <tr>
            <th>Enseignant</th>
            <th>Classes actuelles</th>
            <th>Nouveau nom</th>
          </tr>
        </thead>
        <tbody>
  `;

  for (const { teacher, classes } of sortedTeachers) {
    for (const cls of classes) {
      const draft = state.assignLetterDraftByClass?.[cls.id] || "";
      const displayValue = draft || cls.name || "";
      tableHtml += `
        <tr data-class-id="${escapeHtml(cls.id)}">
          <td><strong>${escapeHtml(teacher.name || "")}</strong></td>
          <td>${escapeHtml(cls.name || "")}</td>
          <td>
            <input type="text" class="assign-letter-input" data-class-id="${escapeHtml(cls.id)}"
                   value="${escapeHtml(displayValue)}" placeholder="Ex: Quatrième 4A" />
          </td>
        </tr>
      `;
    }
  }

  tableHtml += `
        </tbody>
      </table>
    </div>
  `;

  container.innerHTML = tableHtml;

  // Bind input change handlers
  container.querySelectorAll(".assign-letter-input").forEach((input) => {
    input.addEventListener("change", () => {
      const classId = input.dataset.classId;
      const value = input.value.trim();
      if (!value) {
        delete state.assignLetterDraftByClass[classId];
      } else {
        if (!state.assignLetterDraftByClass) state.assignLetterDraftByClass = {};
        state.assignLetterDraftByClass[classId] = value;
      }
    });
  });
}

function getClassLabelWithDraftHtml(classId, fallbackLabel = "") {
  if (!state.assignLettersEditMode) return escapeHtml(String(fallbackLabel || ""));
  if (isSpecialAssignmentId(classId)) return escapeHtml(String(fallbackLabel || ""));
  const cls = state.classes.find((c) => c.id === classId);
  if (!cls) return escapeHtml(String(fallbackLabel || ""));
  const draft = state.assignLetterDraftByClass?.[classId];
  if (!draft) return escapeHtml(String(fallbackLabel || ""));
  return `<span class="assign-letter-old">${escapeHtml(String(cls.name || ""))}</span> <span class="assign-letter-new">${escapeHtml(draft)}</span>`;
}


async function commitAssignLetterDrafts() {
  const drafts = state.assignLetterDraftByClass || {};
  const draftEntries = Object.entries(drafts);
  if (!draftEntries.length) {
    state.assignLettersEditMode = false;
    return { ok: true, message: "Aucun changement de lettre." };
  }

  const errors = [];
  const batch = db.batch();
  let changed = 0;

  // Only validate and update classes that have changed
  for (const [classId, newName] of Object.entries(drafts)) {
    const cls = state.classes.find((c) => c.id === classId);
    if (!cls) continue;

    const trimmedName = String(newName || "").trim();
    if (!trimmedName) {
      errors.push(`${cls.name}: nom invalide.`);
      continue;
    }

    // Only update if the name actually changed
    if (trimmedName === String(cls.name || "")) continue;

    // Check for duplicates only with OTHER changed classes, not existing classes
    const isDuplicate = Object.entries(drafts).some(([otherId, otherName]) => {
      if (otherId === classId) return false;
      const otherCls = state.classes.find((c) => c.id === otherId);
      if (!otherCls) return false;
      if (String(otherCls.level || "") !== String(cls.level || "")) return false;
      return String(otherName || "").trim() === trimmedName;
    });

    if (isDuplicate) {
      errors.push(`Doublon dans les changements: ${trimmedName}`);
      continue;
    }

    batch.update(doc(db, "classes", cls.id), { name: trimmedName, updatedAt: serverTimestamp() });
    changed += 1;
  }

  if (errors.length) {
    return { ok: false, error: `Validation impossible:\n- ${Array.from(new Set(errors)).join("\n- ")}` };
  }

  if (!changed) {
    state.assignLettersEditMode = false;
    state.assignLetterDraftByClass = {};
    return { ok: true, message: "Aucun changement effectif." };
  }

  try {
    await batch.commit();
    state.assignLettersEditMode = false;
    state.assignLetterDraftByClass = {};
    return { ok: true, message: `Lettres validées (${changed} classe(s) mises à jour).` };
  } catch (error) {
    return { ok: false, error: `Erreur sauvegarde: ${error?.message || "échec."}` };
  }
}

function bindGlobalClassLetterEditActions(container) {
  // Event binding is now handled in renderAssignLettersTableView
  // This function is kept for backward compatibility but does nothing
}

function parseAssignPayload(payload) {
  const raw = String(payload || "");
  if (raw.startsWith("CLASS::")) {
    return { kind: "class", classId: raw.slice("CLASS::".length) };
  }
  if (raw.startsWith("LEVEL::")) {
    const parts = raw.split("::");
    const level = decodeURIComponent(parts[1] || "");
    const mode = String(parts[2] || "NEW");
    const ownerTeacherId = String(parts[3] || "");
    return { kind: "level", level, mode, ownerTeacherId };
  }
  return { kind: "class", classId: raw };
}

function setTouchAssignPayload(payload, label = "") {
  state.touchAssignPayload = { payload: String(payload || ""), label: String(label || "") };
  if (ui.sessionError) {
    ui.sessionError.textContent = `Sélection tactile: ${label || payload}. Touchez une case du planning pour déposer.`;
    ui.sessionError.className = "error-text hours-ok";
  }
}

function clearTouchAssignPayload() {
  state.touchAssignPayload = null;
}

function resolveClassIdFromAssignPayload(payload, teacherId, day, slot, weekType = "A") {
  const parsed = parseAssignPayload(payload);
  if (parsed.kind === "class") return parsed.classId || "";
  if (parsed.kind !== "level") return "";

  let candidates = state.classes
    .filter((c) => String(c.level || "") === String(parsed.level || ""))
    .filter((c) => getClassAlgoRemaining(c.id) > 0.001);

  if (parsed.mode === "NEW") {
    candidates = candidates.filter((c) => getAssignedHoursForClass(c.id) <= 0.001);
  } else if (parsed.mode === "PARTIAL") {
    candidates = candidates.filter((c) => getAssignedHoursForClass(c.id) > 0.001);
    if (parsed.ownerTeacherId) {
      candidates = candidates.filter((c) => String(getClassOwnerTeacherId(c.id) || "") === String(parsed.ownerTeacherId));
    }
  }

  candidates.sort((a, b) => String(a.name || "").localeCompare(String(b.name || ""), "fr"));
  if (!candidates.length) return "";

  if (!teacherId) return candidates[0].id;
  const assignable = candidates.filter((c) => canAssignClassInTeacherSlot(teacherId, c.id, day, slot, weekType));
  if (assignable.length) return assignable[0].id;
  // Fallback robuste: on renvoie la prochaine classe du niveau,
  // puis la validation métier standard décidera si le placement est autorisé.
  return candidates[0]?.id || "";
}

function enforcePermissions() {
  // Skip for SUPER_ADMIN - they have all permissions
  if (state.currentUserRole === "SUPER_ADMIN") return;

  const rights = getCurrentUserRights();
  console.log("Enforcing permissions for user:", state.currentUserTeacherId, "Rights:", rights);
  const map = [
    { panel: ui.adminCreationPanel, button: ui.adminTabCreationBtn, key: "creation" },
    { panel: ui.adminAssignPanel, button: ui.adminTabAssignBtn, key: "assign" },
    { panel: ui.adminProgramPanel, button: ui.adminTabProgramBtn, key: "program" },
    { panel: ui.adminAlgoPanel, button: ui.adminTabAlgoBtn, key: "program" },
    { panel: ui.adminBusPanel, button: ui.adminTabBusBtn, key: "bus" },
    { panel: ui.adminTasksPanel, button: ui.adminTabTasksBtn, key: "tasks" },
    { panel: ui.adminDocumentsPanel, button: ui.adminTabDocumentsBtn, key: "documents" },
    { panel: ui.adminManagePanel, button: ui.adminTabManageBtn, key: "manage" },
    { panel: ui.adminAbsencePanel, button: ui.adminTabAbsenceBtn, key: "manage" },
    { panel: ui.adminSchoolYearPanel, button: ui.adminTabSchoolYearBtn, key: "manage" },
    { panel: ui.adminEmailTemplatesPanel, button: ui.adminTabEmailTemplatesBtn, key: "emailTemplates" },
    { panel: ui.adminSwimPanel, button: ui.adminTabSwimBtn, key: "swim" },
    { panel: ui.adminRecapPanel, button: ui.adminTabRecapBtn, key: "recap" },
    { panel: ui.adminRepartitionPanel, button: ui.adminTabRepartitionBtn, key: "repartition" },
    { panel: ui.adminInventoryPanel, button: ui.adminTabInventoryBtn, key: "inventory" },
  ];

  map.forEach(({ panel, button, key }) => {
    if (!panel) return;

    const hasAccess = rights[key] !== "NONE";
    const canModify = rights[key] === "MODIFY";

    // Cacher/montrer le bouton d'onglet basé sur l'accès (utiliser classe "hidden" pour cohérence)
    if (button) {
      button.classList.toggle("hidden", !hasAccess);
    }

    // Cacher le panel si pas d'accès du tout
    if (!hasAccess) {
      panel.classList.add("hidden");
    } else {
      // Montrer le panel s'il a accès
      panel.classList.remove("hidden");
    }

    // Désactiver les contrôles si pas de droit MODIFY
    panel.querySelectorAll("input, select, button").forEach((el) => {
      // Ne pas désactiver les onglets de sous-programmation eux-mêmes
      if (el.id.startsWith("programSubtab")) return;
      // Natation: les toggles sont gérés dynamiquement et doivent rester cliquables.
      if (el.classList.contains("swim-toggle")) return;

      el.disabled = !canModify;
      if (el.classList.contains("delete-btn") || el.classList.contains("secondary-btn")) {
        el.style.opacity = canModify ? "1" : "0.5";
        el.style.pointerEvents = canModify ? "auto" : "none";
      }
    });
    // Cas particulier pour le drag & drop dans la programmation
    if (key === "program") {
      panel.querySelectorAll("[draggable]").forEach(el => {
        el.draggable = canModify;
        el.style.opacity = canModify ? "1" : "0.5";
      });
    }
  });
}

function setupInventory() {
  const qInventory = collection(db, "inventory");
  onSnapshot(qInventory, (snap) => {
    state.inventory = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    renderInventory();
  });
}

async function saveInventoryRecord() {
  if (!ui.inventoryItemName || !ui.inventoryCount || !ui.inventoryDate) return;
  const name = String(ui.inventoryItemName.value || "").trim();
  const count = parseInt(ui.inventoryCount.value, 10);
  const date = ui.inventoryDate.value;

  if (!name || isNaN(count) || !date) return;

  try {
    await addDoc(collection(db, "inventory"), {
      name,
      count,
      date,
      createdAt: serverTimestamp()
    });
    ui.inventoryItemName.value = "";
    ui.inventoryCount.value = "";
    showToast("Relevé d'inventaire enregistré !", "success");
  } catch (err) {
    console.error("Erreur inventaire:", err);
    showToast("Erreur lors de l'enregistrement.", "error");
  }
}

function renderInventory() {
  renderInventorySummary();
  renderInventoryHistory();
  
  // Suggestions datalist
  if (ui.inventoryItemSuggestions) {
    const names = Array.from(new Set(state.inventory.map(i => i.name))).sort();
    ui.inventoryItemSuggestions.innerHTML = names.map(n => `<option value="${escapeHtml(n)}">`).join("");
  }
}

function renderInventorySummary() {
  if (!ui.inventorySummaryContainer) return;
  
  // Pour chaque matériel, on garde le relevé le plus récent
  const summaryMap = new Map();
  state.inventory.forEach(record => {
    const existing = summaryMap.get(record.name);
    if (!existing || record.date > existing.date || (record.date === existing.date && record.createdAt > existing.createdAt)) {
      summaryMap.set(record.name, record);
    }
  });

  const sortedNames = Array.from(summaryMap.keys()).sort();

  if (sortedNames.length === 0) {
    ui.inventorySummaryContainer.innerHTML = `<p class="summary-box">Aucun matériel inventorié pour le moment.</p>`;
    return;
  }

  const rows = sortedNames.map(name => {
    const record = summaryMap.get(name);
    const isSelected = state.selectedInventoryItem === name;
    return `
      <tr class="${isSelected ? "selected-row" : ""}" onclick="state.selectedInventoryItem = '${escapeHtml(name)}'; renderInventory();">
        <td><strong>${escapeHtml(name)}</strong></td>
        <td style="text-align:center"><strong>${record.count}</strong></td>
        <td>${new Date(record.date).toLocaleDateString("fr-FR")}</td>
      </tr>
    `;
  }).join("");

  ui.inventorySummaryContainer.innerHTML = `
    <table>
      <thead>
        <tr>
          <th>Matériel</th>
          <th style="text-align:center">Stock actuel</th>
          <th>Dernier relevé</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}

function renderInventoryHistory() {
  if (!ui.inventoryHistoryContainer) return;
  const name = state.selectedInventoryItem;
  
  if (!name) {
    ui.inventoryHistoryContainer.innerHTML = `<p class="summary-box">Cliquez sur un matériel ci-dessus pour voir son historique.</p>`;
    return;
  }

  const history = state.inventory
    .filter(i => i.name === name)
    .sort((a, b) => b.date.localeCompare(a.date) || b.createdAt - a.createdAt);

  const rows = history.map(h => {
    return `
      <tr>
        <td>${new Date(h.date).toLocaleDateString("fr-FR")}</td>
        <td style="text-align:center"><strong>${h.count}</strong></td>
        <td><button class="delete-btn" onclick="deleteInventoryRecord('${h.id}')" type="button">Supprimer</button></td>
      </tr>
    `;
  }).join("");

  ui.inventoryHistoryContainer.innerHTML = `
    <div style="margin-bottom: 0.5rem;"><strong>Historique pour : ${escapeHtml(name)}</strong></div>
    <table>
      <thead>
        <tr>
          <th>Date</th>
          <th style="text-align:center">Quantité</th>
          <th>Action</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}

async function deleteInventoryRecord(id) {
  if (!confirm("Supprimer ce relevé ?")) return;
  try {
    await deleteDoc(doc(db, "inventory", id));
  } catch (err) {
    showToast("Erreur lors de la suppression.", "error");
  }
}

function renderTeacherOptions() {
  const opts = state.teachers.map((t) => `<option value="${t.id}">${escapeHtml(t.name)}</option>`).join("");

  if (ui.publicTeacherSelect) {
    ui.publicTeacherSelect.innerHTML = `<option value="__ALL__">Tous les enseignants</option>${opts}`;
    if (state.selectedPublicTeacherId) ui.publicTeacherSelect.value = state.selectedPublicTeacherId;
  }

  if (ui.desiderataTeacherSelect) {
    if (state.currentUserRole === "SUPER_ADMIN") {
      // L'admin peut consulter tous les enseignants
      ui.desiderataTeacherSelect.innerHTML = opts;
      if (ui.desiderataTeacherSelect.parentElement) ui.desiderataTeacherSelect.parentElement.style.display = "";
      if (!state.selectedDesiderataTeacherId || !state.teachers.find(t => t.id === state.selectedDesiderataTeacherId)) {
        state.selectedDesiderataTeacherId = state.teachers[0]?.id || "";
      }
      ui.desiderataTeacherSelect.value = state.selectedDesiderataTeacherId;
    } else if (state.currentUserRole === "CUSTOM" && state.currentUserTeacherId) {
      // L'enseignant ne voit que ses propres désidérata
      const teacher = state.teachers.find(t => t.id === state.currentUserTeacherId);
      if (teacher) {
        ui.desiderataTeacherSelect.innerHTML = `<option value="${teacher.id}">${escapeHtml(teacher.name)}</option>`;
        ui.desiderataTeacherSelect.value = teacher.id;
        state.selectedDesiderataTeacherId = teacher.id;
        if (ui.desiderataTeacherSelect.parentElement) ui.desiderataTeacherSelect.parentElement.style.display = "none";
      }
    } else {
      ui.desiderataTeacherSelect.innerHTML = `<option value="">Non autorisé</option>`;
      state.selectedDesiderataTeacherId = "";
      if (ui.desiderataTeacherSelect.parentElement) ui.desiderataTeacherSelect.parentElement.style.display = "";
    }
    ui.desiderataTeacherSelect.value = state.selectedDesiderataTeacherId || "";
  }  
  if (ui.teacherEditSelect) {
    ui.teacherEditSelect.innerHTML = `<option value="">Nouveau professeur</option>${opts}`;
    ui.teacherEditSelect.value = state.editingTeacherId || "";
  }

  if (ui.absenceTeacherSelect) {
    ui.absenceTeacherSelect.innerHTML = `<option value="">Sélectionner...</option>${opts}`;
    if (ui.absenceTeacherSelect.value && !state.teachers.some((t) => t.id === ui.absenceTeacherSelect.value)) {
      ui.absenceTeacherSelect.value = "";
    }
  }

  if (ui.teacherSubmitBtn) ui.teacherSubmitBtn.textContent = state.editingTeacherId ? "Enregistrer les modifications" : "Ajouter professeur";
  if (ui.teacherCancelEditBtn) ui.teacherCancelEditBtn.classList.toggle("hidden", !state.editingTeacherId);
}

function renderClassOptions() {
  // Classes are selected directly from planners.
}

function renderPlannerGrid() {
  const container = ui.assignComparisonArea;
  const globalLargeZone = ui.assignGlobalLargeArea;
  const workspace = ui.assignWorkspace;
  if (!container || !globalLargeZone || !workspace) return;

  // 1. Toujours afficher le planning général en haut
  const globalContainer = document.getElementById("globalPlannerContainer");
  if (globalContainer) {
    ui.globalPlannerContainer = globalContainer;
    ui.globalPlannerHint = document.getElementById("globalPlannerHint");
    renderGlobalPlanner();
  }

  // 2. Gérer les professeurs sélectionnés en bas
  const teacherFilter = String(state.assignFilters.teacherId || "");
  const visibleComparingTeacherIds = state.comparingTeacherIds.filter((id) => !teacherFilter || id === teacherFilter);
  const selectedCount = visibleComparingTeacherIds.length;
  
  if (selectedCount > 0) {
    container.classList.remove("hidden");
    
    // On construit uniquement les cartes des profs
    container.innerHTML = visibleComparingTeacherIds.map(id => {
      const teacher = state.teachers.find(t => t.id === id);
      if (!teacher) return "";
      return `
        <div class="card assign-teacher-card">
          <div class="assign-teacher-head">
            <div class="assign-teacher-head-main">
              <span class="teacher-color-dot large" style="background:${escapeHtml(getTeacherColor(teacher))}"></span>
              <div>
                <h3>${escapeHtml(teacher.name)}</h3>
                <p>${escapeHtml(getTeacherDisplayLabel(teacher))}</p>
              </div>
            </div>
            <button class="session-remove-btn" data-close-compare-teacher="${escapeHtml(id)}" type="button" title="Fermer cette vue">×</button>
          </div>
          <div id="adminPlannerHint-${escapeHtml(teacher.id)}" class="summary-box"></div>
          <div id="adminPlannerContainer-${escapeHtml(teacher.id)}" class="table-wrap"></div>
        </div>
      `;
    }).join("");

    // Rendre chaque prof
    const prevAdminHint = ui.adminPlannerHint;
    const prevAdminContainer = ui.adminPlannerContainer;
    const prevTeacherId = state.selectedAdminTeacherId;

    visibleComparingTeacherIds.forEach(id => {
      ui.adminPlannerHint = document.getElementById(`adminPlannerHint-${id}`);
      ui.adminPlannerContainer = document.getElementById(`adminPlannerContainer-${id}`);
      state.selectedAdminTeacherId = id;
      if (ui.adminPlannerContainer) renderAdminPlanner();
    });

    container.querySelectorAll("[data-close-compare-teacher]").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        const id = String(btn.getAttribute("data-close-compare-teacher") || "");
        if (!id) return;
        state.comparingTeacherIds = state.comparingTeacherIds.filter((x) => x !== id);
        render();
      });
    });

    // Restaurer l'état
    ui.adminPlannerHint = prevAdminHint;
    ui.adminPlannerContainer = prevAdminContainer;
    state.selectedAdminTeacherId = prevTeacherId;
  } else {
    container.innerHTML = "";
    container.classList.add("hidden");
  }
}

function getGridColumns(count) {
  // Inclure le bloc planning général dans le compte
  const total = count + 1;
  if (total <= 2) return 2; // 1 prof + global = 2x1
  if (total <= 4) return 2; // 2 ou 3 profs + global = 2x2
  return 3; // 4+ profs = 3 colonnes
}

function renderTeacherMiniatures() {
  if (!ui.assignTeacherMiniatures) return;
  const container = ui.assignTeacherMiniatures;

  // Vérifier les droits d'affectation
  const userRights = state.userRights.find((r) => r.id === state.currentUserTeacherId);
  const canModifyAssignments = userRights?.permissions?.assign === "MODIFY";

  // Ne pas afficher les miniatures si pas de droit MODIFY
  if (!canModifyAssignments) {
    container.innerHTML = "";
    return;
  }

  container.innerHTML = state.teachers.map(teacher => {
    const isActive = state.comparingTeacherIds.includes(teacher.id);
    return `
      <div class="miniature-card${isActive ? " active" : ""}" data-compare-teacher-id="${escapeHtml(teacher.id)}">
        <div style="display:flex; justify-content:space-between; align-items:center;">
          <h4 style="margin:0;">${escapeHtml(teacher.name)}</h4>
          ${getPersistedDesiderataCommentForTeacher(teacher.id) ? `<span class="material-symbols-outlined" title="Note: ${escapeHtml(getPersistedDesiderataCommentForTeacher(teacher.id))}" style="font-size:1.1rem; color:#f59f00; cursor:help;">chat</span>` : ""}
        </div>
        <div class="mini-grid-container" id="mini-grid-${escapeHtml(teacher.id)}"></div>
      </div>
    `;
  }).join("");

  // Rendre chaque petit tableau
  const prevAdminHint = ui.adminPlannerHint;
  const prevAdminContainer = ui.adminPlannerContainer;
  const prevTeacherId = state.selectedAdminTeacherId;

  state.teachers.forEach(teacher => {
    ui.adminPlannerHint = { set textContent(v) {}, set innerHTML(v) {} }; 
    ui.adminPlannerContainer = document.getElementById(`mini-grid-${teacher.id}`);
    state.selectedAdminTeacherId = teacher.id;
    if (ui.adminPlannerContainer) {
      renderAdminPlanner();
      // DESACTIVER le Drag & Drop dans les miniatures pour ne pas interférer
      ui.adminPlannerContainer.querySelectorAll("[data-assign-drop-target]").forEach(el => {
        el.removeAttribute("data-assign-drop-target");
        el.style.pointerEvents = "none";
      });
      ui.adminPlannerContainer.querySelectorAll("button").forEach(b => b.remove());
    }
  });

  ui.adminPlannerHint = prevAdminHint;
  ui.adminPlannerContainer = prevAdminContainer;
  state.selectedAdminTeacherId = prevTeacherId;

  // Bind click (Multi-sélection)
  container.querySelectorAll("[data-compare-teacher-id]").forEach(card => {
    card.addEventListener("click", () => {
      const id = card.dataset.compareTeacherId;
      if (state.comparingTeacherIds.includes(id)) {
        state.comparingTeacherIds = state.comparingTeacherIds.filter(x => x !== id);
      } else {
        state.comparingTeacherIds.push(id);
      }
      render();
    });
  });
}

function getPlannerColumns(displayedCount) {
  if (!displayedCount) return 1;
  if (window.innerWidth <= 1100) return 1;
  return Math.ceil(Math.sqrt(displayedCount));
}

function renderTeacherList() {
  if (!ui.teachersList) return;
  const hoursByTeacher = computeTeacherHours();
  ui.teachersList.innerHTML = state.teachers
    .map((t) => {
      const used = hoursByTeacher.get(t.id) || 0;
      const over = used > Number(t.maxHours || 0);
      const color = getTeacherColor(t);
      return `<li class="data-item">
        <div>
          <span class="teacher-color-dot" style="background:${escapeHtml(color)}"></span>
          <strong>${escapeHtml(t.name)}</strong><br>
          ${formatHours(used)}/${formatHours(t.maxHours)}h <span class="${over ? "hours-over" : "hours-ok"}">${over ? "(dépassement)" : ""}</span><br>
          <small>${escapeHtml(getTeacherAssignedTargetLabels(t))}</small>
        </div>
        <button class="delete-btn" data-delete-teacher="${t.id}" type="button">Supprimer</button>
      </li>`;
    })
    .join("");

  ui.teachersList.querySelectorAll("[data-delete-teacher]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const teacherId = btn.dataset.deleteTeacher;
      const isUsed = state.sessions.some((s) => s.teacherId === teacherId);
      if (isUsed) {
        ui.sessionError.textContent = "Suppression refusée: ce professeur est utilisé dans des créneaux.";
        return;
      }
      await deleteDoc(doc(db, "teachers", btn.dataset.deleteTeacher));
    });
  });
}

function renderClassList() {
  if (!ui.classesList) return;
  const assignedByClass = new Map();
  for (const c of state.classes) assignedByClass.set(c.id, 0);
  for (const s of state.sessions) assignedByClass.set(s.classId, (assignedByClass.get(s.classId) || 0) + weeklyEquivalentHours(s));

  const listHtml = state.classes
    .map((c) => {
      const used = assignedByClass.get(c.id) || 0;
      const over = used > Number(c.weeklyHours || 0);
      return `<li class="data-item">
        <div>
          <strong>${escapeHtml(c.level)} ${escapeHtml(c.name)}</strong><br>
          <span class="${over ? "hours-over" : "hours-ok"}">${formatHours(used)}/${formatHours(c.weeklyHours)}h</span>
        </div>
        <button class="delete-btn" data-delete-class="${c.id}" type="button">Supprimer</button>
      </li>`;
    })
    .join("");
  
  ui.classesList.innerHTML = listHtml;

  if (ui.creationClassesTableBody) {
    ui.creationClassesTableBody.innerHTML = state.classes
      .map((c) => {
        const used = assignedByClass.get(c.id) || 0;
        const over = used > Number(c.weeklyHours || 0);
        return `<tr data-class-id="${c.id}">
          <td>${escapeHtml(c.level)}</td>
          <td>
            <div class="view-mode">
              <strong class="class-name">${escapeHtml(c.name)}</strong>
              <button class="edit-name-btn mini-btn" title="Modifier le nom">
                <span class="material-symbols-outlined" style="font-size: 1.1rem;">edit</span>
              </button>
            </div>
            <div class="edit-mode hidden">
              <input type="text" class="edit-name-input" value="${escapeHtml(c.name)}" style="width: 80px; padding: 2px 4px;">
              <button class="save-name-btn mini-btn" title="Enregistrer">
                <span class="material-symbols-outlined" style="font-size: 1.1rem;">check</span>
              </button>
              <button class="cancel-name-btn mini-btn" title="Annuler">
                <span class="material-symbols-outlined" style="font-size: 1.1rem;">close</span>
              </button>
            </div>
          </td>
          <td><span class="${over ? "hours-over" : "hours-ok"}">${formatHours(used)}/${formatHours(c.weeklyHours)}h</span></td>
          <td>
            <button class="delete-btn mini-btn" data-delete-class="${c.id}" type="button" title="Supprimer">
              <span class="material-symbols-outlined">delete</span>
            </button>
          </td>
        </tr>`;
      })
      .join("");

    ui.creationClassesTableBody.querySelectorAll(".edit-name-btn").forEach(btn => {
      btn.addEventListener("click", (e) => {
        const tr = e.currentTarget.closest("tr");
        tr.querySelector(".view-mode").classList.add("hidden");
        tr.querySelector(".edit-mode").classList.remove("hidden");
        tr.querySelector(".edit-name-input").focus();
      });
    });

    ui.creationClassesTableBody.querySelectorAll(".cancel-name-btn").forEach(btn => {
      btn.addEventListener("click", (e) => {
        const tr = e.currentTarget.closest("tr");
        tr.querySelector(".view-mode").classList.remove("hidden");
        tr.querySelector(".edit-mode").classList.add("hidden");
      });
    });

    ui.creationClassesTableBody.querySelectorAll(".save-name-btn").forEach(btn => {
      btn.addEventListener("click", async (e) => {
        const tr = e.currentTarget.closest("tr");
        const classId = tr.dataset.classId;
        const newName = tr.querySelector(".edit-name-input").value.trim();
        if (newName) {
          await updateDoc(doc(db, "classes", classId), { name: newName });
        } else {
          tr.querySelector(".view-mode").classList.remove("hidden");
          tr.querySelector(".edit-mode").classList.add("hidden");
        }
      });
    });
  }

  const deleteClassHandler = async (e) => {
    const btn = e.currentTarget;
    const classId = btn.dataset.deleteClass;
    const isUsed = state.sessions.some((s) => s.classId === classId);
    if (isUsed) {
      if (ui.sessionError) ui.sessionError.textContent = "Suppression refusée: cette classe est utilisée dans des créneaux.";
      showToast("Suppression refusée : cette classe est utilisée dans des créneaux.", "error");
      return;
    }
    if (confirm(`Supprimer la classe ${getClassLabelById(classId, true)} ?`)) {
      await deleteDoc(doc(db, "classes", classId));
    }
  };

  ui.classesList.querySelectorAll("[data-delete-class]").forEach((btn) => {
    btn.addEventListener("click", deleteClassHandler);
  });

  if (ui.creationClassesTableBody) {
    ui.creationClassesTableBody.querySelectorAll("[data-delete-class]").forEach((btn) => {
      btn.addEventListener("click", deleteClassHandler);
    });
  }
}

function renderSessionsList() {
  if (!ui.sessionsList) return;
  ui.sessionsList.innerHTML = state.sessions
    .map((s) => {
      const teacher = state.teachers.find((t) => t.id === s.teacherId);
      const cadenceLabel = normalizeCadence(s.cadence) === "BIWEEKLY" ? ` - Semaine ${normalizeWeekType(s.weekType)}` : "";
      return `<li class="data-item">
        <div>
          <strong>${escapeHtml(s.day)} ${escapeHtml(s.start)} (${s.duration}h${escapeHtml(cadenceLabel)})</strong><br>
          ${escapeHtml(s.type)} - ${escapeHtml(teacher?.name || "Prof inconnu")} - ${escapeHtml(getClassLabelById(s.classId, true))}
        </div>
        <button class="delete-btn" data-delete-session="${s.id}" type="button">Supprimer</button>
      </li>`;
    })
    .join("");

  ui.sessionsList.querySelectorAll("[data-delete-session]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const sessionId = btn.dataset.deleteSession;
      const session = state.sessions.find(s => s.id === sessionId);
      await deleteDoc(doc(db, "sessions", sessionId));
      // Décrémenter le quota de répartition
      if (session) {
        await decrementTeacherLevelQuota(session.teacherId, session.classId);
      }
    });
  });
}

async function saveAbsenceRecord() {
  if (!ui.absenceTeacherSelect || !ui.absenceStartDate || !ui.absenceEndDate || !ui.absenceHint) return;
  const teacherId = String(ui.absenceTeacherSelect.value || "").trim();
  const startDate = String(ui.absenceStartDate.value || "").trim();
  const endDate = String(ui.absenceEndDate.value || "").trim();
  const reason = String(ui.absenceReason?.value || "").trim();

  if (!teacherId || !startDate || !endDate) {
    ui.absenceHint.textContent = "Renseignez le professeur et la période d'absence.";
    return;
  }
  if (startDate > endDate) {
    ui.absenceHint.textContent = "La date de fin doit être postérieure ou égale à la date de début.";
    return;
  }

  try {
    await addDoc(collection(db, "absences"), {
      schoolYearId: getActiveSchoolYearId(),
      teacherId,
      startDate,
      endDate,
      reason: reason || null,
      status: "ACTIVE",
      createdAt: serverTimestamp(),
    });
    ui.absenceHint.textContent = "Absence enregistrée.";
    if (ui.absenceReason) ui.absenceReason.value = "";
  } catch (error) {
    ui.absenceHint.textContent = `Erreur absence: ${error?.message || "enregistrement impossible."}`;
  }
}

async function deleteAbsenceRecord(absenceId) {
  if (!absenceId) return;
  try {
    const linked = state.replacements.filter((r) => r.absenceId === absenceId);
    await Promise.all(linked.map((r) => deleteDoc(doc(db, "replacements", r.id))));
    await deleteDoc(doc(db, "absences", absenceId));
    ui.absenceHint.textContent = "Absence supprimée.";
  } catch (error) {
    ui.absenceHint.textContent = `Erreur suppression absence: ${error?.message || "suppression impossible."}`;
  }
}

async function applyReplacement(absence, session, toTeacherId) {
  if (!absence || !session || !toTeacherId || !ui.absenceHint) return;
  const existing = state.replacements.find((r) => r.absenceId === absence.id && r.sessionId === session.id);
  const payload = {
    absenceId: absence.id,
    sessionId: session.id,
    fromTeacherId: absence.teacherId,
    toTeacherId,
    startDate: absence.startDate,
    endDate: absence.endDate,
    status: "PLANNED",
    updatedAt: serverTimestamp(),
  };
  try {
    if (existing) {
      await updateDoc(doc(db, "replacements", existing.id), payload);
    } else {
      await addDoc(collection(db, "replacements"), {
        schoolYearId: getActiveSchoolYearId(),
        ...payload,
        createdAt: serverTimestamp(),
      });
    }
    const teacher = state.teachers.find((t) => t.id === toTeacherId);
    ui.absenceHint.textContent = `Remplaçant planifié: ${teacher?.name || "Professeur"}.`;
  } catch (error) {
    ui.absenceHint.textContent = `Erreur remplacement: ${error?.message || "enregistrement impossible."}`;
  }
}

async function deleteReplacementRecord(replacementId) {
  if (!replacementId || !ui.absenceHint) return;
  try {
    await deleteDoc(doc(db, "replacements", replacementId));
    ui.absenceHint.textContent = "Remplacement supprimé.";
  } catch (error) {
    ui.absenceHint.textContent = `Erreur suppression remplacement: ${error?.message || "suppression impossible."}`;
  }
}

async function reviewReplacementOffer(offerId, decision) {
  if (!ui.absenceHint) return;
  const offer = state.replacementOffers.find((o) => o.id === offerId);
  if (!offer) return;
  const nextStatus = decision === "ACCEPT" ? "ACCEPTED" : "REJECTED";
  try {
    if (nextStatus === "ACCEPTED") {
      const absence = state.absences.find((a) => a.id === offer.absenceId);
      const session = state.sessions.find((s) => s.id === offer.sessionId);
      if (!absence || !session) {
        ui.absenceHint.textContent = "Absence ou créneau introuvable.";
        return;
      }
      await applyReplacement(absence, session, offer.candidateTeacherId);
      const related = state.replacementOffers.filter(
        (o) => o.absenceId === offer.absenceId && o.sessionId === offer.sessionId
      );
      await Promise.all(
        related.map((o) =>
          updateDoc(doc(db, "replacementOffers", o.id), {
            status: o.id === offerId ? "ACCEPTED" : "REJECTED",
            updatedAt: serverTimestamp(),
          })
        )
      );
      ui.absenceHint.textContent = "Candidature acceptée et remplacement planifié.";
      return;
    }
    await updateDoc(doc(db, "replacementOffers", offerId), {
      status: "REJECTED",
      updatedAt: serverTimestamp(),
    });
    ui.absenceHint.textContent = "Candidature rejetée.";
  } catch (error) {
    ui.absenceHint.textContent = `Erreur décision candidature: ${error?.message || "mise à jour impossible."}`;
  }
}

function getReplacementSelectionForAbsence(absenceId) {
  const key = String(absenceId || "");
  if (!key) return {};
  if (!state.replacementSelectionByAbsence[key]) state.replacementSelectionByAbsence[key] = {};
  return state.replacementSelectionByAbsence[key];
}

function pruneReplacementSelection(absenceId, pendingOffers) {
  const selection = getReplacementSelectionForAbsence(absenceId);
  const validKeys = new Set(
    pendingOffers.map((entry) => `${entry.session.id}|${entry.offer.id}`)
  );
  Object.entries(selection).forEach(([sessionId, offerId]) => {
    if (!validKeys.has(`${sessionId}|${offerId}`)) {
      delete selection[sessionId];
    }
  });
}

function pruneAllReplacementSelections(pendingOffers) {
  const valid = new Set(
    pendingOffers.map((entry) => `${entry.offer.absenceId}|${entry.session.id}|${entry.offer.id}`)
  );
  Object.entries(state.replacementSelectionByAbsence || {}).forEach(([absenceId, selection]) => {
    Object.entries(selection || {}).forEach(([sessionId, offerId]) => {
      if (!valid.has(`${absenceId}|${sessionId}|${offerId}`)) {
        delete selection[sessionId];
      }
    });
    if (!Object.keys(selection || {}).length) delete state.replacementSelectionByAbsence[absenceId];
  });
}

function formatIsoDateFr(value) {
  if (!value) return "";
  const d = new Date(String(value));
  if (Number.isNaN(d.getTime())) return String(value);
  return d.toLocaleDateString("fr-FR");
}

function datesOverlap(startA, endA, startB, endB) {
  if (!startA || !endA || !startB || !endB) return false;
  return !(endA < startB || endB < startA);
}

function getSessionDateIsoForWeek(session, weekStart) {
  const dayIndex = DAYS.indexOf(String(session?.day || ""));
  if (dayIndex < 0) return "";
  return toIsoDate(addDays(weekStart, dayIndex));
}

function isSessionAbsentForWeek(session, weekStart) {
  const sessionDateIso = getSessionDateIsoForWeek(session, weekStart);
  if (!sessionDateIso) return null;
  return (
    state.absences.find(
      (a) =>
        a.teacherId === session.teacherId &&
        String(a.startDate || "") <= sessionDateIso &&
        String(a.endDate || "") >= sessionDateIso
    ) || null
  );
}

function isReplacementActive(replacement) {
  const status = String(replacement?.status || "PLANNED").toUpperCase();
  return status === "PLANNED" || status === "ACTIVE" || status === "ACCEPTED";
}

function doesReplacementApplyForWeek(replacement, session, weekStart, weekType) {
  if (!replacement || !session || !weekStart) return false;
  if (!isReplacementActive(replacement)) return false;
  if (!isSessionVisibleForWeek(session, weekType)) return false;
  const sessionDateIso = getSessionDateIsoForWeek(session, weekStart);
  if (!sessionDateIso) return false;
  const startDate = String(replacement.startDate || "");
  const endDate = String(replacement.endDate || "");
  if (startDate && sessionDateIso < startDate) return false;
  if (endDate && sessionDateIso > endDate) return false;
  if (isNoSchoolDate(sessionDateIso)) return false;
  return true;
}

function getReplacementEntriesForWeek(week, teacherId = "") {
  if (!week?.weekStart) return [];
  return state.replacements
    .filter((replacement) => !teacherId || replacement.toTeacherId === teacherId)
    .map((replacement) => {
      const session = state.sessions.find((s) => s.id === replacement.sessionId);
      if (!session) return null;
      if (!doesReplacementApplyForWeek(replacement, session, week.weekStart, week.weekType)) return null;
      const fallbackAbsence = state.absences.find((a) => a.id === replacement.absenceId);
      const fromTeacherId = replacement.fromTeacherId || fallbackAbsence?.teacherId || "";
      const fromTeacher = state.teachers.find((t) => t.id === fromTeacherId);
      const toTeacher = state.teachers.find((t) => t.id === replacement.toTeacherId);
      return { replacement, session, fromTeacher, toTeacher };
    })
    .filter(Boolean);
}

function getWeekTypeForMonday(mondayDate, referenceMonday = null) {
  const weekIso = toIsoDate(mondayDate);
  const configuredPattern = getSchoolYearWeekPatternMap();
  const configured = String(configuredPattern?.[weekIso] || "").trim();
  if (configured === "A" || configured === "B") return configured;
  const schoolBounds = getSchoolYearBounds();
  const baseMonday = referenceMonday || schoolBounds?.startMonday || getMonday(new Date());
  const weekMs = 7 * 24 * 3600 * 1000;
  const rawIndex = Math.floor((mondayDate.getTime() - baseMonday.getTime()) / weekMs);
  const parity = ((rawIndex % 2) + 2) % 2;
  return parity === 0 ? "A" : "B";
}

function isNoSchoolDate(dateIso) {
  const vacations = Array.isArray(state.schoolYearConfig?.vacations) ? state.schoolYearConfig.vacations : [];
  const holidays = Array.isArray(state.schoolYearConfig?.holidays) ? state.schoolYearConfig.holidays : [];
  const inVacation = vacations.some((v) => v?.startDate && v?.endDate && v.startDate <= dateIso && v.endDate >= dateIso);
  const isHoliday = holidays.some((h) => h?.date && h.date === dateIso);
  return inVacation || isHoliday;
}

function isVacationDate(dateIso) {
  const vacations = Array.isArray(state.schoolYearConfig?.vacations) ? state.schoolYearConfig.vacations : [];
  return vacations.some((v) => v?.startDate && v?.endDate && v.startDate <= dateIso && v.endDate >= dateIso);
}

function getVacationDaySetForWeek(weekStart) {
  const set = new Set();
  if (!weekStart) return set;
  DAYS.forEach((day, index) => {
    const dateIso = toIsoDate(addDays(weekStart, index));
    if (isVacationDate(dateIso)) set.add(day);
  });
  return set;
}

function getImpactedOccurrencesForAbsence(absence, session) {
  if (!absence || !session) return [];
  const start = parseIsoDate(absence.startDate);
  const end = parseIsoDate(absence.endDate);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return [];
  const dayIndex = DAYS.indexOf(String(session.day || ""));
  if (dayIndex < 0) return [];

  const bounds = getSchoolYearBounds();
  const rangeStart = bounds ? new Date(Math.max(start.getTime(), bounds.start.getTime())) : start;
  const rangeEnd = bounds ? new Date(Math.min(end.getTime(), bounds.end.getTime())) : end;
  if (rangeStart > rangeEnd) return [];

  const occurrences = [];
  let currentMonday = getMonday(rangeStart);
  const endMonday = getMonday(rangeEnd);
  while (currentMonday <= endMonday) {
    const sessionDate = addDays(currentMonday, dayIndex);
    if (sessionDate >= rangeStart && sessionDate <= rangeEnd) {
      const dateIso = toIsoDate(sessionDate);
      const weekType = getWeekTypeForMonday(currentMonday);
      if (!isNoSchoolDate(dateIso) && isSessionVisibleForWeek(session, weekType)) {
        occurrences.push({
          dateIso,
          weekType,
        });
      }
    }
    currentMonday = addDays(currentMonday, 7);
  }
  return occurrences;
}

function evaluateReplacementCandidate(absence, session, teacher) {
  const slots = getCoveredSlots(session.day, session.start, Number(session.duration || 0));
  const reasons = [];

  const teacherAbsent = state.absences.some(
    (a) =>
      a.id !== absence.id &&
      a.teacherId === teacher.id &&
      datesOverlap(String(a.startDate || ""), String(a.endDate || ""), String(absence.startDate || ""), String(absence.endDate || ""))
  );
  if (teacherAbsent) reasons.push("Professeur absent sur la période");

  const unavailable = slots.some((slotKey) => (teacher.unavailable || []).includes(slotKey));
  if (unavailable) reasons.push("Indisponible sur ce créneau");

  const conflict = state.sessions.some(
    (s) => s.id !== session.id && s.teacherId === teacher.id && sessionsConflict(session, s)
  );
  if (conflict) reasons.push("Déjà en cours sur ce créneau");

  if (reasons.length) {
    return { teacher, compatible: false, score: 0, reason: reasons.join(" · ") };
  }

  const hoursByTeacher = computeTeacherHours();
  const maxHours = Number(teacher.maxHours || 0);
  const projectedHours = (hoursByTeacher.get(teacher.id) || 0) + weeklyEquivalentHours(session);
  const ratio = maxHours > 0 ? projectedHours / maxHours : 0;
  const preferredCount = slots.filter((slotKey) => {
    const [dayValue, slotValue] = String(slotKey).split("|");
    return hasDesiderataSlot(teacher.id, dayValue, slotValue);
  }).length;
  const teachesClassAlready = state.sessions.some((s) => s.teacherId === teacher.id && s.classId === session.classId);

  let score = 68;
  if (ratio > 1) score -= 28;
  else if (ratio > 0.95) score -= 15;
  else if (ratio < 0.8) score += 10;
  if (preferredCount === slots.length && slots.length > 0) score += 12;
  else if (preferredCount > 0) score += 6;
  if (teachesClassAlready) score += 8;
  score = Math.max(0, Math.min(100, Math.round(score)));

  return {
    teacher,
    compatible: true,
    score,
    reason: `Charge projetée ${formatHours(projectedHours)}/${formatHours(maxHours)}h`,
  };
}

function getReplacementCandidates(absence, session) {
  if (!absence || !session) return [];
  return state.teachers
    .filter((t) => t.id !== absence.teacherId)
    .map((teacher) => evaluateReplacementCandidate(absence, session, teacher))
    .filter((x) => x.compatible)
    .sort((a, b) => b.score - a.score || String(a.teacher.name || "").localeCompare(String(b.teacher.name || ""), "fr"))
    .slice(0, 3);
}

function renderAbsencePanel() {
  if (!ui.absenceListContainer || !ui.absenceDetailsContainer || !ui.replacementPlansContainer || !ui.absenceTeacherSelect) return;

  if (!ui.absenceStartDate?.value) {
    const today = new Date().toISOString().slice(0, 10);
    ui.absenceStartDate.value = today;
    if (ui.absenceEndDate) ui.absenceEndDate.value = today;
  }

  if (!state.absences.length) {
    state.replacementSelectionByAbsence = {};
    ui.absenceListContainer.innerHTML = `<p class="summary-box">Aucune absence enregistrée.</p>`;
    ui.absenceDetailsContainer.innerHTML = `<p class="summary-box">Déclarez une absence pour proposer des remplaçants.</p>`;
    ui.replacementPlansContainer.innerHTML = `<p class="summary-box">Aucun remplacement planifié.</p>`;
    renderReplacementMailPreview();
    if (ui.absenceOffersContainer) ui.absenceOffersContainer.innerHTML = `<p class="summary-box">Aucune demande de remplacement.</p>`;
    return;
  }

  const selected = state.absences.find((a) => a.id === state.selectedAbsenceId) || state.absences[0];
  if (selected && state.selectedAbsenceId !== selected.id) state.selectedAbsenceId = selected.id;

  const rows = state.absences
    .map((a) => {
      const teacher = state.teachers.find((t) => t.id === a.teacherId);
      const activeClass = a.id === state.selectedAbsenceId ? "selected-row" : "";
      return `<tr class="${activeClass}">
        <td>${escapeHtml(teacher?.name || "Professeur inconnu")}</td>
        <td>${escapeHtml(formatIsoDateFr(a.startDate))}</td>
        <td>${escapeHtml(formatIsoDateFr(a.endDate))}</td>
        <td>${escapeHtml(String(a.reason || "—"))}</td>
        <td>
          <button type="button" class="secondary-btn" data-select-absence="${escapeHtml(a.id)}">Voir</button>
          <button type="button" class="delete-btn" data-delete-absence="${escapeHtml(a.id)}">Suppr.</button>
        </td>
      </tr>`;
    })
    .join("");

  ui.absenceListContainer.innerHTML = `
    <table class="absence-table">
      <thead>
        <tr><th>Professeur</th><th>Début</th><th>Fin</th><th>Motif</th><th>Action</th></tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  `;

  ui.absenceDetailsContainer.innerHTML = "";

  const replacementRows = state.replacements
    .filter((r) => r.absenceId === selected.id)
    .map((r) => {
      const session = state.sessions.find((s) => s.id === r.sessionId);
      const toTeacher = state.teachers.find((t) => t.id === r.toTeacherId);
      const fromTeacher = state.teachers.find((t) => t.id === r.fromTeacherId);
      return `<tr>
        <td>${escapeHtml(fromTeacher?.name || "—")}</td>
        <td>${escapeHtml(toTeacher?.name || "—")}</td>
        <td>${session ? `${escapeHtml(session.day)} ${escapeHtml(session.start)}` : "Créneau supprimé"}</td>
        <td>${escapeHtml(formatIsoDateFr(r.startDate))} → ${escapeHtml(formatIsoDateFr(r.endDate))}</td>
        <td><button type="button" class="delete-btn" data-delete-replacement="${escapeHtml(r.id)}">Suppr.</button></td>
      </tr>`;
    })
    .join("");
  ui.replacementPlansContainer.innerHTML = `
    <h4>Remplacements planifiés</h4>
    <table class="absence-table">
      <thead>
        <tr><th>Absent</th><th>Remplaçant</th><th>Créneau</th><th>Période</th><th>Action</th></tr>
      </thead>
      <tbody>${replacementRows || `<tr><td colspan="5">Aucun remplacement planifié pour cette absence.</td></tr>`}</tbody>
    </table>
  `;
  renderReplacementMailPreview();

  const pendingOffers = state.replacementOffers
    .filter((o) => String(o.status || "").toUpperCase() === "PENDING")
    .map((offer) => {
      const absence = state.absences.find((a) => a.id === offer.absenceId);
      const session = state.sessions.find((s) => s.id === offer.sessionId);
      const teacher = state.teachers.find((t) => t.id === offer.candidateTeacherId);
      if (!absence || !session || !teacher) return null;
      const scoreInfo = evaluateReplacementCandidate(absence, session, teacher);
      const absentTeacher = state.teachers.find((t) => t.id === absence.teacherId);
      return { offer, absence, session, teacher, scoreInfo, absentTeacher };
    })
    .filter(Boolean);

  if (ui.absenceOffersContainer) {
    if (!pendingOffers.length) {
      state.replacementSelectionByAbsence = {};
      ui.absenceOffersContainer.innerHTML = `
        <h4>Demandes de remplacement (à examiner)</h4>
        <p class="summary-box">Aucune demande en attente.</p>
      `;
    } else {
      pruneAllReplacementSelections(pendingOffers);
      const selectedOffers = pendingOffers.filter((entry) => {
        const selection = getReplacementSelectionForAbsence(entry.offer.absenceId);
        return selection[entry.session.id] === entry.offer.id;
      });
      const selectedHoursByTeacher = new Map();
      selectedOffers.forEach((entry) => {
        const occurrences = getImpactedOccurrencesForAbsence(entry.absence, entry.session);
        const extra = Number(entry.session.duration || 0) * occurrences.length;
        selectedHoursByTeacher.set(entry.teacher.id, (selectedHoursByTeacher.get(entry.teacher.id) || 0) + extra);
      });
      const counterRows = Array.from(selectedHoursByTeacher.entries())
        .map(([teacherId, extraHours]) => {
          const teacher = state.teachers.find((t) => t.id === teacherId);
          const teacherName = teacher?.name || "Professeur";
          return {
            teacherName,
            html: `<li>
            <strong>${escapeHtml(teacher?.name || "Professeur")}</strong>
            <span>+${formatHours(extraHours)}h</span>
            <small>sur la période d'absence</small>
          </li>`,
          };
        })
        .sort((a, b) => String(a.teacherName).localeCompare(String(b.teacherName), "fr"))
        .map((x) => x.html);

      const sessionSummary = Array.from(
        new Set(
          pendingOffers.map(
            (x) =>
              `${x.session.day} ${x.session.start} - ${getClassLabelById(x.session.classId, true)} (abs: ${x.absentTeacher?.name || "Prof"})`
          )
        )
      )
        .map((label) => `<li>${escapeHtml(label)}</li>`)
        .join("");

      const slotMap = new Map();
      for (const day of DAYS) {
        for (const band of SLOT_BANDS) {
          slotMap.set(toSlotKey(day, band.start), []);
        }
      }

      const candidateIds = Array.from(new Set(pendingOffers.map((x) => x.teacher.id)));
      const candidateSessions = state.sessions.filter((s) => candidateIds.includes(s.teacherId));
      candidateSessions.forEach((s) => {
        const teacher = state.teachers.find((t) => t.id === s.teacherId);
        const segments = getSessionBandSegments(s);
        const cadenceTag = normalizeCadence(s.cadence) === "BIWEEKLY" ? ` (${normalizeWeekType(s.weekType)})` : "";
        const text = `${getTeacherDisplayLabel(teacher)} - ${getClassLabelById(s.classId)}${cadenceTag}`;
        segments.forEach((seg) => {
          const segClass = getSessionSegmentClassName(seg);
          slotMap
            .get(toSlotKey(seg.day, seg.bandStart))
            ?.push(`<div class="slot-block${segClass}" style="${escapeHtml(getTeacherBlockStyle(s.teacherId))}">${seg.showContent === false ? "" : escapeHtml(text)}</div>`);
        });
      });

      pendingOffers.forEach((entry) => {
        const session = entry.session;
        const segments = getSessionBandSegments(session);
        const classLabel = getClassLabelById(session.classId, true);
        const scoreLabel = entry.scoreInfo.compatible ? `Score ${entry.scoreInfo.score}/100` : entry.scoreInfo.reason;
        const selection = getReplacementSelectionForAbsence(entry.offer.absenceId);
        const isSelected = selection[session.id] === entry.offer.id;
        segments.forEach((seg) => {
          const segClass = getSessionSegmentClassName(seg);
          const disabledAttr = entry.scoreInfo.compatible ? "" : "disabled";
          const disabledClass = entry.scoreInfo.compatible ? "" : " disabled";
          slotMap.get(toSlotKey(seg.day, seg.bandStart))?.push(`
            <div class="replacement-target-block${segClass}">
              ${seg.showContent === false ? "" : `<strong>${escapeHtml(entry.teacher.name)}</strong>
              <span>${escapeHtml(classLabel)}</span>
              <small>${escapeHtml(scoreLabel)}</small>
              <small>Absent: ${escapeHtml(entry.absentTeacher?.name || "Professeur")}</small>
              <div class="replacement-target-actions">
                <button type="button" ${disabledAttr} class="replacement-select-btn${disabledClass}${isSelected ? " selected" : ""}" data-offer-select="${escapeHtml(entry.offer.id)}" data-session-id="${escapeHtml(session.id)}" data-absence-id="${escapeHtml(entry.offer.absenceId)}">${isSelected ? "Sélectionné" : "Sélectionner"}</button>
                <button type="button" class="secondary-btn replacement-reject-btn" data-offer-reject="${escapeHtml(entry.offer.id)}">Refuser</button>
              </div>`}
            </div>
          `);
        });
      });

      const head = `<tr><th>Heure</th>${DAYS.map((d) => `<th>${d}</th>`).join("")}</tr>`;
      const rows = SLOT_BANDS.map((band) => {
        const cells = DAYS.map((day) => `<td class="slot">${(slotMap.get(toSlotKey(day, band.start)) || []).join("")}</td>`).join("");
        return `<tr><th>${band.label}</th>${cells}</tr>`;
      }).join("");

      ui.absenceOffersContainer.innerHTML = `
        <h4>Demandes de remplacement (à examiner)</h4>
        <p class="summary-box">Toutes absences confondues.</p>
        <ul class="replacement-summary-list">${sessionSummary}</ul>
        <div class="replacement-load-panel">
          <h5>Compteur heures supplémentaires (sélection)</h5>
          ${
            counterRows.length
              ? `<ul class="replacement-load-list">${counterRows.join("")}</ul>`
              : `<p class="summary-box">Aucun remplaçant sélectionné pour le moment.</p>`
          }
        </div>
        <div class="table-wrap replacement-compare-table-wrap">
          <table class="replacement-compare-table replacement-superposed-table">${head}${rows}</table>
        </div>
        <div class="replacement-selection-footer">
          <button type="button" class="replacement-finalize-btn" data-validate-selected="1" ${selectedOffers.length ? "" : "disabled"}>
            Valider les remplacements sélectionnés (${selectedOffers.length})
          </button>
        </div>
      `;
    }
  }

  ui.absenceListContainer.querySelectorAll("[data-select-absence]").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.selectedAbsenceId = String(btn.dataset.selectAbsence || "");
      renderAbsencePanel();
    });
  });
  ui.absenceListContainer.querySelectorAll("[data-delete-absence]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      await deleteAbsenceRecord(String(btn.dataset.deleteAbsence || ""));
    });
  });
  ui.absenceDetailsContainer.querySelectorAll("[data-apply-replacement]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const absenceId = String(btn.dataset.absenceId || "");
      const sessionId = String(btn.dataset.sessionId || "");
      const teacherId = String(btn.dataset.teacherId || "");
      const absence = state.absences.find((a) => a.id === absenceId);
      const session = state.sessions.find((s) => s.id === sessionId);
      await applyReplacement(absence, session, teacherId);
    });
  });
  ui.replacementPlansContainer.querySelectorAll("[data-delete-replacement]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      await deleteReplacementRecord(String(btn.dataset.deleteReplacement || ""));
    });
  });
  if (ui.absenceOffersContainer) {
    ui.absenceOffersContainer.querySelectorAll("[data-offer-select]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const absenceId = String(btn.dataset.absenceId || "");
        const sessionId = String(btn.dataset.sessionId || "");
        const offerId = String(btn.dataset.offerSelect || "");
        if (!absenceId || !sessionId || !offerId) return;
        const selection = getReplacementSelectionForAbsence(absenceId);
        if (selection[sessionId] === offerId) {
          delete selection[sessionId];
        } else {
          selection[sessionId] = offerId;
        }
        renderAbsencePanel();
      });
    });
    ui.absenceOffersContainer.querySelectorAll("[data-offer-reject]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        await reviewReplacementOffer(String(btn.dataset.offerReject || ""), "REJECT");
      });
    });
    ui.absenceOffersContainer.querySelectorAll("[data-validate-selected]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const toValidate = pendingOffers.filter((entry) => {
          const selection = getReplacementSelectionForAbsence(entry.offer.absenceId);
          return selection[entry.session.id] === entry.offer.id;
        });
        if (!toValidate.length) {
          if (ui.absenceHint) ui.absenceHint.textContent = "Sélectionnez au moins un remplaçant.";
          return;
        }
        let done = 0;
        for (const item of toValidate) {
          await reviewReplacementOffer(item.offer.id, "ACCEPT");
          const selection = getReplacementSelectionForAbsence(item.offer.absenceId);
          delete selection[item.session.id];
          done += 1;
        }
        if (ui.absenceHint) ui.absenceHint.textContent = `${done} remplacement(s) validé(s).`;
        renderAbsencePanel();
      });
    });
  }
}

function buildReplacementEmailPayload() {
  const to = String(ui.replacementEmailTo?.value || "").trim();
  const replacements = [...state.replacements].sort((a, b) => {
    const startCmp = String(a.startDate || "").localeCompare(String(b.startDate || ""), "fr");
    if (startCmp !== 0) return startCmp;
    const dayA = DAYS.indexOf(String(state.sessions.find((s) => s.id === a.sessionId)?.day || ""));
    const dayB = DAYS.indexOf(String(state.sessions.find((s) => s.id === b.sessionId)?.day || ""));
    if (dayA !== dayB) return dayA - dayB;
    return String(state.sessions.find((s) => s.id === a.sessionId)?.start || "").localeCompare(
      String(state.sessions.find((s) => s.id === b.sessionId)?.start || ""),
      "fr"
    );
  });
  const rows = replacements
    .map((r) => {
      const session = state.sessions.find((s) => s.id === r.sessionId);
      const toTeacher = state.teachers.find((t) => t.id === r.toTeacherId);
      const fromTeacher = state.teachers.find((t) => t.id === r.fromTeacherId);
      if (!session || !toTeacher || !fromTeacher) return null;
      const classLabel = getClassLabelById(session.classId, true);
      const dateTimeLabel = formatReplacementMailDateTime(r.startDate, session.start, session.day);
      return {
        fromTeacher: fromTeacher.name || "Professeur absent",
        toTeacher: toTeacher.name || "Professeur remplaçant",
        dateTimeLabel,
        classLabel,
        color: toTeacher.color || "#0b7285",
      };
    })
    .filter(Boolean);

  const subject = `Remplacements EPS validés (${rows.length})`;
  const textLines = ["Bonjour Mme La Rosa,", "", "Voici les remplacements validés :", ""];
  rows.forEach((row, index) => {
    textLines.push(`${index + 1}. ${row.dateTimeLabel} | ${row.classLabel} | ${row.fromTeacher} -> ${row.toTeacher}`);
  });
  textLines.push("", "Bien cordialement.");

  const htmlRows = rows
    .map(
      (row) => `<tr>
<td style="padding:8px;border:1px solid #d9e2ef;">${escapeHtml(row.dateTimeLabel)}</td>
<td style="padding:8px;border:1px solid #d9e2ef;">${escapeHtml(row.classLabel)}</td>
<td style="padding:8px;border:1px solid #d9e2ef;background:#fff5f5;">${escapeHtml(row.fromTeacher)}</td>
<td style="padding:8px;border:1px solid #d9e2ef;background:${escapeHtml(row.color)}22;"><strong style="color:${escapeHtml(row.color)};">${escapeHtml(row.toTeacher)}</strong></td>
</tr>`
    )
    .join("");
  const html = `<div style="font-family:Arial,sans-serif;color:#1a2a3a;">
<p>Bonjour Mme La Rosa,</p>
<p>Voici les remplacements validés :</p>
<table style="border-collapse:collapse;width:100%;max-width:980px;font-size:13px;">
<thead>
<tr style="background:#eef4fb;">
<th style="padding:8px;border:1px solid #d9e2ef;text-align:left;">Date</th>
<th style="padding:8px;border:1px solid #d9e2ef;text-align:left;">Classe</th>
<th style="padding:8px;border:1px solid #d9e2ef;text-align:left;">Prof absent</th>
<th style="padding:8px;border:1px solid #d9e2ef;text-align:left;">Remplaçant</th>
</tr>
</thead>
<tbody>${htmlRows}</tbody>
</table>
<p style="margin-top:12px;">Bien cordialement.</p>
</div>`;

  return { to, subject, text: textLines.join("\n"), html, rowsCount: rows.length };
}

function formatReplacementMailDateTime(isoDate, startTime, fallbackDay) {
  const dateStr = String(isoDate || "").trim();
  const timeStr = String(startTime || "").trim();
  const timeLabel = timeStr ? timeStr.replace(":", "h") : "";
  if (!dateStr) {
    return `${String(fallbackDay || "").toLowerCase()} ${timeLabel}`.trim();
  }
  const d = new Date(`${dateStr}T12:00:00`);
  if (Number.isNaN(d.getTime())) {
    return `${String(fallbackDay || "").toLowerCase()} ${timeLabel}`.trim();
  }
  const dateLabel = d.toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "long" });
  return `${dateLabel} ${timeLabel}`.trim();
}

function renderReplacementMailPreview() {
  if (!ui.replacementMailPreview) return;
  const payload = buildReplacementEmailPayload();
  if (!payload.rowsCount) {
    ui.replacementMailPreview.textContent = "Aucun remplacement validé.";
    if (ui.replacementMailHtmlPreview) ui.replacementMailHtmlPreview.innerHTML = "";
    return;
  }
  ui.replacementMailPreview.innerHTML = `<span class="hours-ok">${payload.rowsCount} remplacement(s) prêt(s) à envoyer à Mme La Rosa.</span>`;
  if (ui.replacementMailHtmlPreview) ui.replacementMailHtmlPreview.innerHTML = payload.html;
}

function composeReplacementEmail() {
  const payload = buildReplacementEmailPayload();
  if (!payload.rowsCount) {
    ui.sessionError.textContent = "Aucun remplacement validé à envoyer.";
    return;
  }
  if (!payload.to) {
    ui.sessionError.textContent = "Renseignez l'email de Mme La Rosa.";
    return;
  }
  const mailto = `mailto:${encodeURIComponent(payload.to)}?subject=${encodeURIComponent(payload.subject)}&body=${encodeURIComponent(payload.text)}`;
  ui.sessionError.textContent = "Email ouvert. Copiez le tableau HTML pour garder la mise en forme.";
  window.location.href = mailto;
}

async function copyReplacementEmailHtml() {
  const payload = buildReplacementEmailPayload();
  if (!payload.rowsCount) {
    ui.sessionError.textContent = "Aucun remplacement validé à copier.";
    return;
  }
  try {
    if (navigator.clipboard && window.ClipboardItem && window.isSecureContext) {
      const item = new ClipboardItem({
        "text/html": new Blob([payload.html], { type: "text/html" }),
        "text/plain": new Blob([payload.text], { type: "text/plain" }),
      });
      await navigator.clipboard.write([item]);
      ui.sessionError.textContent = "Contenu email copié (HTML + texte).";
      return;
    }
  } catch (_error) {}

  try {
    const helper = document.createElement("div");
    const sourceHtml = ui.replacementMailHtmlPreview?.innerHTML?.trim() ? ui.replacementMailHtmlPreview.innerHTML : payload.html;
    helper.innerHTML = sourceHtml;
    helper.setAttribute("contenteditable", "true");
    helper.style.position = "fixed";
    helper.style.left = "-9999px";
    helper.style.top = "0";
    helper.style.opacity = "0";
    document.body.appendChild(helper);

    const range = document.createRange();
    range.selectNodeContents(helper);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);

    const ok = document.execCommand("copy");
    selection?.removeAllRanges();
    document.body.removeChild(helper);

    if (ok) {
      ui.sessionError.textContent = "Tableau HTML copié.";
      return;
    }
  } catch (_error) {}

  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(payload.text);
      ui.sessionError.textContent = "Copie HTML indisponible ici: texte copié.";
      return;
    }
  } catch (_error) {}

  ui.sessionError.textContent = "Copie impossible dans ce contexte (ouvrez en http://localhost pour activer le presse-papiers).";
}

function getSchoolYearVacations() {
  return Array.isArray(state.schoolYearConfig?.vacations) ? state.schoolYearConfig.vacations : [];
}

function getSchoolYearHolidays() {
  return Array.isArray(state.schoolYearConfig?.holidays) ? state.schoolYearConfig.holidays : [];
}

function getSchoolYearWeekPatternMap() {
  const raw = state.schoolYearConfig?.weekPattern;
  if (!raw || typeof raw !== "object") return {};
  return raw;
}

function getSchoolYearWeeksBetween(startIso, endIso) {
  const start = parseIsoDate(startIso);
  const end = parseIsoDate(endIso);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || start > end) return [];
  const monday = getMonday(start);
  const endMonday = getMonday(end);
  const weeks = [];
  let cursor = new Date(monday);
  let guard = 0;
  while (cursor <= endMonday && guard < 200) {
    weeks.push(new Date(cursor));
    cursor = addDays(cursor, 7);
    guard += 1;
  }
  return weeks;
}

function renderSchoolYearPanel() {
  if (
    !ui.schoolYearStartDate ||
    !ui.schoolYearEndDate ||
    !ui.schoolYearVacationsContainer ||
    !ui.schoolYearHolidaysContainer ||
    !ui.schoolYearHint
  ) {
    return;
  }

  ui.schoolYearStartDate.value = String(state.schoolYearConfig?.startDate || "");
  ui.schoolYearEndDate.value = String(state.schoolYearConfig?.endDate || "");

  const vacations = getSchoolYearVacations();
  const holidays = getSchoolYearHolidays();

  ui.schoolYearVacationsContainer.innerHTML =
    vacations
      .map(
        (v, idx) => `
      <div class="schoolyear-row">
        <input type="text" data-schoolyear-vacation-label="${idx}" placeholder="Nom (ex: Toussaint)" value="${escapeHtml(String(v?.label || ""))}" />
        <input type="date" data-schoolyear-vacation-start="${idx}" value="${escapeHtml(String(v?.startDate || ""))}" />
        <input type="date" data-schoolyear-vacation-end="${idx}" value="${escapeHtml(String(v?.endDate || ""))}" />
        <button type="button" class="delete-btn" data-schoolyear-remove-vacation="${idx}">Suppr.</button>
      </div>`
      )
      .join("") || `<p class="summary-box">Aucune période de vacances.</p>`;

  ui.schoolYearHolidaysContainer.innerHTML =
    holidays
      .map(
        (h, idx) => `
      <div class="schoolyear-row">
        <input type="text" data-schoolyear-holiday-label="${idx}" placeholder="Nom (ex: Ascension)" value="${escapeHtml(String(h?.label || ""))}" />
        <input type="date" data-schoolyear-holiday-date="${idx}" value="${escapeHtml(String(h?.date || ""))}" />
        <button type="button" class="delete-btn" data-schoolyear-remove-holiday="${idx}">Suppr.</button>
      </div>`
      )
      .join("") || `<p class="summary-box">Aucun jour férié.</p>`;

  if (ui.schoolYearWeeksContainer) {
    const weeks = getSchoolYearWeeksBetween(
      String(state.schoolYearConfig?.startDate || ""),
      String(state.schoolYearConfig?.endDate || "")
    );
    const configuredPattern = getSchoolYearWeekPatternMap();
    if (!weeks.length) {
      ui.schoolYearWeeksContainer.innerHTML = `<p class="summary-box">Définissez d'abord les dates de début et de fin.</p>`;
    } else {
      const controls = `
        <div class="schoolyear-week-controls">
          <button type="button" class="secondary-btn" data-schoolyear-weeks-fill="A">Tout en A</button>
          <button type="button" class="secondary-btn" data-schoolyear-weeks-fill="B">Tout en B</button>
          <button type="button" class="secondary-btn" data-schoolyear-weeks-fill="ALT">Alterner A/B</button>
          <button type="button" class="secondary-btn" data-schoolyear-weeks-flip="1">Inverser A/B</button>
        </div>`;
      const rows = weeks
        .map((weekStart, idx) => {
          const weekIso = toIsoDate(weekStart);
          const fallback = idx % 2 === 0 ? "A" : "B";
          const value = normalizeWeekType(configuredPattern[weekIso] || fallback);
          const weekEnd = addDays(weekStart, 4);
          const weekNum = getIsoWeekNumber(weekStart);
          return `<tr>
            <td><span class="schoolyear-week-badge">S${weekNum}</span></td>
            <td>${escapeHtml(formatDateFrShort(weekStart))} au ${escapeHtml(formatDateFrShort(weekEnd))}</td>
            <td>
              <select class="schoolyear-week-select" data-schoolyear-week-type="${escapeHtml(weekIso)}">
                <option value="A"${value === "A" ? " selected" : ""}>A</option>
                <option value="B"${value === "B" ? " selected" : ""}>B</option>
              </select>
            </td>
          </tr>`;
        })
        .join("");
      ui.schoolYearWeeksContainer.innerHTML = `${controls}<table class="schoolyear-weeks-table">
        <thead><tr><th>#</th><th>Semaine</th><th>Type</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>`;
      const applyToAllWeekTypeSelects = (resolver) => {
        const selects = Array.from(ui.schoolYearWeeksContainer.querySelectorAll("[data-schoolyear-week-type]"));
        selects.forEach((sel, idx) => {
          sel.value = normalizeWeekType(resolver(idx, sel.value));
        });
      };
      ui.schoolYearWeeksContainer.querySelectorAll("[data-schoolyear-weeks-fill]").forEach((btn) => {
        btn.addEventListener("click", () => {
          const mode = String(btn.getAttribute("data-schoolyear-weeks-fill") || "");
          if (mode === "A" || mode === "B") {
            applyToAllWeekTypeSelects(() => mode);
            return;
          }
          applyToAllWeekTypeSelects((idx) => (idx % 2 === 0 ? "A" : "B"));
        });
      });
      ui.schoolYearWeeksContainer.querySelectorAll("[data-schoolyear-weeks-flip]").forEach((btn) => {
        btn.addEventListener("click", () => {
          applyToAllWeekTypeSelects((_idx, current) => (normalizeWeekType(current) === "A" ? "B" : "A"));
        });
      });
    }
  }
  if (ui.schoolYearTeachersContainer) {
    const activeYear = getActiveSchoolYearId();
    const rows = state.allTeachers
      .map((teacher) => {
        const checked = isTeacherActiveInYear(teacher, activeYear);
        return `<label class="check-row">
          <input type="checkbox" data-schoolyear-teacher="${escapeHtml(teacher.id)}" ${checked ? "checked" : ""} />
          <span>${escapeHtml(teacher.name)}${teacher.abbreviation ? ` (${escapeHtml(teacher.abbreviation)})` : ""}</span>
        </label>`;
      })
      .join("");
    ui.schoolYearTeachersContainer.innerHTML = rows || `<p class="summary-box">Aucun professeur enregistré.</p>`;
  }

  ui.schoolYearVacationsContainer.querySelectorAll("[data-schoolyear-remove-vacation]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const idx = Number(btn.dataset.schoolyearRemoveVacation);
      const vacationsNext = getSchoolYearVacations().filter((_, i) => i !== idx);
      state.schoolYearConfig = { ...state.schoolYearConfig, vacations: vacationsNext };
      renderSchoolYearPanel();
    });
  });

  ui.schoolYearHolidaysContainer.querySelectorAll("[data-schoolyear-remove-holiday]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const idx = Number(btn.dataset.schoolyearRemoveHoliday);
      const holidaysNext = getSchoolYearHolidays().filter((_, i) => i !== idx);
      state.schoolYearConfig = { ...state.schoolYearConfig, holidays: holidaysNext };
      renderSchoolYearPanel();
    });
  });

  if (!state.schoolYearConfig?.startDate || !state.schoolYearConfig?.endDate) {
    ui.schoolYearHint.textContent = "Renseignez les dates de l'année scolaire, puis ajoutez vacances et jours fériés.";
  }

  if (ui.desiderataConfigYearSelect) {
    const years = new Set([
      getAdminSchoolYearId(),
      getActiveSchoolYearId(),
      String(state.desiderataConfig?.yearId || ""),
    ]);
    Array.from(ui.schoolYearScopeSelect?.options || []).forEach((o) => years.add(String(o.value || "")));
    const opts = Array.from(years)
      .filter(Boolean)
      .sort((a, b) => a.localeCompare(b, "fr"))
      .map((y) => `<option value="${escapeHtml(y)}">${escapeHtml(y)}</option>`)
      .join("");
    ui.desiderataConfigYearSelect.innerHTML = opts;
    ui.desiderataConfigYearSelect.value = String(state.desiderataConfig?.yearId || getAdminSchoolYearId());
  }
  if (ui.desiderataConfigEnabled) {
    ui.desiderataConfigEnabled.value = state.desiderataConfig?.enabled ? "1" : "0";
  }

  // Mettre à jour la checkbox de publication
  if (ui.schoolYearIsPublishedCheck) {
    ui.schoolYearIsPublishedCheck.checked = Boolean(state.schoolYearConfig?.isPublished);
  }
}

function addSchoolYearVacationRow() {
  const vacations = getSchoolYearVacations();
  state.schoolYearConfig = {
    ...state.schoolYearConfig,
    vacations: [...vacations, { label: "", startDate: "", endDate: "" }],
  };
  renderSchoolYearPanel();
}

function addSchoolYearHolidayRow() {
  const holidays = getSchoolYearHolidays();
  state.schoolYearConfig = {
    ...state.schoolYearConfig,
    holidays: [...holidays, { label: "", date: "" }],
  };
  renderSchoolYearPanel();
}

function collectSchoolYearVacationsFromDom() {
  if (!ui.schoolYearVacationsContainer) return [];
  const rows = [];
  const labels = ui.schoolYearVacationsContainer.querySelectorAll("[data-schoolyear-vacation-label]");
  labels.forEach((el) => {
    const idx = String(el.dataset.schoolyearVacationLabel || "");
    const label = String(el.value || "").trim();
    const startDate = String(
      ui.schoolYearVacationsContainer.querySelector(`[data-schoolyear-vacation-start="${cssEscape(idx)}"]`)?.value || ""
    ).trim();
    const endDate = String(
      ui.schoolYearVacationsContainer.querySelector(`[data-schoolyear-vacation-end="${cssEscape(idx)}"]`)?.value || ""
    ).trim();
    if (!label && !startDate && !endDate) return;
    rows.push({ label, startDate, endDate });
  });
  return rows;
}

function collectSchoolYearHolidaysFromDom() {
  if (!ui.schoolYearHolidaysContainer) return [];
  const rows = [];
  const labels = ui.schoolYearHolidaysContainer.querySelectorAll("[data-schoolyear-holiday-label]");
  labels.forEach((el) => {
    const idx = String(el.dataset.schoolyearHolidayLabel || "");
    const label = String(el.value || "").trim();
    const date = String(
      ui.schoolYearHolidaysContainer.querySelector(`[data-schoolyear-holiday-date="${cssEscape(idx)}"]`)?.value || ""
    ).trim();
    if (!label && !date) return;
    rows.push({ label, date });
  });
  return rows;
}

function collectSchoolYearWeekPatternFromDom(startDate, endDate) {
  if (!ui.schoolYearWeeksContainer) return {};
  const weeks = getSchoolYearWeeksBetween(startDate, endDate);
  const pattern = {};
  weeks.forEach((weekStart, idx) => {
    const weekIso = toIsoDate(weekStart);
    const fallback = idx % 2 === 0 ? "A" : "B";
    const selected = String(
      ui.schoolYearWeeksContainer.querySelector(`[data-schoolyear-week-type="${cssEscape(weekIso)}"]`)?.value || fallback
    ).trim();
    pattern[weekIso] = normalizeWeekType(selected);
  });
  return pattern;
}

function collectSchoolYearActiveTeacherIdsFromDom() {
  if (!ui.schoolYearTeachersContainer) return [];
  return Array.from(ui.schoolYearTeachersContainer.querySelectorAll("[data-schoolyear-teacher]"))
    .filter((el) => el.checked)
    .map((el) => String(el.getAttribute("data-schoolyear-teacher") || "").trim())
    .filter(Boolean);
}

async function publishSchoolYearEdt() {
  if (!ui.schoolYearIsPublishedCheck || !ui.schoolYearHint) return;

  const isPublished = ui.schoolYearIsPublishedCheck.checked;
  const active = getActiveSchoolYearId();

  try {
    // Mettre à jour la config avec isPublished
    await setDoc(
      doc(db, "planningConfig", "schoolYearCalendar"),
      { years: { [active]: { isPublished, updatedAt: serverTimestamp() } } },
      { merge: true }
    );

    // Mettre à jour l'état local
    state.schoolYearConfig = { ...state.schoolYearConfig, isPublished };
    renderSchoolYearPanel();

    const message = isPublished
      ? `✅ EDT publiée et visible au public (${active}).`
      : `📵 EDT dépubliée et cachée au public (${active}).`;
    ui.schoolYearHint.textContent = message;
  } catch (error) {
    ui.schoolYearHint.textContent = `Erreur publication: ${error?.message || "modification impossible."}`;
  }
}

async function saveSchoolYearCalendar() {
  if (!ui.schoolYearStartDate || !ui.schoolYearEndDate || !ui.schoolYearHint) return;
  const startDate = String(ui.schoolYearStartDate.value || "").trim();
  const endDate = String(ui.schoolYearEndDate.value || "").trim();
  const vacations = collectSchoolYearVacationsFromDom();
  const holidays = collectSchoolYearHolidaysFromDom();

  if (!startDate || !endDate) {
    ui.schoolYearHint.textContent = "Définissez le début et la fin de l'année scolaire.";
    return;
  }
  if (startDate > endDate) {
    ui.schoolYearHint.textContent = "La date de fin de l'année doit être postérieure à la date de début.";
    return;
  }
  if (vacations.some((v) => !v.label || !v.startDate || !v.endDate || v.startDate > v.endDate)) {
    ui.schoolYearHint.textContent = "Corrigez les vacances: nom + dates valides obligatoires.";
    return;
  }
  if (holidays.some((h) => !h.label || !h.date)) {
    ui.schoolYearHint.textContent = "Corrigez les jours fériés: nom + date obligatoires.";
    return;
  }
  const weekPattern = collectSchoolYearWeekPatternFromDom(startDate, endDate);
  const activeTeacherIds = new Set(collectSchoolYearActiveTeacherIdsFromDom());

  const isPublished = Boolean(ui.schoolYearIsPublishedCheck?.checked);

  const payload = {
    startDate,
    endDate,
    vacations,
    holidays,
    weekPattern,
    isPublished,
    updatedAt: serverTimestamp(),
  };

  try {
    const active = getActiveSchoolYearId();
    const batch = db.batch();
    for (const teacher of state.allTeachers) {
      const years = new Set(
        Array.isArray(teacher.activeSchoolYears)
          ? teacher.activeSchoolYears.map((y) => String(y || "").trim()).filter(Boolean)
          : []
      );
      const shouldBeActive = activeTeacherIds.has(teacher.id);
      if (shouldBeActive) years.add(active);
      else years.delete(active);
      const nextYears = Array.from(years);
      const prevYears = Array.isArray(teacher.activeSchoolYears)
        ? teacher.activeSchoolYears.map((y) => String(y || "").trim()).filter(Boolean)
        : [];
      if (JSON.stringify(nextYears.sort()) !== JSON.stringify(prevYears.sort())) {
        batch.set(
          doc(db, "teachers", teacher.id),
          { activeSchoolYears: nextYears, updatedAt: serverTimestamp() },
          { merge: true }
        );
      }
    }
    await setDoc(
      doc(db, "planningConfig", "schoolYearCalendar"),
      { years: { [active]: payload } },
      { merge: true }
    );
    await batch.commit();
    state.schoolYearConfig = payload;
    ui.schoolYearHint.textContent = `Année scolaire enregistrée (${active}).`;
  } catch (error) {
    ui.schoolYearHint.textContent = `Erreur année scolaire: ${error?.message || "enregistrement impossible."}`;
  }
}

async function saveDesiderataConfig() {
  const yearId = String(ui.desiderataConfigYearSelect?.value || "").trim();
  const enabled = String(ui.desiderataConfigEnabled?.value || "0") === "1";
  if (!yearId) {
    if (ui.schoolYearHint) ui.schoolYearHint.textContent = "Choisissez l'année des désidératas.";
    return;
  }
  try {
    await setDoc(
      doc(db, "planningConfig", "desiderataConfig"),
      { yearId, enabled, updatedAt: serverTimestamp() },
      { merge: true }
    );
    state.desiderataConfig = { yearId, enabled };
    if (ui.schoolYearHint) ui.schoolYearHint.textContent = `Désidératas ${enabled ? "activés" : "désactivés"} pour ${yearId}.`;
  } catch (error) {
    if (ui.schoolYearHint) ui.schoolYearHint.textContent = `Erreur config désidératas: ${error?.message || "enregistrement impossible."}`;
  }
}

function renderRightsPanel() {
  if (!ui.adminRightsContainer) return;
  const container = ui.adminRightsContainer;

  if (state.currentUserRole !== "SUPER_ADMIN") {
    container.innerHTML = `<p class="hours-over">Accès refusé. Seul le Super Administrateur peut gérer les droits.</p>`;
    return;
  }

  const modules = [
    { key: "creation", label: "Création" },
    { key: "assign", label: "Affectation" },
    { key: "program", label: "Programmation" },
    { key: "bus", label: "Bus" },
    { key: "tasks", label: "Tâches" },
    { key: "documents", label: "Documents" },
    { key: "manage", label: "Gestion" },
    { key: "emailTemplates", label: "Templates Email" },
    { key: "swim", label: "Natation" },
    { key: "recap", label: "Récapitulatif" },
    { key: "repartition", label: "Répartition" },
    { key: "inventory", label: "Inventaire" },
  ];

  const rows = state.teachers.map((teacher) => {
    const rights = state.userRights.find((r) => r.id === teacher.id)?.permissions || {};
    const moduleSelects = modules.map((m) => {
      const val = rights[m.key] || "NONE";
      return `
        <td>
          <select data-rights-teacher="${teacher.id}" data-rights-module="${m.key}">
            <option value="NONE" ${val === "NONE" ? "selected" : ""}>Aucun</option>
            <option value="VIEW" ${val === "VIEW" ? "selected" : ""}>Lecture</option>
            <option value="MODIFY" ${val === "MODIFY" ? "selected" : ""}>Modif.</option>
          </select>
        </td>
      `;
    }).join("");

    return `
      <tr>
        <td>
          <span class="teacher-color-dot" style="background:${escapeHtml(getTeacherColor(teacher))}"></span>
          <strong>${escapeHtml(teacher.name)}</strong>
        </td>
        ${moduleSelects}
        <td><button class="secondary-btn" data-save-rights="${teacher.id}" type="button">Sauver</button></td>
      </tr>
    `;
  });

  container.innerHTML = `
    <div class="table-wrap">
      <table class="rights-table">
        <thead>
          <tr>
            <th>Utilisateur</th>
            ${modules.map((m) => `<th>${m.label}</th>`).join("")}
            <th>Action</th>
          </tr>
        </thead>
        <tbody>
          ${rows.join("") || `<tr><td colspan="${modules.length + 2}">Aucun professeur à configurer.</td></tr>`}
        </tbody>
      </table>
    </div>
  `;

  // Bind actions
  container.querySelectorAll("[data-save-rights]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const teacherId = btn.dataset.saveRights;
      const permissions = {};
      // Use querySelectorAll with attribute value selector without escaping the value directly
      // Instead, find the row and get all selects within it
      const row = btn.closest("tr");
      if (row) {
        row.querySelectorAll("select[data-rights-module]").forEach((sel) => {
          if (sel.dataset.rightsTeacher === teacherId) {
            permissions[sel.dataset.rightsModule] = sel.value;
          }
        });
      }

      // If no selects found, fall back to checking all selects
      if (Object.keys(permissions).length === 0) {
        container.querySelectorAll("select[data-rights-module]").forEach((sel) => {
          if (sel.dataset.rightsTeacher === teacherId) {
            permissions[sel.dataset.rightsModule] = sel.value;
          }
        });
      }

      try {
        await setDoc(doc(db, "userRights", teacherId), {
          id: teacherId,
          permissions,
          updatedAt: serverTimestamp(),
        }, { merge: true });
        ui.sessionError.textContent = "Droits mis à jour.";
      } catch (error) {
        ui.sessionError.textContent = "Erreur de sauvegarde : " + error.message;
      }
    });
  });
}

function renderAdminSummary() {
  const hoursByTeacher = computeTeacherHours();
  const totalTeachers = state.teachers.length;
  const totalClasses = state.classes.length;
  const totalSessions = state.sessions.length;
  const totalAbsences = state.absences.length;
  const totalOffers = state.replacementOffers.length;
  const overloadCount = state.teachers.filter((t) => (hoursByTeacher.get(t.id) || 0) > Number(t.maxHours || 0)).length;
  const remainingHours = state.classes.reduce((acc, cls) => acc + getClassAlgoRemaining(cls.id), 0);
  const remainingClasses = state.classes.filter((cls) => getClassAlgoRemaining(cls.id) > 0.001).length;
  const selectedYear = getActiveSchoolYearId();
  const alertItems = [
    remainingClasses
      ? `<li><span class="hours-over">${remainingClasses}</span> classe(s) encore partiellement ou non placée(s) (${formatHours(remainingHours)}h).</li>`
      : `<li><span class="hours-ok">Toutes les classes sont actuellement couvertes.</span></li>`,
    overloadCount
      ? `<li><span class="hours-over">${overloadCount}</span> enseignant(s) dépassent leur charge configurée.</li>`
      : `<li><span class="hours-ok">Aucune surcharge enseignant détectée.</span></li>`,
    totalAbsences
      ? `<li><span class="hours-over">${totalAbsences}</span> absence(s) enregistrée(s), ${totalOffers} candidature(s) de remplacement à suivre.</li>`
      : `<li><span class="hours-ok">Aucune absence active sur l'année sélectionnée.</span></li>`,
  ].join("");
  const rows = state.teachers.map((t) => {
    const used = hoursByTeacher.get(t.id) || 0;
    const max = Number(t.maxHours || 0);
    const over = used > max;
    const teacherSessions = state.sessions.filter((s) => s.teacherId === t.id);
    const details = teacherSessions.length
      ? teacherSessions
          .map((s) => {
            const cadence = normalizeCadence(s.cadence) === "BIWEEKLY" ? ` - Semaine ${normalizeWeekType(s.weekType)}` : "";
            const label = getClassLabelById(s.classId, true);
            const typeLabel = s.type || "EPS";
            return `${typeLabel} ${label} (${s.day} ${s.start}, ${s.duration}h${cadence})`;
          })
          .join("<br>")
      : "Aucun créneau";

    return `<tr>
      <td><strong>${escapeHtml(t.name)}</strong></td>
      <td><span class="${over ? "hours-over" : "hours-ok"}">${formatHours(used)}/${formatHours(max)}h</span></td>
      <td>${details}</td>
    </tr>`;
  });

  ui.adminRecapContainer.innerHTML = `
    <div class="dashboard-shell">
      <section class="dashboard-hero">
        <div>
          <p class="dashboard-kicker">Tableau de bord</p>
          <h3>Vision d'ensemble de l'année ${escapeHtml(selectedYear)}</h3>
          <p class="card-subtitle">Entrée rapide pour corriger les tensions, suivre la couverture des classes et aller directement au bon module.</p>
        </div>
        <div class="dashboard-quick-actions">
          <button type="button" class="secondary-btn" data-dashboard-tab="assign">Affectation</button>
          <button type="button" class="secondary-btn" data-dashboard-tab="absence">Remplacements</button>
          <button type="button" class="secondary-btn" data-dashboard-tab="algo">Algorithme</button>
          <button type="button" class="secondary-btn" data-dashboard-tab="schoolyear">Année scolaire</button>
        </div>
      </section>
      <section class="dashboard-metrics">
        <article class="dashboard-metric-card">
          <span class="dashboard-metric-label">Enseignants actifs</span>
          <strong>${totalTeachers}</strong>
          <small>${totalClasses} classes configurées</small>
        </article>
        <article class="dashboard-metric-card">
          <span class="dashboard-metric-label">Créneaux planifiés</span>
          <strong>${totalSessions}</strong>
          <small>${remainingClasses ? `${remainingClasses} classe(s) à finaliser` : "Couverture complète"}</small>
        </article>
        <article class="dashboard-metric-card ${overloadCount ? "warning" : ""}">
          <span class="dashboard-metric-label">Charge enseignant</span>
          <strong>${overloadCount}</strong>
          <small>${overloadCount ? "surcharge(s) à corriger" : "aucune surcharge"}</small>
        </article>
        <article class="dashboard-metric-card ${totalAbsences ? "warning" : ""}">
          <span class="dashboard-metric-label">Absences / remplacements</span>
          <strong>${totalAbsences}</strong>
          <small>${totalOffers} candidature(s) en suivi</small>
        </article>
      </section>
      <section class="dashboard-alert-card">
        <h4>Points d'attention</h4>
        <ul class="dashboard-alert-list">${alertItems}</ul>
      </section>
      <section class="dashboard-table-card">
        <div class="dashboard-table-head">
          <div>
            <h4>Répartition par professeur</h4>
            <p class="card-subtitle">Lecture rapide des charges et des créneaux déjà attribués.</p>
          </div>
        </div>
        <div class="table-wrap">
          <table>
            <tr>
              <th>Professeur</th>
              <th>Heures</th>
              <th>Classes / AS attribués</th>
            </tr>
            ${rows.join("") || `<tr><td colspan="3">Aucun professeur.</td></tr>`}
          </table>
        </div>
      </section>
    </div>
  `;

  ui.adminRecapContainer.querySelectorAll("[data-dashboard-tab]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const next = String(btn.dataset.dashboardTab || "").trim();
      if (!next) return;
      setAdminTab(next);
      render();
    });
  });
}

function isCompactMobileLayout() {
  return window.matchMedia("(max-width: 760px)").matches;
}

function renderMobileDayPlanner(days, grid, options = {}) {
  const { vacationDays = new Set(), emptyLabel = "Aucun cours", dayClassName = "" } = options;
  return `<div class="mobile-day-planner ${escapeHtml(dayClassName)}">
    ${days
      .map((day) => {
        const rows = SLOT_BANDS.map((band) => {
          const key = toSlotKey(day, band.start);
          const blocks = grid.get(key) || [];
          return `
            <div class="mobile-day-row">
              <div class="mobile-day-time">${escapeHtml(band.label)}</div>
              <div class="mobile-day-content">${blocks.length ? renderSlotBlocksWithBiweeklyLayout(blocks) : `<span class="mobile-empty-slot">${escapeHtml(emptyLabel)}</span>`}</div>
            </div>
          `;
        }).join("");
        return `
          <article class="mobile-day-card${vacationDays.has(day) ? " vacation" : ""}">
            <header class="mobile-day-card-head">
              <h4>${escapeHtml(day)}</h4>
              ${vacationDays.has(day) ? `<span class="public-chip public-chip-warn">Vacances</span>` : ""}
            </header>
            <div class="mobile-day-card-body">${rows}</div>
          </article>
        `;
      })
      .join("")}
  </div>`;
}

function getProgramActivities() {
  return state.programActivities;
}

function getProgramLocations() {
  return state.programLocations;
}

function renderProgrammingPanel() {
  if (!ui.programActivitiesList || !ui.programLocationsList || !ui.programStats || !ui.programHint) return;
  if (state.programEditSessionId && !state.sessions.some((s) => s.id === state.programEditSessionId)) {
    state.programEditSessionId = "";
  }

  const activities = getProgramActivities();
  const locations = getProgramLocations();
  const staleSessionsCount = state.sessions.filter((s) => !isSessionClassCurrent(s)).length;
  let visibleSessions = getCurrentClassSessions();

  // Remplir les selects de filtrage
  if (ui.programFilterTeacher) {
    const currentTeacherId = ui.programFilterTeacher.value;
    const teacherIds = [...new Set(visibleSessions.map(s => s.teacherId).filter(Boolean))];
    const options = '<option value="">Tous les profs</option>' +
      teacherIds
        .map(tid => {
          const teacher = state.teachers.find(t => t.id === tid);
          return `<option value="${tid}">${teacher?.name || tid}</option>`;
        })
        .join('');
    ui.programFilterTeacher.innerHTML = options;
    ui.programFilterTeacher.value = currentTeacherId;
  }

  // Remplir le select des périodes
  if (ui.programFilterPeriod) {
    const currentPeriodId = ui.programFilterPeriod.value;
    const periodIds = [...new Set(visibleSessions.map(s => s.periodId).filter(Boolean))];
    const options = '<option value="">Toutes les périodes</option>' +
      periodIds
        .map(pid => {
          const period = state.periods.find(p => p.id === pid);
          return `<option value="${pid}">${period?.name || pid}</option>`;
        })
        .join('');
    ui.programFilterPeriod.innerHTML = options;
    ui.programFilterPeriod.value = currentPeriodId;
  }

  // Appliquer les filtres
  const selectedTeacher = ui.programFilterTeacher?.value;
  const selectedPeriod = ui.programFilterPeriod?.value;

  if (selectedTeacher) {
    visibleSessions = visibleSessions.filter(s => s.teacherId === selectedTeacher);
  }
  if (selectedPeriod) {
    visibleSessions = visibleSessions.filter(s => s.periodId === selectedPeriod);
  }

  // Ajouter les event listeners
  if (ui.programFilterTeacher && !ui.programFilterTeacher._listenerAttached) {
    ui.programFilterTeacher.onchange = () => renderProgrammingPanel();
    ui.programFilterTeacher._listenerAttached = true;
  }
  if (ui.programFilterPeriod && !ui.programFilterPeriod._listenerAttached) {
    ui.programFilterPeriod.onchange = () => renderProgrammingPanel();
    ui.programFilterPeriod._listenerAttached = true;
  }

  const total = visibleSessions.length;
  const programmed = visibleSessions.filter((s) => s.activityLabel && s.locationName).length;
  const pending = Math.max(0, total - programmed);

  const locationConflictCount = countLocationConflicts(visibleSessions);
  const hintParts = [];
  hintParts.push(
    locationConflictCount > 0
      ? `<span class="hours-over">${locationConflictCount} conflit(s) de salle détecté(s) sur la semaine.</span>`
      : `<span class="hours-ok">Aucun conflit de salle sur la semaine.</span>`
  );
  if (staleSessionsCount > 0) {
    hintParts.push(`<span class="hours-over">${staleSessionsCount} créneau(x) masqué(s): classes supprimées / non actuelles.</span>`);
  }
  ui.programHint.innerHTML = hintParts.join("<br>");

  ui.programStats.innerHTML = `
    <p>Programmés <strong>${total ? Math.round((programmed / total) * 100) : 0}%</strong></p>
    <p>Créneaux en attente <strong>${pending}</strong></p>
    <p>Conflits de salle <strong class="${locationConflictCount ? "hours-over" : "hours-ok"}">${locationConflictCount}</strong></p>
  `;

  if (ui.programHighlightPendingBtn) {
    ui.programHighlightPendingBtn.classList.toggle("active", state.highlightPending);
    ui.programHighlightPendingBtn.innerHTML = state.highlightPending
      ? `<span class="material-symbols-outlined">visibility_off</span> Masquer la mise en surbrillance`
      : `<span class="material-symbols-outlined">visibility</span> Visualiser les créneaux restants`;
  }

  const activityLocationOptions = locations
    .map((l) => `<option value="${escapeHtml(l.name)}">${escapeHtml(l.name)}</option>`)
    .join("");
  const activityItems = activities
    .map(
      (a) => `<div class="program-activity-card">
        <div class="program-activity-card-head">
          <strong>${escapeHtml(a.label)}</strong>
        </div>
        <div class="program-activity-card-grid">
          <input type="text" data-edit-program-activity-label="${escapeHtml(a.id)}" value="${escapeHtml(a.label)}" placeholder="Nom activité" />
          <input type="text" data-edit-program-activity-code="${escapeHtml(a.id)}" value="${escapeHtml(a.code || "")}" maxlength="6" placeholder="Code" />
          <select data-edit-program-activity-location="${escapeHtml(a.id)}">
            <option value="">Salle préférentielle (optionnel)</option>
            ${activityLocationOptions}
          </select>
        </div>
        <div class="program-activity-card-actions">
          <button class="secondary-btn" type="button" data-save-program-activity="${escapeHtml(a.id)}">Enregistrer</button>
          <button class="delete-btn" type="button" data-delete-program-activity="${escapeHtml(a.id)}">Suppr.</button>
        </div>
      </div>`
    )
    .join("");
  ui.programActivitiesList.innerHTML = activityItems || `<p class="slot-picker-empty">Aucune activité</p>`;
  for (const a of activities) {
    const locSel = ui.programActivitiesList.querySelector(`[data-edit-program-activity-location="${cssEscape(a.id)}"]`);
    if (locSel) locSel.value = String(a.preferredLocationName || "");
  }
  if (ui.programActivityPreferredLocationSelect) {
    ui.programActivityPreferredLocationSelect.innerHTML = `
      <option value="">Salle préférentielle (optionnel)</option>
      ${locations.map((l) => `<option value="${escapeHtml(l.name)}">${escapeHtml(l.name)}</option>`).join("")}
    `;
  }

  const locationUsage = computeLocationUsage(visibleSessions);
  const locationItems = locations
    .map((l) => {
      const percent = locationUsage.get(l.name) || 0;
      return `<div class="program-list-item">
        <span>${escapeHtml(l.name)}</span>
        <span>${percent}%</span>
        <span
          class="program-drag-pill"
          draggable="true"
          data-program-draggable="location"
          data-location-name="${escapeHtml(l.name)}"
          title="Glisser-déposer dans une séance"
        >Glisser</span>
        <button class="delete-btn" type="button" data-delete-program-location="${escapeHtml(l.id)}">Suppr.</button>
      </div>`;
    })
    .join("");
  ui.programLocationsList.innerHTML = locationItems || `<p class="slot-picker-empty">Aucun lieu</p>`;

  renderProgramPeriodsPanel();
  renderProgramClassPlans(activities);
  renderProgramAnnualVisual(activities, locations);

  bindProgrammingActions();
}

function getProgramPlanLabelsByClassId(classId) {
  const plan = getClassActivityPlan(classId) || {};
  const isAS = classId === "__AS__";
  const biweekly = !isAS && isClassBiweeklyProfile(classId);
  if (isAS) {
    return {
      h1: "Année",
      h2: "",
      h3: "",
      v1: String(plan.yearActivityLabel || ""),
      v2: "",
      v3: "",
    };
  }
  if (biweekly) {
    return {
      h1: "S1",
      h2: "S2",
      h3: "",
      v1: String(plan.s1ActivityLabel || ""),
      v2: String(plan.s2ActivityLabel || ""),
      v3: "",
    };
  }
  return {
    h1: "T1",
    h2: "T2",
    h3: "T3",
    v1: String(plan.t1ActivityLabel || ""),
    v2: String(plan.t2ActivityLabel || ""),
    v3: String(plan.t3ActivityLabel || ""),
  };
}

function renderProgramAnnualVisual(activities, locations) {
  if (!ui.programAnnualVisualContainer) return;
  const sessions = [...getCurrentClassSessions()].sort((a, b) => {
    const dayCmp = DAYS.indexOf(a.day) - DAYS.indexOf(b.day);
    if (dayCmp !== 0) return dayCmp;
    const slotCmp = String(a.start || "").localeCompare(String(b.start || ""), "fr");
    if (slotCmp !== 0) return slotCmp;
    return String(getClassLabelById(a.classId)).localeCompare(String(getClassLabelById(b.classId)), "fr");
  });
  if (!sessions.length) {
    ui.programAnnualVisualContainer.innerHTML = `<p class="slot-picker-empty">Aucun créneau pour générer la vue annuelle.</p>`;
    return;
  }

  const seen = new Set();
  const rows = [];
  let currentDay = "";
  let currentBandStart = "";
  for (const s of sessions) {
    const key = `${s.day}|${s.start}|${s.classId}|${s.teacherId}|${normalizeCadence(s.cadence)}|${normalizeWeekType(s.weekType)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (s.day !== currentDay) {
      currentDay = s.day;
      currentBandStart = "";
      rows.push(`<tr class="program-annual-day-row"><td colspan="10">${escapeHtml(currentDay)}</td></tr>`);
    }
    const teacher = state.teachers.find((t) => t.id === s.teacherId);
    const band = getBandForSlot(s.start);
    const bandLabel = band ? formatProgramBandRange(band.start, band.end) : String(s.start || "");
    const bandStart = String(band?.start || s.start || "");
    const slotStartClass = bandStart !== currentBandStart ? " annual-slot-group-start" : "";
    currentBandStart = bandStart;
    const plan = getClassActivityPlan(s.classId) || {};
    const defaultLieu = String(s.locationName || "");
    const defaultAct = String(s.activityLabel || "");
    const t1Activity = getAnnualPlanDisplayValue(plan, s.classId, "t1", "activity", defaultAct);
    const t2Activity = getAnnualPlanDisplayValue(plan, s.classId, "t2", "activity", defaultAct);
    const t3Activity = getAnnualPlanDisplayValue(plan, s.classId, "t3", "activity", defaultAct);
    const t1Lieu = getAnnualPlanDisplayValue(plan, s.classId, "t1", "location", defaultLieu);
    const t2Lieu = getAnnualPlanDisplayValue(plan, s.classId, "t2", "location", defaultLieu);
    const t3Lieu = getAnnualPlanDisplayValue(plan, s.classId, "t3", "location", defaultLieu);
    const t1ActivityMeta = getAnnualPlanFieldMeta(s.classId, "t1", "activity");
    const t2ActivityMeta = getAnnualPlanFieldMeta(s.classId, "t2", "activity");
    const t3ActivityMeta = getAnnualPlanFieldMeta(s.classId, "t3", "activity");
    const t1LocationMeta = getAnnualPlanFieldMeta(s.classId, "t1", "location");
    const t2LocationMeta = getAnnualPlanFieldMeta(s.classId, "t2", "location");
    const t3LocationMeta = getAnnualPlanFieldMeta(s.classId, "t3", "location");
    const pickCell = (kind, period, value, meta) => {
      if (!meta.enabled) {
        return `<span class="annual-readonly">—</span>`;
      }
      const placeholder = kind === "activity" ? "Choisir activité" : "Choisir salle";
      const highlightClass = (state.highlightPending && !value) ? " highlight-pending" : "";
      return `<button
        class="annual-pick-btn${highlightClass}"
        type="button"
        data-program-pick-cell="1"
        data-class-id="${escapeHtml(s.classId)}"
        data-period-key="${escapeHtml(period)}"
        data-kind="${escapeHtml(kind)}"
        data-day="${escapeHtml(s.day || "")}"
        data-slot="${escapeHtml(s.start || "")}"
      >${escapeHtml(value || placeholder)}</button>`;
    };
    const isBiweekly = isClassBiweeklyProfile(s.classId);
    const planMode = getClassPlanMode(s.classId);

    const teacherColor = getTeacherColorById(s.teacherId);
    rows.push(`<tr class="annual-slot-row annual-teacher-row${slotStartClass}" style="--annual-teacher-row-bg:${escapeHtml(`${teacherColor}22`)};--annual-teacher-row-border:${escapeHtml(teacherColor)};">
      <td>${escapeHtml(bandLabel)}</td>
      <td>${escapeHtml(getClassLabelById(s.classId))}</td>
      <td class="annual-prof-cell" style="${escapeHtml(getTeacherBlockStyle(s.teacherId))}">${escapeHtml(getTeacherDisplayLabel(teacher))}</td>
      ${
        planMode === "YEAR"
          ? `<td class="annual-trim-sep" colspan="3">
               ${pickCell("activity", "t1", t1Activity, t1ActivityMeta)}
             </td>
             <td colspan="3">
               ${pickCell("location", "t1", t1Lieu, t1LocationMeta)}
             </td>`
          : planMode === "SEMESTER"
            ? `<td class="annual-trim-sep" colspan="2">
                 ${pickCell("activity", "t1", t1Activity, t1ActivityMeta)}
               </td>
               <td>
                 ${pickCell("location", "t1", t1Lieu, t1LocationMeta)}
               </td>
               <td class="annual-trim-sep" colspan="2">
                 ${pickCell("activity", "t2", t2Activity, t2ActivityMeta)}
               </td>
               <td>
                 ${pickCell("location", "t2", t2Lieu, t2LocationMeta)}
               </td>`
            : `<td class="annual-trim-sep">
               ${pickCell("activity", "t1", t1Activity, t1ActivityMeta)}
             </td>
             <td>
               ${pickCell("location", "t1", t1Lieu, t1LocationMeta)}
             </td>
             <td class="annual-trim-sep">
               ${pickCell("activity", "t2", t2Activity, t2ActivityMeta)}
             </td>
             <td>
               ${pickCell("location", "t2", t2Lieu, t2LocationMeta)}
             </td>
             <td class="annual-trim-sep">
               ${pickCell("activity", "t3", t3Activity, t3ActivityMeta)}
             </td>
             <td>
               ${pickCell("location", "t3", t3Lieu, t3LocationMeta)}
             </td>`
      }
      <td class="annual-mode-cell">
        <select class="annual-mode-select" data-program-mode-select="${escapeHtml(s.classId)}">
          <option value="">Auto</option>
          <option value="YEAR">Année</option>
          <option value="TRIMESTER">Trimestre</option>
          <option value="SEMESTER">Semestre</option>
        </select>
      </td>
    </tr>`);
  }

  ui.programAnnualVisualContainer.innerHTML = `
    <table class="program-annual-table">
      <tr class="annual-head">
        <th rowspan="2">Horaire</th>
        <th rowspan="2">Classe</th>
        <th rowspan="2">Prof</th>
        <th colspan="2">Trimestre 1</th>
        <th colspan="2">Trimestre 2</th>
        <th colspan="2">Trimestre 3</th>
        <th rowspan="2">Mode</th>
      </tr>
      <tr class="annual-subhead">
        <th>Activité</th>
        <th>Lieu</th>
        <th>Activité</th>
        <th>Lieu</th>
        <th>Activité</th>
        <th>Lieu</th>
      </tr>
      ${rows.join("")}
    </table>
  `;
  bindProgramAnnualVisualActions();
}

function formatProgramBandRange(start, end) {
  const toLabel = (timeValue) => {
    const [hRaw, mRaw] = String(timeValue || "").split(":");
    const h = String(Number(hRaw || 0));
    const m = String(mRaw || "00").padStart(2, "0");
    return `${h}h${m}`;
  };
  return `${toLabel(start)} - ${toLabel(end)}`;
}

function bindProgramAnnualVisualActions() {
  if (!ui.programAnnualVisualContainer) return;
  ui.programAnnualVisualContainer.querySelectorAll("[data-program-pick-cell]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const classId = String(btn.dataset.classId || "").trim();
      const periodKey = String(btn.dataset.periodKey || "").trim();
      const kind = String(btn.dataset.kind || "").trim();
      const day = String(btn.dataset.day || "").trim();
      const slot = String(btn.dataset.slot || "").trim();
      if (!classId || !periodKey || !kind) return;
      const fieldMeta = getAnnualPlanFieldMeta(classId, periodKey, kind);
      if (!fieldMeta.enabled) return;
      openProgramPickModal({
        classId,
        periodKey,
        kind,
        day,
        slot,
      });
    });
  });
  ui.programAnnualVisualContainer.querySelectorAll("[data-program-mode-select]").forEach((sel) => {
    const classId = String(sel.dataset.programModeSelect || "").trim();
    if (!classId) return;
    sel.value = String(getClassActivityPlan(classId)?.modeOverride || "");
    sel.addEventListener("change", async () => {
      const modeOverride = sel.value || null;
      try {
        await setDoc(doc(db, "classActivityPlans", getPlanDocId(classId)), {
          classId,
          modeOverride,
          schoolYearId: getActiveSchoolYearId(),
          updatedAt: serverTimestamp(),
        }, { merge: true });
        let existingPlan = getClassActivityPlan(classId);
        if (existingPlan) {
          existingPlan.modeOverride = modeOverride;
        } else {
          state.classActivityPlans.push({ id: classId, classId, modeOverride });
        }
        renderProgrammingPanel();
      } catch (error) {
        ui.sessionError.textContent = "Erreur de sauvegarde du mode : " + error.message;
      }
    });
  });
}

function getClassPlanMode(classId) {
  const override = String(getClassActivityPlan(classId)?.modeOverride || "").toUpperCase();
  if (override === "YEAR" || override === "SEMESTER" || override === "TRIMESTER") return override;
  if (String(classId || "").startsWith("__AS")) return "YEAR";
  if (isClassBiweeklyProfile(classId)) return "SEMESTER";
  return "TRIMESTER";
}

function getPlanDocId(classId) {
  const id = String(classId || "");
  return id.startsWith("__") && id.endsWith("__") ? "plan_" + id.slice(2, -2) : id;
}

function getAnnualPlanFieldMeta(classId, periodKey, kind) {
  const activity = kind === "activity";
  const mode = getClassPlanMode(classId);
  const suffix = activity ? "ActivityLabel" : "LocationName";
  if (mode === "YEAR") {
    if (periodKey !== "t1") return { enabled: false, field: "", mode };
    return { enabled: true, field: `year${suffix}`, mode };
  }
  if (mode === "SEMESTER") {
    if (periodKey === "t1") return { enabled: true, field: `s1${suffix}`, mode };
    if (periodKey === "t2") return { enabled: true, field: `s2${suffix}`, mode };
    return { enabled: false, field: "", mode };
  }
  if (periodKey === "t1" || periodKey === "t2" || periodKey === "t3") {
    return { enabled: true, field: `${periodKey}${suffix}`, mode };
  }
  return { enabled: false, field: "", mode };
}

function getAnnualPlanDisplayValue(plan, classId, periodKey, kind, fallback = "") {
  const activity = kind === "activity";
  const mode = getClassPlanMode(classId);
  const suffix = activity ? "ActivityLabel" : "LocationName";
  if (mode === "YEAR") {
    // Pour l'AS, on affiche la valeur annuelle partout si elle existe
    return String(plan[`year${suffix}`] || plan[`t1${suffix}`] || fallback || "");
  }
  if (mode === "SEMESTER") {
    if (periodKey === "t1") {
      const val = String(plan[`s1${suffix}`] || plan[`t1${suffix}`] || fallback || "");
      console.log(`getAnnualPlanDisplayValue SEMESTER t1: s1${suffix}=${plan[`s1${suffix}`]}, t1${suffix}=${plan[`t1${suffix}`]}, fallback=${fallback}, result=${val}`);
      return val;
    }
    if (periodKey === "t2") {
      const val = String(plan[`s2${suffix}`] || plan[`t2${suffix}`] || fallback || "");
      console.log(`getAnnualPlanDisplayValue SEMESTER t2: s2${suffix}=${plan[`s2${suffix}`]}, t2${suffix}=${plan[`t2${suffix}`]}, fallback=${fallback}, result=${val}`);
      return val;
    }
    return "";
  }
  if (periodKey === "t1" || periodKey === "t2" || periodKey === "t3") {
    const val = String(plan[`${periodKey}${suffix}`] || fallback || "");
    console.log(`getAnnualPlanDisplayValue TRIMESTER ${periodKey}: ${periodKey}${suffix}=${plan[`${periodKey}${suffix}`]}, fallback=${fallback}, result=${val}`);
    return val;
  }
  return "";
}

function closeProgramPickModal() {
  if (!ui.programPickModal) return;
  ui.programPickModal.classList.add("hidden");
  state.programPickContext = null;
}

function openProgramPickModal(context) {
  if (!ui.programPickModal || !ui.programPickModalList || !ui.programPickModalTitle || !ui.programPickModalContext) return;
  const classId = String(context?.classId || "");
  const periodKey = String(context?.periodKey || "");
  const kind = String(context?.kind || "");
  if (!classId || !periodKey || !kind) return;
  const fieldMeta = getAnnualPlanFieldMeta(classId, periodKey, kind);
  if (!fieldMeta.enabled) return;

  state.programPickContext = {
    classId,
    periodKey,
    kind,
    field: fieldMeta.field,
    mode: fieldMeta.mode,
  };

  const sourceItems =
    kind === "activity"
      ? getProgramActivities().map((a) => ({ value: a.label, label: a.label, sub: a.code }))
      : getProgramLocations().map((l) => ({ value: l.name, label: l.name, sub: "" }));
  
  const classLabel = getClassLabelById(classId);
  ui.programPickModalTitle.textContent = kind === "activity" ? "Choisir une activité" : "Choisir une salle";
  ui.programPickModalContext.textContent = `${classLabel} · Période ${periodKey.slice(1)}`;

  const normalizeStr = (s) => String(s || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");

  const renderModalList = (filter = "") => {
    const searchTerms = normalizeStr(filter).split(/\s+/).filter(Boolean);
    const filtered = sourceItems.filter(item => {
      const label = normalizeStr(item.label);
      const sub = item.sub ? normalizeStr(item.sub) : "";
      const combined = `${label} ${sub}`;
      const words = combined.split(/\s+/);
      return searchTerms.every(term => words.some(word => word.startsWith(term)));
    });

    const itemsHtml = filtered
      .map(item => `
        <button class="program-pick-item" type="button" data-program-pick-value="${escapeHtml(item.value)}">
          <span class="pick-label">${escapeHtml(item.label)}</span>
          ${item.sub ? `<span class="pick-sub">${escapeHtml(item.sub)}</span>` : ""}
        </button>`).join("");

    const showCreate = filter.trim().length > 0 && !sourceItems.some(i => i.label.toLowerCase() === filter.trim().toLowerCase());
    const createHtml = showCreate ? `
      <button class="program-pick-item create" type="button" id="programPickManualCreateBtn">
        <span class="pick-label">Créer "${escapeHtml(filter.trim())}"</span>
        <span class="pick-sub">Nouveau</span>
      </button>` : "";

    ui.programPickModalList.innerHTML = `
      <div class="program-pick-filter-row">
        <input id="programPickFilterInput" type="text" placeholder="Taper pour filtrer ou créer..." value="${escapeHtml(filter)}" autocomplete="off" />
      </div>
      <div class="program-pick-grid">
        <button class="program-pick-item clear" type="button" data-program-pick-clear="1">
          <span class="pick-label">Effacer</span>
        </button>
        ${itemsHtml}
        ${createHtml}
        ${!filtered.length && !showCreate ? `<p class="slot-picker-empty">Aucun résultat</p>` : ""}
      </div>
    `;

    const filterInput = ui.programPickModalList.querySelector("#programPickFilterInput");
    if (filterInput) {
      setTimeout(() => {
        filterInput.focus();
        filterInput.setSelectionRange(filterInput.value.length, filterInput.value.length);
      }, 50);
    }
    
    filterInput.addEventListener("input", (e) => renderModalList(e.target.value));
    filterInput.addEventListener("keydown", async (e) => {
      if (e.key === "Enter") {
        const firstBtn = ui.programPickModalList.querySelector(".program-pick-grid .program-pick-item:not(.clear)");
        if (firstBtn) firstBtn.click();
        else if (showCreate) await handleCreate(filter.trim());
      }
    });

    if (showCreate) {
      ui.programPickModalList.querySelector("#programPickManualCreateBtn").addEventListener("click", () => handleCreate(filter.trim()));
    }
    
    ui.programPickModalList.querySelectorAll("[data-program-pick-value]").forEach(btn => {
      btn.addEventListener("click", () => saveProgramPickValue(btn.dataset.programPickValue));
    });
    ui.programPickModalList.querySelectorAll("[data-program-pick-clear]").forEach(btn => {
      btn.addEventListener("click", () => saveProgramPickValue(""));
    });
  };

  const handleCreate = async (raw) => {
    const val = raw.trim();
    if (!val) return;
    if (kind === "activity") {
      const existing = getProgramActivities().find(a => a.label.toLowerCase() === val.toLowerCase());
      if (!existing) {
        await addDoc(collection(db, "programActivities"), { label: val, code: val.slice(0,3).toUpperCase(), createdAt: serverTimestamp() });
      }
    } else {
      const existing = getProgramLocations().find(l => l.name.toLowerCase() === val.toLowerCase());
      if (!existing) {
        await addDoc(collection(db, "programLocations"), { name: val, createdAt: serverTimestamp() });
      }
    }
    await saveProgramPickValue(val);
  };

  ui.programPickModal.classList.remove("hidden");
  renderModalList("");
}

async function saveProgramPickValue(value) {
  const ctx = state.programPickContext;
  console.log('saveProgramPickValue called with value:', value, 'ctx:', ctx);
  if (!ctx?.classId || !ctx.field) {
    console.log('Context missing');
    return;
  }
  
  // Détection de conflits de salle
  let autoPickedLocation = "";
  if (ctx.kind === "activity" && value) {
    const activity = getProgramActivities().find((a) => a.label === value);
    const preferred = String(activity?.preferredLocationName || "").trim();
    const locationMeta = getAnnualPlanFieldMeta(ctx.classId, ctx.periodKey, "location");
    if (preferred && locationMeta.enabled && locationMeta.field) {
      autoPickedLocation = preferred;
    }
  }

  const locationToVerify = ctx.kind === "location" ? value : autoPickedLocation;
  if (locationToVerify) {
    const conflicts = getAnnualPeriodLocationConflicts(ctx.classId, ctx.periodKey, locationToVerify);
    if (conflicts.length) {
      const confirmed = confirm(`ALERTE CONFLIT :\nLa salle "${locationToVerify}" est déjà occupée sur ces créneaux par :\n- ${conflicts.join("\n- ")}\n\nVoulez-vous quand même enregistrer ce choix ?`);
      if (!confirmed) return;
    }
  }

  const payload = {
    classId: ctx.classId,
    mode: ctx.mode,
    schoolYearId: getActiveSchoolYearId(),
    [ctx.field]: value || null,
    updatedAt: serverTimestamp(),
  };

  if (ctx.mode === "YEAR") {
    if (ctx.kind === "activity") {
      payload.yearActivityLabel = value || null;
      payload.t1ActivityLabel = value || null;
    }
    if (ctx.kind === "location") {
      payload.yearLocationName = value || null;
      payload.t1LocationName = value || null;
    }
  }

  if (autoPickedLocation) {
    const locationMeta = getAnnualPlanFieldMeta(ctx.classId, ctx.periodKey, "location");
    payload[locationMeta.field] = autoPickedLocation;
    if (ctx.mode === "YEAR") {
      payload.yearLocationName = autoPickedLocation;
      payload.t1LocationName = autoPickedLocation;
    }
  }

  try {
    console.log('Saving payload:', payload);
    await setDoc(doc(db, "classActivityPlans", getPlanDocId(ctx.classId)), payload, { merge: true });
    console.log('Sauvegarde réussie');

    // Mettre à jour l'état local immédiatement
    let existingPlan = state.classActivityPlans.find((p) => p.classId === ctx.classId);
    if (!existingPlan) {
      existingPlan = state.classActivityPlans.find((p) => p.id === ctx.classId);
    }

    if (existingPlan) {
      Object.assign(existingPlan, payload);
      console.log('Plan existant mis à jour');
    } else {
      const newPlan = { id: ctx.classId, classId: ctx.classId, ...payload };
      state.classActivityPlans.push(newPlan);
      console.log('Nouveau plan créé:', newPlan);
    }

    ui.sessionError.textContent = "Programmation enregistrée (par trimestre).";
    closeProgramPickModal();

    // Rafraîchir immédiatement sans délai
    renderProgrammingPanel();
    console.log('Panel rafraîchi');
  } catch (error) {
    console.error('Erreur sauvegarde:', error);
    ui.sessionError.textContent = "Erreur de sauvegarde : " + error.message;
  }
}

function renderProgramPeriodsPanel() {
  if (
    !ui.programTrim1Start ||
    !ui.programTrim1End ||
    !ui.programTrim2Start ||
    !ui.programTrim2End ||
    !ui.programTrim3Start ||
    !ui.programTrim3End ||
    !ui.programSem1Start ||
    !ui.programSem1End ||
    !ui.programSem2Start ||
    !ui.programSem2End ||
    !ui.programPeriodsInfo
  ) {
    return;
  }
  const p = state.programPeriods || {};
  ui.programTrim1Start.value = String(p.t1Start || "");
  ui.programTrim1End.value = String(p.t1End || "");
  ui.programTrim2Start.value = String(p.t2Start || "");
  ui.programTrim2End.value = String(p.t2End || "");
  ui.programTrim3Start.value = String(p.t3Start || "");
  ui.programTrim3End.value = String(p.t3End || "");
  ui.programSem1Start.value = String(p.s1Start || "");
  ui.programSem1End.value = String(p.s1End || "");
  ui.programSem2Start.value = String(p.s2Start || "");
  ui.programSem2End.value = String(p.s2End || "");

  const hasTrimesters = p.t1Start && p.t1End && p.t2Start && p.t2End && p.t3Start && p.t3End;
  const hasSemesters = p.s1Start && p.s1End && p.s2Start && p.s2End;
  const hasAll = hasTrimesters && hasSemesters;
  ui.programPeriodsInfo.innerHTML = hasAll
    ? `<span class="hours-ok">Trimestres et semestres configurés.</span>`
    : `<span>${hasTrimesters && !hasSemesters ? "Trimestres configurés, semestres incomplets." : "Renseignez les 3 trimestres et les 2 semestres."}</span>`;
}

function getCurrentTrimester() {
  const today = new Date();
  const periods = state.programPeriods || {};

  if (periods.t1Start && periods.t1End) {
    const t1Start = new Date(periods.t1Start);
    const t1End = new Date(periods.t1End);
    if (today >= t1Start && today <= t1End) return 't1';
  }

  if (periods.t2Start && periods.t2End) {
    const t2Start = new Date(periods.t2Start);
    const t2End = new Date(periods.t2End);
    if (today >= t2Start && today <= t2End) return 't2';
  }

  if (periods.t3Start && periods.t3End) {
    const t3Start = new Date(periods.t3Start);
    const t3End = new Date(periods.t3End);
    if (today >= t3Start && today <= t3End) return 't3';
  }

  return null; // Pas dans une période définie
}

function getClassActivityPlan(classId) {
  return state.classActivityPlans.find((x) => (x.classId || x.id) === classId) || null;
}

function isClassBiweeklyProfile(classId) {
  return state.sessions.some((s) => s.classId === classId && normalizeCadence(s.cadence) === "BIWEEKLY");
}

function renderProgramClassPlans(activities) {
  if (!ui.programClassPlanContainer) return;
  const classes = [...state.classes].sort((a, b) => String(a.name || "").localeCompare(String(b.name || ""), "fr"));
  
  // Trouver toutes les AS uniques présentes dans les sessions
  const usedASIds = Array.from(new Set(state.sessions.filter(s => String(s.classId || "").startsWith("__AS")).map(s => s.classId))).sort();
  const asRows = usedASIds.map(id => ({
    id,
    name: getSpecialAssignmentById(id).label,
    level: "Activités",
    __isAS: true
  }));

  const rowsData = [...classes, ...asRows];
  if (!rowsData.length) {
    ui.programClassPlanContainer.innerHTML = `<p class="slot-picker-empty">Aucune classe.</p>`;
    return;
  }
  const activityOptions = activities
    .map((a) => `<option value="${escapeHtml(a.label)}">${escapeHtml(a.label)}</option>`)
    .join("");
  const locationOptions = state.programLocations
    .map((l) => `<option value="${escapeHtml(l.name)}">${escapeHtml(l.name)}</option>`)
    .join("");

  const rows = rowsData
    .map((c) => {
      if (c.__isAS) {
        return `<tr>
          <td><strong>${escapeHtml(c.name)}</strong></td>
          <td>ANNUEL</td>
          <td colspan="2">
            <div class="class-plan-row">
              <div class="class-plan-field">
                <label>Activité</label>
                <select data-class-plan-year-act="${escapeHtml(c.id)}">
                  <option value="">Choisir activité</option>
                  ${activityOptions}
                </select>
              </div>
              <div class="class-plan-field">
                <label>Salle</label>
                <select data-class-plan-year-loc="${escapeHtml(c.id)}">
                  <option value="">Choisir salle</option>
                  ${locationOptions}
                </select>
              </div>
            </div>
          </td>
          <td><button class="secondary-btn" type="button" data-save-class-plan="${escapeHtml(c.id)}">Enregistrer</button></td>
        </tr>`;
      }
      const biweekly = isClassBiweeklyProfile(c.id);
      const mode = biweekly ? "SEMESTRE" : "TRIMESTRE";
      const plan = getClassActivityPlan(c.id) || {};
      if (biweekly) {
        return `<tr>
          <td><strong>${escapeHtml(c.name)}</strong></td>
          <td>${escapeHtml(mode)}</td>
          <td>
            <label>S1</label>
            <select data-class-plan-s1="${escapeHtml(c.id)}">
              <option value="">Activité</option>
              ${activityOptions}
            </select>
          </td>
          <td>
            <label>S2</label>
            <select data-class-plan-s2="${escapeHtml(c.id)}">
              <option value="">Activité</option>
              ${activityOptions}
            </select>
          </td>
          <td><button class="secondary-btn" type="button" data-save-class-plan="${escapeHtml(c.id)}">Enregistrer</button></td>
        </tr>`;
      }
      return `<tr>
        <td><strong>${escapeHtml(c.name)}</strong></td>
        <td>${escapeHtml(mode)}</td>
        <td>
          <label>T1</label>
          <select data-class-plan-t1="${escapeHtml(c.id)}">
            <option value="">Activité</option>
            ${activityOptions}
          </select>
        </td>
        <td>
          <label>T2</label>
          <select data-class-plan-t2="${escapeHtml(c.id)}">
            <option value="">Activité</option>
            ${activityOptions}
          </select>
        </td>
        <td>
          <label>T3</label>
          <select data-class-plan-t3="${escapeHtml(c.id)}">
            <option value="">Activité</option>
            ${activityOptions}
          </select>
          <button class="secondary-btn" type="button" data-save-class-plan="${escapeHtml(c.id)}">Enregistrer</button>
        </td>
      </tr>`;
    })
    .join("");

  ui.programClassPlanContainer.innerHTML = `
    <table class="program-class-plan-table">
      <tr>
        <th>Classe</th>
        <th>Mode</th>
        <th>Période 1</th>
        <th>Période 2</th>
        <th>Période 3 / Action</th>
      </tr>
      ${rows}
    </table>
  `;

  for (const c of rowsData) {
    const plan = getClassActivityPlan(c.id) || {};
    if (c.__isAS) {
      const yearlyAct = ui.programClassPlanContainer.querySelector(`[data-class-plan-year-act="${cssEscape(c.id)}"]`);
      const yearlyLoc = ui.programClassPlanContainer.querySelector(`[data-class-plan-year-loc="${cssEscape(c.id)}"]`);
      if (yearlyAct) yearlyAct.value = String(plan.yearActivityLabel || plan.t1ActivityLabel || "");
      if (yearlyLoc) yearlyLoc.value = String(plan.yearLocationName || plan.t1LocationName || "");
      continue;
    }
    if (isClassBiweeklyProfile(c.id)) {
      const s1 = ui.programClassPlanContainer.querySelector(`[data-class-plan-s1="${cssEscape(c.id)}"]`);
      const s2 = ui.programClassPlanContainer.querySelector(`[data-class-plan-s2="${cssEscape(c.id)}"]`);
      if (s1) s1.value = String(plan.s1ActivityLabel || plan.t1ActivityLabel || "");
      if (s2) s2.value = String(plan.s2ActivityLabel || plan.t2ActivityLabel || "");
    } else {
      const t1 = ui.programClassPlanContainer.querySelector(`[data-class-plan-t1="${cssEscape(c.id)}"]`);
      const t2 = ui.programClassPlanContainer.querySelector(`[data-class-plan-t2="${cssEscape(c.id)}"]`);
      const t3 = ui.programClassPlanContainer.querySelector(`[data-class-plan-t3="${cssEscape(c.id)}"]`);
      if (t1) t1.value = String(plan.t1ActivityLabel || "");
      if (t2) t2.value = String(plan.t2ActivityLabel || "");
      if (t3) t3.value = String(plan.t3ActivityLabel || "");
    }
  }
  bindProgramClassPlanActions();
}

async function saveProgramPeriods() {
  const payload = {
    t1Start: String(ui.programTrim1Start?.value || ""),
    t1End: String(ui.programTrim1End?.value || ""),
    t2Start: String(ui.programTrim2Start?.value || ""),
    t2End: String(ui.programTrim2End?.value || ""),
    t3Start: String(ui.programTrim3Start?.value || ""),
    t3End: String(ui.programTrim3End?.value || ""),
    s1Start: String(ui.programSem1Start?.value || ""),
    s1End: String(ui.programSem1End?.value || ""),
    s2Start: String(ui.programSem2Start?.value || ""),
    s2End: String(ui.programSem2End?.value || ""),
    updatedAt: serverTimestamp(),
  };
  try {
    await setDoc(doc(db, "planningConfig", "periods"), payload);
    ui.sessionError.textContent = "Dates des trimestres enregistrées.";
  } catch (error) {
    ui.sessionError.textContent = `Erreur trimestres: ${error?.message || "mise à jour impossible."}`;
  }
}

function bindProgramClassPlanActions() {
  if (!ui.programClassPlanContainer) return;

  // Mise à jour de l'état local lors du changement pour éviter la perte au re-render
  ui.programClassPlanContainer.querySelectorAll("select").forEach((sel) => {
    sel.addEventListener("change", () => {
      const classId = sel.dataset.classPlanYearAct || sel.dataset.classPlanYearLoc || 
                      sel.dataset.classPlanS1 || sel.dataset.classPlanS2 ||
                      sel.dataset.classPlanT1 || sel.dataset.classPlanT2 || sel.dataset.classPlanT3;
      if (!classId) return;
      
      let plan = getClassActivityPlan(classId);
      if (!plan) {
        plan = { classId, mode: getClassPlanMode(classId) };
        state.classActivityPlans.push(plan);
      }

      if (sel.dataset.classPlanYearAct) plan.yearActivityLabel = sel.value || null;
      if (sel.dataset.classPlanYearLoc) plan.yearLocationName = sel.value || null;
      if (sel.dataset.classPlanS1) plan.s1ActivityLabel = sel.value || null;
      if (sel.dataset.classPlanS2) plan.s2ActivityLabel = sel.value || null;
      if (sel.dataset.classPlanT1) plan.t1ActivityLabel = sel.value || null;
      if (sel.dataset.classPlanT2) plan.t2ActivityLabel = sel.value || null;
      if (sel.dataset.classPlanT3) plan.t3ActivityLabel = sel.value || null;
    });
  });

  ui.programClassPlanContainer.querySelectorAll("[data-save-class-plan]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const classId = btn.dataset.saveClassPlan;
      if (!classId) return;

      const batch = db.batch();
      let payload = { classId, schoolYearId: getActiveSchoolYearId(), updatedAt: serverTimestamp() };

      if (String(classId).startsWith("__AS")) {
        const yearlyAct = String(ui.programClassPlanContainer.querySelector(`[data-class-plan-year-act="${cssEscape(classId)}"]`)?.value || "").trim();
        const yearlyLoc = String(ui.programClassPlanContainer.querySelector(`[data-class-plan-year-loc="${cssEscape(classId)}"]`)?.value || "").trim();
        
        payload.mode = "YEAR";
        payload.yearActivityLabel = yearlyAct || null;
        payload.yearLocationName = yearlyLoc || null;
        payload.t1ActivityLabel = yearlyAct || null;
        payload.t1LocationName = yearlyLoc || null;

        // Sync individual sessions for THIS AS
        state.sessions.filter(s => s.classId === classId).forEach(s => {
          const update = {
            activityLabel: yearlyAct || null,
            locationName: yearlyLoc || null,
            activityCode: getProgramActivities().find(a => a.label === yearlyAct)?.code || (yearlyAct ? yearlyAct.slice(0,3).toUpperCase() : null)
          };
          batch.update(doc(db, "sessions", s.id), update);
        });
      } else {
        const biweekly = isClassBiweeklyProfile(classId);
        if (biweekly) {
          const s1 = String(ui.programClassPlanContainer.querySelector(`[data-class-plan-s1="${cssEscape(classId)}"]`)?.value || "").trim();
          const s2 = String(ui.programClassPlanContainer.querySelector(`[data-class-plan-s2="${cssEscape(classId)}"]`)?.value || "").trim();
          payload.mode = "SEMESTER";
          payload.s1ActivityLabel = s1 || null;
          payload.s2ActivityLabel = s2 || null;
          payload.t1ActivityLabel = s1 || null;
          payload.t2ActivityLabel = s2 || null;
        } else {
          const t1 = String(ui.programClassPlanContainer.querySelector(`[data-class-plan-t1="${cssEscape(classId)}"]`)?.value || "").trim();
          const t2 = String(ui.programClassPlanContainer.querySelector(`[data-class-plan-t2="${cssEscape(classId)}"]`)?.value || "").trim();
          const t3 = String(ui.programClassPlanContainer.querySelector(`[data-class-plan-t3="${cssEscape(classId)}"]`)?.value || "").trim();
          payload.mode = "TRIMESTER";
          payload.t1ActivityLabel = t1 || null;
          payload.t2ActivityLabel = t2 || null;
          payload.t3ActivityLabel = t3 || null;
        }

        // Sync sessions for regular classes
        state.sessions.filter(s => s.classId === classId).forEach(s => {
          const update = {};
          const planMode = payload.mode;
          // Synchronisation simplifiée : on prend la valeur du plan correspondant au T1 (par défaut pour l'instant)
          const act = payload.t1ActivityLabel || (planMode === "YEAR" ? payload.yearActivityLabel : null);
          if (act) {
            update.activityLabel = act;
            update.activityCode = getProgramActivities().find(a => a.label === act)?.code || act.slice(0,3).toUpperCase();
          }
          batch.update(doc(db, "sessions", s.id), update);
        });
      }

      try {
        batch.set(doc(db, "classActivityPlans", getPlanDocId(classId)), payload, { merge: true });
        await batch.commit();
        ui.sessionError.textContent = "Plan d'activités enregistré et synchronisé.";
      } catch (error) {
        ui.sessionError.textContent = `Erreur sauvegarde: ${error?.message || "impossible."}`;
      }
    });
  });
}

function renderBusOrdersHistory() {
  if (!ui.busOrdersHistoryContainer) return;

  const orders = state.busOrders || [];

  if (orders.length === 0) {
    ui.busOrdersHistoryContainer.innerHTML = `<p class="summary-box">Aucune commande de bus créée pour le moment.</p>`;
    return;
  }

  const rows = orders
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
    .map(order => {
      const createdBy = state.teachers.find(t => t.id === order.createdBy)?.name || "Inconnu";
      const startDate = order.startDate ? new Date(order.startDate).toLocaleDateString('fr-FR') : '-';
      const endDate = order.endDate ? new Date(order.endDate).toLocaleDateString('fr-FR') : '-';
      const sessionCount = (order.sessionIds || []).length;
      return `
        <tr>
          <td><strong>${escapeHtml(order.period || 'Sans période')}</strong></td>
          <td>${startDate} à ${endDate}</td>
          <td>${sessionCount} session(s)</td>
          <td>${escapeHtml(createdBy)}</td>
          <td>
            <button class="secondary-btn" data-delete-order="${escapeHtml(order.id)}" type="button">Supprimer</button>
          </td>
        </tr>
      `;
    })
    .join('');

  ui.busOrdersHistoryContainer.innerHTML = `
    <table style="width: 100%;">
      <thead>
        <tr>
          <th>Période</th>
          <th>Dates</th>
          <th>Sessions</th>
          <th>Créée par</th>
          <th>Actions</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  `;

  // Bind delete actions
  ui.busOrdersHistoryContainer.querySelectorAll('[data-delete-order]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const orderId = btn.dataset.deleteOrder;
      if (confirm('Êtes-vous sûr de vouloir supprimer cette commande ?')) {
        try {
          await deleteDoc(doc(db, "busOrders", orderId));
          renderBusOrdersHistory();
        } catch (error) {
          ui.sessionError.textContent = `Erreur suppression: ${error.message}`;
        }
      }
    });
  });
}

function openBusOrderModal() {
  const today = new Date();
  const defaultStart = today.toISOString().split('T')[0];
  const defaultEnd = new Date(today.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

  const html = `
    <div style="display: flex; gap: 1rem; margin-bottom: 1rem;">
      <button onclick="closeBusOrderModal()" class="secondary-btn" type="button">✕ Fermer</button>
    </div>
    <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 1rem; margin-bottom: 1.5rem;">
      <div>
        <label for="busOrderStartDate">Date de début :</label>
        <input type="date" id="busOrderStartDate" value="${defaultStart}" />
      </div>
      <div>
        <label for="busOrderEndDate">Date de fin :</label>
        <input type="date" id="busOrderEndDate" value="${defaultEnd}" />
      </div>
    </div>
    <div id="busOrderSessionsPreview" style="margin-bottom: 1rem; max-height: 300px; overflow-y: auto; border: 1px solid #ddd; padding: 1rem; border-radius: 4px;"></div>
    <div style="display: flex; gap: 1rem;">
      <button id="busOrderCreateBtn" class="primary-btn" type="button">✓ Créer la commande</button>
    </div>
  `;

  if (!ui.busOrderModal) {
    const modalEl = document.createElement('div');
    modalEl.id = 'busOrderModal';
    modalEl.className = 'modal-overlay hidden';
    modalEl.innerHTML = `
      <div class="modal-card" style="max-width: 800px;">
        <div class="modal-header">
          <h3>Créer une nouvelle commande de bus</h3>
          <button onclick="closeBusOrderModal()" class="close-btn">&times;</button>
        </div>
        <div class="modal-body" style="max-height: calc(90vh - 80px); overflow-y: auto;">
          <div id="busOrderContent"></div>
        </div>
      </div>
    `;
    document.body.appendChild(modalEl);
    ui.busOrderModal = modalEl;
    ui.busOrderContent = modalEl.querySelector('#busOrderContent');
  }

  ui.busOrderContent.innerHTML = html;
  ui.busOrderModal.classList.remove('hidden');

  // Bind date inputs and preview
  const startInput = ui.busOrderContent.querySelector('#busOrderStartDate');
  const endInput = ui.busOrderContent.querySelector('#busOrderEndDate');
  const preview = ui.busOrderContent.querySelector('#busOrderSessionsPreview');
  const createBtn = ui.busOrderContent.querySelector('#busOrderCreateBtn');

  const updatePreview = () => {
    const startDate = startInput.value ? new Date(startInput.value) : null;
    const endDate = endInput.value ? new Date(endInput.value) : null;

    if (!startDate || !endDate) {
      preview.innerHTML = '<p style="color: #999;">Sélectionnez les deux dates.</p>';
      return;
    }

    if (startDate > endDate) {
      preview.innerHTML = '<p style="color: #d32f2f;">La date de fin doit être après la date de début.</p>';
      return;
    }

    const sessionsInPeriod = state.sessions.filter(s => Boolean(s.busRequired) && s.day);

    if (sessionsInPeriod.length === 0) {
      preview.innerHTML = '<p style="color: #999;">Aucune session avec besoin de bus.</p>';
    } else {
      const periodLabel = `${startDate.toLocaleDateString('fr-FR')} au ${endDate.toLocaleDateString('fr-FR')}`;
      preview.innerHTML = `
        <strong>Période : ${periodLabel}</strong><br>
        <strong>${sessionsInPeriod.length} session(s) avec bus :</strong>
        <ul style="margin-top: 0.5rem; padding-left: 1.5rem;">
          ${sessionsInPeriod.map(s => {
            const teacher = state.teachers.find(t => t.id === s.teacherId);
            const classLabel = getClassLabelById(s.classId);
            return `<li>${s.day} ${s.start} - ${teacher?.name || '-'} / ${classLabel}</li>`;
          }).join('')}
        </ul>
      `;
    }
  };

  startInput.addEventListener('change', updatePreview);
  endInput.addEventListener('change', updatePreview);
  updatePreview();

  createBtn.addEventListener('click', async () => {
    const startDate = startInput.value;
    const endDate = endInput.value;

    if (!startDate || !endDate) {
      ui.sessionError.textContent = 'Sélectionnez les deux dates.';
      return;
    }

    if (new Date(startDate) > new Date(endDate)) {
      ui.sessionError.textContent = 'La date de fin doit être après la date de début.';
      return;
    }

    const sessionsInPeriod = state.sessions.filter(s => Boolean(s.busRequired)).map(s => s.id);
    const periodLabel = `${new Date(startDate).toLocaleDateString('fr-FR')} au ${new Date(endDate).toLocaleDateString('fr-FR')}`;

    try {
      await addDoc(collection(db, "busOrders"), {
        schoolYearId: getActiveSchoolYearId(),
        period: periodLabel,
        startDate: startDate,
        endDate: endDate,
        sessionIds: sessionsInPeriod,
        createdAt: new Date().getTime(),
        createdBy: state.currentUserTeacherId
      });

      // Mettre à jour le filtre de période et afficher le planning
      state.busOrderFilterStartDate = startDate;
      state.busOrderFilterEndDate = endDate;

      closeBusOrderModal();
      renderBusOrdersHistory();
      renderBusPanel();
      ui.sessionError.textContent = '✅ Commande de bus créée !';
    } catch (error) {
      ui.sessionError.textContent = `Erreur création: ${error.message}`;
    }
  });
}

function closeBusOrderModal() {
  if (ui.busOrderModal) {
    ui.busOrderModal.classList.add('hidden');
  }
}

function renderBusPanel() {
  if (!ui.busPlannerContainer || !ui.busHint) return;

  // Afficher l'historique des commandes
  renderBusOrdersHistory();

  // Déterminer les jours à afficher selon le filtre de période
  let daysToShow = DAYS;
  let periodLabel = "";

  if (state.busOrderFilterStartDate && state.busOrderFilterEndDate) {
    const startDate = new Date(state.busOrderFilterStartDate);
    const endDate = new Date(state.busOrderFilterEndDate);
    periodLabel = `<div style="margin-bottom: 1rem; padding: 1rem; background: #e3f2fd; border-radius: 4px; border-left: 4px solid #1976d2;">
      <strong>📋 Période filtrée :</strong> ${startDate.toLocaleDateString('fr-FR')} au ${endDate.toLocaleDateString('fr-FR')}
      <button onclick="state.busOrderFilterStartDate = null; state.busOrderFilterEndDate = null; renderBusPanel();" class="secondary-btn" style="margin-left: 1rem;" type="button">✕ Réinitialiser</button>
    </div>`;

    // Générer les dates de chaque jour dans la période
    const dayDates = new Map();
    let currentDate = new Date(startDate);
    while (currentDate <= endDate) {
      const dayIndex = currentDate.getDay();
      const dayName = DAYS[(dayIndex + 6) % 7]; // Convert JS week (0=Sun) to our week (0=Mon)
      const dateStr = currentDate.toLocaleDateString('fr-FR');

      if (!dayDates.has(dayName)) {
        dayDates.set(dayName, []);
      }
      dayDates.get(dayName).push(dateStr);

      currentDate.setDate(currentDate.getDate() + 1);
    }

    // Ajouter les dates à DAYS
    daysToShow = DAYS.filter(day => dayDates.has(day));
    DAYS.forEach(day => {
      DAYS._dates = DAYS._dates || {};
      DAYS._dates[day] = dayDates.get(day) || [];
    });
  }

  const dayBlocks = daysToShow.map((day) => {
    const sessions = state.sessions
      .filter((s) => s.day === day)
      .sort((a, b) => String(a.start || "").localeCompare(String(b.start || ""), "fr"));
    const dayDatesStr = DAYS._dates && DAYS._dates[day] ? DAYS._dates[day].join(", ") : "";

    if (!sessions.length) {
      return `<div class="card bus-day-card">
        <h4>${escapeHtml(day)}${dayDatesStr ? ` <small style="color: #666; font-weight: normal;">${dayDatesStr}</small>` : ""}</h4>
        <p class="slot-picker-empty">Aucune activité prévue.</p>
      </div>`;
    }

    const rows = sessions
      .map((s) => {
        const teacher = state.teachers.find((t) => t.id === s.teacherId);
        const classLabel = getClassLabelById(s.classId);
        const cadenceLabel = normalizeCadence(s.cadence) === "BIWEEKLY" ? `Semaine ${normalizeWeekType(s.weekType)}` : "Hebdo";
        const activityLabel = s.activityLabel || s.type || "Activité";
        const needsBus = Boolean(s.busRequired);
        return `<tr>
          <td>${escapeHtml(s.start)} (${Number(s.duration || 1)}h)</td>
          <td>${escapeHtml(getTeacherDisplayLabel(teacher))}</td>
          <td>${escapeHtml(classLabel)}</td>
          <td>${escapeHtml(activityLabel)} <small>${escapeHtml(cadenceLabel)}</small></td>
          <td><label class="check-row bus-check"><input type="checkbox" data-bus-required="${escapeHtml(s.id)}" ${needsBus ? "checked" : ""} /><span>Bus</span></label></td>
          <td><input type="time" data-bus-outbound-time="${escapeHtml(s.id)}" value="${escapeHtml(String(s.busOutboundTime || ""))}" /></td>
          <td><input type="time" data-bus-return-time="${escapeHtml(s.id)}" value="${escapeHtml(String(s.busReturnTime || ""))}" /></td>
          <td><input type="text" data-bus-outbound-dropoff="${escapeHtml(s.id)}" placeholder="Lieu dépose aller" value="${escapeHtml(String(s.busOutboundDropoff || ""))}" /></td>
          <td><input type="text" data-bus-return-dropoff="${escapeHtml(s.id)}" placeholder="Lieu dépose retour" value="${escapeHtml(String(s.busReturnDropoff || ""))}" /></td>
          <td><button class="secondary-btn" type="button" data-bus-save="${escapeHtml(s.id)}">Enregistrer</button></td>
        </tr>`;
      })
      .join("");

    return `<div class="card bus-day-card">
      <h4>${escapeHtml(day)}${dayDatesStr ? ` <small style="color: #666; font-weight: normal;">${dayDatesStr}</small>` : ""}</h4>
      <div class="table-wrap">
        <table class="bus-table">
          <tr>
            <th>Créneau</th>
            <th>Prof</th>
            <th>Classe</th>
            <th>Activité</th>
            <th>Besoin bus</th>
            <th>Aller</th>
            <th>Retour</th>
            <th>Dépose aller</th>
            <th>Dépose retour</th>
            <th>Action</th>
          </tr>
          ${rows}
        </table>
      </div>
    </div>`;
  }).join("");

  const withBus = state.sessions.filter((s) => Boolean(s.busRequired)).length;
  ui.busHint.innerHTML = `<strong>${withBus}</strong> activité(s) marquée(s) avec transport bus.`;
  if (ui.busMailPreview) {
    const mailSessions = getBusSessionsForMail();
    const missing = getBusMissingFields(mailSessions);
    if (!mailSessions.length) {
      ui.busMailPreview.innerHTML = "Aucune commande bus à envoyer.";
    } else if (missing.length) {
      ui.busMailPreview.innerHTML = `<span class="hours-over">${missing.length} ligne(s) bus incomplète(s). Complétez avant envoi de l'email.</span>`;
    } else {
      ui.busMailPreview.innerHTML = `<span class="hours-ok">Commande prête: ${mailSessions.length} activité(s) prêtes à envoyer par email.</span>`;
    }
  }
  ui.busPlannerContainer.innerHTML = periodLabel + dayBlocks;
  bindBusActions();
}

function bindBusActions() {
  if (!ui.busPlannerContainer) return;
  ui.busPlannerContainer.querySelectorAll("[data-bus-save]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const sessionId = btn.dataset.busSave;
      if (!sessionId) return;
      const requiredEl = ui.busPlannerContainer.querySelector(`[data-bus-required="${cssEscape(sessionId)}"]`);
      const outboundEl = ui.busPlannerContainer.querySelector(`[data-bus-outbound-time="${cssEscape(sessionId)}"]`);
      const returnEl = ui.busPlannerContainer.querySelector(`[data-bus-return-time="${cssEscape(sessionId)}"]`);
      const outboundDropEl = ui.busPlannerContainer.querySelector(`[data-bus-outbound-dropoff="${cssEscape(sessionId)}"]`);
      const returnDropEl = ui.busPlannerContainer.querySelector(`[data-bus-return-dropoff="${cssEscape(sessionId)}"]`);
      const payload = {
        busRequired: Boolean(requiredEl?.checked),
        busOutboundTime: String(outboundEl?.value || "").trim() || null,
        busReturnTime: String(returnEl?.value || "").trim() || null,
        busOutboundDropoff: String(outboundDropEl?.value || "").trim() || null,
        busReturnDropoff: String(returnDropEl?.value || "").trim() || null,
        updatedAt: serverTimestamp(),
      };
      try {
        await updateDoc(doc(db, "sessions", sessionId), payload);
        ui.sessionError.textContent = "Transport bus enregistré.";
      } catch (error) {
        ui.sessionError.textContent = `Erreur transport bus: ${error?.message || "mise à jour impossible."}`;
      }
    });
  });
}

function getBusSessionsForMail() {
  return state.sessions
    .filter((s) => Boolean(s.busRequired))
    .sort((a, b) => {
      const dayCmp = DAYS.indexOf(a.day) - DAYS.indexOf(b.day);
      if (dayCmp !== 0) return dayCmp;
      return String(a.start || "").localeCompare(String(b.start || ""), "fr");
    });
}

function getBusMissingFields(sessions) {
  return sessions
    .map((s) => {
      const missing = [];
      if (!String(s.busOutboundTime || "").trim()) missing.push("horaire aller");
      if (!String(s.busReturnTime || "").trim()) missing.push("horaire retour");
      if (!String(s.busOutboundDropoff || "").trim()) missing.push("dépose aller");
      if (!String(s.busReturnDropoff || "").trim()) missing.push("dépose retour");
      if (!missing.length) return null;
      return `${s.day} : ${missing.join(", ")}`;
    })
    .filter(Boolean);
}

function buildBusEmailPayload() {
  const to = String(ui.busEmailTo?.value || "").trim();
  const sessions = getBusSessionsForMail();
  const missing = getBusMissingFields(sessions);
  const subject = "Commande bus EPS";

  const grouped = new Map();
  for (const d of DAYS) grouped.set(d, []);
  for (const s of sessions) grouped.get(s.day)?.push(s);

  const lines = [];
  lines.push("Bonjour Cathy,");
  lines.push("");
  lines.push("Voici la commande de bus EPS.");
  lines.push("");
  for (const day of DAYS) {
    const daySessions = grouped.get(day) || [];
    if (!daySessions.length) continue;
    lines.push(`${day}`);
    for (const s of daySessions) {
      lines.push(`- Aller: ${s.busOutboundTime || "à préciser"} -> ${s.busOutboundDropoff || "à préciser"}`);
      lines.push(`  Retour: ${s.busReturnTime || "à préciser"} -> ${s.busReturnDropoff || "à préciser"}`);
    }
    lines.push("");
  }
  lines.push("Merci.");

  return {
    to,
    subject,
    body: lines.join("\n"),
    sessionsCount: sessions.length,
    missing,
  };
}

function composeBusEmail() {
  const payload = buildBusEmailPayload();
  if (!payload.to) {
    ui.sessionError.textContent = "Renseignez l'email de Cathy avant envoi.";
    return;
  }
  if (!payload.sessionsCount) {
    ui.sessionError.textContent = "Aucune activité avec bus.";
    return;
  }
  if (payload.missing.length) {
    const preview = payload.missing.slice(0, 4).join(" | ");
    ui.sessionError.textContent = `Complétez les infos bus manquantes (${payload.missing.length}) avant envoi: ${preview}`;
    return;
  }

  const mailto = `mailto:${encodeURIComponent(payload.to)}?subject=${encodeURIComponent(payload.subject)}&body=${encodeURIComponent(payload.body)}`;
  ui.sessionError.textContent = `Email prêt pour ${payload.sessionsCount} ligne(s) bus.`;
  window.location.href = mailto;
}

async function copyBusEmailText() {
  const payload = buildBusEmailPayload();
  if (!payload.sessionsCount) {
    ui.sessionError.textContent = "Aucune activité avec bus.";
    return;
  }
  try {
    await navigator.clipboard.writeText(payload.body);
    ui.sessionError.textContent = "Texte de la commande bus copié.";
  } catch (error) {
    ui.sessionError.textContent = `Copie impossible: ${error?.message || "presse-papiers indisponible."}`;
  }
}

function renderProgramSessionRow(session, activities, locations, bandStart, segment = "full") {
  const teacher = state.teachers.find((t) => t.id === session.teacherId);
  const startBand = getBandForSlot(session.start);
  const isStartSlot = startBand ? startBand.start === bandStart : String(session.start || "") === String(bandStart || "");
  const isOneHourSession = Number(session.duration || 0) <= 1;
  const activityText = session.activityLabel || "Activité non définie";
  const locationText = session.locationName || "Lieu non défini";
  const cadenceText = normalizeCadence(session.cadence) === "BIWEEKLY" ? `Semaine ${normalizeWeekType(session.weekType)}` : "Hebdo";
  const segClass = segment === "full" ? "" : ` band-seg-${segment}`;
  const isAS = isASLike(session);
  const hasProgramData = Boolean(String(session.activityLabel || "").trim()) && Boolean(String(session.locationName || "").trim());
  const isEditMode = state.programEditSessionId === session.id;

  if (!isStartSlot && !isOneHourSession) {
    return `
      <div class="program-session-row${segClass}" data-program-drop-session="${escapeHtml(session.id)}">
        <div class="program-session-line">${escapeHtml(getClassLabelById(session.classId))} - ${escapeHtml(getTeacherDisplayLabel(teacher))}</div>
        <div class="program-session-line">${escapeHtml(activityText)} · ${escapeHtml(locationText)} · ${escapeHtml(cadenceText)}</div>
      </div>
    `;
  }

  if (isAS && hasProgramData && !isEditMode) {
    return `
      <div class="program-session-row${segClass}" data-program-toggle-edit="${escapeHtml(session.id)}" title="Cliquer pour modifier activité/salle">
        <div class="program-session-line">${escapeHtml(getClassLabelById(session.classId))} - ${escapeHtml(getTeacherDisplayLabel(teacher))}</div>
        <div class="program-session-line">${escapeHtml(activityText)} · ${escapeHtml(locationText)} · ${escapeHtml(cadenceText)}</div>
      </div>
    `;
  }

  const activityOptions = activities
    .map((a) => `<option value="${escapeHtml(a.label)}" ${session.activityLabel === a.label ? "selected" : ""}>${escapeHtml(a.label)} (${escapeHtml(a.code || "")})</option>`)
    .join("");
  const locationOptions = locations
    .map((l) => `<option value="${escapeHtml(l.name)}" ${session.locationName === l.name ? "selected" : ""}>${escapeHtml(l.name)}</option>`)
    .join("");
  return `
    <div class="program-session-row${segClass}" data-program-drop-session="${escapeHtml(session.id)}">
      <div class="program-session-line">${escapeHtml(getClassLabelById(session.classId))} - ${escapeHtml(getTeacherDisplayLabel(teacher))}</div>
      <div class="program-session-controls">
        <select data-program-activity="${escapeHtml(session.id)}">
          <option value="">Activité</option>
          ${activityOptions}
        </select>
        <select data-program-location="${escapeHtml(session.id)}">
          <option value="">Lieu</option>
          ${locationOptions}
        </select>
        <button class="program-save-btn" data-program-save="${escapeHtml(session.id)}" type="button">OK</button>
      </div>
    </div>
  `;
}

function computeLocationUsage(visibleSessions) {
  const map = new Map();
  const total = Math.max(1, visibleSessions.length);
  for (const s of visibleSessions) {
    if (!s.locationName) continue;
    map.set(s.locationName, (map.get(s.locationName) || 0) + 1);
  }
  for (const [name, count] of map.entries()) {
    map.set(name, Math.round((count / total) * 100));
  }
  return map;
}

function countLocationConflicts(visibleSessions) {
  let conflicts = 0;
  for (let i = 0; i < visibleSessions.length; i += 1) {
    const a = visibleSessions[i];
    if (!a.locationName) continue;
    for (let j = i + 1; j < visibleSessions.length; j += 1) {
      const b = visibleSessions[j];
      if (!b.locationName) continue;
      if (a.locationName !== b.locationName) continue;
      if (a.day !== b.day) continue;
      if (String(a.classId || "") === String(b.classId || "")) continue;
      if (!sessionsConflict(a, b)) continue;
      conflicts += 1;
    }
  }
  return conflicts;
}

function getLocationConflictsForSession(sessionId, locationName) {
  const target = getCurrentClassSessions().find((s) => s.id === sessionId);
  if (!target || !locationName) return [];
  const candidate = {
    day: target.day,
    start: target.start,
    duration: Number(target.duration || 0),
    cadence: target.cadence,
    weekType: target.weekType,
  };
  const list = getCurrentClassSessions().filter((s) => {
    if (s.id === sessionId) return false;
    if (!s.locationName || s.locationName !== locationName) return false;
    if (String(s.classId || "") === String(target.classId || "")) return false;
    return sessionsConflict(candidate, s);
  });

  return list.map((s) => {
    const teacher = state.teachers.find((t) => t.id === s.teacherId);
    const band = getBandForSlot(s.start);
    const range = band ? formatProgramBandRange(band.start, band.end) : String(s.start || "");
    return `${s.day} ${range} - ${getClassLabelById(s.classId)} (${getTeacherDisplayLabel(teacher)})`;
  });
}

function getBusyLocationsForSlot(day, slot, weekType) {
  const visibleSessions = getCurrentClassSessions().filter((s) => isSessionVisibleForWeek(s, weekType) && s.day === day);
  const band = getBandForSlot(slot);
  const targetKeys = (band ? band.slots : [slot]).map((s) => toSlotKey(day, s));
  const busy = new Map();
  for (const s of visibleSessions) {
    const covered = getCoveredSlots(s.day, s.start, Number(s.duration || 0));
    if (!targetKeys.some((k) => covered.includes(k))) continue;
    if (!s.locationName) continue;
    const teacher = state.teachers.find((t) => t.id === s.teacherId);
    const line = `${getTeacherDisplayLabel(teacher)} - ${getClassLabelById(s.classId)}`;
    const list = busy.get(s.locationName) || [];
    list.push(line);
    busy.set(s.locationName, list);
  }
  return busy;
}

function getPlannedLocationForSessionPeriod(session, periodKey) {
  const plan = getClassActivityPlan(session.classId) || {};
  return String(
    getAnnualPlanDisplayValue(plan, session.classId, periodKey, "location", String(session.locationName || "")) || ""
  ).trim();
}

async function syncASPlanFromSession(session, update) {
  if (!isASLike(session) || !session.classId) return;
  const payload = {
    classId: session.classId,
    mode: "YEAR",
    schoolYearId: getActiveSchoolYearId(),
    updatedAt: serverTimestamp(),
  };
  if (update.activityLabel !== undefined) {
    payload.yearActivityLabel = update.activityLabel;
    payload.t1ActivityLabel = update.activityLabel;
  }
  if (update.locationName !== undefined) {
    payload.yearLocationName = update.locationName;
    payload.t1LocationName = update.locationName;
  }
  try {
    await setDoc(doc(db, "classActivityPlans", getPlanDocId(session.classId)), payload, { merge: true });
  } catch (e) {
    console.error("Erreur sync AS Plan:", e);
  }
}


function getAnnualPeriodLocationConflicts(classId, periodKey, locationName) {
  const targetLocation = String(locationName || "").trim();
  if (!classId || !periodKey || !targetLocation) return [];
  const sessions = getCurrentClassSessions();
  const targets = sessions.filter((s) => s.classId === classId);
  if (!targets.length) return [];

  const details = [];
  for (const target of targets) {
    const candidate = {
      day: target.day,
      start: target.start,
      duration: Number(target.duration || 0),
      cadence: target.cadence,
      weekType: target.weekType,
    };
    for (const other of sessions) {
      if (String(other.classId || "") === String(classId)) continue;
      if (!sessionsConflict(candidate, other)) continue;
      
      // Les 5èmes ne bloquent pas de salle (cours à l'extérieur)
      const otherCls = state.classes.find(c => c.id === other.classId);
      if (otherCls && getLevelRule(otherCls.level)?.group === "CINQUIEME") continue;

      const otherLocation = getPlannedLocationForSessionPeriod(other, periodKey);
      if (otherLocation !== targetLocation) continue;
      const otherBand = getBandForSlot(other.start);
      const otherRange = otherBand ? formatProgramBandRange(otherBand.start, otherBand.end) : String(other.start || "");
      details.push(`${other.day} ${otherRange} - ${getClassLabelById(other.classId)}`);
    }
  }
  return Array.from(new Set(details));
}

function closeProgramRoomsModal() {
  if (!ui.programRoomsModal) return;
  ui.programRoomsModal.classList.add("hidden");
}

function openProgramRoomsModal(day, slot, weekType) {
  if (!ui.programRoomsModal || !ui.programRoomsModalBody) return;
  const locations = getProgramLocations();
  const busy = getBusyLocationsForSlot(day, slot, weekType);
  const available = locations.filter((l) => !busy.has(l.name));

  const busyHtml = Array.from(busy.entries())
    .map(([name, users]) => `<li><strong>${escapeHtml(name)}</strong> : ${escapeHtml(users.join(" | "))}</li>`)
    .join("");
  const availableHtml = available.map((l) => `<li>${escapeHtml(l.name)}</li>`).join("");

  ui.programRoomsModalTitle.textContent = "Salles disponibles";
  ui.programRoomsModalContext.textContent = `${day} ${slot} (Semaine ${weekType})`;
  ui.programRoomsModalBody.innerHTML = `
    <p><strong>Disponibles (${available.length})</strong></p>
    <ul>${availableHtml || "<li>Aucune salle libre</li>"}</ul>
    <p><strong>Occupées (${busy.size})</strong></p>
    <ul>${busyHtml || "<li>Aucune salle occupée</li>"}</ul>
  `;
  ui.programRoomsModal.classList.remove("hidden");
}

function bindProgrammingActions() {
  if (ui.programPlannerContainer) {
    ui.programPlannerContainer.querySelectorAll("[data-program-toggle-edit]").forEach((row) => {
      row.addEventListener("click", () => {
        const sessionId = row.dataset.programToggleEdit;
        if (!sessionId) return;
        state.programEditSessionId = sessionId;
        renderProgrammingPanel();
      });
    });

    ui.programPlannerContainer.querySelectorAll(".program-slot-cell").forEach((cell) => {
      cell.addEventListener("click", (e) => {
        if (e.target.closest("button,select,input")) return;
        if (e.target.closest("[data-program-toggle-edit]")) return;
        const day = cell.dataset.programDay;
        const slot = cell.dataset.programSlot;
        const week = normalizeWeekType(cell.dataset.programWeek);
        if (!day || !slot) return;
        openProgramRoomsModal(day, slot, week);
      });
    });
  }

  ui.programLocationsList.querySelectorAll("[data-program-draggable]").forEach((el) => {
    el.addEventListener("dragstart", (e) => {
      const type = el.dataset.programDraggable;
      if (!type || !e.dataTransfer) return;
      const payload = {
        type,
        name: String(el.dataset.locationName || ""),
      };
      e.dataTransfer.setData("application/json", JSON.stringify(payload));
      e.dataTransfer.effectAllowed = "copy";
    });
  });
  if (ui.programPlannerContainer) {
    ui.programPlannerContainer.querySelectorAll("[data-program-drop-session]").forEach((row) => {
      row.addEventListener("dragover", (e) => {
        if (!e.dataTransfer) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "copy";
        row.classList.add("program-drop-target");
      });
      row.addEventListener("dragleave", () => {
        row.classList.remove("program-drop-target");
      });
      row.addEventListener("drop", async (e) => {
        e.preventDefault();
        row.classList.remove("program-drop-target");
        const sessionId = row.dataset.programDropSession;
        if (!sessionId || !e.dataTransfer) return;
        const raw = e.dataTransfer.getData("application/json");
        if (!raw) return;
        let payload = null;
        try {
          payload = JSON.parse(raw);
        } catch {
          return;
        }
        try {
          if (payload?.type === "activity") {
            const session = state.sessions.find((s) => s.id === sessionId);
            const existingLocation = String(session?.locationName || "").trim();
            const preferredLocation = String(payload.preferredLocationName || "").trim();
            const autoLocation = existingLocation ? "" : preferredLocation;
            if (autoLocation) {
              const conflicts = getLocationConflictsForSession(sessionId, autoLocation);
              if (conflicts.length) {
                const confirmed = confirm(`ALERTE CONFLIT :\nLa salle préférentielle "${autoLocation}" est déjà occupée sur ces créneaux par :\n- ${conflicts.join("\n- ")}\n\nVoulez-vous quand même affecter cette activité ?`);
                if (!confirmed) return;
              }
            }
            const update = {
              activityLabel: String(payload.label || "") || null,
              activityCode: String(payload.code || "") || null,
              locationName: autoLocation || session?.locationName || null,
              updatedAt: serverTimestamp(),
            };
            await updateDoc(doc(db, "sessions", sessionId), update);
            if (isASLike(session)) await syncASPlanFromSession(session, update);

            if (state.programEditSessionId === sessionId) state.programEditSessionId = "";
            ui.sessionError.textContent = autoLocation ? `Activité affectée. Salle préférentielle appliquée: ${autoLocation}.` : "Activité affectée par glisser-déposer.";
          } else if (payload?.type === "location") {
            const locationName = String(payload.name || "");
            const conflicts = locationName ? getLocationConflictsForSession(sessionId, locationName) : [];
            if (conflicts.length) {
              const confirmed = confirm(`ALERTE CONFLIT :\nLa salle "${locationName}" est déjà occupée sur ces créneaux par :\n- ${conflicts.join("\n- ")}\n\nVoulez-vous quand même affecter ce lieu ?`);
              if (!confirmed) return;
            }
            const update = {
              locationName: locationName || null,
              updatedAt: serverTimestamp(),
            };
            await updateDoc(doc(db, "sessions", sessionId), update);
            if (isASLike(session)) await syncASPlanFromSession(session, update);

            if (state.programEditSessionId === sessionId) state.programEditSessionId = "";
            ui.sessionError.textContent = "Lieu affecté par glisser-déposer.";
          }
        } catch (error) {
          ui.sessionError.textContent = `Erreur drag & drop: ${error?.message || "affectation impossible."}`;
        }
      });
    });

    ui.programPlannerContainer.querySelectorAll("[data-program-save]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const sessionId = btn.dataset.programSave;
        if (!sessionId) return;
        const activitySel = ui.programPlannerContainer.querySelector(`[data-program-activity="${cssEscape(sessionId)}"]`);
        const locationSel = ui.programPlannerContainer.querySelector(`[data-program-location="${cssEscape(sessionId)}"]`);
        const activityLabel = String(activitySel?.value || "").trim();
        const locationName = String(locationSel?.value || "").trim();
        const activity = getProgramActivities().find((a) => a.label === activityLabel);
        const session = state.sessions.find((s) => s.id === sessionId);
        const preferredLocation = String(activity?.preferredLocationName || "").trim();
        const finalLocationName = locationName || String(session?.locationName || "").trim() || preferredLocation || "";
        const conflicts = finalLocationName ? getLocationConflictsForSession(sessionId, finalLocationName) : [];
        try {
          const update = {
            activityLabel: activityLabel || null,
            activityCode: activity?.code || null,
            locationName: finalLocationName || null,
            updatedAt: serverTimestamp(),
          };
          await updateDoc(doc(db, "sessions", sessionId), update);
          if (isASLike(session)) await syncASPlanFromSession(session, update);

          if (state.programEditSessionId === sessionId) state.programEditSessionId = "";
          if (conflicts.length) {
            ui.sessionError.textContent = `Alerte: la salle "${finalLocationName}" est déjà utilisée sur ce créneau par :\n- ${conflicts.join("\n- ")}`;
          } else if (!locationName && preferredLocation) {
            ui.sessionError.textContent = `Programmation enregistrée. Salle préférentielle appliquée: ${preferredLocation}.`;
          } else {
            ui.sessionError.textContent = "Programmation enregistrée.";
          }
        } catch (error) {
          ui.sessionError.textContent = `Erreur programmation: ${error?.message || "mise à jour impossible."}`;
        }
      });
    });
  }

  ui.programActivitiesList.querySelectorAll("[data-save-program-activity]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const id = String(btn.dataset.saveProgramActivity || "").trim();
      if (!id) return;
      const label = String(ui.programActivitiesList.querySelector(`[data-edit-program-activity-label="${cssEscape(id)}"]`)?.value || "").trim();
      const code = String(ui.programActivitiesList.querySelector(`[data-edit-program-activity-code="${cssEscape(id)}"]`)?.value || "")
        .trim()
        .toUpperCase();
      const preferredLocationName = String(
        ui.programActivitiesList.querySelector(`[data-edit-program-activity-location="${cssEscape(id)}"]`)?.value || ""
      ).trim();
      if (!label) {
        ui.sessionError.textContent = "Le nom de l'activité est obligatoire.";
        return;
      }
      try {
        await updateDoc(doc(db, "programActivities", id), {
          label,
          code: code || label.slice(0, 3).toUpperCase(),
          preferredLocationName: preferredLocationName || null,
          updatedAt: serverTimestamp(),
        });
        ui.sessionError.textContent = "Activité mise à jour.";
      } catch (error) {
        ui.sessionError.textContent = `Erreur mise à jour activité: ${error?.message || "mise à jour impossible."}`;
      }
    });
  });

  ui.programActivitiesList.querySelectorAll("[data-delete-program-activity]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const id = btn.dataset.deleteProgramActivity;
      if (!id) return;
      try {
        await deleteDoc(doc(db, "programActivities", id));
      } catch (error) {
        ui.sessionError.textContent = `Erreur suppression activité: ${error?.message || "suppression impossible."}`;
      }
    });
  });

  ui.programLocationsList.querySelectorAll("[data-delete-program-location]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const id = btn.dataset.deleteProgramLocation;
      if (!id) return;
      try {
        await deleteDoc(doc(db, "programLocations", id));
      } catch (error) {
        ui.sessionError.textContent = `Erreur suppression lieu: ${error?.message || "suppression impossible."}`;
      }
    });
  });
}

function parseIsoDate(value) {
  const [y, m, d] = String(value || "").split("-").map((x) => Number(x || 0));
  if (!y || !m || !d) return new Date(NaN);
  return new Date(y, m - 1, d);
}

function toIsoDate(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function addDays(date, days) {
  const next = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  next.setDate(next.getDate() + Number(days || 0));
  return next;
}

function getMonday(date) {
  const d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const jsDay = d.getDay();
  const diff = jsDay === 0 ? -6 : 1 - jsDay;
  return addDays(d, diff);
}

function getIsoWeekNumber(date) {
  const target = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const dayNr = (target.getDay() + 6) % 7;
  target.setDate(target.getDate() - dayNr + 3);
  const firstThursday = new Date(target.getFullYear(), 0, 4);
  const firstDayNr = (firstThursday.getDay() + 6) % 7;
  firstThursday.setDate(firstThursday.getDate() - firstDayNr + 3);
  return 1 + Math.round((target - firstThursday) / (7 * 24 * 3600 * 1000));
}

function formatDateFrShort(date) {
  return date.toLocaleDateString("fr-FR", { day: "2-digit", month: "2-digit", year: "numeric" });
}

function getSchoolYearBounds() {
  const startRaw = String(state.schoolYearConfig?.startDate || "");
  const endRaw = String(state.schoolYearConfig?.endDate || "");
  const start = parseIsoDate(startRaw);
  const end = parseIsoDate(endRaw);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return null;
  return {
    start,
    end,
    startMonday: getMonday(start),
    endMonday: getMonday(end),
  };
}

function clampWeekStartToBounds(weekStart, bounds) {
  if (!bounds) return weekStart;
  if (weekStart < bounds.startMonday) return bounds.startMonday;
  if (weekStart > bounds.endMonday) return bounds.endMonday;
  return weekStart;
}

function ensurePublicWeekSelection() {
  const bounds = getSchoolYearBounds();
  const todayMonday = getMonday(new Date());
  let weekStart = parseIsoDate(state.selectedPublicWeekStart);
  if (Number.isNaN(weekStart.getTime())) weekStart = todayMonday;
  weekStart = clampWeekStartToBounds(weekStart, bounds);
  state.selectedPublicWeekStart = toIsoDate(weekStart);
  return weekStart;
}

function shiftPublicWeek(days) {
  const current = ensurePublicWeekSelection();
  const shifted = addDays(current, days);
  const bounded = clampWeekStartToBounds(shifted, getSchoolYearBounds());
  state.selectedPublicWeekStart = toIsoDate(bounded);
}

function getPublicWeekContext() {
  const weekStart = ensurePublicWeekSelection();
  const weekEnd = addDays(weekStart, 4);
  const bounds = getSchoolYearBounds();
  const inYear = bounds ? weekStart >= bounds.startMonday && weekStart <= bounds.endMonday : true;

  const weekType = getWeekTypeForMonday(weekStart);

  const vacations = Array.isArray(state.schoolYearConfig?.vacations) ? state.schoolYearConfig.vacations : [];
  const holidays = Array.isArray(state.schoolYearConfig?.holidays) ? state.schoolYearConfig.holidays : [];

  const vacationLabels = vacations
    .filter((v) => v?.startDate && v?.endDate && !(v.endDate < toIsoDate(weekStart) || v.startDate > toIsoDate(weekEnd)))
    .map((v) => String(v.label || "Vacances"));

  const holidayLabels = holidays
    .filter((h) => h?.date && h.date >= toIsoDate(weekStart) && h.date <= toIsoDate(weekEnd))
    .map((h) => String(h.label || "Jour férié"));

  return {
    weekStart,
    weekEnd,
    weekStartIso: toIsoDate(weekStart),
    weekEndIso: toIsoDate(weekEnd),
    weekType,
    inYear,
    vacationLabels,
    holidayLabels,
  };
}

async function submitReplacementOffer(absenceId, sessionId) {
  if (!ui.publicAbsenceSummary) return;
  if (!state.currentUserTeacherId) {
    ui.publicAbsenceSummary.textContent = "Connectez-vous en mode enseignant pour proposer un remplacement.";
    return;
  }
  const absence = state.absences.find((a) => a.id === absenceId);
  const session = state.sessions.find((s) => s.id === sessionId);
  if (!absence || !session) {
    ui.publicAbsenceSummary.textContent = "Créneau d'absence introuvable.";
    return;
  }
  if (absence.teacherId === state.currentUserTeacherId) {
    ui.publicAbsenceSummary.textContent = "Vous ne pouvez pas vous proposer sur votre propre créneau.";
    return;
  }

  const candidateTeacher = state.teachers.find((t) => t.id === state.currentUserTeacherId);
  const check = evaluateReplacementCandidate(absence, session, candidateTeacher);
  if (!check.compatible) {
    ui.publicAbsenceSummary.textContent = `Candidature impossible: ${check.reason}`;
    return;
  }

  const existing = state.replacementOffers.find(
    (o) => o.absenceId === absenceId && o.sessionId === sessionId && o.candidateTeacherId === state.currentUserTeacherId
  );
  if (existing && String(existing.status || "").toUpperCase() === "PENDING") {
    ui.publicAbsenceSummary.textContent = "Vous avez déjà une candidature en attente sur ce créneau.";
    return;
  }

  try {
    if (existing) {
      await updateDoc(doc(db, "replacementOffers", existing.id), {
        status: "PENDING",
        updatedAt: serverTimestamp(),
      });
    } else {
      await addDoc(collection(db, "replacementOffers"), {
        schoolYearId: getActiveSchoolYearId(),
        absenceId,
        sessionId,
        candidateTeacherId: state.currentUserTeacherId,
        status: "PENDING",
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    }
    ui.publicAbsenceSummary.textContent = "Votre candidature de remplacement a été envoyée.";
  } catch (error) {
    ui.publicAbsenceSummary.textContent = `Erreur candidature: ${error?.message || "enregistrement impossible."}`;
  }
}

function renderPublicAbsenceRequests(week) {
  if (!ui.publicAbsenceRequestsContainer || !ui.publicAbsenceSummary) return;
  if (ui.publicOpenReplacementModalBtn) {
    const canUse = Boolean(state.currentUserTeacherId);
    ui.publicOpenReplacementModalBtn.disabled = !canUse;
    ui.publicOpenReplacementModalBtn.title = canUse ? "Afficher mon EDT et mes opportunités" : "Connectez-vous en mode enseignant";
  }
  const vacationDays = getVacationDaySetForWeek(week?.weekStart);
  const weekSessions = state.sessions.filter((s) => isSessionVisibleForWeek(s, week.weekType) && !vacationDays.has(String(s.day || "")));
  const absentEntries = weekSessions
    .map((session) => {
      const absence = isSessionAbsentForWeek(session, week.weekStart);
      if (!absence) return null;
      const absentTeacher = state.teachers.find((t) => t.id === session.teacherId);
      const replacement = state.replacements.find((r) => r.absenceId === absence.id && r.sessionId === session.id);
      const replacementTeacher = state.teachers.find((t) => t.id === replacement?.toTeacherId);
      const offers = state.replacementOffers.filter(
        (o) => o.absenceId === absence.id && o.sessionId === session.id && String(o.status || "").toUpperCase() === "PENDING"
      );
      return { session, absence, absentTeacher, replacementTeacher, offersCount: offers.length };
    })
    .filter(Boolean)
    .sort((a, b) => DAYS.indexOf(a.session.day) - DAYS.indexOf(b.session.day) || String(a.session.start || "").localeCompare(String(b.session.start || ""), "fr"));

  if (!absentEntries.length) {
    ui.publicAbsenceSummary.innerHTML = `<span class="hours-ok">Aucune absence déclarée sur cette semaine.</span>`;
    ui.publicAbsenceRequestsContainer.innerHTML = `<p class="summary-box">Aucun créneau absent.</p>`;
    return;
  }

  const currentTeacherId = String(state.currentUserTeacherId || "");
  const rows = absentEntries
    .map((entry) => {
      const { session, absence, absentTeacher, replacementTeacher, offersCount } = entry;
      const currentTeacher = state.teachers.find((t) => t.id === currentTeacherId);
      const check = currentTeacher ? evaluateReplacementCandidate(absence, session, currentTeacher) : null;
      const ownPending = state.replacementOffers.some(
        (o) =>
          o.absenceId === absence.id &&
          o.sessionId === session.id &&
          o.candidateTeacherId === currentTeacherId &&
          String(o.status || "").toUpperCase() === "PENDING"
      );
      const canPropose =
        Boolean(currentTeacherId) &&
        currentTeacherId !== absence.teacherId &&
        !replacementTeacher &&
        !ownPending &&
        Boolean(check?.compatible);

      const actionHtml = replacementTeacher
        ? `<span class="hours-ok">Remplacé par ${escapeHtml(replacementTeacher.name || "—")}</span>`
        : currentTeacherId
          ? canPropose
            ? `<button type="button" class="secondary-btn" data-public-propose="${escapeHtml(absence.id)}|${escapeHtml(session.id)}">Je me propose</button>`
            : ownPending
              ? `<span class="hours-ok">Candidature envoyée</span>`
              : `<span class="hours-over">${escapeHtml(check?.reason || "Non compatible")}</span>`
          : `<button type="button" class="secondary-btn" data-open-login-modal="1">Se connecter (enseignant)</button>`;

      return `<tr class="absence-public-row">
        <td data-label="Créneau">${escapeHtml(session.day)} ${escapeHtml(session.start)}</td>
        <td data-label="Classe">${escapeHtml(getClassLabelById(session.classId, true))}</td>
        <td data-label="Absence"><strong class="hours-over">${escapeHtml(absentTeacher?.name || "Prof absent")}</strong></td>
        <td data-label="Candidatures">${offersCount}</td>
        <td data-label="Action">${actionHtml}</td>
      </tr>`;
    })
    .join("");

  ui.publicAbsenceSummary.innerHTML = `<span class="hours-over">${absentEntries.length}</span> créneau(x) en absence sur cette semaine.`;
  ui.publicAbsenceRequestsContainer.innerHTML = `
    <table class="absence-table public-absence-table">
      <thead>
        <tr><th>Créneau</th><th>Classe</th><th>Absence</th><th>Candidatures</th><th>Action</th></tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  `;

  ui.publicAbsenceRequestsContainer.querySelectorAll("[data-public-propose]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const [absenceId, sessionId] = String(btn.dataset.publicPropose || "").split("|");
      await submitReplacementOffer(absenceId, sessionId);
      renderPublicAbsenceRequests(getPublicWeekContext());
    });
  });
  ui.publicAbsenceRequestsContainer.querySelectorAll("[data-open-login-modal]").forEach((btn) => {
    btn.addEventListener("click", () => {
      if (ui.loginModal) ui.loginModal.classList.remove("hidden");
      if (ui.loginError) ui.loginError.textContent = "";
      if (ui.loginMessage) ui.loginMessage.textContent = "";
    });
  });
}

function closePublicReplacementModal() {
  if (!ui.publicReplacementModal) return;
  ui.publicReplacementModal.classList.add("hidden");
}

function openPublicReplacementModal() {
  if (!ui.publicReplacementModal || !ui.publicReplacementModalBody || !ui.publicReplacementModalContext) return;
  if (!state.currentUserTeacherId) {
    ui.publicReplacementModalContext.textContent = "Connectez-vous en mode enseignant pour voir vos opportunités.";
    ui.publicReplacementModalBody.innerHTML = `<p class="summary-box">Aucun enseignant connecté.</p>`;
    ui.publicReplacementModal.classList.remove("hidden");
    return;
  }

  const week = getPublicWeekContext();
  const vacationDays = getVacationDaySetForWeek(week.weekStart);
  const teacherId = state.currentUserTeacherId;
  const teacher = state.teachers.find((t) => t.id === teacherId);
  const teacherSessions = state.sessions.filter((s) => {
    if (s.teacherId !== teacherId) return false;
    if (vacationDays.has(String(s.day || ""))) return false;
    return true;
  });
  const teacherReplacements = getReplacementEntriesForWeek(week, teacherId);
  const absentEntries = state.sessions
    .filter((s) => isSessionVisibleForWeek(s, week.weekType))
    .map((session) => {
      const absence = isSessionAbsentForWeek(session, week.weekStart);
      if (!absence) return null;
      if (absence.teacherId === teacherId) return null;
      const replacement = state.replacements.find((r) => r.absenceId === absence.id && r.sessionId === session.id);
      if (replacement) return null;
      const evalInfo = evaluateReplacementCandidate(absence, session, teacher);
      const ownPending = state.replacementOffers.some(
        (o) =>
          o.absenceId === absence.id &&
          o.sessionId === session.id &&
          o.candidateTeacherId === teacherId &&
          String(o.status || "").toUpperCase() === "PENDING"
      );
      return { session, absence, evalInfo, ownPending };
    })
    .filter(Boolean);

  ui.publicReplacementModalContext.textContent = `${teacher?.name || "Enseignant"} - Semaine ${week.weekType} (${formatDateFrShort(week.weekStart)} au ${formatDateFrShort(week.weekEnd)})`;

  const slotMap = new Map();
  for (const day of DAYS) {
    for (const band of SLOT_BANDS) {
      slotMap.set(toSlotKey(day, band.start), []);
    }
  }

  teacherSessions.forEach((s) => {
    const segments = getSessionBandSegments(s);
    const classLabel = getClassLabelById(s.classId);
    const cadenceTag = normalizeCadence(s.cadence) === "BIWEEKLY" ? ` (${normalizeWeekType(s.weekType)})` : "";
    segments.forEach((seg) => {
      const segClass = getSessionSegmentClassName(seg);
      slotMap
        .get(toSlotKey(seg.day, seg.bandStart))
        ?.push(`<div class="slot-block slot-block-own-teacher${segClass}" style="${escapeHtml(getTeacherBlockStyle(teacherId))}">${seg.showContent === false ? "" : escapeHtml(`Mon cours - ${classLabel}${cadenceTag}`)}</div>`);
    });
  });

  teacherReplacements.forEach((entry) => {
    const segments = getSessionBandSegments(entry.session);
    const classLabel = getClassLabelById(entry.session.classId, true);
    const fromCode = getTeacherDisplayLabel(entry.fromTeacher);
    segments.forEach((seg) => {
      const segClass = getSessionSegmentClassName(seg);
      slotMap
        .get(toSlotKey(seg.day, seg.bandStart))
        ?.push(`<div class="slot-block slot-block-replacement${segClass}" style="${escapeHtml(getTeacherBlockStyle(teacherId))}">${seg.showContent === false ? "" : escapeHtml(`Remp ${fromCode} - ${classLabel}`)}</div>`);
    });
  });

  absentEntries.forEach((entry) => {
    const session = entry.session;
    const absentTeacher = state.teachers.find((t) => t.id === session.teacherId);
    const segments = getSessionBandSegments(session);
    segments.forEach((seg) => {
      const segClass = getSessionSegmentClassName(seg);
      const canPropose = Boolean(entry.evalInfo?.compatible);
      const btn = !canPropose
        ? `<span class="hours-over">${escapeHtml(entry.evalInfo?.reason || "Incompatible")}</span>`
        : entry.ownPending
        ? `<span class="hours-ok">Candidature envoyée</span>`
        : `<button type="button" class="secondary-btn" data-modal-public-propose="${escapeHtml(entry.absence.id)}|${escapeHtml(session.id)}">Je me propose</button>`;
      const blockClass = canPropose ? "replacement-opportunity-block" : "replacement-opportunity-block replacement-opportunity-block-incompatible";
      slotMap.get(toSlotKey(seg.day, seg.bandStart))?.push(`
        <div class="${blockClass}${segClass}">
          ${seg.showContent === false ? "" : `<strong>Remplacement possible</strong>
          <span>${escapeHtml(getClassLabelById(session.classId, true))}</span>
          <small>Absent: ${escapeHtml(absentTeacher?.name || "Professeur")} - ${canPropose ? `Score ${entry.evalInfo.score}/100` : "Non compatible"}</small>
          ${btn}`}
        </div>
      `);
    });
  });

  const head = `<tr><th>Heure</th>${DAYS.map((d) => `<th>${d}</th>`).join("")}</tr>`;
  const rows = SLOT_BANDS.map((band) => {
    const cells = DAYS.map((day) => `<td class="slot">${(slotMap.get(toSlotKey(day, band.start)) || []).join("")}</td>`).join("");
    return `<tr><th>${band.label}</th>${cells}</tr>`;
  }).join("");

  const shouldRenderTable = absentEntries.length || teacherSessions.length || teacherReplacements.length;
  ui.publicReplacementModalBody.innerHTML = shouldRenderTable
    ? `<table class="replacement-opportunity-table">${head}${rows}</table>`
    : `<p class="summary-box">Aucun créneau disponible pour vous cette semaine.</p>`;

  ui.publicReplacementModalBody.querySelectorAll("[data-modal-public-propose]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const [absenceId, sessionId] = String(btn.dataset.modalPublicPropose || "").split("|");
      await submitReplacementOffer(absenceId, sessionId);
      renderPublicAbsenceRequests(getPublicWeekContext());
      openPublicReplacementModal();
    });
  });

  ui.publicReplacementModal.classList.remove("hidden");
}

function renderPublic() {
  // Vérifier si l'EDT est publiée
  if (!state.schoolYearConfig?.isPublished) {
    ui.publicTimetableContainer.innerHTML = `
      <div class="summary-box" style="border-left: 4px solid #ff9800; background: #fff8f0;">
        <strong>📵 EDT non publiée</strong><br>
        <span style="color: #666; font-size: 0.9em;">L'emploi du temps sera disponible une fois terminé.</span>
      </div>
    `;
    return;
  }

  const week = getPublicWeekContext();
  const vacationDays = getVacationDaySetForWeek(week.weekStart);
  const allMode = state.selectedPublicTeacherId === "__ALL__";
  const teacher = state.teachers.find((t) => t.id === state.selectedPublicTeacherId);
  if (!allMode && !teacher) {
    if (ui.publicTeacherSummary) ui.publicTeacherSummary.innerHTML = "Aucun professeur disponible.";
    if (ui.publicDashboardIntro) ui.publicDashboardIntro.textContent = "Aucun enseignant disponible pour l'année scolaire sélectionnée.";
    ui.publicTimetableContainer.innerHTML = "";
    return;
  }

  if (ui.publicWeekDate) ui.publicWeekDate.value = toIsoDate(week.weekStart);
  if (ui.publicWeekLabel) {
    ui.publicWeekLabel.innerHTML = `
      <span class="public-chip public-chip-week">Semaine du ${formatDateFrShort(week.weekStart)} au ${formatDateFrShort(week.weekEnd)}</span>
      <span class="public-chip public-chip-type">Type ${week.weekType}</span>
    `;
  }
  if (ui.publicWeekMeta) {
    const parts = [];
    if (!week.inYear) parts.push(`<span class="hours-over">Hors plage d'année scolaire configurée.</span>`);
    if (week.vacationLabels.length) parts.push(`Vacances: ${escapeHtml(Array.from(new Set(week.vacationLabels)).join(", "))}`);
    if (week.holidayLabels.length) parts.push(`Jours fériés: ${escapeHtml(Array.from(new Set(week.holidayLabels)).join(", "))}`);
    ui.publicWeekMeta.innerHTML = parts.length ? parts.join(" - ") : ``;
    ui.publicWeekMeta.classList.toggle("hidden", parts.length === 0);
  }

  const sourceSessions = allMode ? state.sessions : state.sessions.filter((s) => s.teacherId === teacher.id);
  const rawSessions = sourceSessions.filter((s) => isSessionVisibleForWeek(s, week.weekType));
  const rawReplacementEntries = getReplacementEntriesForWeek(week, allMode ? "" : teacher.id);

  // Déterminer le trimestre actuel pour afficher les bonnes activités
  const currentTrimester = getCurrentTrimester();

  const sessions = rawSessions
    .filter((s) => !vacationDays.has(String(s.day || "")))
    .map((s) => {
      // Afficher l'activité du trimestre actuel si disponible
      if (currentTrimester) {
        const plan = getClassActivityPlan(s.classId);
        if (plan) {
          const planned = getAnnualPlanDisplayValue(plan, s.classId, currentTrimester, "activity", "");
          if (planned) {
            // Créer une copie avec l'activité programmée pour la période actuelle
            return { ...s, activityLabel: planned };
          }
        }
      }
      return s;
    })
    .sort(sortSessionsBySlotOrder);
  const replacementEntries = rawReplacementEntries.filter((entry) => !vacationDays.has(String(entry.session?.day || "")));
  if (allMode) {
    if (ui.publicTeacherSummary) {
      ui.publicTeacherSummary.innerHTML = `<strong>Vue globale</strong><br>${state.teachers.length} enseignants affichés · ${sessions.length} créneau(x) cette semaine · ${replacementEntries.length} remplacement(s)`;
    }
  } else {
    const used = sessions.reduce((acc, s) => acc + Number(s.duration || 0), 0);
    const replacementHours = replacementEntries.reduce((acc, entry) => acc + Number(entry.session.duration || 0), 0);
    const totalProjected = used + replacementHours;
    const over = totalProjected > Number(teacher.maxHours || 0);
    if (ui.publicTeacherSummary) {
      ui.publicTeacherSummary.innerHTML = `
        <strong>${escapeHtml(teacher.name)}</strong><br>
        Heures cette semaine: <span class="${over ? "hours-over" : "hours-ok"}">${formatHours(totalProjected)}/${formatHours(teacher.maxHours)}h</span>
        ${replacementEntries.length ? `<br><span class="hours-ok">${replacementEntries.length} remplacement(s) planifié(s)</span>` : ""}
      `;
    }
  }

  if (ui.publicDashboardTitle) {
    ui.publicDashboardTitle.textContent = allMode ? "EDT global" : `EDT - ${teacher?.name || ""}`;
  }
  if (ui.publicDashboardStats) {
    const visibleTeachers = allMode ? state.teachers.length : 1;
    const stats = [
      {
        label: "Semaine",
        value: `${formatDateFrShort(week.weekStart)} - ${formatDateFrShort(week.weekEnd)}`,
        tone: "neutral",
      },
      {
        label: allMode ? "Enseignants" : "Créneaux",
        value: allMode ? String(visibleTeachers) : String(sessions.length),
        tone: "neutral",
      },
      {
        label: "Remplacements",
        value: String(replacementEntries.length),
        tone: replacementEntries.length ? "warning" : "neutral",
      },
      {
        label: allMode ? "Créneaux visibles" : "Charge",
        value: allMode ? String(sessions.length) : `${formatHours(sessions.reduce((acc, s) => acc + Number(s.duration || 0), 0))}h`,
        tone: "neutral",
      },
    ];
    ui.publicDashboardStats.innerHTML = stats
      .map(
        (item) => `
          <div class="dashboard-metric-card ${item.tone}">
            <span>${escapeHtml(item.label)}</span>
            <strong>${escapeHtml(item.value)}</strong>
          </div>
        `
      )
      .join("");
  }

  const grid = new Map();
  for (const day of DAYS) for (const band of getSlotBandsForDay(day)) grid.set(toSlotKey(day, band.start), []);
  for (const s of sessions) {
    const prof = state.teachers.find((t) => t.id === s.teacherId);
    const absence = isSessionAbsentForWeek(s, week.weekStart);
    const blockStyle = getTeacherBlockStyle(s.teacherId);
    const segments = getSessionBandSegments(s);
    const cadenceTag = normalizeCadence(s.cadence) === "BIWEEKLY" ? ` (${normalizeWeekType(s.weekType)})` : "";
    const teacherLabel = getTeacherDisplayLabel(prof);
    const classLabel = getClassLabelById(s.classId);
    const activity = getProgramActivities().find(a => a.label === s.activityLabel);
    const activityCode = activity?.code || s.activityLabel?.slice(0, 3).toUpperCase() || '';
    const text = allMode
      ? `${teacherLabel} - ${classLabel}${cadenceTag}`
      : `${classLabel}${cadenceTag}`;
    const css = "slot-block";
    for (const seg of segments) {
      const blockClass = `${css}${absence ? " slot-block-absent" : ""}`;
      const segClass = getSessionSegmentClassName(seg);
      const displayText = absence ? `ABSENCE - ${text}` : text;
      const textParts = allMode ? [String(displayText || "")] : String(displayText || "").split(" - ");
      const headText = textParts.shift() || displayText;
      const subText = textParts.join(" - ");
      const subTextWithCode = subText ? `${subText}${activityCode ? ` - ${activityCode}` : ""}` : activityCode;
      grid
        .get(toSlotKey(seg.day, seg.bandStart))
        ?.push({ html: `<div class="${blockClass}${segClass}" style="${escapeHtml(blockStyle)} cursor: pointer;" data-session-id="${escapeHtml(s.id)}" data-session-class="${escapeHtml(classLabel)}" data-session-prof="${escapeHtml(teacherLabel)}" data-session-activity="${escapeHtml(s.activityLabel)}" data-session-code="${escapeHtml(activityCode)}" data-session-start="${escapeHtml(s.start)}" data-session-duration="${s.duration}">
          ${seg.showContent === false ? "" : `<strong class="public-session-main">${escapeHtml(headText)}</strong>
          ${subTextWithCode ? `<small class="public-session-sub">${escapeHtml(subTextWithCode)}</small>` : ""}`}
        </div>`, cadence: s.cadence, weekType: s.weekType, teacherId: s.teacherId, sessionId: s.id, sessionClass: classLabel, sessionProf: teacherLabel, sessionActivity: s.activityLabel, sessionCode: activityCode, sessionStart: s.start, sessionDuration: s.duration });
    }
  }

  for (const entry of replacementEntries) {
    const { session, fromTeacher, toTeacher } = entry;
    const segments = getSessionBandSegments(session);
    const blockStyle = getTeacherBlockStyle(toTeacher?.id || session.teacherId);
    const classLabel = getClassLabelById(session.classId, true);
    const fromCode = getTeacherDisplayLabel(fromTeacher);
    const text = allMode
      ? `${getTeacherDisplayLabel(toTeacher)} - Remp ${fromCode} - ${classLabel}`
      : `Remp ${fromCode} - ${classLabel}`;
    for (const seg of segments) {
      const segClass = getSessionSegmentClassName(seg);
      const textParts = allMode ? [String(text || "")] : String(text || "").split(" - ");
      const headText = textParts.shift() || text;
      const subText = textParts.join(" - ");
      grid
        .get(toSlotKey(seg.day, seg.bandStart))
        ?.push({ html: `<div class="slot-block slot-block-replacement${segClass}" style="${escapeHtml(blockStyle)}">
          ${seg.showContent === false ? "" : `<strong class="public-session-main">${escapeHtml(headText)}</strong>
          ${subText ? `<small class="public-session-sub">${escapeHtml(subText)}</small>` : ""}`}
        </div>`, cadence: session.cadence, weekType: session.weekType, teacherId: toTeacher?.id || session.teacherId });
    }
  }

  // ── Rendu slot-par-slot avec décalage vendredi ───────────────────────────
  // Chaque ligne = 1 slot. Les bandes multi-slots utilisent rowspan.
  // Col gauche = label horaire standard. Col droite = label vendredi spécifique.
  const standardBands = SLOT_BANDS.filter(b => !b.fridayOnly);
  const fridayBands   = getSlotBandsForDay("Vendredi");

  // Pré-calcule, pour chaque slot, la bande dont il est le START (ou null si absorbé)
  const stdBandBySlotStart  = new Map(standardBands.map(b => [b.start, b]));
  const friiBandBySlotStart = new Map(fridayBands.map(b => [b.start, b]));
  // Slots absorbés = slots non-start d'une bande
  const stdAbsorbed  = new Set(standardBands.flatMap(b => b.slots.slice(1)));
  const friAbsorbed  = new Set(fridayBands.flatMap(b => b.slots.slice(1)));
  // Colonne droite : label vendredi + rowspan
  const friRightByStart = new Map();
  for (const b of fridayBands) {
    if (b.start >= "13:00") { // seulement l'après-midi
      friRightByStart.set(b.start, { label: b.label, rowspan: b.slots.length });
    }
  }

  const head = `<tr>
    <th></th>
    ${DAYS.map(d => `<th class="${vacationDays.has(d) ? "vacation-day-head" : ""}">${d}</th>`).join("")}
    <th class="friday-time-th"></th>
  </tr>`;

  const rows = SLOTS.map(slot => {
    const stdBand  = stdBandBySlotStart.get(slot);   // non-null si ce slot est un start standard
    const friiBand = friiBandBySlotStart.get(slot);  // non-null si ce slot est un start vendredi
    const stdAbs   = stdAbsorbed.has(slot);          // ce slot est absorbé côté standard
    const friAbs   = friAbsorbed.has(slot);          // ce slot est absorbé côté vendredi
    const friRight = friRightByStart.get(slot);

    // Ligne entièrement absorbée (ex: 09:05, 11:10) : renvoyer un <tr> VIDE mais réel.
    // Les cellules rowspan=2 au-dessus ont besoin que la ligne physique existe dans le DOM,
    // sinon le rowspan déborde sur la ligne suivante et décale tout le tableau.
    if (!stdBand && stdAbs && !friiBand && friAbs && !friRight) {
      return `<tr class="timetable-absorbed-row"></tr>`;
    }

    // Col gauche (label standard)
    let leftTh = "";
    if (stdBand) {
      const rs = stdBand.slots.length > 1 ? ` rowspan="${stdBand.slots.length}"` : "";
      leftTh = `<th class="time-label"${rs}>${stdBand.label}</th>`;
    } else if (!stdAbs) {
      leftTh = `<th class="time-label"></th>`; // slot sans bande standard définie
    }
    // Si stdAbs → pas de <th> (absorbé par rowspan au-dessus)

    // Cellules jours
    const dayCells = DAYS.map(day => {
      const isFriday = day === "Vendredi";
      const isVacation = vacationDays.has(day);

      if (isFriday) {
        if (friAbs) return null; // absorbé par rowspan au-dessus
        if (!friiBand) return `<td class="slot slot-friday-na"></td>`;
        const rs = friiBand.slots.length > 1 ? ` rowspan="${friiBand.slots.length}"` : "";
        const key = toSlotKey(day, friiBand.start);
        const swimCls = getBandSlotStarts(friiBand).some(s => hasSwimSlot(day, s)) ? " slot-swim" : "";
        const cls = isVacation ? "slot slot-vacation slot-friday-merged" : `slot slot-friday-merged${swimCls}`;
        return `<td class="${cls}"${rs}>${renderSlotBlocksWithBiweeklyLayout(grid.get(key) || [])}</td>`;
      } else {
        if (stdAbs) return null; // absorbé
        if (!stdBand) return `<td class="slot"></td>`;
        const rs = stdBand.slots.length > 1 ? ` rowspan="${stdBand.slots.length}"` : "";
        const key = toSlotKey(day, stdBand.start);
        const swimCls = getBandSlotStarts(stdBand).some(s => hasSwimSlot(day, s)) ? " slot-swim" : "";
        const cls = isVacation ? "slot slot-vacation" : `slot${swimCls}`;
        return `<td class="${cls}"${rs}>${renderSlotBlocksWithBiweeklyLayout(grid.get(key) || [])}</td>`;
      }
    }).filter(c => c !== null).join("");

    // Col droite (label vendredi)
    let rightTd = "";
    if (friRight) {
      const rs = friRight.rowspan > 1 ? ` rowspan="${friRight.rowspan}"` : "";
      rightTd = `<td class="friday-time-td"${rs}>${friRight.label}</td>`;
    } else if (!friAbs) {
      // Sur les lignes non-vendredi (matin), afficher le même label que gauche
      if (stdBand) {
        const rs = stdBand.slots.length > 1 ? ` rowspan="${stdBand.slots.length}"` : "";
        rightTd = `<td class="friday-time-td friday-time-same"${rs}>${stdBand.label}</td>`;
      } else {
        rightTd = `<td class="friday-time-td"></td>`;
      }
    }
    // Si friAbs → pas de <td> droite

    return `<tr>${leftTh}${dayCells}${rightTd}</tr>`;
  }).filter(r => r !== null).join("");

  // Afficher le tableau
  ui.publicTimetableContainer.innerHTML = `<table class="public-timetable">${head}${rows}</table>`;

  // Ajouter les event listeners pour afficher les détails au clic
  ui.publicTimetableContainer.querySelectorAll('[data-session-id]').forEach(el => {
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      const sessionClass = el.dataset.sessionClass;
      const sessionProf = el.dataset.sessionProf;
      const sessionActivity = el.dataset.sessionActivity;
      const sessionCode = el.dataset.sessionCode;
      const sessionStart = el.dataset.sessionStart;
      const sessionDuration = el.dataset.sessionDuration;

      const durationMin = sessionDuration ? parseInt(sessionDuration) * 55 : 0;
      const startDate = new Date();
      const [h, m] = sessionStart.split(':').map(Number);
      startDate.setHours(h, m);
      const endDate = new Date(startDate);
      endDate.setMinutes(endDate.getMinutes() + durationMin);

      const timeStr = `${sessionStart} - ${endDate.getHours().toString().padStart(2, '0')}:${endDate.getMinutes().toString().padStart(2, '0')}`;

      alert(`Classe: ${sessionClass}\nProf: ${sessionProf}\nActivité: ${sessionActivity} (${sessionCode})\nHoraire: ${timeStr}`);
    });
  });

  renderPublicAbsenceRequests(week);
}

function renderAdminPlanner() {
  const container = ui.adminPlannerContainer;
  if (!container) return;
  const teacher = state.teachers.find((t) => t.id === state.selectedAdminTeacherId);
  if (!teacher) {
    ui.adminPlannerHint.textContent = "Sélectionnez un professeur.";
    container.innerHTML = "";
    return;
  }

  const usedHours = state.sessions
    .filter((s) => s.teacherId === teacher.id)
    .reduce((acc, s) => acc + weeklyEquivalentHours(s), 0);
  const maxHours = Number(teacher.maxHours || 0);
  const over = usedHours > maxHours;
  const desiderataNote = getPersistedDesiderataCommentForTeacher(teacher.id);

  let infoHtml = `<div class="assign-teacher-summary minimal">`;

  // Heures
  infoHtml += `<p style="margin: 0; font-size: 0.9rem;"><strong>Heures:</strong> ${formatHours(usedHours)}h / ${formatHours(maxHours)}h</p>`;

  // Commentaire
  if (desiderataNote) {
    infoHtml += `
      <div class="clickable-comment teacher-comment-box" data-teacher-id="${teacher.id}" data-comment="${escapeHtml(desiderataNote)}" style="background: #f9f3e6; border-left: 4px solid #f59f00; padding: 1rem; border-radius: 4px; margin-top: 0.75rem; cursor: pointer; max-height: 200px; overflow-y: auto;">
        <strong style="color: #f59f00; display: block; margin-bottom: 0.75rem;">📝 Commentaire enseignant</strong>
        <p style="margin: 0; white-space: pre-wrap; font-size: 0.85rem; line-height: 1.5;">${escapeHtml(desiderataNote)}</p>
      </div>
    `;
  } else {
    infoHtml += `<p style="margin: 0.75rem 0 0 0; color: #999; font-size: 0.85rem;"><em>Aucun commentaire</em></p>`;
  }

  infoHtml += `</div>`;
  ui.adminPlannerHint.innerHTML = infoHtml;

  const sessions = state.sessions
    .filter((s) => s.teacherId === teacher.id)
    .filter((s) => doesSessionMatchAssignFilters(s))
    .sort(sortSessionsBySlotOrder);
  const grid = new Map();
  for (const day of DAYS) for (const band of getSlotBandsForDay(day)) grid.set(toSlotKey(day, band.start), []);
  for (const s of sessions) {
    const blockStyle = getTeacherBlockStyle(s.teacherId);
    const segments = getSessionBandSegments(s);
    const cadenceTag = normalizeCadence(s.cadence) === "BIWEEKLY" ? ` (${normalizeWeekType(s.weekType)})` : "";
    const text = `${getClassLabelById(s.classId)}${cadenceTag}`;
    const css = "slot-block";
    for (const seg of segments) {
      const segClass = getSessionSegmentClassName(seg);
      grid
        .get(toSlotKey(seg.day, seg.bandStart))
        ?.push({
          html: renderSessionBlockHtml({
            sessionId: s.id,
            text,
            style: blockStyle,
            className: `${css}${segClass}`,
            cadence: s.cadence,
            weekType: s.weekType,
            showContent: seg.showContent !== false,
            showRemoveButton: seg.showContent !== false,
          }),
          cadence: s.cadence,
          weekType: s.weekType,
          teacherId: s.teacherId,
        });
    }
  }

  const standardBands = SLOT_BANDS.filter((b) => !b.fridayOnly);
  const fridayBands = getSlotBandsForDay("Vendredi");
  const stdBandBySlotStart = new Map(standardBands.map((b) => [b.start, b]));
  const friBandBySlotStart = new Map(fridayBands.map((b) => [b.start, b]));
  const stdAbsorbed = new Set(standardBands.flatMap((b) => b.slots.slice(1)));
  const friAbsorbed = new Set(fridayBands.flatMap((b) => b.slots.slice(1)));
  const friRightByStart = new Map();
  for (const b of fridayBands) {
    if (b.start >= "13:00") friRightByStart.set(b.start, { label: b.label, rowspan: b.slots.length });
  }

  const head = `<tr>
    <th></th>
    ${DAYS.map((d) => `<th>${d}</th>`).join("")}
    <th class="friday-time-th"></th>
  </tr>`;

  const rows = SLOTS.map((slot) => {
    const stdBand = stdBandBySlotStart.get(slot);
    const friBand = friBandBySlotStart.get(slot);
    const stdAbs = stdAbsorbed.has(slot);
    const friAbs = friAbsorbed.has(slot);
    const friRight = friRightByStart.get(slot);

    if (!stdBand && stdAbs && !friBand && friAbs && !friRight) {
      return `<tr class="timetable-absorbed-row"></tr>`;
    }

    let leftTh = "";
    if (stdBand) {
      const rs = stdBand.slots.length > 1 ? ` rowspan="${stdBand.slots.length}"` : "";
      leftTh = `<th class="time-label"${rs}>${stdBand.label}</th>`;
    } else if (!stdAbs) {
      leftTh = `<th class="time-label"></th>`;
    }

    const dayCells = DAYS.map((day) => {
      const isFriday = day === "Vendredi";
      const displayBand = isFriday ? friBand : stdBand;
      const absorbed = isFriday ? friAbs : stdAbs;
      if (absorbed) return null;
      if (!displayBand) return isFriday ? `<td class="slot slot-friday-na"></td>` : `<td class="slot"></td>`;

      const key = toSlotKey(day, displayBand.start);
      const blocks = grid.get(key) || [];
      const bandSlots = getBandSlotStarts(displayBand);
      const swimClass = bandSlots.some((s) => hasSwimSlot(day, s)) ? " slot-swim" : "";
      const isPreferred = bandSlots.some((s) => hasDesiderataSlot(teacher.id, day, s));
      const isUnavailable = bandSlots.some((s) => hasDesiderataUnavailableSlot(teacher.id, day, s));
      const isDayOff = bandSlots.some((s) => hasDesiderataDayOffSlot(teacher.id, day, s));
      const desiderataClass = isDayOff
        ? " slot-desiderata-dayoff"
        : isPreferred
        ? " slot-desiderata"
        : isUnavailable
        ? " slot-desiderata-unavailable"
        : "";

      const rs = displayBand.slots.length > 1 ? ` rowspan="${displayBand.slots.length}"` : "";
      return `<td class="slot${swimClass}${desiderataClass}${isFriday ? " slot-friday-merged" : ""}"
                  ${rs}
                  data-assign-drop-target="1"
                  data-teacher-id="${escapeHtml(teacher.id)}"
                  data-day="${escapeHtml(day)}"
                  data-slot="${escapeHtml(displayBand.start)}">
        ${renderSlotBlocksWithBiweeklyLayout(blocks)}
        <button class="slot-action slot-add-inline" data-teacher-id="${escapeHtml(teacher.id)}" data-day="${escapeHtml(day)}" data-slot="${escapeHtml(displayBand.start)}" type="button">+</button>
      </td>`;
    }).filter((c) => c !== null).join("");

    let rightTd = "";
    if (friRight) {
      const rs = friRight.rowspan > 1 ? ` rowspan="${friRight.rowspan}"` : "";
      rightTd = `<td class="friday-time-td"${rs}>${friRight.label}</td>`;
    } else if (!friAbs) {
      if (stdBand) {
        const rs = stdBand.slots.length > 1 ? ` rowspan="${stdBand.slots.length}"` : "";
        rightTd = `<td class="friday-time-td friday-time-same"${rs}>${stdBand.label}</td>`;
      } else {
        rightTd = `<td class="friday-time-td"></td>`;
      }
    }

    return `<tr>${leftTh}${dayCells}${rightTd}</tr>`;
  }).filter((r) => r !== null).join("");

  container.innerHTML = `<table class="timetable-shared timetable-slotwise teacher-planner-timetable">${head}${rows}</table>`;
  container.querySelectorAll("[data-assign-drop-target]").forEach((cell) => {
    cell.addEventListener("click", (e) => {
      if (e.target.closest("button")) return;
      selectAssignContext({
        kind: "slot",
        day: cell.dataset.day,
        slot: cell.dataset.slot,
        teacherId: cell.dataset.teacherId || teacher.id,
        source: "teacher",
      });
    });
  });
  
  // Bind actions
  container.querySelectorAll(".slot-action").forEach((btn) => {
    btn.addEventListener("click", () => {
      openQuickAssignWizardForSlot({
        teacherId: btn.dataset.teacherId || teacher.id,
        day: btn.dataset.day,
        slot: btn.dataset.slot,
        weekType: "A",
      });
    });
  });

  // Bind Drag & Drop logic
  container.querySelectorAll("[data-assign-drop-target]").forEach(cell => {
    const handleDropPayload = async (dropped) => {
      const teacherId = cell.dataset.teacherId;
      const day = cell.dataset.day;
      const slot = cell.dataset.slot;
      if (!teacherId || !day || !slot) return;
      if (dropped.kind === "session" && dropped.sessionId) {
        const result = await moveSessionByDrag(dropped.sessionId, teacherId, day, slot, { promptOnOverride: true });
        ui.sessionError.textContent = result.ok ? result.message : result.error;
        ui.sessionError.className = result.ok ? "error-text hours-ok" : "error-text hours-over";
        if (result.ok) {
          clearTouchAssignPayload();
          render();
        }
        return;
      }
      if (dropped.kind === "assign" && dropped.value) {
        await handleSmartAssign(teacherId, dropped.value, day, slot);
        clearTouchAssignPayload();
      }
    };
    cell.addEventListener("dragover", (e) => {
      e.preventDefault();
      cell.classList.add("assign-drop-ready");
    });
    cell.addEventListener("dragleave", () => {
      cell.classList.remove("assign-drop-ready");
    });
    cell.addEventListener("drop", async (e) => {
      e.preventDefault();
      cell.classList.remove("assign-drop-ready");
      const dropped = getDropPayloadFromEvent(e);
      await handleDropPayload(dropped);
    });
    cell.addEventListener("click", async () => {
      if (!state.touchAssignPayload?.payload) return;
      const dropped = getDropPayloadFromEvent({
        dataTransfer: { getData: (k) => (k === "text/plain" ? state.touchAssignPayload.payload : "") },
      });
      await handleDropPayload(dropped);
    });
  });

  bindSessionRemoveButtons(container);
  bindSessionDragStart(container);
}

async function handleSmartAssign(teacherId, classId, day, slot) {
  const resolvedClassId = resolveClassIdFromAssignPayload(classId, teacherId, day, slot, "A");
  if (!resolvedClassId) {
    ui.sessionError.textContent = "Aucune classe disponible pour ce niveau sur ce créneau.";
    ui.sessionError.className = "error-text hours-over";
    return;
  }

  let cadencePref = "AUTO";
  const cls = state.classes.find((c) => c.id === resolvedClassId);
  if (cls && getLevelRule(cls.level)?.group === "ALT_43") {
    const pick = await askCadencePreferenceForClass(resolvedClassId);
    if (!pick.ok) {
      ui.sessionError.textContent = pick.error || "Cadence indisponible pour cette classe.";
      ui.sessionError.className = "error-text hours-over";
      return;
    }
    cadencePref = pick.value;
  } else {
    // Proposition 4: Smart Cadence Detection pour les autres niveaux
    const targetKey = toSlotKey(day, slot);
    let hasA = false;
    let hasB = false;
    for (const s of state.sessions.slice().sort(sortSessionsBySlotOrder)) {
      if (s.teacherId !== teacherId) continue;
      const covered = getCoveredSlots(s.day, s.start, Number(s.duration || 0));
      if (covered.includes(targetKey)) {
        if (normalizeCadence(s.cadence) === "WEEKLY") {
          hasA = true;
          hasB = true;
        }
        if (normalizeWeekType(s.weekType) === "A") hasA = true;
        if (normalizeWeekType(s.weekType) === "B") hasB = true;
      }
    }
    if (hasA && !hasB) cadencePref = "WEEK_B";
    else if (hasB && !hasA) cadencePref = "WEEK_A";
    else if (!hasA && !hasB) cadencePref = "WEEKLY";
  }

  // Si c'est de l'AS, on incrémente l'ID
  const finalClassId = resolvedClassId === "__AS__" ? findNextAvailableASId() : resolvedClassId;

  const result = await quickAssignFromPlanner(teacherId, day, slot, finalClassId, cadencePref, { promptOnOverride: true });
  
  if (result.ok) {
    ui.sessionError.textContent = result.message;
    ui.sessionError.className = "error-text hours-ok";
    setTimeout(() => ui.sessionError.className = "error-text", 3000);
    render();
  } else {
    // Si l'auto-cadence a échoué (ex: déjà occupé), on tente de forcer l'autre semaine ou on affiche l'erreur
    ui.sessionError.textContent = result.error;
    ui.sessionError.className = "error-text hours-over";
  }
}

function renderGlobalPlanner() {
  const container = ui.globalPlannerContainer;
  if (!container) return;
  if (ui.assignEditLettersBtn) {
    ui.assignEditLettersBtn.textContent = state.assignLettersEditMode ? "Valider les lettres" : "Changer les lettres";
  }

  // If in letter edit mode, show table instead of grid
  if (state.assignLettersEditMode) {
    renderAssignLettersTableView();
    return;
  }

  const weekType = "A";
  const layout = state.selectedGlobalPlannerLayout === "EXCEL" ? "EXCEL" : "GRID";
  if (ui.globalWeekType) ui.globalWeekType.value = weekType;
  ui.globalPlannerLayout.value = layout;
  if (layout === "EXCEL") {
    renderGlobalPlannerExcel(weekType);
    return;
  }

  const grid = new Map();
  for (const day of DAYS) for (const band of getSlotBandsForDay(day)) grid.set(toSlotKey(day, band.start), []);

  for (const s of state.sessions.filter((session) => doesSessionMatchAssignFilters(session)).slice().sort(sortSessionsBySlotOrder)) {
    const teacher = state.teachers.find((t) => t.id === s.teacherId);
    const blockStyle = getTeacherBlockStyle(s.teacherId);
    const segments = getSessionBandSegments(s);
    const cadenceTag = normalizeCadence(s.cadence) === "BIWEEKLY" ? ` (${normalizeWeekType(s.weekType)})` : "";
    const classLabelHtml = getClassLabelWithDraftHtml(s.classId, getClassLabelById(s.classId));
    const label = `${getTeacherDisplayLabel(teacher)} - ${getClassLabelById(s.classId)}${cadenceTag}`;
    const labelHtml = `${escapeHtml(getTeacherDisplayLabel(teacher))} - ${classLabelHtml}${escapeHtml(cadenceTag)}`;
    for (const seg of segments) {
      grid.get(toSlotKey(seg.day, seg.bandStart))?.push({
        sessionId: s.id,
        teacherId: s.teacherId,
        classId: s.classId,
        label,
        labelHtml,
        type: s.type,
        blockStyle,
        cadence: s.cadence,
        weekType: s.weekType,
        segment: seg.segment,
        chainClass: seg.chainClass || "",
        showContent: seg.showContent !== false,
        segmentIndex: Number(seg.segmentIndex || 0),
      });
    }
  }

  const buildGlobalCellState = (entries) => {
    const reasonSet = new Set();
    if (entries.length > 0) {
      for (let i = 0; i < entries.length; i += 1) {
        for (let j = i + 1; j < entries.length; j += 1) {
          const a = entries[i];
          const b = entries[j];
          const sameTeacher = a.teacherId === b.teacherId;
          const sameRealClass =
            a.classId === b.classId && !isSpecialAssignmentId(a.classId) && !isSpecialAssignmentId(b.classId);
          const bothAS = isASLike(a) && isASLike(b);
          if (!sameTeacher && !sameRealClass) continue;
          if (bothAS) continue;
          if (
            !sessionsCanOccurSameWeek(
              { cadence: a.cadence, weekType: a.weekType },
              { cadence: b.cadence, weekType: b.weekType }
            )
          ) {
            continue;
          }
          if (sameTeacher) {
            const teacher = state.teachers.find((t) => t.id === a.teacherId);
            reasonSet.add(`enseignant ${getTeacherDisplayLabel(teacher)}`);
          }
          if (sameRealClass) {
            reasonSet.add(`classe ${getClassLabelById(a.classId)}`);
          }
        }
      }
    }

    let cellConflict = false;
    const blocks = entries
      .map((e) => {
        const conflict = entries.some((other) => {
          if (other.sessionId === e.sessionId) return false;
          const sameTeacher = other.teacherId === e.teacherId;
          const sameRealClass =
            other.classId === e.classId && !isSpecialAssignmentId(other.classId) && !isSpecialAssignmentId(e.classId);
          const bothAS = isASLike(other) && isASLike(e);
          const sameTeacherOrClass = sameTeacher || sameRealClass;
          if (!sameTeacherOrClass) return false;
          if (bothAS) return false;
          return sessionsCanOccurSameWeek(
            { cadence: e.cadence, weekType: e.weekType },
            { cadence: other.cadence, weekType: other.weekType }
          );
        });
        if (conflict) cellConflict = true;
        const baseClass = "slot-block global-stacked-block";
        const segClass = getSessionSegmentClassName(e);
        return renderSessionBlockHtml({
          sessionId: e.sessionId,
          text: e.label,
          textHtml: e.labelHtml || "",
          style: e.blockStyle,
          className: `${baseClass}${segClass}${conflict ? " conflict-block" : ""}`,
          cadence: e.cadence,
          weekType: e.weekType,
          extraContent: "",
          showContent: e.showContent !== false,
          showRemoveButton: e.showContent !== false,
        });
      })
      .map((html, idx) => ({
        html,
        cadence: entries[idx]?.cadence,
        weekType: entries[idx]?.weekType,
        teacherId: entries[idx]?.teacherId,
      }));

    let occupancyClass = "";
    const relevantClasses = entries.filter((e) => {
      const cls = state.classes.find((c) => c.id === e.classId);
      return !cls || getLevelRule(cls.level)?.group !== "CINQUIEME";
    });
    const classesCount = relevantClasses.length;
    if (classesCount === 4) occupancyClass = " slot-occupancy-4";
    else if (classesCount >= 5) occupancyClass = " slot-occupancy-5plus";

    return {
      cellConflict,
      reasonText: Array.from(reasonSet).join(", "),
      blocks,
      occupancyClass,
    };
  };

  let conflictsCount = 0;
  const conflictDetails = [];
  const standardBands = SLOT_BANDS.filter((b) => !b.fridayOnly);
  const fridayBands = getSlotBandsForDay("Vendredi");
  const stdBandBySlotStart = new Map(standardBands.map((b) => [b.start, b]));
  const friBandBySlotStart = new Map(fridayBands.map((b) => [b.start, b]));
  const stdAbsorbed = new Set(standardBands.flatMap((b) => b.slots.slice(1)));
  const friAbsorbed = new Set(fridayBands.flatMap((b) => b.slots.slice(1)));
  const friRightByStart = new Map();
  for (const b of fridayBands) {
    if (b.start >= "13:00") friRightByStart.set(b.start, { label: b.label, rowspan: b.slots.length });
  }

  const head = `<tr>
    <th></th>
    ${DAYS.map((d) => `<th>${d}</th>`).join("")}
    <th class="friday-time-th"></th>
  </tr>`;
  const rows = SLOTS.map((slot) => {
    const stdBand = stdBandBySlotStart.get(slot);
    const friBand = friBandBySlotStart.get(slot);
    const stdAbs = stdAbsorbed.has(slot);
    const friAbs = friAbsorbed.has(slot);
    const friRight = friRightByStart.get(slot);

    if (!stdBand && stdAbs && !friBand && friAbs && !friRight) {
      return `<tr class="timetable-absorbed-row"></tr>`;
    }

    let leftTh = "";
    if (stdBand) {
      const rs = stdBand.slots.length > 1 ? ` rowspan="${stdBand.slots.length}"` : "";
      leftTh = `<th class="time-label"${rs}>${stdBand.label}</th>`;
    } else if (!stdAbs) {
      leftTh = `<th class="time-label"></th>`;
    }

    const dayCells = DAYS.map((day) => {
      const isFriday = day === "Vendredi";
      const displayBand = isFriday ? friBand : stdBand;
      const absorbed = isFriday ? friAbs : stdAbs;
      if (absorbed) return null;
      if (!displayBand) return isFriday ? `<td class="slot slot-friday-na"></td>` : `<td class="slot"></td>`;

      const rs = displayBand.slots.length > 1 ? ` rowspan="${displayBand.slots.length}"` : "";
      const key = toSlotKey(day, displayBand.start);
      const entries = grid.get(key) || [];
      const hasSwim = getBandSlotStarts(displayBand).some((s) => hasSwimSlot(day, s));
      const swimClass = hasSwim ? " slot-swim" : "";
      const { cellConflict, reasonText, blocks, occupancyClass } = buildGlobalCellState(entries);

      if (state.assignFilters.conflictsOnly && !cellConflict) {
        return `<td class="slot assign-filter-muted${isFriday ? " slot-friday-merged" : ""}"
                  ${rs}
                  data-assign-drop-target="1"
                  data-day="${escapeHtml(day)}"
                  data-slot="${escapeHtml(displayBand.start)}"></td>`;
      }

      if (cellConflict) {
        conflictsCount += 1;
        conflictDetails.push(`${day} ${displayBand.label}: ${reasonText || "conflit de superposition"}`);
      }

      const actionBtn = entries.length > 0
        ? `<button class="slot-action slot-add-inline global-slot-action" data-day="${escapeHtml(day)}" data-slot="${escapeHtml(displayBand.start)}" type="button">+</button>`
        : renderGlobalEmptyCell(day, displayBand.start, weekType);

      // Style de fond si filtre prof actif et cellule contient ce prof
      let bgStyle = "";
      if (state.assignFilters.teacherId && entries.length > 0) {
        const teacher = state.teachers.find(t => t.id === state.assignFilters.teacherId);
        if (teacher) {
          const color = getTeacherColor(teacher);

          // Calculer le pourcentage de la case à remplir basé sur la durée du cours
          let fillPercent = 100;
          if (entries.length > 0) {
            const firstEntry = entries[0];
            // Chercher la session réelle pour obtenir endTime
            const session = state.sessions.find(s => s.id === firstEntry.sessionId);
            if (session && session.endTime) {
              // Durée du cours en minutes
              const [startH, startM] = session.startTime.split(':').map(Number);
              const [endH, endM] = session.endTime.split(':').map(Number);
              const courseDuration = (endH * 60 + endM) - (startH * 60 + startM);

              // Durée du créneau en minutes (à partir du band)
              const bandSlots = displayBand.slots;
              const [bandStartH, bandStartM] = bandSlots[0].split(':').map(Number);
              const [bandEndH, bandEndM] = bandSlots[bandSlots.length - 1].split(':').map(Number);
              const bandDuration = (bandEndH * 60 + bandEndM) - (bandStartH * 60 + bandStartM);

              if (bandDuration > 0) {
                fillPercent = Math.round((courseDuration / bandDuration) * 100);
                fillPercent = Math.min(100, Math.max(10, fillPercent)); // Min 10%, max 100%
              }
            }
          }

          bgStyle = `style="background: linear-gradient(to bottom, ${color}44 0%, ${color}44 ${fillPercent}%, transparent ${fillPercent}%, transparent 100%);"`;
        }
      }

      return `<td class="slot${cellConflict ? " slot-conflict" : ""}${swimClass}${occupancyClass}${isFriday ? " slot-friday-merged" : ""}"
                  ${rs}
                  ${bgStyle}
                  data-assign-drop-target="1"
                  data-day="${escapeHtml(day)}"
                  data-slot="${escapeHtml(displayBand.start)}">
          ${renderSlotBlocksWithBiweeklyLayout(blocks)}
          ${actionBtn}
        </td>`;
    }).filter((c) => c !== null).join("");

    let rightTd = "";
    if (friRight) {
      const rs = friRight.rowspan > 1 ? ` rowspan="${friRight.rowspan}"` : "";
      rightTd = `<td class="friday-time-td"${rs}>${friRight.label}</td>`;
    } else if (!friAbs) {
      if (stdBand) {
        const rs = stdBand.slots.length > 1 ? ` rowspan="${stdBand.slots.length}"` : "";
        rightTd = `<td class="friday-time-td friday-time-same"${rs}>${stdBand.label}</td>`;
      } else {
        rightTd = `<td class="friday-time-td"></td>`;
      }
    }

    return `<tr>${leftTh}${dayCells}${rightTd}</tr>`;
  }).filter((r) => r !== null).join("");

  if (conflictsCount > 0) {
    const shown = conflictDetails.slice(0, 4).map((x) => `<li>${escapeHtml(x)}</li>`).join("");
    const more = conflictDetails.length > 4 ? `<p>+${conflictDetails.length - 4} autre(s) conflit(s).</p>` : "";
    if (ui.globalPlannerHint) {
      ui.globalPlannerHint.innerHTML = `
        <span class="hours-over">${conflictsCount} créneau(x) en conflit détecté(s)</span> (vue conjointe semaines A + B).<br>
        <strong>Détail :</strong>
        <ul>${shown}</ul>
        ${more}
      `;
    }
  } else if (ui.globalPlannerHint) {
    ui.globalPlannerHint.innerHTML = `<span class="hours-ok">Aucun conflit détecté</span> (vue conjointe semaines A + B).`;
  }
  container.innerHTML = `<table class="timetable-shared timetable-slotwise admin-global-timetable">${head}${rows}</table>`;
  container.querySelectorAll("[data-session-block-id]").forEach((el) => {
    el.addEventListener("click", (e) => {
      if (e.target.closest("button")) return;
      const sessionId = String(el.dataset.sessionBlockId || "");
      if (!sessionId) return;
      selectAssignContext({ kind: "session", sessionId, source: "global" });
    });
  });
  container.querySelectorAll("[data-assign-drop-target]").forEach((cell) => {
    cell.addEventListener("click", (e) => {
      if (e.target.closest("[data-session-block-id],button")) return;
      selectAssignContext({
        kind: "slot",
        day: cell.dataset.day,
        slot: cell.dataset.slot,
        source: "global",
      });
    });
  });
  bindGlobalClassLetterEditActions(container);
  bindGlobalPlannerActions(weekType, container);
  bindSessionRemoveButtons(container);
  bindSessionDragStart(container);
}

function renderGlobalPlannerExcel(weekType) {
  const dayHeaders = DAYS.map(
    (day) =>
      `<th colspan="3">${day}</th>`
  ).join("");
  const subHeaders = DAYS.map(() => "<th>N</th><th>Sem. paire</th><th>Sem. impaire</th>").join("");

  const bands = [
    { label: "08h15 à 10h00", start: "08:15", endExclusive: "10:20" },
    { label: "10h20 à 12h05", start: "10:20", endExclusive: "12:10" },
    { label: "12h10 à 13h55", start: "12:10", endExclusive: "14:00" },
    { label: "14h00 à 16h00", start: "14:00", endExclusive: "16:05" },
    { label: "16h05 à 17h50", start: "16:05", endExclusive: "23:59" },
  ];

  const keyFor = (day, bucket, start) => `${day}|${bucket}|${start}`;
  const buckets = ["N", "PAIR", "IMPAIR"];
  const cellMap = new Map();
  for (const day of DAYS) {
    for (const b of buckets) {
      for (const band of bands) {
        cellMap.set(keyFor(day, b, band.start), []);
      }
    }
  }

  for (const s of state.sessions) {
    const teacher = state.teachers.find((t) => t.id === s.teacherId);
    const bucket = normalizeCadence(s.cadence) === "WEEKLY" ? "N" : normalizeWeekType(s.weekType) === "A" ? "PAIR" : "IMPAIR";
    const start = String(s.start || "");
    const band = bands.find((b) => start >= b.start && start < b.endExclusive);
    if (!band) continue;
    const key = keyFor(s.day, bucket, band.start);
    if (!cellMap.has(key)) continue;
    const code = getTeacherDisplayLabel(teacher);
    cellMap.get(key).push({
      sessionId: s.id,
      teacherId: s.teacherId,
      classId: s.classId,
      type: s.type,
      label: `${getClassLabelById(s.classId)} - ${code}`,
      style: getTeacherBlockStyle(s.teacherId),
    });
  }

  let conflictsCount = 0;
  const conflictDetails = [];
  const rows = bands
    .map((band) => {
      const cells = DAYS.map((day) => {
        return buckets
          .map((bucket) => {
            const entries = cellMap.get(keyFor(day, bucket, band.start)) || [];
            if (!entries.length) return `<td class="slot"></td>`;

            const reasonSet = new Set();
            let cellConflict = false;
            const html = entries
              .map((e) => {
                const conflict = entries.some((other) => {
                  if (other.sessionId === e.sessionId) return false;
                  const sameTeacher = other.teacherId === e.teacherId;
                  const sameRealClass =
                    other.classId === e.classId &&
                    !isSpecialAssignmentId(other.classId) &&
                    !isSpecialAssignmentId(e.classId);
                  const bothAS = isASLike(other) && isASLike(e);
                  if (!sameTeacher && !sameRealClass) return false;
                  if (bothAS) return false;
                  return true;
                });
                if (conflict) cellConflict = true;
                return renderSessionBlockHtml({
                  sessionId: e.sessionId,
                  text: e.label,
                  style: e.style,
                  className: `slot-block global-stacked-block${conflict ? " conflict-block" : ""}`,
                  cadence: bucket === "N" ? "WEEKLY" : "BIWEEKLY",
                  weekType: bucket === "PAIR" ? "A" : bucket === "IMPAIR" ? "B" : "A",
                });
              })
              .join("");
            if (cellConflict) conflictsCount += 1;
            if (cellConflict) {
              for (let i = 0; i < entries.length; i += 1) {
                for (let j = i + 1; j < entries.length; j += 1) {
                  const a = entries[i];
                  const b = entries[j];
                  const sameTeacher = a.teacherId === b.teacherId;
                  const sameRealClass =
                    a.classId === b.classId && !isSpecialAssignmentId(a.classId) && !isSpecialAssignmentId(b.classId);
                  const bothAS = isASLike(a) && isASLike(b);
                  if (!sameTeacher && !sameRealClass) continue;
                  if (bothAS) continue;
                  if (sameTeacher) {
                    const teacher = state.teachers.find((t) => t.id === a.teacherId);
                    reasonSet.add(`enseignant ${getTeacherDisplayLabel(teacher)}`);
                  }
                  if (sameRealClass) {
                    reasonSet.add(`classe ${getClassLabelById(a.classId)}`);
                  }
                }
              }
              const reasons = Array.from(reasonSet).join(", ");
              const bucketLabel = bucket === "N" ? "Hebdo" : bucket === "PAIR" ? "Sem. A" : "Sem. B";
              conflictDetails.push(`${day} ${band.label} (${bucketLabel}) : ${reasons || "conflit de superposition"}`);
            }
            return `<td class="slot${cellConflict ? " slot-conflict" : ""}">${html}</td>`;
          })
          .join("");
      }).join("");
      return `<tr><th>${band.label}</th>${cells}</tr>`;
    })
    .join("");

  if (conflictsCount > 0) {
    const shown = conflictDetails.slice(0, 4).map((x) => `<li>${escapeHtml(x)}</li>`).join("");
    const more = conflictDetails.length > 4 ? `<p>+${conflictDetails.length - 4} autre(s) conflit(s).</p>` : "";
    if (ui.globalPlannerHint) {
      ui.globalPlannerHint.innerHTML = `
        <span class="hours-over">${conflictsCount} créneau(x) en conflit détecté(s)</span> (vue type Excel).<br>
        <strong>Détail :</strong>
        <ul>${shown}</ul>
        ${more}
      `;
    }
  } else if (ui.globalPlannerHint) {
    ui.globalPlannerHint.innerHTML = `<span class="hours-ok">Aucun conflit détecté</span> (vue type Excel).`;
  }

  const container = ui.globalPlannerContainer;
  if (!container) return;
  container.innerHTML = `
    <table class="excel-like-table">
      <tr><th rowspan="2">Horaire</th>${dayHeaders}</tr>
      <tr>${subHeaders}</tr>
      ${rows}
    </table>
  `;
  state.globalPicker = null;
  bindSessionRemoveButtons(container);
  bindSessionDragStart(container);
}

function renderGlobalEmptyCell(day, slot, weekType) {
  return `<button class="slot-action global-slot-action" data-day="${escapeHtml(day)}" data-slot="${escapeHtml(slot)}" type="button">+</button>`;
}

function bindGlobalPlannerActions(weekType, container) {
  container.querySelectorAll(".global-slot-action").forEach((btn) => {
    btn.addEventListener("click", () => {
      openQuickAssignWizardForSlot({
        day: String(btn.dataset.day || ""),
        slot: String(btn.dataset.slot || ""),
        weekType: normalizeWeekType(weekType),
      });
    });
  });

  // Gestion du Drag & Drop sur le général
  container.querySelectorAll("[data-assign-drop-target]").forEach(cell => {
    const handleDropPayload = async (dropped) => {
      const day = cell.dataset.day;
      const slot = cell.dataset.slot;
      if (!day || !slot) return;
      if (dropped.kind === "session" && dropped.sessionId) {
        const original = state.sessions.find((s) => s.id === dropped.sessionId);
        const teacherId = String(original?.teacherId || "");
        if (!teacherId) return;
        const result = await moveSessionByDrag(dropped.sessionId, teacherId, day, slot, { promptOnOverride: true });
        ui.sessionError.textContent = result.ok ? result.message : result.error;
        ui.sessionError.className = result.ok ? "error-text hours-ok" : "error-text hours-over";
        if (result.ok) {
          clearTouchAssignPayload();
          render();
        }
        return;
      }
      if (dropped.kind === "assign" && dropped.value) {
        await handleGlobalSmartAssign(dropped.value, day, slot);
        clearTouchAssignPayload();
      }
    };
    cell.addEventListener("dragover", (e) => {
      e.preventDefault();
      cell.classList.add("assign-drop-ready");
    });
    cell.addEventListener("dragleave", () => {
      cell.classList.remove("assign-drop-ready");
    });
    cell.addEventListener("drop", async (e) => {
      e.preventDefault();
      cell.classList.remove("assign-drop-ready");
      const dropped = getDropPayloadFromEvent(e);
      await handleDropPayload(dropped);
    });
    cell.addEventListener("click", async () => {
      if (!state.touchAssignPayload?.payload) return;
      const dropped = getDropPayloadFromEvent({
        dataTransfer: { getData: (k) => (k === "text/plain" ? state.touchAssignPayload.payload : "") },
      });
      await handleDropPayload(dropped);
    });
  });
}

function openQuickAssignWizardForSlot({ day, slot, weekType, teacherId = "" }) {
  const modal = document.getElementById("quickTeacherPicker");
  const grid = document.getElementById("teacherPickerGrid");
  const title = document.getElementById("quickTeacherPickerTitle");
  if (!modal || !grid || !title) return;

  const stateWizard = {
    day: String(day || ""),
    slot: String(slot || ""),
    weekType: normalizeWeekType(weekType || "A"),
    teacherId: String(teacherId || ""),
  };

  const close = () => modal.classList.add("hidden");
  const closeBtn = document.getElementById("quickTeacherPickerClose");
  const cancelBtn = document.getElementById("quickTeacherPickerCancel");
  if (closeBtn) {
    closeBtn.onclick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      close();
    };
  }
  if (cancelBtn) {
    cancelBtn.onclick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      close();
    };
  }
  modal.onclick = (e) => {
    if (e.target === modal) close();
  };

  const renderTeachers = () => {
    title.textContent = `Affectation ${stateWizard.day} ${stateWizard.slot} - Choisir un enseignant`;
    const cards = state.teachers
      .map((t) => `
        <button class="teacher-picker-card" type="button" data-wizard-teacher="${escapeHtml(t.id)}">
          <span class="teacher-color-dot" style="background:${escapeHtml(getTeacherColor(t))}"></span>
          <strong>${escapeHtml(t.name)}</strong>
        </button>
      `)
      .join("");
    grid.innerHTML = cards || `<p class="summary-box">Aucun enseignant disponible.</p>`;
    grid.querySelectorAll("[data-wizard-teacher]").forEach((btn) => {
      btn.addEventListener("click", () => {
        stateWizard.teacherId = String(btn.getAttribute("data-wizard-teacher") || "");
        renderClasses();
      });
    });
  };

  const renderClasses = () => {
    const teacher = state.teachers.find((t) => t.id === stateWizard.teacherId);
    if (!teacher) return renderTeachers();
    title.textContent = `Affectation ${stateWizard.day} ${stateWizard.slot} - ${teacher.name}`;
    const sortedClasses = state.classes.slice().sort((a, b) => {
      const levelCmp = getLevelSortWeight(a.level) - getLevelSortWeight(b.level);
      if (levelCmp !== 0) return levelCmp;
      return String(a.name || "").localeCompare(String(b.name || ""), "fr");
    });
    const teacherAssigned = [];
    const unassigned = [];
    const assignedElsewhere = [];
    const teacherQuotas = getTeacherAssignedLevelQuotas(teacher);
    const teacherAsSessions = state.sessions
      .filter((s) => s.teacherId === teacher.id && isASLike(s))
      .sort(sortSessionsBySlotOrder);

    sortedClasses.forEach((cls) => {
      const repartitionTeacherId = getRepartitionAssignedTeacherIdForClass(cls.id);
      const repartitionTeacher = repartitionTeacherId ? state.teachers.find((t) => t.id === repartitionTeacherId) : null;
      const ownerTeacherId = String(getClassOwnerTeacherId(cls.id) || "");
      const ownerTeacher = ownerTeacherId ? state.teachers.find((t) => t.id === ownerTeacherId) : null;
      const classSessions = state.sessions
        .filter((s) => s.classId === cls.id && String(s.type || "").toUpperCase() === "EPS")
        .sort(sortSessionsBySlotOrder);
      const firstSession = classSessions[0] || null;
      const isOwnedByTeacher = repartitionTeacherId === teacher.id;
      const isUnassignedByRepartition = !repartitionTeacherId;
      const item = { cls, ownerTeacher, ownerTeacherId, repartitionTeacher, classSessions, firstSession };

      if (isOwnedByTeacher) {
        teacherAssigned.push(item);
      } else if (isUnassignedByRepartition) {
        unassigned.push(item);
      } else if (isTeacherAssignedToClass(teacher, cls.id) || ownerTeacherId !== teacher.id) {
        assignedElsewhere.push(item);
      }
    });

    const allowedAsCount = Number(teacherQuotas.AS || 0);
    for (let i = 0; i < allowedAsCount; i += 1) {
      const asSession = teacherAsSessions[i] || null;
      teacherAssigned.push({
        cls: { id: "__AS__", name: `AS ${i + 1}`, level: "AS", __specialSlotIndex: i + 1 },
        ownerTeacher: teacher,
        ownerTeacherId: teacher.id,
        repartitionTeacher: teacher,
        classSessions: asSession ? [asSession] : [],
        firstSession: asSession,
      });
    }

    const resolveCadenceFromVariant = async (classId, variant) => {
      const cls = state.classes.find((c) => c.id === classId);
      const group = getLevelRule(cls?.level)?.group || "";
      if (group !== "ALT_43") {
        return { ok: true, value: "WEEKLY" };
      }
      if (variant === "WEEKLY") {
        const choices = getAssignCadenceChoicesForClass(classId);
        if (!choices.some((choice) => choice.value === "WEEKLY")) {
          return { ok: false, error: "Le créneau hebdomadaire est déjà défini pour cette classe." };
        }
        return { ok: true, value: "WEEKLY" };
      }
      const choices = getAssignCadenceChoicesForClass(classId).filter((choice) => choice.value === "WEEK_A" || choice.value === "WEEK_B");
      if (!choices.length) {
        return { ok: false, error: "Le créneau une semaine sur deux est déjà défini pour cette classe." };
      }
      if (choices.length === 1) {
        return { ok: true, value: choices[0].value };
      }
      const picked = await openCadenceChoiceModal({
        title: "Choisir la semaine",
        text: "Cette classe une semaine sur deux peut être placée en semaine A ou en semaine B.",
        choices,
      });
      if (!picked) return { ok: false, error: "Choix de semaine annulé." };
      return { ok: true, value: picked };
    };

    const renderClassCard = ({ cls, ownerTeacher, ownerTeacherId, repartitionTeacher, classSessions, firstSession }, variant = "") => {
      const special = getSpecialAssignmentById(cls?.id);
      const isAssigned = classSessions.length > 0;
      let detail = "Répartition libre";
      let noteClass = "teacher-picker-meta";
      const displayLabel = special && cls?.name ? cls.name : getClassLabelById(cls.id, true);
      const displayShortLabel = special && cls?.name ? cls.name : getClassLabelById(cls.id);

      if (variant === "mine") {
        detail = "Répartition prof";
      } else if (variant === "free") {
        detail = isAssigned
          ? `Sans répartition - ${ownerTeacher?.name || "Prof"} - ${firstSession?.day || ""} ${firstSession?.start || ""}`.trim()
          : "Sans répartition";
      } else {
        const otherTeacher = ownerTeacher || repartitionTeacher;
        detail = isAssigned
          ? `Répartition ${otherTeacher?.name || "un autre prof"} - ${firstSession?.day || ""} ${firstSession?.start || ""}`.trim()
          : `Répartition ${otherTeacher?.name || "un autre prof"}`;
      }

      const group = getLevelRule(cls?.level)?.group || "";
      const weeklySessions = classSessions.filter((s) => normalizeCadence(s.cadence) === "WEEKLY");
      const biweeklySessions = classSessions.filter((s) => normalizeCadence(s.cadence) === "BIWEEKLY");
      const formatSessionSlot = (session) => {
        if (!session) return "Déjà affecté";
        return `Déjà affecté - ${session.day} ${session.start}`;
      };
      const getOptionStatusClass = (isDone, extraInfo) => {
        if (isDone) return "teacher-picker-done";
        if (String(extraInfo || "").trim().startsWith("À affecter")) return "teacher-picker-todo";
        return noteClass;
      };
      const makeOptionBtn = (label, cadenceValue, extraInfo = "", isDone = false, existingSessionId = "") => `
        <button class="teacher-picker-card teacher-picker-option-card${isDone ? " assigned" : ""}" type="button" data-wizard-class="${escapeHtml(cls.id)}" data-wizard-cadence="${escapeHtml(cadenceValue)}"${existingSessionId ? ` data-wizard-session-id="${escapeHtml(existingSessionId)}"` : ""}>
          <strong>${escapeHtml(label)}</strong>
          ${extraInfo ? `<small class="${getOptionStatusClass(isDone, extraInfo)}">${escapeHtml(extraInfo)}</small>` : ""}
        </button>
      `;
      const wrapHead = (title, subtitle, done = false) => `
        <div class="teacher-picker-class-head">
          <strong class="${done ? "teacher-picker-label-complete" : ""}">${escapeHtml(title)}</strong>
          <small class="${noteClass}">${escapeHtml(subtitle)}</small>
        </div>
      `;

      if (special?.type === "AS") {
        const done = weeklySessions.length > 0;
        return `
          <div class="teacher-picker-class-group">
            ${wrapHead(displayLabel, detail, done)}
            <div class="teacher-picker-option-stack">
              ${makeOptionBtn(displayShortLabel, "WEEKLY", done ? formatSessionSlot(weeklySessions[0]) : "À affecter", done, weeklySessions[0]?.id || "")}
            </div>
          </div>
        `;
      }

      if (group === "ALT_43") {
        const hasWeekly = weeklySessions.length > 0;
        const hasBiweekly = biweeklySessions.length > 0;
        const done = hasWeekly && hasBiweekly;
        return `
          <div class="teacher-picker-class-group">
            ${wrapHead(displayLabel, detail, done)}
            <div class="teacher-picker-option-stack">
              ${makeOptionBtn(`${displayShortLabel} en hebdo`, "WEEKLY", hasWeekly ? formatSessionSlot(weeklySessions[0]) : "À affecter", hasWeekly, weeklySessions[0]?.id || "")}
              ${makeOptionBtn(`${displayShortLabel} une semaine sur 2`, "BIWEEKLY", hasBiweekly ? `${formatSessionSlot(biweeklySessions[0])}${biweeklySessions[0]?.weekType ? ` - semaine ${normalizeWeekType(biweeklySessions[0].weekType)}` : ""}` : "À affecter", hasBiweekly, biweeklySessions[0]?.id || "")}
            </div>
          </div>
        `;
      }

      if (group === "SIXIEME") {
        const firstDone = weeklySessions.length >= 1;
        const secondDone = weeklySessions.length >= 2;
        const firstSessionWeekly = weeklySessions[0] || null;
        const secondSessionWeekly = weeklySessions[1] || null;
        return `
          <div class="teacher-picker-class-group">
            ${wrapHead(displayLabel, detail, secondDone)}
            <div class="teacher-picker-option-stack">
              ${makeOptionBtn(`${displayShortLabel} - cours 1 (2h)`, "WEEKLY", firstDone ? formatSessionSlot(firstSessionWeekly) : "À affecter", firstDone, firstSessionWeekly?.id || "")}
              ${makeOptionBtn(`${displayShortLabel} - cours 2 (2h)`, "WEEKLY", secondDone ? formatSessionSlot(secondSessionWeekly) : "À affecter", secondDone, secondSessionWeekly?.id || "")}
            </div>
          </div>
        `;
      }

      if (group === "CINQUIEME") {
        const done = weeklySessions.length > 0;
        return `
          <div class="teacher-picker-class-group">
            ${wrapHead(displayLabel, detail, done)}
            <div class="teacher-picker-option-stack">
              ${makeOptionBtn(`${displayShortLabel} - 3h`, "WEEKLY", done ? formatSessionSlot(weeklySessions[0]) : "À affecter", done, weeklySessions[0]?.id || "")}
            </div>
          </div>
        `;
      }

      const done = weeklySessions.length > 0;
      return `
        <div class="teacher-picker-class-group">
          ${wrapHead(displayLabel, detail, done)}
          <div class="teacher-picker-option-stack">
            ${makeOptionBtn(displayShortLabel, "WEEKLY", done ? formatSessionSlot(weeklySessions[0]) : "À affecter", done, weeklySessions[0]?.id || "")}
          </div>
        </div>
      `;
    };

    const otherClasses = [
      ...unassigned.map((item) => ({ item, variant: "free" })),
      ...assignedElsewhere.map((item) => ({ item, variant: "other" })),
    ];
    const sections = [];
    if (teacherAssigned.length) {
      sections.push(`
        <div class="teacher-picker-group-title">Classes attribuées à ${escapeHtml(teacher.name)}</div>
        ${teacherAssigned.map((item) => renderClassCard(item, "mine")).join("")}
      `);
    }
    if (otherClasses.length) {
      sections.push(`
        <div class="teacher-picker-group-title">Autres classes</div>
        ${otherClasses.map(({ item, variant }) => renderClassCard(item, variant)).join("")}
      `);
    }

    grid.innerHTML = `
      <button class="secondary-btn" type="button" data-wizard-back="teachers">← Professeurs</button>
      ${sections.join("") || `<p class="summary-box">Aucune classe disponible pour cet enseignant.</p>`}
    `;
    grid.querySelector("[data-wizard-back='teachers']")?.addEventListener("click", renderTeachers);
    grid.querySelectorAll("[data-wizard-class]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const classId = String(btn.getAttribute("data-wizard-class") || "");
        const cadenceVariant = String(btn.getAttribute("data-wizard-cadence") || "WEEKLY");
        const existingSessionId = String(btn.getAttribute("data-wizard-session-id") || "");
        if (!classId) return;
        let result = null;
        const cadencePick = await resolveCadenceFromVariant(classId, cadenceVariant);
        if (!cadencePick.ok) {
          if (ui.sessionError) {
            ui.sessionError.textContent = cadencePick.error || "Cadence indisponible.";
            ui.sessionError.className = "error-text hours-over";
          }
          return;
        }
        if (existingSessionId) {
          const sessionToMove = state.sessions.find((s) => s.id === existingSessionId);
          if (!sessionToMove) return;
          const currentTeacher = state.teachers.find((t) => t.id === sessionToMove.teacherId);
          const warn = `Cette séance est déjà affectée à ${currentTeacher?.name || "un enseignant"} le ${sessionToMove.day} à ${sessionToMove.start}.\n\nConfirmer la réaffectation vers ${teacher.name} - ${stateWizard.day} ${stateWizard.slot} ?`;
          if (!confirm(warn)) return;
          result = await moveSessionByDrag(sessionToMove.id, teacher.id, stateWizard.day, stateWizard.slot, { promptOnOverride: true });
        } else {
          result = await quickAssignFromGlobal(
            stateWizard.day,
            stateWizard.slot,
            teacher.id,
            classId,
            stateWizard.weekType,
            cadencePick.value,
            { promptOnOverride: true }
          );
        }
        if (ui.sessionError) {
          ui.sessionError.textContent = result?.ok ? result.message : result?.error || "Affectation impossible.";
          ui.sessionError.className = result?.ok ? "error-text hours-ok" : "error-text hours-over";
        }
        if (result?.ok) {
          close();
          render();
        }
      });
    });
  };

  if (stateWizard.teacherId) renderClasses();
  else renderTeachers();
  modal.classList.remove("hidden");
}

async function handleGlobalSmartAssign(classId, day, slot) {
  const resolvedClassId = resolveClassIdFromAssignPayload(
    classId,
    "",
    day,
    slot,
    normalizeWeekType(state.selectedGlobalWeekType || "A")
  );
  if (!resolvedClassId) {
    if (ui.sessionError) {
      ui.sessionError.textContent = "Aucune classe disponible pour ce niveau.";
      ui.sessionError.className = "error-text hours-over";
    }
    return;
  }
  // 1. Chercher si la classe est déjà attribuée à un prof
  const existingSession = state.sessions.find(s => s.classId === resolvedClassId);
  
  if (existingSession) {
    // Si oui, on utilise le même prof automatiquement
    await handleSmartAssign(existingSession.teacherId, resolvedClassId, day, slot);
  } else {
    // Si non, on ouvre la grille de sélection en filtrant les profs occupés
    openQuickTeacherPicker(resolvedClassId, day, slot, async (teacherId) => {
      await handleSmartAssign(teacherId, resolvedClassId, day, slot);
    });
  }
}

function openQuickTeacherPicker(classId, day, slot, onSelect) {
  const modal = document.getElementById("quickTeacherPicker");
  const grid = document.getElementById("teacherPickerGrid");
  const title = document.getElementById("quickTeacherPickerTitle");
  if (!modal || !grid) return;

  title.textContent = `Attribuer ${getClassLabelById(classId, true)}`;
  
  const eligibleTeachers = state.teachers.filter((teacher) => isTeacherAssignedToClass(teacher, classId));
  const rankedTeachers = eligibleTeachers
    .map((teacher) => {
      const proposal = buildBestSessionProposal(
        teacher.id,
        classId,
        day,
        slot,
        state.selectedGlobalWeekType,
        "AUTO",
        true
      );
      if (!proposal.ok || !proposal.session) {
        return { teacher, proposal, quality: null, warning: proposal.error || "Contrainte non respectée." };
      }
      const quality = evaluateAssignmentQuality(proposal.session);
      return { teacher, proposal, quality, warning: "" };
    })
    .sort((a, b) => {
      const aScore = Number(a.quality?.score || -1);
      const bScore = Number(b.quality?.score || -1);
      if (aScore !== bScore) return bScore - aScore;
      return String(a.teacher?.name || "").localeCompare(String(b.teacher?.name || ""), "fr");
    });

  if (!rankedTeachers.length) {
    showToast("Aucun professeur n'a ce niveau attribué pour cette classe.", "warning");
    return;
  }

  const bestCompatibleScore = Math.max(...rankedTeachers.map((x) => Number(x.quality?.score || -1)));
  grid.innerHTML = rankedTeachers.map((entry, idx) => {
    const t = entry.teacher;
    const color = getTeacherColor(t);
    const recommended = Number(entry.quality?.score || -1) === bestCompatibleScore && bestCompatibleScore >= 0 ? " recommended" : "";
    const warnClass = entry.warning ? " warning" : "";
    return `
      <div class="teacher-picker-card${recommended}${warnClass}" data-teacher-id="${escapeHtml(t.id)}">
        <span class="teacher-color-dot" style="background:${escapeHtml(color)}"></span>
        <strong>${escapeHtml(t.name)}</strong>
        ${
          entry.quality
            ? `<small class="teacher-picker-score">Score ${entry.quality.score}/100</small>`
            : `<small class="teacher-picker-warning">⚠ ${escapeHtml(entry.warning)}</small>`
        }
      </div>
    `;
  }).join("");

  // Bind clicks
  grid.querySelectorAll(".teacher-picker-card").forEach(card => {
    card.addEventListener("click", () => {
      onSelect(card.dataset.teacherId);
      modal.classList.add("hidden");
    });
  });

  // Closers
  const close = () => modal.classList.add("hidden");
  const closeBtn = document.getElementById("quickTeacherPickerClose");
  const cancelBtn = document.getElementById("quickTeacherPickerCancel");
  if (closeBtn) {
    closeBtn.onclick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      close();
    };
  }
  if (cancelBtn) {
    cancelBtn.onclick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      close();
    };
  }
  modal.onclick = (e) => {
    if (e.target === modal) close();
  };

  modal.classList.remove("hidden");
}

function openAssignModal({ source, teacherId, day, slot, weekType }) {
  if (!ui.assignModal) return;
  if (ui.assignModalCancelBtn) ui.assignModalCancelBtn.onclick = () => closeAssignModal();
  if (ui.assignModalConfirmBtn) ui.assignModalConfirmBtn.onclick = async () => {
    await confirmAssignModal();
  };
  state.assignModal = {
    source: source === "global" ? "global" : "teacher",
    teacherId: teacherId || "",
    day: day || "",
    slot: slot || "",
    weekType: normalizeWeekType(weekType || state.selectedGlobalWeekType),
    manualTeacherSelection: false,
    autoTeacherApplied: false,
  };

  ui.assignModalTitle.textContent =
    state.assignModal.source === "teacher" ? "Affectation rapide professeur" : "Affectation planning général";
  ui.assignModalContext.textContent = `${state.assignModal.day} ${state.assignModal.slot}`;

  const teacherOptions = state.teachers
    .map((t) => `<option value="${escapeHtml(t.id)}">${escapeHtml(t.name)}</option>`)
    .join("");
  ui.assignModalTeacherSelect.innerHTML = teacherOptions;
  ui.assignModalTeacherRow.classList.remove("hidden");
  if (state.assignModal.source === "teacher") {
    ui.assignModalTeacherSelect.value = state.assignModal.teacherId;
  } else {
    ui.assignModalTeacherSelect.value = state.assignModal.teacherId || state.teachers[0]?.id || "";
    state.assignModal.teacherId = ui.assignModalTeacherSelect.value || "";
  }

  const suggested = getSuggestedCadenceForTeacherSlot(
    state.assignModal.teacherId || ui.assignModalTeacherSelect.value,
    state.assignModal.day,
    state.assignModal.slot
  );
  ui.assignModalCadenceSelect.value = suggested === "AUTO" ? "WEEKLY" : suggested;
  ui.assignModalHint.innerHTML = "";
  refreshAssignModalClassOptions();
  ui.assignModal.classList.remove("hidden");
}

function closeAssignModal() {
  if (!ui.assignModal) return;
  ui.assignModal.classList.add("hidden");
  state.assignModal = null;
}

function refreshAssignModalClassOptions() {
  if (!state.assignModal) return;
  const previousClassId = String(ui.assignModalClassSelect.value || "");
  const previousCadence = String(ui.assignModalCadenceSelect.value || "WEEKLY");
  const teacherId =
    state.assignModal.source === "teacher" ? state.assignModal.teacherId : String(ui.assignModalTeacherSelect.value || "");
  state.assignModal.teacherId = teacherId;
  const day = state.assignModal.day;
  const slot = state.assignModal.slot;
  const weekType = state.assignModal.source === "teacher" ? "A" : state.assignModal.weekType;
  const includeConflicting = true;
  const classes = getAvailableClassesForGlobalPicker(teacherId, day, slot, weekType, includeConflicting, true);
  const levelMap = new Map();
  for (const c of classes) {
    const level = isSpecialAssignmentId(c.id) ? "Activités" : String(c.level || "Autres");
    const arr = levelMap.get(level) || [];
    arr.push(c);
    levelMap.set(level, arr);
  }
  const levels = Array.from(levelMap.keys()).sort((a, b) => {
    if (a === "Activités") return 1;
    if (b === "Activités") return -1;
    return a.localeCompare(b, "fr");
  });

  const prevLevel = ui.assignModalLevelSelect.value;
  const selectedLevel = levels.includes(prevLevel) ? prevLevel : levels[0] || "";
  ui.assignModalLevelSelect.innerHTML = levels
    .map((level) => `<option value="${escapeHtml(level)}">${escapeHtml(level)}</option>`)
    .join("");
  ui.assignModalLevelSelect.disabled = !levels.length;
  ui.assignModalLevelSelect.value = selectedLevel;

  const classPool = selectedLevel ? levelMap.get(selectedLevel) || [] : [];
  const options = classPool
    .map((c) => {
      const warn = c._slotCompatible === false ? " ⚠" : "";
      if (isSpecialAssignmentId(c.id)) {
        return `<option value="${escapeHtml(c.id)}">${escapeHtml(getClassLabelById(c.id))}${warn} (illimité)</option>`;
      }
      const remaining = Math.max(0, Number(c.weeklyHours || 0) - getAssignedHoursForClass(c.id));
      return `<option value="${escapeHtml(c.id)}">${escapeHtml(c.name)}${warn} (${formatHours(remaining)}h)</option>`;
    })
    .join("");
  ui.assignModalClassSelect.innerHTML = options || `<option value="">Aucune classe disponible</option>`;
  ui.assignModalClassSelect.disabled = !options;
  if (options && previousClassId) {
    const stillAvailable = classPool.some((c) => c.id === previousClassId);
    if (stillAvailable) ui.assignModalClassSelect.value = previousClassId;
  }

  const selectedClassId = String(ui.assignModalClassSelect.value || "");
  const cadenceChoices = getAssignCadenceChoicesForClass(selectedClassId);
  ui.assignModalCadenceSelect.innerHTML = cadenceChoices.length
    ? cadenceChoices
        .map((choice) => `<option value="${escapeHtml(choice.value)}">${escapeHtml(choice.label)}</option>`)
        .join("")
    : `<option value="">Aucune cadence disponible</option>`;
  ui.assignModalCadenceSelect.disabled = cadenceChoices.length <= 1;
  if (cadenceChoices.some((choice) => choice.value === previousCadence)) {
    ui.assignModalCadenceSelect.value = previousCadence;
  } else if (cadenceChoices[0]?.value) {
    ui.assignModalCadenceSelect.value = cadenceChoices[0].value;
  }

  if (state.assignModal.source === "global" && !state.assignModal.manualTeacherSelection && options) {
    const classId = selectedClassId;
    const cadencePreference = String(ui.assignModalCadenceSelect?.value || "WEEKLY");
    const best = getBestTeacherRecommendations(classId, day, slot, weekType, cadencePreference, "global")[0];
    if (best && best.teacher.id !== teacherId && !state.assignModal.autoTeacherApplied) {
      state.assignModal.autoTeacherApplied = true;
      ui.assignModalTeacherSelect.value = best.teacher.id;
      state.assignModal.teacherId = best.teacher.id;
      refreshAssignModalClassOptions();
      return;
    }
  }

  renderAssignDecisionSupport();
}

async function confirmAssignModal() {
  if (!state.assignModal) return;
  const classId = String(ui.assignModalClassSelect.value || "");
  const cadencePreference = String(ui.assignModalCadenceSelect.value || "WEEKLY");
  if (!classId) {
    ui.assignModalHint.textContent = "Aucune classe disponible sur ce créneau.";
    return;
  }
  if (!cadencePreference) {
    ui.assignModalHint.textContent = "Aucune cadence disponible pour cette classe.";
    return;
  }
  const { source, teacherId, day, slot, weekType } = state.assignModal;
  try {
    const result =
      source === "teacher"
        ? await quickAssignFromPlanner(teacherId, day, slot, classId, cadencePreference, { promptOnOverride: true })
        : await quickAssignFromGlobal(
            day,
            slot,
            String(ui.assignModalTeacherSelect.value || ""),
            classId,
            weekType,
            cadencePreference,
            { promptOnOverride: true }
          );
    ui.sessionError.textContent = result.ok ? result.message : result.error;
    if (result.ok) {
      closeAssignModal();
      renderPlannerGrid();
    } else {
      renderAssignDecisionSupport(result.error || "Affectation impossible.");
    }
  } catch (error) {
    renderAssignDecisionSupport(`Erreur: ${error?.message || "affectation impossible."}`);
  }
}

function getAssignModalTeacherId() {
  if (!state.assignModal) return "";
  if (state.assignModal.source === "teacher") return String(state.assignModal.teacherId || "");
  return String(ui.assignModalTeacherSelect?.value || "");
}

function getAssignQualityTone(score) {
  if (score >= 75) return { key: "good", label: "Vert" };
  if (score >= 50) return { key: "warn", label: "Orange" };
  return { key: "bad", label: "Rouge" };
}

function evaluateTeacherWeekSpreadImpact(session) {
  if (!session?.teacherId || !session.day) return { delta: 0, details: [] };
  if (String(session.type || "").toUpperCase() === "AS") return { delta: 0, details: [] };
  const teacherId = String(session.teacherId || "");
  const day = String(session.day || "");
  const addedHours = weeklyEquivalentHours(session);
  const dailyHours = new Map(
    DAYS.map((d) => [
      d,
      state.sessions
        .filter((s) => s.teacherId === teacherId && String(s.day || "") === d)
        .filter((s) => String(s.type || "").toUpperCase() !== "AS")
        .reduce((acc, s) => acc + weeklyEquivalentHours(s), 0),
    ])
  );
  const beforeDayHours = Number(dailyHours.get(day) || 0);
  dailyHours.set(day, beforeDayHours + addedHours);
  const values = DAYS.map((d) => Number(dailyHours.get(d) || 0));
  const total = values.reduce((acc, h) => acc + h, 0);
  if (total <= 0.001) return { delta: 0, details: [] };

  const workedDaysBefore = DAYS.filter((d) => {
    const h = d === day ? beforeDayHours : Number(dailyHours.get(d) || 0);
    return h > 0.001;
  }).length;
  const workedDaysAfter = values.filter((h) => h > 0.001).length;
  // On vise une répartition sur environ 4h par jour travaillé
  const targetDays = Math.max(1, Math.min(DAYS.length, Math.ceil(total / 4)));
  const averageTarget = total / targetDays;
  const maxDay = Math.max(...values);
  let delta = 0;
  const details = [];

  // Bonus si on ouvre un nouveau jour nécessaire
  if (beforeDayHours <= 0.001 && workedDaysBefore < targetDays) {
    delta += 12;
    details.push("Répartition hebdomadaire: nouveau jour travaillé utile.");
  } 
  
  // Pénalité progressive selon l'écart à la moyenne cible
  const currentLoad = beforeDayHours + addedHours;
  const overshoot = currentLoad - averageTarget;
  
  if (overshoot > 1.5) {
    const penalty = Math.round(overshoot * 8);
    delta -= penalty;
    details.push(`Déséquilibre hebdo: journée trop chargée (+${formatHours(overshoot)}h vs moyenne).`);
  } else if (currentLoad <= averageTarget + 0.5 && currentLoad >= averageTarget - 1.5) {
    delta += 10;
    details.push("Bon équilibre de la charge hebdomadaire.");
  }

  if (maxDay > 5.5) {
    delta -= 15;
    details.push("Attention: forte concentration sur une seule journée.");
  }

  return { delta, details };
}

function calculateTeacherDailyAmplitude(teacherId, day, weekType) {
  const daySessions = state.sessions.filter(
    (s) => s.teacherId === teacherId && String(s.day || "") === day && isSessionVisibleForWeek(s, weekType)
  );
  if (daySessions.length < 1) return 0;

  let minStart = 24;
  let maxEnd = 0;

  for (const s of daySessions) {
    const startHour = toWeekStartHour(s.day, s.start) % 24;
    const endHour = startHour + Number(s.duration || 0);
    if (startHour < minStart) minStart = startHour;
    if (endHour > maxEnd) maxEnd = endHour;
  }

  return maxEnd - minStart;
}

function evaluateGlobalWeekSpreadImpact(session) {
  if (!session?.day) return { delta: 0, details: [] };
  const day = session.day;
  const dailyCounts = DAYS.map(d => state.sessions.filter(s => s.day === d).length);
  const total = dailyCounts.reduce((a, b) => a + b, 0);
  
  // N'appliquer que si on a déjà un certain nombre de créneaux pour avoir une moyenne significative
  if (total < state.classes.length * 0.5) return { delta: 0, details: [] };

  const avg = total / DAYS.length;
  const currentDayCount = state.sessions.filter(s => s.day === day).length;
  
  let delta = 0;
  const details = [];
  
  if (currentDayCount > avg + 2) {
    delta -= 12;
    details.push(`Équilibre établissement: le ${day} est déjà plus chargé que la moyenne.`);
  } else if (currentDayCount < avg - 1) {
    delta += 6;
    details.push(`Équilibre établissement: le ${day} est moins chargé, à privilégier.`);
  }
  
  return { delta, details };
}

function getAlgoBiweeklySlotBalanceImpact(candidateSessions) {
  const sessions = (Array.isArray(candidateSessions) ? candidateSessions : [candidateSessions])
    .filter(Boolean)
    .filter((s) => normalizeCadence(s.cadence) === "BIWEEKLY");
  if (!sessions.length) return { delta: 0, details: [] };

  const grouped = new Map();
  const makeKey = (session) => `${session.day}|${getCoveredSlots(session.day, session.start, Number(session.duration || 0)).join(",")}`;
  const makeId = (session) =>
    [
      String(session.id || ""),
      String(session.classId || ""),
      String(session.teacherId || ""),
      String(session.day || ""),
      String(session.start || ""),
      String(session.duration || ""),
      String(normalizeWeekType(session.weekType)),
    ].join("|");

  sessions.forEach((session) => {
    const key = makeKey(session);
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(session);
  });

  let delta = 0;
  const details = [];

  grouped.forEach((proposed, key) => {
    const sample = proposed[0];
    const sampleSlots = getCoveredSlots(sample.day, sample.start, Number(sample.duration || 0));
    const existingIds = new Set();
    state.sessions.forEach((s) => {
      if (normalizeCadence(s.cadence) !== "BIWEEKLY") return;
      if (String(s.day || "") !== String(sample.day || "")) return;
      const existingSlots = getCoveredSlots(s.day, s.start, Number(s.duration || 0));
      if (!slotsOverlap(sampleSlots, existingSlots)) return;
      existingIds.add(makeId(s));
    });
    const proposedIds = new Set(proposed.map((s) => makeId(s)));
    const total = existingIds.size + proposedIds.size;
    if (total > 4) {
      delta -= 180 + (total - 5) * 35;
      details.push(`Créneau A/B très chargé: ${sample.day} ${sample.start} monterait à ${total} classes une semaine sur 2.`);
    } else if (total === 4) {
      delta -= 26;
      details.push(`Créneau A/B déjà dense: ${sample.day} ${sample.start} atteindrait 4 classes une semaine sur 2.`);
    } else if (total === 3) {
      delta -= 8;
    }
  });

  return { delta, details };
}

function evaluateAssignmentQuality(session) {
  if (!session) return { score: 0, tone: getAssignQualityTone(0), details: [] };
  const teacher = state.teachers.find((t) => t.id === session.teacherId);
  const maxHours = Number(teacher?.maxHours || 0);
  const currentHours = state.sessions
    .filter((s) => s.teacherId === session.teacherId)
    .reduce((acc, s) => acc + weeklyEquivalentHours(s), 0);
  const nextHours = currentHours + weeklyEquivalentHours(session);
  const loadRatio = maxHours > 0 ? nextHours / maxHours : 0;
  const slots = getCoveredSlots(session.day, session.start, Number(session.duration || 0));
  const preferredCount = slots.filter((slotKey) => {
    const [dayValue, slotValue] = String(slotKey).split("|");
    return hasDesiderataSlot(session.teacherId, dayValue, slotValue);
  }).length;

  let score = 72;
  const details = [];

  if (loadRatio > 1) {
    score -= 34;
    details.push(`Charge après affectation: ${formatHours(nextHours)}/${formatHours(maxHours)}h (dépassement).`);
  } else if (loadRatio > 0.92) {
    score -= 16;
    details.push(`Charge proche de la limite: ${formatHours(nextHours)}/${formatHours(maxHours)}h.`);
  } else if (loadRatio < 0.75) {
    score += 8;
    details.push(`Charge équilibrée: ${formatHours(nextHours)}/${formatHours(maxHours)}h.`);
  } else {
    details.push(`Charge: ${formatHours(nextHours)}/${formatHours(maxHours)}h.`);
  }

  if (preferredCount === slots.length && slots.length > 0) {
    score += 50; // Augmentation massive pour forcer le choix
    details.push("Créneau pleinement aligné avec les désidérata (priorité haute).");
  } else if (preferredCount > 0) {
    score += 25;
    details.push("Créneau partiellement aligné avec les désidérata.");
  } else {
    details.push("Créneau neutre par rapport aux désidérata.");
  }

  // AMÉLIORATION 4 : Malus d'amplitude journalière
  const weekType = normalizeWeekType(session.weekType);
  const currentAmplitude = calculateTeacherDailyAmplitude(session.teacherId, session.day, weekType);
  // On simule l'amplitude avec le nouveau créneau
  const startHour = toWeekStartHour(session.day, session.start) % 24;
  const endHour = startHour + Number(session.duration || 0);
  const daySessions = state.sessions.filter(
    (s) => s.teacherId === session.teacherId && String(s.day || "") === session.day && isSessionVisibleForWeek(s, weekType)
  );
  let minH = startHour;
  let maxH = endHour;
  for (const s of daySessions) {
    const sH = toWeekStartHour(s.day, s.start) % 24;
    const eH = sH + Number(s.duration || 0);
    if (sH < minH) minH = sH;
    if (eH > maxH) maxH = eH;
  }
  const nextAmplitude = maxH - minH;

  if (nextAmplitude > 10.001) {
    score -= 100;
    details.push(`Alerte amplitude excessive: ${formatHours(nextAmplitude)}h (> 10h).`);
  } else if (nextAmplitude > 9.001) {
    score -= 60;
    details.push(`Alerte amplitude élevée: ${formatHours(nextAmplitude)}h (> 9h).`);
  } else if (nextAmplitude > 8.001) {
    score -= 30;
    details.push(`Alerte amplitude: ${formatHours(nextAmplitude)}h (> 8h).`);
  }

  const suggestedCadence = getSuggestedCadenceForTeacherSlot(session.teacherId, session.day, session.start);
  const assignedCadence = normalizeCadence(session.cadence) === "BIWEEKLY" ? `WEEK_${normalizeWeekType(session.weekType)}` : "WEEKLY";
  if (suggestedCadence !== "AUTO" && suggestedCadence === assignedCadence) {
    score += 6;
    details.push("Cadence cohérente avec le contexte du créneau.");
  }

  const spread = evaluateTeacherWeekSpreadImpact(session);
  score += spread.delta;
  details.push(...spread.details);

  const globalSpread = evaluateGlobalWeekSpreadImpact(session);
  score += globalSpread.delta;
  details.push(...globalSpread.details);

  // Bonus stratégie SPREAD : favorise la répartition sur les jours de la semaine
  if (state.algoCurrentStrategy === "SPREAD") {
    const dayH = state.sessions
      .filter((s) => s.teacherId === session.teacherId && String(s.day || "") === session.day && !isASLike(s))
      .reduce((acc, s) => acc + weeklyEquivalentHours(s), 0);
    if (dayH === 0) { score += 30; details.push("SPREAD: jour vierge pour ce prof (+30)."); }
    else if (dayH <= 2) { score += 10; details.push("SPREAD: jour peu chargé (+10)."); }
    else { score -= 15; details.push("SPREAD: jour déjà chargé (-15)."); }
  }

  score = Math.max(0, Math.round(score));
  return {
    score,
    tone: getAssignQualityTone(score),
    details,
  };
}

function getBestTeacherRecommendations(classId, day, slot, weekType, cadencePreference = "WEEKLY", source = "global") {
  const teacherPool =
    source === "teacher" && state.assignModal?.teacherId
      ? state.teachers.filter((t) => t.id === state.assignModal.teacherId)
      : state.teachers;

  return teacherPool
    .map((teacher) => {
      const proposal = buildBestSessionProposal(
        teacher.id,
        classId,
        day,
        slot,
        weekType,
        cadencePreference,
        true
      );
      if (!proposal.ok) return null;
      const quality = evaluateAssignmentQuality(proposal.session);
      return { teacher, proposal, quality };
    })
    .filter(Boolean)
    .sort((a, b) => b.quality.score - a.quality.score)
    .slice(0, 3);
}

function getAssignConflictSuggestions({ source, teacherId, classId, day, slot, weekType, cadencePreference }) {
  const suggestions = [];
  const scored = [];

  const pushScored = (entry) => {
    if (!entry) return;
    scored.push(entry);
  };

  // 1) Chercher un autre créneau avec même prof et même classe
  for (const d of DAYS) {
    for (const band of SLOT_BANDS) {
      const start = band.start;
      if (d === day && start === slot) continue;
      const attempt = buildBestSessionProposal(teacherId, classId, d, start, weekType, cadencePreference, true);
      if (!attempt.ok || !attempt.session) continue;
      const quality = evaluateAssignmentQuality(attempt.session);
      pushScored({
        type: "apply_slot",
        teacherId,
        day: d,
        slot: start,
        cadence: cadencePreference,
        qualityScore: Number(quality.score || 0),
        sortBias: 30,
        label: `Créneau alternatif: ${d} ${start} (${quality.score}/100)`,
      });
    }
  }

  // 2) Chercher un autre prof sur le même créneau
  const teacherRecos = getBestTeacherRecommendations(classId, day, slot, weekType, cadencePreference, source);
  for (const rec of teacherRecos) {
    if (!rec?.teacher || rec.teacher.id === teacherId) continue;
    pushScored({
      type: "apply_teacher",
      teacherId: rec.teacher.id,
      day,
      slot,
      cadence: cadencePreference,
      qualityScore: Number(rec.quality?.score || 0),
      sortBias: 20,
      label: `Prof alternatif: ${rec.teacher.name} (${rec.quality?.score || 0}/100)`,
    });
  }

  // 3) Essayer une cadence différente
  const cadenceCandidates = ["WEEKLY", "WEEK_A", "WEEK_B"].filter((x) => x !== cadencePreference);
  for (const candidateCadence of cadenceCandidates) {
    const attempt = buildBestSessionProposal(teacherId, classId, day, slot, weekType, candidateCadence, true);
    if (attempt.ok) {
      const quality = attempt.session ? evaluateAssignmentQuality(attempt.session) : { score: 0 };
      pushScored({
        type: "apply_cadence",
        cadence: candidateCadence,
        teacherId,
        day,
        slot,
        qualityScore: Number(quality.score || 0),
        sortBias: 10,
        label:
          candidateCadence === "WEEKLY"
            ? `Cadence: hebdo (${quality.score}/100)`
            : `Cadence: semaine ${candidateCadence === "WEEK_A" ? "A" : "B"} (${quality.score}/100)`,
      });
    }
  }

  scored.sort((a, b) => (Number(b.qualityScore || 0) + Number(b.sortBias || 0)) - (Number(a.qualityScore || 0) + Number(a.sortBias || 0)));
  for (const item of scored) {
    const duplicate = suggestions.some(
      (s) =>
        s.type === item.type &&
        String(s.teacherId || "") === String(item.teacherId || "") &&
        String(s.day || "") === String(item.day || "") &&
        String(s.slot || "") === String(item.slot || "") &&
        String(s.cadence || "") === String(item.cadence || "")
    );
    if (!duplicate) suggestions.push(item);
    if (suggestions.length >= 6) break;
  }

  return suggestions;
}

function bindAssignHintActions() {
  if (!ui.assignModalHint || !state.assignModal) return;
  ui.assignModalHint.querySelectorAll("[data-assign-preview-index]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const idx = Number(btn.dataset.assignPreviewIndex);
      if (!Number.isFinite(idx) || idx < 0) return;
      state.assignModal.previewSuggestionIndex = idx;
      renderAssignDecisionSupport();
    });
  });
  ui.assignModalHint.querySelectorAll("[data-assign-hint-action]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const action = String(btn.dataset.assignHintAction || "");
      if (action === "set_teacher") {
        const teacherId = String(btn.dataset.teacherId || "");
        if (!teacherId || !ui.assignModalTeacherSelect) return;
        ui.assignModalTeacherSelect.value = teacherId;
        state.assignModal.teacherId = teacherId;
        state.assignModal.manualTeacherSelection = true;
        refreshAssignModalClassOptions();
        return;
      }
      if (action === "set_cadence") {
        const cadence = String(btn.dataset.cadence || "");
        if (!cadence || !ui.assignModalCadenceSelect) return;
        ui.assignModalCadenceSelect.value = cadence;
        renderAssignDecisionSupport();
        return;
      }
      if (action === "apply_best" || action === "apply_teacher" || action === "apply_cadence" || action === "apply_slot") {
        const teacherId = String(btn.dataset.teacherId || "");
        const cadence = String(btn.dataset.cadence || "WEEKLY");
        const targetDay = String(btn.dataset.day || state.assignModal?.day || "");
        const targetSlot = String(btn.dataset.slot || state.assignModal?.slot || "");
        const classId = String(ui.assignModalClassSelect?.value || "");
        if (!classId || !teacherId) return;
        const { source, weekType } = state.assignModal;
        const result =
          source === "teacher"
            ? await quickAssignFromPlanner(teacherId, targetDay, targetSlot, classId, cadence, { promptOnOverride: true })
            : await quickAssignFromGlobal(targetDay, targetSlot, teacherId, classId, weekType, cadence, { promptOnOverride: true });
        ui.sessionError.textContent = result.ok ? result.message : result.error;
        if (result.ok) {
          closeAssignModal();
          renderPlannerGrid();
        } else {
          renderAssignDecisionSupport(result.error || "Affectation impossible.");
        }
      }
    });
  });
}

function buildAssignSimulationSession({ teacherId, classId, day, slot, weekType, cadencePreference }) {
  const attempt = buildBestSessionProposal(teacherId, classId, day, slot, weekType, cadencePreference, true);
  if (attempt?.ok && attempt.session) return attempt.session;
  return null;
}

function renderAssignSimulationGrid({ baseSessions, simulatedSession, labelBuilder, weekType }) {
  const grid = new Map();
  for (const d of DAYS) {
    for (const band of SLOT_BANDS) grid.set(toSlotKey(d, band.start), []);
  }
  const sessions = [...(baseSessions || [])];
  if (simulatedSession) sessions.push({ ...simulatedSession, __simulated: true });

  for (const s of sessions) {
    if (!isSessionVisibleForWeek(s, weekType)) continue;
    const text = labelBuilder(s);
    const style = getTeacherBlockStyle(s.teacherId);
    for (const seg of getSessionBandSegments(s)) {
      const key = toSlotKey(seg.day, seg.bandStart);
      const arr = grid.get(key) || [];
      arr.push({
        html: `<div class="slot-block assign-sim-slot-block${getSessionSegmentClassName(seg)} ${s.__simulated ? "assign-simulated-block" : ""}" style="${escapeHtml(style)}">${seg.showContent === false ? "" : escapeHtml(text)}</div>`,
        cadence: s.cadence,
        weekType: s.weekType,
        teacherId: s.teacherId,
      });
      grid.set(key, arr);
    }
  }

  const head = `<tr><th>Heure</th>${DAYS.map((d) => `<th>${escapeHtml(d)}</th>`).join("")}</tr>`;
  const rows = SLOT_BANDS.map((band) => {
    const cells = DAYS.map((d) => {
      const key = toSlotKey(d, band.start);
      const items = grid.get(key) || [];
      if (!items.length) return `<td class="assign-sim-empty">-</td>`;
      return `<td>${renderSlotBlocksWithBiweeklyLayout(items)}</td>`;
    }).join("");
    return `<tr><th>${escapeHtml(band.label)}</th>${cells}</tr>`;
  }).join("");
  return `<table class="assign-sim-table timetable-shared">${head}${rows}</table>`;
}

function renderAssignSimulationPanel({ classId, teacherId, day, slot, weekType, cadencePreference, title = "Simulation" }) {
  const simulated = buildAssignSimulationSession({ teacherId, classId, day, slot, weekType, cadencePreference });
  if (!simulated) return "";
  const teacher = state.teachers.find((t) => t.id === teacherId);
  const teacherSessions = state.sessions.filter((s) => s.teacherId === teacherId);

  const teacherTable = renderAssignSimulationGrid({
    baseSessions: teacherSessions,
    simulatedSession: simulated,
    weekType,
    labelBuilder: (s) => {
      const c = getClassLabelById(s.classId, true);
      const cadence = normalizeCadence(s.cadence) === "BIWEEKLY" ? ` (${normalizeWeekType(s.weekType)})` : "";
      return `${c}${cadence}${s.__simulated ? " [SIM]" : ""}`;
    },
  });

  const globalTable = renderAssignSimulationGrid({
    baseSessions: state.sessions,
    simulatedSession: simulated,
    weekType,
    labelBuilder: (s) => {
      const t = state.teachers.find((x) => x.id === s.teacherId);
      const tLabel = getTeacherDisplayLabel(t);
      const c = getClassLabelById(s.classId, true);
      const cadence = normalizeCadence(s.cadence) === "BIWEEKLY" ? ` (${normalizeWeekType(s.weekType)})` : "";
      return `${tLabel} - ${c}${cadence}${s.__simulated ? " [SIM]" : ""}`;
    },
  });

  return `
    <div class="assign-sim-panel">
      <p><strong>${escapeHtml(title)}</strong> · ${escapeHtml(teacher?.name || "Prof")} · ${escapeHtml(day)} ${escapeHtml(slot)}</p>
      <div class="assign-sim-split">
        <div>
          <p><strong>Vue prof</strong></p>
          ${teacherTable}
        </div>
        <div>
          <p><strong>Planning général</strong></p>
          ${globalTable}
        </div>
      </div>
    </div>
  `;
}

function renderAssignDecisionSupport(forceError = "") {
  if (!state.assignModal || !ui.assignModalHint) return;
  const classId = String(ui.assignModalClassSelect?.value || "");
  const teacherId = getAssignModalTeacherId();
  const cadencePreference = String(ui.assignModalCadenceSelect?.value || "WEEKLY");
  const { source, day, slot, weekType } = state.assignModal;

  if (!classId || !teacherId) {
    ui.assignModalHint.textContent = "Choisissez une classe pour obtenir une recommandation et un score de qualité.";
    return;
  }

  const current = buildBestSessionProposal(teacherId, classId, day, slot, weekType, cadencePreference, true);
  const recommendations = getBestTeacherRecommendations(classId, day, slot, weekType, cadencePreference, source);
  const top = recommendations[0] || null;

  if (!current.ok) {
    const suggestions = getAssignConflictSuggestions({
      source,
      teacherId,
      classId,
      day,
      slot,
      weekType,
      cadencePreference,
    });
    state.assignModal.lastConflictSuggestions = suggestions.slice();
    const selectedIdxRaw = Number(state.assignModal.previewSuggestionIndex || 0);
    const selectedIdx = Number.isFinite(selectedIdxRaw) ? Math.max(0, Math.min(suggestions.length - 1, selectedIdxRaw)) : 0;
    state.assignModal.previewSuggestionIndex = selectedIdx;
    const actions = suggestions
      .map((s) => {
        if (s.type === "set_teacher") {
          return `<button type="button" class="assign-suggestion-btn secondary-btn" data-assign-hint-action="set_teacher" data-teacher-id="${escapeHtml(s.teacherId)}">${escapeHtml(s.label)}</button>`;
        }
        if (s.type === "set_cadence") {
          return `<button type="button" class="assign-suggestion-btn secondary-btn" data-assign-hint-action="set_cadence" data-cadence="${escapeHtml(s.cadence)}">${escapeHtml(s.label)}</button>`;
        }
        return `<button
          type="button"
          class="assign-suggestion-btn"
          data-assign-hint-action="${escapeHtml(s.type)}"
          data-teacher-id="${escapeHtml(s.teacherId || teacherId)}"
          data-day="${escapeHtml(s.day || day)}"
          data-slot="${escapeHtml(s.slot || slot)}"
          data-cadence="${escapeHtml(s.cadence || cadencePreference)}"
        >Appliquer · ${escapeHtml(s.label)}</button>`;
      })
      .join("");
    const previewTabs = suggestions.length
      ? `<div class="assign-preview-tabs">
          ${suggestions
            .map((s, idx) => {
              const active = idx === selectedIdx ? "active" : "";
              return `<button type="button" class="secondary-btn assign-preview-tab ${active}" data-assign-preview-index="${idx}">Proposition ${idx + 1}</button>`;
            })
            .join("")}
        </div>`
      : "";
    const simTarget = suggestions[selectedIdx] || null;
    const simHtml = simTarget
      ? renderAssignSimulationPanel({
          classId,
          teacherId: String(simTarget.teacherId || teacherId),
          day: String(simTarget.day || day),
          slot: String(simTarget.slot || slot),
          weekType,
          cadencePreference: String(simTarget.cadence || cadencePreference),
          title: `Simulation proposition ${selectedIdx + 1}`,
        })
      : "";
    ui.assignModalHint.innerHTML = `
      <div class="assign-quality-box">
        <p class="hours-over"><strong>Pourquoi non plaçable ?</strong> ${escapeHtml(forceError || current.error || "Affectation impossible.")}</p>
        <p><strong>Suggestions ordonnées</strong></p>
        ${actions ? `<div class="assign-suggestion-row">${actions}</div>` : ""}
        ${previewTabs}
        ${simHtml}
      </div>
    `;
    bindAssignHintActions();
    return;
  }

  const quality = evaluateAssignmentQuality(current.session);
  const simHtml = renderAssignSimulationPanel({
    classId,
    teacherId,
    day,
    slot,
    weekType,
    cadencePreference,
    title: "Simulation placement courant",
  });
  const recommendationHtml =
    top && top.teacher.id !== teacherId
      ? `<p><strong>Recommandation auto:</strong> ${escapeHtml(top.teacher.name)} (score ${top.quality.score}/100)
           <button type="button" class="assign-suggestion-btn secondary-btn" data-assign-hint-action="set_teacher" data-teacher-id="${escapeHtml(top.teacher.id)}">Utiliser ce prof</button>
         </p>`
      : `<p><strong>Recommandation auto:</strong> ce professeur est actuellement le meilleur choix disponible.</p>`;

  ui.assignModalHint.innerHTML = `
    <div class="assign-quality-box">
      <p>
        <strong>Score qualité:</strong>
        <span class="assign-score-badge ${escapeHtml(quality.tone.key)}">${quality.score}/100 · ${escapeHtml(quality.tone.label)}</span>
      </p>
      <ul class="assign-quality-list">
        ${quality.details.map((detail) => `<li>${escapeHtml(detail)}</li>`).join("")}
      </ul>
      ${recommendationHtml}
      ${simHtml}
    </div>
  `;
  bindAssignHintActions();
}

function toSlotKey(day, slot) {
  return `${day}|${slot}`;
}

function getBandForSlot(slot) {
  return SLOT_BANDS.find((b) => b.slots.includes(slot)) || null;
}

function getBandSlotStarts(band) {
  return Array.isArray(band?.slots) && band.slots.length ? band.slots : [String(band?.start || "")];
}

function getSessionBandSegments(session) {
  const segments = [];
  const covered = getCoveredSlots(session.day, session.start, Number(session.duration || 0));
  // Utilise les bandes spécifiques au jour (vendredi : 13h-15h et 15h-17h)
  for (const band of getSlotBandsForDay(session.day)) {
    const bandSlots = getBandSlotStarts(band).filter(Boolean);
    if (!bandSlots.length) continue;
    const coveredSlots = bandSlots.filter((slot) => covered.includes(toSlotKey(session.day, slot)));
    if (!coveredSlots.length) continue;
    let segment = "full";
    if (bandSlots.length === 2) {
      const hasTop = coveredSlots.includes(bandSlots[0]);
      const hasBottom = coveredSlots.includes(bandSlots[1]);
      segment = hasTop && hasBottom ? "full" : hasTop ? "top" : "bottom";
    }
    segments.push({ day: session.day, bandStart: band.start, segment });
  }
  const cls = state.classes.find((c) => c.id === session?.classId);
  const isCinquiemeThreeHour =
    String(session?.type || "").toUpperCase() === "EPS" &&
    getLevelRule(cls?.level)?.group === "CINQUIEME" &&
    Number(session?.duration || 0) === 3 &&
    segments.length > 1;
  if (isCinquiemeThreeHour) {
    return segments.map((seg, index) => ({
      ...seg,
      chainClass:
        index === 0
          ? "session-chain-start"
          : index === segments.length - 1
            ? "session-chain-end"
            : "session-chain-middle",
      showContent: index === 0,
    }));
  }
  return segments;
}

function getSessionSegmentClassName(seg) {
  const classes = [];
  if (seg?.segment && seg.segment !== "full") classes.push(`band-seg-${seg.segment}`);
  if (seg?.chainClass) classes.push(seg.chainClass);
  return classes.length ? ` ${classes.join(" ")}` : "";
}

function renderSessionBlockHtml({
  sessionId,
  text,
  textHtml = "",
  style,
  className,
  cadence,
  weekType,
  extraContent = "",
  showContent = true,
  showRemoveButton = true,
}) {
  const biClass =
    normalizeCadence(cadence) === "BIWEEKLY"
      ? ` biweekly-half biweekly-${normalizeWeekType(weekType).toLowerCase()}`
      : "";
  const draggable = state.assignMode === "view" ? "false" : "true";
  return `
    <div class="${className}${biClass} session-draggable-block" style="${escapeHtml(style)}" draggable="${draggable}" data-session-draggable-id="${escapeHtml(sessionId)}" data-session-block-id="${escapeHtml(sessionId)}">
      <div class="session-block-row">
        <span>${showContent ? (textHtml ? textHtml : escapeHtml(text)) : ""}</span>
        ${showContent ? (extraContent || "") : ""}
        ${showContent && showRemoveButton ? `<button class="session-remove-btn" data-session-id="${escapeHtml(sessionId)}" type="button" title="Désaffecter">x</button>` : ""}
      </div>
    </div>
  `;
}

function renderSlotBlocksWithBiweeklyLayout(blocks) {
  if (!Array.isArray(blocks) || !blocks.length) return "";
  const used = new Set();
  const chunks = [];

  for (let i = 0; i < blocks.length; i += 1) {
    if (used.has(i)) continue;
    const a = blocks[i];
    const isBiweeklyA = normalizeCadence(a?.cadence) === "BIWEEKLY" && normalizeWeekType(a?.weekType) === "A";
    if (!isBiweeklyA) continue;
    const teacherA = String(a?.teacherId || "");
    if (!teacherA) continue;
    let pairIndex = -1;
    for (let j = 0; j < blocks.length; j += 1) {
      if (i === j || used.has(j)) continue;
      const b = blocks[j];
      const isBiweeklyB = normalizeCadence(b?.cadence) === "BIWEEKLY" && normalizeWeekType(b?.weekType) === "B";
      const teacherB = String(b?.teacherId || "");
      if (isBiweeklyB && teacherB === teacherA) {
        pairIndex = j;
        break;
      }
    }
    if (pairIndex >= 0) {
      used.add(i);
      used.add(pairIndex);
      chunks.push(`<div class="biweekly-side-by-side">${a.html || ""}${blocks[pairIndex].html || ""}</div>`);
    }
  }

  for (let i = 0; i < blocks.length; i += 1) {
    if (used.has(i)) continue;
    const block = blocks[i] || {};
    const isBiweekly = normalizeCadence(block?.cadence) === "BIWEEKLY";
    const week = normalizeWeekType(block?.weekType);
    if (isBiweekly) {
      chunks.push(
        `<div class="biweekly-single biweekly-single-${week.toLowerCase()}">${block.html || ""}</div>`
      );
    } else {
      chunks.push(block?.html || "");
    }
  }
  return chunks.join("");
}

function getSessionSlotOrderValue(session) {
  const raw = Number(session?.slotOrder);
  if (Number.isFinite(raw)) return raw;
  return 1000;
}

function sortSessionsBySlotOrder(a, b) {
  const orderCmp = getSessionSlotOrderValue(a) - getSessionSlotOrderValue(b);
  if (orderCmp !== 0) return orderCmp;
  const aLabel = getClassLabelById(a.classId, true);
  const bLabel = getClassLabelById(b.classId, true);
  const labelCmp = String(aLabel || "").localeCompare(String(bLabel || ""), "fr");
  if (labelCmp !== 0) return labelCmp;
  return String(a.id || "").localeCompare(String(b.id || ""), "fr");
}

async function reorderSessionsInSameSlot(draggedSessionId, targetSessionId) {
  const dragged = state.sessions.find((s) => s.id === draggedSessionId);
  const target = state.sessions.find((s) => s.id === targetSessionId);
  if (!dragged || !target) return { ok: false, error: "Créneau introuvable." };
  if (dragged.id === target.id) return { ok: false, error: "Même créneau." };

  const bandDragged = getBandForSlot(String(dragged.start || ""));
  const bandTarget = getBandForSlot(String(target.start || ""));
  if (!bandDragged || !bandTarget) return { ok: false, error: "Tranche horaire introuvable." };

  const sameBucket =
    String(dragged.teacherId || "") === String(target.teacherId || "") &&
    String(dragged.day || "") === String(target.day || "") &&
    String(bandDragged.start || "") === String(bandTarget.start || "");
  if (!sameBucket) {
    return {
      ok: false,
      error: "Réorganisation possible uniquement dans le même créneau (même prof, même jour, même tranche horaire).",
    };
  }

  const bucket = state.sessions
    .filter((s) => {
      const b = getBandForSlot(String(s.start || ""));
      return (
        String(s.teacherId || "") === String(dragged.teacherId || "") &&
        String(s.day || "") === String(dragged.day || "") &&
        String(b?.start || "") === String(bandDragged.start || "")
      );
    })
    .sort(sortSessionsBySlotOrder);

  const from = bucket.findIndex((s) => s.id === dragged.id);
  const to = bucket.findIndex((s) => s.id === target.id);
  if (from < 0 || to < 0 || from === to) return { ok: false, error: "Ordre inchangé." };

  const ordered = bucket.slice();
  const [moved] = ordered.splice(from, 1);
  ordered.splice(to, 0, moved);

  const batch = db.batch();
  let touched = 0;
  ordered.forEach((s, idx) => {
    const nextOrder = (idx + 1) * 10;
    if (Number(s.slotOrder || 0) === nextOrder) return;
    batch.update(doc(db, "sessions", s.id), { slotOrder: nextOrder, updatedAt: serverTimestamp() });
    touched += 1;
  });
  if (!touched) return { ok: true, message: "Ordre déjà à jour." };

  await batch.commit();
  return { ok: true, message: "Ordre des classes mis à jour." };
}

function bindSessionDragStart(container) {
  if (!container) return;
  container.querySelectorAll("[data-session-draggable-id]").forEach((el) => {
    el.addEventListener("dragstart", (e) => {
      if (state.assignMode === "view") {
        e.preventDefault();
        return;
      }
      const sessionId = String(el.getAttribute("data-session-draggable-id") || "").trim();
      if (!sessionId) return;
      e.dataTransfer.setData("application/x-edt-session", sessionId);
      e.dataTransfer.setData("text/plain", `SESSION::${sessionId}`);
      e.dataTransfer.effectAllowed = "move";
    });
    const selectForTouch = () => {
      const sessionId = String(el.getAttribute("data-session-draggable-id") || "").trim();
      if (!sessionId) return;
      selectAssignContext({ kind: "session", sessionId });
      if (state.assignMode !== "view") {
        const label = String(el.querySelector(".session-block-row span")?.textContent || "Cours");
        setTouchAssignPayload(`SESSION::${sessionId}`, `Déplacer: ${label}`);
      }
    };
    el.addEventListener("click", selectForTouch);
    el.addEventListener("touchstart", selectForTouch, { passive: true });
    el.addEventListener("dragover", (e) => {
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = "move";
    });
    el.addEventListener("drop", async (e) => {
      e.preventDefault();
      e.stopPropagation();
      const dropped = getDropPayloadFromEvent(e);
      if (dropped.kind !== "session" || !dropped.sessionId) return;
      const targetSessionId = String(el.getAttribute("data-session-draggable-id") || "").trim();
      if (!targetSessionId || targetSessionId === dropped.sessionId) return;
      const result = await reorderSessionsInSameSlot(dropped.sessionId, targetSessionId);
      if (ui.sessionError) {
        ui.sessionError.textContent = result.ok ? result.message : result.error;
        ui.sessionError.className = result.ok ? "error-text hours-ok" : "error-text hours-over";
      }
    });
  });
}

function getDropPayloadFromEvent(e) {
  const sessionId = String(e.dataTransfer?.getData("application/x-edt-session") || "").trim();
  if (sessionId) return { kind: "session", sessionId };
  const plain = String(e.dataTransfer?.getData("text/plain") || "").trim();
  if (plain.startsWith("SESSION::")) return { kind: "session", sessionId: plain.slice("SESSION::".length) };
  if (!plain) return { kind: "", value: "" };
  return { kind: "assign", value: plain };
}

function bindSessionRemoveButtons(container) {
  container.querySelectorAll(".session-remove-btn").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      e.preventDefault();
      const sessionId = btn.dataset.sessionId;
      if (!sessionId) return;
      const sess = state.sessions.find((s) => s.id === sessionId);
      await deleteDoc(doc(db, "sessions", sessionId));
      // Décrémenter le quota de répartition
      if (sess) {
        await decrementTeacherLevelQuota(sess.teacherId, sess.classId);
      }
      logActivity("session_deleted", { sessionId, day: sess?.day, start: sess?.start, classId: sess?.classId, teacherId: sess?.teacherId });
    });
  });
}

async function moveSessionByDrag(sessionId, targetTeacherId, targetDay, targetSlot, options = {}) {
  const promptOnOverride = Boolean(options?.promptOnOverride);
  const session = state.sessions.find((s) => s.id === sessionId);
  if (!session) return { ok: false, error: "Créneau introuvable." };
  const nextTeacherId = String(targetTeacherId || session.teacherId || "").trim();
  if (!nextTeacherId) return { ok: false, error: "Professeur cible introuvable." };

  const payload = {
    teacherId: nextTeacherId,
    classId: session.classId,
    type: session.type || "EPS",
    day: String(targetDay || "").trim(),
    start: String(targetSlot || "").trim(),
    duration: Number(session.duration || 0),
    cadence: normalizeCadence(session.cadence),
    weekType: normalizeWeekType(session.weekType),
  };

  const index = state.sessions.findIndex((s) => s.id === sessionId);
  let check;
  if (index >= 0) {
    const [removed] = state.sessions.splice(index, 1);
    try {
      check = validateSession(payload);
    } finally {
      state.sessions.splice(index, 0, removed);
    }
  } else {
    check = validateSession(payload);
  }

  if (!check?.ok) {
    if (!promptOnOverride) return check;
    const reason = check?.error || "Contrainte non respectée.";
    const confirmed = confirm(`Avertissement déplacement:\n${reason}\n\nVoulez-vous déplacer ce cours quand même ?`);
    if (!confirmed) return { ok: false, error: "Déplacement annulé." };
    try {
      await updateDoc(doc(db, "sessions", sessionId), {
        teacherId: payload.teacherId,
        day: payload.day,
        start: payload.start,
        duration: payload.duration,
        cadence: payload.cadence,
        weekType: payload.cadence === "BIWEEKLY" ? payload.weekType : null,
        manualOverride: true,
        manualOverrideReason: reason,
        updatedAt: serverTimestamp(),
      });

      // Ajuster les quotas si le prof a changé
      if (session.teacherId !== payload.teacherId) {
        await decrementTeacherLevelQuota(session.teacherId, session.classId);
        await incrementTeacherLevelQuota(payload.teacherId, session.classId);
      }

      return { ok: true, message: `Avertissement: ${reason}. Cours déplacé.` };
    } catch (error) {
      return { ok: false, error: `Erreur déplacement: ${error?.message || "mise à jour impossible."}` };
    }
  }

  try {
    await updateDoc(doc(db, "sessions", sessionId), {
      teacherId: check.normalized.teacherId,
      day: check.normalized.day,
      start: check.normalized.start,
      duration: check.normalized.duration,
      cadence: check.normalized.cadence,
      weekType: check.normalized.cadence === "BIWEEKLY" ? check.normalized.weekType : null,
      manualOverride: null,
      manualOverrideReason: null,
      updatedAt: serverTimestamp(),
    });

    // Ajuster les quotas si le prof a changé
    if (session.teacherId !== check.normalized.teacherId) {
      await decrementTeacherLevelQuota(session.teacherId, session.classId);
      await incrementTeacherLevelQuota(check.normalized.teacherId, session.classId);
    }

    return { ok: true, message: "Cours déplacé." };
  } catch (error) {
    return { ok: false, error: `Erreur déplacement: ${error?.message || "mise à jour impossible."}` };
  }
}

function getCoveredSlots(day, start, duration) {
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

function slotsOverlap(a, b) {
  const setB = new Set(b);
  return a.some((x) => setB.has(x));
}

function getSuggestedCadenceForTeacherSlot(teacherId, day, slot) {
  if (!teacherId || !day || !slot) return "AUTO";
  const targetKey = toSlotKey(day, slot);
  let hasWeekly = false;
  let hasA = false;
  let hasB = false;
  for (const s of state.sessions) {
    if (s.teacherId !== teacherId) continue;
    const covered = getCoveredSlots(s.day, s.start, Number(s.duration || 0));
    if (!covered.includes(targetKey)) continue;
    const cadence = normalizeCadence(s.cadence);
    if (cadence === "WEEKLY") {
      hasWeekly = true;
      break;
    }
    if (normalizeWeekType(s.weekType) === "A") hasA = true;
    if (normalizeWeekType(s.weekType) === "B") hasB = true;
  }
  if (hasWeekly) return "AUTO";
  if (hasA && !hasB) return "WEEK_B";
  if (hasB && !hasA) return "WEEK_A";
  return "AUTO";
}

function findNextAvailableASId() {
  const usedIds = new Set(state.sessions.filter(s => String(s.classId || "").startsWith("__AS")).map(s => s.classId));
  for (let i = 1; i <= 20; i++) {
    const candidate = `__AS${i}__`;
    if (!usedIds.has(candidate)) return candidate;
  }
  return "__AS__"; // Fallback
}

function buildManualOverrideSession(teacherId, classId, day, slot, weekType = "A", cadencePreference = "AUTO") {
  const special = getSpecialAssignmentById(classId);
  const cls = state.classes.find((c) => c.id === classId);
  const pref = normalizeCadencePreference(cadencePreference);
  const isBiweekly = pref === "WEEK_A" || pref === "WEEK_B";
  const cadence = isBiweekly ? "BIWEEKLY" : "WEEKLY";
  const normalizedWeek = isBiweekly ? (pref === "WEEK_B" ? "B" : "A") : normalizeWeekType(weekType);
  if (special) {
    const band = getBandForSlot(slot);
    const asStart = band ? getBandSlotStarts(band)[0] : slot;
    return {
      teacherId,
      classId,
      type: special.type,
      day,
      start: special.type === "AS" ? asStart : slot,
      duration: special.type === "AS" ? 1 : 2,
      cadence,
      weekType: normalizedWeek,
    };
  }
  const rule = getLevelRule(cls?.level);
  const duration = rule?.group === "CINQUIEME" ? 3 : 2;
  return {
    teacherId,
    classId,
    type: "EPS",
    day,
    start: slot,
    duration,
    cadence,
    weekType: normalizedWeek,
  };
}

async function quickAssignFromPlanner(teacherId, day, slot, classId, cadencePreference = "AUTO", options = {}) {
  if (!teacherId) return { ok: false, error: "Aucun professeur sélectionné." };
  const promptOnOverride = Boolean(options?.promptOnOverride);
  
  const targetClassId = classId === "__AS__" ? findNextAvailableASId() : classId;
  const proposal = buildBestSessionProposal(teacherId, targetClassId, day, slot, "A", cadencePreference);
  if (!proposal.ok || !proposal.session) {
    if (!promptOnOverride) return proposal;
    const reason = proposal.error || "Affectation hors contraintes.";
    const confirmText = `Avertissement affectation:\n${reason}\n\nVoulez-vous affecter quand même ce créneau ?`;
    if (!confirm(confirmText)) return { ok: false, error: "Affectation annulée." };
    const forcedPayload = buildManualOverrideSession(teacherId, targetClassId, day, slot, "A", cadencePreference);
    const forcedResult = await createSession(forcedPayload, { manualOverride: true, overrideReason: reason });
    if (!forcedResult.ok) return forcedResult;
    const classLabelForced = getClassLabelById(targetClassId, true);
    return {
      ok: true,
      message: `Avertissement: ${reason}. Affecté: ${classLabelForced} -> ${day} ${forcedPayload.start} (${forcedPayload.cadence === "BIWEEKLY" ? `Semaine ${forcedPayload.weekType}` : "hebdo"}).`,
    };
  }
  const createResult = await createSession(proposal.session);
  if (!createResult.ok) {
    if (!promptOnOverride) return createResult;
    const reason = createResult.error || "Affectation hors contraintes.";
    const confirmText = `Avertissement affectation:\n${reason}\n\nVoulez-vous affecter quand même ce créneau ?`;
    if (!confirm(confirmText)) return { ok: false, error: "Affectation annulée." };
    const forcedPayload = buildManualOverrideSession(teacherId, targetClassId, day, slot, "A", cadencePreference);
    const forcedResult = await createSession(forcedPayload, { manualOverride: true, overrideReason: reason });
    if (!forcedResult.ok) return forcedResult;
    const classLabelForced = getClassLabelById(targetClassId, true);
    return {
      ok: true,
      message: `Avertissement: ${reason}. Affecté: ${classLabelForced} -> ${day} ${forcedPayload.start} (${forcedPayload.cadence === "BIWEEKLY" ? `Semaine ${forcedPayload.weekType}` : "hebdo"}).`,
    };
  }
  const classLabel = getClassLabelById(targetClassId, true);
  const warning = getLateCollegeWarning(targetClassId, proposal.session.start);
  return {
    ok: true,
    message: `Affecté: ${classLabel} -> ${day} ${proposal.session.start} (${proposal.session.cadence === "BIWEEKLY" ? `Semaine ${proposal.session.weekType}` : "hebdo"}).${warning ? ` ${warning}` : ""}`,
  };
}

async function quickAssignFromGlobal(day, slot, teacherId, classId, weekType, cadencePreference = "AUTO", options = {}) {
  const promptOnOverride = Boolean(options?.promptOnOverride);
  const targetClassId = classId === "__AS__" ? findNextAvailableASId() : classId;
  const proposal = buildBestSessionProposal(teacherId, targetClassId, day, slot, weekType, cadencePreference);
  if (!proposal.ok || !proposal.session) {
    if (!promptOnOverride) return proposal;
    const reason = proposal.error || "Affectation hors contraintes.";
    const confirmText = `Avertissement affectation:\n${reason}\n\nVoulez-vous affecter quand même ce créneau ?`;
    if (!confirm(confirmText)) return { ok: false, error: "Affectation annulée." };
    const forcedPayload = buildManualOverrideSession(teacherId, targetClassId, day, slot, weekType, cadencePreference);
    const forcedResult = await createSession(forcedPayload, { manualOverride: true, overrideReason: reason });
    if (!forcedResult.ok) return forcedResult;
    const classLabelForced = getClassLabelById(targetClassId, true);
    return {
      ok: true,
      message: `Avertissement: ${reason}. Affecté: ${classLabelForced} -> ${day} ${forcedPayload.start}.`,
    };
  }
  const createResult = await createSession(proposal.session);
  if (!createResult.ok) {
    if (!promptOnOverride) return createResult;
    const reason = createResult.error || "Affectation hors contraintes.";
    const confirmText = `Avertissement affectation:\n${reason}\n\nVoulez-vous affecter quand même ce créneau ?`;
    if (!confirm(confirmText)) return { ok: false, error: "Affectation annulée." };
    const forcedPayload = buildManualOverrideSession(teacherId, targetClassId, day, slot, weekType, cadencePreference);
    const forcedResult = await createSession(forcedPayload, { manualOverride: true, overrideReason: reason });
    if (!forcedResult.ok) return forcedResult;
    const classLabelForced = getClassLabelById(targetClassId, true);
    return {
      ok: true,
      message: `Avertissement: ${reason}. Affecté: ${classLabelForced} -> ${day} ${forcedPayload.start}.`,
    };
  }
  const classLabel = getClassLabelById(targetClassId, true);
  const warning = getLateCollegeWarning(targetClassId, proposal.session.start);
  return {
    ok: true,
    message: `Affecté: ${classLabel} -> ${day} ${proposal.session.start}.${warning ? ` ${warning}` : ""}`,
  };
}

function validateSession(payload) {
  const { teacherId, classId, type, day, start, duration } = payload;
  const cadence = normalizeCadence(payload.cadence);
  const weekType = normalizeWeekType(payload.weekType);

  if (!teacherId || !classId || !type || !day || !start || !duration) {
    return { ok: false, error: "Informations incomplètes pour créer le créneau." };
  }

  const teacher = state.teachers.find((t) => t.id === teacherId);
  const special = getSpecialAssignmentById(classId);
  const cls = state.classes.find((c) => c.id === classId);
  if (!teacher) return { ok: false, error: "Professeur introuvable." };
  if (!cls && !special) return { ok: false, error: "Classe introuvable." };
  if (!special) {
    const ownerTeacherId = getClassOwnerTeacherId(classId);
    if (ownerTeacherId && ownerTeacherId !== teacherId) {
      const owner = state.teachers.find((t) => t.id === ownerTeacherId);
      return {
        ok: false,
        error: `Conflit: ${getClassLabelById(classId)} appartient déjà à ${owner?.name || "un autre professeur"} (1 classe = 1 professeur).`,
      };
    }
  }
  if (!isTeacherAssignedToClass(teacher, classId)) {
    return {
      ok: false,
      error: `Affectation non autorisée: ${teacher.name || "ce professeur"} n'est pas configuré pour ${getClassLabelById(classId, true)}.`,
    };
  }
  if (!canTeacherTakeClassByLevelQuota(teacher, classId)) {
    const clsLevel = state.classes.find((c) => c.id === classId)?.level || "ce niveau";
    return {
      ok: false,
      error: `Quota atteint: ${teacher.name || "ce professeur"} a déjà le nombre maximal de classes autorisé en ${clsLevel}.`,
    };
  }

  const plannedSlots = getCoveredSlots(day, start, Number(duration));
  if (!plannedSlots.length) return { ok: false, error: "Créneau invalide (fin de journée dépassée)." };
  if (!isBandStartAllowedOnDay(day, start)) {
    return { ok: false, error: `Règle ${day}: ce créneau n'est pas autorisé.` };
  }
  const candidate = { day, start, duration: Number(duration), cadence, weekType };

  // Option 3: Limite de charge quotidienne (max 6h par jour de cours EPS)
  const currentDailyHours = getTeacherDailyTeachingHours(teacherId, day, weekType);
  if (currentDailyHours + Number(duration) > 6.001) {
    return { ok: false, error: `Conflit: ${escapeHtml(teacher.name)} dépasserait la limite de 6h de cours sur la journée du ${day}.` };
  }

  if (type === "AS" || isASLike({ classId, type })) {
    if (!["12:10", "13:00"].includes(String(start || ""))) {
      return { ok: false, error: "Règle AS: les créneaux AS doivent être placés entre 12h et 14h." };
    }
    if (Number(duration) !== 1) {
      return { ok: false, error: "Règle AS: un créneau AS dure 1h." };
    }
    if (cadence !== "WEEKLY") {
      return { ok: false, error: "Règle AS: les créneaux AS sont hebdomadaires." };
    }
  }

  if (type === "EPS" && cls) {
    const rule = getLevelRule(cls.level);
    // Verrou horaire: éviter les cours EPS "à cheval" 13h-14h / 14h-16h.
    // Seuls les 5e utilisent la plage de midi via 12:10-15:10.
    if (start === "13:00" && rule?.group !== "CINQUIEME" && day !== "Vendredi") {
      return { ok: false, error: "Règle EPS: les cours ne peuvent pas démarrer à 13h00 (réservé aux découpages midi/AS)." };
    }
    if (rule?.group === "CINQUIEME") {
      if (start !== "12:10") return { ok: false, error: "Règle EPS 5e: la séance doit commencer à 12:10 (entre midi et deux)." };
      if (Number(duration) !== 3) return { ok: false, error: "Règle EPS 5e: une séance doit durer 3h." };
      if (cadence !== "WEEKLY") return { ok: false, error: "Règle EPS 5e: la planification se fait toutes les semaines." };
      const existingCinquiemeSameSlot = state.sessions.filter((s) => {
        if (String(s.day || "") !== day) return false;
        if (String(s.start || "") !== "12:10") return false;
        if (!sessionsCanOccurSameWeek(candidate, s)) return false;
        if (String(s.type || "").toUpperCase() !== "EPS") return false;
        const c = state.classes.find((x) => x.id === s.classId);
        return Boolean(c && getLevelRule(c.level)?.group === "CINQUIEME");
      }).length;
      if (existingCinquiemeSameSlot >= 3) {
        return { ok: false, error: "Règle EPS 5e: maximum 3 classes de 5e simultanées sur le créneau de midi." };
      }
    } else {
      if (Number(duration) !== 2) return { ok: false, error: "Règle EPS: une séance EPS doit durer 2h." };
    }
    if ((rule?.group === "SIXIEME" || rule?.group === "LYCEE") && cadence !== "WEEKLY") {
      return { ok: false, error: "Règle EPS: ce niveau doit être planifié chaque semaine." };
    }
    if (rule?.group !== "ALT_43" && cadence === "BIWEEKLY") {
      return { ok: false, error: "Les créneaux Semaine A/B sont autorisés uniquement pour les classes de 4e et 3e." };
    }
    if (String(cls.level || "") === "Seconde") {
      const allowedSecondeStarts = day === "Vendredi" ? ["15:00"] : ["16:05"];
      if (!allowedSecondeStarts.includes(start)) {
        return {
          ok: false,
          error: day === "Vendredi"
            ? "Règle Seconde (vendredi): les cours doivent être placés sur 15h00-17h00."
            : "Règle Seconde: les cours doivent être placés sur 16h05-17h50.",
        };
      }
    }
    if (rule?.group === "ALT_43") {
      const classEpsSessions = state.sessions.filter(
        (s) => s.classId === classId && String(s.type || "").toUpperCase() === "EPS"
      );
      const weeklyCount = classEpsSessions.filter((s) => normalizeCadence(s.cadence) === "WEEKLY").length;
      const biweeklyCount = classEpsSessions.filter((s) => normalizeCadence(s.cadence) === "BIWEEKLY").length;
      if (cadence === "WEEKLY" && weeklyCount >= 1) {
        return {
          ok: false,
          error: "Règle 4e/3e: un seul créneau hebdomadaire fixe est autorisé par classe.",
        };
      }
      if (cadence === "BIWEEKLY" && biweeklyCount >= 1) {
        return {
          ok: false,
          error: "Règle 4e/3e: un seul créneau une semaine sur deux est autorisé par classe.",
        };
      }
    }
  }

  // Règle métier: le créneau 16h05-17h50 est réservé aux classes de Seconde.
  if (start >= "16:05") {
    const isSecondeClass = Boolean(cls && String(cls.level || "") === "Seconde");
    if (!isSecondeClass) {
      return {
        ok: false,
        error: "Règle: les créneaux de 16h à 18h sont réservés aux classes de Seconde.",
      };
    }
  }

  // Le créneau 12:10 est réservé à l'AS et aux EPS de 5e.
  if (start === "12:10") {
    const isCinquiemeEps = Boolean(type === "EPS" && cls && getLevelRule(cls.level)?.group === "CINQUIEME");
    if (!isCinquiemeEps && type !== "AS" && !isASLike({ classId })) {
      return { ok: false, error: "Le créneau 12h10 - 13h55 est réservé à l'AS et aux classes de 5e." };
    }
  }
  const candidateSlots = plannedSlots;

  const isCinquiemeLikeSession = (sessionLike) => {
    if (!sessionLike) return false;
    if (String(sessionLike.type || "").toUpperCase() !== "EPS") return false;
    const c = state.classes.find((x) => x.id === sessionLike.classId);
    return Boolean(c && getLevelRule(c.level)?.group === "CINQUIEME");
  };

  const currentTeacherHours = state.sessions
    .filter((s) => s.teacherId === teacherId)
    .reduce((acc, s) => acc + weeklyEquivalentHours(s), 0);
  const candidateHours = weeklyEquivalentHours(candidate);
  const maxHours = Number(teacher.maxHours || 0);
  if (maxHours > 0 && currentTeacherHours + candidateHours > maxHours + 1e-9) {
    return {
      ok: false,
      error: `Conflit: ${escapeHtml(teacher.name)} dépasserait son temps de travail (${formatHours(currentTeacherHours + candidateHours)}/${formatHours(maxHours)}h).`,
    };
  }

  // Règle métier: un enseignant ne peut pas dépasser 6h de cours par jour.
  const teacherDaySessions = state.sessions.filter((s) => s.teacherId === teacherId && String(s.day || "") === day);
  const dayHoursWeekA =
    teacherDaySessions
      .filter((s) => isSessionVisibleForWeek(s, "A"))
      .reduce((acc, s) => acc + Number(s.duration || 0), 0) +
    (isSessionVisibleForWeek(candidate, "A") ? Number(candidate.duration || 0) : 0);
  const dayHoursWeekB =
    teacherDaySessions
      .filter((s) => isSessionVisibleForWeek(s, "B"))
      .reduce((acc, s) => acc + Number(s.duration || 0), 0) +
    (isSessionVisibleForWeek(candidate, "B") ? Number(candidate.duration || 0) : 0);
  const worstDayHours = Math.max(dayHoursWeekA, dayHoursWeekB);
  if (worstDayHours > 6 + 1e-9) {
    return {
      ok: false,
      error: `Conflit: ${escapeHtml(teacher.name)} dépasserait 6h de cours le ${day} (${formatHours(worstDayHours)}h).`,
    };
  }

  // Règle métier: éviter les longues coupures. Trou max autorisé: 2h.
  const getMaxInternalGapHoursForWeek = (weekTypeRef) => {
    const daySessions = state.sessions
      .filter((s) => s.teacherId === teacherId && String(s.day || "") === day)
      .filter((s) => isSessionVisibleForWeek(s, weekTypeRef));
    if (isSessionVisibleForWeek(candidate, weekTypeRef)) daySessions.push(candidate);

    const occupiedIndexes = new Set();
    for (const s of daySessions) {
      const covered = getCoveredSlots(day, s.start, Number(s.duration || 0));
      for (const key of covered) {
        const [, slot] = String(key).split("|");
        const idx = SLOTS.indexOf(slot);
        if (idx >= 0) occupiedIndexes.add(idx);
      }
    }
    if (occupiedIndexes.size <= 1) return 0;

    const sorted = Array.from(occupiedIndexes).sort((a, b) => a - b);
    let maxGapSlots = 0;
    for (let i = 1; i < sorted.length; i += 1) {
      const gapSlots = Math.max(0, sorted[i] - sorted[i - 1] - 1);
      if (gapSlots > maxGapSlots) maxGapSlots = gapSlots;
    }
    return maxGapSlots;
  };
  const maxGapA = getMaxInternalGapHoursForWeek("A");
  const maxGapB = getMaxInternalGapHoursForWeek("B");
  const worstGap = Math.max(maxGapA, maxGapB);
  if (worstGap > 2) {
    return {
      ok: false,
      error: `Conflit: trou de ${formatHours(worstGap)}h sur la journée (${day}). Maximum autorisé: 2h.`,
    };
  }

  // Les 5e n'occupent pas d'installation sportive:
  // ils sont exclus du plafond de simultanéité par créneau.
  if (!isCinquiemeLikeSession(candidate)) {
    const overlappingTeacherIds = new Set(
      state.sessions
        .filter((s) => !isCinquiemeLikeSession(s))
        .filter((s) => sessionsCanOccurSameWeek(candidate, s))
        .filter((s) => {
          const bSlots = getCoveredSlots(s.day, s.start, Number(s.duration || 0));
          return slotsOverlap(candidateSlots, bSlots);
        })
        .map((s) => s.teacherId)
        .filter(Boolean)
    );
    const projectedTeacherCount = new Set([...overlappingTeacherIds, teacherId]).size;
    if (projectedTeacherCount > 5) {
      return {
        ok: false,
        error: "Conflit: maximum 5 professeurs simultanés par créneau horaire (hors 5e).",
      };
    }
  }

  const isUnavailable = plannedSlots.some((slotKey) => (teacher.unavailable || []).includes(slotKey));
  if (isUnavailable) {
    return { ok: false, error: `Conflit: ${escapeHtml(teacher.name)} est marqué indisponible sur ce créneau (${day} ${start}).` };
  }
  const blockedByDesiderataUnavailable = plannedSlots.some((slotKey) => {
    const [d, s] = String(slotKey).split("|");
    return hasDesiderataUnavailableSlot(teacherId, d, s);
  });
  if (blockedByDesiderataUnavailable) {
    return {
      ok: false,
      error: `Conflit: ${escapeHtml(teacher.name)} a marqué ce créneau en indisponible dans les désidérata (${day} ${start}).`,
    };
  }
  const blockedByDayOff = plannedSlots.some((slotKey) => {
    const [d, s] = String(slotKey).split("|");
    return hasDesiderataDayOffSlot(teacherId, d, s);
  });
  if (blockedByDayOff) {
    return {
      ok: false,
      error: `Conflit: ${escapeHtml(teacher.name)} est en journée OFF sur ce créneau (${day} ${start}).`,
    };
  }

  // Règle métier: si un prof commence à 08:15, il ne peut pas finir à 18h le même jour.
  const teacherDaySessionsBoundary = state.sessions.filter((s) => s.teacherId === teacherId && String(s.day || "") === day);
  const hasDayBoundaryConflict = (weekTypeRef) => {
    const visible = teacherDaySessionsBoundary.filter((s) => isSessionVisibleForWeek(s, weekTypeRef));
    const all = [...visible, candidate];
    const hasEarlyStart = all.some((s) => {
      const covered = getCoveredSlots(s.day, s.start, Number(s.duration || 0));
      return covered.includes(toSlotKey(day, "08:15"));
    });
    const hasLateEnd = all.some((s) => {
      const covered = getCoveredSlots(s.day, s.start, Number(s.duration || 0));
      return covered.includes(toSlotKey(day, "16:05")) || covered.includes(toSlotKey(day, "16:55"));
    });
    return hasEarlyStart && hasLateEnd;
  };
  if (hasDayBoundaryConflict("A") || hasDayBoundaryConflict("B")) {
    return {
      ok: false,
      error: `Conflit: ${escapeHtml(teacher.name)} ne peut pas commencer à 08:15 et finir à 18h le même jour (${day}).`,
    };
  }

  const tConflict = state.sessions.find((s) => s.teacherId === teacherId && sessionsConflict(candidate, s));
  if (tConflict) {
    const cLabel = getClassLabelById(tConflict.classId);
    return { ok: false, error: `Conflit: ${escapeHtml(teacher.name)} a déjà un cours avec ${cLabel} (${tConflict.day} ${tConflict.start}).` };
  }

  if (!special) {
    const cConflict = state.sessions.find((s) => s.classId === classId && sessionsConflict(candidate, s));
    if (cConflict) {
      const p = state.teachers.find(t => t.id === cConflict.teacherId);
      return { ok: false, error: `Conflit: la classe ${getClassLabelById(classId)} est déjà occupée avec ${p ? p.name : 'un prof'} (${cConflict.day} ${cConflict.start}).` };
    }
  }

  // Règle métier: pour une même classe avec le même enseignant, les débuts de cours
  // doivent être espacés d'au moins 24h lorsqu'ils peuvent avoir lieu la même semaine.
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

async function createSession(payload, options = {}) {
  const manualOverride = Boolean(options?.manualOverride);
  let s = null;
  if (!manualOverride) {
    const check = validateSession(payload);
    if (!check.ok) return check;
    s = check.normalized;
  } else {
    const teacherId = String(payload?.teacherId || "").trim();
    const classId = String(payload?.classId || "").trim();
    const type = String(payload?.type || "").trim();
    const day = String(payload?.day || "").trim();
    const start = String(payload?.start || "").trim();
    const duration = Number(payload?.duration || 0);
    const cadence = normalizeCadence(payload?.cadence);
    const weekType = normalizeWeekType(payload?.weekType);
    const teacher = state.teachers.find((t) => t.id === teacherId);
    const special = getSpecialAssignmentById(classId);
    const cls = state.classes.find((c) => c.id === classId);
    if (!teacher) return { ok: false, error: "Professeur introuvable." };
    if (!cls && !special) return { ok: false, error: "Classe introuvable." };
    if (!DAYS.includes(day) || !start || duration <= 0) return { ok: false, error: "Créneau invalide." };
    if (!getCoveredSlots(day, start, duration).length) return { ok: false, error: "Créneau invalide (hors plage)." };
    s = { teacherId, classId, type: type || (special?.type || "EPS"), day, start, duration, cadence, weekType };
  }
  try {
    await addDoc(collection(db, "sessions"), {
      schoolYearId: getActiveSchoolYearId(),
      teacherId: s.teacherId,
      classId: s.classId,
      type: s.type,
      day: s.day,
      start: s.start,
      duration: s.duration,
      cadence: s.cadence,
      weekType: s.cadence === "BIWEEKLY" ? s.weekType : null,
      manualOverride: manualOverride ? true : null,
      manualOverrideReason: manualOverride ? String(options?.overrideReason || "") : null,
      placedBy: options?.placedBy === "ALGO" ? "ALGO" : "MANUAL",
      createdAt: serverTimestamp(),
    });

    // Auto-incrémenter le quota de répartition si c'est une classe réelle (non AS/Danse)
    const cls = state.classes.find(c => c.id === s.classId);
    if (cls && cls.level) {
      const teacher = state.teachers.find(t => t.id === s.teacherId);
      if (teacher) {
        const quotas = teacher.assignedLevelQuotas || {};
        const currentQuota = quotas[cls.level] || 0;
        const updatedQuotas = { ...quotas, [cls.level]: currentQuota + 1 };
        await updateDoc(doc(db, "teachers", s.teacherId), {
          assignedLevelQuotas: updatedQuotas
        });
      }
    }

    logActivity("session_created", {
      teacherId: s.teacherId,
      classId: s.classId,
      day: s.day,
      start: s.start,
      duration: s.duration,
      cadence: s.cadence,
    });
    return { ok: true };
  } catch (error) {
    const code = String(error?.code || "");
    if (code.includes("permission-denied")) {
      return {
        ok: false,
        error: "Permission Firestore refusée. Déployez les règles: `firebase deploy --only firestore:rules`.",
      };
    }
    return { ok: false, error: `Erreur Firestore: ${error?.message || "écriture impossible."}` };
  }
}

function sessionsConflict(a, b) {
  const aSlots = getCoveredSlots(a.day, a.start, Number(a.duration || 0));
  const bSlots = getCoveredSlots(b.day, b.start, Number(b.duration || 0));
  if (!slotsOverlap(aSlots, bSlots)) return false;

  const aCadence = normalizeCadence(a.cadence);
  const bCadence = normalizeCadence(b.cadence);
  if (aCadence === "WEEKLY" || bCadence === "WEEKLY") return true;
  return normalizeWeekType(a.weekType) === normalizeWeekType(b.weekType);
}

function weeklyEquivalentHours(session) {
  const duration = Number(session?.duration || 0);
  return normalizeCadence(session?.cadence) === "BIWEEKLY" ? duration / 2 : duration;
}

function isSessionVisibleForWeek(session, weekType) {
  const cadence = normalizeCadence(session?.cadence);
  if (cadence === "WEEKLY") return true;
  return normalizeWeekType(session?.weekType) === normalizeWeekType(weekType);
}

function normalizeCadence(cadence) {
  return cadence === "BIWEEKLY" ? "BIWEEKLY" : "WEEKLY";
}

function normalizeWeekType(weekType) {
  return weekType === "B" ? "B" : "A";
}

function sessionsCanOccurSameWeek(a, b) {
  const aCadence = normalizeCadence(a?.cadence);
  const bCadence = normalizeCadence(b?.cadence);
  if (aCadence === "WEEKLY" || bCadence === "WEEKLY") return true;
  return normalizeWeekType(a?.weekType) === normalizeWeekType(b?.weekType);
}

function toWeekStartHour(day, start) {
  const dayIndex = Math.max(0, DAYS.indexOf(day));
  const [hStr, mStr] = String(start || "00:00").split(":");
  const hour = Number(hStr || 0);
  const minute = Number(mStr || 0);
  return dayIndex * 24 + hour + minute / 60;
}

function getLateCollegeWarning(classId, start) {
  const cls = state.classes.find((c) => c.id === classId);
  if (!cls) return "";
  const rule = getLevelRule(cls.level);
  const isCollege = rule?.group === "SIXIEME" || rule?.group === "CINQUIEME" || rule?.group === "ALT_43";
  if (!isCollege) return "";
  const [hourStr] = String(start || "00:00").split(":");
  const hour = Number(hourStr || 0);
  if (hour <= 16) return "";
  return `Alerte: ${cls.level} ${cls.name} est placé après 16h.`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatHours(value) {
  const n = Number(value || 0);
  return Number.isInteger(n) ? String(n) : n.toFixed(1).replace(".", ",");
}

function getLevelRule(level) {
  return LEVEL_RULES[level] || null;
}

function getLevelPrefix(level) {
  const mapping = {
    "Sixième": "6",
    "Cinquième": "5",
    "Quatrième": "4",
    "Troisième": "3",
    Seconde: "2",
    "Première": "1",
    Terminale: "T",
  };
  return mapping[level] || "";
}

function getUnassignedClasses() {
  const assignedByClass = new Map();
  for (const c of state.classes) assignedByClass.set(c.id, 0);
  for (const s of state.sessions) {
    assignedByClass.set(s.classId, (assignedByClass.get(s.classId) || 0) + weeklyEquivalentHours(s));
  }
  return state.classes.filter((c) => (assignedByClass.get(c.id) || 0) < Number(c.weeklyHours || 0));
}

function getSpecialAssignmentById(id) {
  if (String(id || "").startsWith("__AS")) {
    const num = String(id).replace(/__AS|__/g, "");
    return { id, label: "AS" + (num ? " " + num : ""), type: "AS" };
  }
  return SPECIAL_ASSIGNMENTS.find((x) => x.id === id) || null;
}

function isSpecialAssignmentId(id) {
  return Boolean(getSpecialAssignmentById(id));
}

function normalizeTeacherAssignedTargets(targets) {
  const raw = Array.isArray(targets) ? targets : [];
  const set = new Set(raw.map((x) => String(x || "").trim()).filter(Boolean));
  return Array.from(set);
}

function getTeacherQuotaCatalog() {
  const shortLevelLabels = {
    "Sixième": "6ème",
    "Cinquième": "5ème",
    "Quatrième": "4ème",
    "Troisième": "3ème",
    Seconde: "2nde",
    "Première": "1ère",
    Terminale: "Tle",
  };
  const levels = Object.keys(LEVEL_RULES).map((level) => ({
    key: level,
    label: shortLevelLabels[level] || level,
    weeklyHours: Number(getLevelRule(level)?.weeklyHours || 0),
    kind: "level",
  }));
  const specials = [
    { key: "AS", label: "AS", weeklyHours: 1, kind: "special" },
    { key: "DANSE", label: "Danse", weeklyHours: 1, kind: "special" },
    { key: "COORD", label: "Heure de coordo", weeklyHours: 1, kind: "special" },
    { key: "PROJET", label: "Heure projet", weeklyHours: 1, kind: "special" },
  ];
  return [...levels, ...specials];
}

function normalizeTeacherAssignedLevelQuotas(quotas, legacyTargets = []) {
  const out = {};
  const validKeys = new Set(getTeacherQuotaCatalog().map((x) => x.key));
  if (quotas && typeof quotas === "object") {
    validKeys.forEach((key) => {
      const n = Math.max(0, Math.floor(Number(quotas[key] || 0)));
      if (n > 0) out[key] = n;
    });
    if (Object.keys(out).length) return out;
  }
  const legacy = normalizeTeacherAssignedTargets(legacyTargets);
  for (const id of legacy) {
    if (id === "__AS__") {
      out.AS = (out.AS || 0) + 1;
      continue;
    }
    if (id === "__DANSE__") {
      out.DANSE = (out.DANSE || 0) + 1;
      continue;
    }
    const cls = state.classes.find((c) => c.id === id);
    if (!cls || !LEVEL_RULES[cls.level]) continue;
    out[cls.level] = (out[cls.level] || 0) + 1;
  }
  return out;
}

function getTeacherAssignedLevelQuotas(teacher) {
  return normalizeTeacherAssignedLevelQuotas(teacher?.assignedLevelQuotas, teacher?.assignedTargets || []);
}

function getTeacherAssignedQuotaTotal(teacher) {
  return Object.values(getTeacherAssignedLevelQuotas(teacher)).reduce((acc, value) => acc + Number(value || 0), 0);
}

function isTeacherAssignedToClass(teacher, classId) {
  const quotas = getTeacherAssignedLevelQuotas(teacher);
  const quotaTotal = Object.values(quotas).reduce((acc, value) => acc + Number(value || 0), 0);
  if (!quotaTotal) return true;
  const special = getSpecialAssignmentById(classId);
  if (special) {
    const specialKey = special.type === "AS" ? "AS" : "DANSE";
    return Number(quotas[specialKey] || 0) > 0;
  }
  const cls = state.classes.find((c) => c.id === classId);
  if (!cls) return false;
  const repartitionTeacherId = getRepartitionAssignedTeacherIdForClass(classId);
  if (repartitionTeacherId) return repartitionTeacherId === teacher.id;
  return Number(quotas[cls.level] || 0) > 0;
}

function canTeacherTakeClassByLevelQuota(teacher, classId) {
  const special = getSpecialAssignmentById(classId);
  const quotas = getTeacherAssignedLevelQuotas(teacher);
  const quotaTotal = Object.values(quotas).reduce((acc, value) => acc + Number(value || 0), 0);
  if (!quotaTotal) return true;
  if (special) {
    const specialKey = special.type === "AS" ? "AS" : "DANSE";
    const allowed = Number(quotas[specialKey] || 0);
    if (allowed <= 0) return false;
    const distinctCurrentSpecials = new Set(
      state.sessions
        .filter((s) => s.teacherId === teacher.id && isSpecialAssignmentId(s.classId))
        .filter((s) => {
          const sp = getSpecialAssignmentById(s.classId);
          return (sp?.type || "") === special.type;
        })
        .map((s) => s.classId)
    );
    if (distinctCurrentSpecials.has(classId)) return true;
    return distinctCurrentSpecials.size < allowed;
  }
  const cls = state.classes.find((c) => c.id === classId);
  if (!cls) return false;
  const repartitionTeacherId = getRepartitionAssignedTeacherIdForClass(classId);
  if (repartitionTeacherId) return repartitionTeacherId === teacher.id;
  const allowed = Number(quotas[cls.level] || 0);
  if (allowed <= 0) return false;
  const distinctCurrentClasses = new Set(
    state.sessions
      .filter((s) => s.teacherId === teacher.id && !isSpecialAssignmentId(s.classId))
      .filter((s) => state.classes.find((c) => c.id === s.classId)?.level === cls.level)
      .map((s) => s.classId)
  );
  if (distinctCurrentClasses.has(classId)) return true;
  return distinctCurrentClasses.size < allowed;
}

function isSessionClassCurrent(session) {
  if (!session) return false;
  if (isSpecialAssignmentId(session.classId)) return true;
  return state.classes.some((c) => c.id === session.classId);
}

function getCurrentClassSessions() {
  return state.sessions.filter((s) => isSessionClassCurrent(s));
}

function isASLike(entry) {
  if (!entry) return false;
  return String(entry.type || "").toUpperCase() === "AS" || String(entry.classId || "").startsWith("__AS");
}

function getClassLabelById(classId, withLevel = false) {
  const special = getSpecialAssignmentById(classId);
  if (special) return special.label;
  const cls = state.classes.find((c) => c.id === classId);
  if (!cls) return "Classe inconnue";
  return withLevel ? `${cls.level} ${cls.name}` : cls.name;
}

function getTeacherAssignedTargetLabels(teacher) {
  const quotas = getTeacherAssignedLevelQuotas(teacher);
  const rows = getTeacherQuotaCatalog()
    .filter((entry) => Number(quotas[entry.key] || 0) > 0)
    .map((entry) => {
      const count = Number(quotas[entry.key] || 0);
      return `${entry.label} x${count}`;
    });
  if (!rows.length) return "Tous niveaux + AS + Danse";
  const totalHours = getTeacherQuotaCatalog().reduce((acc, entry) => {
    const count = Number(quotas[entry.key] || 0);
    return acc + count * Number(entry.weeklyHours || 0);
  }, 0);
  return `${rows.join(", ")} (${formatHours(totalHours)}h)`;
}


function getPlannerAssignableOptions() {
  const classes = getUnassignedClasses().map((c) => {
    const remaining = Math.max(0, Number(c.weeklyHours || 0) - getAssignedHoursForClass(c.id));
    return {
      id: c.id,
      label: `${c.level} ${c.name} (${formatHours(remaining)}h restantes)`,
    };
  });
  const specials = SPECIAL_ASSIGNMENTS.map((s) => ({
    id: s.id,
    label: `${s.label} (illimité)`,
  }));
  return [...specials, ...classes];
}

function getAvailableClassesForGlobalPicker(teacherId, day, slot, weekType, includeConflicting = false, includeAllAssigned = false) {
  if (!teacherId) return [];
  const teacher = state.teachers.find((t) => t.id === teacherId);
  if (!teacher) return [];
  const regular = state.classes.filter((c) => {
    if (!isTeacherAssignedToClass(teacher, c.id)) return false;
    if (!includeAllAssigned && !canTeacherTakeClassByLevelQuota(teacher, c.id)) return false;
    if (!includeAllAssigned) {
      const remaining = Number(c.weeklyHours || 0) - getAssignedHoursForClass(c.id);
      if (remaining <= 0) return false;
    }
    return true;
  }).map((c) => {
    const slotCompatible = canAssignClassInTeacherSlot(teacherId, c.id, day, slot, weekType);
    return { ...c, _slotCompatible: slotCompatible };
  }).filter((c) => includeConflicting || c._slotCompatible);
  const specials = SPECIAL_ASSIGNMENTS
    .filter((s) => isTeacherAssignedToClass(teacher, s.id))
    .map((s) => ({ ...s, _slotCompatible: canAssignClassInTeacherSlot(teacherId, s.id, day, slot, weekType) }))
    .filter((s) => includeConflicting || s._slotCompatible);
  return [...specials, ...regular];
}

function canAssignClassInTeacherSlot(teacherId, classId, day, slot, weekType) {
  const suggested = getSuggestedCadenceForTeacherSlot(teacherId, day, slot);
  const candidates = [suggested, "AUTO", "WEEKLY", "WEEK_A", "WEEK_B"];
  const seen = new Set();
  for (const pref of candidates) {
    const normalized = normalizeCadencePreference(pref);
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    if (buildBestSessionProposal(teacherId, classId, day, slot, weekType, normalized, true).ok) return true;
  }
  return false;
}

function buildBestSessionProposal(teacherId, classId, day, slot, weekType, cadencePreference = "AUTO", silent = false) {
  const special = getSpecialAssignmentById(classId);
  if (special) {
    const duration = special.type === "AS" ? 1 : 2;
    const normalizedPref = normalizeCadencePreference(cadencePreference);
    const band = getBandForSlot(slot);
    const candidateStarts =
      duration === 1 && band ? getBandSlotStarts(band) : [slot];
    const proposals = [];
    for (const start of candidateStarts) {
      if (normalizedPref === "WEEK_A" || normalizedPref === "WEEK_B") {
        proposals.push({
          teacherId,
          classId,
          type: special.type,
          day,
          start,
          duration,
          cadence: "BIWEEKLY",
          weekType: normalizedPref === "WEEK_A" ? "A" : "B",
        });
      } else {
        proposals.push({
          teacherId,
          classId,
          type: special.type,
          day,
          start,
          duration,
          cadence: "WEEKLY",
          weekType: normalizeWeekType(weekType),
        });
      }
    }
    for (const p of proposals) {
      const check = validateSession(p);
      if (check.ok) return { ok: true, session: p };
    }
    const fallback = validateSession(proposals[0]);
    return { ok: false, error: fallback.error || "Affectation impossible sur ce créneau." };
  }

  const cls = state.classes.find((c) => c.id === classId);
  if (!cls) return { ok: false, error: "Classe indisponible." };
  const rule = getLevelRule(cls.level);
  const remaining = Math.max(0, Number(cls.weeklyHours || 0) - getAssignedHoursForClass(cls.id));
  const firstAssignment = getAssignedHoursForClass(cls.id) === 0;
  const normalizedPref = normalizeCadencePreference(cadencePreference);

  if (!silent && rule?.group === "ALT_43" && firstAssignment && normalizedPref === "AUTO") {
    return { ok: false, error: "Pour une 4e/3e non encore affectée, choisissez: toutes les semaines, Semaine A ou Semaine B." };
  }
  if (!silent && rule?.group !== "ALT_43" && (normalizedPref === "WEEK_A" || normalizedPref === "WEEK_B")) {
    return { ok: false, error: "Semaine A/B est disponible uniquement pour les classes de 4e et 3e." };
  }
  if (rule?.group === "CINQUIEME") {
    const proposal = {
      teacherId,
      classId,
      type: "EPS",
      day,
      start: slot,
      duration: 3,
      cadence: "WEEKLY",
      weekType: normalizeWeekType(weekType),
    };
    const check = validateSession(proposal);
    if (check.ok) return { ok: true, session: proposal };
    return { ok: false, error: check.error || "Affectation impossible pour cette classe de 5e." };
  }

  const proposals = [];
  if (normalizedPref === "WEEKLY") {
    proposals.push({
      teacherId,
      classId,
      type: "EPS",
      day,
      start: slot,
      duration: 2,
      cadence: "WEEKLY",
      weekType: normalizeWeekType(weekType),
    });
  } else if (normalizedPref === "WEEK_A" || normalizedPref === "WEEK_B") {
    proposals.push({
      teacherId,
      classId,
      type: "EPS",
      day,
      start: slot,
      duration: 2,
      cadence: "BIWEEKLY",
      weekType: normalizedPref === "WEEK_A" ? "A" : "B",
    });
  } else if (rule?.group === "ALT_43" && remaining <= 1) {
    proposals.push({
      teacherId,
      classId,
      type: "EPS",
      day,
      start: slot,
      duration: 2,
      cadence: "BIWEEKLY",
      weekType: normalizeWeekType(weekType),
    });
    proposals.push({
      teacherId,
      classId,
      type: "EPS",
      day,
      start: slot,
      duration: 2,
      cadence: "BIWEEKLY",
      weekType: normalizeWeekType(weekType) === "A" ? "B" : "A",
    });
  } else {
    proposals.push({
      teacherId,
      classId,
      type: "EPS",
      day,
      start: slot,
      duration: 2,
      cadence: "WEEKLY",
      weekType: normalizeWeekType(weekType),
    });
  }

  for (const p of proposals) {
    const check = validateSession(p);
    if (check.ok) return { ok: true, session: p };
  }
  const fallback = validateSession(proposals[0]);
  return { ok: false, error: fallback.error || "Affectation impossible sur ce créneau." };
}

function normalizeCadencePreference(value) {
  if (value === "WEEKLY") return "WEEKLY";
  if (value === "WEEK_A") return "WEEK_A";
  if (value === "WEEK_B") return "WEEK_B";
  return "AUTO";
}

function daySlotKey(day, slot) {
  return `${day}|${slot}`;
}

function hasSwimSlot(day, slot) {
  return state.swimSlotKeys.has(daySlotKey(day, slot));
}

function swimSlotDocId(day, slot, schoolYearId = getActiveSchoolYearId()) {
  return `${schoolYearId}__${day}__${slot}`;
}

async function toggleSwimSlot(day, slot) {
  if (!day || !slot) return;
  const band = getBandForSlot(slot);
  const targetSlots = band ? band.slots : [slot];
  const isMarked = targetSlots.every((s) => hasSwimSlot(day, s));
  if (isMarked) {
    const toDelete = state.swimSlots.filter((s) => s.day === day && targetSlots.includes(s.slot)).map((s) => s.id);
    if (!toDelete.length) {
      await Promise.all(targetSlots.map((s) => deleteDoc(doc(db, "swimSlots", swimSlotDocId(day, s, getActiveSchoolYearId())))));
      return;
    }
    await Promise.all(toDelete.map((id) => deleteDoc(doc(db, "swimSlots", id))));
    return;
  }
  await Promise.all(
    targetSlots.map((s) =>
      setDoc(doc(db, "swimSlots", swimSlotDocId(day, s, getActiveSchoolYearId())), {
        schoolYearId: getActiveSchoolYearId(),
        day,
        slot: s,
        createdAt: serverTimestamp(),
      })
    )
  );
}

function renderSwimPlanner() {
  const markedCount = state.swimSlotKeys.size;
  ui.swimHint.textContent = `Repère visuel global: cliquez sur un créneau pour afficher/retirer l'icône nageur. Créneaux marqués: ${markedCount}.`;

  const head = `<tr><th>Heure</th>${DAYS.map((d) => `<th>${d}</th>`).join("")}</tr>`;
  const rows = SLOT_BANDS.map((band) => {
    const cells = DAYS.map((day) => {
      const marked = getBandSlotStarts(band).some((s) => hasSwimSlot(day, s));
      return `<td class="slot${marked ? " slot-swim" : ""}">
        <button class="swim-toggle${marked ? " active" : ""}" data-day="${escapeHtml(day)}" data-slot="${escapeHtml(band.start)}" type="button">
          ${marked ? "Natation" : "-"}
        </button>
      </td>`;
    }).join("");
    return `<tr><th>${band.label}</th>${cells}</tr>`;
  }).join("");

  ui.swimPlannerContainer.innerHTML = `<table>${head}${rows}</table>`;
  ui.swimPlannerContainer.querySelectorAll(".swim-toggle").forEach((btn) => {
    btn.addEventListener("click", async () => {
      await toggleSwimSlot(btn.dataset.day, btn.dataset.slot);
    });
  });
}

function desiderataSlotKey(teacherId, day, slot) {
  return `${teacherId}|${day}|${slot}`;
}

function rawSlotKey(day, slot) {
  return `${day}|${slot}`;
}

function normalizeDesiderataStatus(status) {
  if (status === "UNAVAILABLE") return "UNAVAILABLE";
  if (status === "DAY_OFF") return "DAY_OFF";
  return "PREFERRED";
}

function splitRawSlotKey(key) {
  const [day, slot] = String(key || "").split("|");
  return { day, slot };
}

function nextDesiderataStatus(current) {
  if (current === "PREFERRED") return "UNAVAILABLE";
  if (current === "UNAVAILABLE") return null;
  if (current === "DAY_OFF") return null;
  return "PREFERRED";
}

function getPersistedDesiderataForTeacher(teacherId) {
  const map = new Map();
  if (!teacherId) return map;
  for (const s of state.desiderataSlots) {
    if (s.teacherId !== teacherId) continue;
    map.set(rawSlotKey(s.day, s.slot), normalizeDesiderataStatus(s.status));
  }
  return map;
}

function getPersistedDesiderataCommentForTeacher(teacherId) {
  if (!teacherId) return "";
  return String(state.desiderataCommentsByTeacher.get(teacherId) || "");
}

function getActiveDesiderataTeacherId() {
  if (state.currentUserRole === "CUSTOM" && state.currentUserTeacherId) return state.currentUserTeacherId;
  if (ui.desiderataTeacherSelect) {
    const selected = String(ui.desiderataTeacherSelect.value || "").trim();
    if (selected) return selected;
  }
  return String(state.selectedDesiderataTeacherId || "").trim();
}

function syncDesiderataDraftWithPersisted() {
  const teacherId = getActiveDesiderataTeacherId();
  if (!teacherId) return;
  state.selectedDesiderataTeacherId = teacherId;
  if (state.desiderataDirty && state.desiderataDraftTeacherId === teacherId) return;
  state.desiderataDraftTeacherId = teacherId;
  state.desiderataDraft = getPersistedDesiderataForTeacher(teacherId);
}

function syncDesiderataCommentDraftWithPersisted() {
  const teacherId = getActiveDesiderataTeacherId();
  if (!teacherId) return;
  state.selectedDesiderataTeacherId = teacherId;
  if (state.desiderataDirty && state.desiderataCommentDraftTeacherId === teacherId) return;
  state.desiderataCommentDraftTeacherId = teacherId;
  state.desiderataCommentDraft = getPersistedDesiderataCommentForTeacher(teacherId);
}

function hasDesiderataSlot(teacherId, day, slot) {
  return state.desiderataSlotStatus.get(desiderataSlotKey(teacherId, day, slot)) === "PREFERRED";
}

function hasDesiderataUnavailableSlot(teacherId, day, slot) {
  return state.desiderataSlotStatus.get(desiderataSlotKey(teacherId, day, slot)) === "UNAVAILABLE";
}

function hasDesiderataDayOffSlot(teacherId, day, slot) {
  return state.desiderataSlotStatus.get(desiderataSlotKey(teacherId, day, slot)) === "DAY_OFF";
}

function desiderataDocId(teacherId, day, slot) {
  return `${getDesiderataYearId()}__${teacherId}__${day}__${slot}`;
}

function setDesiderataDraftStatus(day, slot, status) {
  const band = getBandForSlot(slot);
  const targetSlots = band ? band.slots : [slot];
  for (const s of targetSlots) {
    const key = rawSlotKey(day, s);
    if (!status) state.desiderataDraft.delete(key);
    else state.desiderataDraft.set(key, status);
  }
  state.desiderataDirty = true;
}

function setDesiderataDayOff(day, enabled) {
  if (!DAYS.includes(day)) return;
  for (const slot of SLOTS) {
    const key = rawSlotKey(day, slot);
    if (enabled) {
      state.desiderataDraft.set(key, "DAY_OFF");
    } else if (state.desiderataDraft.get(key) === "DAY_OFF") {
      state.desiderataDraft.delete(key);
    }
  }
  state.desiderataDirty = true;
}

function countDesiderataBandsWithStatus(draftMap, status) {
  let count = 0;
  for (const day of DAYS) {
    for (const band of SLOT_BANDS) {
      const slots = getBandSlotStarts(band);
      const statuses = slots.map((s) => draftMap.get(rawSlotKey(day, s)) || null);
      const unified = statuses.length <= 1 ? statuses[0] : statuses[0] === statuses[1] ? statuses[0] : statuses[0] || statuses[1];
      if (unified === status) count += 1;
    }
  }
  return count;
}

function hasAnyDesiderataDayOff(draftMap) {
  for (const value of draftMap.values()) {
    if (value === "DAY_OFF") return true;
  }
  return false;
}

function getDesiderataDayOffDayCount(draftMap) {
  let count = 0;
  for (const day of DAYS) {
    const hasDayOffOnDay = SLOT_BANDS.some((band) => {
      const slots = getBandSlotStarts(band);
      const statuses = slots.map((s) => draftMap.get(rawSlotKey(day, s)) || null);
      const unified = statuses.length <= 1 ? statuses[0] : statuses[0] === statuses[1] ? statuses[0] : statuses[0] || statuses[1];
      return unified === "DAY_OFF";
    });
    if (hasDayOffOnDay) count += 1;
  }
  return count;
}

function validateDesiderataDraftRules(draftMap) {
  const unavailableCount = countDesiderataBandsWithStatus(draftMap, "UNAVAILABLE");
  const dayOffDayCount = getDesiderataDayOffDayCount(draftMap);
  if (dayOffDayCount > 1) {
    return { ok: false, message: "Vous ne pouvez soumettre qu'une seule journée OFF." };
  }
  if (dayOffDayCount === 1 && unavailableCount > 2) {
    return { ok: false, message: "Avec une journée OFF, vous ne pouvez pas dépasser 2 créneaux indisponibles." };
  }
  if (dayOffDayCount === 0 && unavailableCount > 6) {
    return { ok: false, message: "Sans journée OFF, vous ne pouvez pas dépasser 6 créneaux indisponibles." };
  }
  return { ok: true, message: "" };
}

async function persistDesiderataDraft(mode = "BROUILLON") {
  if (!state.desiderataConfig?.enabled) {
    if (ui.desiderataHint) ui.desiderataHint.textContent = "Désidératas désactivés par l'administration.";
    return;
  }
  const teacherId = getActiveDesiderataTeacherId();
  state.selectedDesiderataTeacherId = teacherId;
  if (!teacherId) {
    if (ui.desiderataHint) ui.desiderataHint.textContent = "Aucun enseignant sélectionné pour enregistrer les désidérata.";
    return;
  }
  const persisted = getPersistedDesiderataForTeacher(teacherId);
  const persistedComment = getPersistedDesiderataCommentForTeacher(teacherId);
  const draftComment = String(state.desiderataCommentDraft || "").trim();
  const draft = state.desiderataDraft;
  if (mode === "SOUMIS") {
    const validation = validateDesiderataDraftRules(draft);
    if (!validation.ok) {
      if (ui.desiderataHint) ui.desiderataHint.textContent = validation.message;
      showToast(validation.message, "error");
      return;
    }
  }
  const all = new Set([...persisted.keys(), ...draft.keys()]);
  const batch = db.batch();
  let writes = 0;

  for (const key of all) {
    const oldStatus = persisted.get(key) || null;
    const newStatus = draft.get(key) || null;
    if (oldStatus === newStatus) continue;
    const { day, slot } = splitRawSlotKey(key);
    if (!day || !slot) continue;
    const ref = doc(db, "desiderata", desiderataDocId(teacherId, day, slot));
    if (!newStatus) {
      batch.delete(ref);
    } else {
      batch.set(ref, {
        schoolYearId: getDesiderataYearId(),
        teacherId,
        day,
        slot,
        status: newStatus,
        submissionMode: mode,
        updatedAt: serverTimestamp(),
      });
    }
    writes += 1;
  }

  if (persistedComment !== draftComment) {
    const ref = doc(db, "desiderataComments", `${getDesiderataYearId()}__${teacherId}`);
    if (!draftComment) {
      batch.delete(ref);
    } else {
      batch.set(ref, {
        schoolYearId: getDesiderataYearId(),
        teacherId,
        comment: draftComment,
        submissionMode: mode,
        updatedAt: serverTimestamp(),
      });
    }
    writes += 1;
  }

  if (!writes) {
    ui.desiderataHint.textContent = "Aucun changement à enregistrer.";
    return;
  }

  try {
    await batch.commit();
    state.desiderataDirty = false;
    ui.desiderataHint.textContent =
      mode === "SOUMIS" ? "Désidérata soumis avec succès." : "Brouillon des désidérata sauvegardé.";
  } catch (error) {
    ui.desiderataHint.textContent = `Erreur Firestore: ${error?.message || "écriture impossible."}`;
  }
}

function renderDesiderata() {
  const renderPlannedLevels = (teacher) => {
    if (!ui.desiderataPlannedLevelsContainer) return;
    if (!teacher) {
      ui.desiderataPlannedLevelsContainer.innerHTML = `<p class="summary-box">Aucun enseignant sélectionné.</p>`;
      return;
    }
    const quotas = getTeacherAssignedLevelQuotas(teacher);
    const entries = getTeacherQuotaCatalog();
    const rows = entries
      .map((entry) => {
        const classes = Number(quotas[entry.key] || 0);
        const hours = classes * Number(entry.weeklyHours || 0);
        return `<tr><td>${escapeHtml(entry.label)}</td><td>${classes}</td><td>${formatHours(hours)}h</td></tr>`;
      })
      .join("");
    const totals = entries.reduce(
      (acc, entry) => {
        const classes = Number(quotas[entry.key] || 0);
        const hours = classes * Number(entry.weeklyHours || 0);
        acc.classes += classes;
        acc.hours += hours;
        return acc;
      },
      { classes: 0, hours: 0 }
    );
    const hint =
      totals.classes === 0
        ? `<p class="summary-box">Aucune répartition définie: toutes classes autorisées.</p>`
        : "";
    ui.desiderataPlannedLevelsContainer.innerHTML = `
      <table class="desiderata-planned-table">
        <thead><tr><th>Niveau</th><th>Classes</th><th>Heures</th></tr></thead>
        <tbody>${rows}</tbody>
        <tfoot><tr><th>Total</th><th>${totals.classes}</th><th>${formatHours(totals.hours)}h</th></tr></tfoot>
      </table>
      ${hint}
    `;
  };

  const activeTeacherId = getActiveDesiderataTeacherId();
  const desiderataYearId = getDesiderataYearId();
  if (ui.desiderataYearBadge) {
    const enabled = Boolean(state.desiderataConfig?.enabled);
    ui.desiderataYearBadge.innerHTML = `Année des désidératas: <strong>${escapeHtml(desiderataYearId)}</strong> · <span class="${enabled ? "hours-ok" : "hours-over"}">${enabled ? "Activés" : "Désactivés"}</span>`;
  }
  if (activeTeacherId) state.selectedDesiderataTeacherId = activeTeacherId;
  const teacher = state.teachers.find((t) => t.id === state.selectedDesiderataTeacherId);
  if (!teacher) {
    ui.desiderataHint.textContent = "Aucun professeur disponible.";
    if (ui.desiderataPreferredHours) ui.desiderataPreferredHours.textContent = "0h";
    if (ui.desiderataUnavailableBlocks) ui.desiderataUnavailableBlocks.textContent = "0";
    if (ui.desiderataTargetHours) ui.desiderataTargetHours.textContent = "0h";
    ui.desiderataGridContainer.innerHTML = "";
    if (ui.desiderataComment) ui.desiderataComment.value = "";
    renderPlannedLevels(null);
    return;
  }
  renderPlannedLevels(teacher);

  if (state.desiderataDraftTeacherId !== teacher.id || !state.desiderataDirty) {
    syncDesiderataDraftWithPersisted();
  }
  if (state.desiderataCommentDraftTeacherId !== teacher.id || !state.desiderataDirty) {
    syncDesiderataCommentDraftWithPersisted();
  }
  if (ui.desiderataComment) {
    const isFocused = document.activeElement === ui.desiderataComment;
    if (!isFocused || state.desiderataCommentDraftTeacherId !== teacher.id) {
      ui.desiderataComment.value = state.desiderataCommentDraft || "";
    }
  }

  const preferredCount = countDesiderataBandsWithStatus(state.desiderataDraft, "PREFERRED");
  const unavailableCount = countDesiderataBandsWithStatus(state.desiderataDraft, "UNAVAILABLE");
  if (ui.desiderataPreferredHours) ui.desiderataPreferredHours.textContent = `${preferredCount}h`;
  if (ui.desiderataUnavailableBlocks) ui.desiderataUnavailableBlocks.textContent = String(unavailableCount);
  if (ui.desiderataTargetHours) ui.desiderataTargetHours.textContent = `${formatHours(teacher.maxHours || 0)}h`;
  if (!state.desiderataDirty) {
    ui.desiderataHint.textContent = "";
  }
  if (ui.desiderataDayOffSelect && !ui.desiderataDayOffSelect.value) ui.desiderataDayOffSelect.value = DAYS[0];

  const renderDesiderataCellButton = (day, band) => {
    const statuses = getBandSlotStarts(band).map((s) => state.desiderataDraft.get(rawSlotKey(day, s)) || null);
    const unified = statuses.length <= 1 ? statuses[0] : statuses[0] === statuses[1] ? statuses[0] : statuses[0] || statuses[1];
    const cls =
      unified === "PREFERRED" ? " active" : unified === "UNAVAILABLE" ? " unavailable" : unified === "DAY_OFF" ? " day-off" : "";
    const text = unified === "PREFERRED" ? "★" : unified === "UNAVAILABLE" ? "⛔" : unified === "DAY_OFF" ? "OFF" : "•";
    return `<button class="desiderata-toggle${cls}" data-day="${escapeHtml(day)}" data-slot="${escapeHtml(band.start)}" data-status="${escapeHtml(unified || "")}" type="button">
      ${text}
    </button>`;
  };

  if (isCompactMobileLayout()) {
    ui.desiderataGridContainer.innerHTML = `
      <div class="mobile-day-planner desiderata-mobile-day-planner">
        ${DAYS.map((day) => `
          <article class="mobile-day-card">
            <header class="mobile-day-card-head">
              <h4>${escapeHtml(day)}</h4>
            </header>
            <div class="mobile-day-card-body">
              ${SLOT_BANDS.map((band) => `
                <div class="mobile-day-row mobile-day-row-desiderata">
                  <div class="mobile-day-time">${escapeHtml(band.label)}</div>
                  <div class="mobile-day-content mobile-day-content-center">
                    ${renderDesiderataCellButton(day, band)}
                  </div>
                </div>
              `).join("")}
            </div>
          </article>
        `).join("")}
      </div>
    `;
  } else {
    const head = `<tr><th>Heure</th>${DAYS.map((d) => `<th>${d}</th>`).join("")}</tr>`;
    const rows = SLOT_BANDS.map((band, bandIdx) => {
      const nextBand = SLOT_BANDS[bandIdx + 1];
      const isFridayOnly = Boolean(band.fridayOnly);
      const cells = DAYS.map((day) => {
        const isFriday = day === "Vendredi";
        // Vendredi : 14:00 et 16:05 absorbés par rowspan
        if (isFriday && FRIDAY_DISABLED_BAND_STARTS.has(band.start)) return null;
        // Lun-Jeu : bande fridayOnly absorbée par le rowspan 14:00
        if (!isFriday && isFridayOnly) return null;
        const displayBand = isFriday
          ? (FRIDAY_AFTERNOON_BANDS.find(b => b.start === band.start) || band)
          : band;
        // Vendredi : rowspan=2 quand la bande suivante est désactivée (13:00→14:00, 15:00→16:05)
        if (isFriday && nextBand && FRIDAY_DISABLED_BAND_STARTS.has(nextBand.start)) {
          return `<td class="slot slot-friday-merged" rowspan="2">${renderDesiderataCellButton(day, displayBand)}</td>`;
        }
        // Lun-Jeu bande 14:00 : rowspan=2 pour absorber la ligne fridayOnly (15:00)
        if (!isFriday && nextBand?.fridayOnly) {
          return `<td class="slot" rowspan="2">${renderDesiderataCellButton(day, displayBand)}</td>`;
        }
        return `<td class="slot">${renderDesiderataCellButton(day, displayBand)}</td>`;
      }).filter(c => c !== null).join("");
      const fridayLabel = getBandLabelForDay(band, "Vendredi");
      const thLabel = isFridayOnly ? ""
        : fridayLabel !== band.label && fridayLabel !== "—"
          ? `${band.label}<small class="band-friday-hint">${fridayLabel}</small>`
          : band.label;
      return `<tr><th>${thLabel}</th>${cells}</tr>`;
    }).join("");
    ui.desiderataGridContainer.innerHTML = `<table class="timetable-shared desiderata-timetable">${head}${rows}</table>`;
  }

  const applyStatusToButton = (btn, forcedStatus = null, explicit = false) => {
    const day = btn.dataset.day;
    const slot = btn.dataset.slot;
    const current = btn.dataset.status || null;
    let next = explicit ? forcedStatus : forcedStatus === null ? nextDesiderataStatus(current) : forcedStatus;

    // Règle indisponibilités:
    // - Sans journée OFF: max 6 créneaux indisponibles
    // - Avec au moins une journée OFF: max 2 créneaux indisponibles
    if (next === "UNAVAILABLE" && current !== "UNAVAILABLE") {
      const currentUnavailableCount = countDesiderataBandsWithStatus(state.desiderataDraft, "UNAVAILABLE");
      const hasDayOff = hasAnyDesiderataDayOff(state.desiderataDraft);
      const maxUnavailable = hasDayOff ? 2 : 6;

      if (currentUnavailableCount >= maxUnavailable) {
        showToast(
          hasDayOff
            ? "Avec une journée OFF, vous ne pouvez pas dépasser 2 créneaux indisponibles."
            : "Vous ne pouvez pas marquer plus de 6 créneaux indisponibles.",
          "warning"
        );
        state.desiderataPointerDown = false; // Stop painting
        return;
      }
    }

    setDesiderataDraftStatus(day, slot, next);
    btn.dataset.status = next || "";
    btn.classList.toggle("active", next === "PREFERRED");
    btn.classList.toggle("unavailable", next === "UNAVAILABLE");
    btn.classList.toggle("day-off", next === "DAY_OFF");
    btn.textContent = next === "PREFERRED" ? "★" : next === "UNAVAILABLE" ? "⛔" : next === "DAY_OFF" ? "OFF" : "•";
  };

  if (!state.desiderataMouseupBound) {
    window.addEventListener("mouseup", () => {
      state.desiderataPointerDown = false;
      state.desiderataPaintStatus = null;
    });
    state.desiderataMouseupBound = true;
  }

  ui.desiderataGridContainer.querySelectorAll(".desiderata-toggle").forEach((btn) => {
    btn.addEventListener("mousedown", (e) => {
      if (e.button !== 0) return;
      state.desiderataPointerDown = true;
      const current = btn.dataset.status || null;
      state.desiderataPaintStatus = nextDesiderataStatus(current);
      applyStatusToButton(btn, state.desiderataPaintStatus, true);
      btn.dataset.pointerToggled = "1";
      renderDesiderata();
    });
    btn.addEventListener("mouseenter", () => {
      if (!state.desiderataPointerDown) return;
      applyStatusToButton(btn, state.desiderataPaintStatus, true);
      btn.dataset.pointerToggled = "1";
      renderDesiderata();
    });
    btn.addEventListener("touchstart", (e) => {
      e.preventDefault();
      const current = btn.dataset.status || null;
      const next = nextDesiderataStatus(current);
      applyStatusToButton(btn, next, true);
      renderDesiderata();
    }, { passive: false });
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (btn.dataset.pointerToggled === "1") {
        btn.dataset.pointerToggled = "";
        return;
      }
      const current = btn.dataset.status || null;
      const next = nextDesiderataStatus(current);
      applyStatusToButton(btn, next, true);
      renderDesiderata();
    });
  });
}

function getAssignedHoursForClass(classId) {
  if (isSpecialAssignmentId(classId)) return 0;
  return state.sessions
    .filter((s) => s.classId === classId)
    .reduce((acc, s) => acc + weeklyEquivalentHours(s), 0);
}

function cssEscape(value) {
  if (window.CSS && typeof window.CSS.escape === "function") {
    return window.CSS.escape(value);
  }
  return String(value).replace(/["\\]/g, "\\$&");
}

function normalizeHexColor(value) {
  const color = String(value || "").trim();
  if (/^#[0-9a-fA-F]{6}$/.test(color)) return color.toLowerCase();
  return "#0b7285";
}

function hashString(input) {
  let h = 0;
  for (let i = 0; i < input.length; i += 1) h = (h << 5) - h + input.charCodeAt(i);
  return Math.abs(h);
}

function fallbackColorForTeacher(teacher) {
  const palette = ["#0b7285", "#1971c2", "#2b8a3e", "#c92a2a", "#a61e4d", "#5f3dc4", "#e67700", "#087f5b"];
  const seed = `${teacher?.id || ""}|${teacher?.name || ""}`;
  return palette[hashString(seed) % palette.length];
}

function getTeacherColor(teacher) {
  return normalizeHexColor(teacher?.color || fallbackColorForTeacher(teacher));
}

function getTeacherColorById(teacherId) {
  const teacher = state.teachers.find((t) => t.id === teacherId);
  return getTeacherColor(teacher);
}

function getTeacherBlockStyle(teacherId) {
  const color = getTeacherColorById(teacherId);
  return `background:${color}44;border-left:4px solid ${color};`;
}

function teacherShortCode(name) {
  const parts = String(name || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (!parts.length) return "PROF";
  if (parts.length === 1) return parts[0].slice(0, 3).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function normalizeTeacherAbbreviation(value, fallbackName = "") {
  const raw = String(value || "")
    .trim()
    .replace(/\s+/g, "")
    .toUpperCase()
    .slice(0, 8);
  if (raw) return raw;
  return teacherShortCode(fallbackName);
}

function getTeacherDisplayLabel(teacher) {
  return normalizeTeacherAbbreviation(teacher?.abbreviation, teacher?.name || "PROF");
}

function applyClassRule() {
  const rule = getLevelRule(ui.classLevel.value);
  if (!rule) {
    ui.classWeeklyHours.value = "";
    ui.classRuleHint.textContent = "Sélectionnez un niveau pour appliquer la règle horaire.";
    ui.classCreateInfo.textContent = "Choisissez un niveau et un nombre de classes à générer.";
    return;
  }
  ui.classWeeklyHours.value = String(rule.weeklyHours);
  ui.classRuleHint.textContent = rule.hint;
  const prefix = getLevelPrefix(ui.classLevel.value);
  const count = Math.max(1, Math.min(26, Number(ui.classCount.value || 1)));
  const preview = Array.from({ length: count }, (_, i) => `${prefix}${String.fromCharCode(65 + i)}`).join(", ");
  ui.classCreateInfo.textContent = `Aperçu génération: ${preview}`;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function renderRepartitionPanel() {
  if (!ui.repartitionApportsContainer || !ui.repartitionBesoinsContainer) return;

  const catalog = getTeacherQuotaCatalog();
  const teachers = state.teachers;
  const hoursByTeacher = computeTeacherHours();

  // --- 1. Tableau des Apports (Bilan des Heures) ---
  let totalMax = 0;
  let totalUsed = 0;

  const apportRows = teachers.map(t => {
    const used = hoursByTeacher.get(t.id) || 0;
    const max = Number(t.maxHours || 0);
    const over = used > max;
    totalMax += max;
    totalUsed += used;
    return `
      <tr>
        <td>
          <span class="teacher-color-dot" style="background:${escapeHtml(getTeacherColor(t))}"></span>
          <strong>${escapeHtml(t.name)}</strong>
        </td>
        <td>
          <input type="number"
                 class="inline-number-input"
                 value="${max}"
                 data-repartition-max-hours="${t.id}" />h
        </td>
        <td>
          <span class="${over ? "hours-over" : "hours-ok"}">${formatHours(used)}h</span>
        </td>
        <td>
          <span class="${over ? "hours-over" : "hours-ok"}">${formatHours(max - used)}h</span>
        </td>
      </tr>
    `;
  }).join("");

  ui.repartitionApportsContainer.innerHTML = `
    <table>
      <thead>
        <tr>
          <th>Professeur</th>
          <th>Potentiel (max)</th>
          <th>Déjà affecté</th>
          <th>Solde</th>
        </tr>
      </thead>
      <tbody>${apportRows || "<tr><td colspan='4'>Aucun professeur.</td></tr>"}</tbody>
      <tfoot>
        <tr class="total-row">
          <td><strong>TOTAL</strong></td>
          <td><strong>${formatHours(totalMax)}h</strong></td>
          <td><strong>${formatHours(totalUsed)}h</strong></td>
          <td class="${totalUsed > totalMax ? "hours-over" : "hours-ok"}"><strong>${formatHours(totalMax - totalUsed)}h</strong></td>
        </tr>
      </tfoot>
    </table>
  `;

  // Bind Apports inputs
  ui.repartitionApportsContainer.querySelectorAll("[data-repartition-max-hours]").forEach(input => {
    input.addEventListener("change", async () => {
      const teacherId = input.dataset.repartitionMaxHours;
      const val = Number(input.value);
      if (isNaN(val) || val < 0) return;
      await updateDoc(doc(db, "teachers", teacherId), { maxHours: val });
    });
  });

  // --- 2. Tableau des Besoins (Attributions par niveau) ---
  const headCols = catalog.map(c => `<th>${escapeHtml(c.label)}</th>`).join("");

  // Track column totals
  const colTotals = new Map();
  catalog.forEach(c => colTotals.set(c.key, 0));
  let grandTotalClasses = 0;
  let grandTotalHours = 0;

  const besoinRows = teachers.map(t => {
    const quotas = getTeacherAssignedLevelQuotas(t);
    let teacherTotalClasses = 0;
    let teacherTotalHours = 0;

    const cells = catalog.map(c => {
      const count = Number(quotas[c.key] || 0);
      const hours = count * Number(c.weeklyHours || 0);
      colTotals.set(c.key, colTotals.get(c.key) + count);

      // Projet is a numeric input, others are +/-
      if (c.key === "PROJET") {
        teacherTotalHours += count; // For Projet, we treat the value as direct hours
        return `
          <td class="repartition-cell">
            <input type="number" 
                   step="0.5" 
                   min="0" 
                   class="inline-number-input repartition-projet-input"
                   data-teacher-id="${t.id}"
                   data-quota-key="${c.key}"
                   value="${count}" />
          </td>
        `;
      }

      teacherTotalClasses += count;
      teacherTotalHours += hours;

      return `
        <td class="repartition-cell">
          <div class="repartition-controls">
            <button class="repartition-btn minus"
                    data-teacher-id="${t.id}"
                    data-quota-key="${c.key}"
                    data-delta="-1"
                    type="button">-</button>
            <span class="repartition-value ${count === 0 ? "empty" : ""}">${count}</span>
            <button class="repartition-btn plus"
                    data-teacher-id="${t.id}"
                    data-quota-key="${c.key}"
                    data-delta="1"
                    type="button">+</button>
          </div>
        </td>
      `;
    }).join("");

    grandTotalClasses += teacherTotalClasses;
    grandTotalHours += teacherTotalHours;

    return `
      <tr>
        <td class="sticky-col">
          <span class="teacher-color-dot" style="background:${escapeHtml(getTeacherColor(t))}"></span>
          <span class="repartition-teacher-id">
            <strong>${escapeHtml(t.name || "Professeur")}</strong>
            <small>${escapeHtml(getTeacherDisplayLabel(t))}</small>
          </span>
        </td>
        ${cells}
        <td style="text-align:center; font-weight:800; background:#f8fbff;">
          ${formatHours(teacherTotalHours)}h
        </td>
      </tr>
    `;
  }).join("");

  const footerCols = catalog
    .map((c) => {
      const total = Number(colTotals.get(c.key) || 0);
      const text = c.key === "PROJET" ? `${formatHours(total)}h` : String(total);
      return `<td><strong>${text}</strong></td>`;
    })
    .join("");

  ui.repartitionBesoinsContainer.innerHTML = `
    <div class="table-scroll-wrapper">
      <table class="repartition-table">
        <thead>
          <tr>
            <th class="sticky-col">Professeur</th>
            ${headCols}
            <th>Total (Heures)</th>
          </tr>
        </thead>
        <tbody>${besoinRows || "<tr><td colspan='10'>Aucun professeur.</td></tr>"}</tbody>
        <tfoot>
          <tr class="total-row">
            <td class="sticky-col"><strong>TOTAL</strong></td>
            ${footerCols}
            <td style="text-align:center;"><strong>${formatHours(grandTotalHours)}h</strong></td>
          </tr>
        </tfoot>
      </table>
    </div>
  `;

  // Interaction logic for Attributions (+/-)
  ui.repartitionBesoinsContainer.querySelectorAll(".repartition-btn").forEach(btn => {
    btn.addEventListener("click", async (e) => {
      const teacherId = btn.dataset.teacherId;
      const key = btn.dataset.quotaKey;
      const delta = Number(btn.dataset.delta || 0);
      const teacher = state.teachers.find(t => t.id === teacherId);
      if (!teacher) return;

      const currentQuotas = { ...getTeacherAssignedLevelQuotas(teacher) };
      const current = Number(currentQuotas[key] || 0);
      const next = Math.max(0, current + delta);

      if (next > 0) currentQuotas[key] = next;
      else delete currentQuotas[key];

      await updateDoc(doc(db, "teachers", teacherId), { assignedLevelQuotas: currentQuotas });
    });
  });

  // Interaction logic for Projet (numeric input)
  ui.repartitionBesoinsContainer.querySelectorAll(".repartition-projet-input").forEach(input => {
    input.addEventListener("change", async () => {
      const teacherId = input.dataset.teacherId;
      const key = input.dataset.quotaKey;
      const val = parseFloat(input.value);
      if (isNaN(val) || val < 0) return;

      const teacher = state.teachers.find(t => t.id === teacherId);
      if (!teacher) return;

      const currentQuotas = { ...getTeacherAssignedLevelQuotas(teacher) };
      if (val > 0) currentQuotas[key] = val;
      else delete currentQuotas[key];

      await updateDoc(doc(db, "teachers", teacherId), { assignedLevelQuotas: currentQuotas });
    });
  });
}

async function resetRepartitionForAllTeachers() {
  if (!state.teachers.length) return;
  const confirmed = confirm(
    "Confirmer l'effacement de toute la répartition ?\n\nCela supprimera toutes les attributions par niveau pour tous les professeurs."
  );
  if (!confirmed) return;

  const batch = db.batch();
  for (const teacher of state.teachers) {
    batch.update(doc(db, "teachers", teacher.id), {
      assignedLevelQuotas: {},
      assignedTargets: [],
      updatedAt: serverTimestamp(),
    });
  }
  try {
    await batch.commit();
    if (ui.sessionError) {
      ui.sessionError.textContent = "Répartition effacée pour tous les professeurs.";
      ui.sessionError.className = "error-text hours-ok";
    }
  } catch (error) {
    if (ui.sessionError) {
      ui.sessionError.textContent = `Erreur effacement répartition: ${error?.message || "opération impossible."}`;
      ui.sessionError.className = "error-text hours-over";
    }
  }
}

function csvEscape(value) {
  const text = String(value ?? "");
  if (!/[;"\n\r]/.test(text)) return text;
  return `"${text.replace(/"/g, "\"\"")}"`;
}

function exportRepartitionCsv() {
  const teachers = state.teachers || [];
  const catalog = getTeacherQuotaCatalog();
  const hoursByTeacher = computeTeacherHours();
  const yearId = getActiveSchoolYearId();

  const lines = [];
  lines.push(`Répartition des services;Année;${csvEscape(yearId)}`);
  lines.push("");

  lines.push("BILAN DES HEURES");
  lines.push("Professeur;Potentiel (h);Déjà affecté (h);Solde (h)");
  let totalMax = 0;
  let totalUsed = 0;
  teachers.forEach((t) => {
    const max = Number(t.maxHours || 0);
    const used = Number(hoursByTeacher.get(t.id) || 0);
    const solde = max - used;
    totalMax += max;
    totalUsed += used;
    lines.push([
      csvEscape(getTeacherDisplayLabel(t)),
      csvEscape(formatHours(max)),
      csvEscape(formatHours(used)),
      csvEscape(formatHours(solde)),
    ].join(";"));
  });
  lines.push([
    "TOTAL",
    csvEscape(formatHours(totalMax)),
    csvEscape(formatHours(totalUsed)),
    csvEscape(formatHours(totalMax - totalUsed)),
  ].join(";"));
  lines.push("");

  lines.push("ATTRIBUTIONS PAR NIVEAU");
  const head = ["Professeur", ...catalog.map((c) => c.label), "Total (h)"];
  lines.push(head.map(csvEscape).join(";"));

  const colTotals = new Map();
  catalog.forEach((c) => colTotals.set(c.key, 0));
  let grandTotalHours = 0;

  teachers.forEach((t) => {
    const quotas = getTeacherAssignedLevelQuotas(t);
    let teacherHours = 0;
    const values = catalog.map((c) => {
      const count = Number(quotas[c.key] || 0);
      colTotals.set(c.key, Number(colTotals.get(c.key) || 0) + count);
      teacherHours += c.key === "PROJET" ? count : count * Number(c.weeklyHours || 0);
      return count;
    });
    grandTotalHours += teacherHours;
    lines.push([csvEscape(getTeacherDisplayLabel(t)), ...values.map(csvEscape), csvEscape(formatHours(teacherHours))].join(";"));
  });

  const footer = [
    "TOTAL",
    ...catalog.map((c) => {
      const total = Number(colTotals.get(c.key) || 0);
      return c.key === "PROJET" ? `${formatHours(total)}h` : total;
    }),
    formatHours(grandTotalHours),
  ];
  lines.push(footer.map(csvEscape).join(";"));

  const csv = `\uFEFF${lines.join("\n")}`;
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `repartition_${yearId}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function exportRepartitionExcelStyled() {
  const yearId = getActiveSchoolYearId();
  const teachers = state.teachers || [];
  const catalog = getTeacherQuotaCatalog();
  const hoursByTeacher = computeTeacherHours();
  const apportsRows = [];
  let totalMax = 0;
  let totalUsed = 0;
  for (const t of teachers) {
    const max = Number(t.maxHours || 0);
    const used = Number(hoursByTeacher.get(t.id) || 0);
    const solde = max - used;
    totalMax += max;
    totalUsed += used;
    apportsRows.push(`
      <tr>
        <td><strong>${escapeHtml(getTeacherDisplayLabel(t))}</strong></td>
        <td>${formatHours(max)}h</td>
        <td>${formatHours(used)}h</td>
        <td>${formatHours(solde)}h</td>
      </tr>`);
  }
  const apportsHtml = `
    <table>
      <thead>
        <tr><th>Professeur</th><th>Potentiel (max)</th><th>Déjà affecté</th><th>Solde</th></tr>
      </thead>
      <tbody>${apportsRows.join("") || "<tr><td colspan='4'>Aucun professeur.</td></tr>"}</tbody>
      <tfoot><tr class="total-row"><td><strong>TOTAL</strong></td><td><strong>${formatHours(totalMax)}h</strong></td><td><strong>${formatHours(totalUsed)}h</strong></td><td><strong>${formatHours(totalMax - totalUsed)}h</strong></td></tr></tfoot>
    </table>`;

  const colTotals = new Map();
  catalog.forEach((c) => colTotals.set(c.key, 0));
  let grandTotalHours = 0;
  const besoinsRows = [];
  for (const t of teachers) {
    const quotas = getTeacherAssignedLevelQuotas(t);
    let teacherHours = 0;
    const cells = catalog
      .map((c) => {
        const count = Number(quotas[c.key] || 0);
        colTotals.set(c.key, Number(colTotals.get(c.key) || 0) + count);
        teacherHours += c.key === "PROJET" ? count : count * Number(c.weeklyHours || 0);
        return `<td>${count}</td>`;
      })
      .join("");
    grandTotalHours += teacherHours;
    besoinsRows.push(`<tr><td><strong>${escapeHtml(getTeacherDisplayLabel(t))}</strong></td>${cells}<td><strong>${formatHours(teacherHours)}h</strong></td></tr>`);
  }
  const besoinsFooter = catalog
    .map((c) => {
      const total = Number(colTotals.get(c.key) || 0);
      return `<td><strong>${c.key === "PROJET" ? `${formatHours(total)}h` : total}</strong></td>`;
    })
    .join("");
  const besoinsHtml = `
    <table>
      <thead>
        <tr><th>Professeur</th>${catalog.map((c) => `<th>${escapeHtml(c.label)}</th>`).join("")}<th>Total (Heures)</th></tr>
      </thead>
      <tbody>${besoinsRows.join("") || "<tr><td colspan='10'>Aucun professeur.</td></tr>"}</tbody>
      <tfoot><tr class="total-row"><td><strong>TOTAL</strong></td>${besoinsFooter}<td><strong>${formatHours(grandTotalHours)}h</strong></td></tr></tfoot>
    </table>`;
  if (!apportsHtml && !besoinsHtml) {
    if (ui.sessionError) ui.sessionError.textContent = "Aucune donnée de répartition à exporter.";
    return;
  }

  const html = `
  <html xmlns:o="urn:schemas-microsoft-com:office:office"
        xmlns:x="urn:schemas-microsoft-com:office:excel"
        xmlns="http://www.w3.org/TR/REC-html40">
  <head>
    <meta charset="UTF-8" />
    <style>
      body { font-family: Arial, sans-serif; }
      h2 { color: #0b4f6c; margin: 10px 0 6px; }
      .subtitle { color: #333; margin-bottom: 12px; font-size: 12px; }
      table { border-collapse: collapse; width: 100%; margin-bottom: 14px; }
      th, td { border: 1px solid #b9c7d4; padding: 6px; font-size: 12px; }
      th { background: #eaf3fb; color: #0c3f5e; font-weight: 700; }
      tfoot td, .total-row td { background: #f3f8fc !important; font-weight: 700; }
      .hours-over { color: #b42318; font-weight: 700; }
      .hours-ok { color: #117a37; font-weight: 700; }
      .sticky-col { background: #f8fbff; font-weight: 700; }
      .teacher-color-dot { display: inline-block; width: 10px; height: 10px; border-radius: 999px; margin-right: 6px; vertical-align: middle; }
    </style>
  </head>
  <body>
    <h2>Répartition des services</h2>
    <div class="subtitle">Année scolaire: ${escapeHtml(yearId)}</div>
    <h2>Bilan des heures</h2>
    ${apportsHtml}
    <h2>Attributions par niveau</h2>
    ${besoinsHtml}
  </body>
  </html>`;

  const blob = new Blob(["\uFEFF", html], { type: "application/vnd.ms-excel;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `repartition_${yearId}.xls`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function exportRepartitionImagePng() {
  const teachers = state.teachers || [];
  const catalog = getTeacherQuotaCatalog();
  const hoursByTeacher = computeTeacherHours();
  if (!teachers.length) {
    if (ui.sessionError) ui.sessionError.textContent = "Aucune donnée de répartition à exporter en image.";
    return;
  }
  const yearId = getActiveSchoolYearId();
  const colCount = 2 + catalog.length + 1;
  const colWidths = [220, 100, ...catalog.map(() => 70), 90];
  const rowH = 28;
  const headerRows = 3;
  const rows = headerRows + 1 + teachers.length + 1;
  const width = colWidths.reduce((a, b) => a + b, 0) + 20;
  const height = rows * rowH + 30;

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = "#0b4f6c";
  ctx.font = "bold 16px Arial";
  ctx.fillText(`Répartition des services - ${yearId}`, 10, 22);

  let y = 36;
  const drawCell = (x, yy, w, h, text, opts = {}) => {
    ctx.fillStyle = opts.bg || "#fff";
    ctx.fillRect(x, yy, w, h);
    ctx.strokeStyle = "#b9c7d4";
    ctx.strokeRect(x, yy, w, h);
    ctx.fillStyle = opts.color || "#111";
    ctx.font = opts.bold ? "bold 12px Arial" : "12px Arial";
    ctx.fillText(String(text ?? ""), x + 6, yy + 18);
  };

  let x = 10;
  drawCell(x, y, colWidths[0], rowH, "Professeur", { bg: "#eaf3fb", bold: true }); x += colWidths[0];
  drawCell(x, y, colWidths[1], rowH, "Potentiel", { bg: "#eaf3fb", bold: true }); x += colWidths[1];
  catalog.forEach((c, i) => { drawCell(x, y, colWidths[2 + i], rowH, c.label, { bg: "#eaf3fb", bold: true }); x += colWidths[2 + i]; });
  drawCell(x, y, colWidths[colWidths.length - 1], rowH, "Total h", { bg: "#eaf3fb", bold: true });
  y += rowH;

  let totalHours = 0;
  teachers.forEach((t) => {
    const quotas = getTeacherAssignedLevelQuotas(t);
    const max = Number(t.maxHours || 0);
    let teacherHours = 0;
    x = 10;
    drawCell(x, y, colWidths[0], rowH, getTeacherDisplayLabel(t)); x += colWidths[0];
    drawCell(x, y, colWidths[1], rowH, formatHours(max));
    x += colWidths[1];
    catalog.forEach((c, i) => {
      const count = Number(quotas[c.key] || 0);
      const h = c.key === "PROJET" ? count : count * Number(c.weeklyHours || 0);
      teacherHours += h;
      drawCell(x, y, colWidths[2 + i], rowH, String(count), { color: count ? "#111" : "#777" });
      x += colWidths[2 + i];
    });
    totalHours += teacherHours;
    drawCell(x, y, colWidths[colWidths.length - 1], rowH, formatHours(teacherHours), { bold: true });
    y += rowH;
  });

  x = 10;
  drawCell(x, y, colWidths[0] + colWidths[1] + catalog.reduce((a, _c, i) => a + colWidths[2 + i], 0), rowH, "TOTAL", { bg: "#f3f8fc", bold: true });
  x += colWidths[0] + colWidths[1] + catalog.reduce((a, _c, i) => a + colWidths[2 + i], 0);
  drawCell(x, y, colWidths[colWidths.length - 1], rowH, formatHours(totalHours), { bg: "#f3f8fc", bold: true });

  const a = document.createElement("a");
  a.href = canvas.toDataURL("image/png");
  a.download = `repartition_${yearId}.png`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

function ensureRuntimeEnvironment() {
  if (window.location.protocol !== "file:") return true;

  const msg = "Mode fichier détecté. Ouvrez l'application via http://localhost (serveur web local), pas en file://.";
  ui.publicTeacherSummary.textContent = msg;
  ui.publicTimetableContainer.innerHTML = "";
  ui.sessionError.textContent = msg;
  if (ui.plannerGrid) {
    ui.plannerGrid.innerHTML = `<div class="card"><p>${escapeHtml(msg)}</p></div>`;
  }
  console.error(msg);
  return false;
}

function setupAdminSidebar() {
  const toggle = ui.adminSidebarToggleBtn;
  const collapseToggle = ui.adminSidebarCollapseBtn;
  const close = ui.adminSidebarCloseBtn;
  const overlay = ui.adminSidebarOverlay;
  const sidebar = ui.adminTabsHorizontal;
  const shell = ui.adminShell;

  if (!overlay || !sidebar || !shell) return;
  const DESKTOP_KEY = "adminSidebarCollapsed";
  const isMobile = () => window.matchMedia("(max-width: 900px)").matches;
  const navActions = Array.from(sidebar.querySelectorAll("button, summary"));

  navActions.forEach((node) => {
    const textNode = Array.from(node.querySelectorAll("span"))
      .map((span) => span.textContent.trim())
      .find((text) => text && text !== "expand_more");
    if (textNode) node.title = textNode;
  });

  const openSidebar = () => {
    sidebar.classList.add("open");
    if (toggle) toggle.innerHTML = `<span class="material-symbols-outlined">close</span>`;
  };

  const closeSidebar = () => {
    sidebar.classList.remove("open");
    if (isMobile() && toggle) {
      toggle.innerHTML = `<span class="material-symbols-outlined">menu</span>`;
    }
  };

  const applyDesktopCollapsed = (collapsed) => {
    state.adminSidebarCollapsed = Boolean(collapsed);
    shell.classList.toggle("collapsed", state.adminSidebarCollapsed);
    if (collapseToggle) {
      collapseToggle.innerHTML = `<span class="material-symbols-outlined">menu_open</span>`;
      collapseToggle.title = state.adminSidebarCollapsed ? "Déplier le menu admin" : "Replier le menu admin";
      collapseToggle.setAttribute("aria-label", collapseToggle.title);
    }
    if (toggle) toggle.innerHTML = `<span class="material-symbols-outlined">menu</span>`;
  };

  if (!isMobile()) {
    const saved = localStorage.getItem(DESKTOP_KEY) === "1";
    applyDesktopCollapsed(saved);
  }

  if (toggle) {
    toggle.addEventListener("click", () => {
      if (isMobile()) {
        const isOpen = sidebar.classList.contains("open");
        if (isOpen) closeSidebar();
        else openSidebar();
        return;
      }
    });
  }

  if (collapseToggle) collapseToggle.addEventListener("click", () => {
    if (isMobile()) return;
    const next = !state.adminSidebarCollapsed;
    applyDesktopCollapsed(next);
    localStorage.setItem(DESKTOP_KEY, next ? "1" : "0");
  });

  if (close) close.addEventListener("click", () => {
    if (isMobile()) closeSidebar();
    else {
      applyDesktopCollapsed(true);
      localStorage.setItem(DESKTOP_KEY, "1");
    }
  });
  if (overlay) overlay.addEventListener("click", closeSidebar);

  // Fermer le sidebar quand on clique sur un bouton de navigation (pour mobile)
  sidebar.querySelectorAll("button").forEach(btn => {
    btn.addEventListener("click", () => {
      if (isMobile()) {
        closeSidebar();
      }
    });
  });

  window.addEventListener("resize", () => {
    if (isMobile()) {
      shell.classList.remove("collapsed");
      closeSidebar();
      if (toggle) toggle.innerHTML = `<span class="material-symbols-outlined">menu</span>`;
    } else {
      closeSidebar();
      applyDesktopCollapsed(localStorage.getItem(DESKTOP_KEY) === "1");
    }
  });
}

function handleMagicLink() {
  const params = new URLSearchParams(window.location.search);
  const token = params.get("token");
  if (token) {
    sessionStorage.setItem("magicToken", token);
    const newUrl = window.location.origin + window.location.pathname;
    window.history.replaceState({}, document.title, newUrl);
  }
}

function init() {
  handleMagicLink();
  setupAuth();
  setupAdminSidebar();
  setupModeSwitch();
  setupFloatingAssign();
  setupInventory();
  buildConstraintsPicker();
  setupForms();
  setupTasks();
  setupDocuments();
  setupNotificationPreferences();
  setupEmailTemplates();
  document.addEventListener("fullscreenchange", () => {
    // Si le fullscreen natif a été retiré mais l'utilisateur a volontairement activé le fullscreen CSS,
    // réappliquer le fullscreen natif (car le navigateur l'a retiré automatiquement lors d'un changement de vue)
    if (!document.fullscreenElement && state.isAssignFullscreen) {
      setTimeout(() => {
        document.documentElement.requestFullscreen().catch(() => {
          // Si échec, garder le mode CSS fullscreen actif
        });
      }, 150);
    } else {
      // Sinon, synchroniser l'état avec le fullscreen natif
      updateFullscreenUiState(Boolean(document.fullscreenElement));
    }
  });
  if (ui.busEmailTo) ui.busEmailTo.value = localStorage.getItem("busEmailTo") || "";
  if (ui.replacementEmailTo) ui.replacementEmailTo.value = localStorage.getItem("replacementEmailTo") || "";
  resetTeacherForm();
  setAdminTab("recap");
  setCreationSubTab("teacher");
  setProgramSubTab("programming");
  applyClassRule();
  if (!ensureRuntimeEnvironment()) return;
  subscribeData();
  initPWAUpdateHandler();
}

window.setCreationSubTab = setCreationSubTab;

// ==================== TASKS MODULE ====================

function setupTasks() {
  if (ui.tasksCreateBtn) {
    ui.tasksCreateBtn.addEventListener("click", () => openTaskEditModal(null));
  }

  if (ui.tasksFilterCategory) {
    ui.tasksFilterCategory.addEventListener("change", (e) => {
      state.tasksFilterCategory = e.target.value;
      renderTasksKanban();
    });
  }

  if (ui.tasksEditForm) {
    ui.tasksEditForm.addEventListener("submit", (e) => {
      e.preventDefault();
      saveTask();
    });
  }

  if (ui.tasksEditCancelBtn) {
    ui.tasksEditCancelBtn.addEventListener("click", closeTaskEditModal);
  }

  if (ui.tasksEditModalClose) {
    ui.tasksEditModalClose.addEventListener("click", closeTaskEditModal);
  }

  if (ui.tasksDetailsCloseBtn) {
    ui.tasksDetailsCloseBtn.addEventListener("click", closeTaskDetailsModal);
  }

  if (ui.tasksDetailsModalClose) {
    ui.tasksDetailsModalClose.addEventListener("click", closeTaskDetailsModal);
  }

  if (ui.tasksDetailsMarkDoneBtn) {
    ui.tasksDetailsMarkDoneBtn.addEventListener("click", markTaskAsDone);
  }

  if (ui.tasksNotificationCloseBtn) {
    ui.tasksNotificationCloseBtn.addEventListener("click", () => {
      if (ui.tasksNotificationModal) ui.tasksNotificationModal.classList.add("hidden");
    });
  }

  if (ui.tasksMyTasksCloseBtn) {
    ui.tasksMyTasksCloseBtn.addEventListener("click", closeTasksMyTasksModal);
  }

  if (ui.tasksMyTasksModalClose) {
    ui.tasksMyTasksModalClose.addEventListener("click", closeTasksMyTasksModal);
  }

  if (ui.tasksNotificationBellBtn) {
    ui.tasksNotificationBellBtn.addEventListener("click", showTasksNotificationModal);
  }

  if (ui.tasksAddCommentBtn) {
    ui.tasksAddCommentBtn.addEventListener("click", addTaskComment);
  }

  if (ui.tasksMarkInProgressBtn) {
    ui.tasksMarkInProgressBtn.addEventListener("click", () => {
      if (state.tasksEditingId) {
        updateTaskStatus(state.tasksEditingId, "EN_COURS");
      }
    });
  }

  if (ui.tasksMarkDoneBtn) {
    ui.tasksMarkDoneBtn.addEventListener("click", () => {
      if (state.tasksEditingId) {
        updateTaskStatus(state.tasksEditingId, "TERMINEE");
      }
    });
  }

  if (ui.tasksDetailsEditBtn) {
    ui.tasksDetailsEditBtn.addEventListener("click", () => {
      if (state.tasksEditingId) {
        closeTaskDetailsModal();
        openTaskEditModal(state.tasksEditingId);
      }
    });
  }

  if (ui.tasksAddStepBtn) {
    ui.tasksAddStepBtn.addEventListener("click", addTaskStep);
  }

  if (ui.tasksNewStepInput) {
    ui.tasksNewStepInput.addEventListener("keypress", (e) => {
      if (e.key === "Enter") addTaskStep();
    });
  }
}

function startTasksRealtime() {
  const db = firebase.firestore();
  const tasksRef = db.collection("tasks").where("schoolYear", "==", state.activeSchoolYearId);

  state.tasksSnapshot = tasksRef.onSnapshot({
    next: (snapshot) => {
      state.tasks = snapshot.docs.map((doc) => ({
        id: doc.id,
        ...doc.data(),
      }));
      state.tasksLoaded = true;
      renderTasksKanban();
      checkTaskNotifications();
    },
    error: (err) => console.error("Erreur chargement tâches:", err),
  });
}

function stopTasksRealtime() {
  if (state.tasksSnapshot) {
    state.tasksSnapshot();
    state.tasksSnapshot = null;
  }
}

function openTaskEditModal(taskId) {
  const rights = getCurrentUserRights();
  if (rights.tasks === "NONE") {
    showToast("Vous n'avez pas les droits pour créer des tâches", "error");
    return;
  }

  if (!ui.tasksEditForm || !ui.tasksEditTitle) return;

  const task = taskId ? state.tasks.find((t) => t.id === taskId) : null;
  state.tasksEditingId = taskId;

  if (ui.tasksEditModalTitle) {
    ui.tasksEditModalTitle.textContent = task ? "Modifier la tâche" : "Nouvelle tâche";
  }

  ui.tasksEditTitle.value = task?.title || "";
  ui.tasksEditDescription.value = task?.description || "";
  ui.tasksEditPriority.value = task?.priority || "NORMALE";
  ui.tasksEditCategory.value = task?.category || "AUTRE";
  ui.tasksEditDueDate.value = task?.dueDate || "";

  // Remplir les profs assignés
  if (ui.tasksEditAssignedTeachers) {
    ui.tasksEditAssignedTeachers.innerHTML = "";
    state.teachers.forEach((teacher) => {
      const option = document.createElement("option");
      option.value = teacher.id;
      option.textContent = teacher.name;
      if (task?.assignedTeachers?.includes(teacher.id)) {
        option.selected = true;
      }
      ui.tasksEditAssignedTeachers.appendChild(option);
    });
  }

  // Bouton supprimer visible seulement en édition
  if (ui.tasksEditDeleteBtn) {
    ui.tasksEditDeleteBtn.classList.toggle("hidden", !task);
    if (task) {
      ui.tasksEditDeleteBtn.addEventListener("click", () => deleteTask(taskId), { once: true });
    }
  }

  if (ui.tasksEditModal) ui.tasksEditModal.classList.remove("hidden");
}

function closeTaskEditModal() {
  if (ui.tasksEditModal) ui.tasksEditModal.classList.add("hidden");
  state.tasksEditingId = null;
}

function closeTaskDetailsModal() {
  if (ui.tasksDetailsModal) ui.tasksDetailsModal.classList.add("hidden");
}

function closeTasksMyTasksModal() {
  if (ui.tasksMyTasksModal) ui.tasksMyTasksModal.classList.add("hidden");
}

async function saveTask() {
  if (!ui.tasksEditTitle?.value.trim()) {
    showToast("Le titre est obligatoire", "error");
    return;
  }

  const db = firebase.firestore();
  const assignedTeachersSelect = ui.tasksEditAssignedTeachers;
  const assignedTeachers = Array.from(assignedTeachersSelect?.selectedOptions || []).map((o) => o.value);

  const taskData = {
    title: ui.tasksEditTitle.value,
    description: ui.tasksEditDescription.value,
    priority: ui.tasksEditPriority.value,
    category: ui.tasksEditCategory.value,
    dueDate: ui.tasksEditDueDate.value,
    assignedTeachers,
    assignedBy: state.currentUserTeacherId,
    schoolYear: state.activeSchoolYearId,
    updatedAt: new Date(),
  };

  try {
    if (state.tasksEditingId) {
      await db.collection("tasks").doc(state.tasksEditingId).update(taskData);
      showToast("Tâche mise à jour ✓", "success");
      logActivity("Tâche modifiée", { taskId: state.tasksEditingId, ...taskData });
    } else {
      taskData.status = "A_FAIRE";
      taskData.createdBy = state.currentUser?.uid;
      taskData.createdAt = new Date();
      const docRef = await db.collection("tasks").add(taskData);
      showToast("Tâche créée ✓", "success");
      logActivity("Tâche créée", { taskId: docRef.id, ...taskData });

      // Notifier les profs assignés
      assignedTeachers.forEach((teacherId) => {
        const teacher = state.teachers.find((t) => t.id === teacherId);
        if (teacher) {
          showToast(`Tâche attribuée à ${teacher.name}`, "info");
        }
      });
    }

    closeTaskEditModal();
  } catch (err) {
    console.error("Erreur sauvegarde tâche:", err);
    showToast("Erreur lors de la sauvegarde", "error");
  }
}

async function deleteTask(taskId) {
  if (!confirm("Êtes-vous sûr de vouloir supprimer cette tâche ?")) return;

  const db = firebase.firestore();
  try {
    await db.collection("tasks").doc(taskId).delete();
    showToast("Tâche supprimée ✓", "success");
    logActivity("Tâche supprimée", { taskId });
    closeTaskEditModal();
  } catch (err) {
    console.error("Erreur suppression tâche:", err);
    showToast("Erreur lors de la suppression", "error");
  }
}

async function updateTaskStatus(taskId, newStatus) {
  const db = firebase.firestore();
  try {
    const updateData = { status: newStatus, updatedAt: new Date() };

    if (newStatus === "TERMINEE") {
      updateData.completedBy = state.currentUser?.uid;
      updateData.completedAt = new Date();
    }

    await db.collection("tasks").doc(taskId).update(updateData);
    showToast(`Tâche déplacée en "${newStatus.replace("_", " ")}" ✓`, "success");
    logActivity("Tâche déplacée", { taskId, newStatus });
  } catch (err) {
    console.error("Erreur mise à jour statut:", err);
    showToast("Erreur lors de la mise à jour", "error");
  }
}

async function markTaskAsDone() {
  if (state.tasksEditingId) {
    await updateTaskStatus(state.tasksEditingId, "TERMINEE");
    closeTaskDetailsModal();
  }
}

function renderTasksKanban() {
  const rights = getCurrentUserRights();
  const isAdmin = rights.tasks !== "NONE";

  const statuses = ["A_FAIRE", "EN_COURS", "TERMINEE"];

  statuses.forEach((status) => {
    const columnEl = document.getElementById(`tasksColumn${status}`);
    const countEl = document.getElementById(`tasksCount${status}`);

    if (!columnEl) return;

    const filtered = state.tasks.filter((task) => {
      if (task.status !== status) return false;
      if (state.tasksFilterCategory && task.category !== state.tasksFilterCategory) return false;
      if (!isAdmin) {
        return task.assignedTeachers?.includes(state.currentUserTeacherId);
      }
      return true;
    });

    const html = filtered
      .map((task) => renderTaskCard(task, isAdmin))
      .join("");

    columnEl.innerHTML = html || '<div class="kanban-empty">Aucune tâche</div>';

    if (countEl) countEl.textContent = filtered.length;

    // Ajouter les event listeners aux cartes
    columnEl.querySelectorAll(".task-card").forEach((card) => {
      card.addEventListener("click", () => openTaskDetailsModal(card.dataset.taskId));
      card.draggable = isAdmin;
      card.addEventListener("dragstart", (e) => {
        if (!isAdmin) return;
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", card.dataset.taskId);
      });
    });
  });

  // Ajouter les zones de drop
  statuses.forEach((status) => {
    const columnEl = document.getElementById(`tasksColumn${status}`);
    if (!columnEl || !isAdmin) return;

    columnEl.addEventListener("dragover", (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      columnEl.style.backgroundColor = "#e3f2fd";
    });

    columnEl.addEventListener("dragleave", () => {
      columnEl.style.backgroundColor = "";
    });

    columnEl.addEventListener("drop", async (e) => {
      e.preventDefault();
      columnEl.style.backgroundColor = "";
      const taskId = e.dataTransfer.getData("text/plain");
      await updateTaskStatus(taskId, status);
    });
  });
}

function renderTaskCard(task, isAdmin) {
  const dueDate = task.dueDate ? new Date(task.dueDate) : null;
  const isOverdue = dueDate && dueDate < new Date() && task.status !== "TERMINEE";
  const dueDateStr = dueDate ? dueDate.toLocaleDateString("fr-FR") : "";

  const assignees = task.assignedTeachers
    ?.map((id) => state.teachers.find((t) => t.id === id)?.name?.charAt(0) || "?")
    .join("");

  return `
    <div class="task-card priority-${task.priority}" data-task-id="${task.id}">
      <div class="task-card-header">
        <h4 class="task-card-title">${escapeHtml(task.title)}</h4>
        <span class="task-card-priority ${task.priority}">${task.priority}</span>
      </div>

      ${task.category ? `<div class="task-card-category">${task.category}</div>` : ""}

      ${task.description ? `<p class="task-card-description">${escapeHtml(task.description)}</p>` : ""}

      <div class="task-card-footer">
        <span class="task-card-duedate ${isOverdue ? "overdue" : ""}">${dueDateStr || "Sans date"}</span>
        ${task.assignedTeachers?.length ? `<div class="task-card-assignees">${task.assignedTeachers.map((id) => {
          const teacher = state.teachers.find((t) => t.id === id);
          return `<div class="task-assignee-avatar" title="${escapeHtml(teacher?.name || "")}">${escapeHtml(getTeacherDisplayLabel(teacher) || "?")}</div>`;
        }).join("")}</div>` : ""}
      </div>
    </div>
  `;
}

function openTaskDetailsModal(taskId) {
  const task = state.tasks.find((t) => t.id === taskId);
  if (!task) return;

  const rights = getCurrentUserRights();
  const isAssigned = task.assignedTeachers?.includes(state.currentUserTeacherId);
  const isAdmin = rights.tasks !== "NONE";

  if (ui.tasksDetailsTitle) ui.tasksDetailsTitle.textContent = task.title;

  if (ui.tasksDetailsContent) {
    const assignedTeachers = task.assignedTeachers
      ?.map((id) => state.teachers.find((t) => t.id === id)?.name || "?")
      .join(", ") || "Non assigné";

    ui.tasksDetailsContent.innerHTML = `
      <div class="task-details-row">
        <span class="task-details-label">Titre</span>
        <span class="task-details-value">${escapeHtml(task.title)}</span>
      </div>
      ${task.description ? `
        <div class="task-details-row">
          <span class="task-details-label">Description</span>
          <span class="task-details-value">${escapeHtml(task.description)}</span>
        </div>
      ` : ""}
      <div class="task-details-row">
        <span class="task-details-label">Priorité</span>
        <span class="task-details-value">${task.priority}</span>
      </div>
      <div class="task-details-row">
        <span class="task-details-label">Catégorie</span>
        <span class="task-details-value">${task.category || "N/A"}</span>
      </div>
      ${task.dueDate ? `
        <div class="task-details-row">
          <span class="task-details-label">Date limite</span>
          <span class="task-details-value">${new Date(task.dueDate).toLocaleDateString("fr-FR")}</span>
        </div>
      ` : ""}
      <div class="task-details-row">
        <span class="task-details-label">Assigné à</span>
        <span class="task-details-value">${assignedTeachers}</span>
      </div>
      <div class="task-details-row">
        <span class="task-details-label">Assigné par</span>
        <span class="task-details-value">${task.assignedBy ? escapeHtml(state.teachers.find((t) => t.id === task.assignedBy)?.name || "?") : "N/A"}</span>
      </div>
      <div class="task-details-row">
        <span class="task-details-label">Statut</span>
        <span class="task-details-value">${task.status.replace("_", " ")}</span>
      </div>
    `;
  }

  if (ui.tasksDetailsMarkDoneBtn) {
    ui.tasksDetailsMarkDoneBtn.classList.toggle("hidden", !isAssigned || task.status === "TERMINEE");
  }

  if (ui.tasksDetailsEditBtn) {
    ui.tasksDetailsEditBtn.classList.toggle("hidden", !isAdmin);
  }

  // Afficher/masquer la section des étapes et des commentaires
  if (ui.tasksStepsSection) {
    ui.tasksStepsSection.classList.toggle("hidden", !isAssigned && !isAdmin);
  }

  if (ui.tasksCommentsSection) {
    ui.tasksCommentsSection.classList.toggle("hidden", !isAssigned);
  }

  if (ui.tasksMarkInProgressBtn && ui.tasksMarkDoneBtn) {
    const canChangeStatus = isAssigned && task.status !== "TERMINEE";
    ui.tasksMarkInProgressBtn.classList.toggle("hidden", !canChangeStatus);
    ui.tasksMarkDoneBtn.classList.toggle("hidden", !canChangeStatus);

    // Masquer "Marquer en cours" si c'est déjà en cours
    if (ui.tasksMarkInProgressBtn) {
      ui.tasksMarkInProgressBtn.disabled = task.status === "EN_COURS";
    }
  }

  // Réinitialiser les inputs
  if (ui.tasksCommentInput) {
    ui.tasksCommentInput.value = "";
  }

  if (ui.tasksNewStepInput) {
    ui.tasksNewStepInput.value = "";
  }

  // Charger les étapes et commentaires
  startTasksStepsRealtime(taskId);
  startTasksCommentsRealtime(taskId);

  if (ui.tasksDetailsModal) ui.tasksDetailsModal.classList.remove("hidden");
  state.tasksEditingId = taskId;
}

function checkTaskNotifications() {
  if (!state.currentUserTeacherId) return;

  const myTasks = state.tasks.filter((t) => t.assignedTeachers?.includes(state.currentUserTeacherId) && t.status !== "TERMINEE");
  const count = myTasks.length;

  // Mettre à jour le badge
  updateTaskNotificationBadge(count);
}

function updateTaskNotificationBadge(count) {
  if (!ui.tasksNotificationBadge) return;

  if (count > 0) {
    ui.tasksNotificationBadge.textContent = count;
    ui.tasksNotificationBadge.classList.remove("hidden");
  } else {
    ui.tasksNotificationBadge.classList.add("hidden");
  }
}

function showTasksNotificationModal() {
  if (!state.currentUserTeacherId) return;

  const myTasks = state.tasks.filter((t) => t.assignedTeachers?.includes(state.currentUserTeacherId));

  if (!ui.tasksMyTasksContent) return;

  const html = myTasks
    .filter((task) => task.status !== "TERMINEE")
    .map((task) => `
      <div class="task-notification-item" style="padding: 1rem; border: 1px solid var(--border); border-radius: 6px; margin-bottom: 0.8rem; cursor: pointer;" onclick="openTaskDetailsModal('${task.id}')">
        <div style="display: flex; justify-content: space-between; align-items: start;">
          <div>
            <h5 style="margin: 0 0 0.4rem 0;">${escapeHtml(task.title)}</h5>
            <p style="margin: 0; font-size: 0.85rem; color: var(--muted);">${escapeHtml(task.description || "")}</p>
          </div>
          <span style="background: ${task.status === "EN_COURS" ? "var(--secondary-soft)" : "var(--surface-strong)"}; color: ${task.status === "EN_COURS" ? "var(--secondary)" : "var(--muted)"}; padding: 0.25rem 0.6rem; border-radius: 3px; font-size: 0.75rem; font-weight: 600;">${task.status.replace("_", " ")}</span>
        </div>
        ${task.dueDate ? `<p style="margin: 0.5rem 0 0 0; font-size: 0.8rem; color: var(--muted);">Date limite: ${new Date(task.dueDate).toLocaleDateString("fr-FR")}</p>` : ""}
      </div>
    `)
    .join("");

  ui.tasksMyTasksContent.innerHTML = html || '<p style="text-align: center; color: var(--muted); padding: 2rem;">Aucune tâche en attente 🎉</p>';

  if (ui.tasksMyTasksModal) ui.tasksMyTasksModal.classList.remove("hidden");
}

function startTasksCommentsRealtime(taskId) {
  const db = firebase.firestore();
  const commentsRef = db.collection("taskComments").where("taskId", "==", taskId).orderBy("createdAt", "asc");

  // Arrêter l'ancienne écoute si elle existe
  if (state.tasksCommentsSnapshot.has(taskId)) {
    state.tasksCommentsSnapshot.get(taskId)();
  }

  const unsubscribe = commentsRef.onSnapshot({
    next: (snapshot) => {
      const comments = snapshot.docs.map((doc) => ({
        id: doc.id,
        ...doc.data(),
      }));
      state.tasksComments.set(taskId, comments);
      renderTaskComments(taskId);
    },
    error: (err) => console.error("Erreur chargement commentaires:", err),
  });

  state.tasksCommentsSnapshot.set(taskId, unsubscribe);
}

function renderTaskComments(taskId) {
  if (!ui.tasksCommentsList) return;

  const comments = state.tasksComments.get(taskId) || [];

  const html = comments
    .map((comment) => {
      const author = state.teachers.find((t) => t.id === comment.authorId)?.name || "Inconnu";
      const timestamp = new Date(comment.createdAt).toLocaleDateString("fr-FR", { hour: "2-digit", minute: "2-digit" });
      const statusLabel = comment.statusChange ? ` <span class="task-comment-status">${comment.statusChange}</span>` : "";

      return `
        <div class="task-comment">
          <div class="task-comment-header">
            <span class="task-comment-author">${escapeHtml(author)}${statusLabel}</span>
            <span class="task-comment-time">${timestamp}</span>
          </div>
          <p class="task-comment-text">${escapeHtml(comment.text)}</p>
        </div>
      `;
    })
    .join("");

  ui.tasksCommentsList.innerHTML = html || '<p style="text-align: center; color: var(--muted); font-style: italic;">Aucun commentaire</p>';
}

async function addTaskComment() {
  if (!state.tasksEditingId || !ui.tasksCommentInput) return;

  const text = ui.tasksCommentInput.value.trim();
  if (!text) {
    showToast("Veuillez écrire un commentaire", "error");
    return;
  }

  const db = firebase.firestore();

  try {
    await db.collection("taskComments").add({
      taskId: state.tasksEditingId,
      authorId: state.currentUser?.uid,
      text,
      createdAt: new Date(),
    });

    ui.tasksCommentInput.value = "";
    showToast("Commentaire ajouté ✓", "success");
  } catch (err) {
    console.error("Erreur ajout commentaire:", err);
    showToast("Erreur lors de l'ajout du commentaire", "error");
  }
}

function startTasksStepsRealtime(taskId) {
  const db = firebase.firestore();
  const stepsRef = db.collection("taskSteps").where("taskId", "==", taskId).orderBy("createdAt", "asc");

  // Arrêter l'ancienne écoute si elle existe
  if (state.tasksStepsSnapshots.has(taskId)) {
    state.tasksStepsSnapshots.get(taskId)();
  }

  const unsubscribe = stepsRef.onSnapshot({
    next: (snapshot) => {
      const steps = snapshot.docs.map((doc) => ({
        id: doc.id,
        ...doc.data(),
      }));
      state.tasksSteps.set(taskId, steps);
      renderTaskSteps(taskId);
    },
    error: (err) => console.error("Erreur chargement étapes:", err),
  });

  state.tasksStepsSnapshots.set(taskId, unsubscribe);
}

function renderTaskSteps(taskId) {
  if (!ui.tasksStepsList || state.tasksEditingId !== taskId) return;

  const steps = state.tasksSteps.get(taskId) || [];

  const html = steps
    .map((step) => `
      <div class="task-step-item">
        <input type="checkbox" ${step.completed ? "checked" : ""} onchange="toggleTaskStepCompletion('${state.tasksEditingId}', '${step.id}', this.checked)">
        <span class="task-step-text">${escapeHtml(step.title)}</span>
        <button class="task-step-delete" onclick="deleteTaskStep('${state.tasksEditingId}', '${step.id}')">✕</button>
      </div>
    `)
    .join("");

  ui.tasksStepsList.innerHTML = html || '<p style="color: var(--muted); font-size: 0.85rem; margin: 0;">Aucune étape</p>';
}

async function addTaskStep() {
  if (!state.tasksEditingId || !ui.tasksNewStepInput) return;

  const title = ui.tasksNewStepInput.value.trim();
  if (!title) {
    showToast("Veuillez entrer un titre d'étape", "error");
    return;
  }

  const db = firebase.firestore();

  try {
    await db.collection("taskSteps").add({
      taskId: state.tasksEditingId,
      title,
      completed: false,
      createdAt: new Date(),
    });

    ui.tasksNewStepInput.value = "";
    showToast("Étape ajoutée ✓", "success");
  } catch (err) {
    console.error("Erreur ajout étape:", err);
    showToast("Erreur lors de l'ajout de l'étape", "error");
  }
}

async function toggleTaskStepCompletion(taskId, stepId, completed) {
  const db = firebase.firestore();

  try {
    await db.collection("taskSteps").doc(stepId).update({
      completed,
    });
  } catch (err) {
    console.error("Erreur mise à jour étape:", err);
    showToast("Erreur lors de la mise à jour", "error");
  }
}

async function deleteTaskStep(taskId, stepId) {
  if (!confirm("Supprimer cette étape ?")) return;

  const db = firebase.firestore();

  try {
    await db.collection("taskSteps").doc(stepId).delete();
    showToast("Étape supprimée ✓", "success");
  } catch (err) {
    console.error("Erreur suppression étape:", err);
    showToast("Erreur lors de la suppression", "error");
  }
}

window.setupTasks = setupTasks;
window.openTaskDetailsModal = openTaskDetailsModal;
window.toggleTaskStepCompletion = toggleTaskStepCompletion;
window.deleteTaskStep = deleteTaskStep;

// ==================== DOCUMENTS MODULE ====================

function setupDocuments() {
  if (ui.documentsCreateFolderBtn) {
    ui.documentsCreateFolderBtn.addEventListener("click", createDocumentsFolder);
  }

  if (ui.documentsNewFolderName) {
    ui.documentsNewFolderName.addEventListener("keypress", (e) => {
      if (e.key === "Enter") createDocumentsFolder();
    });
  }

  // Configurer l'input file du HTML
  if (ui.documentsFileInput) {
    ui.documentsFileInput.addEventListener("change", (e) => {
      if (e.target.files && e.target.files.length > 0) {
        uploadDocumentsFiles(e.target.files);
        // Réinitialiser après upload pour pouvoir sélectionner le même fichier
        ui.documentsFileInput.value = "";
      }
    });
  }

  if (ui.documentsDeleteFolderBtn) {
    ui.documentsDeleteFolderBtn.addEventListener("click", deleteDocumentsFolder);
  }

  if (ui.documentsRenameFolderBtn) {
    ui.documentsRenameFolderBtn.addEventListener("click", openRenameDocumentsFolderModal);
  }

  if (ui.documentsRenameFolderSaveBtn) {
    ui.documentsRenameFolderSaveBtn.addEventListener("click", saveRenameDocumentsFolder);
  }

  if (ui.documentsRenameFolderCancelBtn) {
    ui.documentsRenameFolderCancelBtn.addEventListener("click", closeRenameDocumentsFolderModal);
  }

  if (ui.documentsPreviewCloseBtn) {
    ui.documentsPreviewCloseBtn.addEventListener("click", closeDocumentsPreviewModal);
  }

  if (ui.documentsPreviewModalClose) {
    ui.documentsPreviewModalClose.addEventListener("click", closeDocumentsPreviewModal);
  }

  // Drag & drop
  if (ui.documentsUploadZone) {
    ["dragenter", "dragover", "dragleave", "drop"].forEach((eventName) => {
      ui.documentsUploadZone.addEventListener(eventName, preventDefaults, false);
    });

    function preventDefaults(e) {
      e.preventDefault();
      e.stopPropagation();
    }

    ui.documentsUploadZone.addEventListener("dragover", () => {
      ui.documentsUploadZone.classList.add("dragover");
    });

    ui.documentsUploadZone.addEventListener("dragleave", () => {
      ui.documentsUploadZone.classList.remove("dragover");
    });

    ui.documentsUploadZone.addEventListener("drop", (e) => {
      ui.documentsUploadZone.classList.remove("dragover");
      uploadDocumentsFiles(e.dataTransfer.files);
    });
  }
}

function startDocumentsRealtime() {
  const db = firebase.firestore();
  const foldersRef = db.collection("documentsFolders").where("schoolYear", "==", state.activeSchoolYearId);

  state.documentsFoldersSnapshot = foldersRef.onSnapshot({
    next: (snapshot) => {
      state.documentsFolders = snapshot.docs.map((doc) => ({
        id: doc.id,
        ...doc.data(),
      })).sort((a, b) => String(a.name || "").localeCompare(String(b.name || ""), "fr"));

      state.documentsLoaded = true;
      renderDocumentsFolders();

      // Démarrer les écoutes pour les fichiers de chaque dossier
      state.documentsFolders.forEach((folder) => {
        startDocumentsFilesRealtime(folder.id);
      });
    },
    error: (err) => console.error("Erreur chargement dossiers:", err),
  });
}

function stopDocumentsRealtime() {
  if (state.documentsFoldersSnapshot) {
    state.documentsFoldersSnapshot();
    state.documentsFoldersSnapshot = null;
  }

  state.documentsFilesSnapshots.forEach((unsubscribe) => unsubscribe());
  state.documentsFilesSnapshots.clear();
}

function startDocumentsFilesRealtime(folderId) {
  const db = firebase.firestore();
  const filesRef = db.collection("documentsFolders").doc(folderId).collection("files").orderBy("uploadedAt", "desc");

  // Arrêter l'ancienne écoute si elle existe
  if (state.documentsFilesSnapshots.has(folderId)) {
    state.documentsFilesSnapshots.get(folderId)();
  }

  const unsubscribe = filesRef.onSnapshot({
    next: (snapshot) => {
      const files = snapshot.docs.map((doc) => ({
        id: doc.id,
        ...doc.data(),
      }));
      state.documentsFiles.set(folderId, files);

      // Mettre à jour le rendu si ce dossier est sélectionné
      if (state.documentsSelectedFolderId === folderId) {
        renderDocumentsFiles();
      }
    },
    error: (err) => console.error("Erreur chargement fichiers:", err),
  });

  state.documentsFilesSnapshots.set(folderId, unsubscribe);
}

async function createDocumentsFolder() {
  const rights = getCurrentUserRights();
  if (rights.documents === "NONE") {
    showToast("Vous n'avez pas les droits pour créer des dossiers", "error");
    return;
  }

  if (!ui.documentsNewFolderName) return;

  const name = ui.documentsNewFolderName.value.trim();
  if (!name) {
    showToast("Veuillez entrer un nom de dossier", "error");
    return;
  }

  const db = firebase.firestore();

  try {
    await db.collection("documentsFolders").add({
      name,
      schoolYear: state.activeSchoolYearId,
      createdBy: state.currentUser?.uid,
      createdAt: new Date(),
    });

    ui.documentsNewFolderName.value = "";
    showToast("Dossier créé ✓", "success");
    logActivity("Dossier créé", { folderName: name });
  } catch (err) {
    console.error("Erreur création dossier:", err);
    showToast("Erreur lors de la création du dossier", "error");
  }
}

function selectDocumentsFolder(folderId) {
  state.documentsSelectedFolderId = folderId;
  const folder = state.documentsFolders.find((f) => f.id === folderId);

  if (ui.documentsCurrentFolderName) {
    ui.documentsCurrentFolderName.textContent = folder?.name || "Dossier";
  }

  if (ui.documentsUploadZone) {
    ui.documentsUploadZone.style.display = "block";
  }

  if (ui.documentsDeleteFolderBtn && ui.documentsRenameFolderBtn) {
    const canEdit = getCurrentUserRights().documents !== "NONE";
    ui.documentsDeleteFolderBtn.style.display = canEdit ? "block" : "none";
    ui.documentsRenameFolderBtn.style.display = canEdit ? "block" : "none";
  }

  renderDocumentsFiles();
}

function renderDocumentsFolders() {
  if (!ui.documentsFoldersList) return;

  const html = state.documentsFolders
    .map((folder) => `
      <div class="documents-folder-item ${state.documentsSelectedFolderId === folder.id ? "active" : ""}" onclick="selectDocumentsFolder('${folder.id}')">
        <span class="material-symbols-outlined">folder</span>
        <span style="flex: 1;">${escapeHtml(folder.name)}</span>
        <span style="font-size: 0.75rem; color: var(--muted);">${(state.documentsFiles.get(folder.id) || []).length}</span>
      </div>
    `)
    .join("");

  ui.documentsFoldersList.innerHTML = html || '<p style="text-align: center; color: var(--muted); padding: 1rem;">Aucun dossier</p>';
}

function renderDocumentsFiles() {
  if (!ui.documentsFilesList || !state.documentsSelectedFolderId) return;

  const files = state.documentsFiles.get(state.documentsSelectedFolderId) || [];

  const html = files
    .map((file) => {
      const icon = getDocumentFileIcon(file.name);
      const size = formatFileSize(file.size || 0);
      return `
        <div class="documents-file-item">
          <span class="documents-file-icon">${icon}</span>
          <p class="documents-file-name" title="${escapeHtml(file.name)}">${escapeHtml(file.name)}</p>
          <p class="documents-file-size">${size}</p>
          <div class="documents-file-actions">
            <button class="secondary-btn" onclick="previewDocumentsFile('${state.documentsSelectedFolderId}', '${file.id}', '${escapeHtml(file.name)}')">Aperçu</button>
            <a class="secondary-btn" href="${file.downloadUrl}" download="${file.name}" style="text-decoration: none; text-align: center;">↓</a>
          </div>
        </div>
      `;
    })
    .join("");

  ui.documentsFilesList.innerHTML = html || '<p style="text-align: center; color: var(--muted); padding: 2rem;">Aucun fichier</p>';
}

function getDocumentFileIcon(filename) {
  const ext = filename.split(".").pop().toLowerCase();
  const icons = {
    pdf: "📄",
    doc: "📝", docx: "📝", txt: "📝",
    xls: "📊", xlsx: "📊", csv: "📊",
    jpg: "🖼️", jpeg: "🖼️", png: "🖼️", gif: "🖼️", webp: "🖼️",
    mp4: "🎬", avi: "🎬", mov: "🎬", mkv: "🎬",
    mp3: "🎵", wav: "🎵", m4a: "🎵",
    zip: "📦", rar: "📦", "7z": "📦",
  };
  return icons[ext] || "📎";
}

function formatFileSize(bytes) {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return Math.round((bytes / Math.pow(k, i)) * 100) / 100 + " " + sizes[i];
}

async function uploadDocumentsFiles(files) {
  const rights = getCurrentUserRights();
  if (rights.documents === "NONE") {
    showToast("Vous n'avez pas les droits pour uploader des fichiers", "error");
    return;
  }

  if (!state.documentsSelectedFolderId) {
    showToast("Sélectionnez d'abord un dossier", "error");
    return;
  }

  if (!files || files.length === 0) return;

  const db = firebase.firestore();
  const storage = firebase.storage();

  for (const file of files) {
    try {
      showToast(`Upload en cours: ${file.name}...`, "info");

      const filePath = `documents/${state.activeSchoolYearId}/${state.documentsSelectedFolderId}/${Date.now()}_${file.name}`;
      const fileRef = storage.ref(filePath);

      const snapshot = await fileRef.put(file);
      const downloadUrl = await fileRef.getDownloadURL();

      await db
        .collection("documentsFolders")
        .doc(state.documentsSelectedFolderId)
        .collection("files")
        .add({
          name: file.name,
          size: file.size,
          type: file.type,
          downloadUrl,
          filePath,
          uploadedBy: state.currentUser?.uid,
          uploadedAt: new Date(),
        });

      showToast(`${file.name} uploadé ✓`, "success");
      logActivity("Fichier uploadé", { fileName: file.name, folderId: state.documentsSelectedFolderId });
    } catch (err) {
      console.error("Erreur upload:", err);
      showToast(`Erreur upload: ${file.name}`, "error");
    }
  }

  if (ui.documentsFileInput) {
    ui.documentsFileInput.value = "";
  }
}

async function deleteDocumentsFile(folderId, fileId, filePath) {
  if (!confirm("Êtes-vous sûr de vouloir supprimer ce fichier ?")) return;

  const db = firebase.firestore();
  const storage = firebase.storage();

  try {
    await storage.ref(filePath).delete();
    await db.collection("documentsFolders").doc(folderId).collection("files").doc(fileId).delete();
    showToast("Fichier supprimé ✓", "success");
    logActivity("Fichier supprimé", { folderId });
  } catch (err) {
    console.error("Erreur suppression:", err);
    showToast("Erreur lors de la suppression", "error");
  }
}

async function previewDocumentsFile(folderId, fileId, fileName) {
  const files = state.documentsFiles.get(folderId) || [];
  const file = files.find((f) => f.id === fileId);
  if (!file) return;

  if (!ui.documentsPreviewContent || !ui.documentsPreviewTitle || !ui.documentsPreviewModal) return;

  ui.documentsPreviewTitle.textContent = fileName;
  ui.documentsPreviewDownloadBtn.href = file.downloadUrl;
  ui.documentsPreviewDownloadBtn.download = fileName;

  const ext = fileName.split(".").pop().toLowerCase();

  let previewHtml = "";

  if (["jpg", "jpeg", "png", "gif", "webp"].includes(ext)) {
    previewHtml = `<img src="${file.downloadUrl}" style="max-width: 100%; max-height: 100%; border-radius: 6px;" alt="${escapeHtml(fileName)}" />`;
  } else if (ext === "pdf") {
    previewHtml = `<embed src="${file.downloadUrl}" type="application/pdf" style="width: 100%; height: 100%;" />`;
  } else if (["mp4", "avi", "mov", "mkv", "webm"].includes(ext)) {
    previewHtml = `<video controls style="max-width: 100%; max-height: 100%; border-radius: 6px;"><source src="${file.downloadUrl}" /></video>`;
  } else if (["mp3", "wav", "m4a", "ogg"].includes(ext)) {
    previewHtml = `<audio controls style="width: 100%;"><source src="${file.downloadUrl}" /></audio>`;
  } else {
    previewHtml = `<p style="text-align: center; color: var(--muted);">Aperçu non disponible pour ce type de fichier<br><a href="${file.downloadUrl}" download="${fileName}" style="color: var(--primary); text-decoration: underline;">Télécharger le fichier</a></p>`;
  }

  ui.documentsPreviewContent.innerHTML = previewHtml;
  ui.documentsPreviewModal.classList.remove("hidden");
}

function closeDocumentsPreviewModal() {
  if (ui.documentsPreviewModal) ui.documentsPreviewModal.classList.add("hidden");
}

function openRenameDocumentsFolderModal() {
  if (!state.documentsSelectedFolderId) return;

  const folder = state.documentsFolders.find((f) => f.id === state.documentsSelectedFolderId);
  if (!folder || !ui.documentsRenameFolderInput) return;

  ui.documentsRenameFolderInput.value = folder.name;

  if (ui.documentsRenameFolderModal) ui.documentsRenameFolderModal.classList.remove("hidden");
}

function closeRenameDocumentsFolderModal() {
  if (ui.documentsRenameFolderModal) ui.documentsRenameFolderModal.classList.add("hidden");
}

async function saveRenameDocumentsFolder() {
  if (!state.documentsSelectedFolderId || !ui.documentsRenameFolderInput) return;

  const newName = ui.documentsRenameFolderInput.value.trim();
  if (!newName) {
    showToast("Veuillez entrer un nom", "error");
    return;
  }

  const db = firebase.firestore();

  try {
    await db.collection("documentsFolders").doc(state.documentsSelectedFolderId).update({
      name: newName,
    });

    showToast("Dossier renommé ✓", "success");
    logActivity("Dossier renommé", { folderId: state.documentsSelectedFolderId });
    closeRenameDocumentsFolderModal();
  } catch (err) {
    console.error("Erreur renommage:", err);
    showToast("Erreur lors du renommage", "error");
  }
}

async function deleteDocumentsFolder() {
  if (!state.documentsSelectedFolderId) return;

  if (!confirm("Êtes-vous sûr ? Les fichiers seront supprimés aussi.")) return;

  const db = firebase.firestore();
  const storage = firebase.storage();

  try {
    // Supprimer les fichiers du stockage
    const files = state.documentsFiles.get(state.documentsSelectedFolderId) || [];
    for (const file of files) {
      try {
        await storage.ref(file.filePath).delete();
      } catch (e) {
        console.warn("Fichier pas trouvé dans Storage:", file.filePath);
      }
    }

    // Supprimer la collection des fichiers
    const filesRef = db.collection("documentsFolders").doc(state.documentsSelectedFolderId).collection("files");
    const filesDocs = await filesRef.get();
    for (const doc of filesDocs.docs) {
      await doc.ref.delete();
    }

    // Supprimer le dossier
    await db.collection("documentsFolders").doc(state.documentsSelectedFolderId).delete();

    state.documentsSelectedFolderId = null;
    showToast("Dossier supprimé ✓", "success");
    logActivity("Dossier supprimé", {});
  } catch (err) {
    console.error("Erreur suppression dossier:", err);
    showToast("Erreur lors de la suppression", "error");
  }
}

window.selectDocumentsFolder = selectDocumentsFolder;
window.previewDocumentsFile = previewDocumentsFile;

// ==================== NOTIFICATION PREFERENCES ====================

function setupNotificationPreferences() {
  if (ui.notificationPreferencesClose) {
    ui.notificationPreferencesClose.addEventListener("click", closeNotificationPreferencesModal);
  }

  if (ui.notificationSaveBtn) {
    ui.notificationSaveBtn.addEventListener("click", saveNotificationPreferences);
  }

  if (ui.notificationTestEmailBtn) {
    ui.notificationTestEmailBtn.addEventListener("click", sendTestEmail);
  }

  if (ui.notificationPreferencesBtn) {
    ui.notificationPreferencesBtn.addEventListener("click", openNotificationPreferencesModal);
  }

  // Charger les préférences au démarrage
  loadNotificationPreferences();
}

async function loadNotificationPreferences() {
  if (!state.currentUser) return;

  try {
    const prefs = await getDoc(
      doc(db, "users", state.currentUser.uid, "settings", "notificationPreferences")
    );

    if (prefs.exists) {
      state.notificationPreferences = { ...state.notificationPreferences, ...prefs.data() };
    }

    // Mettre à jour l'UI
    if (ui.notifTaskAssigned) ui.notifTaskAssigned.checked = state.notificationPreferences.taskAssigned;
    if (ui.notifTaskStatusChange) ui.notifTaskStatusChange.checked = state.notificationPreferences.taskStatusChange;
    if (ui.notifComments) ui.notifComments.checked = state.notificationPreferences.commentNotifications;
    if (ui.notifDeadlineReminder) ui.notifDeadlineReminder.checked = state.notificationPreferences.deadlineReminders;
    if (ui.notifReplacements) ui.notifReplacements.checked = state.notificationPreferences.replacementNotifications;
    if (ui.userEmailDisplay) ui.userEmailDisplay.textContent = state.currentUser.email;
  } catch (error) {
    console.error("Erreur chargement préférences:", error);
  }
}

async function saveNotificationPreferences() {
  if (!state.currentUser) return;

  try {
    const prefs = {
      taskAssigned: ui.notifTaskAssigned?.checked || false,
      taskStatusChange: ui.notifTaskStatusChange?.checked || false,
      commentNotifications: ui.notifComments?.checked || false,
      deadlineReminders: ui.notifDeadlineReminder?.checked || false,
      replacementNotifications: ui.notifReplacements?.checked || false,
      updatedAt: serverTimestamp(),
    };

    await setDoc(
      doc(db, "users", state.currentUser.uid, "settings", "notificationPreferences"),
      prefs,
      { merge: true }
    );

    state.notificationPreferences = prefs;
    showToast("Préférences sauvegardées ✓", "success");
    closeNotificationPreferencesModal();
  } catch (error) {
    console.error("Erreur sauvegarde préférences:", error);
    showToast("Erreur lors de la sauvegarde", "error");
  }
}

async function sendTestEmail() {
  if (!state.currentUser) return;
  if (!state.currentUserTeacherId) {
    showToast("Profil prof non trouvé", "error");
    return;
  }

  try {
    showToast("Envoi d'un email de test...", "info");

    const response = await callCloudFunction("sendTestEmail", {
      teacherId: state.currentUserTeacherId
    });

    if (response.success) {
      showToast("✅ Email de test envoyé ! Vérifiez votre boîte mail.", "success");
    }
  } catch (error) {
    console.error("Erreur envoi email de test:", error);
    showToast("Erreur lors de l'envoi de l'email de test", "error");
  }
}

async function openNotificationPreferencesModal() {
  if (ui.notificationPreferencesModal) {
    ui.notificationPreferencesModal.classList.remove("hidden");

    // Charger et afficher l'email du prof
    if (state.currentUserTeacherId) {
      try {
        const teacherDoc = await db.collection("teachers").doc(state.currentUserTeacherId).get();
        if (teacherDoc.exists) {
          const teacher = teacherDoc.data();
          if (ui.userEmailDisplay) {
            ui.userEmailDisplay.textContent = teacher.email || "Email non configuré";
          }
        }
      } catch (error) {
        console.error("Erreur chargement email prof:", error);
        if (ui.userEmailDisplay) {
          ui.userEmailDisplay.textContent = "Erreur chargement email";
        }
      }
    }
  }
}

function closeNotificationPreferencesModal() {
  if (ui.notificationPreferencesModal) {
    ui.notificationPreferencesModal.classList.add("hidden");
  }
}

/**
 * Appeler une Cloud Function
 */
async function callCloudFunction(functionName, data) {
  const functions = firebase.functions();
  const callable = functions.httpsCallable(functionName);

  try {
    const result = await callable(data);
    return result.data;
  } catch (error) {
    console.error(`Erreur Cloud Function ${functionName}:`, error);
    throw error;
  }
}

window.openNotificationPreferencesModal = openNotificationPreferencesModal;

/**
 * Templates d'email par défaut
 */
const DEFAULT_EMAIL_TEMPLATES = {
  taskAssigned: {
    name: "Nouvelle tâche assignée",
    subject: "🎯 Nouvelle tâche : ${title}",
    html: `<html><body style="font-family: Arial, sans-serif; color: #333;">
      <div style="max-width: 600px; margin: 0 auto; padding: 20px;">
        <div style="background: #002b5b; color: white; padding: 20px; border-radius: 8px 8px 0 0;">
          <h1>📋 Nouvelle tâche assignée</h1>
        </div>
        <div style="background: #f8f9fa; padding: 20px; border: 1px solid #ddd;">
          <p>Bonjour \${name},</p>
          <p>Une nouvelle tâche vous a été assignée :</p>
          <div style="background: white; padding: 15px; border-left: 4px solid #002b5b; margin: 15px 0;">
            <p style="margin: 0 0 10px 0;"><strong>\${title}</strong></p>
            <p style="color: #666; margin: 0;">Consultez les détails dans l'application.</p>
          </div>
        </div>
      </div>
    </body></html>`
  },
  taskStatusChange: {
    name: "Changement de statut",
    subject: "📊 Mise à jour tâche : ${title}",
    html: `<html><body style="font-family: Arial, sans-serif; color: #333;">
      <div style="max-width: 600px; margin: 0 auto; padding: 20px;">
        <div style="background: #002b5b; color: white; padding: 20px; border-radius: 8px 8px 0 0;">
          <h1>📊 Mise à jour de tâche</h1>
        </div>
        <div style="background: #f8f9fa; padding: 20px;">
          <p>La tâche <strong>\${title}</strong> a changé de statut.</p>
          <p>Nouveau statut : <strong>\${status}</strong></p>
        </div>
      </div>
    </body></html>`
  },
  commentNotification: {
    name: "Nouveau commentaire",
    subject: "💬 Nouveau commentaire sur ${title}",
    html: `<html><body style="font-family: Arial, sans-serif; color: #333;">
      <div style="max-width: 600px; margin: 0 auto; padding: 20px;">
        <div style="background: #002b5b; color: white; padding: 20px; border-radius: 8px 8px 0 0;">
          <h1>💬 Nouveau commentaire</h1>
        </div>
        <div style="background: #f8f9fa; padding: 20px;">
          <p>Quelqu'un a commenté la tâche <strong>\${title}</strong>.</p>
          <p>Consultez le commentaire dans l'application.</p>
        </div>
      </div>
    </body></html>`
  },
  replacementNotification: {
    name: "Opportunité de remplacement",
    subject: "🎯 Opportunité de remplacement : ${date}",
    html: `<html><body style="font-family: Arial, sans-serif; color: #333;">
      <div style="max-width: 600px; margin: 0 auto; padding: 20px;">
        <div style="background: #28a745; color: white; padding: 20px; border-radius: 8px 8px 0 0;">
          <h1>🎯 Opportunité de remplacement</h1>
        </div>
        <div style="background: #f8f9fa; padding: 20px;">
          <p>Bonjour \${name},</p>
          <p>Une opportunité de remplacement vous a été proposée :</p>
          <p><strong>Date :</strong> \${date}</p>
          <p>Consultez les détails dans l'application.</p>
        </div>
      </div>
    </body></html>`
  },
  edtInvitation: {
    name: "Invitation à consulter l'EDT",
    subject: "📅 Votre emploi du temps ${schoolYear} est disponible",
    html: `<html><body style="font-family: Arial, sans-serif; color: #333;">
      <div style="max-width: 600px; margin: 0 auto; padding: 20px;">
        <div style="background: #002b5b; color: white; padding: 20px; border-radius: 8px 8px 0 0;">
          <h1>📅 Votre emploi du temps est prêt</h1>
        </div>
        <div style="background: #f8f9fa; padding: 20px;">
          <p>Bonjour \${name},</p>
          <p>L'emploi du temps pour l'année scolaire <strong>\${schoolYear}</strong> a été finalisé.</p>
          <p>Consultez le planning complet en cliquant sur le lien ci-dessous.</p>
        </div>
      </div>
    </body></html>`
  }
};

function setupEmailTemplates() {
  if (!ui.emailTemplateSelect) return;

  // Event listener pour le changement de template
  ui.emailTemplateSelect.onchange = () => {
    loadEmailTemplate();
  };

  if (ui.emailTemplateSaveBtn) {
    ui.emailTemplateSaveBtn.onclick = saveEmailTemplate;
  }
  if (ui.emailTemplateResetBtn) {
    ui.emailTemplateResetBtn.onclick = resetEmailTemplate;
  }
  if (ui.emailTemplateCode) {
    ui.emailTemplateCode.oninput = updateEmailTemplatePreview;
  }
  if (ui.adminTabEmailTemplatesBtn) {
    ui.adminTabEmailTemplatesBtn.onclick = () => {
      setMode("admin");
      state.adminMode = "emailTemplates";
      render();
      loadEmailTemplate();
    };
  }

  loadEmailTemplate();
}

async function loadEmailTemplate() {
  const templateId = ui.emailTemplateSelect?.value || "taskAssigned";
  console.log("Chargement du template:", templateId);

  try {
    // D'abord, utiliser le template par défaut
    let html = DEFAULT_EMAIL_TEMPLATES[templateId]?.html || "";

    // Essayer de charger depuis Firestore
    try {
      const docRef = doc(db, "settings", "emailTemplates", "templates", templateId);
      const docSnap = await getDoc(docRef);

      if (docSnap && docSnap.exists && docSnap.data().html) {
        html = docSnap.data().html;
        console.log("Template personnalisé trouvé");
      }
    } catch (dbError) {
      console.log("Pas de template personnalisé, utilisation du défaut");
    }

    if (ui.emailTemplateCode) {
      ui.emailTemplateCode.value = html;
      updateEmailTemplatePreview();
    }
  } catch (error) {
    console.error("Erreur chargement template:", error);
    if (ui.emailTemplateCode) {
      ui.emailTemplateCode.value = DEFAULT_EMAIL_TEMPLATES[templateId]?.html || "";
      updateEmailTemplatePreview();
    }
  }
}

function updateEmailTemplatePreview() {
  const code = ui.emailTemplateCode.value;
  if (ui.emailTemplatePreview) {
    ui.emailTemplatePreview.innerHTML = code
      .replace(/\$\{name\}/g, "Jean Dupont")
      .replace(/\$\{title\}/g, "Titre de l'exemple")
      .replace(/\$\{schoolYear\}/g, getActiveSchoolYearId())
      .replace(/\$\{date\}/g, new Date().toLocaleDateString("fr-FR"))
      .replace(/\$\{status\}/g, "En cours");
  }
}

async function saveEmailTemplate() {
  const templateId = ui.emailTemplateSelect?.value || "taskAssigned";
  const html = ui.emailTemplateCode.value;

  if (!html.trim()) {
    showToast("Le code du template ne peut pas être vide", "error");
    return;
  }

  try {
    showToast("Sauvegarde du template...", "info");

    const docRef = doc(db, "settings", "emailTemplates", "templates", templateId);
    await setDoc(docRef, {
      id: templateId,
      name: DEFAULT_EMAIL_TEMPLATES[templateId]?.name,
      html,
      updatedAt: serverTimestamp()
    }, { merge: true });

    showToast("✅ Template sauvegardé !", "success");
  } catch (error) {
    console.error("Erreur sauvegarde template:", error);
    showToast("Erreur lors de la sauvegarde", "error");
  }
}

function resetEmailTemplate() {
  const templateId = ui.emailTemplateSelect?.value || "taskAssigned";
  const defaultHtml = DEFAULT_EMAIL_TEMPLATES[templateId]?.html || "";

  if (confirm("Êtes-vous sûr de vouloir réinitialiser ce template ?")) {
    ui.emailTemplateCode.value = defaultHtml;
    updateEmailTemplatePreview();
    showToast("Template réinitialisé", "info");
  }
}

/**
 * Analyser la qualité de l'affectation (vérifications)
 */
function analyzeAssignmentQuality() {
  const analysis = {
    byTeacher: new Map(),
    classesPerTeacher: new Map(),
    unassignedClasses: [],
    doubleAssignedClasses: [],
    sixiemeWithoutSwim: [],
    allErrors: [],
    allWarnings: [],
  };

  // Compter les profs par classe
  const teachersByClass = new Map();
  for (const session of state.sessions) {
    if (!session.classId || session.classId.startsWith('__')) continue; // Ignorer AS/spéciaux

    const cls = state.classes.find(c => c.id === session.classId);
    if (!cls) continue;

    if (!teachersByClass.has(session.classId)) {
      teachersByClass.set(session.classId, []);
    }
    const teachers = teachersByClass.get(session.classId);
    if (!teachers.includes(session.teacherId)) {
      teachers.push(session.teacherId);
    }
  }

  // Analyser les classes : non affectées ou double affectées
  for (const cls of state.classes) {
    const teacherCount = teachersByClass.get(cls.id)?.length || 0;
    if (teacherCount === 0) {
      analysis.unassignedClasses.push(cls);
      analysis.allErrors.push(`❌ ${getClassLabelById(cls.id)} : non affectée`);
    } else if (teacherCount > 1) {
      analysis.doubleAssignedClasses.push({ cls, teachers: teachersByClass.get(cls.id) });
      const teacherNames = teachersByClass.get(cls.id).map(tid => state.teachers.find(t => t.id === tid)?.name || tid).join(', ');
      analysis.allErrors.push(`❌ ${getClassLabelById(cls.id)} : affectée à ${teacherCount} profs (${teacherNames})`);
    }
  }

  // Analyser par prof
  for (const teacher of state.teachers) {
    const allTeacherSessions = state.sessions.filter(s => s.teacherId === teacher.id);
    const teacherSessions = allTeacherSessions.filter(s => !s.classId?.startsWith('__'));
    const asSessions = allTeacherSessions.filter(s => s.classId?.startsWith('__'));

    const classes = new Map();
    let totalHours = 0;
    let asHours = 0;

    for (const session of teacherSessions) {
      const cls = state.classes.find(c => c.id === session.classId);
      if (!cls) continue;

      if (!classes.has(session.classId)) {
        classes.set(session.classId, {
          cls,
          sessions: [],
          hours: 0
        });
      }

      const entry = classes.get(session.classId);
      entry.sessions.push(session);
    }

    // Calculer les heures totales basées sur les sessions placées dans l'EDT
    for (const [classId, entry] of classes) {
      const cls = entry.cls;
      // Compter selon le niveau : 6ème=4h, 5/4/3=3h, 2/1/T=2h
      const weeklyHours = LEVEL_RULES[cls.level]?.weeklyHours || 0;
      entry.hours = weeklyHours;
      totalHours += weeklyHours;
    }

    // Ajouter les heures AS (1h par créneau placé)
    asHours = asSessions.length;
    totalHours += asHours;

    // Ajouter les heures COORD et PROJET
    const teacherQuotas = teacher.assignedLevelQuotas || {};
    const projectHours = teacherQuotas.PROJET || 0;
    const coordHours = teacherQuotas.COORD || 0;
    totalHours += projectHours + coordHours;

    if (classes.size > 0 || asHours > 0 || projectHours > 0 || coordHours > 0) {
      analysis.byTeacher.set(teacher.id, {
        teacher,
        classes: Array.from(classes.values()),
        totalHours,
        asHours,
        projectHours,
        coordHours
      });
      analysis.classesPerTeacher.set(teacher.id, classes.size);

      // Vérifier si le prof dépasse son service
      const maxHours = Number(teacher.maxHours || 0);
      if (maxHours > 0 && totalHours > maxHours) {
        const excess = totalHours - maxHours;
        analysis.allWarnings.push(
          `⚠️ ${teacher.name} : dépassement de service (${formatHours(totalHours)}h assigné pour ${formatHours(maxHours)}h max, +${formatHours(excess)}h)`
        );
      }
    }
  }

  // Vérifier 6ème piscine
  const sixiemeClasses = state.classes.filter(c => c.level === "Sixième");
  for (const cls of sixiemeClasses) {
    const hasSwimSession = state.sessions.some(s =>
      s.classId === cls.id &&
      (s.activityLabel?.toLowerCase().includes('natation') ||
       s.activityLabel?.toLowerCase().includes('piscine') ||
       s.activityLabel?.toLowerCase().includes('nager'))
    );

    if (!hasSwimSession) {
      analysis.sixiemeWithoutSwim.push(cls);
      analysis.allWarnings.push(`⚠️ ${getClassLabelById(cls.id)} : pas de créneau piscine`);
    }
  }

  return analysis;
}

/**
 * Ouvrir/afficher le modal de vérification
 */
function openAssignmentVerificationModal() {
  const analysis = analyzeAssignmentQuality();

  let html = `
    <div style="display: flex; gap: 1rem; margin-bottom: 1rem; flex-wrap: wrap;">
      <button id="assignmentVerificationCloseBtn" class="secondary-btn" type="button">✕ Fermer</button>
      <button id="assignmentVerificationExportBtn" class="secondary-btn" type="button">📥 Exporter rapport</button>
    </div>
  `;

  // Calculer le nombre de profs en surcharge
  let overloadCount = 0;
  for (const [teacherId, info] of analysis.byTeacher) {
    const maxHours = Number(info.teacher.maxHours || 0);
    if (maxHours > 0 && info.totalHours > maxHours) {
      overloadCount++;
    }
  }

  // Résumé
  html += `
    <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(250px, 1fr)); gap: 1rem; margin-bottom: 1.5rem;">
      <div class="summary-box" style="border-left: 4px solid #4caf50;">
        <strong>Profs assignés:</strong> ${analysis.byTeacher.size} / ${state.teachers.length}
      </div>
      <div class="summary-box" style="border-left: 4px solid ${analysis.unassignedClasses.length ? '#ff9800' : '#4caf50'};">
        <strong>Classes non affectées:</strong> ${analysis.unassignedClasses.length}
      </div>
      <div class="summary-box" style="border-left: 4px solid ${analysis.doubleAssignedClasses.length ? '#f44336' : '#4caf50'};">
        <strong>Classes double affectées:</strong> ${analysis.doubleAssignedClasses.length}
      </div>
      <div class="summary-box" style="border-left: 4px solid ${analysis.sixiemeWithoutSwim.length ? '#ff9800' : '#4caf50'};">
        <strong>6ème sans piscine:</strong> ${analysis.sixiemeWithoutSwim.length}
      </div>
      <div class="summary-box" style="border-left: 4px solid ${overloadCount ? '#f44336' : '#4caf50'};">
        <strong>Profs en surcharge:</strong> ${overloadCount}
      </div>
    </div>
  `;

  // Erreurs et avertissements
  if (analysis.allErrors.length > 0) {
    html += `<div style="margin-bottom: 1rem;">
      <h4 style="color: #f44336;">🚨 Erreurs (${analysis.allErrors.length})</h4>
      <ul style="color: #f44336; margin: 0.5rem 0;">
        ${analysis.allErrors.map(e => `<li>${escapeHtml(e)}</li>`).join('')}
      </ul>
    </div>`;
  }

  if (analysis.allWarnings.length > 0) {
    html += `<div style="margin-bottom: 1rem;">
      <h4 style="color: #ff9800;">⚠️ Avertissements (${analysis.allWarnings.length})</h4>
      <ul style="color: #ff9800; margin: 0.5rem 0;">
        ${analysis.allWarnings.map(w => `<li>${escapeHtml(w)}</li>`).join('')}
      </ul>
    </div>`;
  }

  if (analysis.allErrors.length === 0 && analysis.allWarnings.length === 0) {
    html += `<div class="summary-box" style="border-left: 4px solid #4caf50; color: #4caf50;">
      ✅ Aucun problème détecté !
    </div>`;
  }

  // Détail par prof
  html += `<h3>Détail par professeur</h3>`;
  html += `<div style="max-height: 500px; overflow-y: auto; border: 1px solid #ddd; border-radius: 4px;">`;

  if (analysis.byTeacher.size === 0) {
    html += `<p style="padding: 1rem; color: #999;">Aucun professeur avec des classes assignées</p>`;
  } else {
    html += `<table style="width: 100%; border-collapse: collapse;">
      <thead>
        <tr style="background: #f5f5f5; font-weight: bold;">
          <th style="border: 1px solid #ddd; padding: 0.75rem; text-align: left;">Professeur</th>
          <th style="border: 1px solid #ddd; padding: 0.75rem; text-align: center;">Classes</th>
          <th style="border: 1px solid #ddd; padding: 0.75rem; text-align: center;">Heures/sem</th>
          <th style="border: 1px solid #ddd; padding: 0.75rem; text-align: center;">Service</th>
          <th style="border: 1px solid #ddd; padding: 0.75rem; text-align: center;">Heures trou</th>
          <th style="border: 1px solid #ddd; padding: 0.75rem; text-align: center;">Desiderata</th>
        </tr>
      </thead>
      <tbody>
        ${Array.from(analysis.byTeacher.entries()).map(([teacherId, info]) => {
          const classesHtml = info.classes
            .map(c => `<span style="display: inline-block; background: #e3f2fd; padding: 0.25rem 0.5rem; border-radius: 3px; margin-right: 0.25rem; font-size: 0.85em;">${escapeHtml(c.cls.name)}</span>`)
            .join('');
          const notes = [];
          if (info.asHours) notes.push(`${info.asHours}h AS`);
          if (info.projectHours) notes.push(`${info.projectHours}h projet`);
          if (info.coordHours) notes.push(`${info.coordHours}h coord`);
          const notesHtml = notes.length ? ` <small style="color: #666;">+ ${notes.join(' + ')}</small>` : '';

          const maxHours = Number(info.teacher.maxHours || 0);
          const isOver = maxHours > 0 && info.totalHours > maxHours;
          const serviceColor = isOver ? '#f44336' : '#4caf50';
          const serviceText = maxHours > 0 ? info.totalHours + 'h / ' + maxHours + 'h' : info.totalHours + 'h';
          const bgColor = isOver ? 'background-color: #ffebee;' : '';

          // Calculer les heures de trou (créneau vides)
          const totalAvailableHours = 35; // 7 créneaux par jour * 5 jours = 35h (approximation)
          const holeHours = Math.max(0, totalAvailableHours - info.totalHours);

          // Vérifier la compatibilité avec les desiderata
          const teacherSessions = state.sessions.filter(s => s.teacherId === teacherId);
          let desiderataCompatibility = '✅';
          let desiderataColor = '#4caf50';

          // Compter les sessions sur créneaux préférés vs indisponibles
          let preferredCount = 0;
          let unavailableCount = 0;
          for (const session of teacherSessions) {
            const slot = rawSlotKey(session.dayOfWeek, session.startTime);
            const status = state.desiderataSlotStatus.get(desiderataSlotKey(teacherId, session.dayOfWeek, session.startTime));
            if (status === 'PREFERRED') preferredCount++;
            else if (status === 'UNAVAILABLE') unavailableCount++;
          }

          if (unavailableCount > 0) {
            desiderataCompatibility = '⚠️ ' + unavailableCount;
            desiderataColor = '#f44336';
          } else if (teacherSessions.length > 0 && preferredCount === 0) {
            desiderataCompatibility = '⚠️';
            desiderataColor = '#ff9800';
          }

          return '<tr style="border-bottom: 1px solid #eee; ' + bgColor + '">' +
                 '<td style="border: 1px solid #ddd; padding: 0.75rem;">' +
                 '<strong>' + escapeHtml(info.teacher.name || info.teacher.code || teacherId) + '</strong>' +
                 '</td>' +
                 '<td style="border: 1px solid #ddd; padding: 0.75rem;">' + classesHtml + notesHtml + '</td>' +
                 '<td style="border: 1px solid #ddd; padding: 0.75rem; text-align: center; font-weight: bold;">' + info.totalHours + 'h</td>' +
                 '<td style="border: 1px solid #ddd; padding: 0.75rem; text-align: center; font-weight: bold; color: ' + serviceColor + ';">' + serviceText + '</td>' +
                 '<td style="border: 1px solid #ddd; padding: 0.75rem; text-align: center;">' + holeHours + 'h</td>' +
                 '<td style="border: 1px solid #ddd; padding: 0.75rem; text-align: center; font-weight: bold; color: ' + desiderataColor + ';">' + desiderataCompatibility + '</td>' +
                 '</tr>';
        }).join('')}
      </tbody>
    </table>`;
  }

  html += `</div>`;

  // Afficher dans un modal
  if (!ui.assignmentVerificationModal) {
    // Créer le modal s'il n'existe pas
    const modalEl = document.createElement('div');
    modalEl.id = 'assignmentVerificationModal';
    modalEl.className = 'modal-overlay hidden';
    modalEl.innerHTML = `
      <div class="modal-card" style="max-width: 1000px; max-height: 90vh;">
        <div class="modal-header">
          <h3>🔍 Vérification Affectation</h3>
          <button id="assignmentVerificationHeaderCloseBtn" class="close-btn">&times;</button>
        </div>
        <div class="modal-body" style="max-height: calc(90vh - 80px); overflow-y: auto;">
          <div id="assignmentVerificationContent"></div>
        </div>
      </div>
    `;
    document.body.appendChild(modalEl);
    ui.assignmentVerificationModal = modalEl;
    ui.assignmentVerificationContent = modalEl.querySelector('#assignmentVerificationContent');
  }

  ui.assignmentVerificationContent.innerHTML = html;
  ui.assignmentVerificationModal.classList.remove('hidden');

  // Sauvegarder l'analysis dans le state pour export
  state.lastAssignmentAnalysis = analysis;

  // Ajouter les event listeners
  const closeBtn = ui.assignmentVerificationContent.querySelector('#assignmentVerificationCloseBtn');
  const exportBtn = ui.assignmentVerificationContent.querySelector('#assignmentVerificationExportBtn');
  const headerCloseBtn = ui.assignmentVerificationModal.querySelector('#assignmentVerificationHeaderCloseBtn');

  if (closeBtn) {
    closeBtn.addEventListener('click', closeAssignmentVerificationModal);
  }

  if (exportBtn) {
    exportBtn.addEventListener('click', exportAssignmentQualityReport);
  }

  if (headerCloseBtn) {
    headerCloseBtn.addEventListener('click', closeAssignmentVerificationModal);
  }
}

function closeAssignmentVerificationModal() {
  if (ui.assignmentVerificationModal) {
    ui.assignmentVerificationModal.classList.add('hidden');
  }
}

function exportAssignmentQualityReport() {
  const analysis = state.lastAssignmentAnalysis;
  if (!analysis) return;

  let csv = 'Professeur,Classes Affectées,Total Heures\n';

  for (const [teacherId, info] of analysis.byTeacher) {
    const classNames = info.classes.map(c => c.cls.name).join('; ');
    csv += `"${info.teacher.name || info.teacher.code || teacherId}","${classNames}",${info.totalHours}\n`;
  }

  csv += '\n\nProblèmes Détectés\n';
  csv += 'Type,Détail\n';

  for (const error of analysis.allErrors) {
    csv += `"Erreur","${error.replace(/[❌❌]/g, '')}"\n`;
  }

  for (const warning of analysis.allWarnings) {
    csv += `"Avertissement","${warning.replace(/[⚠️]/g, '')}"\n`;
  }

  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `verif-affectation-${new Date().toISOString().split('T')[0]}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

/**
 * Incrémenter le quota de répartition quand une session est affectée à un prof
 */
async function incrementTeacherLevelQuota(teacherId, classId) {
  if (!teacherId || !classId) return;

  // Pas d'incrément pour AS, Danse et autres spéciaux
  const cls = state.classes.find(c => c.id === classId);
  if (!cls || !cls.level) return;

  const teacher = state.teachers.find(t => t.id === teacherId);
  if (!teacher) return;

  try {
    const quotas = teacher.assignedLevelQuotas || {};
    const currentQuota = quotas[cls.level] || 0;
    const updatedQuotas = { ...quotas, [cls.level]: currentQuota + 1 };

    await updateDoc(doc(db, "teachers", teacherId), {
      assignedLevelQuotas: updatedQuotas
    });
  } catch (error) {
    console.error("Erreur incrément quota:", error);
  }
}

/**
 * Décrémenter le quota de répartition quand une session est supprimée
 */
async function decrementTeacherLevelQuota(teacherId, classId) {
  if (!teacherId || !classId) return;

  // Pas de décrément pour AS, Danse et autres spéciaux
  const cls = state.classes.find(c => c.id === classId);
  if (!cls || !cls.level) return;

  const teacher = state.teachers.find(t => t.id === teacherId);
  if (!teacher) return;

  try {
    const quotas = teacher.assignedLevelQuotas || {};
    const currentQuota = quotas[cls.level] || 0;
    const newQuota = Math.max(0, currentQuota - 1);
    const updatedQuotas = { ...quotas, [cls.level]: newQuota };

    await updateDoc(doc(db, "teachers", teacherId), {
      assignedLevelQuotas: updatedQuotas
    });
  } catch (error) {
    console.error("Erreur décrément quota:", error);
  }
}

/**
 * Ouvrir la popup Répartition
 */
function openRepartitionPopup() {
  if (!ui.repartitionPopupModal || !ui.repartitionPopupContent) return;

  // Charger le contenu de la répartition
  renderRepartitionContent();

  // Afficher la modal
  ui.repartitionPopupModal.classList.remove("hidden");
}

/**
 * Fermer la popup Répartition
 */
function closeRepartitionPopup() {
  if (!ui.repartitionPopupModal) return;
  ui.repartitionPopupModal.classList.add("hidden");
}

/**
 * Afficher le contenu de la répartition dans la popup
 */
function renderRepartitionContent() {
  if (!ui.repartitionPopupContent) return;

  const teachers = state.teachers;

  // Colonnes de répartition
  const quotaKeys = ["Sixième", "Cinquième", "Quatrième", "Troisième", "Seconde", "Première", "Terminale", "AS", "DANSE", "COORD"];

  // Créer les lignes du tableau
  const rows = teachers.map(t => {
    let total = 0;
    const quotas = t.assignedLevelQuotas || {};

    const cells = quotaKeys.map(key => {
      const value = quotas[key] || 0;
      // Multiplier par les heures par classe du niveau (AS/DANSE/COORD = 1h par défaut)
      const weeklyHours = LEVEL_RULES[key]?.weeklyHours || 1;
      total += value * weeklyHours;
      const isEmpty = value === 0 ? "empty" : "";
      return `
        <td class="repartition-cell">
          <div class="repartition-controls">
            <button class="repartition-btn minus" data-teacher-id="${t.id}" data-quota-key="${key}" data-delta="-1" type="button">-</button>
            <span class="repartition-value ${isEmpty}">${value}</span>
            <button class="repartition-btn plus" data-teacher-id="${t.id}" data-quota-key="${key}" data-delta="1" type="button">+</button>
          </div>
        </td>
      `;
    }).join('');

    const projetHours = quotas.PROJET || 0;
    total += projetHours;

    return `
      <tr>
        <td class="sticky-col">
          <span class="teacher-color-dot" style="background:${escapeHtml(getTeacherColor(t))}"></span>
          <span class="repartition-teacher-id">
            <strong>${escapeHtml(t.name)}</strong>
            <small>${escapeHtml(t.code || '')}</small>
          </span>
        </td>
        ${cells}
        <td class="repartition-cell">
          <input type="number" step="0.5" min="0" class="inline-number-input repartition-projet-input" data-teacher-id="${t.id}" data-quota-key="PROJET" value="${projetHours}">
        </td>
        <td style="text-align:center; font-weight:800; background:#f8fbff;">
          ${total}h
        </td>
      </tr>
    `;
  }).join('');

  // Calculer les totaux par colonne (nombre de classes seulement)
  const colTotals = {};
  quotaKeys.forEach(key => {
    colTotals[key] = 0;
    teachers.forEach(t => {
      const quotas = t.assignedLevelQuotas || {};
      colTotals[key] += quotas[key] || 0;
    });
  });

  let projectTotal = 0;
  let grandTotal = 0;
  teachers.forEach(t => {
    const quotas = t.assignedLevelQuotas || {};
    projectTotal += quotas.PROJET || 0;

    // Calculer les heures totales pour ce prof
    let teacherHours = quotas.PROJET || 0;
    quotaKeys.forEach(key => {
      const weeklyHours = LEVEL_RULES[key]?.weeklyHours || 1;
      teacherHours += (quotas[key] || 0) * weeklyHours;
    });
    grandTotal += teacherHours;
  });

  const footerCells = quotaKeys.map(key => `<td><strong>${colTotals[key]}</strong></td>`).join('');

  const html = `
    <div style="display: flex; gap: 1rem; margin-bottom: 1rem; flex-wrap: wrap;">
      <button onclick="if(confirm('Êtes-vous sûr ?')) { resetRepartition(); closeRepartitionPopup(); }" class="secondary-btn" type="button">
        🗑️ Effacer la répartition
      </button>
      <button onclick="exportRepartitionCSV()" class="secondary-btn" type="button">
        📥 Exporter CSV
      </button>
      <button onclick="exportRepartitionExcel()" class="secondary-btn" type="button">
        📊 Exporter Excel
      </button>
      <button onclick="exportRepartitionImage()" class="secondary-btn" type="button">
        📸 Exporter PNG
      </button>
      <button onclick="openAdminTab('repartition'); closeRepartitionPopup();" class="primary-btn" type="button">
        📂 Ouvrir vue complète
      </button>
    </div>

    <table class="repartition-table">
      <thead>
        <tr>
          <th class="sticky-col">Professeur</th>
          ${quotaKeys.map(k => `<th>${k}</th>`).join('')}
          <th>Heure projet</th>
          <th>Total (Heures)</th>
        </tr>
      </thead>
      <tbody>
        ${rows}
      </tbody>
      <tfoot>
        <tr class="total-row">
          <td class="sticky-col"><strong>TOTAL</strong></td>
          ${footerCells}
          <td><strong>${projectTotal}h</strong></td>
          <td style="text-align:center;"><strong>${grandTotal}h</strong></td>
        </tr>
      </tfoot>
    </table>
  `;

  ui.repartitionPopupContent.innerHTML = html;

  // Ajouter les event listeners après le rendu
  setTimeout(() => {
    attachRepartitionEventListeners();
  }, 0);
}

/**
 * Attacher les event listeners aux boutons et inputs de la répartition
 */
function attachRepartitionEventListeners() {
  // Boutons +/-
  document.querySelectorAll('.repartition-btn').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      const teacherId = btn.dataset.teacherId;
      const quotaKey = btn.dataset.quotaKey;
      const delta = parseInt(btn.dataset.delta);

      // Mettre à jour dans Firestore
      const teacher = state.teachers.find(t => t.id === teacherId);
      if (!teacher) return;

      const quotas = teacher.assignedLevelQuotas || {};
      const current = quotas[quotaKey] || 0;
      const newValue = Math.max(0, current + delta);

      const updatedQuotas = { ...quotas, [quotaKey]: newValue };
      await updateDoc(doc(db, "teachers", teacherId), {
        assignedLevelQuotas: updatedQuotas
      });

      // Mettre à jour l'affichage
      renderRepartitionContent();
    });
  });

  // Inputs pour les heures projets
  document.querySelectorAll('.repartition-projet-input').forEach(input => {
    input.addEventListener('change', async (e) => {
      const teacherId = input.dataset.teacherId;
      const value = parseFloat(input.value) || 0;

      const teacher = state.teachers.find(t => t.id === teacherId);
      if (!teacher) return;

      const quotas = teacher.assignedLevelQuotas || {};
      const updatedQuotas = { ...quotas, PROJET: value };

      await updateDoc(doc(db, "teachers", teacherId), {
        assignedLevelQuotas: updatedQuotas
      });

      renderRepartitionContent();
    });
  });
}

/**
 * Réinitialiser la répartition
 */
function resetRepartition() {
  // Appeler la fonction d'reset existante si elle existe
  if (ui.repartitionResetBtn) {
    ui.repartitionResetBtn.click();
  }
}

/**
 * Exporter la répartition en CSV
 */
function exportRepartitionCSV() {
  const hoursByTeacher = computeTeacherHours();
  const teachers = state.teachers;

  let csv = "Professeur,Code,Max,Affecté,Solde\n";
  teachers.forEach(t => {
    const used = hoursByTeacher.get(t.id) || 0;
    const max = Number(t.maxHours || 0);
    csv += `"${t.name}","${t.code || ''}",${max},${used},${max - used}\n`;
  });

  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `repartition-${new Date().toISOString().split('T')[0]}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

/**
 * Exporter la répartition en Excel
 */
function exportRepartitionExcel() {
  if (ui.repartitionExportExcelBtn) {
    ui.repartitionExportExcelBtn.click();
  }
}

/**
 * Exporter la répartition en image
 */
function exportRepartitionImage() {
  if (ui.repartitionExportImageBtn) {
    ui.repartitionExportImageBtn.click();
  }
}

/**
 * Inviter les profs à consulter l'EDT
 */
async function inviteConsultEdt() {
  try {
    showToast("Préparation de l'EDT... (peut prendre quelques secondes)", "info");

    // Récupérer tous les profs
    const teachersSnapshot = await db.collection("teachers").get();
    const teachers = [];
    teachersSnapshot.forEach(doc => {
      if (doc.data().email) {
        teachers.push({
          id: doc.id,
          name: doc.data().name,
          email: doc.data().email
        });
      }
    });

    if (teachers.length === 0) {
      showToast("Aucun prof avec email trouvé", "error");
      return;
    }

    // Capturer l'image de l'EDT
    showToast("Capture de l'EDT...", "info");
    const edtElement = document.querySelector(".globalPlannerContainer, .global-large-area, #globalPlannerContainer");
    let edtImage = null;

    if (edtElement) {
      try {
        const canvas = await html2canvas(edtElement, {
          scale: 1,
          useCORS: true,
          logging: false,
          backgroundColor: '#ffffff'
        });
        edtImage = canvas.toDataURL("image/png");
      } catch (error) {
        console.warn("Erreur capture EDT:", error);
      }
    }

    // Appeler la Cloud Function pour envoyer les emails
    const result = await callCloudFunction("sendEdtInvitation", {
      teacherIds: teachers.map(t => t.id),
      schoolYear: getActiveSchoolYearId(),
      edtImage: edtImage
    });

    showToast(`✅ ${teachers.length} invitation(s) envoyée(s)`, "success");
  } catch (error) {
    console.error("Erreur envoi invitations EDT:", error);
    showToast("Erreur lors de l'envoi des invitations", "error");
  }
}

/**
 * Exporte l'EDT global en PDF
 */
async function exportEdtGlobalPdf() {
  try {
    showToast("Génération du PDF en cours...", "info");

    if (!state.teachers || !state.sessions) {
      showToast("Données non disponibles. Veuillez rafraîchir la page.", "error");
      return;
    }

    console.log("Sessions disponibles:", state.sessions.length);
    console.log("Profs disponibles:", state.teachers.length);

    const pdf = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });

    // Titre
    pdf.setFontSize(14);
    pdf.text("Emploi du Temps Global", pdf.internal.pageSize.getWidth() / 2, 10, { align: 'center' });

    // Créer un tableau jour/heure/classes comme l'EDT
    if (!state.sessions || state.sessions.length === 0) {
      pdf.setFontSize(12);
      pdf.text('Aucune session assignée dans l\'emploi du temps', 20, 30);
      pdf.save('EDT_Global.pdf');
      showToast("✅ PDF généré (aucune session)", "info");
      return;
    }

    const daysOfWeek = ['Lundi', 'Mardi', 'Mercredi', 'Jeudi', 'Vendredi'];

    // Chercher les slots dans les sessions
    let timeSlots = Array.from(new Set(state.sessions.map(s => s.startTime || s.slot).filter(Boolean))).sort();

    console.log("TimeSlots trouvés:", timeSlots.length);
    if (timeSlots.length > 0) {
      console.log("Premier slot:", timeSlots[0]);
    }

    // Si pas de timeSlots, utiliser SLOTS global s'il existe
    if (timeSlots.length === 0 && typeof SLOTS !== 'undefined') {
      // Filtrer SLOTS pour ne garder que ceux avec des sessions
      const usedSlots = new Set();
      for (const session of state.sessions) {
        const sessionSlot = session.startTime || session.slot;
        if (sessionSlot) usedSlots.add(sessionSlot);
      }

      if (usedSlots.size > 0) {
        timeSlots = SLOTS.filter(slot => usedSlots.has(slot));
      } else {
        timeSlots = SLOTS;
      }
      console.log("Utilisation des SLOTS globaux filtrés:", timeSlots.length);
    }

    if (timeSlots.length === 0) {
      pdf.setFontSize(12);
      pdf.text('Aucun créneau horaire défini', 20, 30);
      pdf.save('EDT_Global.pdf');
      showToast("✅ PDF généré (pas d'horaires)", "info");
      return;
    }

    // Créer le tableau jour/heure/classe
    console.log("Création tableau EDT avec", timeSlots.length, "créneaux et", daysOfWeek.length, "jours");

    const startY = 20;
    const pageHeight = pdf.internal.pageSize.getHeight();
    const margin = 10;
    const timeColWidth = 18;
    const dayColWidth = (pdf.internal.pageSize.getWidth() - margin * 2 - timeColWidth) / daysOfWeek.length;
    const rowHeight = 10;

    let currentY = startY;

    // En-têtes (jours)
    pdf.setFillColor(51, 102, 153);
    pdf.setTextColor(255, 255, 255);
    pdf.setFont(undefined, 'bold');
    pdf.setFontSize(9);

    // Cellule vide en haut à gauche (pour les heures)
    pdf.rect(margin, currentY, timeColWidth, rowHeight, 'F');
    pdf.text('Heure', margin + 2, currentY + 6);

    // Jours de la semaine en en-tête
    let currentX = margin + timeColWidth;
    for (const day of daysOfWeek) {
      pdf.rect(currentX, currentY, dayColWidth, rowHeight, 'F');
      pdf.text(day, currentX + 2, currentY + 6, { maxWidth: dayColWidth - 4 });
      currentX += dayColWidth;
    }

    currentY += rowHeight;

    // Données (heures x jours)
    pdf.setTextColor(0, 0, 0);
    pdf.setFont(undefined, 'normal');
    pdf.setFontSize(8);

    for (const time of timeSlots) {
      // Nouvelle page si nécessaire
      if (currentY + rowHeight > pageHeight - 15) {
        pdf.addPage();
        currentY = margin;

        // Répéter les en-têtes
        pdf.setFillColor(51, 102, 153);
        pdf.setTextColor(255, 255, 255);
        pdf.setFont(undefined, 'bold');
        pdf.setFontSize(9);

        pdf.rect(margin, currentY, timeColWidth, rowHeight, 'F');
        pdf.text('Heure', margin + 2, currentY + 6);

        currentX = margin + timeColWidth;
        for (const day of daysOfWeek) {
          pdf.rect(currentX, currentY, dayColWidth, rowHeight, 'F');
          pdf.text(day, currentX + 2, currentY + 6, { maxWidth: dayColWidth - 4 });
          currentX += dayColWidth;
        }

        currentY += rowHeight;
        pdf.setTextColor(0, 0, 0);
        pdf.setFont(undefined, 'normal');
        pdf.setFontSize(8);
      }

      // Heure
      pdf.rect(margin, currentY, timeColWidth, rowHeight);
      pdf.text(time, margin + 2, currentY + 6);

      // Classes pour chaque jour
      currentX = margin + timeColWidth;
      for (const day of daysOfWeek) {
        pdf.rect(currentX, currentY, dayColWidth, rowHeight);

        // Trouver toutes les sessions pour ce jour/heure
        const sessions = state.sessions.filter(s =>
          s.dayOfWeek === day && (s.startTime === time || s.slot === time)
        );

        let sessionText = '';
        for (const session of sessions) {
          const cls = state.classes.find(c => c.id === session.classId);
          const className = cls ? cls.name : (session.classId || '');
          const teacher = state.teachers.find(t => t.id === session.teacherId);
          const teacherName = teacher ? teacher.code || teacher.name : '';

          if (className) {
            sessionText += (sessionText ? '\n' : '') + className + (teacherName ? ' (' + teacherName + ')' : '');
          }
        }

        if (sessionText) {
          pdf.text(sessionText, currentX + 2, currentY + 3, { maxWidth: dayColWidth - 4 });
        }
        currentX += dayColWidth;
      }

      currentY += rowHeight;
    }

    pdf.save('EDT_Global.pdf');
    showToast("✅ PDF généré et téléchargé", "success");
  } catch (error) {
    console.error("Erreur export PDF global:", error);
    showToast("Erreur lors de la génération du PDF: " + error.message, "error");
  }
}

/**
 * Exporte l'EDT global en Excel
 */
async function exportEdtGlobalExcel() {
  try {
    showToast("Génération du fichier Excel en cours...", "info");

    if (!state.teachers || state.teachers.length === 0 || !state.sessions) {
      showToast("Données non disponibles. Veuillez rafraîchir la page.", "error");
      return;
    }

    // Créer les données du tableau
    const headers = ['Professeur', 'Classe', 'Jour', 'Heure', 'Activité', 'Lieu'];
    const tableData = [headers];

    for (const session of state.sessions) {
      const teacher = state.teachers.find(t => t.id === session.teacherId);
      const cls = state.classes.find(c => c.id === session.classId);
      tableData.push([
        teacher ? teacher.name : session.teacherId,
        cls ? cls.name : session.classId,
        session.dayOfWeek || '',
        session.startTime || '',
        session.activityLabel || '',
        session.location || ''
      ]);
    }

    // Créer le workbook
    const ws = XLSX.utils.aoa_to_sheet(tableData);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "EDT Global");

    // Auto-ajuster les colonnes
    const columnWidths = [20, 15, 12, 10, 25, 20];
    ws['!cols'] = columnWidths.map(width => ({ wch: width }));

    // Télécharger
    XLSX.writeFile(wb, 'EDT_Global.xlsx');
    showToast("✅ Fichier Excel généré et téléchargé", "success");
  } catch (error) {
    console.error("Erreur export Excel global:", error);
    showToast("Erreur lors de la génération du fichier Excel", "error");
  }
}

/**
 * Exporte l'EDT individuel en PDF (pour le prof connecté)
 */
async function exportEdtIndividualPdf() {
  try {
    if (!state.currentUserTeacherId) {
      showToast("Aucun professeur connecté", "error");
      return;
    }

    if (!state.teachers || !state.sessions) {
      showToast("Données non disponibles. Veuillez rafraîchir la page.", "error");
      return;
    }

    showToast("Génération du PDF en cours...", "info");

    const teacher = state.teachers.find(t => t.id === state.currentUserTeacherId);
    const schoolYearName = "EDT";

    const pdf = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });
    let yPosition = 10;

    // Titre
    pdf.setFontSize(16);
    pdf.text(
      `Emploi du Temps - ${teacher?.name || 'Individuel'} - ${schoolYearName}`,
      pdf.internal.pageSize.getWidth() / 2,
      yPosition,
      { align: 'center' }
    );
    yPosition += 10;

    // Récupérer les sessions du prof
    const teacherSessions = state.sessions.filter(s => s.teacherId === state.currentUserTeacherId);
    const daysOfWeek = ['Lundi', 'Mardi', 'Mercredi', 'Jeudi', 'Vendredi'];
    const timeSlots = Array.from(new Set(teacherSessions.map(s => s.startTime).filter(Boolean))).sort();

    // Créer les en-têtes avec les jours
    const headers = ['Heure', ...daysOfWeek];

    // Créer les données du tableau
    const tableData = [];
    if (timeSlots.length > 0) {
      for (const time of timeSlots) {
        const row = [time];
        for (const day of daysOfWeek) {
          const session = teacherSessions.find(s =>
            s.dayOfWeek === day && s.startTime === time
          );
          if (session) {
            const cls = state.classes.find(c => c.id === session.classId);
            row.push(cls ? cls.name : session.activityLabel || '');
          } else {
            row.push('');
          }
        }
        tableData.push(row);
      }
    } else {
      // Si pas de sessions, ajouter une ligne vide
      tableData.push(['Pas de sessions', '', '', '', '']);
    }

    // Ajouter le tableau au PDF
    if (pdf.autoTable && tableData.length > 0) {
      pdf.autoTable({
        head: [headers],
        body: tableData,
        startY: yPosition,
        theme: 'grid',
        margin: 5,
        fontSize: 11,
        headerStyles: {
          fillColor: [51, 102, 153],
          textColor: [255, 255, 255],
          fontStyle: 'bold',
          halign: 'center'
        },
        bodyStyles: {
          halign: 'center',
          valign: 'middle'
        },
        columnStyles: {
          0: { cellWidth: 25, fontStyle: 'bold' }
        },
        didDrawPage: function(data) {
          const pageCount = pdf.getNumberOfPages();
          pdf.setFontSize(10);
          pdf.text(
            `Page ${data.pageNumber} sur ${pageCount}`,
            pdf.internal.pageSize.getWidth() / 2,
            pdf.internal.pageSize.getHeight() - 5,
            { align: 'center' }
          );
        }
      });
    } else if (!tableData.length) {
      pdf.setFontSize(12);
      pdf.text('Aucune session assignée', 20, yPosition + 20);
    }

    const fileName = `EDT_${teacher?.name || 'Individuel'}.pdf`;
    pdf.save(fileName);
    showToast("✅ PDF généré et téléchargé", "success");
  } catch (error) {
    console.error("Erreur export PDF individuel:", error);
    showToast("Erreur lors de la génération du PDF", "error");
  }
}

/**
 * Exporte l'EDT individuel en Excel (pour le prof connecté)
 */
async function exportEdtIndividualExcel() {
  try {
    if (!state.currentUserTeacherId) {
      showToast("Aucun professeur connecté", "error");
      return;
    }

    if (!state.teachers || !state.sessions) {
      showToast("Données non disponibles. Veuillez rafraîchir la page.", "error");
      return;
    }

    showToast("Génération du fichier Excel en cours...", "info");

    const teacher = state.teachers.find(t => t.id === state.currentUserTeacherId);
    const schoolYearName = "EDT";

    // Récupérer les sessions du prof
    const teacherSessions = state.sessions.filter(s => s.teacherId === state.currentUserTeacherId);

    // Créer les données
    const tableData = [['Jour/Heure', 'Classe', 'Activité', 'Lieu']];
    for (const session of teacherSessions) {
      const cls = state.classes.find(c => c.id === session.classId);
      tableData.push([
        `${session.dayOfWeek || ''} ${session.startTime || ''}`,
        cls ? cls.name : session.classId,
        session.activityLabel || '',
        session.location || ''
      ]);
    }

    // Créer le workbook
    const ws = XLSX.utils.aoa_to_sheet(tableData);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Mon EDT");

    // Auto-ajuster les colonnes
    ws['!cols'] = [
      { wch: 20 },
      { wch: 15 },
      { wch: 25 },
      { wch: 20 }
    ];

    // Télécharger
    const fileName = `EDT_${teacher?.name || 'Individuel'}.xlsx`;
    XLSX.writeFile(wb, fileName);
    showToast("✅ Fichier Excel généré et téléchargé", "success");
  } catch (error) {
    console.error("Erreur export Excel individuel:", error);
    showToast("Erreur lors de la génération du fichier Excel", "error");
  }
}

init();
