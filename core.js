'use strict';
/* ═══════════════════════════════════════════════════════════════
   Lernapp — Kernlogik ohne Oberfläche

   Alles hier ist reine Funktion: kein DOM, kein Speicher, kein Netz. Deshalb
   eigene Datei — tests/core-test.js lädt sie direkt in Node und prüft
   Wiederholungsplan, Offline-Generator, Antwortprüfung und JSON-Reparatur,
   ohne dass ein Browser laufen muss.

   Inhalt
   1. Hilfen (Mischen, Normalisieren, Levenshtein)
   2. Wiederholungsplan (Spaced Repetition, angelehnt an SM-2/Anki)
   3. Lückentext (Cloze)
   4. Antwortprüfung für den Schreibmodus
   5. PDF-Text aufbereiten (Zeilen bauen, Kopf-/Fußzeilen entfernen)
   6. Offline-Generator: Karten und Quizfragen ohne KI
   7. Ergebnis einer KI (oder eingefügtes JSON) prüfen und vereinheitlichen
   8. Mini-Markdown für Zusammenfassungen
   9. Notenpunkte
   ═══════════════════════════════════════════════════════════════ */

const Core = (() => {

/* ── 1. Hilfen ──────────────────────────────────────────────── */

const MIN = 60 * 1000;
const DAY = 24 * 60 * MIN;

function shuffle(arr, rnd) {
  const a = arr.slice();
  const r = rnd || Math.random;
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

const sample = (arr, n, rnd) => shuffle(arr, rnd).slice(0, n);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/** Für Vergleiche: klein, ohne Satzzeichen, Umlaute ausgeschrieben. Wer auf
    dem Handy „ae“ statt „ä“ tippt, soll nicht als falsch gelten. */
function fold(s) {
  return String(s == null ? '' : s).normalize('NFC').toLowerCase()
    .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')          // é → e, ç → c
    .replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

/** Schlüssel zum Erkennen doppelter Karten. */
const dedupeKey = (s) => fold(s).replace(/\s+/g, '');

function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = new Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}

const similarity = (a, b) => {
  const m = Math.max(a.length, b.length);
  return m ? 1 - levenshtein(a, b) / m : 1;
};

/* ── 2. Wiederholungsplan ─────────────────────────────────────
   Angelehnt an SM-2, wie Anki es benutzt:
   - Neue Karten durchlaufen kurze Lernschritte (1 und 10 Minuten), bevor
     sie in den Tagesrhythmus wechseln.
   - Danach wächst der Abstand mit dem „Leichtigkeitsfaktor“ (ease), den
     jede Bewertung ein wenig verschiebt.
   - Vergessen („Nochmal“) halbiert den Abstand und schickt die Karte in
     einen kurzen Wiederlernschritt.
   Der Lerntag beginnt um 4 Uhr: Wer nach Mitternacht noch lernt, zählt zum
   Vortag, und fällige Karten stehen morgens bereit statt erst zur Uhrzeit
   der letzten Wiederholung.

   Zustand einer Karte (`s`):
     st     'new' | 'learn' | 'review' | 'relearn'
     due    Zeitpunkt (ms), ab dem sie wieder dran ist
     ivl    Abstand in Tagen (bei review), sonst der zuletzt erreichte
     ease   Faktor, Start 2,5, nie unter 1,3
     step   aktueller Lernschritt
     reps   Wiederholungen insgesamt, lapses: wie oft vergessen
     last   Zeitpunkt der letzten Bewertung */

const LEARN_STEPS = [1, 10];          // Minuten
const RELEARN_STEPS = [10];
const DAY_HOUR = 4;

function newState() {
  return { st: 'new', due: 0, ivl: 0, ease: 2.5, step: 0, reps: 0, lapses: 0, last: 0 };
}

/** Beginn des Lerntags (4:00 Uhr lokal), zu dem `ts` gehört. */
function dayStart(ts) {
  const d = new Date(ts);
  if (d.getHours() < DAY_HOUR) d.setDate(d.getDate() - 1);
  d.setHours(DAY_HOUR, 0, 0, 0);
  return d.getTime();
}

/** Beginn des Lerntags `n` Tage nach `ts` — über setDate, damit die
    Zeitumstellung keinen Tag verschluckt. */
function addDays(ts, n) {
  const d = new Date(dayStart(ts));
  d.setDate(d.getDate() + n);
  return d.getTime();
}

/** Lerntag als 'JJJJ-MM-TT' — Schlüssel für die Statistik. */
function dayKey(ts) {
  const d = new Date(dayStart(ts));
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** Ganze Lerntage von heute bis zum Datum 'JJJJ-MM-TT' (Prüfung). */
function daysUntil(dateStr, now) {
  if (!dateStr) return null;
  const [y, m, d] = dateStr.split('-').map(Number);
  const target = new Date(y, m - 1, d, DAY_HOUR).getTime();
  return Math.round((target - dayStart(now)) / DAY);
}

/** Kleine Streuung, damit Karten, die am selben Tag gelernt wurden, nicht
    für immer im Block wiederkommen. Deterministisch per `rnd` testbar. */
function fuzz(ivl, rnd) {
  if (ivl < 3) return ivl;
  const f = ivl < 7 ? 1 : Math.max(1, Math.round(ivl * 0.05));
  return ivl + Math.round(((rnd || Math.random)() * 2 - 1) * f);
}

/**
 * Bewertung anwenden. grade: 1 Nochmal, 2 Schwer, 3 Gut, 4 Leicht.
 * opts.maxIvl begrenzt den Abstand (Prüfungstermin), opts.rnd für Tests.
 * Gibt einen neuen Zustand zurück, der alte bleibt unverändert.
 */
function schedule(state, grade, now, opts) {
  opts = opts || {};
  const s = Object.assign(newState(), state);
  const maxIvl = Math.max(1, opts.maxIvl || 3650);
  s.reps++;
  s.last = now;

  const toReview = (ivl) => {
    s.st = 'review';
    s.step = 0;
    s.ivl = clamp(Math.round(ivl), 1, maxIvl);
    s.due = addDays(now, s.ivl);
  };

  if (s.st === 'new' || s.st === 'learn') {
    s.st = 'learn';
    if (grade === 1) { s.step = 0; s.due = now + LEARN_STEPS[0] * MIN; }
    else if (grade === 2) {
      // Schwer: denselben Schritt wiederholen, etwas länger warten
      const cur = LEARN_STEPS[s.step] || LEARN_STEPS[LEARN_STEPS.length - 1];
      const next = LEARN_STEPS[s.step + 1] || cur * 1.5;
      s.due = now + Math.round((cur + next) / 2) * MIN;
    } else if (grade === 3) {
      s.step++;
      if (s.step >= LEARN_STEPS.length) toReview(1);
      else s.due = now + LEARN_STEPS[s.step] * MIN;
    } else {
      toReview(4);
    }
    return s;
  }

  if (s.st === 'relearn') {
    if (grade === 1) { s.step = 0; s.due = now + RELEARN_STEPS[0] * MIN; }
    else if (grade === 2) { s.due = now + RELEARN_STEPS[s.step] * 1.5 * MIN; }
    else if (grade === 3) {
      s.step++;
      if (s.step >= RELEARN_STEPS.length) toReview(Math.max(1, s.ivl));
      else s.due = now + RELEARN_STEPS[s.step] * MIN;
    } else toReview(Math.max(1, s.ivl) + 1);
    return s;
  }

  // review
  const late = Math.max(0, (dayStart(now) - (s.due || now)) / DAY);   // Tage überfällig
  const ivl = Math.max(1, s.ivl);
  if (grade === 1) {
    s.lapses++;
    s.ease = Math.max(1.3, s.ease - 0.2);
    s.ivl = Math.max(1, Math.round(ivl * 0.5));
    s.st = 'relearn';
    s.step = 0;
    s.due = now + RELEARN_STEPS[0] * MIN;
    return s;
  }
  let next;
  if (grade === 2) {
    s.ease = Math.max(1.3, s.ease - 0.15);
    next = Math.max(ivl + 1, (ivl + late / 4) * 1.2);
  } else if (grade === 3) {
    next = Math.max(ivl + 1, (ivl + late / 2) * s.ease);
  } else {
    s.ease = s.ease + 0.15;
    next = Math.max(ivl + 2, (ivl + late) * s.ease * 1.3);
  }
  toReview(fuzz(Math.round(next), opts.rnd));
  return s;
}

/** Wartezeit bis zur nächsten Wiederholung für die vier Knöpfe, als Text. */
function previewLabels(state, now, opts) {
  return [1, 2, 3, 4].map((g) => {
    const n = schedule(state, g, now, Object.assign({}, opts, { rnd: () => 0.5 }));
    return fmtWait(n.due - now);
  });
}

function fmtWait(ms) {
  const m = Math.round(ms / MIN);
  if (m < 1) return '< 1 Min';
  if (m < 60) return `${m} Min`;
  const h = Math.round(m / 60);
  if (h < 20) return `${h} Std`;
  const d = Math.max(1, Math.round(ms / DAY));
  if (d < 31) return `${d} T`;
  if (d < 365) return `${Math.round(d / 30.4)} Mon`;
  return `${(d / 365).toLocaleString('de-DE', { maximumFractionDigits: 1 })} J`;
}

/** Fertig gelernt = sitzt mit mindestens 21 Tagen Abstand („ausgereift“). */
const isMature = (s) => s && s.st === 'review' && s.ivl >= 21;

/* ── 3. Lückentext ─────────────────────────────────────────────
   Schreibweise wie in Anki: {{Begriff}} oder {{c1::Begriff::Hinweis}}.
   Eine Karte versteckt genau eine Lücke (`idx`), die anderen stehen offen da
   — eine Information pro Karte lernt sich besser als fünf auf einmal. */

const CLOZE_RE = /\{\{(?:c\d+::)?([\s\S]+?)(?:::([\s\S]*?))?\}\}/g;

function clozeCount(text) {
  return (String(text).match(CLOZE_RE) || []).length;
}

/** Teile einer Lückenkarte: [{t:'text'|'gap'|'open', s, hint}] */
function clozeParts(text, idx) {
  const out = [];
  let last = 0, i = 0, m;
  const re = new RegExp(CLOZE_RE.source, 'g');
  while ((m = re.exec(text))) {
    if (m.index > last) out.push({ t: 'text', s: text.slice(last, m.index) });
    out.push({ t: i === (idx || 0) ? 'gap' : 'open', s: m[1], hint: m[2] || '' });
    last = m.index + m[0].length;
    i++;
  }
  if (last < text.length) out.push({ t: 'text', s: text.slice(last) });
  return out;
}

/** Klartext einer Lückenkarte (alle Lücken gefüllt). */
const clozePlain = (text) => String(text).replace(new RegExp(CLOZE_RE.source, 'g'), '$1');

/** Antwort der Lücke `idx`. */
function clozeAnswer(text, idx) {
  const p = clozeParts(text, idx).find((x) => x.t === 'gap');
  return p ? p.s : '';
}

/* ── 4. Antwortprüfung ─────────────────────────────────────────
   Für den Schreibmodus. Kurze Antworten (ein Begriff, eine Jahreszahl)
   werden auf Tippfehler-Toleranz geprüft, lange (Erklärungen) auf die
   wichtigen Wörter — dort entscheidet am Ende der Schüler selbst, die App
   macht nur einen Vorschlag. */

const STOP = new Set(('der die das den dem des ein eine einer eines einem einen und oder aber ist sind war waren '
  + 'wird werden wurde wurden hat haben mit von vom zu zum zur im in am an auf aus bei für fuer nach über ueber unter '
  + 'durch als auch nicht noch nur sich so wie wenn dass es er sie ihr ihre sein seine man the a an of to and or is are '
  + 'was were be in on at for with by as it this that le la les un une des de du et est el los las y').split(' '));

const ARTICLES = /^(der|die|das|den|dem|des|ein|eine|einen|einem|the|a|an|le|la|les|l|un|une|el|los|las|il|lo)\s+/;

function variants(expected) {
  const raw = String(expected).split(/\s*(?:;|\/|\boder\b|\bor\b|\n)\s*/i).filter(Boolean);
  const out = new Set();
  for (const r of raw.length ? raw : [String(expected)]) {
    out.add(fold(r).replace(ARTICLES, ''));
    // „Mitochondrium (Mitochondrien)“: Klammern dürfen fehlen
    const noPar = r.replace(/\([^)]*\)/g, ' ');
    if (noPar !== r) out.add(fold(noPar).replace(ARTICLES, ''));
  }
  out.delete('');
  return [...out];
}

const contentWords = (s) => fold(s).split(' ').filter((w) => w.length >= 4 && !STOP.has(w));

/**
 * Antwort mit Lösung vergleichen.
 * Ergebnis: {verdict: 'right'|'close'|'wrong', score 0..1, missing: [Wörter]}
 */
function checkAnswer(input, expected) {
  const a = fold(input).replace(ARTICLES, '');
  if (!a) return { verdict: 'wrong', score: 0, missing: [] };
  const vs = variants(expected);
  const longAnswer = contentWords(expected).length > 4;

  if (!longAnswer) {
    let best = 0;
    for (const v of vs) {
      const sim = similarity(a, v);
      const dist = levenshtein(a, v);
      // Zahlen müssen exakt stimmen: 1789 statt 1798 ist kein Tippfehler
      if (/\d/.test(v) && a.replace(/\D/g, '') !== v.replace(/\D/g, '')) { best = Math.max(best, Math.min(sim, 0.5)); continue; }
      if (a === v) return { verdict: 'right', score: 1, missing: [] };
      const tol = v.length <= 4 ? 0 : v.length <= 8 ? 1 : 2;
      if (dist <= tol) return { verdict: 'right', score: sim, missing: [] };
      best = Math.max(best, sim);
    }
    return { verdict: best >= 0.7 ? 'close' : 'wrong', score: best, missing: [] };
  }

  // Lange Antwort: Anteil der Kernwörter, die (ungefähr) vorkommen
  const want = [...new Set(contentWords(expected))];
  const have = contentWords(input);
  const missing = [];
  let hit = 0;
  for (const w of want) {
    const found = have.some((h) => h === w || (w.length > 5 && h.length > 4 && (h.startsWith(w.slice(0, 5)) || similarity(h, w) >= 0.8)));
    if (found) hit++; else missing.push(w);
  }
  const score = want.length ? hit / want.length : 0;
  return { verdict: score >= 0.75 ? 'right' : score >= 0.4 ? 'close' : 'wrong', score, missing };
}

/* ── 5. PDF-Text aufbereiten ───────────────────────────────── */

/**
 * Textstücke einer PDF-Seite (PDF.js getTextContent().items) zu Zeilen
 * zusammensetzen. Reihenfolge wie im Dokument, nicht nach Koordinaten
 * sortiert: bei zweispaltigen Blättern würde das Sortieren die Spalten
 * zeilenweise verzahnen.
 */
function itemsToText(items) {
  let out = '';
  let lastY = null, lastX = null, lastH = 10, lastEOL = false;
  for (const it of items) {
    if (!it || typeof it.str !== 'string') continue;
    // PDF.js schickt leere Stücke als Zeilenende-Marke, oft mit Position 0/0
    // — für den Abstand zählen sie nicht, nur als Hinweis auf den Umbruch
    if (!it.str) { if (it.hasEOL) lastEOL = true; continue; }
    const tr = it.transform || [1, 0, 0, 1, 0, 0];
    const x = tr[4], y = tr[5];
    const h = Math.abs(it.height || tr[3] || lastH) || lastH;
    if (lastY !== null) {
      const dy = Math.abs(y - lastY);
      if (lastEOL || dy > Math.max(h, lastH) * 0.6) {
        // Großer Abstand nach unten = neuer Absatz
        out += dy > Math.max(h, lastH) * 1.9 ? '\n\n' : '\n';
      } else if (lastX !== null && x - lastX > h * 0.15 && !/\s$/.test(out) && !/^\s/.test(it.str)) {
        out += ' ';
      }
    }
    out += it.str;
    lastY = y; lastH = h;
    lastX = x + (it.width || 0);
    lastEOL = !!it.hasEOL;
  }
  return out.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** Zählt als „handschriftlich oder gescannt“: kaum echter Text auf der Seite. */
const isInkPage = (text) => String(text || '').replace(/\s/g, '').length < 40;

const BULLET_RE = /^\s*(?:[•·▪▫●○◦■□►▶▷➢➤✓✔→⇒\-–—*>]|\(?\d{1,2}[.)]|\(?[a-z][.)])\s+/;

/** Kopf- und Fußzeilen, die sich auf vielen Seiten wiederholen, und
    Seitenzahlen entfernen. Ziffern zählen beim Vergleich nicht mit, damit
    „Seite 3 von 9“ auf jeder Seite als dieselbe Zeile gilt. */
function cleanPages(pages) {
  const sig = (l) => l.replace(/\d+/g, '#').replace(/\s+/g, ' ').trim().toLowerCase();
  // Nur die Ränder zählen: Kopf- und Fußzeilen stehen oben oder unten. Ein
  // „Aufgabe 1“ mitten auf jeder Seite ist Inhalt, kein Seitenkopf.
  const EDGE = 2;
  const edges = (lines) => {
    const idx = lines.map((l, i) => i).filter((i) => lines[i].trim());
    return new Set([...idx.slice(0, EDGE), ...idx.slice(-EDGE)]);
  };
  const split = pages.map((p) => String(p.text || '').split('\n'));
  const counts = new Map();
  const n = pages.length;
  split.forEach((lines) => {
    const seen = new Set();
    for (const i of edges(lines)) { const s = sig(lines[i]); if (s.length > 2) seen.add(s); }
    for (const s of seen) counts.set(s, (counts.get(s) || 0) + 1);
  });
  const repeated = new Set();
  if (n >= 3) for (const [s, c] of counts) if (c >= Math.max(3, n * 0.5)) repeated.add(s);

  return pages.map((p, pi) => {
    const lines = split[pi];
    const edge = edges(lines);
    let t = lines.filter((l, i) => {
      if (!edge.has(i)) return true;
      const s = sig(l);
      if (repeated.has(s)) return false;
      if (/^\s*(seite|page|s\.)?\s*#(\s*(von|of|\/)\s*#)?\s*$/i.test(s)) return false;   // Seitenzahl
      return true;
    }).join('\n')
      .replace(/\r/g, '')
      .replace(/\u00ad/g, '')                                  // weiches Trennzeichen
      .replace(/(\p{Ll})[-‐]\n(\p{Ll})/gu, '$1$2')              // Silbentrennung am Zeilenende
      .replace(/[\u200b\ufeff]/g, '');
    return { n: p.n, text: t.trim() };
  });
}

/* ── 6. Offline-Generator ──────────────────────────────────────
   Erzeugt ohne KI Karten aus typischen Mustern im Unterrichtsmaterial:
   - „Begriff: Erklärung“ und „Begriff – Erklärung“ (Glossare, Merkkästen)
   - Definitionssätze („Unter X versteht man …“, „X bezeichnet …“,
     „Als X bezeichnet man …“, „X ist ein …“)
   - Überschrift mit Stichpunkten darunter → „Nenne …“-Karte
   - Sätze mit Jahreszahl → Lücke für das Jahr
   - Vokabellisten (beide Seiten kurz) → Karten in beide Richtungen
   - „Merke:“-Sätze und Sätze mit bekannten Fachbegriffen → Lückentext
   Das ist bewusst vorsichtig: lieber 20 gute Karten als 80 halbgare. Mit
   KI wird es deutlich besser; das sagt die App auch. */

const TITLE_RE = /\b(unit|kapitel|thema|lektion|chapter|teil|abschnitt|topic|lesson|klasse|q[1-4]|ef|lk|gk|arbeitsblatt|ab|übung|uebung)\b\.?\s*\d*\s*$/i;
const DEF_VERBS = 'bezeichnet|bedeutet|beschreibt|meint|definiert|umfasst|ist|sind|nennt man|heißt|heissen|heißen';

/* Abkürzungen, nach denen der Punkt keinen Satz beendet. */
const ABBR = new Set(('z.b zb d.h dh bzw ca nr s jh jhd v n chr dr prof usw etc u.a ua vgl abb tab bsp evtl ggf inkl '
  + 'max min mio mrd st str e.g i.e vs mr mrs ms no fig').split(' '));
const MONTHS = /^(jan|feb|mär|maer|apr|mai|jun|jul|aug|sep|okt|nov|dez)/i;

/** Text in Sätze zerlegen. Ein Punkt nach einer Ordnungszahl („am 5. Mai“)
    oder einer Abkürzung („z. B.“) beendet keinen Satz. */
function splitSentences(text) {
  const t = String(text).replace(/\s*\n\s*/g, ' ').trim();
  const out = [];
  let start = 0;
  const re = /([.!?])\s+(?=[\p{Lu}„"(\d])/gu;
  let m;
  while ((m = re.exec(t))) {
    const before = t.slice(start, m.index);
    const lastWord = (before.match(/(\S+)$/) || ['', ''])[1].toLowerCase().replace(/^[„"(]/, '');
    const after = t.slice(m.index + m[0].length, m.index + m[0].length + 12);
    if (m[1] === '.') {
      if (/^\d{1,2}$/.test(lastWord) && MONTHS.test(after)) continue;          // „am 5. Mai“
      if (/^\d{1,2}$/.test(lastWord) && /^(jh|jahrhundert)/i.test(after)) continue;
      if (ABBR.has(lastWord) || /^(\p{L}\.)+\p{L}$/u.test(lastWord) || /^\p{L}$/u.test(lastWord)) continue;   // „z. B.“, „u.a.“
    }
    out.push(t.slice(start, m.index + 1).trim());
    start = m.index + m[0].length;
  }
  if (start < t.length) out.push(t.slice(start).trim());
  return out.filter(Boolean);
}

/** „Begriff: …“, „Begriff – …“ oder Vokabelzeile: so eine Zeile beginnt
    immer einen eigenen Block, auch ohne Leerzeile davor. */
const ENTRY_RE = /^[^:=–—\t]{1,60}?(?:\s*:\s|\s[–—-]\s|\s=\s|\t)\S/u;
const ONLY_BULLET_RE = /^\s*[•·▪▫●○◦■□►▶▷➢➤✓✔→⇒\-–—*]\s*$/;

/** Zeilen zu Blöcken: Absätze werden zusammengezogen, Stichpunkte bleiben
    einzeln, Fortsetzungszeilen hängen an ihrem Stichpunkt.
    Manche PDFs legen die Aufzählungszeichen als eigene Spalte ab — dann
    kommen erst vier „•“ und danach die vier Texte. `pending` zählt solche
    verwaisten Zeichen und ordnet sie den folgenden Zeilen zu. */
function toBlocks(text) {
  const lines = String(text).split('\n');
  const blocks = [];
  let cur = null;
  let pending = 0;
  const flush = () => { if (cur) blocks.push(cur); cur = null; };
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) { flush(); continue; }
    if (ONLY_BULLET_RE.test(line)) { flush(); pending++; continue; }
    if (pending > 0) {
      pending--;
      flush();
      cur = { t: 'bullet', s: line };
      continue;
    }
    if (BULLET_RE.test(line)) {
      flush();
      cur = { t: 'bullet', s: line.replace(BULLET_RE, '').trim() };
      continue;
    }
    if (looksLikeHeading(line) && !ENTRY_RE.test(line)) {
      flush();
      blocks.push({ t: 'head', s: line.replace(/^\d+(\.\d+)*\.?\s+/, '').replace(/:$/, '').trim() });
      continue;
    }
    if (ENTRY_RE.test(line)) { flush(); cur = { t: 'para', s: line }; continue; }
    // Fortsetzung, wenn die Zeile davor mitten im Satz endet oder diese
    // klein beginnt (Zeilenumbruch im Fließtext)
    const cont = cur && (/^[\p{Ll}(,]/u.test(line) || !/[.!?:;]$/.test(cur.s));
    if (cur && cont && (cur.t === 'para' || (cur.t === 'bullet' && /^[\p{Ll}(,]/u.test(line)))) {
      cur.s += (/-$/.test(cur.s) ? '' : ' ') + line;
      continue;
    }
    flush();
    cur = { t: 'para', s: line };
  }
  flush();
  return blocks;
}

function looksLikeHeading(line) {
  if (line.length > 70 || line.length < 3) return false;
  if (/[.,;!?]$/.test(line) && !/:$/.test(line)) return false;
  if (/^\d+(\.\d+)*\.?\s+\p{Lu}/u.test(line)) return true;              // „2.1 Zellatmung“
  if (/:$/.test(line) && line.split(/\s+/).length <= 7) return true;   // „Merkmale:“
  const words = line.split(/\s+/);
  if (words.length > 8) return false;
  if (line === line.toUpperCase() && /\p{Lu}{3}/u.test(line)) return true;
  // Kurze Zeile ohne Verb-typische Kleinwörter am Ende → vermutlich Titel
  return words.length <= 6 && /^\p{Lu}/u.test(line) && !/\s(ist|sind|wird|werden|hat|haben)\s/.test(' ' + line + ' ');
}

const tidy = (s) => String(s).replace(/\s+/g, ' ').replace(/\s+([,.;:!?])/g, '$1').trim();
const cap = (s, n) => (s.length > n ? s.slice(0, n - 1).replace(/\s+\S*$/, '') + ' …' : s);

function termOk(term) {
  const t = term.trim();
  if (t.length < 2 || t.length > 60) return false;
  if (t.split(/\s+/).length > 6) return false;
  if (!/\p{L}{2}/u.test(t)) return false;
  if (/^(es|er|sie|das|dies|dieser|diese|man|wir|ich|du|it|this|there|he|she|they)$/i.test(t)) return false;
  if (/^(hier|dabei|dann|also|daher|so|beispiel|z\.?\s?b\.?)/i.test(t)) return false;
  return true;
}

function defOk(def) {
  const d = def.trim();
  return d.length >= 8 && d.length <= 320 && d.split(/\s+/).length >= 2 && /\p{L}{3}/u.test(d);
}

/** „Begriff: Erklärung“ / „Begriff – Erklärung“ / „Begriff = Erklärung“ */
function matchColonDef(s) {
  const m = s.match(/^([^:=–—]{2,60}?)\s*(?::|\s[–—-]\s|\s=\s)\s*(.+)$/u);
  if (!m) return null;
  const term = m[1].replace(/^(?:def(?:inition)?\.?|begriff)\s*/i, '').trim();
  const def = m[2].trim();
  if (/^(merke|wichtig|achtung|hinweis|beispiel|bsp|aufgabe|lösung|tipp|note|z\.\s?b)\.?$/i.test(term)) return null;
  if (!termOk(term) || !defOk(def)) return null;
  return { term, def };
}

/** Definitionssätze — die stärkeren Muster zuerst. */
function matchDefSentence(s) {
  let m;
  const T = '([\\p{Lu}„"][\\p{L}\\p{N}\\-„“"\' ]{1,58}?)';
  if ((m = s.match(new RegExp(`^Unter (?:dem |der |den |einem |einer |einen )?${T},? versteht man (.+?)[.]?$`, 'u')))) return { term: m[1], def: m[2] };
  if ((m = s.match(new RegExp(`^Als ${T} (?:bezeichnet|definiert) man (.+?)[.]?$`, 'u')))) return { term: m[1], def: m[2] };
  if ((m = s.match(new RegExp(`^(.+?) (?:bezeichnet|nennt) man (?:als |auch )?${T}[.]?$`, 'u')))) return { term: m[2], def: m[1] };
  if ((m = s.match(new RegExp(`^(.+?) (?:wird|werden) (?:auch )?als ${T} bezeichnet[.]?$`, 'u')))) return { term: m[2], def: m[1] };
  if ((m = s.match(new RegExp(`^(?:Der |Die |Das |Ein |Eine )?(?:Begriff )?${T} (?:bezeichnet|bedeutet|beschreibt|meint|definiert) (.+?)[.]?$`, 'u')))) return { term: m[1], def: m[2] };
  // „X ist ein/eine/der/die/das …“ — Gattung + Merkmal, typische Lehrbuch-Definition
  if ((m = s.match(new RegExp(`^(?:Der |Die |Das |Ein |Eine )?${T} (?:\\([^)]{1,40}\\) )?(?:ist|sind) (ein|eine|einer|der|die|das|diejenige|derjenige|dasjenige|die Bezeichnung für|ein Begriff für) (.+?)[.]?$`, 'u')))) {
    return { term: m[1], def: (m[2] + ' ' + m[3]).replace(/^die Bezeichnung für |^ein Begriff für /, '') };
  }
  // Englisch, für Fremdsprachen-Material
  if ((m = s.match(/^(?:The |An? )?([A-Z][\w\- ]{1,40}?) (?:is|are) (?:defined as |called )?(an? .+?|the .+?)[.]?$/))) return { term: m[1], def: m[2] };
  if ((m = s.match(/^(?:The term )?([A-Z][\w\- ]{1,40}?) (?:refers to|means|describes) (.+?)[.]?$/))) return { term: m[1], def: m[2] };
  return null;
}

/** Wichtigstes Nomen eines deutschen Satzes raten: das längste
    großgeschriebene Wort, das nicht am Satzanfang steht. */
function keyNoun(sentence, known) {
  const words = sentence.split(/\s+/);
  const knownHit = known && [...known].find((k) => k.length > 3 && new RegExp(`(^|[^\\p{L}])${escRe(k)}([^\\p{L}]|$)`, 'u').test(sentence));
  if (knownHit) return knownHit;
  let best = '';
  for (let i = 1; i < words.length; i++) {
    const w = words[i].replace(/^[„"(]+|[“",.;:!?)]+$/g, '');
    if (/^\p{Lu}\p{Ll}{4,}/u.test(w) && w.length > best.length) best = w;
  }
  return best;
}

const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function makeCloze(sentence, target) {
  const re = new RegExp(`(^|[^\\p{L}])(${escRe(target)})(?=[^\\p{L}]|$)`, 'u');
  return re.test(sentence) ? sentence.replace(re, '$1{{$2}}') : null;
}

/**
 * Offline erzeugen. pages: [{n, text}] (schon bereinigt oder roh).
 * opts.amount: 'wenig' | 'normal' | 'viel'
 * Ergebnis im selben Format wie normalizeGen() es aus KI-Antworten macht.
 */
function generateOffline(pagesIn, opts) {
  opts = opts || {};
  const pages = cleanPages(pagesIn);
  const factor = { wenig: 0.5, normal: 1, viel: 1.8 }[opts.amount] || 1;
  const totalChars = pages.reduce((a, p) => a + p.text.length, 0);
  const maxCards = Math.round(clamp(totalChars / 110, 8, 200) * factor);

  const glossary = [];
  const cards = [];
  const seen = new Set();
  const usedSentences = new Set();
  const headings = [];
  const keyPoints = [];
  let vocabCards = 0;

  const addCard = (c) => {
    const k = dedupeKey(c.front) + '|' + dedupeKey(c.back || '');
    const kf = dedupeKey(c.front);
    if (seen.has(k) || seen.has(kf)) return false;
    seen.add(k); seen.add(kf);
    cards.push(Object.assign({ kind: 'basic', hint: '' }, c));
    return true;
  };
  const addTerm = (term, def, page) => {
    term = tidy(term).replace(/^[„"]|[“"]$/g, '');
    def = tidy(def).replace(/^[,:\-–]\s*/, '')
      // Aus „bezeichnet man den Kreisprozess …“ kommt der Akkusativ mit
      .replace(/^(den|dem)\s/i, 'der ').replace(/^(einen|einem)\s/i, 'ein ');
    def = def.charAt(0).toUpperCase() + def.slice(1);
    if (/^(dies\w*|das|es)$/i.test(def) || def.split(/\s+/).length < 2) return;
    if (!termOk(term) || !defOk(def)) return;
    if (glossary.some((g) => dedupeKey(g.term) === dedupeKey(term))) return;
    glossary.push({ term, def: cap(def, 300), page });
  };

  // Durchgang 1: Muster je Seite
  const perPage = [];
  for (const p of pages) {
    const blocks = toBlocks(p.text);
    perPage.push({ n: p.n, blocks });
    let lastHead = null;
    let vocabRun = [];
    const flushVocab = () => {
      if (vocabRun.length >= 4) {
        for (const v of vocabRun) {
          if (addCard({ front: v.a, back: v.b, page: p.n, tag: 'vokabel', dir: 'a' })) vocabCards++;
          if (addCard({ front: v.b, back: v.a, page: p.n, tag: 'vokabel', dir: 'b' })) vocabCards++;
        }
      } else {
        for (const v of vocabRun) addTerm(v.a, v.b, p.n);
      }
      vocabRun = [];
    };

    for (let i = 0; i < blocks.length; i++) {
      const b = blocks[i];
      if (b.t === 'head') {
        flushVocab();
        lastHead = b.s;
        headings.push({ s: b.s, page: p.n });
        // Stichpunktliste direkt darunter → „Nenne …“
        const list = [];
        for (let j = i + 1; j < blocks.length && blocks[j].t === 'bullet'; j++) list.push(blocks[j].s);
        if (list.length >= 2 && list.length <= 8 && list.every((x) => x.length <= 140)
            && !list.every((x) => matchColonDef(x))) {
          addCard({
            front: `${b.s}: Nenne die ${list.length} Punkte.`,
            back: list.map((x) => '• ' + tidy(x)).join('\n'),
            page: p.n, tag: 'liste',
          });
        }
        continue;
      }

      const line = b.s;
      // „Unit 3 – Globalisation“, „Biologie Q1 – Stoffwechsel“: Titelzeile, kein Begriff
      if (TITLE_RE.test(line.split(/\s[–—-]\s|:/)[0])) { flushVocab(); lastHead = line; headings.push({ s: line, page: p.n }); continue; }
      // Vokabelzeile: beide Seiten kurz, Trennstrich oder Gleichheitszeichen
      const vm = line.match(/^([^–—=:\t]{1,40}?)\s*(?:\t+|\s{2,}|\s[–—-]\s|\s=\s)\s*([^–—=:\t]{1,40})$/u);
      if (vm && vm[1].split(/\s+/).length <= 4 && vm[2].split(/\s+/).length <= 4 && !/[.!?]$/.test(line)) {
        vocabRun.push({ a: tidy(vm[1]), b: tidy(vm[2]) });
        continue;
      }
      flushVocab();

      const cd = matchColonDef(line);
      if (cd) { addTerm(cd.term, cd.def, p.n); usedSentences.add(line); continue; }

      if (/^(merke|wichtig|merksatz|achtung|regel|def(inition)?)\s*[:!]/i.test(line)) {
        const body = tidy(line.replace(/^[^:!]+[:!]\s*/, ''));
        if (body.length > 15) keyPoints.push({ s: body, page: p.n, head: lastHead });
      }

      let prev = '';
      for (const s of splitSentences(line)) {
        const d = matchDefSentence(s);
        if (d) {
          // „Diesen Vorgang bezeichnet man als Photolyse.“ — die eigentliche
          // Erklärung steht im Satz davor
          if (/^(dies\w*|das|es|diese[nrs]?\s+\p{L}+|solche\w*\s+\p{L}+)$/iu.test(d.def.trim()) && prev) d.def = prev.replace(/[.!?]$/, '');
          addTerm(d.term, d.def, p.n);
          usedSentences.add(s);
        }
        prev = s;
      }
    }
    flushVocab();
  }

  // Glossar → Begriffskarten
  for (const g of glossary) {
    addCard({ front: g.term, back: g.def, page: g.page, tag: 'begriff' });
  }

  // Durchgang 2: Lückentexte aus Merksätzen, Jahreszahlen, Sätzen mit Fachbegriffen
  const known = new Set(glossary.map((g) => g.term));
  const clozeBudget = Math.max(4, Math.round(maxCards * 0.45));
  let clozes = 0;
  const tryCloze = (s, page, target) => {
    s = s.replace(/^(merke|wichtig|merksatz|achtung|regel|def(inition)?)\s*[:!]\s*/i, '');
    if (clozes >= clozeBudget || cards.length >= maxCards * 1.2) return;
    if (s.length < 30 || s.length > 240 || usedSentences.has(s)) return;
    const t = target || keyNoun(s, known);
    if (!t) return;
    const c = makeCloze(s, t);
    if (c && addCard({ kind: 'cloze', front: c, back: '', page })) { clozes++; usedSentences.add(s); }
  };

  for (const kp of keyPoints) tryCloze(kp.s, kp.page);
  for (const pp of perPage) {
    for (const b of pp.blocks) {
      if (b.t !== 'para' && b.t !== 'bullet') continue;
      for (const s of splitSentences(b.s)) {
        const y = s.match(/(?:^|[^\d])((?:1[0-9]|20)\d{2})(?:[^\d]|$)/);
        if (y && /\p{L}{4}/u.test(s)) tryCloze(s, pp.n, y[1]);
      }
    }
  }
  for (const pp of perPage) {
    for (const b of pp.blocks) {
      if (b.t !== 'para') continue;
      for (const s of splitSentences(b.s)) {
        if ([...known].some((k) => s.includes(k))) tryCloze(s, pp.n);
      }
    }
  }
  // Fließtext ohne erkennbare Muster: wenigstens etwas zum Üben anbieten
  if (cards.length < 6) {
    for (const pp of perPage) {
      for (const b of pp.blocks) {
        if (b.t === 'head') continue;
        for (const s of splitSentences(b.s)) tryCloze(s, pp.n);
      }
    }
  }

  // Vokabeln sind kurz und zählen nicht gegen die Obergrenze
  const finalCards = cards.slice(0, maxCards + vocabCards);
  const questions = buildQuestions(glossary, finalCards, { max: Math.round(clamp(finalCards.length * 0.7, 4, 40) * factor) });

  // Lernzettel aus Gliederung, Merksätzen und Begriffen
  const sum = [];
  if (headings.length) {
    sum.push('## Gliederung');
    for (const h of headings.slice(0, 30)) sum.push(`- ${h.s} (S. ${h.page})`);
  }
  // Merksätze stehen als keyPoints daneben — hier nicht doppelt
  const firstHead = headings[0] && headings[0].s;

  return {
    // Erste Überschrift schlägt Dateinamen („Scan_0034“), außer sie ist nur ein Wort wie „Mitschrift“
    title: (firstHead && firstHead.length >= 4 && !/^(mitschrift|notizen|notes|arbeitsblatt|ab|inhalt)$/i.test(firstHead) ? firstHead : '') || opts.title || 'Neuer Stapel',
    subject: '',
    summary: sum.join('\n'),
    keyPoints: keyPoints.slice(0, 20).map((k) => k.s),
    glossary: glossary.map((g) => ({ term: g.term, def: g.def, page: g.page })),
    cards: finalCards.map((c) => ({ kind: c.kind, front: c.front, back: c.back, hint: '', page: c.page || 0, tag: c.tag || '', dir: c.dir || '' })),
    questions,
  };
}

/**
 * Quizfragen aus Begriffen und Karten bauen — offline, aber auch für
 * KI-Stapel nutzbar, wenn die KI zu wenige Fragen geliefert hat.
 */
function buildQuestions(glossary, cards, opts) {
  opts = opts || {};
  const rnd = opts.rnd || Math.random;
  const max = opts.max || 20;
  const qs = [];
  const terms = glossary.filter((g) => g.term && g.def);

  // Vokabeln: „Was heißt …?“, falsche Antworten aus derselben Sprachrichtung
  for (const dir of ['a', 'b']) {
    const vs = cards.filter((c) => c.tag === 'vokabel' && c.dir === dir);
    if (vs.length < 4) continue;
    for (const v of shuffle(vs, rnd).slice(0, Math.ceil(max / 3))) {
      const opts2 = shuffle([v.back, ...shuffle(vs.filter((o) => o !== v), rnd).slice(0, 3).map((o) => o.back)], rnd);
      qs.push({ kind: 'mc', q: `Was heißt „${v.front}“?`, options: opts2, correct: opts2.indexOf(v.back),
        answer: '', explain: `${v.front} – ${v.back}`, page: v.page || 0 });
    }
  }

  // Ohne Glossar dienen kurze Begriffskarten als Material
  const pool = terms.length >= 4 ? terms
    : cards.filter((c) => c.kind === 'basic' && c.tag !== 'vokabel' && c.front.length <= 60 && c.back && c.back.length <= 300 && !/\n/.test(c.back))
      .map((c) => ({ term: c.front, def: c.back, page: c.page }));

  if (pool.length >= 4) {
    shuffle(pool, rnd).forEach((g, i) => {
      const others = shuffle(pool.filter((o) => o !== g), rnd).slice(0, 3);
      if (i % 3 === 0) {
        const opts2 = shuffle([g.def, ...others.map((o) => o.def)].map((d) => cap(d, 160)), rnd);
        qs.push({ kind: 'mc', q: `Was beschreibt „${g.term}“?`, options: opts2, correct: opts2.indexOf(cap(g.def, 160)),
          answer: '', explain: `${g.term}: ${g.def}`, page: g.page || 0 });
      } else if (i % 3 === 1) {
        const opts2 = shuffle([g.term, ...others.map((o) => o.term)], rnd);
        qs.push({ kind: 'mc', q: `Welcher Begriff passt zu dieser Beschreibung?\n„${cap(g.def, 220)}“`, options: opts2,
          correct: opts2.indexOf(g.term), answer: '', explain: `Gesucht war „${g.term}“.`, page: g.page || 0 });
      } else {
        const truth = rnd() < 0.5;
        const def = truth ? g.def : others[0].def;
        qs.push({ kind: 'tf', q: `${g.term}: ${cap(def, 220)}`, options: ['Richtig', 'Falsch'], correct: truth ? 0 : 1,
          answer: '', explain: truth ? 'Das stimmt so.' : `Falsch — das beschreibt „${others[0].term}“. ${g.term}: ${cap(g.def, 200)}`,
          page: g.page || 0 });
      }
    });
  }
  // Lückentexte mit Jahreszahl oder Begriff als offene Frage
  for (const c of cards) {
    if (qs.length >= max * 1.5) break;
    if (c.kind === 'cloze') {
      const ans = clozeAnswer(c.front, 0);
      const q = clozeParts(c.front, 0).map((p) => (p.t === 'gap' ? '_____' : p.s)).join('');
      qs.push({ kind: 'open', q: `Ergänze: ${q}`, options: [], correct: 0, answer: ans, explain: clozePlain(c.front), page: c.page || 0 });
    } else if (c.tag === 'liste') {
      qs.push({ kind: 'open', q: c.front, options: [], correct: 0, answer: c.back, explain: '', page: c.page || 0 });
    }
  }
  return shuffle(qs, rnd).slice(0, max);
}

/* ── 7. Ergebnis prüfen und vereinheitlichen ───────────────────
   Gilt für die strukturierte Antwort der API genauso wie für JSON, das der
   Schüler aus einem Claude-Chat einfügt — dort kann alles Mögliche ankommen:
   Codeblöcke drumherum, abgeschnittenes Ende, andere Feldnamen. */

/** JSON aus einem Text holen, notfalls abgeschnittenes Ende reparieren. */
function parseLooseJSON(text) {
  let t = String(text || '').trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)(?:```|$)/i);
  if (fence && fence[1].includes('{')) t = fence[1].trim();
  const start = t.search(/[{[]/);
  if (start < 0) throw new Error('Kein JSON gefunden.');
  t = t.slice(start);
  try { return JSON.parse(t); } catch (e) { /* weiter unten reparieren */ }

  // Hinter dem letzten schließenden Objekt abschneiden und offene Klammern
  // schließen. Rettet eine Antwort, die wegen Längenlimit mittendrin endet.
  for (let cut = t.length; cut > 0; cut = t.lastIndexOf('}', cut - 1)) {
    const head = t.slice(0, cut + (t[cut] === '}' ? 1 : 0));
    const closed = closeBrackets(head);
    if (closed) {
      try { return JSON.parse(closed); } catch (e) { /* nächster Versuch */ }
    }
    if (cut <= 0) break;
  }
  throw new Error('Das JSON ist unvollständig oder fehlerhaft.');
}

function closeBrackets(s) {
  const stack = [];
  let inStr = false, escp = false;
  for (const ch of s) {
    if (inStr) {
      if (escp) escp = false;
      else if (ch === '\\') escp = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{' || ch === '[') stack.push(ch);
    else if (ch === '}' || ch === ']') stack.pop();
  }
  if (inStr) return null;
  let out = s.replace(/,\s*$/, '');
  while (stack.length) out += stack.pop() === '{' ? '}' : ']';
  return out;
}

const str = (v) => (v == null ? '' : typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '').trim();
const pick = (o, ...keys) => { for (const k of keys) if (o && o[k] != null && o[k] !== '') return o[k]; return undefined; };
const pageNo = (v) => { const n = parseInt(v, 10); return isFinite(n) && n > 0 ? n : 0; };

/**
 * Beliebiges Generator-Ergebnis in die feste Form bringen.
 * Lückenkarten mit mehreren Lücken werden in Einzelkarten aufgeteilt.
 */
function normalizeGen(src) {
  const o = src && typeof src === 'object' ? src : {};
  const root = Array.isArray(o) ? { cards: o } : o;
  const out = {
    title: str(pick(root, 'title', 'titel', 'deck', 'name')).slice(0, 120),
    subject: str(pick(root, 'subject', 'fach')).slice(0, 60),
    summary: str(pick(root, 'summary', 'zusammenfassung', 'lernzettel')).slice(0, 40000),
    keyPoints: [],
    glossary: [],
    cards: [],
    questions: [],
  };
  const arr = (v) => (Array.isArray(v) ? v : []);

  for (const k of arr(pick(root, 'keyPoints', 'key_points', 'kernaussagen'))) {
    const s = str(typeof k === 'object' ? pick(k, 'text', 'point') : k);
    if (s) out.keyPoints.push(s.slice(0, 500));
  }
  for (const g of arr(pick(root, 'glossary', 'glossar', 'terms', 'begriffe'))) {
    const term = str(pick(g, 'term', 'begriff', 'name'));
    const def = str(pick(g, 'definition', 'def', 'erklaerung', 'erklärung', 'meaning'));
    if (term && def) out.glossary.push({ term: term.slice(0, 120), def: def.slice(0, 800), page: pageNo(pick(g, 'page', 'seite')) });
  }

  const seen = new Set();
  for (const c of arr(pick(root, 'cards', 'karten', 'flashcards'))) {
    let front = str(pick(c, 'front', 'question', 'frage', 'vorderseite', 'q', 'text'));
    const back = str(pick(c, 'back', 'answer', 'antwort', 'rueckseite', 'rückseite', 'a'));
    const hint = str(pick(c, 'hint', 'hinweis', 'extra', 'note')).slice(0, 600);
    const page = pageNo(pick(c, 'page', 'seite'));
    if (!front) continue;
    front = front.slice(0, 1500);
    const n = clozeCount(front);
    const kind = n > 0 ? 'cloze' : 'basic';
    if (kind === 'basic' && !back) continue;
    if (kind === 'cloze') {
      // Jede Lücke als eigene Karte: die anderen Lücken stehen offen da
      const parts = clozeParts(front, -1);
      let gi = 0;
      for (let i = 0; i < n && i < 4; i++) {
        const text = parts.map((p) => (p.t === 'text' ? p.s : (gi++ === i ? `{{${p.s}${p.hint ? '::' + p.hint : ''}}}` : p.s))).join('');
        gi = 0;
        const k = dedupeKey(text) + '#' + dedupeKey(clozeAnswer(text, 0));
        if (seen.has(k)) continue;
        seen.add(k);
        out.cards.push({ kind: 'cloze', front: text, back: back.slice(0, 1500), hint, page });
      }
      continue;
    }
    const k = dedupeKey(front) + '|' + dedupeKey(back);
    if (seen.has(k)) continue;
    seen.add(k);
    out.cards.push({ kind, front, back: back.slice(0, 2000), hint, page });
  }

  for (const q of arr(pick(root, 'questions', 'quiz', 'fragen'))) {
    const text = str(pick(q, 'question', 'q', 'frage', 'text'));
    if (!text) continue;
    let kind = str(pick(q, 'kind', 'type', 'typ')).toLowerCase();
    let options = arr(pick(q, 'options', 'choices', 'antworten', 'optionen')).map((x) => str(typeof x === 'object' ? pick(x, 'text', 'option') : x)).filter(Boolean);
    let correct = pick(q, 'correct', 'correctIndex', 'correct_index', 'richtig', 'solution');
    const answer = str(pick(q, 'answer', 'antwort', 'musterloesung', 'musterlösung', 'model_answer'));
    const explain = str(pick(q, 'explanation', 'explain', 'erklaerung', 'erklärung', 'begruendung')).slice(0, 1200);
    const page = pageNo(pick(q, 'page', 'seite'));

    if (/^(tf|true|wahr|richtig|bool)/.test(kind) || (!kind && options.length === 0 && typeof correct === 'boolean')) {
      kind = 'tf';
      if (typeof correct === 'boolean') correct = correct ? 0 : 1;
      else if (typeof correct === 'string') correct = /^(true|wahr|richtig|ja|0)$/i.test(correct) ? 0 : 1;
      options = ['Richtig', 'Falsch'];
    } else if (options.length >= 2) {
      kind = 'mc';
      if (typeof correct === 'string') {
        const i = options.findIndex((o) => fold(o) === fold(correct));
        correct = i >= 0 ? i : /^[a-f]$/i.test(correct) ? correct.toLowerCase().charCodeAt(0) - 97 : parseInt(correct, 10);
      }
      options = options.slice(0, 6).map((x) => x.slice(0, 400));
    } else {
      kind = 'open';
      options = [];
      correct = 0;
      if (!answer) continue;
    }
    correct = parseInt(correct, 10);
    if (kind !== 'open' && !(correct >= 0 && correct < options.length)) continue;
    out.questions.push({ kind, q: text.slice(0, 1500), options, correct, answer: answer.slice(0, 2000), explain, page });
  }
  return out;
}

/* ── 8. Mini-Markdown ──────────────────────────────────────────
   Für Zusammenfassungen und Tutor-Antworten: Überschriften, Listen,
   fett/kursiv, Code, einfache Tabellen. Erst wird ALLES maskiert, dann
   werden nur die eigenen Tags eingesetzt — KI-Text kann so kein HTML
   einschleusen. */

function md(src, esc) {
  const lines = String(src || '').replace(/\r/g, '').split('\n');
  const out = [];
  let list = null;      // 'ul' | 'ol'
  let para = [];
  let table = null;
  const inline = (s) => esc(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*\w])\*([^*\n]+)\*(?!\w)/g, '$1<em>$2</em>')
    .replace(/(^|[^_\w])_([^_\n]+)_(?!\w)/g, '$1<em>$2</em>');
  const flushPara = () => { if (para.length) out.push(`<p>${para.map(inline).join('<br>')}</p>`); para = []; };
  const flushList = () => { if (list) out.push(`</${list}>`); list = null; };
  const flushTable = () => {
    if (!table) return;
    const rows = table.filter((r) => !/^\s*\|?\s*:?-{2,}/.test(r));
    const cells = (r) => r.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map((c) => inline(c.trim()));
    out.push('<div class="md-table"><table>' + rows.map((r, i) =>
      `<tr>${cells(r).map((c) => (i === 0 ? `<th>${c}</th>` : `<td>${c}</td>`)).join('')}</tr>`).join('') + '</table></div>');
    table = null;
  };
  for (const raw of lines) {
    const line = raw.trimEnd();
    if (/^\s*\|.*\|\s*$/.test(line)) { flushPara(); flushList(); (table = table || []).push(line); continue; }
    flushTable();
    let m;
    if (!line.trim()) { flushPara(); flushList(); continue; }
    if ((m = line.match(/^(#{1,4})\s+(.*)$/))) {
      flushPara(); flushList();
      const lvl = Math.min(4, m[1].length + 2);
      out.push(`<h${lvl}>${inline(m[2])}</h${lvl}>`);
      continue;
    }
    if ((m = line.match(/^\s*(?:[-*•]|(\d+)[.)])\s+(.*)$/))) {
      flushPara();
      const kind = m[1] ? 'ol' : 'ul';
      if (list !== kind) { flushList(); out.push(`<${kind}>`); list = kind; }
      out.push(`<li>${inline(m[2])}</li>`);
      continue;
    }
    if (/^\s*(-{3,}|\*{3,})\s*$/.test(line)) { flushPara(); flushList(); out.push('<hr>'); continue; }
    if ((m = line.match(/^>\s?(.*)$/))) { flushPara(); flushList(); out.push(`<blockquote>${inline(m[1])}</blockquote>`); continue; }
    flushList();
    para.push(line.trim());
  }
  flushPara(); flushList(); flushTable();
  return out.join('\n');
}

/* ── 9. Notenpunkte ────────────────────────────────────────────
   Übliche Oberstufen-Tabelle (Prozent → Punkte), dazu die Schulnote. */
const POINT_TABLE = [95, 90, 85, 80, 75, 70, 65, 60, 55, 50, 45, 40, 33, 27, 20];

function grade(percent) {
  const p = clamp(percent, 0, 100);
  let points = 0;
  for (let i = 0; i < POINT_TABLE.length; i++) if (p >= POINT_TABLE[i]) { points = 15 - i; break; }
  const notes = ['6', '5−', '5', '5+', '4−', '4', '4+', '3−', '3', '3+', '2−', '2', '2+', '1−', '1', '1+'];
  return { points, note: notes[points] };
}

return {
  MIN, DAY, shuffle, sample, clamp, fold, dedupeKey, levenshtein, similarity,
  newState, schedule, previewLabels, fmtWait, dayStart, addDays, dayKey, daysUntil, isMature,
  clozeCount, clozeParts, clozePlain, clozeAnswer,
  checkAnswer,
  itemsToText, isInkPage, cleanPages, splitSentences, toBlocks,
  generateOffline, buildQuestions,
  parseLooseJSON, normalizeGen,
  md, grade,
};
})();

if (typeof module === 'object' && module.exports) module.exports = Core;
