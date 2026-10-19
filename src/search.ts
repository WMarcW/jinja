// Namenssuche (Kanji, Kana, Romaji) – sortiert nach Entfernung zur Kartenmitte.

import { displayName, PREFS, searchKey, type Shrine } from "./data";
import { allShrines, flyTo, mapCenter, statusOf, ST_GOSHUIN, ST_VISITED } from "./map";
import { esc } from "./ui";

const input = document.getElementById("search") as HTMLInputElement;
const results = document.getElementById("search-results")!;

const SUFFIX = /(神社|大社|神宮|宮|社)$/;

/** Bedeutung aus den Rang-Bits (siehe RANKS in data.ts). */
function importance(rank: number): number {
  let i = 0;
  if (rank & 16) i += 5; // 22 Schreine
  if (rank & 1) i += 4; // Ichinomiya
  if (rank & 8) i += 4; // ehem. kaiserlich
  if (rank & 2) i += 3; // Beppyō
  if (rank & 32) i += 2; // Ise
  if (rank & 4) i += 1; // Shikinaisha
  return i;
}

function km(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const x = ((bLon - aLon) * Math.PI) / 180 * Math.cos(((aLat + bLat) * Math.PI) / 360);
  const y = ((bLat - aLat) * Math.PI) / 180;
  return 6371 * Math.hypot(x, y);
}

export function initSearch(onSelect: (id: string) => void): void {
  let timer: number | undefined;
  input.addEventListener("input", () => {
    clearTimeout(timer);
    timer = window.setTimeout(run, 200);
  });
  input.addEventListener("focus", () => input.value && run());
  document.addEventListener("click", (e) => {
    if (!(e.target as HTMLElement).closest(".search-wrap")) results.hidden = true;
  });

  function run(): void {
    const q = searchKey(input.value.trim());
    if (q.length < 2 && !/[぀-鿿]/.test(q)) {
      results.hidden = true;
      return;
    }
    const c = mapCenter();
    // exakte Treffer (auch ohne Endung 神社/大社 …) zuerst, dann Wortanfang, dann Rest
    const score = (s: Shrine) => {
      const n = searchKey(s.name);
      return n === q || n.replace(SUFFIX, "") === q ? 0 : s.search.startsWith(q) ? 1 : 2;
    };
    const hits = allShrines()
      .filter((s) => s.search.includes(q))
      .map((s) => ({ s, d: km(c.lat, c.lon, s.lat, s.lon), sc: score(s), imp: importance(s.rank) }))
      // bei gleich guten Treffern (z. B. hunderte 八坂神社) bedeutende Schreine zuerst
      .sort((a, b) => a.sc - b.sc || b.imp - a.imp || a.d - b.d)
      .slice(0, 50);
    results.innerHTML = hits.length
      ? hits
          .map(({ s, d }) => {
            const st = statusOf(s.id);
            const dot = st === ST_GOSHUIN ? "gold" : st === ST_VISITED ? "red" : "";
            return `<button data-id="${esc(s.id)}"><span class="dot ${dot}"></span><span class="r-main">${esc(displayName(s))}<small>${esc(s.romaji)}</small></span><span class="r-meta">${s.pref >= 0 ? esc(PREFS[s.pref]) : ""}<br>${d < 10 ? d.toFixed(1) : Math.round(d)} km</span></button>`;
          })
          .join("")
      : `<div class="empty">Keine Treffer</div>`;
    results.hidden = false;
    results.querySelectorAll<HTMLButtonElement>("button").forEach((b) => {
      b.onclick = () => {
        const s = hits.find((h) => h.s.id === b.dataset.id)!.s;
        results.hidden = true;
        input.blur();
        flyTo(s.lat, s.lon, 15);
        onSelect(s.id);
      };
    });
  }
}
