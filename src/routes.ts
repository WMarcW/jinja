// Routen: Schreine in einer Reihenfolge planen, auf der Karte anzeigen, speichern.

import { displayName, type Shrine } from "./data";
import { closeSheet, openSheet } from "./detail";
import { fitPoints, flyTo, getShrine, setRouteLine } from "./map";
import { saveRoute, state, userName, type Route } from "./store";
import { closePanel, esc, openPanel, toast } from "./ui";

type Mode =
  | { kind: "edit"; route: Route; stops: string[]; dirty: boolean }
  | { kind: "view"; route: Route }
  | null;

let mode: Mode = null;
let collapsed = false;
const bar = document.getElementById("route-bar")!;

export function isEditingRoute(): boolean {
  return mode?.kind === "edit";
}

/** Position des Schreins in der aktuell bearbeiteten Route (-1 = nicht enthalten). */
export function routeIndex(id: string): number {
  return mode?.kind === "edit" ? mode.stops.indexOf(id) : -1;
}

/** Schrein zur bearbeiteten Route hinzufügen bzw. daraus entfernen. */
export function toggleStop(id: string): void {
  if (mode?.kind !== "edit") return;
  const i = mode.stops.indexOf(id);
  if (i >= 0) {
    mode.stops.splice(i, 1);
  } else {
    mode.stops.push(id);
    toast(`Stopp ${mode.stops.length} hinzugefügt`, 1500);
  }
  mode.dirty = true;
  render();
}

function stopsOf(ids: string[]): Shrine[] {
  return ids.map(getShrine).filter((s): s is Shrine => !!s);
}

/** Gesamtlänge in Luftlinie (km). */
function lengthKm(stops: Shrine[]): number {
  let km = 0;
  for (let i = 1; i < stops.length; i++) {
    const a = stops[i - 1];
    const b = stops[i];
    const x = ((b.lon - a.lon) * Math.PI) / 180 * Math.cos(((a.lat + b.lat) * Math.PI) / 360);
    const y = ((b.lat - a.lat) * Math.PI) / 180;
    km += 6371 * Math.hypot(x, y);
  }
  return km;
}

const fmtKm = (km: number) => `${km < 10 ? km.toFixed(1).replace(".", ",") : Math.round(km)} km Luftlinie`;

// ---------- Liste der Routen ----------
export function openRoutesPanel(): void {
  const routes = [...state.routes.values()]
    .filter((r) => !r.deleted)
    .sort((a, b) => (b.updated_at ?? "").localeCompare(a.updated_at ?? ""));
  const body = openPanel(
    "Routen",
    `
    <button class="primary wide" id="r-new">＋ Neue Route</button>
    ${
      routes.length
        ? `<div class="route-list">${routes
            .map((r) => {
              const stops = stopsOf(r.stops);
              return `<button class="route-item" data-id="${esc(r.id)}">
                <b>${esc(r.name)}</b>
                <small>${stops.length} Stopps · ${fmtKm(lengthKm(stops))}${r.created_by !== state.userId ? ` · von ${esc(userName(r.created_by))}` : ""}</small>
              </button>`;
            })
            .join("")}</div>`
        : `<p class="hint">Noch keine Routen. Plane eine Tour: Schreine auf der Karte antippen und in der gewünschten Reihenfolge hinzufügen.</p>`
    }`,
  );
  body.querySelector("#r-new")!.addEventListener("click", () => startEdit());
  body.querySelectorAll<HTMLButtonElement>(".route-item").forEach((b) => {
    b.onclick = () => viewRoute(state.routes.get(b.dataset.id!)!);
  });
}

// ---------- Modi ----------
function startEdit(route?: Route): void {
  if (mode?.kind === "edit" && mode.dirty && !confirm("Ungespeicherte Änderungen verwerfen?")) return;
  closePanel();
  closeSheet();
  const r: Route = route
    ? { ...route }
    : { id: `r${crypto.randomUUID()}`, name: "", stops: [], created_by: state.userId, deleted: false };
  mode = { kind: "edit", route: r, stops: [...r.stops], dirty: false };
  collapsed = false;
  render();
  if (!route) toast("Schreine antippen und „Zur Route hinzufügen“ wählen", 3500);
}

function viewRoute(r: Route): void {
  closePanel();
  closeSheet();
  mode = { kind: "view", route: r };
  collapsed = false;
  render();
  fitPoints(stopsOf(r.stops));
}

function exit(): void {
  mode = null;
  render();
}

function cancel(): void {
  if (mode?.kind === "edit" && mode.dirty && !confirm("Route verwerfen? Die Änderungen gehen verloren.")) return;
  const wasExisting = mode?.kind === "edit" && state.routes.has(mode.route.id);
  const r = mode?.kind === "edit" ? state.routes.get(mode.route.id) : undefined;
  if (wasExisting && r) viewRoute(r);
  else exit();
}

function save(): void {
  if (mode?.kind !== "edit") return;
  if (!mode.stops.length) {
    toast("Füge zuerst mindestens einen Schrein hinzu");
    return;
  }
  const name = prompt("Name der Route:", mode.route.name || `Route ${new Date().toLocaleDateString("de-DE")}`);
  if (name === null) return; // Dialog abgebrochen -> weiter bearbeiten
  const r: Route = { ...mode.route, name: name.trim() || "Ohne Namen", stops: [...mode.stops] };
  saveRoute(r);
  toast("Route gespeichert");
  viewRoute(r);
}

