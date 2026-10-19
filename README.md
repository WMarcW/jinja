# Jinja – Schreinkarte Japan

Private PWA fürs iPhone: Karte aller auffindbaren Shinto-Schreine Japans. Pro Schrein lässt sich festhalten, ob man ihn besucht und dort ein Goshuin geholt hat, dazu Fotos und Notizen. Der Fortschritt wird zwischen zwei Personen synchronisiert. Alles läuft auf kostenlosen Diensten.

## Datenquellen

Die Daten kommen aus drei Quellen und werden mit `data-pipeline/` zusammengeführt:

| Quelle | Inhalt | Lizenz |
|---|---|---|
| OpenStreetMap (Geofabrik-Extrakt) | Schreine, Hokora, Namen | ODbL – „© OpenStreetMap-Mitwirkende" |
| Wikidata | Ränge (Ichinomiya, Beppyō, Shikinaisha …), Lesung, Gottheiten, Bilder | CC0 |
| 国土地理院最適化ベクトルタイル | Kartensymbol 神社 (auch Schreine, die in OSM fehlen) | GSI-Nutzungsbedingungen, Quellenangabe |

### Daten neu erzeugen

```bash
python -m venv .venv
.venv/Scripts/pip install -r data-pipeline/requirements.txt
cd data-pipeline
curl -L -o raw/japan-latest.osm.pbf https://download.geofabrik.de/asia/japan-latest.osm.pbf
curl -L -o raw/japan_prefs.geojson https://raw.githubusercontent.com/dataofjapan/land/master/japan.geojson
../.venv/Scripts/python extract_osm.py     # ~10–20 min
../.venv/Scripts/python fetch_wikidata.py  # ~2 min
../.venv/Scripts/python fetch_gsi.py       # ~3 GB Download, ~30–60 min
../.venv/Scripts/python merge.py           # -> public/data/, Statistik in raw/report.txt
```

Die Schrein-IDs (`n123`, `w123`, `Q123`, `g…`) bleiben stabil, solange sich die Quelldaten nicht ändern. Jeder Besuch speichert zusätzlich Name und Koordinaten. So geht nichts verloren, falls ein Schrein nach einem Datenupdate eine andere ID bekommt.

## Einmalige Einrichtung (alles kostenlos)

### 1. Supabase (Synchronisation, Login, Fotos)
1. Auf <https://supabase.com> ein kostenloses Konto und ein neues Projekt anlegen. Als Region „Tokyo" oder „Frankfurt" wählen.
2. Im **SQL Editor** den Inhalt von `supabase/schema.sql` einfügen und auf **Run** klicken.
3. Unter **Authentication → Users → Add user** beide Nutzer mit E-Mail und Passwort anlegen und dabei „Auto Confirm User" anhaken.
4. Unter **Authentication → Sign In / Providers** die Option **„Allow new users to sign up"** ausschalten. Danach kann sich niemand sonst registrieren.
5. Unter **Project Settings → API Keys** den **Publishable key** (`sb_publishable_…`) kopieren. Die **Project URL** (`https://xxxx.supabase.co`) findest du über den Button **Connect**. Den **Secret key** nicht verwenden und nie weitergeben.

### 2. Lokal testen
```bash
cp .env.example .env.local   # Werte aus Schritt 1.5 eintragen
npm install
npm run dev
```
Ohne `.env.local` läuft die App im **lokalen Modus**. Dann gibt es keinen Login, und alle Daten bleiben im Browser.

### 3. Veröffentlichen (GitHub Pages)
1. Ein Repository auf GitHub anlegen und den Code pushen.
2. Unter **Settings → Pages → Source** „GitHub Actions" auswählen.
3. Unter **Settings → Secrets and variables → Actions → Variables** zwei Variablen anlegen: `SUPABASE_URL` und `SUPABASE_ANON_KEY` (= Publishable key). Dieser Schlüssel ist absichtlich öffentlich, die Daten schützt die Row Level Security.
4. Jeder Push auf `main` baut und veröffentlicht die App unter `https://<user>.github.io/<repo>/`.

Der Workflow `keepalive.yml` pingt Supabase zweimal pro Woche. Kostenlose Projekte werden sonst nach 7 Tagen ohne Aktivität pausiert. GitHub deaktiviert geplante Workflows nach 60 Tagen ohne Commit. Kommt per E-Mail eine Warnung, reicht ein Klick auf „Enable workflow".

### 4. Aufs iPhone
Die URL in **Safari** öffnen, dann **Teilen → Zum Home-Bildschirm**. Danach startet die App wie eine normale App im Vollbild.

## Bedienung
- **Schrein antippen:** Details öffnen, Besucht- und Goshuin-Status setzen (mit Datum), Notiz schreiben, Fotos hinzufügen.
- **☰ Filter:** zwischen Ich, Partner und Beide wechseln, nach offen, besucht oder Goshuin filtern, Hokora und namenlose Schreine ein- oder ausblenden.
- **⛩ Statistik:** Fortschritt nach Präfektur und Rang, dazu Einstellungen und Backup-Export.
- **Lange auf die Karte drücken:** einen fehlenden Schrein selbst eintragen.
- **Offline:** Änderungen und Fotos werden zwischengespeichert und automatisch hochgeladen, sobald wieder Netz da ist.

## Kostenlose Limits
- **Fotos:** Supabase Storage bietet 1 GB. Fotos werden auf etwa 250–450 KB verkleinert, das reicht für 2.500 bis 4.000 Fotos. Den Verbrauch zeigt die App unter Statistik → Einstellungen.
- **Datenbank:** Supabase bietet 500 MB. Besuche brauchen nur wenige Bytes, das Limit spielt praktisch keine Rolle.
