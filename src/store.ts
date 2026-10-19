// Zentraler Zustand: Besuche, Fotos, eigene Schreine, Goshuin-Infos.
// Alles wird lokal in IndexedDB gehalten (offline nutzbar) und über eine
// Warteschlange mit Supabase synchronisiert.

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { del, get, set } from "idb-keyval";

export interface Visit {
  shrine_id: string;
  user_id: string;
  visited: boolean;
  visited_at: string | null;
  goshuin: boolean;
  goshuin_at: string | null;
  note: string;
  shrine_name: string;
  lat: number | null;
  lon: number | null;
  updated_at?: string;
}

export interface Photo {
  id: string;
  shrine_id: string;
  user_id: string;
  path: string;
  thumb_path: string;
  bytes: number;
  deleted: boolean;
  created_at?: string;
  updated_at?: string;
}

export interface CustomShrine {
  id: string;
  name: string;
  lat: number;
  lon: number;
  pref: number | null;
  created_by: string;
  deleted: boolean;
  updated_at?: string;
}

export interface GoshuinInfo {
  shrine_id: string;
  available: boolean | null;
  note: string;
  name: string;
  updated_by?: string | null;
  updated_at?: string;
}

type Op =
  | { type: "visit"; row: Visit }
  | { type: "photo"; row: Photo }
  | { type: "photoUpdate"; row: Photo }
  | { type: "custom"; row: CustomShrine }
  | { type: "goshuinInfo"; row: GoshuinInfo };

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const key = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

/** Ohne Supabase-Konfiguration läuft die App rein lokal (zum Testen). */
export const localMode = !url || !key;
export const supabase: SupabaseClient | null = localMode ? null : createClient(url!, key!);
const LOCAL_USER = "local";

export const state = {
  userId: "",
  email: "",
  profiles: new Map<string, string>(),
  visits: new Map<string, Visit>(), // key: shrine|user
  photos: new Map<string, Photo>(),
  custom: new Map<string, CustomShrine>(),
  goshuinInfo: new Map<string, GoshuinInfo>(),
  queue: [] as Op[],
  lastSync: {} as Record<string, string>,
  syncing: false,
  online: navigator.onLine,
  lastError: "",
};

// ---------- Ereignisse ----------
type Listener = () => void;
const listeners = new Set<Listener>();
export function onChange(fn: Listener): void {
  listeners.add(fn);
}
function emit(): void {
  for (const fn of listeners) fn();
}

// ---------- Persistenz ----------
let saveTimer: number | undefined;
function persist(): void {
  clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    void set("state", {
      userId: state.userId,
      profiles: [...state.profiles],
      visits: [...state.visits.values()],
      photos: [...state.photos.values()],
      custom: [...state.custom.values()],
      goshuinInfo: [...state.goshuinInfo.values()],
      queue: state.queue,
      lastSync: state.lastSync,
    });
  }, 300);
}

async function restore(): Promise<void> {
  const s = await get("state");
  if (!s || (state.userId && s.userId !== state.userId)) return;
  state.profiles = new Map(s.profiles);
  state.visits = new Map(s.visits.map((v: Visit) => [vkey(v.shrine_id, v.user_id), v]));
  state.photos = new Map(s.photos.map((p: Photo) => [p.id, p]));
  state.custom = new Map(s.custom.map((c: CustomShrine) => [c.id, c]));
  state.goshuinInfo = new Map(s.goshuinInfo.map((g: GoshuinInfo) => [g.shrine_id, g]));
  state.queue = s.queue ?? [];
  state.lastSync = s.lastSync ?? {};
}

// ---------- Anmeldung ----------
export async function initAuth(): Promise<boolean> {
  if (localMode) {
    state.userId = LOCAL_USER;
    state.email = "lokal";
    state.profiles.set(LOCAL_USER, "Ich");
    await restore();
    return true;
  }
  const { data } = await supabase!.auth.getSession();
  if (!data.session) return false;
  state.userId = data.session.user.id;
  state.email = data.session.user.email ?? "";
  await restore();
  return true;
}

export async function login(email: string, password: string): Promise<string | null> {
  const { data, error } = await supabase!.auth.signInWithPassword({ email, password });
  if (error) return error.message;
  state.userId = data.user.id;
  state.email = data.user.email ?? "";
  await restore();
  return null;
}

export async function logout(): Promise<void> {
  await supabase?.auth.signOut();
  await del("state");
  location.reload();
}

// ---------- Zugriff ----------
export const vkey = (shrine: string, user: string) => `${shrine}|${user}`;

export function myVisit(shrineId: string): Visit | undefined {
  return state.visits.get(vkey(shrineId, state.userId));
}

