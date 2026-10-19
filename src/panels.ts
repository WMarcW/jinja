// Filter-Panel und Statistik-/Einstellungs-Panel

import { KIND_HOKORA, KIND_UNNAMED, PREFS, RANKS, shrines } from "./data";
import { filters, refreshMap, statusOf, ST_GOSHUIN, ST_VISITED, type StatusFilter, type Who } from "./map";
import { exportJson, localMode, logout, partnerId, setDisplayName, state, storageUsage, sync, userName } from "./store";
import { esc, openPanel } from "./ui";

const FILTER_KEY = "jinja-filters";

export function loadFilters(): void {
  try {
    Object.assign(filters, JSON.parse(localStorage.getItem(FILTER_KEY) ?? "{}"));
  } catch {
    /* ignorieren */
  }
}

function saveFilters(): void {
  try {
    localStorage.setItem(FILTER_KEY, JSON.stringify(filters));
  } catch {
    /* ignorieren */
  }
}

function seg<T extends string>(name: string, options: [T, string][], value: T): string {
  return `<div class="seg" data-name="${name}">${options
    .map(([v, l]) => `<button data-v="${v}" class="${v === value ? "on" : ""}">${esc(l)}</button>`)
    .join("")}</div>`;
}

export function openFilterPanel(): void {
  const pid = partnerId();
  const render = () => {
    const body = openPanel(
      "Filter",
      `
      ${pid ? `<h3>Wessen Fortschritt?</h3>${seg<Who>("who", [["me", "Ich"], ["partner", userName(pid)], ["both", "Beide"]], filters.who)}` : ""}
      <h3>Status</h3>
      ${seg<StatusFilter>("status", [["all", "Alle"], ["open", "Offen"], ["visited", "Besucht"], ["goshuin", "Goshuin"]], filters.status)}
      <h3>Anzeigen</h3>
      <label class="check"><input type="checkbox" id="f-hokora" ${filters.showHokora ? "checked" : ""}/> Hokora / kleine Wegschreine</label>
      <label class="check"><input type="checkbox" id="f-unnamed" ${filters.showUnnamed ? "checked" : ""}/> Schreine ohne Namen (Kartensymbole)</label>
      <label class="check"><input type="checkbox" id="f-ranked" ${filters.onlyRanked ? "checked" : ""}/> Nur bedeutende Schreine (Ichinomiya, Beppyō, Shikinaisha …)</label>
      <div class="legend">
        <span><i class="dot"></i>offen</span><span><i class="dot red"></i>besucht</span><span><i class="dot gold"></i>Goshuin</span>
        <span><i class="dot grey"></i>Hokora/namenlos</span><span><i class="dot blue"></i>eigener Eintrag</span>
      </div>
      <p class="hint">Tipp: Lange auf die Karte drücken, um einen fehlenden Schrein hinzuzufügen.</p>
    `,
    );
    body.querySelectorAll<HTMLElement>(".seg").forEach((el) => {
      el.querySelectorAll<HTMLButtonElement>("button").forEach((b) => {
        b.onclick = () => {
          (filters as Record<string, unknown>)[el.dataset.name!] = b.dataset.v;
          changed();
        };
      });
    });
    const chk = (id: string, key: "showHokora" | "showUnnamed" | "onlyRanked") =>
      ((body.querySelector(id) as HTMLInputElement).onchange = (e) => {
        filters[key] = (e.target as HTMLInputElement).checked;
        changed();
      });
    chk("#f-hokora", "showHokora");
    chk("#f-unnamed", "showUnnamed");
    chk("#f-ranked", "onlyRanked");
  };
  const changed = () => {
    saveFilters();
    refreshMap();
    render();
  };
  render();
}

function countFor(who: Who) {
  let visited = 0;
  let goshuin = 0;
  const perPref = new Map<number, { v: number; g: number }>();
  const perRank = new Map<number, number>();
  for (const s of shrines.values()) {
    const st = statusOf(s.id, who);
    if (st < ST_VISITED) continue;
    visited++;
    if (st === ST_GOSHUIN) goshuin++;
    const p = perPref.get(s.pref) ?? { v: 0, g: 0 };
    p.v++;
    if (st === ST_GOSHUIN) p.g++;
    perPref.set(s.pref, p);
    for (const r of RANKS) if (s.rank & r.bit) perRank.set(r.bit, (perRank.get(r.bit) ?? 0) + 1);
  }
  for (const c of state.custom.values()) {
    if (c.deleted) continue;
    const st = statusOf(c.id, who);
    if (st >= ST_VISITED) visited++;
    if (st === ST_GOSHUIN) goshuin++;
  }
  return { visited, goshuin, perPref, perRank };
}

