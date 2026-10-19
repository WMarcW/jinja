"""Lädt Shinto-Schreine (Q845945 + Unterklassen) in Japan von Wikidata.

Mehrere schlanke SPARQL-Abfragen statt einer großen (Timeout-Gefahr); die
Ergebnisse werden in raw/wikidata.json zusammengeführt.
"""
import json
import re
import time
from collections import defaultdict
from pathlib import Path

import requests

OUT = Path(__file__).parent / "raw" / "wikidata.json"
ENDPOINT = "https://query.wikidata.org/sparql"
HEADERS = {
    "User-Agent": "shrine-map-personal/1.0 (private, non-commercial)",
    "Accept": "application/sparql-results+json",
}

BASE = "?s wdt:P31/wdt:P279* wd:Q845945; wdt:P17 wd:Q17; wdt:P625 ?coord."

QUERIES = {
    "base": f"""SELECT ?s ?coord WHERE {{ {BASE} }}""",
    "ja": f"""SELECT ?s ?v WHERE {{ {BASE} ?s rdfs:label ?v FILTER(lang(?v)="ja") }}""",
    "en": f"""SELECT ?s ?v WHERE {{ {BASE} ?s rdfs:label ?v FILTER(lang(?v)="en") }}""",
    "kana": f"""SELECT ?s ?v WHERE {{ {BASE} ?s wdt:P1814 ?v }}""",
    "rank": f"""SELECT ?s ?v WHERE {{ {BASE} ?s wdt:P13723 ?r. ?r rdfs:label ?v FILTER(lang(?v)="en") }}""",
    "partof": f"""SELECT ?s ?v WHERE {{ {BASE} ?s wdt:P361 ?r. ?r rdfs:label ?v FILTER(lang(?v)="en") }}""",
    "deity": f"""SELECT ?s ?v WHERE {{ {BASE} ?s wdt:P825 ?d. ?d rdfs:label ?v FILTER(lang(?v)="ja") }}""",
    "image": f"""SELECT ?s ?v WHERE {{ {BASE} ?s wdt:P18 ?v }}""",
    "website": f"""SELECT ?s ?v WHERE {{ {BASE} ?s wdt:P856 ?v }}""",
    "class": f"""SELECT ?s ?v WHERE {{ {BASE} ?s wdt:P31 ?c. ?c rdfs:label ?v FILTER(lang(?v)="en") }}""",
}


def run(query: str) -> list[dict]:
    for attempt in range(5):
        try:
            r = requests.get(ENDPOINT, params={"query": query}, headers=HEADERS, timeout=300)
            if r.status_code == 200:
                return r.json()["results"]["bindings"]
            print(f"  HTTP {r.status_code}, Retry", flush=True)
        except Exception as e:  # noqa: BLE001
            print(f"  {e}, Retry", flush=True)
        time.sleep(20 * (attempt + 1))
    raise RuntimeError("Wikidata-Abfrage fehlgeschlagen")


def qid(b: dict) -> str:
    return b["s"]["value"].rsplit("/", 1)[1]


def main() -> None:
    items: dict[str, dict] = {}
    multi: dict[str, dict[str, set]] = defaultdict(lambda: defaultdict(set))
    for key, q in QUERIES.items():
        rows = run(q)
        print(f"{key}: {len(rows)} Zeilen", flush=True)
        for b in rows:
            s = qid(b)
            if key == "base":
                # "Point(lon lat)", vereinzelt ungültig/leer
                m = re.search(r"Point\(([-\d.eE]+) ([-\d.eE]+)\)", b["coord"]["value"])
                if not m:
                    continue
                lon, lat = m.groups()
                items.setdefault(s, {"qid": s, "lat": float(lat), "lon": float(lon)})
            else:
                multi[s][key].add(b["v"]["value"])
        time.sleep(3)
    for s, item in items.items():
        for key, vals in multi.get(s, {}).items():
            vals = sorted(vals)
            item[key] = vals if key in ("rank", "partof", "deity", "class") else vals[0]
    OUT.write_text(json.dumps(list(items.values()), ensure_ascii=False, indent=0), encoding="utf-8")
    print(f"{len(items)} Schreine gespeichert")


if __name__ == "__main__":
    main()
