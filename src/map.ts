// Karte mit MapLibre + OpenFreeMap, Schreine als geclusterte GeoJSON-Punkte.

import * as maplibregl from "maplibre-gl";
import type { GeoJSONSource, Map as MLMap } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import workerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?url";
import { KIND_CUSTOM, KIND_HOKORA, KIND_SHRINE, KIND_UNNAMED, searchKey, shrines, type Shrine } from "./data";
import { partnerId, state, vkey, type CustomShrine } from "./store";

export type Who = "me" | "partner" | "both";
export type StatusFilter = "all" | "open" | "visited" | "goshuin";

export const filters = {
  who: "both" as Who,
  status: "all" as StatusFilter,
  showHokora: true,
  showUnnamed: true,
  onlyRanked: false,
};

export const ST_OPEN = 0;
export const ST_VISITED = 1;
export const ST_GOSHUIN = 2;

const COLORS = { open: "#ffffff", visited: "#b7282e", goshuin: "#d4a017", stroke: "#7a1a1f", grey: "#8a8f98" };

let map: MLMap;
let geolocate: maplibregl.GeolocateControl;

/** Status eines Schreins für die aktuelle Personen-Auswahl. */
export function statusOf(id: string, who: Who = filters.who): number {
  const users = who === "me" ? [state.userId] : who === "partner" ? [partnerId() ?? ""] : [state.userId, partnerId() ?? ""];
  let st = ST_OPEN;
  for (const u of users) {
    const v = state.visits.get(vkey(id, u));
    if (!v) continue;
    if (v.goshuin) return ST_GOSHUIN;
    if (v.visited) st = ST_VISITED;
  }
  return st;
}

function customToShrine(c: CustomShrine): Shrine {
  return { id: c.id, lat: c.lat, lon: c.lon, name: c.name, romaji: "", kind: KIND_CUSTOM, pref: c.pref ?? -1, rank: 0, search: searchKey(c.name) };
}

/** Selbst ergänzten Namen (für namenlose Kartensymbole) anwenden. */
function withName(s: Shrine): Shrine {
  const n = state.goshuinInfo.get(s.id)?.name;
  return n && !s.name ? { ...s, name: n, search: searchKey(n) } : s;
}

export function getShrine(id: string): Shrine | undefined {
  const s = shrines.get(id);
  if (s) return withName(s);
  const c = state.custom.get(id);
  return c && !c.deleted ? customToShrine(c) : undefined;
}

/** Alle Schreine (statisch + eigene). */
export function allShrines(): Shrine[] {
  const list = [...shrines.values()].map((s) => (s.name ? s : withName(s)));
  for (const c of state.custom.values()) if (!c.deleted) list.push(customToShrine(c));
  return list;
}

function visible(s: Shrine, st: number): boolean {
  if (s.kind === KIND_HOKORA && !filters.showHokora) return false;
  if (s.kind === KIND_UNNAMED && !s.name && !filters.showUnnamed) return false;
  if (filters.onlyRanked && !s.rank) return false;
  switch (filters.status) {
    case "open": return st === ST_OPEN;
    case "visited": return st >= ST_VISITED;
    case "goshuin": return st === ST_GOSHUIN;
    default: return true;
  }
}

function buildGeoJSON(): GeoJSON.FeatureCollection {
  const features: GeoJSON.Feature[] = [];
  for (const s of allShrines()) {
    const st = statusOf(s.id);
    // selbst benannte Kartensymbole wie normale Schreine darstellen
    const kind = s.kind === KIND_UNNAMED && s.name ? KIND_SHRINE : s.kind;
    if (!visible(s, st)) continue;
    features.push({
      type: "Feature",
      geometry: { type: "Point", coordinates: [s.lon, s.lat] },
      properties: { id: s.id, st, k: kind, r: s.rank ? 1 : 0, n: s.name },
    });
  }
  return { type: "FeatureCollection", features };
}

let refreshTimer: number | undefined;
export function refreshMap(): void {
  clearTimeout(refreshTimer);
  refreshTimer = window.setTimeout(() => {
    const src = map?.getSource("shrines") as GeoJSONSource | undefined;
    src?.setData(buildGeoJSON());
  }, 150);
}