export function openStatsPanel(): void {
  const pid = partnerId();
  const me = countFor("me");
  const partner = pid ? countFor("partner") : null;
  const totals = { all: 0, named: 0, perPref: new Map<number, number>(), perRank: new Map<number, number>() };
  for (const s of shrines.values()) {
    totals.all++;
    if (s.kind !== KIND_HOKORA && s.kind !== KIND_UNNAMED) totals.named++;
    totals.perPref.set(s.pref, (totals.perPref.get(s.pref) ?? 0) + 1);
    for (const r of RANKS) if (s.rank & r.bit) totals.perRank.set(r.bit, (totals.perRank.get(r.bit) ?? 0) + 1);
  }
  const myPhotos = [...state.photos.values()].filter((p) => !p.deleted && p.user_id === state.userId).length;

  const card = (label: string, c: ReturnType<typeof countFor>) => `
    <div class="stat-card"><div class="stat-who">${esc(label)}</div>
      <div class="stat-row"><b>${c.visited}</b> besucht</div>
      <div class="stat-row gold"><b>${c.goshuin}</b> Goshuin</div></div>`;

  const body = openPanel(
    "Statistik & Einstellungen",
    `
    <div class="stat-cards">${card("Ich", me)}${partner ? card(userName(pid!), partner) : ""}</div>
    <p class="hint">${totals.all.toLocaleString("de-DE")} Einträge in der Karte, davon ${totals.named.toLocaleString("de-DE")} benannte Schreine.</p>

    <h3>Bedeutende Schreine</h3>
    <table class="tbl"><tr><th></th><th>Ich</th>${partner ? `<th>${esc(userName(pid!))}</th>` : ""}<th>Gesamt</th></tr>
      ${RANKS.map((r) => `<tr><td>${esc(r.label)}</td><td>${me.perRank.get(r.bit) ?? 0}</td>${partner ? `<td>${partner.perRank.get(r.bit) ?? 0}</td>` : ""}<td>${totals.perRank.get(r.bit) ?? 0}</td></tr>`).join("")}
    </table>

    <h3>Nach Präfektur</h3>
    <table class="tbl"><tr><th></th><th>Ich ⛩/印</th>${partner ? `<th>${esc(userName(pid!))}</th>` : ""}<th>Gesamt</th></tr>
      ${PREFS.map((name, i) => {
        const m = me.perPref.get(i);
        const p = partner?.perPref.get(i);
        if (!m && !p) return "";
        return `<tr><td>${esc(name)}</td><td>${m ? `${m.v}/${m.g}` : "–"}</td>${partner ? `<td>${p ? `${p.v}/${p.g}` : "–"}</td>` : ""}<td>${totals.perPref.get(i) ?? 0}</td></tr>`;
      }).join("") || `<tr><td colspan="4" class="hint">Noch keine Besuche</td></tr>`}
    </table>

    <h3>Einstellungen</h3>
    ${
      localMode
        ? `<p class="hint">Lokaler Modus: Daten werden nur auf diesem Gerät gespeichert (Supabase nicht konfiguriert).</p>`
        : `
      <label class="field">Mein Anzeigename<input id="s-name" class="text" value="${esc(state.profiles.get(state.userId) ?? "")}" /></label>
      <p class="hint">Angemeldet als ${esc(state.email)}</p>
      <p class="hint" id="s-sync">Sync: ${state.syncing ? "läuft …" : state.queue.length ? `${state.queue.length} Änderungen warten` : "aktuell"}${state.lastError ? ` – Fehler: ${esc(state.lastError)}` : ""}</p>
      <p class="hint" id="s-usage">Fotos: ${myPhotos} eigene · Speicher wird berechnet …</p>
      <button class="btn" id="s-sync-now">Jetzt synchronisieren</button>`
    }
    <button class="btn" id="s-export">Backup exportieren (JSON)</button>
    ${localMode ? "" : `<button class="btn danger" id="s-logout">Abmelden</button>`}

    <h3>Datenquellen</h3>
    <p class="hint">Schreine: © OpenStreetMap-Mitwirkende (ODbL), Wikidata (CC0), 国土地理院最適化ベクトルタイル (Kartensymbole 神社). Karte: OpenFreeMap / OpenMapTiles.</p>
  `,
  );

  body.querySelector<HTMLInputElement>("#s-name")?.addEventListener("change", (e) => void setDisplayName((e.target as HTMLInputElement).value));
  body.querySelector("#s-sync-now")?.addEventListener("click", () => void sync().then(openStatsPanel));
  body.querySelector("#s-logout")?.addEventListener("click", () => {
    if (state.queue.length && !confirm(`${state.queue.length} Änderungen sind noch nicht synchronisiert und gehen verloren. Trotzdem abmelden?`)) return;
    void logout();
  });
  body.querySelector("#s-export")!.addEventListener("click", () => {
    const blob = new Blob([exportJson()], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `jinja-backup-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
  });
  if (!localMode) {
    void storageUsage().then((bytes) => {
      const el = body.querySelector("#s-usage");
      if (el) el.textContent = `Fotos: ${myPhotos} eigene · Speicher gesamt ${(bytes / 1e6).toFixed(0)} MB von 1000 MB (kostenlos)`;
    });
  }
}
