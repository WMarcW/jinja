import "./style.css";
import { registerSW } from "virtual:pwa-register";
import { loadShrines, nearestPref } from "./data";
import { closeSheet, currentShrine, openSheet } from "./detail";
import { initMap, locate, markTemp, refreshMap } from "./map";
import { loadFilters, openFilterPanel, openStatsPanel } from "./panels";
import { openRoutesPanel, render as renderRoute } from "./routes";
import { initSearch } from "./search";
import { initAuth, localMode, login, onChange, saveCustom, startAutoSync, state } from "./store";
import { toast } from "./ui";

registerSW({ immediate: true });

const $ = (id: string) => document.getElementById(id)!;

async function boot(): Promise<void> {
  const loggedIn = await initAuth();
  if (!loggedIn) {
    $("loading").hidden = true;
    await showLogin();
  }
  $("loading").hidden = false;
  await loadShrines();
  loadFilters();
  await initMap((id) => void openSheet(id), addCustomShrine);
  $("loading").hidden = true;

  initSearch((id) => void openSheet(id));
  $("btn-filter").onclick = openFilterPanel;
  $("btn-stats").onclick = openStatsPanel;
  $("btn-routes").onclick = openRoutesPanel;
  $("btn-locate").onclick = locate;

  onChange(() => {
    refreshMap();
    updateBadge();
    renderRoute(); // z. B. Route vom Partner geändert
    // offenes Sheet aktualisieren, außer der Nutzer tippt gerade darin
    const id = currentShrine();
    if (id && !$("sheet").contains(document.activeElement)) void openSheet(id);
  });
  updateBadge();
  startAutoSync();
}

function showLogin(): Promise<void> {
  $("login").hidden = false;
  return new Promise((resolve) => {
    ($("login-form") as HTMLFormElement).onsubmit = async (e) => {
      e.preventDefault();
      const email = ($("login-email") as HTMLInputElement).value.trim();
      const pw = ($("login-password") as HTMLInputElement).value;
      $("login-error").textContent = "";
      const err = await login(email, pw);
      if (err) {
        $("login-error").textContent = err === "Invalid login credentials" ? "E-Mail oder Passwort falsch" : err;
        return;
      }
      $("login").hidden = true;
      resolve();
    };
  });
}

function addCustomShrine(lngLat: { lat: number; lng: number }): void {
  const marker = markTemp(lngLat.lat, lngLat.lng);
  // kurz warten, damit der Marker sichtbar ist, bevor der Dialog kommt
  window.setTimeout(() => {
    const name = prompt("Fehlenden Schrein hier hinzufügen?\nName:");
    marker.remove();
    if (!name?.trim()) return;
    const id = `c${crypto.randomUUID()}`;
    saveCustom({
      id,
      name: name.trim(),
      lat: lngLat.lat,
      lon: lngLat.lng,
      pref: nearestPref(lngLat.lat, lngLat.lng),
      created_by: state.userId,
      deleted: false,
    });
    toast("Schrein hinzugefügt");
    window.setTimeout(() => void openSheet(id), 50);
  }, 100);
}

function updateBadge(): void {
  const el = $("sync-badge");
  if (localMode) {
    el.hidden = true;
    return;
  }
  if (!state.online) {
    el.textContent = state.queue.length ? `Offline · ${state.queue.length} ausstehend` : "Offline";
    el.hidden = false;
  } else if (state.queue.length) {
    el.textContent = `Synchronisiere ${state.queue.length} …`;
    el.hidden = false;
  } else if (state.lastError) {
    el.textContent = "Sync-Fehler";
    el.hidden = false;
  } else {
    el.hidden = true;
  }
}

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeSheet();
});

boot().catch((e) => {
  console.error(e);
  $("loading-text").textContent = `Fehler beim Laden: ${e instanceof Error ? e.message : e}`;
});