export function initMap(onSelect: (id: string) => void, onLongPress: (lngLat: maplibregl.LngLat) => void): Promise<void> {
  // Worker als eigenes Asset ausliefern (Vite bündelt ihn sonst nicht mit)
  maplibregl.setWorkerUrl(workerUrl);
  map = new maplibregl.Map({
    container: "map",
    style: "https://tiles.openfreemap.org/styles/liberty",
    bounds: [[128.5, 30.5], [146.0, 45.6]], // Hauptinseln Japans
    fitBoundsOptions: { padding: 10 },
    maxPitch: 0,
    attributionControl: false,
    localIdeographFontFamily: "'Hiragino Sans', 'Noto Sans JP', sans-serif",
  });
  map.dragRotate.disable();
  map.touchZoomRotate.disableRotation();
  map.addControl(
    new maplibregl.AttributionControl({
      compact: true,
      customAttribution: [
        "Schreine: © OpenStreetMap-Mitwirkende (ODbL)",
        "Wikidata (CC0)",
        "国土地理院最適化ベクトルタイル",
      ],
    }),
  );
  geolocate = new maplibregl.GeolocateControl({
    positionOptions: { enableHighAccuracy: true },
    trackUserLocation: true,
    showAccuracyCircle: false,
  });
  map.addControl(geolocate, "bottom-right");

  return new Promise((resolve) => {
    map.on("load", () => {
      // Quellenhinweis eingeklappt starten (ⓘ zum Aufklappen)
      document.querySelector(".maplibregl-ctrl-attrib")?.classList.remove("maplibregl-compact-show");
      map.addSource("shrines", {
        type: "geojson",
        data: buildGeoJSON(),
        cluster: true,
        clusterMaxZoom: 12,
        clusterRadius: 45,
        clusterProperties: {
          v: ["+", ["case", [">=", ["get", "st"], ST_VISITED], 1, 0]],
        },
      });

      map.addLayer({
        id: "clusters",
        type: "circle",
        source: "shrines",
        filter: ["has", "point_count"],
        paint: {
          "circle-color": [
            "case",
            [">", ["get", "v"], 0],
            ["interpolate", ["linear"], ["/", ["get", "v"], ["get", "point_count"]], 0, "#d98a8d", 0.5, COLORS.visited, 1, "#7a1a1f"],
            COLORS.grey,
          ],
          "circle-radius": ["step", ["get", "point_count"], 14, 50, 18, 500, 23, 3000, 29],
          "circle-stroke-width": 2,
          "circle-stroke-color": "#ffffff",
          "circle-opacity": 0.9,
        },
      });
      map.addLayer({
        id: "cluster-count",
        type: "symbol",
        source: "shrines",
        filter: ["has", "point_count"],
        layout: {
          "text-field": [
            "case",
            [">", ["get", "v"], 0],
            ["concat", ["to-string", ["get", "v"]], "/", ["get", "point_count_abbreviated"]],
            ["get", "point_count_abbreviated"],
          ],
          "text-font": ["Noto Sans Bold"],
          "text-size": 11,
          "text-allow-overlap": true,
        },
        paint: { "text-color": "#ffffff" },
      });
      map.addLayer({
        id: "points",
        type: "circle",
        source: "shrines",
        filter: ["!", ["has", "point_count"]],
        paint: {
          "circle-radius": [
            "interpolate", ["linear"], ["zoom"],
            8, ["case", ["==", ["get", "r"], 1], 6, ["==", ["get", "k"], KIND_SHRINE], 4, 3],
            15, ["case", ["==", ["get", "r"], 1], 11, ["==", ["get", "k"], KIND_SHRINE], 8, 6],
          ],
          "circle-color": ["match", ["get", "st"], ST_GOSHUIN, COLORS.goshuin, ST_VISITED, COLORS.visited, COLORS.open],
          "circle-stroke-width": ["case", ["==", ["get", "r"], 1], 3, 2],
          "circle-stroke-color": [
            "case",
            ["==", ["get", "k"], KIND_CUSTOM], "#2a6fdb",
            ["any", ["==", ["get", "k"], KIND_HOKORA], ["==", ["get", "k"], KIND_UNNAMED]], COLORS.grey,
            COLORS.stroke,
          ],
        },
      });
      map.addLayer({
        id: "labels",
        type: "symbol",
        source: "shrines",
        minzoom: 13,
        filter: ["!", ["has", "point_count"]],
        layout: {
          "text-field": ["get", "n"],
          "text-font": ["Noto Sans Regular"],
          "text-size": 12,
          "text-offset": [0, 1.1],
          "text-anchor": "top",
          "text-optional": true,
        },
        paint: { "text-color": "#5b1013", "text-halo-color": "#ffffff", "text-halo-width": 1.5 },
      });

      // Route: Luftlinie zwischen den Stopps + nummerierte Marker
      map.addSource("route", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
      map.addLayer({
        id: "route-line",
        type: "line",
        source: "route",
        filter: ["==", ["geometry-type"], "LineString"],
        layout: { "line-join": "round", "line-cap": "round" },
        paint: { "line-color": "#2a6fdb", "line-width": 4, "line-opacity": 0.85, "line-dasharray": [2, 1.5] },
      });
      map.addLayer({
        id: "route-stops",
        type: "circle",
        source: "route",
        filter: ["==", ["geometry-type"], "Point"],
        paint: { "circle-radius": 12, "circle-color": "#2a6fdb", "circle-stroke-width": 2.5, "circle-stroke-color": "#ffffff" },
      });
      map.addLayer({
        id: "route-numbers",
        type: "symbol",
        source: "route",
        filter: ["==", ["geometry-type"], "Point"],
        layout: { "text-field": ["to-string", ["get", "n"]], "text-font": ["Noto Sans Bold"], "text-size": 12, "text-allow-overlap": true, "text-ignore-placement": true },
        paint: { "text-color": "#ffffff" },
      });
      map.on("click", "route-stops", (e) => onSelect(e.features![0].properties!.id));

      map.on("click", "clusters", async (e) => {
        const f = e.features![0];
        const src = map.getSource("shrines") as GeoJSONSource;
        const zoom = await src.getClusterExpansionZoom(f.properties!.cluster_id);
        map.easeTo({ center: (f.geometry as GeoJSON.Point).coordinates as [number, number], zoom });
      });
      map.on("click", "points", (e) => onSelect(e.features![0].properties!.id));
      for (const l of ["clusters", "points"]) {
        map.on("mouseenter", l, () => (map.getCanvas().style.cursor = "pointer"));
        map.on("mouseleave", l, () => (map.getCanvas().style.cursor = ""));
      }
      setupLongPress(onLongPress);
      resolve();
    });
  });
}

function setupLongPress(cb: (lngLat: maplibregl.LngLat) => void): void {
  let timer: number | undefined;
  let start: { x: number; y: number } | null = null;
  const cancel = () => {
    clearTimeout(timer);
    start = null;
  };
  map.on("touchstart", (e) => {
    if (e.originalEvent.touches.length !== 1) return cancel();
    start = { x: e.point.x, y: e.point.y };
    const lngLat = e.lngLat;
    timer = window.setTimeout(() => {
      if (start) cb(lngLat);
    }, 650);
  });
  map.on("touchmove", (e) => {
    if (start && Math.hypot(e.point.x - start.x, e.point.y - start.y) > 10) cancel();
  });
  map.on("touchend", cancel);
  map.on("touchcancel", cancel);
  map.on("contextmenu", (e) => cb(e.lngLat)); // Desktop: Rechtsklick
}

/** Route auf der Karte zeigen (leere Liste = ausblenden). */
export function setRouteLine(stops: Shrine[]): void {
  const features: GeoJSON.Feature[] = stops.map((s, i) => ({
    type: "Feature",
    geometry: { type: "Point", coordinates: [s.lon, s.lat] },
    properties: { n: i + 1, id: s.id },
  }));
  if (stops.length > 1) {
    features.unshift({
      type: "Feature",
      geometry: { type: "LineString", coordinates: stops.map((s) => [s.lon, s.lat]) },
      properties: {},
    });
  }
  (map?.getSource("route") as GeoJSONSource | undefined)?.setData({ type: "FeatureCollection", features });
}

/** Karte so zoomen, dass alle Punkte sichtbar sind (Platz unten für die Routenleiste). */
export function fitPoints(points: Shrine[]): void {
  if (!points.length) return;
  if (points.length === 1) return flyTo(points[0].lat, points[0].lon, 14);
  const b = new maplibregl.LngLatBounds();
  for (const p of points) b.extend([p.lon, p.lat]);
  map.fitBounds(b, { padding: { top: 90, bottom: window.innerHeight * 0.42, left: 40, right: 70 }, maxZoom: 15 });
}

export function flyTo(lat: number, lon: number, zoom = 15): void {
  map.flyTo({ center: [lon, lat], zoom: Math.max(map.getZoom(), zoom), speed: 1.6 });
}

export function locate(): void {
  geolocate.trigger();
}

export function mapCenter(): { lat: number; lon: number } {
  const c = map.getCenter();
  return { lat: c.lat, lon: c.lng };
}

export function markTemp(lat: number, lon: number): maplibregl.Marker {
  return new maplibregl.Marker({ color: "#2a6fdb" }).setLngLat([lon, lat]).addTo(map);
}
