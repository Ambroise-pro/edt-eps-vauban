import { ui } from '../dom.js';
import { state } from '../state.js';
import { DAYS, SLOT_BANDS } from '../constants.js';
import { escapeHtml } from '../utils.js';
import { setDoc, doc, db, deleteDoc, serverTimestamp } from '../firebase.js';
import { hasSwimSlot } from '../rules.js';

export function renderSwimPlanner() {
  if (!ui.swimPlannerContainer) return;
  const markedCount = state.swimSlotKeys.size;
  ui.swimHint.textContent = `Repère visuel global. Créneaux marqués: ${markedCount}.`;

  const head = `<tr><th>Heure</th>${DAYS.map((d) => `<th>${d}</th>`).join("")}</tr>`;
  const rows = SLOT_BANDS.map((band) => {
    const cells = DAYS.map((day) => {
      const marked = hasSwimSlot(day, band.slots[0]);
      return `<td class="slot${marked ? " slot-swim" : ""}">
        <button class="swim-toggle${marked ? " active" : ""}" data-day="${escapeHtml(day)}" data-slot="${escapeHtml(band.start)}" type="button">
          ${marked ? "Natation" : "-"}
        </button>
      </td>`;
    }).join("");
    return `<tr><th>${band.label}</th>${cells}</tr>`;
  }).join("");

  ui.swimPlannerContainer.innerHTML = `<table>${head}${rows}</table>`;
  bindSwimActions();
}

function bindSwimActions() {
  ui.swimPlannerContainer.querySelectorAll(".swim-toggle").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const day = btn.dataset.day;
      const slot = btn.dataset.slot;
      const key = `${day}|${slot}`;
      const docId = `${day}__${slot}`;
      
      if (state.swimSlotKeys.has(key)) {
        await deleteDoc(doc(db, "swimSlots", docId));
      } else {
        await setDoc(doc(db, "swimSlots", docId), {
          day, slot, createdAt: serverTimestamp()
        });
      }
    });
  });
}