export function visitsFor(shrineId: string): Visit[] {
  const out: Visit[] = [];
  for (const uid of userIds()) {
    const v = state.visits.get(vkey(shrineId, uid));
    if (v) out.push(v);
  }
  return out;
}

export function userIds(): string[] {
  const ids = new Set<string>([state.userId, ...state.profiles.keys()]);
  return [...ids];
}

export function partnerId(): string | undefined {
  return userIds().find((id) => id !== state.userId);
}

export function userName(id: string): string {
  if (id === state.userId) return "Ich";
  return state.profiles.get(id) || "Partner";
}

export function photosFor(shrineId: string): Photo[] {
  return [...state.photos.values()]
    .filter((p) => p.shrine_id === shrineId && !p.deleted)
    .sort((a, b) => (a.created_at ?? "").localeCompare(b.created_at ?? ""));
}

// ---------- Änderungen ----------
function enqueue(op: Op): void {
  if (localMode) {
    // ohne Server nur lokal speichern
    persist();
    emit();
    return;
  }
  // ältere, noch nicht gesendete Änderungen am selben Datensatz ersetzen
  const id = opId(op);
  state.queue = state.queue.filter((o) => o.type === "photo" || opId(o) !== id);
  state.queue.push(op);
  persist();
  emit();
  void sync();
}

function opId(op: Op): string {
  switch (op.type) {
    case "visit": return `v:${op.row.shrine_id}`;
    case "photo": return `p:${op.row.id}`;
    case "photoUpdate": return `pu:${op.row.id}`;
    case "custom": return `c:${op.row.id}`;
    case "goshuinInfo": return `g:${op.row.shrine_id}`;
  }
}

export function saveVisit(v: Visit): void {
  v.updated_at = new Date().toISOString();
  state.visits.set(vkey(v.shrine_id, v.user_id), v);
  enqueue({ type: "visit", row: v });
}

export async function addPhoto(shrineId: string, full: Blob, thumb: Blob): Promise<void> {
  const id = crypto.randomUUID();
  const dir = `${state.userId}/${safe(shrineId)}`;
  const p: Photo = {
    id,
    shrine_id: shrineId,
    user_id: state.userId,
    path: `${dir}/${id}.jpg`,
    thumb_path: `${dir}/${id}_t.jpg`,
    bytes: full.size + thumb.size,
    deleted: false,
    created_at: new Date().toISOString(),
  };
  await set(`full:${id}`, full);
  await set(`thumb:${id}`, thumb);
  state.photos.set(id, p);
  enqueue({ type: "photo", row: p });
}

export function deletePhoto(p: Photo): void {
  p.deleted = true;
  state.photos.set(p.id, p);
  void del(`full:${p.id}`);
  void del(`thumb:${p.id}`);
  // noch nicht hochgeladen? Dann nur aus der Warteschlange nehmen
  const pending = state.queue.some((o) => o.type === "photo" && o.row.id === p.id);
  if (pending) {
    state.queue = state.queue.filter((o) => !(o.type === "photo" && o.row.id === p.id));
    state.photos.delete(p.id);
    persist();
    emit();
  } else {
    enqueue({ type: "photoUpdate", row: p });
  }
}

export function saveCustom(c: CustomShrine): void {
  state.custom.set(c.id, c);
  enqueue({ type: "custom", row: c });
}

export function saveGoshuinInfo(g: GoshuinInfo): void {
  g.updated_by = state.userId;
  state.goshuinInfo.set(g.shrine_id, g);
  enqueue({ type: "goshuinInfo", row: g });
}

function safe(s: string): string {
  return s.replace(/[^A-Za-z0-9_-]/g, "_");
}

// ---------- Fotos lesen ----------
export async function photoBlob(p: Photo, which: "thumb" | "full"): Promise<Blob | null> {
  const cacheKey = `${which}:${p.id}`;
  const cached = await get<Blob>(cacheKey);
  if (cached) return cached;
  if (!supabase) return null;
  const { data, error } = await supabase.storage.from("photos").download(which === "thumb" ? p.thumb_path : p.path);
  if (error || !data) return null;
  if (which === "thumb") await set(cacheKey, data); // nur Thumbnails dauerhaft cachen
  return data;
}

// ---------- Synchronisierung ----------
const TABLES = ["profiles", "visits", "photos", "custom_shrines", "goshuin_info"] as const;

export async function sync(): Promise<void> {
  if (localMode || state.syncing || !navigator.onLine || !state.userId) return;
  state.syncing = true;
  emit();
  try {
    await push();
    await pull();
    state.lastError = "";
  } catch (e) {
    state.lastError = e instanceof Error ? e.message : String(e);
    console.warn("Sync-Fehler", e);
  } finally {
    state.syncing = false;
    persist();
    emit();
  }
}

