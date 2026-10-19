# Lernapp

Unterrichtsmaterial rein, Lernstoff raus. GoodNotes-Mitschriften, Arbeitsblätter, Folien oder Fotos von der Tafel
als PDF/Bild hineinziehen — die App macht daraus **Karteikarten, Quizfragen und einen Lernzettel** und plant, wann Du
was wiederholst.

Reines HTML, CSS und JavaScript nach der Bauanleitung (`PWA-ANLEITUNG.md`): kein Build, keine Abhängigkeiten außer
dem lokal mitgelieferten PDF.js, läuft offline, installierbar als Web-App. Einzige Ausnahme vom „kein Netz“: Wer einen
eigenen Anthropic-API-Schlüssel einträgt, schickt sein Material zum Erzeugen an Claude (siehe `DECISIONS.md`).

## Was sie kann

**Material hinzufügen** — Knopf ＋, Datei aufs Fenster ziehen, Bild einfügen (Strg+V) oder auf Android aus jeder App
über *Teilen → Lernapp* (z. B. direkt aus GoodNotes). PDF, JPEG/PNG, Text/Markdown. Die App liest den Text jeder
Seite und erkennt Seiten ohne Text (Handschrift, Scans) sowie PDFs aus Notiz-Apps (GoodNotes, Notability, …).

**Karten erzeugen** auf drei Wegen:

| Weg | Braucht | Qualität |
|---|---|---|
| **KI** (Claude) | eigenen API-Schlüssel | liest auch Handschrift, Skizzen, Tabellen; Karten, Quiz (Auswahl, richtig/falsch, offene Klausurfragen), Lernzettel, Glossar |
| **Claude-Chat** | nur ein Claude-Konto (App oder claude.ai) | wie KI — Auftrag kopieren, bei Handschrift PDF anhängen, Antwort einfügen |
| **Offline** | nichts | findet Definitionen, „Begriff: Erklärung“, Aufzählungen, Jahreszahlen, Vokabellisten; Handschrift nicht |

**Lernen und üben**

- **Karteikarten mit verteilter Wiederholung** (SM-2 wie Anki): Nochmal / Schwer / Gut / Leicht, Lernschritte von
  1 und 10 Minuten, Rückgängig, Vorlesen (für Vokabeln), „Erklär’s mir“ (KI), Sprung zur Fundstelle im PDF.
  Tastatur: Leertaste, 1–4, U, V, E.
- **Quiz** — Auswahl, richtig/falsch, offene Fragen; kurze Antworten prüft die App selbst, lange bewertet Claude
  (oder Du selbst anhand der Musterlösung). Antwortreihenfolge wird jedes Mal gemischt. „Falsche wiederholen“.
- **Schreiben** — Antwort tippen statt erkennen; Tippfehler und „ae“ statt „ä“ werden toleriert, Zahlen nicht.
- **Zuordnen** — Begriffe und Erklärungen auf Zeit, mit Bestzeit je Stapel.
- **Probetest** — wie in der Klausur, Auswertung erst am Ende, in **Notenpunkten (0–15) und Note**.
- **Erklär es (Feynman)** — einen Begriff in eigenen Worten erklären; Claude zeigt, was fehlt.
- **Tutor** — Chat über genau dieses Material („Was kommt in der Klausur dran?“, „Frag mich ab“).
- **Lernzettel** — Zusammenfassung, Kernaussagen, Glossar; bearbeitbar, druckbar.
- **Bildkarten** — auf einer Seite Rechtecke über Beschriftungen ziehen (Diagramme, Skizzen, Handschrift), die
  App fragt sie einzeln ab. Funktioniert ganz ohne KI.
- **Schwierige Karten / Alles durchgehen** — gezielt pauken, ohne den Wiederholungsplan zu verändern.

**Planen** — Prüfungstermin je Stapel: Die App verteilt die neuen Karten bis dahin und sorgt dafür, dass jede Karte
vor der Prüfung noch einmal drankommt. Countdown auf „Heute“.

**Statistik** — Lernserie, Trefferquote, Aktivitäts-Kalender, Verlauf der letzten 30 Tage, Vorschau der nächsten
14 Tage, Kartenstand, Probetest-Ergebnisse.

**Daten** — Backup als JSON (wahlweise mit den PDFs), Stapel teilen (JSON ohne Lernstand), Export für Anki/Quizlet.

