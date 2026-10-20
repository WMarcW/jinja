// Detail-Sheet eines Schreins: Status, Goshuin, Notiz, Fotos, Infos.

import { displayName, KIND_CUSTOM, KIND_HOKORA, KIND_UNNAMED, loadDetails, PREFS, RANKS, shrines, type Shrine } from "./data";
import { getShrine } from "./map";
import { prepareImage } from "./photos";
import { isEditingRoute, routeIndex, toggleStop } from "./routes";
import {
  addPhoto, deletePhoto, myVisit, partnerId, photoBlob, photosFor, saveCustom, saveGoshuinInfo,
  saveVisit, state, userName, vkey, type GoshuinInfo, type Photo, type Visit,
} from "./store";
import { esc, toast } from "./ui";

const sheet = document.getElementById("sheet")!;
const body = document.getElementById("sheet-body")!;
let currentId: string | null = null;
const urlCache = new Map<string, string>();

export function currentShrine(): string | null {
  return currentId;
}

export function closeSheet(): void {
  sheet.hidden = true;
  currentId = null;
}

function findShrine(id: string): Shrine | undefined {
  return getShrine(id);
}

const today = () => new Date().toISOString().slice(0, 10);

function fmtDate(d: string | null): string {
  if (!d) return "";
  const [y, m, day] = d.split("-");
  return `${day}.${m}.${y}`;
}

