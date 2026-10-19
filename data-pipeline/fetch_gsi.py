"""Extrahiert die 神社-Kartensymbole aus den GSI-Vektorkacheln (国土地理院最適化ベクトルタイル).

Liest das PMTiles-Archiv per HTTP-Range-Requests, nimmt alle Kacheln der
Zoomstufe 14 (enthält ~90 % der Symbole von z16 bei 1/16 der Datenmenge) und
sammelt im Layer "Anno":
  vt_code 3231 = Kartensymbol 神社 (ohne Namen)
  vt_code 661  = Beschriftung 神社 (Name)
Ergebnis: raw/gsi.json  -> {"symbols": [[lat, lon], ...], "labels": [[lat, lon, name], ...]}

Quelle: 国土地理院最適化ベクトルタイル (https://github.com/gsi-cyberjapan/optimal_bvmap)
"""
import gzip
import json
import math
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import mapbox_vector_tile
import requests

URL = "https://cyberjapandata.gsi.go.jp/xyz/optimal_bvmap-v1/optimal_bvmap-v1.pmtiles"
OUT = Path(__file__).parent / "raw" / "gsi.json"
CACHE = Path(__file__).parent / "raw" / "gsi_progress.json"
ZOOM = 14
CHUNK = 8 * 1024 * 1024  # benachbarte Kacheln in Blöcken bis 8 MB laden
HEADERS = {"User-Agent": "shrine-map-personal/1.0 (private, non-commercial)"}
session = requests.Session()
session.headers.update(HEADERS)


def get_range(offset: int, length: int) -> bytes:
    for attempt in range(6):
        try:
            r = session.get(URL, headers={"Range": f"bytes={offset}-{offset + length - 1}"}, timeout=120)
            if r.status_code == 206 and len(r.content) == length:
                return r.content
            err = f"HTTP {r.status_code} len={len(r.content)}"
        except Exception as e:  # noqa: BLE001
            err = str(e)
        print(f"  Range-Fehler ({err}), Retry", flush=True)
        time.sleep(10 * (attempt + 1))
    raise RuntimeError("Range-Request fehlgeschlagen")


# ---------- minimaler PMTiles-v3-Leser ----------
def read_varint(b: bytes, pos: int) -> tuple[int, int]:
    shift = result = 0
    while True:
        byte = b[pos]
        pos += 1
        result |= (byte & 0x7F) << shift
        if not byte & 0x80:
            return result, pos
        shift += 7


def decompress(data: bytes, comp: int) -> bytes:
    if comp in (0, 1):  # unknown / none
        return data
    if comp == 2:
        return gzip.decompress(data)
    raise RuntimeError(f"Kompression {comp} nicht unterstützt")


def parse_dir(b: bytes) -> list[tuple[int, int, int, int]]:
    n, pos = read_varint(b, 0)
    ids, runs, lens, offs = [], [], [], []
    last = 0
    for _ in range(n):
        v, pos = read_varint(b, pos)
        last += v
        ids.append(last)
    for _ in range(n):
        v, pos = read_varint(b, pos)
        runs.append(v)
    for _ in range(n):
        v, pos = read_varint(b, pos)
        lens.append(v)
    for i in range(n):
        v, pos = read_varint(b, pos)
        offs.append(offs[i - 1] + lens[i - 1] if v == 0 and i > 0 else v - 1)
    return list(zip(ids, runs, lens, offs))


def zxy_to_id(z: int, x: int, y: int) -> int:
    acc = sum(4**i for i in range(z))
    n = 1 << z
    d = 0
    s = n >> 1
    while s > 0:
        rx = 1 if x & s else 0
        ry = 1 if y & s else 0
        d += s * s * ((3 * rx) ^ ry)
        if ry == 0:
            if rx == 1:
                x, y = s - 1 - x, s - 1 - y
            x, y = y, x
        s >>= 1
    return acc + d


