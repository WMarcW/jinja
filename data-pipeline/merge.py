"""Führt OSM-, Wikidata- und GSI-Daten zu einer deduplizierten Schreinliste zusammen.

Eingaben:  raw/osm/JP-xx.json, raw/wikidata.json, raw/gsi.json (optional)
Ausgaben:  ../public/data/shrines.json          (kompakte Liste für die Karte)
           ../public/data/details/JP-xx.json    (Zusatzinfos, nachgeladen)
           raw/report.txt                       (Statistik zur Plausibilitätsprüfung)
"""
import json
import math
import re
import unicodedata
from collections import Counter, defaultdict
from datetime import date
from pathlib import Path

import pykakasi
from rapidfuzz.distance import JaroWinkler

HERE = Path(__file__).parent
RAW = HERE / "raw"
PUBLIC = HERE.parent / "public" / "data"

PREFS = [
    "Hokkaidō", "Aomori", "Iwate", "Miyagi", "Akita", "Yamagata", "Fukushima", "Ibaraki",
    "Tochigi", "Gunma", "Saitama", "Chiba", "Tōkyō", "Kanagawa", "Niigata", "Toyama",
    "Ishikawa", "Fukui", "Yamanashi", "Nagano", "Gifu", "Shizuoka", "Aichi", "Mie",
    "Shiga", "Kyōto", "Ōsaka", "Hyōgo", "Nara", "Wakayama", "Tottori", "Shimane",
    "Okayama", "Hiroshima", "Yamaguchi", "Tokushima", "Kagawa", "Ehime", "Kōchi", "Fukuoka",
    "Saga", "Nagasaki", "Kumamoto", "Ōita", "Miyazaki", "Kagoshima", "Okinawa",
]

# Rang-Bits (siehe src/data.ts)
R_ICHINOMIYA, R_BEPPYO, R_SHIKINAI, R_KANSHA, R_22, R_ISE = 1, 2, 4, 8, 16, 32
KANSHA = {"Kanpei Taisha", "Kanpei Chūsha", "Kanpei Shōsha", "Kokuhei Taisha",
          "Kokuhei Chūsha", "Kokuhei Shōsha", "Bekkaku Kanpeisha"}

SUB_BUILDING = re.compile(
    r"(本殿|拝殿|幣殿|社務所|神楽殿|鳥居|手水舎|授与所|参集殿|神饌所|祓所|絵馬殿|宝物殿|社殿|"
    r"門|受付|儀式殿|斎館|祈祷殿|祈祷所|待合所|休憩所|駐車場|参道|舞殿|神輿庫|御朱印所)$")
KIND_SHRINE, KIND_HOKORA, KIND_UNNAMED = 0, 1, 2

kks = pykakasi.kakasi()


# ---------- Hilfsfunktionen ----------
def dist(a_lat, a_lon, b_lat, b_lon) -> float:
    """Entfernung in Metern (equirectangular, für kurze Distanzen ausreichend)."""
    x = math.radians(b_lon - a_lon) * math.cos(math.radians((a_lat + b_lat) / 2))
    y = math.radians(b_lat - a_lat)
    return 6371000 * math.hypot(x, y)


OLD_NEW = str.maketrans("神社宮國櫻澤濱龍廣靈藏嶋", "神社宮国桜沢浜竜広霊蔵島")
PREFIX = re.compile(r"^(村社|郷社|県社|府社|無格社|指定村社|旧村社)")


def norm(name: str) -> str:
    if not name:
        return ""
    s = unicodedata.normalize("NFKC", name)
    s = re.sub(r"[\s・（）()「」『』]", "", s)
    s = PREFIX.sub("", s).translate(OLD_NEW)
    s = re.sub(r"(神社|大社|神宮|社|宮)$", "", s)
    return s


def similar(a: str, b: str) -> float:
    a, b = norm(a), norm(b)
    if not a or not b:
        return 0.0
    if a == b:
        return 1.0
    return JaroWinkler.similarity(a, b)


