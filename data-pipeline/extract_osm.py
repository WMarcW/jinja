"""Extrahiert alle Shinto-Schreine aus dem Geofabrik-Japan-Extrakt (OSM, ODbL).

Vorher herunterladen (≈2,5 GB, täglich aktualisiert):
  curl -L -o raw/japan-latest.osm.pbf https://download.geofabrik.de/asia/japan-latest.osm.pbf

Ergebnis: raw/osm_all.json im Overpass-ähnlichen Format
  {"elements": [{"type", "id", "lat"/"lon" | "center", "tags"}, ...]}
Flächen (Ways/Relationen) werden auf den Mittelpunkt ihrer Knoten reduziert.
"""
import json
import re
import sys
import time
from pathlib import Path

import osmium

RAW = Path(__file__).parent / "raw"
PBF = RAW / "japan-latest.osm.pbf"
OUT = RAW / "osm_all.json"

SHRINE_NAME = re.compile(r"(神社|神宮|宮|社|稲荷|八幡|権現|明神|天神|荒神|大神|祠|大社|天満宮|八幡宮)$")


def matches(tags) -> bool:
    rel = tags.get("religion")
    amenity = tags.get("amenity")
    if amenity == "place_of_worship" and rel == "shinto":
        return True
    if tags.get("historic") == "wayside_shrine" and rel == "shinto":
        return True
    name = tags.get("name", "")
    if amenity == "place_of_worship" and rel is None and SHRINE_NAME.search(name):
        return True
    # z. B. Fushimi Inari: landuse=religious + religion=shinto + tourism=yes
    if rel == "shinto" and name and amenity is None and "historic" not in tags and "man_made" not in tags:
        return True
    # Schreingebäude ohne weitere Tags (oft aus GSI-Importen)
    if tags.get("building") == "shrine" and rel in (None, "shinto") and amenity is None \
            and "historic" not in tags and SHRINE_NAME.search(name):
        return True
    return False


def centroid(coords):
    if not coords:
        return None
    return {"lat": round(sum(c[0] for c in coords) / len(coords), 7),
            "lon": round(sum(c[1] for c in coords) / len(coords), 7)}


def main() -> None:
    if not PBF.exists():
        sys.exit(f"{PBF} fehlt – siehe Docstring")
    t0 = time.time()
    key_filter = osmium.filter.KeyFilter("religion", "amenity", "historic", "building")

    # 1) Relationen (Multipolygone) finden und ihre äußeren Ways merken
    rels = {}
    for r in osmium.FileProcessor(str(PBF), osmium.osm.RELATION).with_filter(key_filter):
        if matches(r.tags):
            rels[r.id] = {"tags": dict(r.tags), "ways": [m.ref for m in r.members if m.type == "w"]}
    print(f"Relationen: {len(rels)} ({time.time() - t0:.0f}s)", flush=True)
    member_ways = {w for r in rels.values() for w in r["ways"]}

    # 2) Knoten und Ways (Koordinaten-Index wird vor den Filtern befüllt,
    #    die Filter laufen in C++ und halten Python-Iterationen klein)
    elements = []
    fp = (osmium.FileProcessor(str(PBF), osmium.osm.NODE | osmium.osm.WAY)
          .with_locations()
          .with_filter(osmium.filter.EmptyTagFilter())
          .with_filter(key_filter))
    for o in fp:
        if not matches(o.tags):
            continue
        if o.is_node():
            elements.append({"type": "node", "id": o.id, "lat": round(o.location.lat, 7),
                             "lon": round(o.location.lon, 7), "tags": dict(o.tags)})
        else:
            c = centroid([(n.lat, n.lon) for n in o.nodes if n.location.valid()])
            if c:
                elements.append({"type": "way", "id": o.id, "center": c, "tags": dict(o.tags)})
    print(f"Knoten+Ways: {len(elements)} ({time.time() - t0:.0f}s)", flush=True)

    # 3) Äußere Ways der Relationen (oft ohne eigene Tags)
    way_coords = {}
    if member_ways:
        fp = (osmium.FileProcessor(str(PBF), osmium.osm.NODE | osmium.osm.WAY)
              .with_locations()
              .with_filter(osmium.filter.EntityFilter(osmium.osm.WAY))
              .with_filter(osmium.filter.IdFilter(member_ways)))
        for w in fp:
            way_coords[w.id] = [(n.lat, n.lon) for n in w.nodes if n.location.valid()]
        print(f"Relations-Ways: {len(way_coords)} ({time.time() - t0:.0f}s)", flush=True)

    for rid, r in rels.items():
        coords = [c for w in r["ways"] for c in way_coords.get(w, [])]
        c = centroid(coords)
        if c:
            elements.append({"type": "relation", "id": rid, "center": c, "tags": r["tags"]})

    OUT.write_text(json.dumps({"elements": elements}, ensure_ascii=False), encoding="utf-8")
    print(f"Fertig: {len(elements)} Elemente in {time.time() - t0:.0f}s")


if __name__ == "__main__":
    main()