export async function openSheet(id: string): Promise<void> {
  const s = findShrine(id);
  if (!s) return;
  const keepScroll = currentId === id ? body.scrollTop : 0;
  currentId = id;
  sheet.hidden = false;

  const v: Visit = myVisit(id) ?? {
    shrine_id: id, user_id: state.userId, visited: false, visited_at: null, goshuin: false,
    goshuin_at: null, note: "", shrine_name: s.name, lat: s.lat, lon: s.lon,
  };
  const pid = partnerId();
  const pv = pid ? state.visits.get(vkey(id, pid)) : undefined;
  const info = state.goshuinInfo.get(id);
  const photos = photosFor(id);
  const ranks = RANKS.filter((r) => s.rank & r.bit);
  const unnamedBase = shrines.get(id)?.name === "";
  const kindLabel =s.kind === KIND_HOKORA ? "Hokora 祠" : s.kind === KIND_UNNAMED ? "Kartensymbol (GSI)" : s.kind === KIND_CUSTOM ? "Eigener Eintrag" : "";

  body.innerHTML = `
    <div class="sheet-head">
      <div>
        <h2>${esc(displayName(s))}</h2>
        ${s.romaji && s.romaji !== s.name ? `<div class="romaji">${esc(s.romaji)}</div>` : ""}
        <div class="meta">${s.pref >= 0 ? esc(PREFS[s.pref]) : ""}${kindLabel ? ` · ${kindLabel}` : ""}</div>
      </div>
      <button class="icon-btn" id="sheet-close" aria-label="Schließen">✕</button>
    </div>
    ${
      isEditingRoute()
        ? routeIndex(id) >= 0
          ? `<button class="route-toggle on" id="route-toggle">✓ Stopp ${routeIndex(id) + 1} der Route · entfernen</button>`
          : `<button class="route-toggle" id="route-toggle">＋ Zur Route hinzufügen</button>`
        : ""
    }
    ${
      unnamedBase
        ? `<input id="s-name" class="text" placeholder="Name ergänzen (z. B. vom Schild am Torii) …" value="${esc(info?.name ?? "")}" />`
        : ""
    }
    ${ranks.length ? `<div class="badges">${ranks.map((r) => `<span class="badge">${esc(r.label)}</span>`).join("")}</div>` : ""}

    <div class="route">
      <a class="btn" target="_blank" rel="noopener" href="https://www.google.com/maps/dir/?api=1&destination=${s.lat},${s.lon}">Google Maps</a>
      <a class="btn" target="_blank" rel="noopener" href="https://maps.apple.com/?daddr=${s.lat},${s.lon}&q=${encodeURIComponent(s.name || "神社")}">Apple Karten</a>
    </div>

    <section class="nearby">
      <div class="nearby-strip" id="nearby-strip"></div>
      <a class="small-link" target="_blank" rel="noopener" href="${googlePhotosUrl(s)}">Fotos in Google Maps ansehen ↗</a>
    </section>

    <section class="status">
      <label class="toggle ${v.visited ? "on" : ""}" id="t-visited">
        <span class="t-icon">⛩</span><span class="t-label">Besucht</span>
        <input type="date" id="d-visited" value="${v.visited_at ?? ""}" ${v.visited ? "" : "hidden"} />
      </label>
      <label class="toggle gold ${v.goshuin ? "on" : ""}" id="t-goshuin">
        <span class="t-icon">印</span><span class="t-label">Goshuin geholt</span>
        <input type="date" id="d-goshuin" value="${v.goshuin_at ?? ""}" ${v.goshuin ? "" : "hidden"} />
      </label>
      ${
        pid
          ? `<div class="partner">${esc(userName(pid))}: ${
              pv?.visited || pv?.goshuin
                ? `${pv.visited ? `besucht${pv.visited_at ? ` am ${fmtDate(pv.visited_at)}` : ""}` : ""}${pv.goshuin ? ` · Goshuin ✓${pv.goshuin_at ? ` (${fmtDate(pv.goshuin_at)})` : ""}` : ""}`
                : "noch nicht besucht"
            }${pv?.note ? `<div class="pnote">„${esc(pv.note)}"</div>` : ""}</div>`
          : ""
      }
    </section>

    <section>
      <h3>Goshuin erhältlich?</h3>
      <div class="seg" id="g-avail">
        <button data-v="true" class="${info?.available === true ? "on" : ""}">Ja</button>
        <button data-v="false" class="${info?.available === false ? "on" : ""}">Nein</button>
        <button data-v="null" class="${info == null || info.available == null ? "on" : ""}">Unbekannt</button>
      </div>
      <input id="g-note" class="text" placeholder="z. B. nur am Wochenende, Shamusho im Nachbarschrein …" value="${esc(info?.note ?? "")}" />
    </section>

    <section>
      <h3>Notiz</h3>
      <textarea id="note" class="text" rows="2" placeholder="Eigene Notiz …">${esc(v.note)}</textarea>
    </section>

    <section>
      <h3>Fotos <span class="count">${photos.length || ""}</span></h3>
      <div class="photos" id="photos">
        ${photos.map((p) => `<button class="thumb" data-id="${p.id}"><img alt="" /><span>${p.user_id === state.userId ? "" : esc(userName(p.user_id))}</span></button>`).join("")}
        <label class="thumb add">＋<input type="file" id="photo-input" accept="image/*" multiple hidden /></label>
      </div>
    </section>

    <section id="details"></section>
    ${s.kind === KIND_CUSTOM && state.custom.get(id)?.created_by === state.userId ? `<button class="btn danger" id="del-custom">Eigenen Eintrag löschen</button>` : ""}
  `;
  body.scrollTop = keepScroll;

  document.getElementById("sheet-close")!.onclick = closeSheet;
  document.getElementById("route-toggle")?.addEventListener("click", () => {
    const adding = routeIndex(id) < 0;
    toggleStop(id);
    // nach dem Hinzufügen Sheet schließen, damit man direkt den nächsten Schrein wählen kann
    if (adding) closeSheet();
    else void openSheet(id);
  });

  // ----- Status -----
  const save = (patch: Partial<Visit>) => {
    Object.assign(v, patch, { shrine_name: s.name, lat: s.lat, lon: s.lon });
    saveVisit({ ...v });
    void openSheet(id);
  };
  document.getElementById("t-visited")!.onclick = (e) => {
    if ((e.target as HTMLElement).tagName === "INPUT") return;
    e.preventDefault();
    if (v.visited) save({ visited: false, visited_at: null, goshuin: false, goshuin_at: null });
    else save({ visited: true, visited_at: v.visited_at ?? today() });
  };
  document.getElementById("t-goshuin")!.onclick = (e) => {
    if ((e.target as HTMLElement).tagName === "INPUT") return;
    e.preventDefault();
    if (v.goshuin) save({ goshuin: false, goshuin_at: null });
    else save({ goshuin: true, goshuin_at: v.goshuin_at ?? today(), visited: true, visited_at: v.visited_at ?? today() });
  };
  (document.getElementById("d-visited") as HTMLInputElement).onchange = (e) =>
    save({ visited_at: (e.target as HTMLInputElement).value || null });
  (document.getElementById("d-goshuin") as HTMLInputElement).onchange = (e) =>
    save({ goshuin_at: (e.target as HTMLInputElement).value || null });
  (document.getElementById("note") as HTMLTextAreaElement).onchange = (e) => {
    v.note = (e.target as HTMLTextAreaElement).value;
    saveVisit({ ...v, shrine_name: s.name, lat: s.lat, lon: s.lon });
  };

  // ----- Goshuin-Info -----
  const saveInfo = (patch: Partial<GoshuinInfo>) =>
    saveGoshuinInfo({ shrine_id: id, available: info?.available ?? null, note: info?.note ?? "", name: info?.name ?? "", ...patch });
  document.querySelectorAll<HTMLButtonElement>("#g-avail button").forEach((b) => {
    b.onclick = () => {
      saveInfo({ available: JSON.parse(b.dataset.v!) });
      void openSheet(id);
    };
  });
  (document.getElementById("g-note") as HTMLInputElement).onchange = (e) => saveInfo({ note: (e.target as HTMLInputElement).value });
  document.getElementById("s-name")?.addEventListener("change", (e) => {
    saveInfo({ name: (e.target as HTMLInputElement).value.trim() });
    void openSheet(id);
  });

  // ----- Fotos -----
  (document.getElementById("photo-input") as HTMLInputElement).onchange = async (e) => {
    const files = [...((e.target as HTMLInputElement).files ?? [])];
    for (const f of files) {
      try {
        const { full, thumb } = await prepareImage(f);
        await addPhoto(id, full, thumb);
      } catch (err) {
        toast(`Foto fehlgeschlagen: ${err instanceof Error ? err.message : err}`);
      }
    }
    if (!v.visited) save({ visited: true, visited_at: today() });
    else void openSheet(id);
  };
  document.querySelectorAll<HTMLButtonElement>("#photos .thumb[data-id]").forEach(async (btn) => {
    const p = state.photos.get(btn.dataset.id!)!;
    btn.onclick = () => void openViewer(p);
    const src = await blobUrl(p, "thumb");
    if (src) btn.querySelector("img")!.src = src;
  });

  document.getElementById("del-custom")?.addEventListener("click", () => {
    if (!confirm("Eintrag wirklich löschen?")) return;
    const c = state.custom.get(id)!;
    saveCustom({ ...c, deleted: true });
    closeSheet();
  });

  // ----- Zusatzinfos (nachgeladen) -----
  void showNearbyPhotos(s);
  const det = await loadDetails(s);
  if (currentId !== id) return;
  const parts: string[] = [];
  if (det.kana) parts.push(`<div><b>Lesung:</b> ${esc(det.kana)}</div>`);
  if (det.deity?.length) parts.push(`<div><b>Gottheiten:</b> ${det.deity.map(esc).join("、")}</div>`);
  const links: string[] = [];
  if (det.web) links.push(`<a target="_blank" rel="noopener" href="${esc(det.web)}">Website</a>`);
  if (det.wd) {
    links.push(`<a target="_blank" rel="noopener" href="https://www.wikidata.org/wiki/${det.wd}">Wikidata</a>`);
    links.push(`<a target="_blank" rel="noopener" href="https://www.wikidata.org/wiki/Special:GoToLinkedPage/jawiki/${det.wd}">Wikipedia (ja)</a>`);
  }
  if (s.id.match(/^[nwr]\d+$/)) {
    const type = { n: "node", w: "way", r: "relation" }[s.id[0]];
    links.push(`<a target="_blank" rel="noopener" href="https://www.openstreetmap.org/${type}/${s.id.slice(1)}">OSM</a>`);
  }
  if (s.name) links.push(`<a target="_blank" rel="noopener" href="https://www.google.com/search?q=${encodeURIComponent(`${s.name} 御朱印`)}">御朱印 suchen</a>`);
  if (links.length) parts.push(`<div class="links">${links.join("")}</div>`);
  if (parts.length) document.getElementById("details")!.innerHTML = `<h3>Infos</h3>${parts.join("")}`;
}