def romaji(text: str) -> str:
    if not text:
        return ""
    try:
        parts = [r["hepburn"] for r in kks.convert(text)]
    except Exception:  # noqa: BLE001 – pykakasi scheitert an einzelnen Sonderzeichen
        return ""
    s = " ".join(p for p in parts if p).strip()
    s = re.sub(r"\s+", " ", s)
    # lange Vokale vereinfachen (Hokkaidou Jinguu -> Hokkaido Jingu)
    s = re.sub(r"ou|oo", "o", s)
    s = re.sub(r"uu", "u", s)
    return " ".join(w.capitalize() for w in s.split(" "))


class Grid:
    """Einfacher räumlicher Index (~1 km Zellen)."""

    def __init__(self, cell=0.01):
        self.cell = cell
        self.cells = defaultdict(list)

    def key(self, lat, lon):
        return int(lat / self.cell), int(lon / self.cell)

    def add(self, item):
        self.cells[self.key(item["lat"], item["lon"])].append(item)

    def near(self, lat, lon, radius):
        r = int(radius / 1000 / (self.cell * 111)) + 1
        ky, kx = self.key(lat, lon)
        out = []
        for dy in range(-r, r + 1):
            for dx in range(-r, r + 1):
                for it in self.cells.get((ky + dy, kx + dx), ()):
                    d = dist(lat, lon, it["lat"], it["lon"])
                    if d <= radius:
                        out.append((d, it))
        out.sort(key=lambda t: t[0])
        return out


# ---------- OSM ----------
def load_osm():
    items = []
    pref = None  # wird später über Präfekturgrenzen bestimmt
    for e in json.loads((RAW / "osm_all.json").read_text(encoding="utf-8"))["elements"]:
        t = e.get("tags", {})
        if "lat" in e:
            lat, lon = e["lat"], e["lon"]
        elif "center" in e:
            lat, lon = e["center"]["lat"], e["center"]["lon"]
        else:
            continue
        name = t.get("name:ja") or t.get("name", "")
        if t.get("religion") not in (None, "shinto"):
            continue
        if "amenity" not in t and "historic" not in t:
            # nur religion=shinto + Name: nur behalten, wenn Name nach Schrein aussieht
            if not re.search(r"(神社|神宮|宮|社|稲荷|八幡|権現|明神|天神|大神|祠)$", name):
                continue
        if name and SUB_BUILDING.search(name):
            kind = "sub"
        elif t.get("historic") == "wayside_shrine" or name.endswith("祠"):
            kind = KIND_HOKORA
        elif not name:
            kind = KIND_UNNAMED
        else:
            kind = KIND_SHRINE
        items.append({
            "id": e["type"][0] + str(e["id"]), "lat": lat, "lon": lon, "pref": pref,
            "name": name, "en": t.get("name:en") or t.get("name:ja-Latn") or "",
            "kana": t.get("name:ja-Hira") or t.get("name:ja-Kana") or "",
            "kind": kind, "wd": t.get("wikidata", ""), "web": t.get("website") or t.get("contact:website", ""),
            "area": e["type"] != "node", "src": "osm", "rank": 0,
        })
    return items


def dedup_osm(items, stats):
    """Doppelte Erfassung (Punkt + Fläche, Gebäudeteile) entfernen."""
    # Flächen zuerst, damit sie als "Hauptobjekt" bleiben
    items.sort(key=lambda i: (not i["area"], i["kind"] == "sub", i["kind"] == KIND_UNNAMED))
    grid = Grid()
    kept = []
    for it in items:
        drop = False
        for d, o in grid.near(it["lat"], it["lon"], 200):
            if it["kind"] == "sub" and o["kind"] != "sub":
                drop = True  # Gebäudeteil einer bereits erfassten Anlage
            elif it["name"] and similar(it["name"], o["name"]) >= 0.95 and d <= 200:
                drop = True
            elif not it["name"] and d <= 40 and o["kind"] != KIND_HOKORA:
                drop = True  # unbenannter Punkt direkt in einer benannten Anlage
            if drop:
                if it["wd"] and not o["wd"]:
                    o["wd"] = it["wd"]
                if it["en"] and not o["en"]:
                    o["en"] = it["en"]
                break
        if drop:
            stats["osm_dupes"] += 1
            continue
        if it["kind"] == "sub":
            it["kind"] = KIND_SHRINE
        grid.add(it)
        kept.append(it)
    return kept, grid