function remove(): void {
  if (mode?.kind !== "view") return;
  if (!confirm(`Route „${mode.route.name}“ löschen?`)) return;
  saveRoute({ ...mode.route, deleted: true });
  exit();
  toast("Route gelöscht");
}

/** Google-Maps-Navigation über alle Stopps (Google erlaubt max. 9 Zwischenziele). */
function googleNavUrl(stops: Shrine[]): string {
  const pt = (s: Shrine) => `${s.lat},${s.lon}`;
  const dest = stops[stops.length - 1];
  const via = stops.slice(0, -1).slice(0, 9);
  let url = `https://www.google.com/maps/dir/?api=1&destination=${pt(dest)}`;
  if (via.length) url += `&waypoints=${via.map(pt).join("|")}`;
  return url;
}

// ---------- Darstellung ----------
function move(i: number, d: number): void {
  if (mode?.kind !== "edit") return;
  const j = i + d;
  if (j < 0 || j >= mode.stops.length) return;
  [mode.stops[i], mode.stops[j]] = [mode.stops[j], mode.stops[i]];
  mode.dirty = true;
  render();
}

export function render(): void {
  if (!mode) {
    bar.hidden = true;
    document.body.classList.remove("route-mode");
    setRouteLine([]);
    return;
  }
  // gelöschte/aktualisierte Route nach Sync übernehmen
  if (mode.kind === "view") {
    const fresh = state.routes.get(mode.route.id);
    if (!fresh || fresh.deleted) return exit();
    mode.route = fresh;
  }
  const ids = mode.kind === "edit" ? mode.stops : mode.route.stops;
  const stops = stopsOf(ids);
  setRouteLine(stops);
  bar.hidden = false;
  document.body.classList.add("route-mode");

  const editing = mode.kind === "edit";
  const title = editing ? (mode.route.name ? `Bearbeiten: ${mode.route.name}` : "Neue Route") : mode.route.name;
  const tooMany = stops.length > 10;

  bar.innerHTML = `
    <button class="rb-head" id="rb-toggle">
      <span class="rb-title">${esc(title)}</span>
      <span class="rb-meta">${stops.length} Stopps${stops.length > 1 ? ` · ${fmtKm(lengthKm(stops))}` : ""}</span>
      <span class="rb-chev">${collapsed ? "▴" : "▾"}</span>
    </button>
    ${
      collapsed
        ? ""
        : `<ol class="rb-list">${
            stops.length
              ? stops
                  .map(
                    (s, i) => `<li>
                <span class="rb-num">${i + 1}</span>
                <button class="rb-name" data-i="${i}">${esc(displayName(s))}</button>
                ${
                  editing
                    ? `<button class="rb-btn" data-up="${i}" ${i === 0 ? "disabled" : ""} aria-label="nach oben">↑</button>
                       <button class="rb-btn" data-down="${i}" ${i === stops.length - 1 ? "disabled" : ""} aria-label="nach unten">↓</button>
                       <button class="rb-btn del" data-del="${i}" aria-label="entfernen">✕</button>`
                    : ""
                }
              </li>`,
                  )
                  .join("")
              : `<li class="rb-empty">Noch keine Stopps. Tippe auf einen Schrein und wähle „Zur Route hinzufügen“.</li>`
          }</ol>`
    }
    <div class="rb-actions">
      ${
        editing
          ? `<button class="btn" id="rb-cancel">Abbrechen</button>
             <button class="primary" id="rb-save">Speichern</button>`
          : `<button class="btn" id="rb-close">Schließen</button>
             <button class="btn danger" id="rb-delete">Löschen</button>
             <button class="btn" id="rb-edit">Bearbeiten</button>
             ${stops.length ? `<a class="primary" id="rb-nav" target="_blank" rel="noopener" href="${googleNavUrl(stops)}">Navigation</a>` : ""}`
      }
    </div>
    ${!editing && tooMany ? `<p class="rb-hint">Google Maps navigiert nur die ersten 10 Stopps auf einmal.</p>` : ""}
  `;

  bar.querySelector("#rb-toggle")!.addEventListener("click", () => {
    collapsed = !collapsed;
    render();
  });
  bar.querySelectorAll<HTMLButtonElement>(".rb-name").forEach((b) => {
    b.onclick = () => {
      const s = stops[Number(b.dataset.i)];
      flyTo(s.lat, s.lon, 15);
      void openSheet(s.id);
    };
  });
  bar.querySelectorAll<HTMLButtonElement>("[data-up]").forEach((b) => (b.onclick = () => move(Number(b.dataset.up), -1)));
  bar.querySelectorAll<HTMLButtonElement>("[data-down]").forEach((b) => (b.onclick = () => move(Number(b.dataset.down), 1)));
  bar.querySelectorAll<HTMLButtonElement>("[data-del]").forEach((b) => {
    b.onclick = () => {
      if (mode?.kind !== "edit") return;
      mode.stops.splice(Number(b.dataset.del), 1);
      mode.dirty = true;
      render();
    };
  });
  bar.querySelector("#rb-cancel")?.addEventListener("click", cancel);
  bar.querySelector("#rb-save")?.addEventListener("click", save);
  bar.querySelector("#rb-close")?.addEventListener("click", exit);
  bar.querySelector("#rb-delete")?.addEventListener("click", remove);
  bar.querySelector("#rb-edit")?.addEventListener("click", () => mode?.kind === "view" && startEdit(mode.route));
}