/** Google Maps mit Suche nach dem Namen an dieser Stelle (dort sind Fotos verfügbar). */
function googlePhotosUrl(s: Shrine): string {
  return s.name
    ? `https://www.google.com/maps/search/${encodeURIComponent(s.name)}/@${s.lat},${s.lon},18z`
    : `https://www.google.com/maps/search/?api=1&query=${s.lat},${s.lon}`;
}

interface CommonsPhoto {
  title: string;
  thumb: string;
}
const nearbyCache = new Map<string, CommonsPhoto[]>();

/** Freie Fotos von Wikimedia Commons, die in der Nähe aufgenommen wurden. */
async function fetchNearby(s: Shrine): Promise<CommonsPhoto[]> {
  if (nearbyCache.has(s.id)) return nearbyCache.get(s.id)!;
  const url =
    "https://commons.wikimedia.org/w/api.php?action=query&format=json&origin=*" +
    `&generator=geosearch&ggscoord=${s.lat}|${s.lon}&ggsradius=150&ggslimit=10&ggsnamespace=6` +
    "&prop=imageinfo&iiprop=url&iiurlwidth=480";
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const data = await fetch(url).then((r) => r.json());
      if (data.error) throw new Error(data.error.code); // z. B. "too busy" -> einmal wiederholen
      const pages = Object.values(data.query?.pages ?? {}) as {
        title: string;
        index: number;
        imageinfo?: { thumburl: string }[];
      }[];
      const photos = pages
        .filter((p) => p.imageinfo?.[0]?.thumburl && /\.(jpe?g|png|webp)$/i.test(p.title))
        .sort((a, b) => a.index - b.index)
        .map((p) => ({ title: p.title, thumb: p.imageinfo![0].thumburl }));
      nearbyCache.set(s.id, photos);
      return photos;
    } catch {
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
  return [];
}