# ---------- Wikidata ----------
def rank_bits(w) -> int:
    ranks, parts, classes = set(w.get("rank", [])), set(w.get("partof", [])), set(w.get("class", []))
    b = 0
    if ranks & {"Ichi-no-Miya", "Regional Ichinomiya"} or "Ichi-no-Miya" in parts:
        b |= R_ICHINOMIYA
    if "Beppyo Shrine" in ranks or "Beppyo Shrine" in parts:
        b |= R_BEPPYO
    if ranks & {"Shikinai Shōsha", "Shikinai Taisha", "Myōjin Taisha"} or classes & {"Shikinaisha", "Shikinai Ronsha"}:
        b |= R_SHIKINAI
    if ranks & KANSHA:
        b |= R_KANSHA
    if "Twenty-Two Shrines" in parts:
        b |= R_22
    if "125 Shrines of Ise" in parts:
        b |= R_ISE
    return b


def match_spatial(w, grid):
    wn = norm(w.get("ja", ""))
    for d, o in grid.near(w["lat"], w["lon"], 1000):
        s = similar(w.get("ja", ""), o["name"])
        on = norm(o["name"])
        contains = bool(wn and on and (wn in on or on in wn))  # 住吉神社 ↔ 若宮住吉神社
        if ((d <= 150 and s >= 0.85) or (d <= 500 and s == 1.0)
                or (d <= 1000 and s == 1.0 and o["area"])  # große Anlagen: Flächenmittelpunkt weit weg
                or (d <= 60 and contains)
                or (d <= 30 and not o["name"])):
            return o
    return None


def merge_wikidata(items, grid, stats):
    wd = json.loads((RAW / "wikidata.json").read_text(encoding="utf-8"))
    by_qid = {}
    for it in items:
        if it["wd"]:
            by_qid.setdefault(it["wd"], it)
    for w in wd:
        target = by_qid.get(w["qid"])
        how = "tag"
        if target is None:
            target, how = match_spatial(w, grid), "spatial"
        if target is not None:
            stats[f"wd_match_{how}"] += 1
            # Wikidata führt manche Schreine doppelt (z. B. Shikinaisha + heutiger
            # Schrein) – erste QID bleibt, Attribute aller Treffer werden vereint
            target["wd"] = target["wd"] or w["qid"]
        else:
            stats["wd_new"] += 1
            target = {
                "id": w["qid"], "lat": w["lat"], "lon": w["lon"], "pref": None,
                "name": w.get("ja", ""), "en": "", "kana": "", "kind": KIND_SHRINE,
                "wd": w["qid"], "web": "", "area": False, "src": "wd", "rank": 0,
            }
            items.append(target)
            grid.add(target)
        target["rank"] |= rank_bits(w)
        target["en"] = target["en"] or w.get("en", "")
        target["kana"] = target["kana"] or w.get("kana", "")
        target["web"] = target["web"] or w.get("website", "")
        if w.get("deity"):
            target["deity"] = w["deity"]
        if w.get("image"):
            target["img"] = w["image"].rsplit("/", 1)[-1]
        if not target["name"]:
            target["name"] = w.get("ja", "")
            if target["kind"] == KIND_UNNAMED and target["name"]:
                target["kind"] = KIND_SHRINE