def id_to_xy(tid: int, z: int) -> tuple[int, int]:
    t = tid - sum(4**i for i in range(z))
    n = 1 << z
    x = y = 0
    s = 1
    while s < n:
        rx = 1 & (t // 2)
        ry = 1 & (t ^ rx)
        if ry == 0:
            if rx == 1:
                x, y = s - 1 - x, s - 1 - y
            x, y = y, x
        x += s * rx
        y += s * ry
        t //= 4
        s *= 2
    return x, y


def list_tiles(z: int) -> tuple[list[tuple[int, int, int]], dict]:
    """Liefert [(tile_id, offset, length)] aller Kacheln der Zoomstufe z."""
    head = get_range(0, 16384)
    assert head[:7] == b"PMTiles" and head[7] == 3, "kein PMTiles v3"
    u = lambda i: int.from_bytes(head[i:i + 8], "little")  # noqa: E731
    h = {
        "root_off": u(8), "root_len": u(16), "leaf_off": u(40),
        "data_off": u(56), "icomp": head[97], "tcomp": head[98],
    }
    lo, hi = zxy_to_id(z, 0, 0), sum(4**i for i in range(z + 1))
    tiles: list[tuple[int, int, int]] = []

    def walk(entries):
        for i, (tid, run, length, off) in enumerate(entries):
            nxt = entries[i + 1][0] if i + 1 < len(entries) else 1 << 62
            if run == 0:  # Leaf-Verzeichnis: deckt [tid, nxt) ab
                if nxt <= lo or tid >= hi:
                    continue
                leaf = decompress(get_range(h["leaf_off"] + off, length), h["icomp"])
                walk(parse_dir(leaf))
            else:
                for k in range(run):
                    if lo <= tid + k < hi:
                        tiles.append((tid + k, off, length))

    root = decompress(head[h["root_off"]:h["root_off"] + h["root_len"]], h["icomp"])
    walk(parse_dir(root))
    return tiles, h


def tile_points(data: bytes, tid: int, z: int):
    x, y = id_to_xy(tid, z)
    t = mapbox_vector_tile.decode(data)
    anno = t.get("Anno")
    if not anno:
        return [], []
    ext = anno.get("extent", 4096)
    n = 1 << z
    syms, labels = [], []
    for f in anno["features"]:
        code = f["properties"].get("vt_code")
        if code not in (3231, 661) or f["geometry"]["type"] != "Point":
            continue
        px, py = f["geometry"]["coordinates"]
        # mapbox_vector_tile liefert y nach oben gespiegelt (y_coord_down=False)
        fx = (x + px / ext) / n
        fy = (y + (ext - py) / ext) / n
        lon = fx * 360 - 180
        lat = math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * fy))))
        if code == 3231:
            syms.append([round(lat, 6), round(lon, 6)])
        else:
            labels.append([round(lat, 6), round(lon, 6), f["properties"].get("vt_text", "")])
    return syms, labels


def main() -> None:
    tiles, h = list_tiles(ZOOM)
    tiles.sort(key=lambda t: t[1])
    # Gleiche Offsets (deduplizierte Kacheln, z. B. leeres Meer) nur einmal laden
    print(f"{len(tiles)} Kacheln auf z{ZOOM}, Daten {sum(t[2] for t in {t[1]: t for t in tiles}.values()) / 1e9:.2f} GB", flush=True)

    # Blöcke bilden
    chunks, cur = [], []
    for t in tiles:
        if cur and (t[1] + t[2] - cur[0][1] > CHUNK or t[1] > cur[-1][1] + cur[-1][2] + 65536):
            chunks.append(cur)
            cur = []
        cur.append(t)
    if cur:
        chunks.append(cur)

    done = set()
    syms, labels = [], []
    if CACHE.exists():
        c = json.loads(CACHE.read_text(encoding="utf-8"))
        done, syms, labels = set(c["done"]), c["symbols"], c["labels"]

    def work(ci: int):
        ch = chunks[ci]
        start = ch[0][1]
        end = max(t[1] + t[2] for t in ch)
        blob = get_range(h["data_off"] + start, end - start)
        s_all, l_all = [], []
        for tid, off, length in ch:
            data = decompress(blob[off - start:off - start + length], h["tcomp"])
            s, l = tile_points(data, tid, ZOOM)
            s_all += s
            l_all += l
        return ci, s_all, l_all

    todo = [i for i in range(len(chunks)) if i not in done]
    print(f"{len(chunks)} Blöcke, offen: {len(todo)}", flush=True)
    with ThreadPoolExecutor(max_workers=4) as ex:
        for k, (ci, s, l) in enumerate(ex.map(work, todo)):
            syms += s
            labels += l
            done.add(ci)
            if k % 20 == 0:
                CACHE.write_text(json.dumps({"done": sorted(done), "symbols": syms, "labels": labels}), encoding="utf-8")
                print(f"  {len(done)}/{len(chunks)} Blöcke, {len(syms)} Symbole, {len(labels)} Namen", flush=True)

    # Duplikate an Kachelgrenzen entfernen
    syms = sorted({(a, b) for a, b in syms})
    labels = sorted({(a, b, c) for a, b, c in labels})
    OUT.write_text(json.dumps({"symbols": syms, "labels": labels}, ensure_ascii=False), encoding="utf-8")
    CACHE.unlink(missing_ok=True)
    print(f"Fertig: {len(syms)} 神社-Symbole, {len(labels)} Schreinnamen")


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "--list":
        tl, _ = list_tiles(ZOOM)
        print(len(tl), "Kacheln")
    else:
        main()