## KI einrichten

1. Auf **console.anthropic.com** anmelden, Guthaben aufladen (ab 5 $), unter *API Keys* einen Schlüssel erzeugen.
2. In der App: Einstellungen → API-Schlüssel → einfügen → *Prüfen & sichern*.
3. Modell wählen: **Opus 5** (Standard, beste Qualität), **Sonnet 5** (etwa 60 % günstiger), **Haiku 4.5** (am günstigsten).

Richtwert: 10 Seiten Mitschrift kosten mit Opus 5 etwa 0,30–0,50 $, mit Sonnet 5 etwa 0,15 $. Die App zeigt die
Kosten je Dokument und insgesamt (Einstellungen). Der Schlüssel bleibt auf dem Gerät und landet nicht im Backup.

Ohne Schlüssel: Beim Hinzufügen „Claude-Chat“ wählen. Das nutzt Dein normales Claude-Konto.

## Dateien

| Hochladen | Nicht hochladen |
|---|---|
| `index.html`, `style.css`, `core.js`, `ai.js`, `app.js`, `sw.js`, `manifest.webmanifest`, `icons/`, `vendor/` | `.claude/`, `tests/`, `upload/`, `beispiele/`, `PWA-ANLEITUNG.md`, `DECISIONS.md`, `PROGRESS.md`, `OFFEN.md`, `MITTAG.md`, Backups (`lernapp-*.json`) |

`README.md` darf mit hoch. `icons/make-icons.py` und `vendor/pack-cmaps.py` schaden nicht.

| Datei | Inhalt |
|---|---|
| `app.js` | Oberfläche, Speicher, alle Ansichten und Lernmodi |
| `core.js` | reine Logik ohne Oberfläche: Wiederholungsplan, Offline-Generator, Antwortprüfung, JSON-Reparatur, Markdown, Notenpunkte |
| `ai.js` | Anbindung an Claude: Streaming, Prompts, Schema, Aufteilung großer PDFs, Kosten |
| `vendor/pdfjs/` | PDF.js 6.4.299 (Mozilla, Apache-2.0), aus dem Reader übernommen |
| `beispiele/` | Stapel zum Importieren (Einstellungen → Stapel importieren), von Claude Code aus Test-PDFs erstellt |

## Deployment (GitHub Pages)

1. Neues Repo auf github.com anlegen, **Public**, Name `lernapp`, kein README anhaken.
2. „uploading an existing file“ → den **Inhalt** von `upload/` hineinziehen (dort liegt genau die linke Spalte oben,
   inklusive der Ordner `icons/` und `vendor/`). `index.html` muss in der Wurzel des Repos liegen.
3. Settings → Pages → Deploy from a branch, `main`, `/ (root)` → Save.
4. Nach ein, zwei Minuten: `https://<name>.github.io/lernapp/`

Bei jedem Update: `APP_VERSION` in `app.js` und `CACHE` in `sw.js` hochzählen, die geänderten Dateien plus `sw.js`
nach `update/` legen und hochladen (Bauanleitung, Abschnitt 7).

## Installieren

**Android (Chrome):** Adresse öffnen → Einstellungen der App (Zahnrad) → **App installieren**. Der Knopf erscheint
ein paar Sekunden nach dem Laden. Erst die installierte App steht im Teilen-Menü („Teilen → Lernapp“).
Nicht „Website-Daten löschen“ für `<name>.github.io` — alle Deine Apps teilen sich diesen Speicher.

**iPad/iPhone (Safari):** Teilen → „Zum Home-Bildschirm“. Das Teilen-Menü von iOS kennt keine Web-Apps; PDFs aus
GoodNotes dort über *Teilen → In Dateien sichern* und dann in der App mit ＋ auswählen, oder in Split View
hineinziehen.

## Lokal testen

```
python3 -m http.server 8125          # wie in der Bauanleitung
python3 tests/serve.py               # Port 8126, ohne Browser-Cache — zum Entwickeln
node tests/core-test.js              # Logik (Wiederholungsplan, Generator, Antwortprüfung …)
node tests/ai-test.js                # KI-Anbindung gegen eine nachgebildete API
```

Im Browser auf dem Testserver (löscht dort alle Daten!), in der Konsole:
`await (await import('./tests/smoke-browser.js?' + Date.now())).run()` — spielt alle Abläufe durch.