# ---------- GSI ----------
def merge_gsi(items, grid, stats):
    p = RAW / "gsi.json"
    if not p.exists():
        print("raw/gsi.json fehlt – GSI-Ebene wird übersprungen")
        return
    g = json.loads(p.read_text(encoding="utf-8"))
    label_grid = Grid()
    for lat, lon, name in g["labels"]:
        label_grid.add({"lat": lat, "lon": lon, "name": name})
    for lat, lon in g["symbols"]:
        near = grid.near(lat, lon, 150)
        if near:
            stats["gsi_known"] += 1
            continue
        lab = label_grid.near(lat, lon, 250)
        name = lab[0][1]["name"] if lab else ""
        if name:
            # benannter GSI-Schrein: evtl. existiert er unter gleichem Namen etwas weiter weg
            if any(similar(name, o["name"]) >= 0.95 for _, o in grid.near(lat, lon, 600)):
                stats["gsi_known"] += 1
                continue
        stats["gsi_new_named" if name else "gsi_new_unnamed"] += 1
        it = {
            "id": f"g{round(lat * 1e5)}_{round(lon * 1e5)}", "lat": lat, "lon": lon, "pref": None,
            "name": name, "en": "", "kana": "", "kind": KIND_SHRINE if name else KIND_UNNAMED,
            "wd": "", "web": "", "area": False, "src": "gsi", "rank": 0,
        }
        items.append(it)
        grid.add(it)


# ---------- Präfektur über Grenzpolygone ----------
def assign_prefs(items):
    from shapely.geometry import Point, shape
    from shapely.strtree import STRtree

    gj = json.loads((RAW / "japan_prefs.geojson").read_text(encoding="utf-8"))
    polys = [shape(f["geometry"]) for f in gj["features"]]
    ids = [f["properties"]["id"] - 1 for f in gj["features"]]
    tree = STRtree(polys)
    for it in items:
        pt = Point(it["lon"], it["lat"])
        hit = tree.query(pt, predicate="intersects")
        if len(hit):
            it["pref"] = ids[hit[0]]
            continue
        # Küste/Inseln: vereinfachte Grenzen -> nächstes Polygon (max. ~30 km)
        i = tree.nearest(pt)
        it["pref"] = ids[i] if polys[i].distance(pt) < 0.3 else -1


def main():
    stats = Counter()
    items = load_osm()
    stats["osm_raw"] = len(items)
    items, grid = dedup_osm(items, stats)
    merge_wikidata(items, grid, stats)
    merge_gsi(items, grid, stats)
    assign_prefs(items)
    stats["outside_japan"] = sum(1 for i in items if i["pref"] < 0)
    items = [i for i in items if i["pref"] >= 0]

    rows = []
    details = defaultdict(dict)
    for it in items:
        en = it["en"]
        rom = en or romaji(it["kana"] or it["name"])
        rows.append([it["id"], round(it["lat"], 6), round(it["lon"], 6), it["name"], rom,
                     it["kind"], it["pref"], it["rank"]])
        det = {k: it[k] for k in ("wd", "kana", "web", "deity", "img") if it.get(k)}
        if det:
            details[it["pref"]][it["id"]] = det

    PUBLIC.mkdir(parents=True, exist_ok=True)
    (PUBLIC / "details").mkdir(exist_ok=True)
    out = {"version": date.today().isoformat(), "prefs": PREFS,
           "fields": ["id", "lat", "lon", "name", "romaji", "kind", "pref", "rank"], "rows": rows}
    (PUBLIC / "shrines.json").write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    for pref, det in details.items():
        (PUBLIC / "details" / f"JP-{pref + 1:02d}.json").write_text(
            json.dumps(det, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")

    kinds = Counter(r[5] for r in rows)
    per_pref = Counter(r[6] for r in rows)
    lines = [f"Gesamt: {len(rows)}",
             f"  Schreine: {kinds[KIND_SHRINE]}, Hokora: {kinds[KIND_HOKORA]}, unbenannt: {kinds[KIND_UNNAMED]}",
             f"  mit Rang: {sum(1 for r in rows if r[7])}",
             *(f"  {k}: {v}" for k, v in sorted(stats.items())),
             "Pro Präfektur:",
             *(f"  JP-{p + 1:02d} {PREFS[p]}: {per_pref[p]}" for p in range(47))]
    (RAW / "report.txt").write_text("\n".join(lines), encoding="utf-8")
    print("\n".join(lines[:20]))
    print(f"shrines.json: {(PUBLIC / 'shrines.json').stat().st_size / 1e6:.1f} MB")


if __name__ == "__main__":
    main()