async function showNearbyPhotos(s: Shrine): Promise<void> {
  const strip = document.getElementById("nearby-strip");
  if (!strip || !navigator.onLine) return;
  const [nearby, det] = await Promise.all([fetchNearby(s), loadDetails(s)]);
  // Wikidata-Bild (meist die Haupthalle) zuerst
  const photos = [...nearby];
  if (det.img) {
    const title = `File:${decodeURIComponent(det.img)}`;
    const i = photos.findIndex((p) => p.title.replace(/_/g, " ") === title.replace(/_/g, " "));
    if (i >= 0) photos.unshift(...photos.splice(i, 1));
    else photos.unshift({ title, thumb: `https://commons.wikimedia.org/wiki/Special:FilePath/${det.img}?width=480` });
  }
  if (currentId !== s.id || !photos.length) return;
  strip.innerHTML =
    photos
      .map(
        (p) =>
          `<a target="_blank" rel="noopener" href="https://commons.wikimedia.org/wiki/${encodeURIComponent(p.title.replace(/ /g, "_"))}"><img loading="lazy" alt="" src="${esc(p.thumb)}" /></a>`,
      )
      .join("") + `<span class="nearby-credit">Fotos: Wikimedia Commons</span>`;
}

async function blobUrl(p: Photo, which: "thumb" | "full"): Promise<string | null> {
  const k = `${which}:${p.id}`;
  if (urlCache.has(k)) return urlCache.get(k)!;
  const b = await photoBlob(p, which);
  if (!b) return null;
  const u = URL.createObjectURL(b);
  urlCache.set(k, u);
  return u;
}

async function openViewer(p: Photo): Promise<void> {
  const div = document.createElement("div");
  div.className = "viewer";
  const own = p.user_id === state.userId;
  div.innerHTML = `
    <img alt="" />
    <div class="viewer-bar">
      <span>${esc(userName(p.user_id))} · ${p.created_at ? fmtDate(p.created_at.slice(0, 10)) : ""}</span>
      ${own ? `<button class="btn danger" id="v-del">Löschen</button>` : ""}
      <button class="btn" id="v-close">Schließen</button>
    </div>`;
  document.body.appendChild(div);
  const img = div.querySelector("img")!;
  img.src = (await blobUrl(p, "thumb")) ?? "";
  void blobUrl(p, "full").then((u) => u && (img.src = u));
  div.querySelector<HTMLButtonElement>("#v-close")!.onclick = () => div.remove();
  div.querySelector<HTMLButtonElement>("#v-del")?.addEventListener("click", () => {
    if (!confirm("Foto löschen?")) return;
    deletePhoto(p);
    div.remove();
    if (currentId) void openSheet(currentId);
  });
}
