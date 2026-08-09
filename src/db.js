import { db, collection, onSnapshot } from './firebase.js';
import { state } from './state.js';

export function subscribeData(renderCallback) {
  onSnapshot(collection(db, "teachers"), (snap) => {
    state.teachers = snap.docs
      .map((d) => ({ id: d.id, ...d.data() }))
      .sort((a, b) => String(a.name || "").localeCompare(String(b.name || ""), "fr"));
    renderCallback();
  });

  onSnapshot(collection(db, "classes"), (snap) => {
    state.classes = snap.docs
      .map((d) => ({ id: d.id, ...d.data() }))
      .sort((a, b) => {
        const levelCmp = String(a.level || "").localeCompare(String(b.level || ""), "fr");
        if (levelCmp !== 0) return levelCmp;
        return String(a.name || "").localeCompare(String(b.name || ""), "fr");
      });
    renderCallback();
  });

  onSnapshot(collection(db, "sessions"), (snap) => {
    state.sessions = snap.docs
      .map((d) => ({ id: d.id, ...d.data() }))
      .sort((a, b) => {
        const dayCmp = String(a.day || "").localeCompare(String(b.day || ""), "fr");
        if (dayCmp !== 0) return dayCmp;
        return String(a.start || "").localeCompare(String(b.start || ""), "fr");
      });
    renderCallback();
  });

  onSnapshot(collection(db, "swimSlots"), (snap) => {
    state.swimSlots = snap.docs
      .map((d) => ({ id: d.id, ...d.data() }))
      .filter((x) => x.day && x.slot);
    state.swimSlotKeys = new Set(state.swimSlots.map((s) => `${s.day}|${s.slot}`));
    renderCallback();
  });

  onSnapshot(collection(db, "programActivities"), (snap) => {
    state.programActivities = snap.docs
      .map((d) => ({ id: d.id, ...d.data() }))
      .sort((a, b) => String(a.label || "").localeCompare(String(b.label || ""), "fr"));
    renderCallback();
  });

  onSnapshot(collection(db, "programLocations"), (snap) => {
    state.programLocations = snap.docs
      .map((d) => ({ id: d.id, ...d.data() }))
      .sort((a, b) => String(a.name || "").localeCompare(String(b.name || ""), "fr"));
    renderCallback();
  });
}
