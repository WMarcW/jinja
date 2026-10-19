// Laden der statischen Schreindaten (erzeugt von data-pipeline/merge.py)

export const KIND_SHRINE = 0;
export const KIND_HOKORA = 1;
export const KIND_UNNAMED = 2;
export const KIND_CUSTOM = 3;

export interface Shrine {
  id: string;
  lat: number;
  lon: number;
  name: string;
  romaji: string;
  kind: number;
  pref: number; // 0–46, -1 = unbekannt
  rank: number; // Bitfeld, siehe RANKS
  /** vorberechneter Suchtext (klein, ohne Makrons) */
  search: string;
}

export interface ShrineDetails {
  wd?: string;
  kana?: string;
  web?: string;
  deity?: string[];
  img?: string;
}

export const RANKS: { bit: number; label: string }[] = [
  { bit: 1, label: "Ichinomiya 一宮" },
  { bit: 2, label: "Beppyō-Schrein 別表神社" },
  { bit: 4, label: "Shikinaisha 式内社" },
  { bit: 8, label: "Ehem. kaiserlicher Schrein 官国幣社" },
  { bit: 16, label: "22 Schreine 二十二社" },
  { bit: 32, label: "Ise-Schrein 伊勢神宮125社" },
];

export let PREFS: string[] = [];
export const shrines = new Map<string, Shrine>();

export function searchKey(s: string): string {
  return s
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "") // Makrons entfernen
    .toLowerCase()
    .replace(/\s+/g, "");
}

export async function loadShrines(): Promise<void> {
  const res = await fetch(`${import.meta.env.BASE_URL}data/shrines.json`);
  if (!res.ok) throw new Error(`shrines.json: HTTP ${res.status}`);
  const data = (await res.json()) as { prefs: string[]; rows: [string, number, number, string, string, number, number, number][] };
  PREFS = data.prefs;
  for (const [id, lat, lon, name, romaji, kind, pref, rank] of data.rows) {
    shrines.set(id, { id, lat, lon, name, romaji, kind, pref, rank, search: searchKey(name + romaji) });
  }
}

const detailCache = new Map<number, Promise<Record<string, ShrineDetails>>>();

export async function loadDetails(s: Shrine): Promise<ShrineDetails> {
  if (s.pref < 0 || s.kind === KIND_CUSTOM) return {};
  let p = detailCache.get(s.pref);
  if (!p) {
    const file = `JP-${String(s.pref + 1).padStart(2, "0")}.json`;
    p = fetch(`${import.meta.env.BASE_URL}data/details/${file}`)
      .then((r) => (r.ok ? r.json() : {}))
      .catch(() => ({}));
    detailCache.set(s.pref, p);
  }
  return (await p)[s.id] ?? {};
}

export function displayName(s: Shrine): string {
  if (s.name) return s.name;
  if (s.kind === KIND_HOKORA) return "Hokora (namenlos)";
  return "Schrein (Name unbekannt)";
}

/** Nächsten Schrein zu einer Koordinate finden (für Präfektur eigener Schreine). */
export function nearestPref(lat: number, lon: number): number {
  let best = -1;
  let bestD = Infinity;
  for (const s of shrines.values()) {
    if (s.pref < 0) continue;
    const d = (s.lat - lat) ** 2 + (s.lon - lon) ** 2;
    if (d < bestD) {
      bestD = d;
      best = s.pref;
    }
  }
  return best;
}