async function push(): Promise<void> {
  const sb = supabase!;
  while (state.queue.length) {
    const op = state.queue[0];
    const { updated_at: _u, ...row } = op.row as unknown as Record<string, unknown>;
    let error: { message: string } | null = null;
    if (op.type === "visit") {
      ({ error } = await sb.from("visits").upsert(row));
    } else if (op.type === "photo") {
      const full = await get<Blob>(`full:${op.row.id}`);
      const thumb = await get<Blob>(`thumb:${op.row.id}`);
      if (full && thumb) {
        const up1 = await sb.storage.from("photos").upload(op.row.path, full, { contentType: "image/jpeg", upsert: true });
        const up2 = await sb.storage.from("photos").upload(op.row.thumb_path, thumb, { contentType: "image/jpeg", upsert: true });
        error = up1.error ?? up2.error;
        if (!error) ({ error } = await sb.from("photos").upsert(row));
        if (!error) await del(`full:${op.row.id}`); // Original nicht mehr lokal nötig
      }
    } else if (op.type === "photoUpdate") {
      ({ error } = await sb.from("photos").upsert(row));
      if (!error && op.row.deleted) {
        await sb.storage.from("photos").remove([op.row.path, op.row.thumb_path]);
      }
    } else if (op.type === "custom") {
      ({ error } = await sb.from("custom_shrines").upsert(row));
    } else if (op.type === "goshuinInfo") {
      ({ error } = await sb.from("goshuin_info").upsert(row));
    }
    if (error) throw new Error(error.message);
    state.queue.shift();
    persist();
  }
}

async function pull(): Promise<void> {
  const sb = supabase!;
  for (const table of TABLES) {
    // Nur Server-Zeitstempel als Sync-Stand verwenden (nie die Geräteuhr)
    for (;;) {
      let q = sb.from(table).select("*").limit(1000);
      if (table !== "profiles") {
        q = q.order("updated_at", { ascending: true });
        if (state.lastSync[table]) q = q.gt("updated_at", state.lastSync[table]);
      }
      const { data, error } = await q;
      if (error) throw new Error(error.message);
      for (const r of data ?? []) apply(table, r);
      if (table !== "profiles" && data?.length) state.lastSync[table] = data[data.length - 1].updated_at;
      if (table === "profiles" || !data || data.length < 1000) break;
    }
  }
}

function apply(table: string, r: any): void {
  // lokale, noch nicht gesendete Änderungen haben Vorrang
  const pendingIds = new Set(state.queue.map(opId));
  switch (table) {
    case "profiles":
      state.profiles.set(r.id, r.display_name);
      break;
    case "visits":
      if (r.user_id === state.userId && pendingIds.has(`v:${r.shrine_id}`)) return;
      state.visits.set(vkey(r.shrine_id, r.user_id), r);
      break;
    case "photos":
      if (pendingIds.has(`pu:${r.id}`)) return;
      state.photos.set(r.id, r);
      break;
    case "custom_shrines":
      if (pendingIds.has(`c:${r.id}`)) return;
      state.custom.set(r.id, r);
      break;
    case "goshuin_info":
      if (pendingIds.has(`g:${r.shrine_id}`)) return;
      state.goshuinInfo.set(r.shrine_id, r);
      break;
  }
}

export async function storageUsage(): Promise<number> {
  if (!supabase) return 0;
  const { data } = await supabase.rpc("storage_usage");
  return Number(data ?? 0);
}

export async function setDisplayName(name: string): Promise<void> {
  state.profiles.set(state.userId, name);
  persist();
  emit();
  if (supabase) await supabase.from("profiles").update({ display_name: name }).eq("id", state.userId);
}

// ---------- Auto-Sync ----------
export function startAutoSync(): void {
  window.addEventListener("online", () => {
    state.online = true;
    emit();
    void sync();
  });
  window.addEventListener("offline", () => {
    state.online = false;
    emit();
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") void sync();
  });
  window.setInterval(() => void sync(), 60_000);
  void sync();
}

/** Export aller eigenen Daten als JSON (Backup, ohne Fotodateien). */
export function exportJson(): string {
  return JSON.stringify(
    {
      exported_at: new Date().toISOString(),
      visits: [...state.visits.values()],
      photos: [...state.photos.values()].filter((p) => !p.deleted),
      custom_shrines: [...state.custom.values()].filter((c) => !c.deleted),
      goshuin_info: [...state.goshuinInfo.values()],
    },
    null,
    2,
  );
}
