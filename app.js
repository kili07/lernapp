'use strict';
/* ═══════════════════════════════════════════════════════════════
   Lernapp — Unterrichtsmaterial rein, Lernmaterial raus

   PDFs (auch GoodNotes-Exporte mit Handschrift), Fotos und Textdateien
   werden zu Karteikarten, Quizfragen und Lernzettel. Gelernt wird mit
   verteilter Wiederholung, Quiz, Schreibmodus, Zuordnen, Probetest,
   Feynman-Methode, Tutor-Chat und Bildkarten (verdeckte Beschriftungen).

   Datenhaltung
   - localStorage 'lernapp.v1': Fächer, Stapel, Karten mit Lernstand,
     Quizfragen, Statistik, Einstellungen — ein JSON-Objekt, siehe blank().
   - localStorage 'lernapp.key': der API-Schlüssel, getrennt, damit er nie
     in einem Backup landet.
   - IndexedDB 'lernapp-files': die Dateien selbst und der erkannte Text je
     Seite. Ein PDF passt nicht in localStorage (5 MB für alles).

   Aufbau dieser Datei
    1. Konstanten, Datenmodell, Persistenz
    2. Dateispeicher (IndexedDB)
    3. Helfer, Symbole, Toast
    4. Sheet-System, Dialoge, Navigation, Zurück-Taste
    5. Abfragen auf den Daten (fällig, neu, Fortschritt)
    6. Import: Dateien lesen, Text erkennen
    7. Erzeugen: KI, offline, Claude-Chat — und als Stapel ablegen
    8. Ansichten: Heute, Stapel, Stapel-Detail, Karten, Üben, Statistik
    9. Lernen (Karteikarten mit Wiederholungsplan)
   10. Quiz, Schreiben, Probetest
   11. Zuordnen
   12. Lernzettel, Dokument, Bildkarten
   13. Tutor, Feynman, Erklären
   14. Einstellungen, Backup, Updates, Installieren
   15. Start
   ═══════════════════════════════════════════════════════════════ */

/* ── 1. Konstanten, Datenmodell, Persistenz ─────────────────── */

const KEY = 'lernapp.v1';
const KEY_API = 'lernapp.key';
/* Bei jeder Änderung hochzählen — wird in den Einstellungen angezeigt, damit
   sich auf dem Handy prüfen lässt, welche Fassung wirklich läuft. */
const APP_VERSION = '1.0.0';

const THEME_KEY = 'lernapp.theme';
/* `bar` ist die Hintergrundfarbe des Themes und landet im
   <meta name="theme-color">, damit die Systemleiste des Handys mitzieht —
   muss mit --bg in style.css übereinstimmen. */
const THEMES = {
  dark:  { label: 'Dunkel', bar: '#0b0e14' },
  light: { label: 'Hell',   bar: '#f3f5f9' },
};

/* Fächerfarben: Index in die Tokens --sj-0 … --sj-7 in style.css */
const SUBJECT_COLORS = 8;
/* Typische Fächer bekommen eine feste Farbe, damit Bio nicht jedes Mal
   anders aussieht. Alles andere reihum. */
const SUBJECT_HINTS = [
  [/bio/i, 2], [/chem/i, 5], [/phys/i, 0], [/mathe|math/i, 1], [/deutsch/i, 6], [/engl/i, 3],
  [/franz|span|latein|ital/i, 4], [/gesch|histor/i, 7], [/erdk|geo/i, 2], [/poli|sowi|wirt|pw/i, 4],
  [/info/i, 0], [/kunst|musik/i, 6], [/reli|ethik|philo/i, 7],
];

/** Frische Grundstruktur. Basis beim Laden und beim Backup-Import, damit
    später ergänzte Felder in alten Daten nicht fehlen. */
const blank = () => ({
  v: 1,
  subjects: [],       // {id, name, color}
  docs: [],           // {id, name, kind:'pdf'|'image'|'text', mime, added, bytes, hash, pages, inkPages, chars,
                      //  subjectId, status:'ready'|'error', error, gen:{mode, at, model, usd, cards, questions},
                      //  summary, keyPoints:[], glossary:[{term, def, page}]}
  decks: [],          // {id, name, subjectId, docIds:[], created, examDate:'JJJJ-MM-TT'|null, newPerDay:null, bestMatch}
  cards: [],          // {id, deckId, docId, kind:'basic'|'cloze'|'occl', front, back, hint, page, ord, created,
                      //  occl:{page, rects:[[x,y,w,h]], i}, susp, s:{…Core.newState()}}
  questions: [],      // {id, deckId, docId, kind:'mc'|'tf'|'open', q, options, correct, answer, explain, page, seen, right}
  days: {},           // 'JJJJ-MM-TT' → {rev, ok, nw, ms, q, qok, nd:{deckId:n}}
  tests: [],          // {id, deckId, at, n, score, max, points}
  chats: {},          // deckId → [{role, text}]
  settings: {
    newPerDay: 20,          // neue Karten pro Tag und Stapel
    model: AI.DEFAULT_MODEL,
    effort: 'high',         // 'medium' | 'high'
    send: 'auto',           // was an die KI geht: 'auto' | 'text' | 'pdf'
    amount: 'normal',       // 'wenig' | 'normal' | 'viel'
    autoGen: true,          // nach dem Import gleich erzeugen
    usd: 0,                 // KI-Kosten bisher (Schätzung aus den Token)
    hideKeyHint: false,
    gradeHelp: true,        // Erklärung der vier Knöpfe unter der Karte zeigen
  },
  theme: 'dark',
  setup: false,
  lastBackup: null,
});

let db = blank();

/** Fremden Datensatz (aus localStorage oder Backup) auf die aktuelle Struktur
    bringen. Object.assign allein reicht nicht: es ersetzt verschachtelte
    Objekte im Ganzen — ein älteres Unterobjekt ohne ein neues Feld würde die
    Vorgabe nicht ergänzen, sondern löschen. Daten haben Vorrang vor Vorgabe. */
function normalize(src) {
  const base = blank();
  const d = Object.assign(blank(), src || {});
  delete d.meta;                                   // Kopfdaten des Backups gehören nicht in die Daten
  delete d.files;                                  // Dateien aus dem Backup landen in IndexedDB

  const arr = (v) => (Array.isArray(v) ? v : []);
  d.subjects = arr(d.subjects).filter((x) => x && x.name).map((x) => Object.assign({ id: uid(), color: 0 }, x));
  d.docs = arr(d.docs).filter(Boolean).map((x) => Object.assign({
    id: uid(), name: 'Dokument', kind: 'pdf', added: Date.now(), bytes: 0, pages: 0, inkPages: 0, chars: 0,
    status: 'ready', gen: null, summary: '', keyPoints: [], glossary: [],
  }, x));
  d.docs.forEach((x) => { x.keyPoints = arr(x.keyPoints); x.glossary = arr(x.glossary); });
  d.decks = arr(d.decks).filter(Boolean).map((x) => Object.assign({ id: uid(), name: 'Stapel', subjectId: null, docIds: [], created: Date.now(), examDate: null, newPerDay: null }, x));
  d.decks.forEach((x) => { x.docIds = arr(x.docIds); });
  const deckIds = new Set(d.decks.map((x) => x.id));
  d.cards = arr(d.cards).filter((c) => c && deckIds.has(c.deckId)).map((c) => {
    const n = Object.assign({ id: uid(), kind: 'basic', front: '', back: '', hint: '', page: 0, ord: 0, created: Date.now() }, c);
    n.s = Object.assign(Core.newState(), c.s);
    return n;
  });
  d.questions = arr(d.questions).filter((q) => q && deckIds.has(q.deckId))
    .map((q) => Object.assign({ id: uid(), kind: 'mc', options: [], correct: 0, answer: '', explain: '', page: 0, seen: 0, right: 0 }, q));
  d.days = d.days && typeof d.days === 'object' ? d.days : {};
  d.tests = arr(d.tests);
  d.chats = d.chats && typeof d.chats === 'object' ? d.chats : {};
  d.settings = Object.assign(base.settings, src && src.settings);
  if (!AI.MODELS[d.settings.model]) d.settings.model = AI.DEFAULT_MODEL;
  if (!THEMES[d.theme]) d.theme = base.theme;
  return d;
}

function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return;
    db = normalize(JSON.parse(raw));
  } catch (e) { console.warn('Laden fehlgeschlagen', e); }
}

let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = null;
  try { localStorage.setItem(KEY, JSON.stringify(db)); }
  catch (e) {
    toast('Speichern fehlgeschlagen — Speicher voll?');
    console.error(e);
  }
}
/** Beim Lernen nach jeder Karte speichern wäre bei großen Datensätzen
    spürbar. Gebündelt, spätestens nach einer Sekunde und beim Verlassen. */
function saveSoon() {
  if (!saveTimer) saveTimer = setTimeout(save, 1000);
}
window.addEventListener('pagehide', () => { if (saveTimer) save(); });
document.addEventListener('visibilitychange', () => { if (document.hidden && saveTimer) save(); });

const getKey = () => { try { return localStorage.getItem(KEY_API) || ''; } catch (e) { return ''; } };
const setKey = (k) => { try { if (k) localStorage.setItem(KEY_API, k); else localStorage.removeItem(KEY_API); } catch (e) { /* egal */ } };
const hasKey = () => !!getKey();

/** Theme aufs Dokument legen. Der Spiegel in THEME_KEY ist das, was das
    Startskript in index.html liest — ohne ihn flackert der Start. */
function applyTheme(t) {
  if (!THEMES[t]) t = 'dark';
  db.theme = t;
  document.documentElement.dataset.theme = t;
  const meta = $('meta[name="theme-color"]');
  if (meta) meta.content = THEMES[t].bar;
  try { localStorage.setItem(THEME_KEY, t); } catch (e) { /* nicht schlimm */ }
}

const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

/* ── 2. Dateispeicher (IndexedDB) ───────────────────────────────
   Ein Datensatz je Dokument: {id, name, type, blob, pages:[{n, text, ink}]}.
   Die Seitentexte liegen mit hier, weil Tutor, Erklären und erneutes
   Erzeugen sie brauchen, sie aber schnell ein paar hundert KB groß werden. */
const Files = (() => {
  let dbp = null;
  const open = () => {
    if (!dbp) {
      dbp = new Promise((resolve, reject) => {
        if (!window.indexedDB) { reject(new Error('IndexedDB fehlt')); return; }
        const r = indexedDB.open('lernapp-files', 1);
        r.onupgradeneeded = () => { r.result.createObjectStore('files', { keyPath: 'id' }); };
        r.onsuccess = () => resolve(r.result);
        r.onerror = () => reject(r.error);
      }).catch((e) => { dbp = null; throw e; });
    }
    return dbp;
  };
  const tx = async (mode, fn) => {
    const d = await open();
    return new Promise((resolve, reject) => {
      const t = d.transaction('files', mode);
      const st = t.objectStore('files');
      let out;
      Promise.resolve(fn(st)).then((v) => { out = v; });
      t.oncomplete = () => resolve(out);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error || new Error('abgebrochen'));
    });
  };
  const req = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  return {
    put: (rec) => tx('readwrite', (st) => req(st.put(rec))),
    get: async (id) => { try { return await tx('readonly', (st) => req(st.get(id))); } catch (e) { return null; } },
    del: (id) => tx('readwrite', (st) => req(st.delete(id))).catch(() => {}),
    all: async () => { try { return await tx('readonly', (st) => req(st.getAll())); } catch (e) { return []; } },
    keys: async () => { try { return await tx('readonly', (st) => req(st.getAllKeys())); } catch (e) { return []; } },
    clear: () => tx('readwrite', (st) => req(st.clear())).catch(() => {}),
  };
})();

/* ── 3. Helfer, Symbole, Toast ──────────────────────────────── */

const $  = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g,
  (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
/** Mehrzeiliger Nutzertext: maskieren, Zeilenumbrüche erhalten. */
const escBr = (s) => esc(s).replace(/\n/g, '<br>');

/* Formatierung immer über Intl — nie von Hand mit toFixed und Komma-Ersatz. */
const nf0 = new Intl.NumberFormat('de-DE', { maximumFractionDigits: 0 });
const nf2 = new Intl.NumberFormat('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const pct = (x) => nf0.format(Math.round(x * 100)) + ' %';
const usd = (v) => (v < 0.005 && v > 0 ? '< 0,01' : nf2.format(v)) + ' $';
const dfShort = new Intl.DateTimeFormat('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit' });
const dfDate = new Intl.DateTimeFormat('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });
const plural = (n, one, many) => `${nf0.format(n)} ${n === 1 ? one : many}`;
const bytesFmt = (b) => (b > 1e6 ? nf2.format(b / 1e6) + ' MB' : nf0.format(Math.max(1, b / 1e3)) + ' KB');
const num = (v) => { const n = parseFloat(String(v).replace(',', '.')); return isFinite(n) ? n : 0; };

/* Symbole als Linien-SVG mit currentColor, damit sie beim Theme-Wechsel
   mitziehen. 24×24, Strichstärke 2. */
const IC = {
  cards: '<rect x="2" y="7" width="15" height="12" rx="2"/><path d="M7 4h13a2 2 0 0 1 2 2v9"/>',
  quiz: '<circle cx="12" cy="12" r="9"/><path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.6v.6"/><circle cx="12" cy="17" r=".6" fill="currentColor"/>',
  pen: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>',
  match: '<rect x="3" y="4" width="7" height="6" rx="1.5"/><rect x="14" y="14" width="7" height="6" rx="1.5"/><path d="M10 7h4a3 3 0 0 1 3 3v4"/><path d="M14 17h-4a3 3 0 0 1-3-3v-4"/>',
  test: '<path d="M9 3h6l1 2h3v16H5V5h3z"/><path d="M9 12l2 2 4-4"/><path d="M9 17h6"/>',
  notes: '<path d="M6 2h9l5 5v15H6z"/><path d="M14 2v6h6"/><path d="M9 13h8M9 17h6"/>',
  chat: '<path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z"/><path d="M8.5 12h.01M12 12h.01M15.5 12h.01" stroke-width="3"/>',
  bulb: '<path d="M9 18h6M10 21h4"/><path d="M12 3a6 6 0 0 0-3.5 10.9c.6.5 1 1.2 1 2.1h5c0-.9.4-1.6 1-2.1A6 6 0 0 0 12 3z"/>',
  doc: '<path d="M6 2h9l5 5v15H6z"/><path d="M14 2v6h6"/>',
  image: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="2"/><path d="M21 16l-5-5-9 9"/>',
  upload: '<path d="M12 16V4M7 9l5-5 5 5"/><path d="M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3"/>',
  download: '<path d="M12 4v12M7 11l5 5 5-5"/><path d="M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3"/>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6"/><path d="M6 7l1 13h10l1-13M9 7V4h6v3"/>',
  edit: '<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="M14 6l4 4"/>',
  more: '<circle cx="5" cy="12" r="1.3" fill="currentColor"/><circle cx="12" cy="12" r="1.3" fill="currentColor"/><circle cx="19" cy="12" r="1.3" fill="currentColor"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  x: '<path d="M6 6l12 12M18 6L6 18"/>',
  play: '<path d="M7 4.5v15l12-7.5z"/>',
  undo: '<path d="M9 14L4 9l5-5"/><path d="M4 9h10a6 6 0 0 1 0 12h-3"/>',
  sparkle: '<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"/><path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  fire: '<path d="M12 22c4 0 7-2.7 7-6.8 0-3.9-3-6.4-4.4-9.2-.4 2.2-1.6 3.6-3 4.2C12 7 10.6 4.2 8 2c.3 3.4-3 6.6-3 11.2C5 18.8 8 22 12 22z"/>',
  calendar: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="M20 20l-4-4"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  copy: '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h8"/>',
  eye: '<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  flag: '<path d="M5 21V4h11l-2 4 2 4H5"/>',
  chevron: '<path d="M9 6l6 6-6 6"/>',
  key: '<circle cx="8" cy="15" r="4"/><path d="M11 12l9-9M17 6l3 3M15 8l2 2"/>',
  target: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1.2" fill="currentColor"/>',
  layers: '<path d="M12 3l9 5-9 5-9-5z"/><path d="M3 13l9 5 9-5"/>',
  shuffle: '<path d="M16 3h5v5M4 20L21 3M21 16v5h-5M15 15l6 6M4 4l5 5"/>',
  speaker: '<path d="M4 9v6h4l5 4V5L8 9z"/><path d="M16.5 9a4 4 0 0 1 0 6M19 6.5a8 8 0 0 1 0 11"/>',
};
const icon = (n, cls) => `<svg class="${cls || ''}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${IC[n] || ''}</svg>`;

let toastTimer;
function toast(msg, ms) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), ms || 2600);
}

/** Arbeitsanzeige oben (z. B. „PDF wird gelesen …“). null blendet aus. */
function busy(text) {
  $('#busy').classList.toggle('hidden', !text);
  if (text) $('#busyText').textContent = text;
}

/** Datei an den Nutzer geben. */
function download(name, blob) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1500);
}

async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; }
  catch (e) {
    // Ohne sicheren Kontext oder Erlaubnis: über ein Textfeld
    const ta = document.createElement('textarea');
    ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch (e2) { ok = false; }
    ta.remove();
    return ok;
  }
}

const blobToBase64 = (blob) => new Promise((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(String(r.result).replace(/^data:[^,]*,/, ''));
  r.onerror = () => reject(r.error);
  r.readAsDataURL(blob);
});

/* ── 4. Sheet-System, Dialoge, Navigation ─────────────────────── */
let sheetSaveFn = null;

function openSheet(title, html, saveFn, saveLabel) {
  armBack();                              // Zurück soll das Sheet schließen, nicht die App
  $('#sheetTitle').textContent = title;
  $('#sheetBody').innerHTML = html;
  $('#sheetBody').onclick = null;         // Handler des vorherigen Sheets verwerfen
  $('#sheetCancel').onclick = closeSheet; // ggf. überschriebenes Abbrechen zurücksetzen
  $('#sheetCancel').textContent = 'Abbrechen';
  sheetSaveFn = saveFn || null;
  const btn = $('#sheetSave');
  btn.classList.toggle('hidden', !saveFn);
  btn.textContent = saveLabel || 'Sichern';
  $('#sheet').classList.remove('hidden');
  $('#scrim').classList.remove('hidden');
  $('#sheetBody').scrollTop = 0;
}

function closeSheet() {
  $('#sheet').classList.add('hidden');
  $('#scrim').classList.add('hidden');
  sheetSaveFn = null;
}
const sheetOpen = () => !$('#sheet').classList.contains('hidden');

/* ── Dialoge ────────────────────────────────────────────────────
   Ersatz für confirm() / prompt() / alert(): installierte Web-Apps
   unterdrücken die nativen Dialoge je nach Gerät kommentarlos — der Knopf
   tut dann scheinbar nichts. Diese hier sind normale Sheets und
   funktionieren überall gleich.
   `back` führt zurück zum vorherigen Sheet statt alles zuzuklappen. */

function askSheet(title, text, okLabel, onOk, back, danger) {
  openSheet(title, `
    <p class="dlg-t">${esc(text)}</p>
    <button class="btn ${danger ? 'btn-danger' : 'btn-primary'} btn-block" id="dlgOk">${esc(okLabel)}</button>
    <button class="btn btn-block" id="dlgNo" style="margin-top:8px">Abbrechen</button>
  `, null);
  const zurueck = () => (back ? back() : closeSheet());
  $('#dlgOk').onclick = onOk;
  $('#dlgNo').onclick = zurueck;
  $('#sheetCancel').onclick = zurueck;
}

function infoSheet(title, text, back) {
  openSheet(title, `
    <p class="dlg-t">${esc(text)}</p>
    <button class="btn btn-primary btn-block" id="dlgOk">Verstanden</button>
  `, null);
  const zurueck = () => (back ? back() : closeSheet());
  $('#dlgOk').onclick = zurueck;
  $('#sheetCancel').onclick = zurueck;
}

/** Einzeiliger Texteingabe-Dialog. `opts`: {value, placeholder, numeric, okLabel, type} */
function askText(title, label, opts, onOk, back) {
  opts = opts || {};
  openSheet(title, `
    <label>${esc(label)}<input id="dlg_in"
      ${opts.numeric ? 'type="number" inputmode="numeric" step="1"' : `type="${opts.type || 'text'}" autocomplete="off"`}
      placeholder="${esc(opts.placeholder || '')}"
      value="${esc(opts.value == null ? '' : opts.value)}"></label>
    ${opts.note ? `<p class="note">${esc(opts.note)}</p>` : ''}
  `, () => onOk($('#dlg_in').value), opts.okLabel || 'Übernehmen');
  if (back) $('#sheetCancel').onclick = back;
  const inp = $('#dlg_in');
  inp.focus(); inp.select && inp.select();
  inp.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); sheetSaveFn && sheetSaveFn(); } };
}

/** Auswahl als Liste von Zeilen. items: [{label, sub, icon, danger, fn}] */
function menuSheet(title, items) {
  openSheet(title, `<div class="rows">${items.map((it, i) => `
    <button class="row${it.danger ? ' danger-text' : ''}" data-mi="${i}">
      ${it.icon ? icon(it.icon) : ''}<span class="grow"><span>${esc(it.label)}</span>${it.sub ? `<span class="sub">${esc(it.sub)}</span>` : ''}</span>
    </button>`).join('')}</div>`, null);
  $('#sheetBody').onclick = (e) => {
    const b = e.target.closest('[data-mi]');
    if (b) items[+b.dataset.mi].fn();
  };
}

/* ── Navigation ─────────────────────────────────────────────────
   Vier Hauptseiten in der Tabbar, alles andere sind Unterseiten mit
   Zurück-Pfeil. `stack` merkt sich, woher man kam: Zurück aus dem Quiz
   führt dorthin, wo es gestartet wurde. */
const TABS = ['home', 'library', 'practice', 'stats'];
const TITLES = {
  home: 'Heute', library: 'Stapel', practice: 'Üben', stats: 'Statistik',
  deck: 'Stapel', cards: 'Karten', study: 'Lernen', quiz: 'Quiz', match: 'Zuordnen',
  notes: 'Lernzettel', doc: 'Dokument', chat: 'Tutor', feynman: 'Erklär es',
};
/* Seiten, auf denen die Tabbar ausgeblendet ist, um Platz zu schaffen und
   versehentliches Wegtippen mitten im Lernen zu vermeiden */
const IMMERSIVE = new Set(['study', 'quiz', 'match', 'feynman', 'chat']);

let view = 'home';
let params = {};
let stack = [];

function nav(v, p, opts) {
  opts = opts || {};
  if (TABS.includes(v)) stack = [];
  else if (!opts.back && !opts.replace && view !== v) stack.push({ v: view, p: params });
  if (view === 'study' && v !== 'study') leaveStudy();
  view = v;
  params = p || {};
  $$('.view').forEach((s) => s.classList.toggle('hidden', s.id !== 'view-' + v));
  const tab = TABS.includes(v) ? v : (stack.find((x) => TABS.includes(x.v)) || { v: 'home' }).v;
  $$('.tabbar button[data-nav]').forEach((b) => b.classList.toggle('on', b.dataset.nav === tab));
  document.body.classList.toggle('immersive', IMMERSIVE.has(v));
  $('#btnBack').classList.toggle('hidden', TABS.includes(v));
  $('#topActions').innerHTML = '';
  setTitle(TITLES[v] || '');
  if (!opts.keepScroll) window.scrollTo(0, 0);
  armBack();                    // Zurück soll auf die vorige Seite führen, nicht aus der App
  render();
}

function setTitle(t) { $('#viewTitle').textContent = t; }

function goBack() {
  const prev = stack.pop();
  if (prev) nav(prev.v, prev.p, { back: true });
  else nav('home');
}

/** Alles neu zeichnen. Bei den Datenmengen einer Handy-App ist gezieltes
    Aktualisieren unnötige Komplexität — einmal neu rendern ist schnell genug
    und kann nicht aus dem Tritt geraten. Ausnahme: Lern- und Quizseiten
    zeichnen sich selbst, wenn sich ihr Zustand ändert. */
function render() {
  const fn = {
    home: renderHome, library: renderLibrary, practice: renderPractice, stats: renderStats,
    deck: renderDeck, cards: renderCards, study: renderStudy, quiz: renderQuiz, match: renderMatch,
    notes: renderNotes, doc: renderDoc, chat: renderChat, feynman: renderFeynman,
  }[view];
  if (fn) fn();
}

/* ── Zurück-Taste ───────────────────────────────────────────────
   Ohne Zutun beendet ein einziger Druck auf Zurück die installierte App —
   viel zu leicht aus Versehen. Deshalb liegt ein zusätzlicher Verlaufseintrag
   („Wächter“) über der App: Zurück landet dann bei uns statt beim System.

   Der Druck schließt der Reihe nach, was offen ist — Sheet, Bildkarten-
   Editor, Unterseite — und baut den Wächter danach wieder auf. Steht nichts
   mehr offen und Du bist auf „Heute“, fragt ein Dialog nach. */
let guardUp = false;
let leaving = false;

function pushGuard() {
  if (guardUp) return;
  guardUp = true;
  try { history.pushState({ g: 1 }, ''); } catch (e) { guardUp = false; }
}

/** Vor allem, was die Zurück-Taste abfangen soll: Sheet öffnen, Seite wechseln. */
function armBack() { pushGuard(); }

/** „Verlassen“ im Abschiedsdialog: der Dialog hat selbst einen Wächter
    aufgebaut (jedes Sheet tut das). Erst ihn abräumen, dann führt der zweite
    Schritt aus der App. Beides muss über zwei Runden laufen — history.back()
    zweimal hintereinander fasst der Browser zu einem Schritt zusammen. */
function leaveApp() {
  closeSheet();
  leaving = true;
  history.back();
}

function wireBack() {
  pushGuard();
  window.addEventListener('popstate', () => {
    guardUp = false;

    if (leaving) {
      leaving = false;
      history.back();
      // Falls nichts mehr zum Zurückgehen da ist (im Browser-Tab, in dem die App
      // der erste Eintrag ist), bleiben wir hier — dann fehlt der Wächter. Kein
      // Timer zum Nachrüsten: ein pushState würde den laufenden Schritt abbrechen
      // und genau das Verlassen verhindern. Also erst beim nächsten Antippen.
      document.addEventListener('pointerdown', pushGuard, { once: true });
      return;
    }
    // Über den Abbrechen-Knopf, nicht über closeSheet: verschachtelte Sheets
    // haben dort ihren Rückweg zum vorherigen Sheet hinterlegt.
    if (sheetOpen()) { $('#sheetCancel').click(); pushGuard(); return; }
    if (!$('#overlay').classList.contains('hidden')) { closeOverlay(); pushGuard(); return; }
    if (view !== 'home') { goBack(); pushGuard(); return; }

    askSheet('App verlassen?', 'Möchtest Du die Lernapp wirklich schließen?',
      'Verlassen', leaveApp);
  });
}

function closeOverlay() {
  const o = $('#overlay');
  o.classList.add('hidden');
  o.innerHTML = '';
  document.body.classList.remove('no-scroll');
}

/* ── 5. Abfragen auf den Daten ──────────────────────────────── */

const deckById = (id) => db.decks.find((d) => d.id === id);
const docById = (id) => db.docs.find((d) => d.id === id);
const subjectById = (id) => db.subjects.find((s) => s.id === id);
const cardsOf = (deckIds) => {
  const set = new Set(Array.isArray(deckIds) ? deckIds : [deckIds]);
  return db.cards.filter((c) => set.has(c.deckId));
};
const questionsOf = (deckIds) => {
  const set = new Set(Array.isArray(deckIds) ? deckIds : [deckIds]);
  return db.questions.filter((q) => set.has(q.deckId));
};
const today = () => Core.dayKey(Date.now());
function dayRec(k) {
  k = k || today();
  if (!db.days[k]) db.days[k] = { rev: 0, ok: 0, nw: 0, ms: 0, q: 0, qok: 0, nd: {} };
  if (!db.days[k].nd) db.days[k].nd = {};
  return db.days[k];
}

/** Fach zu einem Namen finden oder anlegen. Groß/klein und Umlaute egal. */
function subjectFor(name) {
  const n = String(name || '').trim();
  if (!n) return null;
  const f = Core.fold(n);
  let s = db.subjects.find((x) => Core.fold(x.name) === f);
  if (!s) {
    const hint = SUBJECT_HINTS.find(([re]) => re.test(n));
    s = { id: uid(), name: n.charAt(0).toUpperCase() + n.slice(1), color: hint ? hint[1] : db.subjects.length % SUBJECT_COLORS };
    db.subjects.push(s);
  }
  return s;
}
const subjectColor = (id) => { const s = subjectById(id); return s ? s.color : 'x'; };

/** Prüfungsplan: Wie viele neue Karten pro Tag, damit bis zum Vortag der
    Prüfung alles einmal gelernt ist? Nie weniger als die Einstellung. */
function examPlan(deck, now) {
  if (!deck || !deck.examDate) return null;
  const days = Core.daysUntil(deck.examDate, now || Date.now());
  if (days == null || days < 0) return null;
  const left = cardsOf(deck.id).filter((c) => !c.susp && c.s.st === 'new').length;
  const perDay = days > 1 ? Math.ceil(left / (days - 1)) : left;
  return { days, left, perDay };
}

function newLimit(deck) {
  const base = deck.newPerDay != null ? deck.newPerDay : db.settings.newPerDay;
  const plan = examPlan(deck);
  return plan ? Math.max(base, plan.perDay) : base;
}

/** Abstand nie über den Prüfungstag hinaus: vor der Klausur soll jede
    Karte noch einmal drankommen. */
function maxIvlFor(deck) {
  const plan = examPlan(deck);
  return plan && plan.days > 0 ? Math.max(1, plan.days - 1) : null;
}

/** Zahlen für eine Menge Stapel. */
function counts(deckIds, now) {
  now = now || Date.now();
  const ids = Array.isArray(deckIds) ? deckIds : [deckIds];
  const rec = db.days[today()] || { nd: {} };
  const r = { total: 0, nw: 0, newToday: 0, learn: 0, due: 0, mature: 0, young: 0, susp: 0 };
  for (const id of ids) {
    const deck = deckById(id);
    if (!deck) continue;
    let nw = 0;
    for (const c of db.cards) {
      if (c.deckId !== id) continue;
      r.total++;
      if (c.susp) { r.susp++; continue; }
      const s = c.s;
      if (s.st === 'new') nw++;
      else if (s.st === 'learn' || s.st === 'relearn') { if (s.due <= now + 20 * Core.MIN) r.learn++; }
      else if (s.st === 'review') {
        if (s.due <= now) r.due++;
        if (Core.isMature(s)) r.mature++; else r.young++;
      }
    }
    r.nw += nw;
    const left = Math.max(0, newLimit(deck) - ((rec.nd && rec.nd[id]) || 0));
    r.newToday += Math.min(nw, left);
  }
  r.todo = r.due + r.learn + r.newToday;
  return r;
}

const allDeckIds = () => db.decks.map((d) => d.id);

/** Lernserie: Tage in Folge mit mindestens einer Wiederholung. Heute zählt
    mit, sobald gelernt wurde — sonst bleibt die Serie bis gestern stehen. */
function streak() {
  let n = 0;
  let t = Date.now();
  const has = (k) => db.days[k] && (db.days[k].rev > 0 || db.days[k].q > 0);
  if (!has(Core.dayKey(t))) t = Core.addDays(t, -1);
  while (has(Core.dayKey(t))) { n++; t = Core.addDays(t, -1); }
  return n;
}

/* ── 6. Import: Dateien lesen, Text erkennen ──────────────────── */

/* PDF.js wird erst beim ersten Bedarf geladen. Ein klassisches Skript darf
   per import() ein Modul nachladen — app.js selbst bleibt ohne Module. */
let pdfjsP = null;
function pdfjs() {
  if (!pdfjsP) {
    pdfjsP = import('./vendor/pdfjs/pdf.mjs').then((lib) => {
      lib.GlobalWorkerOptions.workerSrc = vendorUrl('pdf.worker.mjs');
      return lib;
    }).catch((e) => { pdfjsP = null; throw e; });
  }
  return pdfjsP;
}
const vendorUrl = (p) => new URL('vendor/pdfjs/' + p, location.href).href;

/** PDF öffnen. PDF.js übernimmt den Puffer (transfer) — deshalb eine Kopie. */
async function openPdf(buf) {
  const lib = await pdfjs();
  const task = lib.getDocument({
    data: new Uint8Array(buf.slice(0)),
    cMapUrl: vendorUrl('cmaps/'), cMapPacked: true,
    standardFontDataUrl: vendorUrl('standard_fonts/'),
    wasmUrl: vendorUrl('wasm/'),
    iccUrl: vendorUrl('iccs/'),
    enableXfa: false,
  });
  task.onPassword = (update, reason) => {
    askText(reason === 2 ? 'Passwort falsch' : 'Passwort nötig',
      reason === 2 ? 'Das Passwort stimmt nicht. Noch einmal:' : 'Dieses PDF ist mit einem Passwort geschützt.',
      { type: 'password', okLabel: 'Öffnen' },
      (v) => { closeSheet(); update(v); },
      () => { closeSheet(); task.destroy(); });
  };
  return task.promise;
}
function closePdf(pdf) { try { (pdf.loadingTask || pdf).destroy(); } catch (e) { /* schon zu */ } }

/* Zuletzt geöffnetes PDF offen halten: Vorschaubilder, Bildkarten und das
   Rendern für die KI greifen oft mehrmals hintereinander auf dasselbe zu. */
let pdfCache = null;     // {id, p: Promise<pdf>}
/* Als Promise gemerkt, nicht als fertiges PDF: Fordern zwei Vorschaubilder
   gleichzeitig dasselbe Dokument an, öffnen sie es sonst zweimal — und das
   zweite Öffnen schließt das erste mitten im Zeichnen. */
function pdfFor(docId) {
  if (pdfCache && pdfCache.id === docId) return pdfCache.p;
  const old = pdfCache;
  const p = (async () => {
    const rec = await Files.get(docId);
    if (!rec || !rec.blob) throw new Error('Die Datei liegt auf diesem Gerät nicht vor.');
    return openPdf(await rec.blob.arrayBuffer());
  })();
  pdfCache = { id: docId, p };
  p.catch(() => { if (pdfCache && pdfCache.p === p) pdfCache = null; });
  if (old) old.p.then(closePdf, () => {});
  return p;
}

/** Seite als Canvas in gewünschter Breite (Pixel). Bilder-Dokumente werden
    genauso behandelt, damit Bildkarten auch auf Fotos funktionieren.
    `keep: false` zeichnet nur einmal (KI-Aufträge brauchen jede Seite genau
    einmal — ein Cache voller 1400-px-Seiten würde das Handy überfordern). */
const pageImgCache = new Map();   // `${docId}:${n}:${w}` → Promise<canvas>
function renderPage(docId, n, width, keep) {
  const k = `${docId}:${n}:${width}`;
  if (keep === false && !pageImgCache.has(k)) return drawPage(docId, n, width);
  if (!pageImgCache.has(k)) {
    const p = drawPage(docId, n, width);
    p.catch(() => pageImgCache.delete(k));
    pageImgCache.set(k, p);
    // Speicher begrenzen: eine 1400-px-Seite belegt als Canvas gut 10 MB.
    // Große Seiten höchstens 6, kleine (Vorschaubilder) bis 40.
    const big = [...pageImgCache.keys()].filter((x) => +x.split(':')[2] >= 800);
    while (big.length > 6) pageImgCache.delete(big.shift());
    if (pageImgCache.size > 40) pageImgCache.delete(pageImgCache.keys().next().value);
  }
  return pageImgCache.get(k);
}

async function drawPage(docId, n, width) {
  const doc = docById(docId);
  if (doc && doc.kind === 'image') {
    const rec = await Files.get(docId);
    if (!rec || !rec.blob) throw new Error('Bild fehlt auf diesem Gerät.');
    const img = await loadImage(rec.blob);
    const c = document.createElement('canvas');
    const sc = Math.min(1, width / img.naturalWidth);
    c.width = Math.round(img.naturalWidth * sc); c.height = Math.round(img.naturalHeight * sc);
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    return c;
  }
  const pdf = await pdfFor(docId);
  const page = await pdf.getPage(n);
  const vp1 = page.getViewport({ scale: 1 });
  const vp = page.getViewport({ scale: width / vp1.width });
  const c = document.createElement('canvas');
  c.width = Math.round(vp.width); c.height = Math.round(vp.height);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#ffffff';                      // PDF-Papier ist weiß, egal welches Theme
  ctx.fillRect(0, 0, c.width, c.height);
  // intent 'print': PDF.js zeichnet dann ohne requestAnimationFrame. Das
  // ruht, solange die Seite verborgen ist — wer während einer KI-Erzeugung
  // in eine andere App wechselt, hätte sonst einen stehenden Auftrag.
  await page.render({ canvasContext: ctx, viewport: vp, intent: 'print' }).promise;
  page.cleanup();
  return c;
}

function loadImage(blob) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(img.src); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(img.src); reject(new Error('Bild lässt sich nicht öffnen (Format?).')); };
    img.src = URL.createObjectURL(blob);
  });
}

/** Seite als JPEG (Base64) für die KI: 1400 px Breite reichen für Handschrift. */
async function pageJpeg(docId, n, width) {
  const c = await renderPage(docId, n, width || 1400, false);
  return c.toDataURL('image/jpeg', 0.82).replace(/^data:[^,]*,/, '');
}

/** Fingerabdruck: erkennt dieselbe Datei wieder, egal wie sie heißt. */
async function fingerprint(buf) {
  if (window.crypto && crypto.subtle) {
    const h = new Uint8Array(await crypto.subtle.digest('SHA-256', buf));
    return 'sha256:' + Array.from(h.slice(0, 16), (b) => b.toString(16).padStart(2, '0')).join('');
  }
  // Ohne sicheren Kontext (http im Heimnetz) fehlt crypto.subtle
  const a = new Uint8Array(buf);
  let h1 = 0x811c9dc5, h2 = 0x01000193;
  for (let i = 0; i < a.length; i++) {
    h1 = Math.imul(h1 ^ a[i], 16777619);
    h2 = Math.imul(h2 ^ a[a.length - 1 - i], 16777619);
  }
  return 'fnv:' + (h1 >>> 0).toString(16) + (h2 >>> 0).toString(16) + a.length.toString(16);
}

function kindOf(file) {
  const n = (file.name || '').toLowerCase();
  const t = file.type || '';
  if (t === 'application/pdf' || n.endsWith('.pdf')) return 'pdf';
  if (t.startsWith('image/') || /\.(jpe?g|png|webp|gif|heic|heif)$/.test(n)) return 'image';
  if (t.startsWith('text/') || /\.(txt|md|markdown)$/.test(n)) return 'text';
  if (/\.(goodnotes|note)$/.test(n)) return 'goodnotes';
  return null;
}

/** Dateiname ohne Endung und ohne GoodNotes-Datumsanhang als Titel. */
const cleanName = (n) => String(n || 'Dokument').replace(/\.[a-z0-9]{2,5}$/i, '').replace(/[_]+/g, ' ')
  .replace(/\s*\(\d+\)$/, '').trim() || 'Dokument';

/* Notiz-Apps, deren PDFs Handschrift als Vektorzeichnung enthalten. Auf
   solchen Seiten kann auch neben getipptem Text Handschrift stehen — die
   sieht nur, wer das PDF selbst bekommt, nicht den erkannten Text. */
const NOTE_APPS = /goodnotes|notability|noteshelf|onenote|samsung notes|xournal|nebo|collanote|flexcil|zoomnotes|penultimate|apple notes|notizen|remarkable|boox|supernote/i;

/** Text einer PDF-Seite für Seite lesen. Rückgabe [{n, text, ink}], dazu
    pages.handwritten, wenn eine Notiz-App das PDF erzeugt hat. */
async function extractPdf(buf, onPage) {
  const pdf = await openPdf(buf);
  try {
    let producer = '';
    try {
      const meta = await pdf.getMetadata();
      producer = [meta.info && meta.info.Producer, meta.info && meta.info.Creator].filter(Boolean).join(' ');
    } catch (e) { /* ohne Metadaten geht es auch */ }
    const pages = [];
    for (let n = 1; n <= pdf.numPages; n++) {
      const page = await pdf.getPage(n);
      const tc = await page.getTextContent();
      const text = Core.itemsToText(tc.items);
      pages.push({ n, text, ink: Core.isInkPage(text) });
      page.cleanup();
      if (onPage) onPage(n, pdf.numPages);
    }
    pages.handwritten = NOTE_APPS.test(producer);
    pages.producer = producer.slice(0, 120);
    return pages;
  } finally { closePdf(pdf); }
}

/** Textdatei in „Seiten“ zu etwa 3000 Zeichen teilen, an Absatzgrenzen —
    so haben auch Karten aus Textdateien eine Fundstelle. */
function textPages(text) {
  const paras = String(text).replace(/\r/g, '').split(/\n\s*\n/);
  const pages = [];
  let cur = '';
  for (const p of paras) {
    if (cur && cur.length + p.length > 3000) { pages.push(cur); cur = ''; }
    cur += (cur ? '\n\n' : '') + p;
  }
  if (cur.trim()) pages.push(cur);
  return pages.map((t, i) => ({ n: i + 1, text: t, ink: false }));
}

/**
 * Dateien aufnehmen und (je nach Wahl) gleich Karten erzeugen.
 * opts: {mode: 'ai'|'offline'|'chat'|'none', subjectId, deckId, amount}
 */
async function importFiles(list, opts) {
  opts = opts || {};
  const files = Array.from(list || []);
  const done = [];
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    const kind = kindOf(f);
    if (kind === 'goodnotes') {
      infoSheet('GoodNotes-Datei', 'Die App liest GoodNotes-Notizbücher als PDF. In GoodNotes: Teilen → Exportieren → PDF, und dieses PDF hier hinzufügen. Handschrift liest die KI dann mit.');
      continue;
    }
    if (!kind) { toast(`„${f.name}“: dieses Format kann die App nicht lesen`); continue; }
    const label = files.length > 1 ? ` (${i + 1}/${files.length})` : '';
    try {
      busy(`„${cleanName(f.name)}“ wird gelesen${label} …`);
      const buf = await f.arrayBuffer();
      const hash = await fingerprint(buf);
      const dup = db.docs.find((d) => d.hash === hash);
      if (dup) {
        // Nach einem Backup ohne PDFs: dieselbe Datei wieder zuordnen
        const have = await Files.get(dup.id);
        if (!have || !have.blob) {
          const pages = have && have.pages && have.pages.length ? have.pages
            : kind === 'pdf' ? await extractPdf(buf) : kind === 'image' ? [{ n: 1, text: '', ink: true }] : textPages(new TextDecoder('utf-8').decode(buf));
          await Files.put({ id: dup.id, name: dup.name, type: f.type, blob: new Blob([buf], { type: f.type || dup.mime }), pages });
          toast(`„${dup.name}“ wieder zugeordnet`);
        } else toast(`„${dup.name}“ ist schon in der App`);
        done.push(dup);
        continue;
      }

      let pages;
      if (kind === 'pdf') pages = await extractPdf(buf, (n, total) => busy(`„${cleanName(f.name)}“: Seite ${n} von ${total}${label}`));
      else if (kind === 'image') {
        // HEIC (iPhone-Standard) kann Chrome nicht öffnen — lieber gleich sagen
        try { await loadImage(new Blob([buf], { type: f.type })); }
        catch (e) { throw new Error('Dieses Bildformat kann der Browser nicht öffnen. iPhone-Fotos (HEIC): in den Kamera-Einstellungen „Maximale Kompatibilität“ wählen oder das Foto als JPEG teilen.'); }
        pages = [{ n: 1, text: '', ink: true }];
      } else pages = textPages(new TextDecoder('utf-8').decode(buf));

      const doc = {
        id: uid(), name: cleanName(f.name), kind, mime: f.type || (kind === 'pdf' ? 'application/pdf' : ''),
        added: Date.now(), bytes: f.size, hash, pages: pages.length,
        inkPages: pages.filter((p) => p.ink).length,
        chars: pages.reduce((a, p) => a + p.text.length, 0),
        subjectId: opts.subjectId || null, status: 'ready', gen: null, summary: '', keyPoints: [], glossary: [],
        // Handschrift-App oder Folien (wenig Text je Seite, viel Bild): Claude soll das PDF selbst sehen
        visual: kind === 'pdf' && (!!pages.handwritten || pages.reduce((a, p) => a + p.text.length, 0) / Math.max(1, pages.length) < 500),
        producer: pages.producer || '',
      };
      const blob = kind === 'text' ? new Blob([buf], { type: 'text/plain' }) : new Blob([buf], { type: doc.mime || 'application/octet-stream' });
      await Files.put({ id: doc.id, name: doc.name, type: blob.type, blob, pages });
      db.docs.push(doc);
      save();
      done.push(doc);
    } catch (e) {
      console.error(e);
      busy(null);
      infoSheet('Datei nicht lesbar', `„${f.name}“ ließ sich nicht öffnen: ${e.message || e}`);
    }
  }
  busy(null);
  render();
  const fresh = done.filter((d) => !d.gen);
  if (!fresh.length) return done;

  const mode = opts.mode || defaultMode();
  if (mode === 'chat' && fresh.length) { openChatRoute(fresh[0].id, opts); return done; }
  if (mode === 'none') { toast(fresh.length === 1 ? 'Dokument abgelegt' : `${fresh.length} Dokumente abgelegt`); return done; }
  for (const d of fresh) startGen(d.id, Object.assign({}, opts, { mode }));
  return done;
}

const defaultMode = () => (hasKey() && db.settings.autoGen ? 'ai' : hasKey() ? 'ai' : 'offline');

/* ── 7. Erzeugen ─────────────────────────────────────────────────
   Läuft im Hintergrund: Man kann weiterlernen, während Claude schreibt.
   `jobs` lebt nur im Speicher — ein Neuladen bricht laufende Aufträge ab,
   das Dokument bleibt dann ohne Karten und lässt sich neu anstoßen. */
const jobs = [];

function startGen(docId, opts) {
  const doc = docById(docId);
  if (!doc) return;
  if (jobs.some((j) => j.docId === docId && j.status === 'run')) { toast('Läuft schon'); return; }
  const job = {
    id: uid(), docId, mode: opts.mode || 'offline', deckId: opts.deckId || null,
    subjectId: opts.subjectId || doc.subjectId || null, amount: opts.amount || db.settings.amount,
    replace: !!opts.replace, wish: opts.wish || '', status: 'run', part: 0, parts: 1, cards: 0, note: 'startet …',
    ctrl: new AbortController(), started: Date.now(),
  };
  jobs.push(job);
  renderJobs();
  runGen(job).catch((e) => {
    job.status = e && e.code === 'abort' ? 'abort' : 'error';
    job.ended = Date.now();
    job.error = (e && e.message) || String(e);
    console.error(e);
    renderJobs();
    if (job.status === 'error') toast('Erzeugen fehlgeschlagen: ' + job.error, 5000);
  });
}

async function runGen(job) {
  const doc = docById(job.docId);
  const rec = await Files.get(job.docId);
  if (!rec) throw new Error('Datei fehlt auf diesem Gerät.');
  const pages = rec.pages || [];
  let result, usdSpent = 0, model = null;

  if (job.mode === 'ai') {
    const key = getKey();
    if (!key) throw new Error('Kein API-Schlüssel hinterlegt.');
    const subj = subjectById(job.subjectId);
    const deck = job.deckId && deckById(job.deckId);
    // Beim Ergänzen sollen keine Karten doppelt kommen
    let wish = job.wish;
    if (deck && !job.replace) {
      const have = cardsOf(deck.id).filter((c) => c.docId === doc.id).slice(0, 120).map((c) => '- ' + Core.clozePlain(c.front).slice(0, 90));
      if (have.length) wish = (wish ? wish + '\n' : '') + 'Diese Karten gibt es schon — erstelle andere, neue:\n' + have.join('\n');
    }
    const out = await AI.generate({
      key, model: db.settings.model, effort: db.settings.effort, amount: job.amount,
      meta: { name: doc.name, subject: subj ? subj.name : '', wish, mediaType: doc.mime },
      pages, bytes: doc.bytes, mode: db.settings.send === 'auto' && doc.visual ? 'pdf' : db.settings.send, kind: doc.kind,
      src: {
        pdfBase64: () => blobToBase64(rec.blob),
        // Fotos immer neu als JPEG mit höchstens 1600 px: Handyfotos sprengen
        // sonst die 5-MB-Grenze je Bild, und mehr Pixel liest Claude ohnehin nicht
        imageBase64: () => pageJpeg(doc.id, 1, 1600),
        renderPage: (n) => pageJpeg(doc.id, n),
      },
      signal: job.ctrl.signal,
      onProgress: (p) => { job.part = p.part; job.parts = p.parts; job.cards = p.cards; job.note = p.status; renderJobs(); },
    });
    result = out.result;
    usdSpent = out.usd;
    model = out.model;
    db.settings.usd = (db.settings.usd || 0) + usdSpent;
    if (out.truncated) toast('Die Antwort war sehr lang und wurde gekürzt — es fehlen eventuell Karten.', 5000);
  } else {
    job.note = 'sucht Begriffe und Definitionen …';
    renderJobs();
    await new Promise((r) => setTimeout(r, 30));      // Anzeige erst zeichnen lassen
    result = Core.generateOffline(pages, { amount: job.amount, title: doc.name });
    if (!result.subject) result.subject = guessSubject(doc.name + '\n' + pages.map((p) => p.text).join('\n').slice(0, 600));
  }
  if (job.ctrl.signal.aborted) throw new AI.AIError('Abgebrochen.', 'abort');

  // Nichts gefunden (z. B. Handschrift ohne KI): keinen leeren Stapel anlegen
  if (!result.cards.length && !result.questions.length && !job.deckId) {
    job.status = 'error';
    job.ended = Date.now();
    job.error = doc.inkPages ? 'Handschrift — offline nicht lesbar' : 'Keine Karten gefunden';
    renderJobs();
    render();
    noCardsInfo(doc, job.mode);
    return null;
  }

  const deck = applyResult(doc, result, {
    mode: job.mode, deckId: job.deckId, subjectId: job.subjectId, replace: job.replace, usd: usdSpent, model,
  });
  job.status = 'done';
  job.ended = Date.now();
  job.deckId = deck.id;
  job.cards = result.cards.length;
  renderJobs();
  render();
  toast(`„${deck.name}“: ${plural(result.cards.length, 'Karte', 'Karten')}, ${plural(result.questions.length, 'Quizfrage', 'Quizfragen')}`, 4000);
  return deck;
}

function noCardsInfo(doc, mode) {
  if (doc.inkPages && mode !== 'ai') {
    openSheet('Handschrift erkannt', `
      <p class="dlg-t">In „${esc(doc.name)}“ steht kein maschinenlesbarer Text — vermutlich Handschrift oder ein Scan. Ohne KI kann die App das nicht lesen.</p>
      <div class="rows">
        <button class="row" id="ncKey">${icon('sparkle')}<span class="grow"><span>KI einrichten</span><span class="sub">Claude liest die Handschrift und schreibt die Karten</span></span></button>
        <button class="row" id="ncChat">${icon('chat')}<span class="grow"><span>Über Claude-Chat</span><span class="sub">ohne Schlüssel: Auftrag kopieren, PDF in der Claude-App anhängen</span></span></button>
        <button class="row" id="ncOccl">${icon('image')}<span class="grow"><span>Bildkarten selbst anlegen</span><span class="sub">Beschriftungen auf der Seite verdecken und abfragen</span></span></button>
      </div>`, null);
    $('#sheetCancel').textContent = 'Später';
    $('#ncKey').onclick = () => openKeySheet(() => { startGen(doc.id, { mode: 'ai' }); toast('Läuft im Hintergrund'); });
    $('#ncChat').onclick = () => openChatRoute(doc.id, {});
    $('#ncOccl').onclick = () => { closeSheet(); occlEditor(doc.id, 1, null); };
  } else infoSheet('Keine Karten gefunden', `In „${doc.name}“ hat der Offline-Generator keine Begriffe, Definitionen oder Listen gefunden. Mit KI oder über Claude-Chat klappt es auch bei Fließtext.`);
}

/**
 * Generator-Ergebnis als Stapel ablegen. Gibt den Stapel zurück.
 * opts: {mode, deckId, subjectId, replace, usd, model}
 */
function applyResult(doc, result, opts) {
  let deck = opts.deckId && deckById(opts.deckId);
  let subj = subjectById(opts.subjectId) || (result.subject ? subjectFor(result.subject) : null) || subjectById(doc.subjectId);
  if (!deck) {
    deck = { id: uid(), name: (result.title && result.title !== 'Neuer Stapel' ? result.title : doc.name).slice(0, 80),
      subjectId: subj ? subj.id : null, docIds: [], created: Date.now(), examDate: null, newPerDay: null };
    db.decks.push(deck);
  } else if (!deck.subjectId && subj) deck.subjectId = subj.id;
  if (!deck.docIds.includes(doc.id)) deck.docIds.push(doc.id);
  doc.subjectId = deck.subjectId;

  if (opts.replace) {
    db.cards = db.cards.filter((c) => !(c.deckId === deck.id && c.docId === doc.id && c.kind !== 'occl'));
    db.questions = db.questions.filter((q) => !(q.deckId === deck.id && q.docId === doc.id));
  }
  const existing = new Set(cardsOf(deck.id).map((c) => Core.dedupeKey(c.front) + '|' + Core.dedupeKey(c.back)));
  let ord = cardsOf(deck.id).reduce((m, c) => Math.max(m, c.ord || 0), 0);
  const now = Date.now();
  let added = 0;
  for (const c of result.cards) {
    const k = Core.dedupeKey(c.front) + '|' + Core.dedupeKey(c.back);
    if (existing.has(k)) continue;
    existing.add(k);
    db.cards.push({ id: uid(), deckId: deck.id, docId: doc.id, kind: c.kind, front: c.front, back: c.back || '', hint: c.hint || '',
      page: c.page || 0, ord: ++ord, created: now, s: Core.newState() });
    added++;
  }
  let questions = result.questions;
  // Zu wenige Quizfragen? Aus Begriffen und Karten ergänzen
  if (questions.length < 6) {
    const extra = Core.buildQuestions(result.glossary || [], result.cards, { max: 12 });
    questions = questions.concat(extra.filter((q) => !questions.some((x) => Core.dedupeKey(x.q) === Core.dedupeKey(q.q))));
  }
  for (const q of questions) {
    db.questions.push(Object.assign({ id: uid(), deckId: deck.id, docId: doc.id, seen: 0, right: 0 }, q));
  }
  if (result.summary || !doc.summary) doc.summary = result.summary || doc.summary;
  if (result.keyPoints && result.keyPoints.length) doc.keyPoints = result.keyPoints;
  if (result.glossary && result.glossary.length) {
    doc.glossary = result.glossary.map((g) => ({ term: g.term, def: g.def, page: g.page || 0 }));
  }
  doc.gen = { mode: opts.mode, at: now, model: opts.model || null, usd: (doc.gen && doc.gen.usd || 0) + (opts.usd || 0),
    cards: added, questions: questions.length };
  db.setup = true;
  save();
  return deck;
}

/** Laufende und frisch beendete Aufträge auf „Heute“ und im Dokument zeigen. */
function renderJobs() {
  // Mehrere Ansichten zeigen Aufträge (Heute, Stapel, Dokument) — alle auffrischen
  $$('.jobs-box').forEach((box) => { box.innerHTML = jobsHtml(box.dataset.doc || null, box.dataset.deck || null); });
}

function jobsHtml(docId, deckId) {
  // Fertige Aufträge nur kurz zeigen; die Stapel stehen ja ohnehin darunter
  const list = jobs.filter((j) => (!docId || j.docId === docId) && (!deckId || j.deckId === deckId)
    && (j.status === 'run' || Date.now() - (j.ended || j.started) < 3 * 60 * 1000));
  if (!list.length) return '';
  return list.slice(-4).map((j) => {
    const doc = docById(j.docId);
    const deck = j.status === 'done' && deckById(j.deckId);
    const name = deck ? deck.name : doc ? doc.name : 'Dokument';
    let sub, cls = '';
    if (j.status === 'run') {
      sub = j.mode === 'ai'
        ? `Claude ${j.note}${j.parts > 1 ? ` · Teil ${j.part}/${j.parts}` : ''}${j.cards ? ` · ${plural(j.cards, 'Karte', 'Karten')}` : ''}`
        : `Offline: ${j.note}`;
    } else if (j.status === 'done') { sub = `Fertig: ${plural(j.cards, 'Karte', 'Karten')}`; cls = ' done'; }
    else if (j.status === 'abort') { sub = 'Abgebrochen'; cls = ' err'; }
    else { sub = j.error || 'Fehler'; cls = ' err'; }
    return `<div class="job${cls}">
      ${j.status === 'run' ? '<div class="spinner"></div>' : icon(j.status === 'done' ? 'check' : 'x')}
      <div class="grow"><strong>${esc(name)}</strong><span class="sub">${esc(sub)}</span></div>
      ${j.status === 'run' ? `<button class="btn btn-sm" data-act="job-stop" data-id="${j.id}">Stopp</button>`
        : j.status === 'done' ? `<button class="btn btn-sm btn-primary" data-act="open-deck" data-id="${j.deckId}">Öffnen</button>`
        : `<button class="btn btn-sm" data-act="gen-doc" data-id="${j.docId}">Nochmal</button>`}
    </div>`;
  }).join('');
}

/* ── Material hinzufügen ────────────────────────────────────────
   Ein Sheet für alles: Dateien wählen oder hineinziehen, Fach, Ziel und
   Art der Erzeugung. Die Auswahl merkt sich die App für das nächste Mal. */
let addPrefs = { mode: null, subjectId: '', deckId: '' };
let pendingFiles = null;

function openAdd(files) {
  pendingFiles = files && files.length ? Array.from(files) : null;
  const key = hasKey();
  const mode = addPrefs.mode && (addPrefs.mode !== 'ai' || key) ? addPrefs.mode : (key ? 'ai' : 'offline');
  const subjOpts = db.subjects.map((s) => `<option value="${s.id}"${addPrefs.subjectId === s.id ? ' selected' : ''}>${esc(s.name)}</option>`).join('');
  const deckOpts = db.decks.map((d) => `<option value="${d.id}"${addPrefs.deckId === d.id ? ' selected' : ''}>${esc(d.name)}</option>`).join('');
  const modes = [
    ['ai', 'KI', key ? 'Claude liest alles, auch Handschrift' : 'braucht API-Schlüssel'],
    ['offline', 'Offline', 'ohne Internet, nur gedruckter Text'],
    ['chat', 'Claude-Chat', 'ohne Schlüssel, per Kopieren'],
    ['none', 'Nur ablegen', 'später erzeugen'],
  ];
  openSheet('Material hinzufügen', `
    <button class="dropzone" id="addPick">
      ${icon('upload')}
      <strong>${pendingFiles ? esc(pendingFiles.map((f) => f.name).join(', ')) : 'Dateien auswählen'}</strong>
      <span>${pendingFiles ? plural(pendingFiles.length, 'Datei', 'Dateien') + ' bereit' : 'PDF (auch GoodNotes-Export), Foto, Textdatei — oder einfach aufs Fenster ziehen'}</span>
    </button>
    <div class="sec-h">Karten erzeugen mit</div>
    <div class="mode-grid" id="addMode">
      ${modes.map(([v, l, s]) => `<button class="mode${v === mode ? ' on' : ''}${v === 'ai' && !key ? ' off' : ''}" data-mode="${v}"><strong>${l}</strong><span>${s}</span></button>`).join('')}
    </div>
    ${!key ? `<p class="note">Für KI-Karten brauchst Du einen eigenen Anthropic-API-Schlüssel — <button class="link inline" id="addKey">jetzt eintragen</button>.</p>` : ''}
    <div class="sec-h">Ablegen in</div>
    <label>Fach<select id="addSubj"><option value="">${key ? 'Automatisch erkennen' : 'Ohne Fach'}</option>${subjOpts}<option value="__new">Neues Fach …</option></select></label>
    <label>Stapel<select id="addDeck"><option value="">Neuer Stapel je Datei</option>${deckOpts}</select></label>
    <label>Menge<div class="seg" id="addAmount">${['wenig', 'normal', 'viel'].map((a) => `<button data-v="${a}" class="${db.settings.amount === a ? 'on' : ''}">${a[0].toUpperCase() + a.slice(1)}</button>`).join('')}</div></label>
    <button class="btn btn-primary btn-block" id="addGo"${pendingFiles ? '' : ' disabled'}>Los geht’s</button>
    <button class="btn btn-ghost btn-block" id="addPaste" style="margin-top:8px">${icon('notes')} Text einfügen statt Datei</button>
  `, null);
  let curMode = mode;
  $('#addPick').onclick = () => $('#fileIn').click();
  $('#addMode').onclick = (e) => {
    const b = e.target.closest('[data-mode]');
    if (!b) return;
    if (b.dataset.mode === 'ai' && !hasKey()) { openKeySheet(() => openAdd(pendingFiles)); return; }
    curMode = b.dataset.mode;
    $$('#addMode .mode').forEach((x) => x.classList.toggle('on', x === b));
  };
  $('#addAmount').onclick = (e) => {
    const b = e.target.closest('[data-v]');
    if (!b) return;
    db.settings.amount = b.dataset.v; save();
    $$('#addAmount button').forEach((x) => x.classList.toggle('on', x === b));
  };
  if ($('#addKey')) $('#addKey').onclick = () => openKeySheet(() => openAdd(pendingFiles));
  $('#addSubj').onchange = (e) => {
    if (e.target.value !== '__new') return;
    const keep = pendingFiles;
    askText('Neues Fach', 'Name des Fachs', { placeholder: 'z. B. Biologie' }, (v) => {
      const s = subjectFor(v);
      if (s) { addPrefs.subjectId = s.id; save(); }
      openAdd(keep);
    }, () => openAdd(keep));
  };
  const go = () => {
    addPrefs = { mode: curMode, subjectId: $('#addSubj').value, deckId: $('#addDeck').value };
    const files = pendingFiles;
    pendingFiles = null;
    closeSheet();
    importFiles(files, { mode: curMode, subjectId: addPrefs.subjectId || null, deckId: addPrefs.deckId || null, amount: db.settings.amount });
  };
  $('#addGo').onclick = go;
  $('#addPaste').onclick = () => openPasteText(curMode);
  // Dateiauswahl, während das Sheet offen ist: gleich loslegen — die
  // Einstellungen hat man ja gerade vor sich gesehen
  addSheetGo = go;
}
let addSheetGo = null;

function openPasteText(mode) {
  openSheet('Text einfügen', `
    <label>Titel<input id="ptTitle" placeholder="z. B. Zellatmung — Mitschrift"></label>
    <label>Text<textarea id="ptText" rows="10" placeholder="Text aus dem Unterricht, einer Website oder einem Dokument hier einfügen"></textarea></label>
  `, () => {
    const t = $('#ptText').value.trim();
    if (t.length < 40) { toast('Bitte etwas mehr Text einfügen'); return; }
    const name = ($('#ptTitle').value.trim() || t.split('\n')[0].slice(0, 50)) + '.txt';
    closeSheet();
    importFiles([new File([t], name, { type: 'text/plain' })], { mode: mode === 'chat' ? 'chat' : mode, subjectId: addPrefs.subjectId || null, deckId: addPrefs.deckId || null });
  }, 'Hinzufügen');
}

/* ── Weg „Claude-Chat“ ohne API-Schlüssel ───────────────────────
   1. Auftrag kopieren (oder per Teilen samt PDF an die Claude-App)
   2. In Claude einfügen, Antwort abwarten
   3. Antwort hier einfügen → wird zum Stapel */
async function openChatRoute(docId, opts) {
  opts = opts || {};
  const doc = docById(docId);
  const rec = await Files.get(docId);
  if (!doc || !rec) { toast('Datei fehlt'); return; }
  const subj = subjectById(opts.subjectId || doc.subjectId);
  const prompt = AI.chatPrompt({ name: doc.name, subject: subj ? subj.name : '' }, rec.pages || [], { amount: opts.amount || db.settings.amount, attach: doc.kind !== 'text' });
  const needFile = doc.kind === 'image' || doc.inkPages > 0;
  const file = new File([rec.blob], doc.name + (doc.kind === 'pdf' ? '.pdf' : doc.kind === 'text' ? '.txt' : ''), { type: rec.blob.type });
  const canShare = !!(navigator.canShare && navigator.canShare({ files: [file] }));
  openSheet('Über Claude-Chat', `
    <ol class="steps">
      <li><strong>Auftrag kopieren</strong>${needFile ? ' und das PDF in den Chat hängen — ohne Datei kann Claude die Handschrift nicht sehen.' : '. Der Text des Dokuments steckt schon drin.'}
        <div class="btn-row" style="margin-top:8px">
          <button class="btn btn-primary" id="crCopy">${icon('copy')} Auftrag kopieren</button>
          ${canShare ? `<button class="btn" id="crShare">${icon('upload')} Mit Datei teilen</button>` : ''}
        </div>
        ${!canShare && needFile ? `<button class="btn btn-block" id="crFile" style="margin-top:8px">${icon('download')} Datei speichern</button>` : ''}
      </li>
      <li><strong>In Claude einfügen</strong> (App oder claude.ai) und die Antwort abwarten.</li>
      <li><strong>Antwort hier einfügen</strong> — einfach alles markieren und kopieren.
        <textarea id="crIn" rows="6" placeholder="{ &quot;title&quot;: … }"></textarea>
      </li>
    </ol>
  `, () => {
    let r;
    try { r = Core.normalizeGen(Core.parseLooseJSON($('#crIn').value)); }
    catch (e) { toast(e.message, 4000); return; }
    if (!r.cards.length && !r.questions.length) { toast('In der Antwort stehen keine Karten'); return; }
    const deck = applyResult(doc, r, { mode: 'chat', deckId: opts.deckId, subjectId: opts.subjectId, replace: opts.replace });
    closeSheet();
    toast(`„${deck.name}“: ${plural(r.cards.length, 'Karte', 'Karten')} übernommen`);
    nav('deck', { id: deck.id });
  }, 'Übernehmen');
  $('#crCopy').onclick = async () => toast((await copyText(prompt)) ? 'Auftrag kopiert — jetzt in Claude einfügen' : 'Kopieren ging nicht');
  if ($('#crShare')) $('#crShare').onclick = async () => {
    // Manche Apps übernehmen beim Teilen nur die Datei, nicht den Text —
    // deshalb liegt der Auftrag vorher schon in der Zwischenablage
    await copyText(prompt);
    try { await navigator.share({ files: [file], text: prompt, title: doc.name }); toast('Falls der Auftrag fehlt: er ist kopiert, einfach einfügen', 4000); }
    catch (e) { if (e.name !== 'AbortError') toast('Teilen ging nicht — Auftrag ist kopiert'); }
  };
  if ($('#crFile')) $('#crFile').onclick = () => download(file.name, file);
}

/* ── 8. Ansichten ───────────────────────────────────────────── */

/** Kartenfront als kurzer Klartext für Listen (Lücke als […]). */
function frontPlain(c) {
  if (c.kind === 'cloze') return Core.clozeParts(c.front, 0).map((p) => (p.t === 'gap' ? '[…]' : p.s)).join('');
  if (c.kind === 'occl') return c.front || 'Bildkarte';
  return c.front;
}

function stateLabel(c) {
  if (c.susp) return { t: 'ausgesetzt', cls: 'muted' };
  const s = c.s;
  if (s.st === 'new') return { t: 'neu', cls: 'new' };
  if (s.st === 'learn' || s.st === 'relearn') return { t: 'lernt', cls: 'learn' };
  if (s.due <= Date.now()) return { t: 'fällig', cls: 'due' };
  return { t: 'in ' + Core.fmtWait(s.due - Date.now()), cls: Core.isMature(s) ? 'mature' : '' };
}

function deckSub(d) {
  const c = counts(d.id);
  const parts = [plural(c.total, 'Karte', 'Karten')];
  if (c.total) parts.push(pct(c.mature / Math.max(1, c.total - c.susp)) + ' gefestigt');
  return parts.join(' · ');
}

function deckRow(d) {
  const c = counts(d.id);
  const plan = examPlan(d);
  return `<button class="row deck-row" data-act="open-deck" data-id="${d.id}">
    <span class="dot sj-${subjectColor(d.subjectId)}"></span>
    <span class="grow"><span class="t">${esc(d.name)}</span>
      <span class="sub">${esc(deckSub(d))}${plan ? ` · ${plan.days === 0 ? 'Prüfung heute' : `Prüfung in ${plural(plan.days, 'Tag', 'Tagen')}`}` : ''}</span>
      <span class="meter"><i style="width:${c.total ? Math.round(100 * c.mature / Math.max(1, c.total - c.susp)) : 0}%"></i></span>
    </span>
    <span class="badges">${c.due + c.learn ? `<b class="b-due">${c.due + c.learn}</b>` : ''}${c.newToday ? `<b class="b-new">${c.newToday}</b>` : ''}</span>
  </button>`;
}

/* ── Heute ── */
function renderHome() {
  const el = $('#view-home');
  if (!db.decks.length && !db.docs.length) { el.innerHTML = onboardingHtml(); return; }
  const ids = allDeckIds();
  const c = counts(ids);
  const rec = db.days[today()] || { rev: 0, ok: 0, ms: 0, nw: 0 };
  const st = streak();
  const exams = db.decks.map((d) => ({ d, p: examPlan(d) })).filter((x) => x.p && x.p.days <= 45).sort((a, b) => a.p.days - b.p.days);
  const withTodo = db.decks.map((d) => ({ d, c: counts(d.id) })).sort((a, b) => (b.c.todo - a.c.todo) || (b.d.created - a.d.created));
  const orphan = db.docs.filter((d) => !d.imported && !db.decks.some((k) => k.docIds.includes(d.id)) && !jobs.some((j) => j.docId === d.id && j.status === 'run'));
  // Erst erinnern, wenn schon ein paar Tage Lernstand drinsteckt — nicht direkt nach dem ersten Import
  const oldest = db.decks.reduce((m, d) => Math.min(m, d.created || Date.now()), Date.now());
  const backupDue = db.cards.length >= 30 && Date.now() - oldest > 3 * Core.DAY
    && (!db.lastBackup || Date.now() - new Date(db.lastBackup).getTime() > 14 * Core.DAY);

  el.innerHTML = `
    <div class="hero">
      ${c.todo ? `
        <div class="hero-n">${nf0.format(c.todo)}</div>
        <div class="hero-l">${c.todo === 1 ? 'Karte' : 'Karten'} für heute</div>
        <div class="hero-s">${[c.due ? `${c.due} fällig` : '', c.learn ? `${c.learn} im Lernschritt` : '', c.newToday ? `${c.newToday} neu` : ''].filter(Boolean).join(' · ')}</div>
        <button class="btn btn-primary btn-block btn-lg" data-act="study-all">${icon('play')} Jetzt lernen</button>
      ` : `
        <div class="hero-done">${icon('check')}</div>
        <div class="hero-l">${rec.rev ? 'Für heute alles gelernt' : 'Heute ist nichts fällig'}</div>
        <div class="hero-s">${c.nw ? `${c.nw} neue Karten warten — Tageslimit erreicht.` : 'Zeit für ein Quiz oder einen Probetest?'}</div>
        <div class="btn-row">
          <button class="btn" data-nav="practice">${icon('target')} Üben</button>
          ${c.nw ? `<button class="btn" data-act="study-extra">${icon('plus')} Mehr neue</button>` : ''}
        </div>
      `}
    </div>
    <div class="stat-row">
      <div class="stat"><span class="stat-v num">${icon('fire', 'ic-fire')}${nf0.format(st)}</span><span class="stat-l">${st === 1 ? 'Tag' : 'Tage'} in Folge</span></div>
      <div class="stat"><span class="stat-v num">${nf0.format(rec.rev || 0)}</span><span class="stat-l">heute gelernt</span></div>
      <div class="stat"><span class="stat-v num">${rec.rev ? pct((rec.ok || 0) / rec.rev) : '–'}</span><span class="stat-l">gewusst</span></div>
    </div>
    <div class="jobs-box">${jobsHtml()}</div>
    ${!hasKey() && !db.settings.hideKeyHint ? `
      <div class="hint">${icon('sparkle')}<div class="grow"><strong>KI einschalten</strong><span>Mit Deinem Anthropic-Schlüssel liest Claude auch Handschrift und schreibt deutlich bessere Karten, Quizfragen und Lernzettel.</span>
        <div class="hint-act"><button class="btn btn-sm" data-act="key">${icon('key')} Einrichten</button></div></div>
        <button class="icon-btn sm hint-x" data-act="hide-key-hint" aria-label="Ausblenden">${icon('x')}</button></div>` : ''}
    ${backupDue ? `<div class="hint warn">${icon('download')}<div class="grow"><strong>Sicherung empfohlen</strong><span>Deine Karten liegen nur auf diesem Gerät. ${db.lastBackup ? 'Letzte Sicherung: ' + dfDate.format(new Date(db.lastBackup)) : 'Noch keine Sicherung.'}</span>
      <div class="hint-act"><button class="btn btn-sm" data-act="backup">${icon('download')} Jetzt sichern</button></div></div></div>` : ''}
    ${exams.length ? `<div class="sec-h">Prüfungen</div><div class="exam-list">${exams.map(({ d, p }) => `
      <button class="exam sj-b-${subjectColor(d.subjectId)}" data-act="open-deck" data-id="${d.id}">
        <span class="exam-d num">${p.days === 0 ? 'heute' : p.days === 1 ? 'morgen' : `in ${p.days} T`}</span>
        <span class="exam-t">${esc(d.name)}</span>
        <span class="exam-s">${dfShort.format(new Date(d.examDate + 'T12:00'))}${p.left ? ` · noch ${p.left} neu` : ' · alles gelernt'}</span>
      </button>`).join('')}</div>` : ''}
    ${orphan.length ? `<div class="sec-h">Noch ohne Karten</div><div class="rows">${orphan.map((d) => `
      <div class="row">${icon(d.kind === 'image' ? 'image' : 'doc')}<span class="grow"><span>${esc(d.name)}</span><span class="sub">${docSub(d)}</span></span>
        <button class="btn btn-sm btn-primary" data-act="gen-doc" data-id="${d.id}">${icon('sparkle')} Erzeugen</button></div>`).join('')}</div>` : ''}
    <div class="sec-h">Deine Stapel</div>
    ${db.decks.length ? `<div class="rows">${withTodo.slice(0, 8).map(({ d }) => deckRow(d)).join('')}</div>
      ${db.decks.length > 8 ? `<button class="btn btn-ghost btn-block" data-nav="library">Alle ${db.decks.length} Stapel</button>` : ''}`
      : '<p class="note">Noch kein Stapel. Tippe auf ＋ und füge ein PDF hinzu.</p>'}
  `;
}

function onboardingHtml() {
  return `
    <div class="onboard">
      <div class="ob-icon">${icon('layers')}</div>
      <h2>Aus Unterricht wird Lernstoff</h2>
      <p>Wirf Deine GoodNotes-Mitschriften, Arbeitsblätter oder Folien als PDF hinein. Die App macht daraus Karteikarten, Quizfragen und einen Lernzettel — und plant, wann Du was wiederholst.</p>
      <button class="dropzone big" data-act="add">${icon('upload')}<strong>PDF hinzufügen</strong><span>antippen oder Datei aufs Fenster ziehen</span></button>
      <div class="ob-steps">
        <div>${icon('upload')}<strong>1. Hochladen</strong><span>PDF, Foto oder Text. In GoodNotes: Teilen → Exportieren → PDF.</span></div>
        <div>${icon('sparkle')}<strong>2. Erzeugen</strong><span>Mit KI (liest Handschrift), offline oder über Claude-Chat.</span></div>
        <div>${icon('target')}<strong>3. Lernen</strong><span>Karteikarten, Quiz, Probetest mit Notenpunkten, Tutor und mehr.</span></div>
      </div>
      <div class="btn-row">
        <button class="btn" data-act="demo">${icon('play')} Beispiel ausprobieren</button>
        ${!hasKey() ? `<button class="btn" data-act="key">${icon('key')} KI einrichten</button>` : ''}
      </div>
    </div>`;
}

const GEN_LABEL = { ai: 'KI', chat: 'Claude-Chat', offline: 'offline', import: 'importiert', demo: 'Beispiel' };

function docSub(d) {
  const parts = [d.kind === 'pdf' ? plural(d.pages, 'Seite', 'Seiten') : d.kind === 'image' ? 'Bild' : 'Text'];
  if (d.kind === 'pdf' && d.inkPages) parts.push(d.inkPages === d.pages ? 'handschriftlich/Scan' : `${d.inkPages} ohne Text`);
  if (d.gen) parts.push(`${GEN_LABEL[d.gen.mode] || 'offline'} · ${plural(d.gen.cards, 'Karte', 'Karten')}`);
  return esc(parts.join(' · '));
}

/* ── Stapel (Bibliothek) ── */
let libFilter = '';     // Fach-ID, '' = alle, '-' = ohne Fach
let libQuery = '';

function renderLibrary() {
  const el = $('#view-library');
  $('#topActions').innerHTML = `<button class="icon-btn" data-act="lib-more" aria-label="Mehr">${icon('more')}</button>`;
  const q = Core.fold(libQuery);
  const usedSubj = db.subjects.filter((s) => db.decks.some((d) => d.subjectId === s.id));
  const noSubj = db.decks.some((d) => !d.subjectId);
  let decks = db.decks.slice().sort((a, b) => a.name.localeCompare(b.name, 'de'));
  if (libFilter === '-') decks = decks.filter((d) => !d.subjectId);
  else if (libFilter) decks = decks.filter((d) => d.subjectId === libFilter);
  if (q) decks = decks.filter((d) => Core.fold(d.name).includes(q));

  const groups = [];
  for (const s of usedSubj) {
    const ds = decks.filter((d) => d.subjectId === s.id);
    if (ds.length) groups.push({ s, ds });
  }
  const loose = decks.filter((d) => !d.subjectId || !subjectById(d.subjectId));
  if (loose.length) groups.push({ s: null, ds: loose });

  // Suche in den Karten
  let hits = [];
  if (q.length >= 3) {
    hits = db.cards.filter((c) => Core.fold(c.front + ' ' + c.back).includes(q)).slice(0, 30);
  }
  const docs = db.docs.slice().sort((a, b) => b.added - a.added)
    .filter((d) => !d.imported)
    .filter((d) => !q || Core.fold(d.name).includes(q))
    .filter((d) => !libFilter || (libFilter === '-' ? !d.subjectId : d.subjectId === libFilter));

  el.innerHTML = `
    <div class="search">${icon('search')}<input type="search" id="libSearch" placeholder="Stapel, Dokumente, Karten suchen" value="${esc(libQuery)}"></div>
    ${usedSubj.length ? `<div class="chips">
      <button class="chip${!libFilter ? ' on' : ''}" data-act="lib-filter" data-id="">Alle</button>
      ${usedSubj.map((s) => `<button class="chip${libFilter === s.id ? ' on' : ''}" data-act="lib-filter" data-id="${s.id}"><span class="dot sj-${s.color}"></span>${esc(s.name)}</button>`).join('')}
      ${noSubj ? `<button class="chip${libFilter === '-' ? ' on' : ''}" data-act="lib-filter" data-id="-">Ohne Fach</button>` : ''}
    </div>` : ''}
    ${groups.map(({ s, ds }) => `
      <div class="sec-h">${s ? `<span class="dot sj-${s.color}"></span>${esc(s.name)}` : 'Ohne Fach'}${s ? `<button class="link sm" data-act="subject-edit" data-id="${s.id}">Bearbeiten</button>` : ''}</div>
      <div class="rows">${ds.map(deckRow).join('')}</div>`).join('')}
    ${!db.decks.length ? `<div class="empty">${icon('cards')}<h2>Noch keine Stapel</h2><p>Füge ein PDF hinzu — daraus entsteht Dein erster Stapel.</p><button class="btn btn-primary" data-act="add">${icon('upload')} Material hinzufügen</button></div>` : ''}
    ${db.decks.length && !groups.length ? '<p class="note">Kein Stapel passt zur Suche.</p>' : ''}
    ${hits.length ? `<div class="sec-h">Karten mit „${esc(libQuery)}“</div><div class="rows">${hits.map((c) => `
      <button class="row" data-act="edit-card" data-id="${c.id}"><span class="grow"><span class="clip2">${esc(frontPlain(c))}</span><span class="sub">${esc((deckById(c.deckId) || {}).name || '')}</span></span></button>`).join('')}</div>` : ''}
    ${docs.length ? `<div class="sec-h">Dokumente</div><div class="rows">${docs.map((d) => `
      <button class="row" data-act="open-doc" data-id="${d.id}">${icon(d.kind === 'image' ? 'image' : 'doc')}
        <span class="grow"><span>${esc(d.name)}</span><span class="sub">${docSub(d)}</span></span>${icon('chevron', 'chev')}</button>`).join('')}</div>` : ''}
  `;
  const inp = $('#libSearch');
  inp.oninput = () => {
    libQuery = inp.value;
    const pos = inp.selectionStart;
    renderLibrary();
    const n = $('#libSearch'); n.focus(); try { n.setSelectionRange(pos, pos); } catch (e) { /* type=search */ }
  };
}

/* ── Stapel-Detail ── */
function renderDeck() {
  const el = $('#view-deck');
  const d = deckById(params.id);
  if (!d) { goBack(); return; }
  setTitle(d.name);
  $('#topActions').innerHTML = `<button class="icon-btn" data-act="deck-more" data-id="${d.id}" aria-label="Mehr">${icon('more')}</button>`;
  const c = counts(d.id);
  const qn = questionsOf(d.id).length;
  const subj = subjectById(d.subjectId);
  const plan = examPlan(d);
  const allDocs = d.docIds.map(docById).filter(Boolean);
  const docs = allDocs.filter((x) => !x.imported);
  const hasSummary = allDocs.some((x) => x.summary || x.glossary.length);
  const lastTest = db.tests.filter((t) => t.deckId === d.id).sort((a, b) => b.at - a.at)[0];
  const running = jobs.filter((j) => j.deckId === d.id && j.status === 'run');
  const tiles = [
    ['study', 'cards', 'Karteikarten', c.todo ? `${c.todo} für heute` : 'heute erledigt'],
    ['quiz', 'quiz', 'Quiz', qn ? plural(qn, 'Frage', 'Fragen') : 'aus Karten'],
    ['write', 'pen', 'Schreiben', 'Antwort tippen'],
    ['match', 'match', 'Zuordnen', d.bestMatch ? `Bestzeit ${fmtSec(d.bestMatch)}` : 'Begriffe & Erklärungen'],
    ['test', 'test', 'Probetest', lastTest ? `zuletzt ${lastTest.points} Punkte` : 'mit Notenpunkten'],
    ['notes', 'notes', 'Lernzettel', hasSummary ? 'Zusammenfassung' : 'Gliederung & Begriffe'],
    ['feynman', 'bulb', 'Erklär es', 'Feynman-Methode'],
    ['chat', 'chat', 'Tutor', hasKey() ? 'Fragen stellen' : 'braucht KI'],
  ];
  el.innerHTML = `
    <div class="deck-head">
      <button class="chip sm" data-act="deck-subject" data-id="${d.id}"><span class="dot sj-${subjectColor(d.subjectId)}"></span>${subj ? esc(subj.name) : 'Fach wählen'}</button>
      <div class="count-row">
        <div><b class="num c-new">${c.nw}</b><span>neu</span></div>
        <div><b class="num c-learn">${c.learn}</b><span>lernt</span></div>
        <div><b class="num c-due">${c.due}</b><span>fällig</span></div>
        <div><b class="num c-mature">${c.mature}</b><span>gefestigt</span></div>
      </div>
      <div class="meter big"><i style="width:${c.total ? Math.round(100 * c.mature / Math.max(1, c.total - c.susp)) : 0}%"></i><i class="young" style="width:${c.total ? Math.round(100 * c.young / Math.max(1, c.total - c.susp)) : 0}%"></i></div>
      <button class="exam-line" data-act="deck-exam" data-id="${d.id}">${icon('calendar')}
        ${plan ? `<span><strong>Prüfung ${plan.days === 0 ? 'heute' : plan.days === 1 ? 'morgen' : `in ${plan.days} Tagen`}</strong> · ${dfShort.format(new Date(d.examDate + 'T12:00'))}${plan.left ? ` · noch ${plural(plan.left, 'neue Karte', 'neue Karten')}, heute bis zu ${newLimit(d)}` : ' · alle Karten einmal gelernt'}</span>`
          : '<span>Prüfungstermin eintragen — die App plant dann bis dahin</span>'}
      </button>
    </div>
    <div class="jobs-box" data-deck="${d.id}">${running.length ? jobsHtml(null, d.id) : ''}</div>
    <button class="btn btn-primary btn-block btn-lg" data-act="study-deck" data-id="${d.id}"${c.total ? '' : ' disabled'}>${icon('play')} ${c.todo ? `Lernen · ${c.todo}` : c.total ? 'Weiter lernen' : 'Noch keine Karten'}</button>
    <div class="tiles">${tiles.map(([act, ic, t, s]) => `
      <button class="tile" data-act="m-${act}" data-id="${d.id}">${icon(ic)}<strong>${t}</strong><span>${esc(s)}</span></button>`).join('')}</div>
    <div class="sec-h">Inhalt</div>
    <div class="rows">
      <button class="row" data-act="open-cards" data-id="${d.id}">${icon('cards')}<span class="grow"><span>Karten ansehen & bearbeiten</span><span class="sub">${plural(c.total, 'Karte', 'Karten')}${c.susp ? `, ${c.susp} ausgesetzt` : ''}</span></span>${icon('chevron', 'chev')}</button>
      <button class="row" data-act="open-questions" data-id="${d.id}">${icon('quiz')}<span class="grow"><span>Quizfragen</span><span class="sub">${plural(qn, 'Frage', 'Fragen')}</span></span>${icon('chevron', 'chev')}</button>
      <button class="row" data-act="card-new" data-id="${d.id}">${icon('plus')}<span class="grow"><span>Karte selbst schreiben</span></span></button>
      ${docs.some((x) => x.kind !== 'text') ? `<button class="row" data-act="occl-pick" data-id="${d.id}">${icon('image')}<span class="grow"><span>Bildkarte anlegen</span><span class="sub">Beschriftungen auf einer Seite verdecken und abfragen</span></span></button>` : ''}
      <button class="row" data-act="deck-more-gen" data-id="${d.id}">${icon('sparkle')}<span class="grow"><span>Mehr Karten erzeugen</span><span class="sub">${hasKey() ? 'Claude ergänzt, was noch fehlt' : 'offline oder über Claude-Chat'}</span></span></button>
    </div>
    ${docs.length ? `<div class="sec-h">Quellen</div><div class="rows">${docs.map((x) => `
      <button class="row" data-act="open-doc" data-id="${x.id}">${icon(x.kind === 'image' ? 'image' : 'doc')}<span class="grow"><span>${esc(x.name)}</span><span class="sub">${docSub(x)}</span></span>${icon('chevron', 'chev')}</button>`).join('')}</div>` : ''}
  `;
}

const fmtSec = (s) => (s >= 60 ? `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')} min` : `${nf0.format(s)} s`);

function deckMenu(id) {
  const d = deckById(id);
  if (!d) return;
  menuSheet(d.name, [
    { label: 'Umbenennen', icon: 'edit', fn: () => askText('Stapel umbenennen', 'Name', { value: d.name }, (v) => {
      if (v.trim()) { d.name = v.trim().slice(0, 80); save(); }
      closeSheet(); render();
    }) },
    { label: 'Fach ändern', icon: 'folder', fn: () => pickSubject(d) },
    { label: 'Prüfungstermin', icon: 'calendar', sub: d.examDate ? dfDate.format(new Date(d.examDate + 'T12:00')) : 'nicht gesetzt', fn: () => examSheet(d) },
    { label: 'Neue Karten pro Tag', icon: 'layers', sub: d.newPerDay != null ? String(d.newPerDay) : `wie eingestellt (${db.settings.newPerDay})`, fn: () => askText('Neue Karten pro Tag', 'Anzahl für diesen Stapel (leer = Einstellung)', { numeric: true, value: d.newPerDay != null ? d.newPerDay : '' }, (v) => {
      d.newPerDay = String(v).trim() === '' ? null : Core.clamp(Math.round(num(v)), 0, 500); save(); closeSheet(); render();
    }, () => deckMenu(id)) },
    { label: 'Exportieren (für Freunde oder Backup)', icon: 'download', sub: 'JSON-Datei, lässt sich hier wieder importieren', fn: () => { exportDeck(d); closeSheet(); } },
    { label: 'Als CSV für Anki/Quizlet', icon: 'download', fn: () => { exportCsv(d); closeSheet(); } },
    { label: 'Lernstand zurücksetzen', icon: 'undo', fn: () => askSheet('Lernstand zurücksetzen?', 'Alle Karten dieses Stapels gelten danach wieder als neu.', 'Zurücksetzen', () => {
      cardsOf(d.id).forEach((c) => { c.s = Core.newState(); }); save(); closeSheet(); render(); toast('Zurückgesetzt');
    }, () => deckMenu(id), true) },
    { label: 'Stapel löschen', icon: 'trash', danger: true, fn: () => deleteDeckSheet(d) },
  ]);
}

function deleteDeckSheet(d) {
  // Dokumente, die nur in diesem Stapel stecken — die anderen bleiben ohnehin
  const own = d.docIds.filter((x) => !db.decks.some((k) => k.id !== d.id && k.docIds.includes(x)));
  openSheet('Stapel löschen?', `
    <p class="dlg-t">„${esc(d.name)}“ mit ${plural(cardsOf(d.id).length, 'Karte', 'Karten')} und dem Lernstand wird gelöscht.</p>
    ${own.length ? `<button class="btn btn-danger btn-block" id="ddAll">Stapel und ${own.length === 1 ? 'Dokument' : own.length + ' Dokumente'} löschen</button>` : ''}
    <button class="btn ${own.length ? '' : 'btn-danger '}btn-block" id="ddDeck" style="margin-top:8px">${own.length ? 'Nur Stapel löschen, Dokument behalten' : 'Löschen'}</button>
    <button class="btn btn-ghost btn-block" id="ddNo" style="margin-top:8px">Abbrechen</button>`, null);
  const done = () => { closeSheet(); toast('Gelöscht'); if (view === 'deck') goBack(); else render(); };
  $('#sheetCancel').onclick = () => deckMenu(d.id);
  $('#ddNo').onclick = () => deckMenu(d.id);
  $('#ddDeck').onclick = () => { deleteDeck(d.id); done(); };
  if ($('#ddAll')) $('#ddAll').onclick = async () => {
    deleteDeck(d.id);
    for (const x of own) await deleteDoc(x);
    save(); done();
  };
}

async function deleteDoc(id) {
  db.docs = db.docs.filter((x) => x.id !== id);
  db.decks.forEach((k) => { k.docIds = k.docIds.filter((x) => x !== id); });
  db.cards.forEach((c) => { if (c.docId === id && c.kind !== 'occl') c.docId = null; });
  await Files.del(id);
  if (pdfCache && pdfCache.id === id) { pdfCache.p.then(closePdf, () => {}); pdfCache = null; }
}

function deleteDeck(id) {
  db.decks = db.decks.filter((d) => d.id !== id);
  db.cards = db.cards.filter((c) => c.deckId !== id);
  db.questions = db.questions.filter((q) => q.deckId !== id);
  db.tests = db.tests.filter((t) => t.deckId !== id);
  delete db.chats[id];
  save();
}

function pickSubject(d) {
  const opts = db.subjects.map((s) => `<button class="row" data-sid="${s.id}"><span class="dot sj-${s.color}"></span><span class="grow">${esc(s.name)}</span>${d.subjectId === s.id ? icon('check') : ''}</button>`).join('');
  openSheet('Fach', `<div class="rows">${opts}<button class="row" data-sid=""><span class="dot sj-x"></span><span class="grow">Ohne Fach</span>${!d.subjectId ? icon('check') : ''}</button>
    <button class="row" data-sid="__new">${icon('plus')}<span class="grow">Neues Fach …</span></button></div>`, null);
  $('#sheetBody').onclick = (e) => {
    const b = e.target.closest('[data-sid]');
    if (!b) return;
    const set = (sid) => {
      d.subjectId = sid || null;
      d.docIds.forEach((x) => { const doc = docById(x); if (doc) doc.subjectId = d.subjectId; });
      save(); closeSheet(); render();
    };
    if (b.dataset.sid === '__new') {
      askText('Neues Fach', 'Name des Fachs', { placeholder: 'z. B. Geschichte' }, (v) => { const s = subjectFor(v); if (s) set(s.id); }, () => pickSubject(d));
    } else set(b.dataset.sid);
  };
}

function subjectEdit(id) {
  const s = subjectById(id);
  if (!s) return;
  openSheet('Fach bearbeiten', `
    <label>Name<input id="sjName" value="${esc(s.name)}"></label>
    <label>Farbe</label><div class="swatches" id="sjCol">${Array.from({ length: SUBJECT_COLORS }, (_, i) => `<button class="sw sj-${i}${s.color === i ? ' on' : ''}" data-c="${i}" aria-label="Farbe ${i + 1}"></button>`).join('')}</div>
    <button class="btn btn-ghost btn-block danger-text" id="sjDel" style="margin-top:16px">${icon('trash')} Fach entfernen</button>
  `, () => {
    const n = $('#sjName').value.trim();
    if (n) s.name = n;
    save(); closeSheet(); render();
  });
  $('#sjCol').onclick = (e) => {
    const b = e.target.closest('[data-c]');
    if (!b) return;
    s.color = +b.dataset.c;
    $$('#sjCol .sw').forEach((x) => x.classList.toggle('on', x === b));
  };
  $('#sjDel').onclick = () => askSheet('Fach entfernen?', 'Die Stapel bleiben erhalten und stehen danach unter „Ohne Fach“.', 'Entfernen', () => {
    db.subjects = db.subjects.filter((x) => x.id !== id);
    db.decks.forEach((d) => { if (d.subjectId === id) d.subjectId = null; });
    db.docs.forEach((d) => { if (d.subjectId === id) d.subjectId = null; });
    if (libFilter === id) libFilter = '';
    save(); closeSheet(); render();
  }, () => subjectEdit(id), true);
}

function examSheet(d) {
  openSheet('Prüfungstermin', `
    <p class="dlg-t">Bis zum Termin verteilt die App die neuen Karten so, dass alles einmal gelernt ist, und plant die Wiederholungen so, dass jede Karte kurz vorher noch einmal drankommt.</p>
    <label>Datum<input type="date" id="exDate" value="${esc(d.examDate || '')}" min="${today()}"></label>
  `, () => {
    const v = $('#exDate').value;
    d.examDate = v || null;
    save(); closeSheet(); render();
    if (v) { const p = examPlan(d); toast(p ? `${p.perDay} neue Karten pro Tag bis zur Prüfung` : 'Gespeichert'); }
  });
  if (d.examDate) {
    $('#sheetBody').insertAdjacentHTML('beforeend', '<button class="btn btn-ghost btn-block" id="exDel">Termin entfernen</button>');
    $('#exDel').onclick = () => { d.examDate = null; save(); closeSheet(); render(); };
  }
}

/** Stapel, in dem nur selbst angelegte Bildkarten zu diesem Dokument
    liegen — erzeugte Karten kommen dann dazu statt in einen zweiten Stapel. */
const occlDeck = (docId) => { const k = db.decks.find((d) => d.docIds.includes(docId)); return k ? k.id : null; };

/** Mehr Karten erzeugen: aus welcher Quelle, und ersetzen oder ergänzen? */
function moreGen(deckId, docId) {
  const d = deckById(deckId);
  const docs = d.docIds.map(docById).filter((x) => x && !x.imported);
  if (!docs.length) { toast('Dieser Stapel hat kein Quelldokument'); return; }
  const key = hasKey();
  openSheet('Mehr Karten erzeugen', `
    ${docs.length > 1 ? `<label>Quelle<select id="mgDoc">${docs.map((x) => `<option value="${x.id}"${x.id === docId ? ' selected' : ''}>${esc(x.name)}</option>`).join('')}</select></label>` : ''}
    <label>Mit<div class="seg" id="mgMode">
      <button data-v="ai" class="${key ? 'on' : ''}">KI</button><button data-v="offline" class="${key ? '' : 'on'}">Offline</button><button data-v="chat">Claude-Chat</button>
    </div></label>
    <label>Wunsch (optional)<input id="mgWish" placeholder="z. B. mehr Fragen zu Kapitel 3, mehr Transferaufgaben"></label>
    <label>Bestehende Karten<div class="seg" id="mgRep"><button data-v="0" class="on">Behalten, ergänzen</button><button data-v="1">Ersetzen</button></div></label>
    <p class="note">„Ersetzen“ löscht die bisher erzeugten Karten dieser Quelle samt Lernstand. Selbst geschriebene Bildkarten bleiben.</p>
  `, () => {
    const mode = $('#mgMode .on').dataset.v;
    const docId = $('#mgDoc') ? $('#mgDoc').value : docs[0].id;
    const replace = $('#mgRep .on').dataset.v === '1';
    if (mode === 'ai' && !hasKey()) { openKeySheet(() => moreGen(deckId, docId)); return; }
    closeSheet();
    if (mode === 'chat') openChatRoute(docId, { deckId, replace });
    else { startGen(docId, { mode, deckId, replace, wish: $('#mgWish') ? $('#mgWish').value.trim() : '' }); toast('Läuft im Hintergrund'); }
  }, 'Start');
  const segs = (sel) => { $(sel).onclick = (e) => { const b = e.target.closest('button'); if (b) $$(sel + ' button').forEach((x) => x.classList.toggle('on', x === b)); }; };
  segs('#mgMode'); segs('#mgRep');
}

/** Fach erraten, wenn es im Dateinamen oder in den ersten Zeilen steht
    („Biologie Q1“, „Bio_Photosynthese.pdf“). Nur für den Offline-Weg — die
    KI erkennt das Fach selbst. */
function guessSubject(text) {
  const m = String(text).match(/\b(Biologie|Bio|Chemie|Physik|Mathematik|Mathe|Deutsch|Englisch|English|Französisch|Spanisch|Latein|Italienisch|Geschichte|Erdkunde|Geographie|Geografie|Politik|Sozialwissenschaften|SoWi|Wirtschaft|Informatik|Kunst|Musik|Religion|Ethik|Philosophie|Pädagogik|Psychologie)\b/i);
  if (!m) return '';
  const k = m[1].toLowerCase();
  return { bio: 'Biologie', mathe: 'Mathematik', english: 'Englisch', sowi: 'Sozialwissenschaften', geografie: 'Geographie' }[k] || m[1].charAt(0).toUpperCase() + m[1].slice(1).toLowerCase();
}

/** Für ein Dokument ohne Stapel: Erzeugen-Auswahl. */
function genDoc(docId) {
  const doc = docById(docId);
  if (!doc) return;
  const deck = db.decks.find((d) => d.docIds.includes(docId) && cardsOf(d.id).some((c) => c.docId === docId && c.kind !== 'occl'));
  // Gibt es schon Karten aus diesem Dokument, erst fragen: ergänzen oder ersetzen
  if (deck) { moreGen(deck.id, docId); return; }
  const key = hasKey();
  menuSheet('Karten erzeugen', [
    { label: 'Mit KI (Claude)', icon: 'sparkle', sub: key ? `${AI.MODELS[db.settings.model].label}${doc.inkPages ? ' · liest auch Handschrift' : ''}` : 'API-Schlüssel einrichten', fn: () => {
      if (!hasKey()) { openKeySheet(() => genDoc(docId)); return; }
      closeSheet(); startGen(docId, { mode: 'ai', deckId: occlDeck(docId) }); toast('Läuft im Hintergrund');
    } },
    { label: 'Offline', icon: 'cards', sub: doc.inkPages === doc.pages ? 'findet bei Handschrift nichts' : 'Begriffe, Definitionen, Listen, Jahreszahlen', fn: () => {
      closeSheet(); startGen(docId, { mode: 'offline', deckId: occlDeck(docId) });
    } },
    { label: 'Über Claude-Chat (ohne Schlüssel)', icon: 'chat', sub: 'Auftrag kopieren, Antwort einfügen', fn: () => openChatRoute(docId, { deckId: occlDeck(docId) }) },
  ]);
}

/* ── Karten ansehen ── */
let cardFilter = 'all';
let cardQuery = '';

function renderCards() {
  const el = $('#view-cards');
  const d = deckById(params.id);
  if (!d) { goBack(); return; }
  const tab = params.tab || 'cards';
  setTitle(tab === 'cards' ? 'Karten' : 'Quizfragen');
  $('#topActions').innerHTML = `<button class="icon-btn" data-act="${tab === 'cards' ? 'card-new' : 'q-new'}" data-id="${d.id}" aria-label="Neu">${icon('plus')}</button>`;
  const q = Core.fold(cardQuery);
  if (tab === 'questions') {
    let qs = questionsOf(d.id);
    if (q) qs = qs.filter((x) => Core.fold(x.q + ' ' + x.options.join(' ') + ' ' + x.answer).includes(q));
    el.innerHTML = `
      <div class="seg tabs"><button data-act="cards-tab" data-v="cards">Karten</button><button class="on">Quizfragen</button></div>
      <div class="search">${icon('search')}<input type="search" id="cardSearch" placeholder="Suchen" value="${esc(cardQuery)}"></div>
      <div class="rows">${qs.map((x) => `
        <button class="row" data-act="edit-q" data-id="${x.id}"><span class="grow"><span class="clip2">${esc(x.q)}</span>
          <span class="sub">${{ mc: 'Multiple Choice', tf: 'Richtig/Falsch', open: 'Offene Frage' }[x.kind]}${x.seen ? ` · ${x.right}/${x.seen} richtig` : ''}</span></span></button>`).join('') || '<div class="row"><span class="grow muted">Keine Fragen</span></div>'}</div>`;
  } else {
    let cs = cardsOf(d.id).sort((a, b) => (a.ord || 0) - (b.ord || 0));
    const now = Date.now();
    const F = {
      all: () => true, new: (c) => !c.susp && c.s.st === 'new', due: (c) => !c.susp && c.s.st !== 'new' && c.s.due <= now,
      hard: (c) => c.s.lapses >= 2 || (c.s.ease < 2.0 && c.s.reps > 2), susp: (c) => c.susp,
    };
    const n = (k) => cs.filter(F[k]).length;
    cs = cs.filter(F[cardFilter] || F.all);
    if (q) cs = cs.filter((c) => Core.fold(c.front + ' ' + c.back + ' ' + c.hint).includes(q));
    el.innerHTML = `
      <div class="seg tabs"><button class="on">Karten</button><button data-act="cards-tab" data-v="questions">Quizfragen</button></div>
      <div class="search">${icon('search')}<input type="search" id="cardSearch" placeholder="Suchen" value="${esc(cardQuery)}"></div>
      <div class="chips">${[['all', 'Alle'], ['new', 'Neu'], ['due', 'Fällig'], ['hard', 'Schwierig'], ['susp', 'Ausgesetzt']].map(([k, l]) =>
        `<button class="chip${cardFilter === k ? ' on' : ''}" data-act="card-filter" data-v="${k}">${l}<span class="n">${n(k)}</span></button>`).join('')}</div>
      <div class="rows">${cs.slice(0, 400).map((c) => {
        const st = stateLabel(c);
        return `<button class="row card-row" data-act="edit-card" data-id="${c.id}">
          <span class="grow"><span class="clip2">${c.kind === 'occl' ? icon('image', 'inl') : ''}${esc(frontPlain(c))}</span>
          ${c.kind === 'basic' ? `<span class="sub clip1">${esc(c.back)}</span>` : ''}</span>
          <span class="st st-${st.cls}">${esc(st.t)}</span></button>`;
      }).join('') || '<div class="row"><span class="grow muted">Keine Karten</span></div>'}</div>
      ${cs.length > 400 ? `<p class="note">Die ersten 400 von ${cs.length} — Suche hilft.</p>` : ''}`;
  }
  const inp = $('#cardSearch');
  inp.oninput = () => {
    cardQuery = inp.value;
    const pos = inp.selectionStart;
    renderCards();
    const n = $('#cardSearch'); n.focus(); try { n.setSelectionRange(pos, pos); } catch (e) { /* egal */ }
  };
}

function editCard(id, deckId, back) {
  const c = id ? db.cards.find((x) => x.id === id) : null;
  const deck = deckById(c ? c.deckId : deckId);
  if (!deck) return;
  const kind = c ? c.kind : 'basic';
  openSheet(c ? 'Karte bearbeiten' : 'Neue Karte', `
    ${kind !== 'occl' ? `<label>Art<div class="seg" id="ecKind"><button data-v="basic" class="${kind === 'basic' ? 'on' : ''}">Frage & Antwort</button><button data-v="cloze" class="${kind === 'cloze' ? 'on' : ''}">Lückentext</button></div></label>` : `<div class="occl-prev" id="ecPrev"></div>`}
    <label><span id="ecFrontL">${kind === 'cloze' ? 'Satz mit Lücke in {{…}}' : kind === 'occl' ? 'Frage zur Bildkarte' : 'Vorderseite'}</span><textarea id="ecFront" rows="3">${esc(c ? c.front : '')}</textarea></label>
    <div id="ecClozeHelp" class="${kind === 'cloze' ? '' : 'hidden'}"><button class="btn btn-sm" id="ecMark">Markiertes zur Lücke machen</button></div>
    <label id="ecBackL" class="${kind === 'occl' ? 'hidden' : ''}"><span>${kind === 'cloze' ? 'Zusatz (optional)' : 'Rückseite'}</span><textarea id="ecBack" rows="3">${esc(c ? c.back : '')}</textarea></label>
    <label>Hinweis / Eselsbrücke (optional)<input id="ecHint" value="${esc(c ? c.hint : '')}"></label>
    ${c ? `<p class="note">${esc(stateLabel(c).t)} · ${plural(c.s.reps, 'Wiederholung', 'Wiederholungen')}${c.s.lapses ? ` · ${c.s.lapses}× vergessen` : ''}${c.page ? ` · Seite ${c.page}` : ''}</p>
    <div class="btn-row">
      <button class="btn btn-sm" id="ecSusp">${c.susp ? 'Fortsetzen' : 'Aussetzen'}</button>
      <button class="btn btn-sm" id="ecReset">Als neu</button>
      <button class="btn btn-sm danger-text" id="ecDel">${icon('trash')} Löschen</button>
    </div>` : ''}
  `, () => {
    const front = $('#ecFront').value.trim();
    const backV = $('#ecBack').value.trim();
    const k = kind === 'occl' ? 'occl' : $('#ecKind .on').dataset.v;
    if (!front) { toast('Vorderseite fehlt'); return; }
    if (k === 'cloze' && !Core.clozeCount(front)) { toast('Lückentext braucht eine Lücke in {{…}}'); return; }
    if (k === 'basic' && !backV) { toast('Rückseite fehlt'); return; }
    if (c) Object.assign(c, { kind: k, front, back: backV, hint: $('#ecHint').value.trim() });
    else {
      const ord = cardsOf(deck.id).reduce((m, x) => Math.max(m, x.ord || 0), 0) + 1;
      db.cards.push({ id: uid(), deckId: deck.id, docId: null, kind: k, front, back: backV, hint: $('#ecHint').value.trim(), page: 0, ord, created: Date.now(), s: Core.newState() });
    }
    save(); closeSheet();
    if (back) back(); else render();
    toast(c ? 'Gespeichert' : 'Karte angelegt');
  });
  if (back) $('#sheetCancel').onclick = back;
  if ($('#ecKind')) $('#ecKind').onclick = (e) => {
    const b = e.target.closest('[data-v]');
    if (!b) return;
    $$('#ecKind button').forEach((x) => x.classList.toggle('on', x === b));
    const cl = b.dataset.v === 'cloze';
    $('#ecFrontL').textContent = cl ? 'Satz mit Lücke in {{…}}' : 'Vorderseite';
    $('#ecBackL span').textContent = cl ? 'Zusatz (optional)' : 'Rückseite';
    $('#ecClozeHelp').classList.toggle('hidden', !cl);
  };
  if ($('#ecMark')) $('#ecMark').onclick = () => {
    const ta = $('#ecFront');
    const a = ta.selectionStart, b = ta.selectionEnd;
    if (a === b) { toast('Erst ein Wort im Satz markieren'); return; }
    ta.value = ta.value.slice(0, a) + '{{' + ta.value.slice(a, b) + '}}' + ta.value.slice(b);
  };
  if (c && c.kind === 'occl') occlPreview($('#ecPrev'), c, true);
  if (c) {
    $('#ecSusp').onclick = () => { c.susp = !c.susp; save(); closeSheet(); if (back) back(); else render(); toast(c.susp ? 'Ausgesetzt — kommt nicht mehr dran' : 'Fortgesetzt'); };
    $('#ecReset').onclick = () => { c.s = Core.newState(); save(); closeSheet(); if (back) back(); else render(); toast('Karte gilt wieder als neu'); };
    $('#ecDel').onclick = () => askSheet('Karte löschen?', frontPlain(c).slice(0, 140), 'Löschen', () => {
      db.cards = db.cards.filter((x) => x.id !== c.id); save(); closeSheet(); if (back) back(); else render(); toast('Gelöscht');
    }, () => editCard(id, deckId, back), true);
  }
}

function editQuestion(id, deckId) {
  const q = id ? db.questions.find((x) => x.id === id) : null;
  const deck = deckById(q ? q.deckId : deckId);
  if (!deck) return;
  const kind = q ? q.kind : 'mc';
  const opts = q && q.kind === 'mc' ? q.options.slice() : ['', '', '', ''];
  while (opts.length < 4) opts.push('');
  openSheet(q ? 'Frage bearbeiten' : 'Neue Frage', `
    <label>Art<div class="seg" id="eqKind">${[['mc', 'Auswahl'], ['tf', 'Richtig/Falsch'], ['open', 'Offen']].map(([v, l]) => `<button data-v="${v}" class="${kind === v ? 'on' : ''}">${l}</button>`).join('')}</div></label>
    <label>Frage<textarea id="eqQ" rows="3">${esc(q ? q.q : '')}</textarea></label>
    <div id="eqMc" class="${kind === 'mc' ? '' : 'hidden'}">
      <label>Antworten — die richtige antippen</label>
      ${opts.map((o, i) => `<div class="opt-edit"><button class="check${q && q.kind === 'mc' && q.correct === i ? ' on' : (!q && i === 0 ? ' on' : '')}" data-i="${i}">${icon('check')}</button><input class="eqOpt" value="${esc(o)}" placeholder="Antwort ${i + 1}"></div>`).join('')}
    </div>
    <div id="eqTf" class="${kind === 'tf' ? '' : 'hidden'}"><label>Die Aussage ist<div class="seg" id="eqTfV"><button data-v="0" class="${!q || q.correct === 0 ? 'on' : ''}">richtig</button><button data-v="1" class="${q && q.kind === 'tf' && q.correct === 1 ? 'on' : ''}">falsch</button></div></label></div>
    <label id="eqAns" class="${kind === 'open' ? '' : 'hidden'}">Musterlösung<textarea id="eqA" rows="3">${esc(q ? q.answer : '')}</textarea></label>
    <label>Erklärung (optional)<textarea id="eqE" rows="2">${esc(q ? q.explain : '')}</textarea></label>
    ${q ? `<button class="btn btn-ghost btn-block danger-text" id="eqDel">${icon('trash')} Frage löschen</button>` : ''}
  `, () => {
    const k = $('#eqKind .on').dataset.v;
    const text = $('#eqQ').value.trim();
    if (!text) { toast('Frage fehlt'); return; }
    const rec = { kind: k, q: text, explain: $('#eqE').value.trim(), answer: '', options: [], correct: 0 };
    if (k === 'mc') {
      const inputs = $$('.eqOpt');
      const sel = $$('#eqMc .check').findIndex((x) => x.classList.contains('on'));
      const list = inputs.map((x, i) => ({ t: x.value.trim(), ok: i === sel })).filter((x) => x.t);
      if (list.length < 2 || !list.some((x) => x.ok)) { toast('Mindestens zwei Antworten, eine davon richtig'); return; }
      rec.options = list.map((x) => x.t); rec.correct = list.findIndex((x) => x.ok);
    } else if (k === 'tf') { rec.options = ['Richtig', 'Falsch']; rec.correct = +$('#eqTfV .on').dataset.v; }
    else { rec.answer = $('#eqA').value.trim(); if (!rec.answer) { toast('Musterlösung fehlt'); return; } }
    if (q) Object.assign(q, rec);
    else db.questions.push(Object.assign({ id: uid(), deckId: deck.id, docId: null, page: 0, seen: 0, right: 0 }, rec));
    save(); closeSheet(); render(); toast('Gespeichert');
  });
  $('#eqKind').onclick = (e) => {
    const b = e.target.closest('[data-v]'); if (!b) return;
    $$('#eqKind button').forEach((x) => x.classList.toggle('on', x === b));
    $('#eqMc').classList.toggle('hidden', b.dataset.v !== 'mc');
    $('#eqTf').classList.toggle('hidden', b.dataset.v !== 'tf');
    $('#eqAns').classList.toggle('hidden', b.dataset.v !== 'open');
  };
  $('#eqMc').onclick = (e) => { const b = e.target.closest('.check'); if (b) $$('#eqMc .check').forEach((x) => x.classList.toggle('on', x === b)); };
  $('#eqTfV').onclick = (e) => { const b = e.target.closest('[data-v]'); if (b) $$('#eqTfV button').forEach((x) => x.classList.toggle('on', x === b)); };
  if (q) $('#eqDel').onclick = () => askSheet('Frage löschen?', q.q.slice(0, 140), 'Löschen', () => {
    db.questions = db.questions.filter((x) => x.id !== q.id); save(); closeSheet(); render(); toast('Gelöscht');
  }, () => editQuestion(id, deckId), true);
}

/* ── Üben ── */
let practiceDeck = '';     // '' = alle Stapel

function renderPractice() {
  const el = $('#view-practice');
  if (!db.decks.length) {
    el.innerHTML = `<div class="empty">${icon('target')}<h2>Noch nichts zum Üben</h2><p>Sobald ein Stapel da ist, findest Du hier alle Lernmethoden.</p><button class="btn btn-primary" data-act="add">${icon('upload')} Material hinzufügen</button></div>`;
    return;
  }
  if (practiceDeck && !deckById(practiceDeck)) practiceDeck = '';
  const ids = practiceDeck ? [practiceDeck] : allDeckIds();
  const c = counts(ids);
  const cards = cardsOf(ids).filter((x) => !x.susp);
  const hard = cards.filter((x) => x.s.lapses >= 2 || (x.s.reps > 2 && x.s.ease < 2.0)).length;
  const qn = questionsOf(ids).length;
  const id = practiceDeck || '*';
  const M = [
    ['study', 'cards', 'Karteikarten', 'Verteilte Wiederholung: Jede Karte kommt genau dann wieder, wenn Du sie sonst vergessen würdest.', c.todo ? `${c.todo} für heute` : 'heute erledigt'],
    ['quiz', 'quiz', 'Quiz', 'Multiple Choice, Richtig/Falsch und offene Fragen mit Erklärung.', qn ? plural(qn, 'Frage', 'Fragen') : 'aus Karten gebaut'],
    ['write', 'pen', 'Schreiben', 'Antwort selbst tippen — aktives Erinnern wirkt stärker als Wiedererkennen.', 'Tippfehler werden toleriert'],
    ['match', 'match', 'Zuordnen', 'Begriffe und Erklärungen auf Zeit zusammenbringen.', 'sechs Paare je Runde'],
    ['test', 'test', 'Probetest', 'Wie in der Klausur: erst am Ende gibt es die Auswertung — in Notenpunkten.', '10 bis 30 Fragen'],
    ['feynman', 'bulb', 'Erklär es (Feynman)', 'Einen Begriff in eigenen Worten erklären. Wo Du stockst, ist die Lücke.', hasKey() ? 'Claude gibt Feedback' : 'Vergleich mit dem Material'],
    ['hard', 'flag', 'Schwierige Karten', 'Nur die Karten, die Du oft vergisst — ohne den Plan zu verändern.', hard ? plural(hard, 'Karte', 'Karten') : 'noch keine'],
    ['cram', 'shuffle', 'Alles durchgehen', 'Alle Karten einmal, z. B. am Abend vor der Prüfung. Ändert den Plan nicht.', plural(cards.length, 'Karte', 'Karten')],
    ['notes', 'notes', 'Lernzettel', 'Zusammenfassung, Kernaussagen und Begriffe zum Durchlesen und Drucken.', ''],
    ['chat', 'chat', 'Tutor', 'Fragen zum Stoff stellen, Erklärungen und Beispiele bekommen.', hasKey() ? '' : 'braucht KI'],
  ];
  el.innerHTML = `
    <div class="chips">
      <button class="chip${!practiceDeck ? ' on' : ''}" data-act="pr-deck" data-id="">Alle Stapel</button>
      ${db.decks.map((d) => `<button class="chip${practiceDeck === d.id ? ' on' : ''}" data-act="pr-deck" data-id="${d.id}"><span class="dot sj-${subjectColor(d.subjectId)}"></span>${esc(d.name)}</button>`).join('')}
    </div>
    <div class="method-list">${M.filter(([k]) => !(['notes', 'chat'].includes(k) && !practiceDeck)).map(([k, ic, t, s, n]) => `
      <button class="method" data-act="m-${k}" data-id="${id}">${icon(ic)}<span class="grow"><strong>${t}</strong><span>${esc(s)}</span>${n ? `<em>${esc(n)}</em>` : ''}</span>${icon('chevron', 'chev')}</button>`).join('')}</div>
    ${!practiceDeck ? '<p class="note">Lernzettel und Tutor gibt es je Stapel — oben einen Stapel wählen.</p>' : ''}
  `;
}

/* ── Statistik ── */
function renderStats() {
  const el = $('#view-stats');
  const keys = Object.keys(db.days).sort();
  const sum = (f, n) => { let s = 0; for (let i = 0; i < n; i++) { const r = db.days[Core.dayKey(Core.addDays(Date.now(), -i))]; if (r) s += f(r); } return s; };
  const rev30 = sum((r) => r.rev, 30), ok30 = sum((r) => r.ok, 30);
  const ms30 = sum((r) => r.ms, 30);
  const all = db.cards.filter((c) => !c.susp);
  const st = { new: 0, learn: 0, young: 0, mature: 0 };
  for (const c of all) {
    if (c.s.st === 'new') st.new++;
    else if (c.s.st !== 'review') st.learn++;
    else if (Core.isMature(c.s)) st.mature++;
    else st.young++;
  }
  const tot = Math.max(1, all.length);

  // Heatmap: 18 Wochen, Spalten = Wochen (Mo–So)
  const WEEKS = 18;
  const startT = (() => { const d = new Date(Core.dayStart(Date.now())); const dow = (d.getDay() + 6) % 7; d.setDate(d.getDate() - dow - (WEEKS - 1) * 7); return d.getTime(); })();
  let cells = '';
  const maxRev = Math.max(1, ...keys.map((k) => db.days[k].rev || 0));
  for (let w = 0; w < WEEKS; w++) {
    for (let d = 0; d < 7; d++) {
      const t = Core.addDays(startT, w * 7 + d);
      if (t > Date.now()) continue;
      const r = db.days[Core.dayKey(t)];
      const v = r ? r.rev + (r.q || 0) : 0;
      const lvl = v === 0 ? 0 : v < maxRev * 0.25 ? 1 : v < maxRev * 0.5 ? 2 : v < maxRev * 0.75 ? 3 : 4;
      cells += `<rect x="${w * 13}" y="${d * 13}" width="11" height="11" rx="2.5" class="h${lvl}"><title>${dfShort.format(new Date(t))}: ${v}</title></rect>`;
    }
  }

  // Letzte 30 Tage: Wiederholungen je Tag (Balken), gewusst als dunklerer Teil
  const days30 = Array.from({ length: 30 }, (_, i) => { const t = Core.addDays(Date.now(), i - 29); return { t, r: db.days[Core.dayKey(t)] || { rev: 0, ok: 0 } }; });
  const m30 = Math.max(5, ...days30.map((x) => x.r.rev));
  const bars = days30.map((x, i) => {
    const h = 80 * x.r.rev / m30, h2 = 80 * (x.r.ok || 0) / m30;
    return `<rect x="${i * 10 + 1}" y="${90 - h}" width="8" height="${h}" rx="1.5" class="bar-soft"/><rect x="${i * 10 + 1}" y="${90 - h2}" width="8" height="${h2}" rx="1.5" class="bar"><title>${dfShort.format(new Date(x.t))}: ${x.r.rev} gelernt, ${x.r.ok || 0} gewusst</title></rect>`;
  }).join('');

  // Vorschau: fällige Karten in den nächsten 14 Tagen
  const fc = new Array(14).fill(0);
  const t0 = Core.dayStart(Date.now());
  for (const c of all) {
    if (c.s.st === 'new') continue;
    const dd = Math.max(0, Math.floor((Core.dayStart(c.s.due) - t0) / Core.DAY + 0.5));
    if (dd < 14) fc[dd]++;
  }
  const mf = Math.max(5, ...fc);
  const fbars = fc.map((v, i) => `<rect x="${i * 21 + 2}" y="${90 - 80 * v / mf}" width="17" height="${80 * v / mf}" rx="2" class="bar"><title>${i === 0 ? 'heute' : 'in ' + i + ' T'}: ${v}</title></rect>
    <text x="${i * 21 + 10.5}" y="${86 - 80 * v / mf}" class="bar-v" text-anchor="middle">${v || ''}</text>`).join('');

  const tests = db.tests.slice().sort((a, b) => b.at - a.at).slice(0, 8);
  el.innerHTML = `
    <div class="stat-grid">
      <div class="stat"><span class="stat-v num">${icon('fire', 'ic-fire')}${streak()}</span><span class="stat-l">Tage in Folge</span></div>
      <div class="stat"><span class="stat-v num">${rev30 ? pct(ok30 / rev30) : '–'}</span><span class="stat-l">gewusst (30 Tage)</span></div>
      <div class="stat"><span class="stat-v num">${nf0.format(rev30)}</span><span class="stat-l">Wiederholungen (30 T)</span></div>
      <div class="stat"><span class="stat-v num">${nf0.format(Math.round(ms30 / 60000))}</span><span class="stat-l">Minuten (30 T)</span></div>
    </div>
    <div class="sec-h">Aktivität</div>
    <div class="card chart"><svg viewBox="0 0 ${WEEKS * 13} ${7 * 13}" class="heat">${cells}</svg>
      <div class="legend"><span>weniger</span>${[0, 1, 2, 3, 4].map((l) => `<i class="h${l}"></i>`).join('')}<span>mehr</span></div></div>
    <div class="sec-h">Letzte 30 Tage</div>
    <div class="card chart"><svg viewBox="0 0 300 92" preserveAspectRatio="none" class="bars">${bars}<line x1="0" y1="90.5" x2="300" y2="90.5" class="axis"/></svg>
      <div class="legend"><i class="bar-soft-i"></i><span>gelernt</span><i class="bar-i"></i><span>gewusst</span><span class="grow"></span><span>max. ${m30}</span></div></div>
    <div class="sec-h">Fällig in den nächsten 14 Tagen</div>
    <div class="card chart"><svg viewBox="0 0 296 92" class="bars">${fbars}<line x1="0" y1="90.5" x2="296" y2="90.5" class="axis"/></svg>
      <div class="legend"><span>heute</span><span class="grow"></span><span>in 2 Wochen</span></div></div>
    <div class="sec-h">Karten</div>
    <div class="card">
      <div class="stack-bar">
        <i class="s-new" style="width:${100 * st.new / tot}%"></i><i class="s-learn" style="width:${100 * st.learn / tot}%"></i><i class="s-young" style="width:${100 * st.young / tot}%"></i><i class="s-mature" style="width:${100 * st.mature / tot}%"></i>
      </div>
      <div class="legend wrap"><i class="s-new"></i><span>neu ${st.new}</span><i class="s-learn"></i><span>lernt ${st.learn}</span><i class="s-young"></i><span>jung ${st.young}</span><i class="s-mature"></i><span>gefestigt ${st.mature}</span></div>
      <p class="note">Gefestigt heißt: kommt erst in drei Wochen oder später wieder.</p>
    </div>
    ${db.decks.length ? `<div class="sec-h">Je Stapel</div><div class="rows">${db.decks.map((d) => {
      const cs = cardsOf(d.id);
      const lt = db.tests.filter((t) => t.deckId === d.id).sort((a, b) => b.at - a.at)[0];
      const lapses = cs.reduce((a, c) => a + c.s.lapses, 0), reps = cs.reduce((a, c) => a + c.s.reps, 0);
      return `<button class="row" data-act="open-deck" data-id="${d.id}"><span class="dot sj-${subjectColor(d.subjectId)}"></span><span class="grow"><span>${esc(d.name)}</span>
        <span class="sub">${esc(deckSub(d))}${reps ? ` · ${pct(1 - lapses / Math.max(1, reps))} behalten` : ''}${lt ? ` · Probetest ${lt.points} P.` : ''}</span></span></button>`;
    }).join('')}</div>` : ''}
    ${tests.length ? `<div class="sec-h">Probetests</div><div class="rows">${tests.map((t) => `
      <div class="row"><span class="pts num">${t.points}</span><span class="grow"><span>${esc((deckById(t.deckId) || { name: 'Alle Stapel' }).name)}</span>
        <span class="sub">${dfDate.format(new Date(t.at))} · ${t.score}/${t.max} · Note ${Core.grade(100 * t.score / Math.max(1, t.max)).note}</span></span></div>`).join('')}</div>` : ''}
    ${!keys.length ? '<p class="note">Sobald Du lernst, füllt sich diese Seite.</p>' : ''}
  `;
}

/* ── 9. Lernen ──────────────────────────────────────────────────
   Eine Sitzung hält ihre Warteschlange im Speicher. Jede Bewertung landet
   sofort im Lernstand der Karte — wer mittendrin aufhört, verliert nichts.
   Karten im Lernschritt (1 oder 10 Minuten) kommen in derselben Sitzung
   wieder; ist sonst nichts mehr da, werden sie vorgezogen. */
let S = null;

/** Inline-Formatierung für Kartentext: maskiert, **fett**, Zeilenumbrüche. */
const fmtCard = (s) => esc(s).replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>').replace(/\n/g, '<br>');

function clozeHtml(text, reveal) {
  return Core.clozeParts(text, 0).map((p) => {
    if (p.t === 'gap') return reveal ? `<span class="gap open">${fmtCard(p.s)}</span>` : `<span class="gap">${p.hint ? esc(p.hint) : '…'}</span>`;
    return fmtCard(p.s);
  }).join('');
}

function idsFrom(id) { return !id || id === '*' ? allDeckIds() : [id]; }

/**
 * Sitzung starten. opts: {extra: mehr neue Karten, cram: 'hard'|'all'}
 */
function startStudy(ids, opts) {
  opts = opts || {};
  const now = Date.now();
  let queue = [];
  if (opts.cram) {
    let cs = cardsOf(ids).filter((c) => !c.susp && c.s.st !== 'new' || (!c.susp && opts.cram === 'all'));
    if (opts.cram === 'hard') cs = cs.filter((c) => c.s.lapses >= 2 || (c.s.reps > 2 && c.s.ease < 2.0));
    queue = Core.shuffle(cs).map((c) => c.id);
  } else {
    const rec = dayRec();
    const learn = [], review = [], fresh = [];
    for (const id of ids) {
      const deck = deckById(id);
      if (!deck) continue;
      const cs = cardsOf(id).filter((c) => !c.susp);
      for (const c of cs) {
        if ((c.s.st === 'learn' || c.s.st === 'relearn') && c.s.due <= now + 20 * Core.MIN) learn.push(c);
        else if (c.s.st === 'review' && c.s.due <= now) review.push(c);
      }
      const left = Math.max(0, newLimit(deck) - (rec.nd[id] || 0)) + (opts.extra ? 10 : 0);
      fresh.push(...cs.filter((c) => c.s.st === 'new').sort((a, b) => (a.ord || 0) - (b.ord || 0)).slice(0, left));
    }
    review.sort((a, b) => a.s.due - b.s.due);
    // Bei mehreren Stapeln die neuen Karten mischen, damit nicht erst nur Bio kommt
    const fr = ids.length > 1 ? Core.shuffle(fresh) : fresh;
    // Alle drei Wiederholungen eine neue Karte
    const mixed = [];
    let ri = 0, fi = 0;
    while (ri < review.length || fi < fr.length) {
      for (let k = 0; k < 3 && ri < review.length; k++) mixed.push(review[ri++]);
      if (fi < fr.length) mixed.push(fr[fi++]);
    }
    queue = learn.sort((a, b) => a.s.due - b.s.due).concat(mixed).map((c) => c.id);
  }
  if (!queue.length) {
    toast(opts.cram === 'hard' ? 'Keine schwierigen Karten — gut so!' : 'Gerade nichts fällig');
    return;
  }
  S = { ids, queue, learnQ: [], done: 0, ok: 0, again: 0, seen: new Set(), total: queue.length, cram: opts.cram || null,
    started: now, shownAt: now, cur: null, flipped: false, undo: null, ended: false, explain: null };
  nextCard();
  nav('study', { ids });
}

function nextCard() {
  const now = Date.now();
  const byId = (id) => db.cards.find((c) => c.id === id);
  S.explain = null;
  S.flipped = false;
  // Fällige Lernschritte zuerst
  S.learnQ.sort((a, b) => byId(a).s.due - byId(b).s.due);
  if (S.learnQ.length && byId(S.learnQ[0]).s.due <= now) { S.cur = S.learnQ.shift(); }
  else if (S.queue.length) { S.cur = S.queue.shift(); }
  else if (S.learnQ.length) { S.cur = S.learnQ.shift(); }      // vorziehen
  else { S.cur = null; S.ended = true; }
  if (S.cur && !byId(S.cur)) { nextCard(); return; }          // zwischendurch gelöscht
  S.shownAt = now;
}

function gradeCard(g) {
  if (!S || !S.cur || !S.flipped) return;
  const c = db.cards.find((x) => x.id === S.cur);
  if (!c) { nextCard(); renderStudy(); return; }
  const now = Date.now();
  const prev = JSON.parse(JSON.stringify(c.s));
  const deck = deckById(c.deckId);
  const ms = Math.min(60000, now - S.shownAt);
  const rec = dayRec();
  const undo = { id: c.id, prev, cram: !!S.cram, ms, g, wasNew: prev.st === 'new', deckId: c.deckId, learnQ: S.learnQ.slice(), queue: S.queue.slice() };
  if (!S.cram) {
    c.s = Core.schedule(c.s, g, now, { maxIvl: maxIvlFor(deck) });
    if (c.s.st === 'learn' || c.s.st === 'relearn') S.learnQ.push(c.id);
    rec.rev++;
    if (g >= 2) rec.ok++;
    if (undo.wasNew) { rec.nw++; rec.nd[c.deckId] = (rec.nd[c.deckId] || 0) + 1; }
  } else if (g === 1) {
    // Pauken: falsch Beantwortetes kommt am Ende der Runde noch einmal
    S.queue.push(c.id);
  }
  rec.ms += ms;
  S.done++;
  S.seen.add(c.id);
  if (g >= 2) S.ok++; else S.again++;
  S.undo = undo;
  saveSoon();
  nextCard();
  renderStudy();
}

function undoGrade() {
  if (!S || !S.undo) return;
  const u = S.undo;
  const c = db.cards.find((x) => x.id === u.id);
  if (!c) return;
  if (S.cur) S.queue.unshift(S.cur);
  S.queue = u.queue;
  S.learnQ = u.learnQ;
  if (!u.cram) {
    c.s = u.prev;
    const rec = dayRec();
    rec.rev = Math.max(0, rec.rev - 1);
    if (u.g >= 2) rec.ok = Math.max(0, rec.ok - 1);
    if (u.wasNew) { rec.nw = Math.max(0, rec.nw - 1); rec.nd[u.deckId] = Math.max(0, (rec.nd[u.deckId] || 0) - 1); }
  }
  dayRec().ms = Math.max(0, dayRec().ms - u.ms);
  S.done = Math.max(0, S.done - 1);
  if (u.g >= 2) S.ok = Math.max(0, S.ok - 1); else S.again = Math.max(0, S.again - 1);
  S.cur = u.id; S.flipped = true; S.ended = false; S.undo = null; S.shownAt = Date.now();
  saveSoon();
  renderStudy();
}

function leaveStudy() { if (saveTimer) save(); }

function renderStudy() {
  const el = $('#view-study');
  if (!S) { goBack(); return; }
  const remaining = S.queue.length + S.learnQ.length + (S.cur ? 1 : 0);
  setTitle(S.cram ? (S.cram === 'hard' ? 'Schwierige Karten' : 'Durchgehen') : (S.ids.length === 1 ? (deckById(S.ids[0]) || {}).name || 'Lernen' : 'Alle Stapel'));
  $('#topActions').innerHTML = S.undo ? `<button class="icon-btn" data-act="undo" aria-label="Rückgängig">${icon('undo')}</button>` : '';
  const progress = S.done / Math.max(1, S.done + remaining);

  if (S.ended || !S.cur) {
    const minutes = Math.max(1, Math.round((Date.now() - S.started) / 60000));
    const c = counts(S.ids);
    el.innerHTML = `
      <div class="done-screen">
        <div class="hero-done">${icon('check')}</div>
        <h2>Geschafft!</h2>
        <p>${plural(S.seen.size, 'Karte', 'Karten')}${S.done > S.seen.size ? ` (${S.done} Wiederholungen)` : ''} in ${plural(minutes, 'Minute', 'Minuten')} · ${S.done ? pct(S.ok / S.done) : '–'} gewusst</p>
        ${S.undo ? `<button class="btn btn-ghost" data-act="undo">${icon('undo')} Letzte Bewertung zurück</button>` : ''}
        <div class="btn-col">
          ${!S.cram && c.nw ? `<button class="btn btn-block" data-act="study-more">${icon('plus')} 10 weitere neue Karten</button>` : ''}
          <button class="btn btn-block" data-act="m-quiz" data-id="${S.ids.length === 1 ? S.ids[0] : '*'}">${icon('quiz')} Quiz zum Stoff</button>
          <button class="btn btn-primary btn-block" data-act="back">Fertig</button>
        </div>
        ${!S.cram && c.learn ? `<p class="note">${plural(c.learn, 'Karte ist', 'Karten sind')} noch im Lernschritt und kommen in wenigen Minuten wieder.</p>` : ''}
      </div>`;
    return;
  }

  const c = db.cards.find((x) => x.id === S.cur);
  const deck = deckById(c.deckId);
  const labels = S.cram ? ['kommt nochmal', '', 'weiter', ''] : Core.previewLabels(c.s, Date.now(), { maxIvl: maxIvlFor(deck) });
  const lbl = (s) => (s === 'review' ? 'Wiederholung' : s === 'new' ? 'Neu' : 'Lernschritt');
  const doc = c.docId && docById(c.docId);
  let face;
  if (c.kind === 'cloze') {
    face = `<div class="q cloze">${clozeHtml(c.front, S.flipped)}</div>
      ${S.flipped && c.back ? `<div class="a extra">${fmtCard(c.back)}</div>` : ''}`;
  } else if (c.kind === 'occl') {
    face = `<div class="q">${fmtCard(c.front || 'Was ist verdeckt?')}</div><div class="occl-prev" id="studyOccl"></div>`;
  } else {
    // Aufzählungen linksbündig, sonst springen die Punkte hin und her
    const listy = (t) => /\n\s*[•\-–*\d]/.test(t) ? ' list' : '';
    face = `<div class="q${listy(c.front)}">${fmtCard(c.front)}</div>${S.flipped ? `<div class="sep"></div><div class="a${listy('\n' + c.back)}">${fmtCard(c.back)}</div>` : ''}`;
  }
  el.innerHTML = `
    <div class="prog"><i style="width:${Math.round(progress * 100)}%"></i></div>
    <div class="study-meta"><span class="tag tag-${c.s.st}">${lbl(c.s.st)}</span><span>${deck && S.ids.length > 1 ? esc(deck.name) : ''}</span><span class="grow"></span><span class="num">${remaining} übrig</span></div>
    <div class="flash${S.flipped ? ' flipped' : ''}" id="flash" ${S.flipped ? '' : 'data-act="flip" role="button" tabindex="0" aria-label="Karte umdrehen"'}>
      ${face}
      ${S.flipped && c.hint ? `<div class="hint-box">${icon('bulb')}<span>${fmtCard(c.hint)}</span></div>` : ''}
      ${S.flipped && S.explain ? `<div class="explain md">${S.explain === '…' ? '<div class="spinner"></div> Claude erklärt …' : Core.md(S.explain, esc)}</div>` : ''}
      ${!S.flipped ? '<div class="tap-hint">Tippen zum Umdrehen</div>' : ''}
    </div>
    ${!S.flipped && 'speechSynthesis' in window && c.kind !== 'occl' ? `<div class="card-tools"><button class="btn btn-sm btn-ghost" data-act="speak" aria-label="Vorlesen">${icon('speaker')} Vorlesen</button></div>` : ''}
    ${S.flipped ? `
      <div class="card-tools">
        ${'speechSynthesis' in window && c.kind !== 'occl' ? `<button class="btn btn-sm btn-ghost" data-act="speak" aria-label="Vorlesen">${icon('speaker')}</button>` : ''}
        ${doc ? `<button class="btn btn-sm btn-ghost" data-act="card-source" data-id="${c.id}">${icon('doc')} ${c.page ? 'Seite ' + c.page : 'Quelle'}</button>` : ''}
        ${c.kind !== 'occl' ? `<button class="btn btn-sm btn-ghost" data-act="card-explain" data-id="${c.id}">${icon('sparkle')} Erklär’s mir</button>` : ''}
        <button class="btn btn-sm btn-ghost" data-act="card-edit-study" data-id="${c.id}">${icon('edit')} Bearbeiten</button>
      </div>
      <div class="grades${S.cram ? ' two' : ''}">
        <button class="g g1" data-act="grade" data-g="1"><strong>Nochmal</strong><span>${labels[0]}</span></button>
        ${S.cram ? '' : `<button class="g g2" data-act="grade" data-g="2"><strong>Schwer</strong><span>${labels[1]}</span></button>`}
        <button class="g g3" data-act="grade" data-g="3"><strong>${S.cram ? 'Gewusst' : 'Gut'}</strong><span>${labels[2]}</span></button>
        ${S.cram ? '' : `<button class="g g4" data-act="grade" data-g="4"><strong>Leicht</strong><span>${labels[3]}</span></button>`}
      </div>
      ${!S.cram && db.settings.gradeHelp ? `<p class="grade-help"><b>Nochmal</b> nicht gewusst · <b>Schwer</b> nur mit Mühe · <b>Gut</b> gewusst · <b>Leicht</b> sofort, ohne nachzudenken. Darunter steht, wann die Karte wiederkommt. <button class="link inline" data-act="grade-help-off">Verstanden</button></p>` : ''}` : `
      <button class="btn btn-primary btn-block btn-lg" data-act="flip">Antwort zeigen</button>`}
    <p class="kbd-hint">Leertaste: umdrehen · 1–4: bewerten · U: zurück · V: vorlesen · E: bearbeiten</p>
  `;
  if (c.kind === 'occl') occlPreview($('#studyOccl'), c, S.flipped);
}

/* ── Vorlesen ───────────────────────────────────────────────────
   Für Vokabeln mit Aussprache. Die Sprache rät die App: Steht der Stapel
   in einem Sprachfach und der Text sieht nicht deutsch aus, wird er in
   dieser Sprache gelesen, sonst auf Deutsch. Ohne Internet, über die
   Sprachausgabe des Geräts. */
const LANG_OF_SUBJECT = [[/engl/i, 'en-GB'], [/franz/i, 'fr-FR'], [/span/i, 'es-ES'], [/ital/i, 'it-IT'], [/latein/i, 'it-IT']];
function guessLang(text, deck) {
  const w = ' ' + String(text).toLowerCase().replace(/[^\p{L}\s]/gu, ' ') + ' ';
  const hits = (list) => list.reduce((a, x) => a + (w.includes(' ' + x + ' ') ? 1 : 0), 0);
  // Funktionswörter zählen doppelt, typische Wortendungen einfach — so wird
  // auch ein einzelnes „erreichen“ (‑en) oder „sustainable“ (‑able) erkannt
  const ends = (re) => (w.match(re) || []).length;
  const de = 2 * hits(['der', 'die', 'das', 'und', 'ist', 'ein', 'eine', 'nicht', 'zu', 'den', 'mit', 'von']) + (/[äöüß]/.test(w) ? 3 : 0)
    + ends(/\p{L}{2}(en|ung|heit|keit|lich|isch|ig|chen|schaft|ieren|ern)\s/gu) + ends(/sch|tz/g);
  const en = 2 * hits(['the', 'to', 'a', 'is', 'and', 'of', 'in', 'it', 'you', 'that', 'an', 'for'])
    + ends(/\p{L}{2}(tion|ing|ly|able|ible|ity|ness|ment|ship|ous|ive)\s/gu) + ends(/\s(th|wh|w)\p{L}/gu);
  const subj = deck && subjectById(deck.subjectId);
  const lang = subj && (LANG_OF_SUBJECT.find(([re]) => re.test(subj.name)) || [])[1];
  if (en > de) return lang && lang !== 'de-DE' ? (lang.startsWith('en') ? lang : 'en-GB') : 'en-GB';
  if (de > en) return 'de-DE';
  return lang || 'de-DE';
}
function speak(text, deck) {
  if (!('speechSynthesis' in window)) return;
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(Core.clozePlain(String(text)).replace(/[•*_#]/g, ' '));
  u.lang = guessLang(text, deck);
  u.rate = 0.95;
  speechSynthesis.speak(u);
}

function flipCard() {
  if (!S || !S.cur || S.flipped) return;
  S.flipped = true;
  renderStudy();
}

/* ── 10. Quiz, Schreiben, Probetest ─────────────────────────── */
let Q = null;

/** Glossar aller Quelldokumente der Stapel — Material für Fragen und Zuordnen. */
function glossaryOf(ids) {
  const docs = new Set();
  ids.forEach((id) => { const d = deckById(id); if (d) d.docIds.forEach((x) => docs.add(x)); });
  const out = [];
  docs.forEach((id) => { const d = docById(id); if (d) d.glossary.forEach((g) => out.push(Object.assign({ docId: id }, g))); });
  return out;
}

/** Quizfragen sammeln, notfalls aus Karten und Glossar ergänzen. */
function quizPool(ids, n, kinds, wrongOnly) {
  let qs = questionsOf(ids).filter((q) => !kinds || kinds.has(q.kind));
  if (wrongOnly) qs = qs.filter((q) => q.seen > q.right);
  let items = Core.shuffle(qs).slice(0, n).map((q) => ({ type: 'q', qid: q.id, q: Object.assign({}, q) }));
  if (items.length < n && !wrongOnly) {
    const cards = cardsOf(ids).filter((c) => !c.susp && c.kind !== 'occl');
    const extra = Core.buildQuestions(glossaryOf(ids), cards, { max: n - items.length + 5 })
      .filter((q) => (!kinds || kinds.has(q.kind)) && !items.some((x) => Core.dedupeKey(x.q.q) === Core.dedupeKey(q.q)));
    items = items.concat(extra.slice(0, n - items.length).map((q) => ({ type: 'q', qid: null, q })));
  }
  // Antwortmöglichkeiten bei jeder Runde neu mischen — sonst lernt man Positionen
  for (const it of items) {
    if (it.q.kind === 'mc') {
      const order = Core.shuffle(it.q.options.map((_, i) => i));
      it.q.options = order.map((i) => it.q.options[i]);
      it.q.correct = order.indexOf(it.q.correct);
    }
  }
  return Core.shuffle(items);
}

function startQuiz(ids, opts) {
  opts = opts || {};
  const mode = opts.mode || 'quiz';
  let items;
  if (mode === 'write') {
    const cs = cardsOf(ids).filter((c) => !c.susp && ((c.kind === 'basic' && c.back.length <= 90 && !/\n/.test(c.back)) || c.kind === 'cloze'));
    const pick = opts.wrongIds ? cs.filter((c) => opts.wrongIds.includes(c.id)) : Core.shuffle(cs).slice(0, opts.n || 15);
    items = pick.map((c) => ({ type: 'w', cid: c.id }));
    if (!items.length) { toast('Keine passenden Karten (kurze Antworten oder Lückentexte)'); return; }
  } else {
    items = opts.items || quizPool(ids, opts.n || 10, opts.kinds, opts.wrongOnly);
    if (!items.length) { toast(opts.wrongOnly ? 'Keine falsch beantworteten Fragen' : 'Zu wenig Material für ein Quiz'); return; }
  }
  Q = { mode, ids, items, i: 0, answers: [], started: Date.now(), done: false, sel: null, locked: false, grading: false };
  nav('quiz', { ids });
}

/** Auswahl vor dem Start: Anzahl, Fragearten, nur falsche. */
function quizSetup(ids, mode) {
  const qn = questionsOf(ids).length;
  const isTest = mode === 'test';
  const wrong = questionsOf(ids).filter((q) => q.seen > q.right).length;
  openSheet(isTest ? 'Probetest' : 'Quiz', `
    ${isTest ? '<p class="dlg-t">Wie in der Klausur: Du beantwortest alles, erst am Ende gibt es die Auswertung mit Notenpunkten. Offene Fragen bewertest Du selbst — oder Claude, wenn ein Schlüssel hinterlegt ist.</p>' : ''}
    <label>Fragen<div class="seg" id="qsN">${(isTest ? [10, 20, 30] : [5, 10, 20]).map((n, i) => `<button data-v="${n}" class="${i === 1 ? 'on' : ''}">${n}</button>`).join('')}</div></label>
    <label>Fragearten</label>
    <div class="check-list rows" id="qsKinds">
      ${[['mc', 'Multiple Choice'], ['tf', 'Richtig oder falsch'], ['open', 'Offene Fragen']].map(([k, l]) => `<button class="row on" data-k="${k}"><span class="check on">${icon('check')}</span><span class="grow">${l}</span></button>`).join('')}
    </div>
    ${!isTest && wrong ? `<button class="btn btn-block" id="qsWrong" style="margin-top:12px">${icon('undo')} Nur bisher falsch beantwortete (${wrong})</button>` : ''}
    <p class="note">${qn ? `${plural(qn, 'Frage', 'Fragen')} im Stapel` : 'Der Stapel hat noch keine Quizfragen — die App baut welche aus den Karten.'}</p>
  `, () => {
    const kinds = new Set($$('#qsKinds .row.on').map((x) => x.dataset.k));
    if (!kinds.size) { toast('Mindestens eine Frageart wählen'); return; }
    closeSheet();
    startQuiz(ids, { mode, n: +$('#qsN .on').dataset.v, kinds });
  }, 'Start');
  $('#qsN').onclick = (e) => { const b = e.target.closest('[data-v]'); if (b) $$('#qsN button').forEach((x) => x.classList.toggle('on', x === b)); };
  $('#qsKinds').onclick = (e) => { const r = e.target.closest('.row'); if (r) { r.classList.toggle('on'); r.querySelector('.check').classList.toggle('on'); } };
  if ($('#qsWrong')) $('#qsWrong').onclick = () => { closeSheet(); startQuiz(ids, { mode: 'quiz', n: 30, wrongOnly: true }); };
}

function quizItem() { return Q && Q.items[Q.i]; }

/** Antwort (Index bei mc/tf, Text bei offen/schreiben) festhalten. */
function answerQuiz(val) {
  const it = quizItem();
  if (!it || Q.locked) return;
  if (it.type === 'w') {
    const c = db.cards.find((x) => x.id === it.cid);
    const expected = c.kind === 'cloze' ? Core.clozeAnswer(c.front, 0) : c.back;
    const r = Core.checkAnswer(val, expected);
    Q.answers[Q.i] = { given: val, verdict: r.verdict, score: r.verdict === 'right' ? 1 : 0, expected };
    Q.locked = true;
    logQuiz(r.verdict === 'right');
  } else if (it.q.kind === 'open') {
    const a = Q.answers[Q.i] = { given: val, verdict: null, score: null };
    // Kurze Lösung (ein Begriff, eine Jahreszahl): selbst prüfen wie im Schreibmodus
    if (isShort(it.q.answer)) {
      const r = Core.checkAnswer(val, it.q.answer);
      a.verdict = r.verdict === 'right' ? 'right' : r.verdict === 'close' ? 'partial' : 'wrong';
      a.score = a.verdict === 'right' ? 1 : a.verdict === 'partial' ? 0.5 : 0;
      a.auto = true;
      if (Q.mode !== 'test') { countQuestion(it, a.verdict === 'right'); logQuiz(a.verdict === 'right'); }
    }
    if (Q.mode === 'test') { nextQuiz(); return; }
    Q.locked = true;
    if (!a.auto && hasKey() && val.trim()) gradeOpen(Q.i);
  } else {
    const ok = val === it.q.correct;
    Q.answers[Q.i] = { given: val, verdict: ok ? 'right' : 'wrong', score: ok ? 1 : 0 };
    if (Q.mode === 'test') { Q.sel = val; renderQuiz(); return; }
    Q.locked = true;
    // Kurzes Brummen bei falscher Antwort — man merkt es, ohne hinzusehen
    if (!ok && navigator.vibrate) { try { navigator.vibrate(40); } catch (e) { /* egal */ } }
    countQuestion(it, ok);
    logQuiz(ok);
  }
  renderQuiz();
}

const isShort = (ans) => String(ans || '').length <= 40 && !/\n/.test(ans);

function countQuestion(it, ok) {
  if (!it.qid) return;
  const q = db.questions.find((x) => x.id === it.qid);
  if (q) { q.seen++; if (ok) q.right++; }
}
function logQuiz(ok) { const r = dayRec(); r.q++; if (ok) r.qok++; saveSoon(); }

/** Offene Antwort von Claude bewerten lassen. */
async function gradeOpen(i) {
  const it = Q.items[i];
  const a = Q.answers[i];
  if (!a || !a.given.trim()) { a.verdict = 'wrong'; a.score = 0; return; }
  a.grading = true;
  if (view === 'quiz') renderQuiz();
  try {
    const r = await AI.gradeAnswer({ key: getKey(), model: db.settings.model }, { question: it.q.q, reference: it.q.answer, answer: a.given });
    a.verdict = r.verdict; a.score = r.verdict === 'right' ? 1 : r.verdict === 'partial' ? 0.5 : 0;
    a.feedback = r.feedback; a.missing = r.missing;
    db.settings.usd += r.cost;
    if (Q.mode !== 'test') { countQuestion(it, r.verdict === 'right'); logQuiz(r.verdict === 'right'); }
  } catch (e) {
    a.feedback = 'Bewertung nicht möglich: ' + e.message + ' — bitte selbst einschätzen.';
  }
  a.grading = false;
  save();
  if (view === 'quiz') renderQuiz();
}

function selfGrade(i, verdict) {
  const a = Q.answers[i];
  const it = Q.items[i];
  const first = a.verdict == null;
  a.verdict = verdict;
  a.score = verdict === 'right' ? 1 : verdict === 'partial' ? 0.5 : 0;
  if (it.type === 'w') { a.override = true; if (first) logQuiz(verdict === 'right'); else if (verdict === 'right') { const r = dayRec(); r.qok++; } }
  else if (Q.mode !== 'test' && first) { countQuestion(it, verdict === 'right'); logQuiz(verdict === 'right'); }
  saveSoon();
  renderQuiz();
}

function nextQuiz() {
  if (Q.mode === 'test' && Q.items[Q.i] && Q.items[Q.i].q && Q.items[Q.i].q.kind !== 'open' && Q.answers[Q.i] == null) {
    toast('Bitte eine Antwort wählen'); return;
  }
  Q.i++;
  Q.locked = false;
  Q.sel = null;
  if (Q.i >= Q.items.length) finishQuiz();
  renderQuiz();
  window.scrollTo(0, 0);
}

function finishQuiz() {
  Q.done = true;
  if (Q.mode === 'test') {
    // Jetzt erst zählen: im Probetest gab es unterwegs keine Rückmeldung
    Q.items.forEach((it, i) => {
      const a = Q.answers[i];
      if (it.q.kind !== 'open' && a) { countQuestion(it, a.verdict === 'right'); logQuiz(a.verdict === 'right'); }
    });
    if (hasKey()) Q.items.forEach((it, i) => { if (it.q.kind === 'open' && Q.answers[i] && Q.answers[i].verdict == null) gradeOpen(i); });
  }
  save();
}

/** Probetest speichern, sobald alle offenen Antworten bewertet sind. */
function saveTestResult() {
  if (Q.saved) return;
  const score = Q.answers.reduce((s, a) => s + (a && a.score ? a.score : 0), 0);
  const max = Q.items.length;
  const g = Core.grade(100 * score / Math.max(1, max));
  db.tests.push({ id: uid(), deckId: Q.ids.length === 1 ? Q.ids[0] : null, at: Date.now(), n: max, score, max, points: g.points });
  Q.saved = true;
  save();
}

function renderQuiz() {
  const el = $('#view-quiz');
  if (!Q) { goBack(); return; }
  const titles = { quiz: 'Quiz', test: 'Probetest', write: 'Schreiben' };
  setTitle(titles[Q.mode]);
  if (Q.done) { renderQuizResult(el); return; }
  const it = quizItem();
  const a = Q.answers[Q.i];
  const progress = Q.i / Q.items.length;
  let body = '';
  if (it.type === 'w') {
    const c = db.cards.find((x) => x.id === it.cid);
    const prompt = c.kind === 'cloze' ? `<div class="q cloze">${clozeHtml(c.front, Q.locked)}</div>` : `<div class="q">${fmtCard(c.front)}</div>`;
    body = `<div class="flash quiz-card">${prompt}</div>
      ${!Q.locked ? `
        <input id="wIn" class="answer-in" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="${c.kind === 'cloze' ? 'Was gehört in die Lücke?' : 'Deine Antwort'}">
        <div class="btn-row"><button class="btn" data-act="w-skip">Weiß nicht</button><button class="btn btn-primary" data-act="w-check">Prüfen</button></div>`
      : `<div class="verdict v-${a.verdict}">${icon(a.verdict === 'right' ? 'check' : 'x')}<div class="grow">
          <strong>${{ right: 'Richtig!', close: 'Fast — vielleicht ein Tippfehler?', wrong: a.given ? 'Leider falsch' : 'Lösung' }[a.verdict]}</strong>
          ${a.given ? `<span>Deine Antwort: ${esc(a.given)}</span>` : ''}
          <span>Lösung: <b>${esc(a.expected)}</b></span></div></div>
        ${a.verdict !== 'right' && a.given ? `<button class="btn btn-block btn-ghost" data-act="w-override">${icon('check')} Ich lag richtig</button>` : ''}
        <button class="btn btn-primary btn-block btn-lg" data-act="q-next">${Q.i + 1 < Q.items.length ? 'Weiter' : 'Auswertung'}</button>`}`;
  } else {
    const q = it.q;
    if (q.kind === 'open' && isShort(q.answer)) {
      body = `<div class="flash quiz-card"><div class="q-kind">Kurze Antwort</div><div class="q">${fmtCard(q.q)}</div></div>
        ${!Q.locked ? `<input id="wIn" class="answer-in" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="Deine Antwort">
          <div class="btn-row"><button class="btn" data-act="o-skip">Weiß nicht</button><button class="btn btn-primary" data-act="o-check-short">${Q.mode === 'test' ? 'Weiter' : 'Prüfen'}</button></div>`
        : `<div class="verdict v-${a.verdict === 'partial' ? 'close' : a.verdict}">${icon(a.verdict === 'right' ? 'check' : 'x')}<div class="grow">
            <strong>${{ right: 'Richtig!', partial: 'Fast — vielleicht ein Tippfehler?', wrong: a.given ? 'Leider falsch' : 'Lösung' }[a.verdict]}</strong>
            ${a.given ? `<span>Deine Antwort: ${esc(a.given)}</span>` : ''}<span>Lösung: <b>${esc(q.answer)}</b></span></div></div>
          ${a.verdict !== 'right' && a.given ? `<button class="btn btn-block btn-ghost" data-act="self" data-v="right">${icon('check')} Ich lag richtig</button>` : ''}
          ${q.explain ? `<p class="note">${esc(q.explain)}</p>` : ''}
          <button class="btn btn-primary btn-block btn-lg" data-act="q-next">${Q.i + 1 < Q.items.length ? 'Weiter' : 'Auswertung'}</button>`}`;
    } else if (q.kind === 'open') {
      body = `<div class="flash quiz-card"><div class="q-kind">Offene Frage</div><div class="q">${fmtCard(q.q)}</div></div>
        ${!Q.locked ? `<textarea id="oIn" class="answer-in" rows="5" placeholder="Deine Antwort in Stichpunkten oder Sätzen">${esc(a ? a.given : '')}</textarea>
          <div class="btn-row"><button class="btn" data-act="o-skip">Weiß nicht</button><button class="btn btn-primary" data-act="o-check">${Q.mode === 'test' ? 'Weiter' : 'Lösung zeigen'}</button></div>`
        : `<div class="model-answer"><div class="ma-h">Musterlösung</div>${fmtCard(q.answer)}</div>
          ${a.given ? `<div class="your-answer"><div class="ma-h">Deine Antwort</div>${fmtCard(a.given)}</div>` : ''}
          ${a.grading ? '<div class="verdict"><div class="spinner"></div><div class="grow"><strong>Claude bewertet …</strong></div></div>' : ''}
          ${a.feedback ? `<div class="verdict v-${a.verdict || 'close'}">${icon(a.verdict === 'right' ? 'check' : a.verdict === 'wrong' ? 'x' : 'bulb')}<div class="grow"><strong>${{ right: 'Richtig', partial: 'Teilweise richtig', wrong: 'Noch nicht' }[a.verdict] || 'Hinweis'}</strong><span>${esc(a.feedback)}</span>${a.missing && a.missing.length ? `<span>Fehlt: ${esc(a.missing.join(', '))}</span>` : ''}</div></div>` : ''}
          ${!a.grading && (a.verdict == null || !hasKey()) ? `<div class="self-grade"><span>Wie gut war Deine Antwort?</span><div class="btn-row">
            <button class="btn${a.verdict === 'wrong' ? ' sel' : ''}" data-act="self" data-v="wrong">Falsch</button><button class="btn${a.verdict === 'partial' ? ' sel' : ''}" data-act="self" data-v="partial">Teilweise</button><button class="btn${a.verdict === 'right' ? ' sel' : ''}" data-act="self" data-v="right">Richtig</button></div></div>` : ''}
          ${q.explain ? `<p class="note">${esc(q.explain)}</p>` : ''}
          <button class="btn btn-primary btn-block btn-lg" data-act="q-next"${a.verdict == null && !a.grading ? ' disabled' : ''}>${Q.i + 1 < Q.items.length ? 'Weiter' : 'Auswertung'}</button>`}`;
    } else {
      const test = Q.mode === 'test';
      body = `<div class="flash quiz-card"><div class="q-kind">${q.kind === 'tf' ? 'Richtig oder falsch?' : 'Eine Antwort ist richtig'}</div><div class="q">${fmtCard(q.q)}</div></div>
        <div class="options${q.kind === 'tf' ? ' tf' : ''}">${q.options.map((o, i) => {
          let cls = '';
          if (Q.locked) cls = i === q.correct ? ' right' : a && a.given === i ? ' wrong' : ' dim';
          else if (test && Q.sel === i) cls = ' sel';
          return `<button class="opt${cls}" data-act="opt" data-i="${i}"${Q.locked ? ' disabled' : ''}><span class="k">${q.kind === 'tf' ? '' : String.fromCharCode(65 + i)}</span><span class="grow">${fmtCard(o)}</span></button>`;
        }).join('')}</div>
        ${Q.locked ? `${q.explain ? `<div class="verdict v-${a.verdict}">${icon(a.verdict === 'right' ? 'check' : 'x')}<div class="grow"><strong>${a.verdict === 'right' ? 'Richtig!' : 'Falsch'}</strong><span>${esc(q.explain)}</span></div></div>` : ''}
          <button class="btn btn-primary btn-block btn-lg" data-act="q-next">${Q.i + 1 < Q.items.length ? 'Weiter' : 'Auswertung'}</button>`
          : test ? `<button class="btn btn-primary btn-block btn-lg" data-act="q-next"${Q.sel == null ? ' disabled' : ''}>${Q.i + 1 < Q.items.length ? 'Weiter' : 'Abgeben'}</button>` : ''}`;
    }
  }
  el.innerHTML = `
    <div class="prog"><i style="width:${Math.round(progress * 100)}%"></i></div>
    <div class="study-meta"><span class="num">Frage ${Q.i + 1} von ${Q.items.length}</span><span class="grow"></span>${Q.mode !== 'test' ? `<span class="num">${Q.answers.filter((x) => x && x.score === 1).length} richtig</span>` : `<span class="num">${icon('clock', 'inl')} ${fmtSec(Math.round((Date.now() - Q.started) / 1000))}</span>`}</div>
    ${body}`;
  const inp = $('#wIn');
  if (inp) {
    inp.focus();
    inp.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); answerQuiz(inp.value); } };
  }
}

function renderQuizResult(el) {
  const grading = Q.answers.some((a) => a && a.grading);
  const unrated = Q.items.filter((it, i) => it.q && it.q.kind === 'open' && (!Q.answers[i] || Q.answers[i].verdict == null)).length;
  const pending = grading || unrated > 0;
  const score = Q.answers.reduce((s, a) => s + (a && a.score ? a.score : 0), 0);
  const max = Q.items.length;
  const p = 100 * score / Math.max(1, max);
  const g = Core.grade(p);
  if (Q.mode === 'test' && !pending) saveTestResult();
  const minutes = Math.max(1, Math.round((Date.now() - Q.started) / 60000));
  const wrong = Q.items.map((it, i) => ({ it, a: Q.answers[i], i })).filter((x) => !x.a || x.a.score !== 1);
  el.innerHTML = `
    <div class="result">
      ${Q.mode === 'test' ? `<div class="grade-big"><span class="num">${pending ? '…' : g.points}</span><small>${grading ? 'Claude bewertet …' : pending ? `noch ${unrated} offene ${unrated === 1 ? 'Antwort' : 'Antworten'} unten bewerten` : `Punkte · Note ${g.note}`}</small></div>` : `<div class="grade-big"><span class="num">${pct(score / Math.max(1, max))}</span><small>richtig</small></div>`}
      <p>${nf2.format(score).replace(',00', '')} von ${max} ${Q.mode === 'write' ? 'gewusst' : 'Punkten'} · ${plural(minutes, 'Minute', 'Minuten')}</p>
      ${p >= 90 ? '<p class="praise">Stark! Das sitzt.</p>' : p >= 70 ? '<p class="praise">Gut — die Lücken unten noch einmal ansehen.</p>' : '<p class="praise">Dranbleiben: die falschen Antworten durchgehen und morgen wiederholen.</p>'}
    </div>
    ${wrong.length ? `<div class="sec-h">${Q.mode === 'test' ? 'Auswertung' : 'Zum Nacharbeiten'}</div>
    <div class="review-list">${(Q.mode === 'test' ? Q.items.map((it, i) => ({ it, a: Q.answers[i], i })) : wrong).map(({ it, a, i }) => reviewItemHtml(it, a, i)).join('')}</div>` : ''}
    <div class="btn-col">
      ${wrong.length && Q.mode !== 'test' ? `<button class="btn btn-block" data-act="q-retry-wrong">${icon('undo')} Falsche wiederholen (${wrong.length})</button>` : ''}
      <button class="btn btn-block" data-act="q-again">${icon('shuffle')} Neue Runde</button>
      <button class="btn btn-primary btn-block" data-act="back">Fertig</button>
    </div>`;
}

function reviewItemHtml(it, a, i) {
  if (it.type === 'w') {
    const c = db.cards.find((x) => x.id === it.cid);
    return `<div class="rv ${a && a.score === 1 ? 'ok' : 'bad'}"><div class="rv-q">${esc(c ? frontPlain(c) : '')}</div>
      <div class="rv-a">Lösung: <b>${esc(a ? a.expected : '')}</b>${a && a.given ? ` · Du: ${esc(a.given)}` : ''}</div></div>`;
  }
  const q = it.q;
  const v = a ? a.verdict : null;
  let ans;
  if (q.kind === 'open') {
    ans = `<div class="rv-a"><b>Musterlösung:</b> ${fmtCard(q.answer)}</div>${a && a.given ? `<div class="rv-a"><b>Du:</b> ${fmtCard(a.given)}</div>` : '<div class="rv-a muted">nicht beantwortet</div>'}
      ${a && a.grading ? '<div class="rv-a"><div class="spinner"></div> wird bewertet …</div>' : ''}
      ${a && a.feedback ? `<div class="rv-a">${esc(a.feedback)}</div>` : ''}
      ${Q.mode === 'test' && !(a && a.grading) ? `<div class="btn-row sm">${['wrong', 'partial', 'right'].map((x) => `<button class="btn btn-sm${v === x ? ' sel' : ''}" data-act="self-r" data-i="${i}" data-v="${x}">${{ wrong: 'Falsch', partial: 'Teilweise', right: 'Richtig' }[x]}</button>`).join('')}</div>` : ''}`;
  } else {
    ans = `<div class="rv-a">Richtig: <b>${esc(q.options[q.correct])}</b>${a && a.given != null && a.given !== q.correct ? ` · Du: ${esc(q.options[a.given])}` : ''}</div>${q.explain ? `<div class="rv-a muted">${esc(q.explain)}</div>` : ''}`;
  }
  return `<div class="rv ${v === 'right' ? 'ok' : v === 'partial' ? 'mid' : v == null ? '' : 'bad'}"><div class="rv-q">${fmtCard(q.q)}</div>${ans}</div>`;
}

/* ── 11. Zuordnen ───────────────────────────────────────────── */
let M = null;
let matchTimer = null;

function startMatch(ids) {
  const seen = new Set();
  const pairs = [];
  const add = (a, b) => {
    a = String(a).trim(); b = String(b).trim();
    const ka = Core.dedupeKey(a), kb = Core.dedupeKey(b);
    // Vokabeln gibt es in beiden Richtungen — ein Begriff darf nur einmal im Spiel sein,
    // sonst stehen „nachhaltig“ und „sustainable“ je zweimal da
    if (!a || !b || seen.has(ka) || seen.has(kb) || a.length > 60 || b.length > 150) return;
    seen.add(ka); seen.add(kb); pairs.push({ a, b });
  };
  glossaryOf(ids).forEach((g) => add(g.term, g.def));
  cardsOf(ids).filter((c) => c.kind === 'basic' && !c.susp && !/\n/.test(c.back) && c.front.length <= 60).forEach((c) => add(c.front, c.back));
  if (pairs.length < 3) { toast('Dafür braucht es mindestens drei Begriffe mit kurzer Erklärung'); return; }
  const all = Core.shuffle(pairs).slice(0, 18);
  M = { ids, all, round: 0, rounds: Math.ceil(all.length / 6), tiles: [], sel: null, matched: new Set(), mistakes: 0, start: Date.now(), end: null, wrong: null };
  setupRound();
  nav('match', { ids });
  clearInterval(matchTimer);
  matchTimer = setInterval(() => {
    if (view !== 'match' || !M || M.end) { clearInterval(matchTimer); return; }
    const t = $('#matchTime'); if (t) t.textContent = fmtSec(Math.round((Date.now() - M.start) / 1000));
  }, 500);
}

function setupRound() {
  const ps = M.all.slice(M.round * 6, M.round * 6 + 6);
  M.left = Core.shuffle(ps.map((p, i) => ({ i, t: p.a })));
  M.right = Core.shuffle(ps.map((p, i) => ({ i, t: p.b })));
  M.matched = new Set();
  M.sel = null;
}

function tapMatch(side, i) {
  if (!M || M.end || M.matched.has(i)) return;
  if (!M.sel || M.sel.side === side) { M.sel = { side, i }; renderMatch(); return; }
  if (M.sel.i === i) {
    M.matched.add(i);
    M.sel = null;
    if (M.matched.size === M.left.length) {
      M.round++;
      if (M.round >= M.rounds) {
        M.end = Date.now();
        const secs = Math.round((M.end - M.start) / 1000) + M.mistakes * 2;
        M.secs = secs;
        if (M.ids.length === 1) {
          const d = deckById(M.ids[0]);
          if (d && (!d.bestMatch || secs < d.bestMatch)) { d.bestMatch = secs; M.record = true; }
        }
        const r = dayRec(); r.q += M.all.length; r.qok += Math.max(0, M.all.length - M.mistakes);
        save();
      } else setTimeout(() => { setupRound(); renderMatch(); }, 350);
    }
  } else {
    M.mistakes++;
    M.wrong = [M.sel, { side, i }];
    M.sel = null;
    setTimeout(() => { if (M) { M.wrong = null; renderMatch(); } }, 550);
  }
  renderMatch();
}

function renderMatch() {
  const el = $('#view-match');
  if (!M) { goBack(); return; }
  if (M.end) {
    el.innerHTML = `<div class="result">
      <div class="grade-big"><span class="num">${fmtSec(M.secs)}</span><small>${M.record ? 'neue Bestzeit!' : 'Zeit'}</small></div>
      <p>${plural(M.all.length, 'Paar', 'Paare')} · ${plural(M.mistakes, 'Fehler', 'Fehler')} (je +2 s)</p></div>
      <div class="btn-col"><button class="btn btn-block" data-act="match-again">${icon('shuffle')} Noch eine Runde</button><button class="btn btn-primary btn-block" data-act="back">Fertig</button></div>`;
    return;
  }
  const cls = (side, i) => {
    let c = 'mt';
    if (M.matched.has(i)) c += ' gone';
    if (M.sel && M.sel.side === side && M.sel.i === i) c += ' sel';
    if (M.wrong && M.wrong.some((w) => w.side === side && w.i === i)) c += ' bad';
    return c;
  };
  el.innerHTML = `
    <div class="study-meta"><span>Runde ${M.round + 1} von ${M.rounds}</span><span class="grow"></span><span class="num" id="matchTime">${fmtSec(Math.round((Date.now() - M.start) / 1000))}</span><span class="num">· ${M.mistakes} Fehler</span></div>
    <p class="note">Tippe einen Begriff und dann die passende Erklärung.</p>
    <div class="match-grid">
      <div class="col">${M.left.map((x) => `<button class="${cls('l', x.i)}" data-act="mt" data-s="l" data-i="${x.i}">${esc(x.t)}</button>`).join('')}</div>
      <div class="col">${M.right.map((x) => `<button class="${cls('r', x.i)} def" data-act="mt" data-s="r" data-i="${x.i}">${esc(x.t)}</button>`).join('')}</div>
    </div>`;
}

/* ── 12. Lernzettel, Dokument, Bildkarten ───────────────────── */

/* Vorschaubilder als Daten-URL zwischenspeichern: ein Canvas kann nur an
   einer Stelle im DOM hängen, ein Bild beliebig oft. */
const thumbCache = new Map();
async function pageImage(docId, n, w) {
  const k = `${docId}:${n}:${w}`;
  if (thumbCache.has(k)) return thumbCache.get(k);
  const c = await renderPage(docId, n, w);
  const url = c.toDataURL('image/jpeg', 0.85);
  thumbCache.set(k, url);
  if (thumbCache.size > 120) thumbCache.delete(thumbCache.keys().next().value);
  return url;
}

function renderNotes() {
  const el = $('#view-notes');
  const d = deckById(params.id);
  if (!d) { goBack(); return; }
  setTitle('Lernzettel');
  $('#topActions').innerHTML = `<button class="icon-btn" data-act="notes-print" aria-label="Drucken">${icon('download')}</button>`;
  const docs = d.docIds.map(docById).filter(Boolean);
  const q = Core.fold(params.q || '');
  const gl = glossaryOf([d.id]).filter((g) => !q || Core.fold(g.term + ' ' + g.def).includes(q))
    .sort((a, b) => a.term.localeCompare(b.term, 'de'));
  el.innerHTML = `
    <h2 class="notes-title">${esc(d.name)}</h2>
    ${docs.map((x) => `
      <article class="notes card">
        ${docs.length > 1 ? `<div class="notes-src">${icon('doc', 'inl')} ${esc(x.name)}</div>` : ''}
        ${x.summary ? `<div class="md">${Core.md(x.summary, esc)}</div>` : `<p class="muted">Für „${esc(x.name)}“ gibt es noch keine Zusammenfassung.</p>`}
        ${x.keyPoints.length ? `<h4>Kernaussagen</h4><ul class="kp">${x.keyPoints.map((k) => `<li>${fmtCard(k)}</li>`).join('')}</ul>` : ''}
        <div class="btn-row no-print">
          <button class="btn btn-sm" data-act="notes-ai" data-id="${x.id}">${icon('sparkle')} ${x.summary ? 'Neu schreiben' : 'Mit KI schreiben'}</button>
          <button class="btn btn-sm" data-act="notes-edit" data-id="${x.id}">${icon('edit')} Bearbeiten</button>
        </div>
      </article>`).join('')}
    ${!docs.length ? '<p class="note">Dieser Stapel hat kein Quelldokument. Unten stehen die Begriffe aus den Karten.</p>' : ''}
    <div class="sec-h">Begriffe <span class="muted">${gl.length}</span></div>
    <div class="search no-print">${icon('search')}<input type="search" id="glSearch" placeholder="Begriff suchen" value="${esc(params.q || '')}"></div>
    ${gl.length ? `<dl class="gloss">${gl.map((g) => `<dt>${esc(g.term)}${g.page ? ` <span class="pg">S. ${g.page}</span>` : ''}</dt><dd>${fmtCard(g.def)}</dd>`).join('')}</dl>`
      : `<dl class="gloss">${cardsOf(d.id).filter((c) => c.kind === 'basic' && c.front.length < 60).slice(0, 80).map((c) => `<dt>${esc(c.front)}</dt><dd>${fmtCard(c.back)}</dd>`).join('') || '<p class="muted">Keine Begriffe</p>'}</dl>`}
  `;
  const inp = $('#glSearch');
  inp.oninput = () => { params.q = inp.value; const p = inp.selectionStart; renderNotes(); const n = $('#glSearch'); n.focus(); try { n.setSelectionRange(p, p); } catch (e) { /* egal */ } };
}

/** Text aller Seiten eines Dokuments aus dem Dateispeicher. */
async function docText(docId, maxChars) {
  const rec = await Files.get(docId);
  if (!rec || !rec.pages) return '';
  const t = rec.pages.map((p) => `--- Seite ${p.n} ---\n${p.text || ''}`).join('\n\n');
  return maxChars ? t.slice(0, maxChars) : t;
}

/** Material für Tutor und Lernzettel: bei Handschrift das PDF selbst,
    sonst der Text (billiger und schneller). */
async function materialFor(deck) {
  const docs = deck.docIds.map(docById).filter(Boolean);
  if (docs.length === 1 && (docs[0].inkPages > 0 || docs[0].visual || docs[0].kind === 'image')) {
    const rec = await Files.get(docs[0].id);
    if (rec && rec.blob) {
      if (docs[0].kind === 'pdf' && docs[0].bytes < 20e6 && docs[0].pages <= 100) return { name: docs[0].name, pdfBase64: () => blobToBase64(rec.blob) };
      if (docs[0].kind === 'image') return { name: docs[0].name, mediaType: 'image/jpeg', imageBase64: () => pageJpeg(docs[0].id, 1, 1600) };
    }
  }
  let text = '';
  for (const x of docs) text += `\n\n=== ${x.name} ===\n` + await docText(x.id, 300000);
  if (!text.trim()) {
    // Ohne Quelldokument: die Karten selbst als Material
    text = cardsOf(deck.id).map((c) => `- ${Core.clozePlain(c.front)}${c.back ? ' → ' + c.back : ''}`).join('\n');
  }
  return { name: deck.name, text: text.slice(0, 400000) };
}

async function notesAi(docId) {
  if (!hasKey()) { openKeySheet(() => notesAi(docId)); return; }
  const doc = docById(docId);
  const deck = db.decks.find((d) => d.docIds.includes(docId)) || { name: doc.name, docIds: [docId], id: null };
  busy('Claude schreibt den Lernzettel …');
  try {
    const mat = await materialFor({ name: doc.name, docIds: [docId], id: deck.id });
    const res = await AI.tutor({ key: getKey(), model: db.settings.model, onStatus: (s) => busy('Claude ' + s) }, mat, [{ role: 'user',
      text: 'Schreibe mir einen Lernzettel zu diesem Material, so wie ich ihn mir vor der Klausur durchlesen würde: höchstens eine Seite, Markdown mit ## Überschriften und Stichpunkten, wichtige Begriffe **fett**, am Ende „## Typische Fehler“ und „## Das kommt oft dran“. Nur den Lernzettel, keine Einleitung.' }]);
    doc.summary = res.text.trim();
    db.settings.usd += res.cost;
    save();
    busy(null);
    render();
    toast('Lernzettel fertig');
  } catch (e) { busy(null); infoSheet('Lernzettel', e.message); }
}

function notesEdit(docId) {
  const doc = docById(docId);
  openSheet('Lernzettel bearbeiten', `
    <p class="note">Markdown: ## Überschrift, - Stichpunkt, **fett**</p>
    <textarea id="neText" rows="16">${esc(doc.summary)}</textarea>
  `, () => { doc.summary = $('#neText').value; save(); closeSheet(); render(); });
}

/* ── Dokument ── */
let thumbObserver = null;

function renderDoc() {
  const el = $('#view-doc');
  const d = docById(params.id);
  if (!d) { goBack(); return; }
  setTitle(d.name);
  $('#topActions').innerHTML = `<button class="icon-btn" data-act="doc-more" data-id="${d.id}" aria-label="Mehr">${icon('more')}</button>`;
  const decks = db.decks.filter((k) => k.docIds.includes(d.id));
  el.innerHTML = `
    <div class="card doc-info">
      <div class="facts">
        <span>Art</span><span>${d.kind === 'pdf' ? 'PDF' : d.kind === 'image' ? 'Bild' : 'Text'} · ${bytesFmt(d.bytes)}</span>
        ${d.kind === 'pdf' ? `<span>Seiten</span><span>${d.pages}${d.inkPages ? ` · davon ${d.inkPages} ohne Text (Handschrift/Scan)` : ' · alle mit Text'}</span>` : ''}
        ${d.producer ? `<span>Erstellt mit</span><span>${esc(d.producer)}${d.visual ? ' · Claude bekommt das PDF selbst' : ''}</span>` : ''}
        <span>Hinzugefügt</span><span>${dfDate.format(new Date(d.added))}</span>
        ${d.gen ? `<span>Erzeugt</span><span>${d.gen.mode === 'ai' ? (AI.MODELS[d.gen.model] || { label: d.gen.model || 'KI' }).label : d.gen.mode === 'chat' ? 'Claude-Chat' : 'offline'} · ${dfDate.format(new Date(d.gen.at))}${d.gen.usd ? ` · ca. ${usd(d.gen.usd)}` : ''}</span>` : ''}
      </div>
      ${d.inkPages && !hasKey() ? '<p class="note">Seiten ohne Text kann nur die KI lesen. Alternativ: Bildkarten anlegen.</p>' : ''}
      <div class="btn-row">
        <button class="btn btn-primary" data-act="gen-doc" data-id="${d.id}">${icon('sparkle')} ${d.gen ? 'Neu erzeugen' : 'Karten erzeugen'}</button>
        ${decks.length ? `<button class="btn" data-act="open-deck" data-id="${decks[0].id}">${icon('cards')} Stapel</button>` : ''}
      </div>
    </div>
    <div class="jobs-box" data-doc="${d.id}">${jobsHtml(d.id)}</div>
    <div class="sec-h">${d.kind === 'text' ? 'Text' : 'Seiten'}<span class="muted">${d.kind !== 'text' ? 'antippen für Bildkarte oder Text' : ''}</span></div>
    <div id="pages" class="${d.kind === 'text' ? '' : 'page-grid'}"><div class="spinner"></div></div>
  `;
  fillPages(d);
}

async function fillPages(d) {
  const box = $('#pages');
  const rec = await Files.get(d.id);
  if (view !== 'doc' || params.id !== d.id) return;
  if (!rec || !rec.blob) {
    box.className = '';
    box.innerHTML = '<p class="note">Die Datei liegt nicht auf diesem Gerät (z. B. nach einem Backup ohne PDFs). Füge sie erneut hinzu — die App erkennt sie wieder und ordnet sie zu.</p>';
    return;
  }
  if (d.kind === 'text') {
    box.innerHTML = `<div class="card text-doc">${escBr((rec.pages || []).map((p) => p.text).join('\n\n').slice(0, 60000))}</div>`;
    return;
  }
  const pages = rec.pages || [{ n: 1, ink: true }];
  // Leeres 1×1-Bild als Platzhalter: ein <img> ohne src zeigt bis zum Laden ein kaputtes Bildsymbol
  const blankImg = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
  box.innerHTML = pages.map((p) => `<button class="pg-thumb" data-act="page" data-id="${d.id}" data-n="${p.n}" aria-label="Seite ${p.n}"><img alt="" src="${blankImg}" data-n="${p.n}"><span>${p.n}${p.ink ? ' · Handschrift' : ''}</span></button>`).join('');
  if (thumbObserver) thumbObserver.disconnect();
  thumbObserver = new IntersectionObserver((entries) => {
    for (const en of entries) {
      if (!en.isIntersecting) continue;
      const img = en.target;
      thumbObserver.unobserve(img);
      pageImage(d.id, +img.dataset.n, 300).then((u) => { img.src = u; }).catch(() => { img.closest('.pg-thumb').classList.add('err'); });
    }
  }, { rootMargin: '300px' });
  $$('.pg-thumb img', box).forEach((img) => thumbObserver.observe(img));
}

async function openPage(docId, n) {
  const d = docById(docId);
  const rec = await Files.get(docId);
  const pg = rec && rec.pages ? rec.pages.find((p) => p.n === n) : null;
  const deck = db.decks.find((k) => k.docIds.includes(docId));
  const cards = db.cards.filter((c) => c.docId === docId && (c.page === n || (c.occl && c.occl.page === n)));
  openSheet(`Seite ${n}`, `
    <div class="page-view"><img id="pvImg" alt="Seite ${n}"></div>
    <div class="btn-row">
      <button class="btn btn-primary" id="pvOccl">${icon('image')} Bildkarte</button>
      <button class="btn" id="pvText">${icon('notes')} Text</button>
    </div>
    <div id="pvTextBox" class="hidden"><div class="card text-doc">${pg && pg.text ? escBr(pg.text) : '<span class="muted">Kein maschinenlesbarer Text auf dieser Seite.</span>'}</div></div>
    ${cards.length ? `<div class="sec-h">Karten von dieser Seite</div><div class="rows">${cards.map((c) => `<button class="row" data-cid="${c.id}"><span class="grow clip2">${esc(frontPlain(c))}</span></button>`).join('')}</div>` : ''}
  `, null);
  $('#sheetCancel').textContent = 'Schließen';
  pageImage(docId, n, 1100).then((u) => { const i = $('#pvImg'); if (i) i.src = u; }).catch((e) => toast(e.message));
  $('#pvOccl').onclick = () => { closeSheet(); occlEditor(docId, n, deck ? deck.id : null); };
  $('#pvText').onclick = () => $('#pvTextBox').classList.toggle('hidden');
  $('#sheetBody').onclick = (e) => { const b = e.target.closest('[data-cid]'); if (b) editCard(b.dataset.cid, null, () => openPage(docId, n)); };
}

function docMenu(id) {
  const d = docById(id);
  menuSheet(d.name, [
    { label: 'Umbenennen', icon: 'edit', fn: () => askText('Dokument umbenennen', 'Name', { value: d.name }, (v) => { if (v.trim()) d.name = v.trim(); save(); closeSheet(); render(); }) },
    { label: 'Datei speichern', icon: 'download', fn: async () => {
      const rec = await Files.get(id);
      if (!rec || !rec.blob) { toast('Datei liegt nicht auf diesem Gerät'); return; }
      download(d.name + (d.kind === 'pdf' ? '.pdf' : d.kind === 'text' ? '.txt' : ''), rec.blob); closeSheet();
    } },
    { label: 'Dokument löschen', icon: 'trash', danger: true, sub: 'Karten bleiben im Stapel', fn: () => askSheet('Dokument löschen?', `„${d.name}“ wird vom Gerät entfernt. Erzeugte Karten bleiben erhalten, Bildkarten aus diesem Dokument zeigen danach kein Bild mehr.`, 'Löschen', async () => {
      await deleteDoc(id);
      save(); closeSheet(); toast('Gelöscht'); if (view === 'doc') goBack(); else render();
    }, () => docMenu(id), true) },
  ]);
}

/* ── Bildkarten ─────────────────────────────────────────────────
   Für Skizzen, Diagramme und handschriftliche Beschriftungen: Rechtecke
   über die Stellen ziehen, die man abgefragt werden will. Jedes Rechteck
   wird eine Karte; beim Lernen ist das gesuchte rot verdeckt, die anderen
   grau („alle verdecken, eins erraten“). Das Bild wird nicht kopiert, die
   Karte merkt sich nur Seite und Rechtecke — gezeichnet wird aus dem PDF. */
function occlPickPage(deckId) {
  const d = deckById(deckId);
  const docs = d.docIds.map(docById).filter((x) => x && x.kind !== 'text');
  if (!docs.length) { toast('Kein PDF oder Bild in diesem Stapel'); return; }
  if (docs.length === 1 && docs[0].pages === 1) { occlEditor(docs[0].id, 1, deckId); return; }
  if (docs.length === 1) { nav('doc', { id: docs[0].id }); toast('Seite antippen, dann „Bildkarte“'); return; }
  menuSheet('Aus welchem Dokument?', docs.map((x) => ({ label: x.name, icon: 'doc', sub: docSub(x), fn: () => { closeSheet(); nav('doc', { id: x.id }); toast('Seite antippen, dann „Bildkarte“'); } })));
}

async function occlEditor(docId, page, deckId) {
  const doc = docById(docId);
  const o = $('#overlay');
  o.innerHTML = `
    <div class="ov-head"><button class="link" id="ocCancel">Abbrechen</button><strong>Bildkarte · Seite ${page}</strong><button class="link strong" id="ocSave">Sichern</button></div>
    <div class="ov-tools">
      <input id="ocQ" value="Was ist hier verdeckt?" aria-label="Frage">
      <div class="btn-row">
        <button class="btn btn-sm" id="ocMode">${icon('edit')} Zeichnen</button>
        <button class="btn btn-sm" id="ocZoom">${icon('search')} 100 %</button>
        <button class="btn btn-sm" id="ocUndo">${icon('undo')}</button>
        <span class="grow"></span><span class="num" id="ocN">0 Felder</span>
      </div>
    </div>
    <div class="ov-scroll" id="ocScroll"><div class="oc-wrap draw" id="ocWrap"><img id="ocImg" alt=""><div class="spinner"></div></div></div>
    <p class="ov-hint">Ziehe Rechtecke über die Beschriftungen, die Du lernen willst. Antippen löscht ein Feld. Zum Verschieben auf „Zeichnen“ tippen.</p>`;
  o.classList.remove('hidden');
  document.body.classList.add('no-scroll');
  armBack();
  const rects = [];
  const wrap = $('#ocWrap');
  const img = $('#ocImg');
  try { img.src = await pageImage(docId, page, 1400); }
  catch (e) { closeOverlay(); toast(e.message); return; }
  const sp = wrap.querySelector('.spinner'); if (sp) sp.remove();

  const draw = () => {
    $$('.oc-r', wrap).forEach((x) => x.remove());
    rects.forEach((r, i) => wrap.insertAdjacentHTML('beforeend',
      `<div class="oc-r" data-i="${i}" style="left:${r[0] * 100}%;top:${r[1] * 100}%;width:${r[2] * 100}%;height:${r[3] * 100}%"><span>${i + 1}</span></div>`));
    $('#ocN').textContent = plural(rects.length, 'Feld', 'Felder');
  };
  let drawing = null;
  const pos = (e) => { const b = img.getBoundingClientRect(); return [Core.clamp((e.clientX - b.left) / b.width, 0, 1), Core.clamp((e.clientY - b.top) / b.height, 0, 1)]; };
  wrap.onpointerdown = (e) => {
    if (!wrap.classList.contains('draw')) return;
    const hit = e.target.closest('.oc-r');
    if (hit) { rects.splice(+hit.dataset.i, 1); draw(); return; }
    e.preventDefault();
    wrap.setPointerCapture(e.pointerId);
    const p = pos(e);
    drawing = { p, el: document.createElement('div') };
    drawing.el.className = 'oc-r live';
    wrap.appendChild(drawing.el);
  };
  wrap.onpointermove = (e) => {
    if (!drawing) return;
    const p = pos(e);
    const x = Math.min(p[0], drawing.p[0]), y = Math.min(p[1], drawing.p[1]);
    const w = Math.abs(p[0] - drawing.p[0]), h = Math.abs(p[1] - drawing.p[1]);
    Object.assign(drawing.el.style, { left: x * 100 + '%', top: y * 100 + '%', width: w * 100 + '%', height: h * 100 + '%' });
    drawing.r = [x, y, w, h];
  };
  const endDraw = () => {
    if (!drawing) return;
    const r = drawing.r;
    drawing.el.remove();
    drawing = null;
    if (r && r[2] > 0.012 && r[3] > 0.006) rects.push(r.map((v) => Math.round(v * 10000) / 10000));
    draw();
  };
  wrap.onpointerup = endDraw;
  wrap.onpointercancel = endDraw;
  let zoom = 1;
  $('#ocZoom').onclick = () => {
    zoom = zoom === 1 ? 1.6 : zoom === 1.6 ? 2.4 : 1;
    wrap.style.width = zoom * 100 + '%';
    $('#ocZoom').innerHTML = `${icon('search')} ${Math.round(zoom * 100)} %`;
  };
  $('#ocMode').onclick = () => {
    const on = wrap.classList.toggle('draw');
    $('#ocMode').innerHTML = on ? `${icon('edit')} Zeichnen` : `${icon('shuffle')} Verschieben`;
  };
  $('#ocUndo').onclick = () => { rects.pop(); draw(); };
  $('#ocCancel').onclick = () => { closeOverlay(); render(); };
  $('#ocSave').onclick = () => {
    if (!rects.length) { toast('Erst ein Feld aufziehen'); return; }
    const q = $('#ocQ').value.trim() || 'Was ist hier verdeckt?';
    if (!deckId || !deckById(deckId)) {
      // Dokument ohne Stapel: erst jetzt einen anlegen — beim Abbrechen bleibt nichts Leeres zurück
      const deck = { id: uid(), name: doc.name, subjectId: doc.subjectId, docIds: [docId], created: Date.now(), examDate: null, newPerDay: null };
      db.decks.push(deck);
      deckId = deck.id;
    }
    let ord = cardsOf(deckId).reduce((m, c) => Math.max(m, c.ord || 0), 0);
    rects.forEach((r, i) => db.cards.push({ id: uid(), deckId, docId, kind: 'occl', front: q, back: '', hint: '', page,
      occl: { page, rects: rects.slice(), i }, ord: ++ord, created: Date.now(), s: Core.newState() }));
    const dk = deckById(deckId);
    if (dk && !dk.docIds.includes(docId)) dk.docIds.push(docId);
    db.setup = true;
    save();
    closeOverlay();
    toast(`${plural(rects.length, 'Bildkarte', 'Bildkarten')} angelegt`);
    render();
  };
}

/** Ausschnitt einer Bildkarte zeichnen: Bereich um alle Felder, das
    gesuchte rot (oder beim Aufdecken umrandet), die anderen grau. */
async function occlPreview(el, card, reveal) {
  if (!el || !card.occl) return;
  el.innerHTML = '<div class="spinner"></div>';
  let src;
  try { src = await renderPage(card.docId, card.occl.page, 1400); }
  catch (e) { el.innerHTML = `<p class="muted">${esc(e.message)}</p>`; return; }
  const rs = card.occl.rects;
  let x0 = Math.min(...rs.map((r) => r[0])), y0 = Math.min(...rs.map((r) => r[1]));
  let x1 = Math.max(...rs.map((r) => r[0] + r[2])), y1 = Math.max(...rs.map((r) => r[1] + r[3]));
  // Seitlich großzügiger als oben/unten: Beschriftungen stehen meist neben dem, was sie benennen
  const mx = 0.22, my = 0.1;
  x0 = Math.max(0, x0 - mx); y0 = Math.max(0, y0 - my); x1 = Math.min(1, x1 + mx); y1 = Math.min(1, y1 + my);
  if (y1 - y0 < 0.22) { const c = (y0 + y1) / 2; y0 = Math.max(0, c - 0.11); y1 = Math.min(1, c + 0.11); }
  const W = src.width, H = src.height;
  const cw = Math.round((x1 - x0) * W), ch = Math.round((y1 - y0) * H);
  const c = document.createElement('canvas');
  c.width = cw; c.height = ch;
  const ctx = c.getContext('2d');
  ctx.drawImage(src, x0 * W, y0 * H, cw, ch, 0, 0, cw, ch);
  // Farben aus dem Theme, damit es in Hell und Dunkel passt
  const css = getComputedStyle(document.documentElement);
  const accent = css.getPropertyValue('--occl-target').trim() || '#e5484d';
  const other = css.getPropertyValue('--occl-other').trim() || '#8a94a6';
  rs.forEach((r, i) => {
    const x = (r[0] - x0) * W, y = (r[1] - y0) * H, w = r[2] * W, h = r[3] * H;
    if (i === card.occl.i) {
      if (reveal) { ctx.lineWidth = Math.max(3, W / 300); ctx.strokeStyle = accent; ctx.strokeRect(x, y, w, h); }
      else {
        ctx.fillStyle = accent; ctx.fillRect(x, y, w, h);
        ctx.fillStyle = '#ffffff'; ctx.font = `bold ${Math.max(14, Math.min(h * 0.7, 48))}px sans-serif`;
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText('?', x + w / 2, y + h / 2);
      }
    } else { ctx.fillStyle = other; ctx.fillRect(x, y, w, h); }
  });
  el.innerHTML = '';
  c.className = 'occl-canvas';
  el.appendChild(c);
}

/** Fundstelle einer Karte zeigen. */
async function cardSource(id) {
  const c = db.cards.find((x) => x.id === id);
  if (!c || !c.docId) return;
  const d = docById(c.docId);
  if (!d) { toast('Quelle wurde gelöscht'); return; }
  if (d.kind === 'text' || !c.page) {
    const rec = await Files.get(d.id);
    const pg = rec && rec.pages ? rec.pages.find((p) => p.n === (c.page || 1)) : null;
    openSheet(d.name, `<div class="card text-doc">${pg ? escBr(pg.text) : '<span class="muted">Kein Text</span>'}</div>`, null);
    $('#sheetCancel').textContent = 'Schließen';
    return;
  }
  openSheet(`${d.name} · Seite ${c.page}`, `<div class="page-view"><img id="csImg" alt=""></div>`, null);
  $('#sheetCancel').textContent = 'Schließen';
  pageImage(d.id, c.page, 1100).then((u) => { const i = $('#csImg'); if (i) i.src = u; }).catch((e) => toast(e.message));
}

/* ── 13. Tutor, Feynman, Erklären ───────────────────────────── */
let tutorBusy = false;
let tutorCtrl = null;

function renderChat() {
  const el = $('#view-chat');
  const d = deckById(params.id);
  if (!d) { goBack(); return; }
  setTitle('Tutor · ' + d.name);
  const hist = db.chats[d.id] || [];
  $('#topActions').innerHTML = hist.length ? `<button class="icon-btn" data-act="chat-clear" data-id="${d.id}" aria-label="Gespräch löschen">${icon('trash')}</button>` : '';
  if (!hasKey()) {
    el.innerHTML = `<div class="empty">${icon('chat')}<h2>Der Tutor braucht KI</h2>
      <p>Mit Deinem Anthropic-Schlüssel beantwortet Claude Fragen zu genau diesem Stoff, erklärt einfacher und fragt Dich ab.</p>
      <button class="btn btn-primary" data-act="key">${icon('key')} Schlüssel einrichten</button>
      <p class="note" style="margin-top:20px">Ohne Schlüssel: Material und Tutor-Auftrag kopieren und in die Claude-App einfügen.</p>
      <button class="btn" data-act="chat-copy" data-id="${d.id}">${icon('copy')} Für Claude-Chat kopieren</button></div>`;
    return;
  }
  const quick = ['Erklär mir das Thema so einfach wie möglich', 'Was kommt wahrscheinlich in der Klausur dran?', 'Frag mich ab — eine Frage nach der anderen', 'Gib mir ein Beispiel aus dem Alltag', 'Welche Eselsbrücken helfen hier?', 'Was verwechselt man hier leicht?'];
  el.innerHTML = `
    <div class="chat" id="chatList">
      ${!hist.length ? `<div class="chat-intro">${icon('chat')}<p>Frag mich alles zu „${esc(d.name)}“. Ich kenne Dein Material.</p></div>` : ''}
      ${hist.map((m, i) => `<div class="msg ${m.role}${m.err ? ' err' : ''}" data-i="${i}">${m.role === 'assistant' ? (m.text ? `<div class="md">${Core.md(m.text, esc)}</div>` : '<div class="spinner"></div>') : escBr(m.text)}</div>`).join('')}
    </div>
    <div class="chips quick">${quick.map((q) => `<button class="chip" data-act="chat-quick">${esc(q)}</button>`).join('')}</div>
    <div class="chat-bar">
      <textarea id="chatIn" rows="1" placeholder="Frage stellen …"></textarea>
      ${tutorBusy ? `<button class="icon-btn send" data-act="chat-stop" aria-label="Stopp">${icon('x')}</button>` : `<button class="icon-btn send" data-act="chat-send" aria-label="Senden">${icon('play')}</button>`}
    </div>`;
  const inp = $('#chatIn');
  inp.oninput = () => { inp.style.height = 'auto'; inp.style.height = Math.min(140, inp.scrollHeight) + 'px'; };
  inp.onkeydown = (e) => { if (e.key === 'Enter' && !e.shiftKey && !('ontouchstart' in window)) { e.preventDefault(); sendChat(inp.value); } };
  window.scrollTo(0, document.body.scrollHeight);
}

async function sendChat(text) {
  text = String(text || '').trim();
  const d = deckById(params.id);
  if (!text || !d || tutorBusy) return;
  const hist = db.chats[d.id] = db.chats[d.id] || [];
  hist.push({ role: 'user', text });
  const ans = { role: 'assistant', text: '' };
  hist.push(ans);
  tutorBusy = true;
  tutorCtrl = new AbortController();
  renderChat();
  try {
    const mat = await materialFor(d);
    // Nur die letzten 20 Nachrichten mitschicken; die Antwort im Aufbau nicht
    const send = hist.slice(0, -1).filter((m) => !m.err && m.text).slice(-20);
    if (send[0] && send[0].role !== 'user') send.shift();
    let last = 0;
    const res = await AI.tutor({ key: getKey(), model: db.settings.model, signal: tutorCtrl.signal,
      onText: (t) => {
        ans.text = t;
        const now = Date.now();
        if (now - last < 120) return;      // nicht bei jedem Wortschnipsel neu zeichnen
        last = now;
        const node = $(`.msg[data-i="${hist.length - 1}"]`);
        if (node) { node.innerHTML = `<div class="md">${Core.md(t, esc)}</div>`; window.scrollTo(0, document.body.scrollHeight); }
      } }, mat, send);
    ans.text = res.text;
    db.settings.usd += res.cost;
  } catch (e) {
    ans.text = e.code === 'abort' ? (ans.text || '(abgebrochen)') : '⚠ ' + e.message;
    if (e.code !== 'abort') ans.err = true;
  }
  tutorBusy = false;
  tutorCtrl = null;
  if (hist.length > 60) hist.splice(0, hist.length - 60);
  save();
  if (view === 'chat') renderChat();
}

async function chatCopy(deckId) {
  const d = deckById(deckId);
  busy('Material wird zusammengestellt …');
  const mat = await materialFor(d);
  busy(null);
  const txt = `Du bist mein Nachhilfelehrer. Unten ist mein Unterrichtsmaterial zu „${d.name}“. Beantworte meine Fragen dazu knapp und anschaulich, frag nach, wenn ich etwas falsch verstehe, und frag mich auf Wunsch ab.\n\n<material>\n${mat.text || '(Bitte das PDF anhängen)'}\n</material>\n\nMeine erste Frage: `;
  toast((await copyText(txt)) ? 'Kopiert — in Claude einfügen und Frage ergänzen' : 'Kopieren ging nicht');
}

/* ── Feynman ── */
let F = null;

function startFeynman(ids) {
  const pool = [];
  const seen = new Set();
  const add = (term, ref, page) => { const k = Core.dedupeKey(term); if (term && ref && !seen.has(k) && term.length <= 80) { seen.add(k); pool.push({ term, ref, page }); } };
  glossaryOf(ids).forEach((g) => add(g.term, g.def, g.page));
  cardsOf(ids).filter((c) => c.kind === 'basic' && !c.susp && c.back.length > 15).forEach((c) => add(c.front, c.back, c.page));
  if (!pool.length) { toast('Keine Begriffe mit Erklärung gefunden'); return; }
  F = { ids, pool: Core.shuffle(pool), i: 0, answer: '', result: null, busy: false };
  nav('feynman', { ids });
}

function renderFeynman() {
  const el = $('#view-feynman');
  if (!F) { goBack(); return; }
  const it = F.pool[F.i % F.pool.length];
  const r = F.result;
  el.innerHTML = `
    <div class="flash quiz-card">
      <div class="q-kind">Erkläre in eigenen Worten</div>
      <div class="q big">${esc(it.term)}</div>
      <p class="muted small">So, dass es ein jüngerer Mitschüler versteht — ohne Fachwörter, die Du nicht selbst erklärst.</p>
    </div>
    ${!r ? `
      <textarea id="fyIn" class="answer-in" rows="7" placeholder="Was ist das, wozu gehört es, wie funktioniert es, ein Beispiel …">${esc(F.answer)}</textarea>
      <div class="btn-row"><button class="btn" data-act="fy-skip">Überspringen</button><button class="btn btn-primary" data-act="fy-check"${F.busy ? ' disabled' : ''}>${F.busy ? '<div class="spinner"></div> Claude prüft …' : 'Prüfen'}</button></div>`
    : `
      <div class="score-bar"><i style="width:${r.score}%" class="${r.score >= 75 ? 'ok' : r.score >= 40 ? 'mid' : 'bad'}"></i><span class="num">${r.score} %</span></div>
      <div class="verdict v-${r.verdict === 'right' ? 'right' : r.verdict === 'wrong' ? 'wrong' : 'close'}">${icon('bulb')}<div class="grow">
        <strong>${{ right: 'Verstanden!', partial: 'Teilweise', wrong: 'Da fehlt noch was' }[r.verdict]}</strong>
        ${r.feedback ? `<span>${esc(r.feedback)}</span>` : ''}
        ${r.missing && r.missing.length ? `<span>Fehlt: ${esc(r.missing.join(', '))}</span>` : ''}</div></div>
      <div class="model-answer"><div class="ma-h">Aus Deinem Material${it.page ? ` (S. ${it.page})` : ''}</div>${fmtCard(it.ref)}</div>
      <div class="your-answer"><div class="ma-h">Deine Erklärung</div>${escBr(F.answer)}</div>
      <button class="btn btn-primary btn-block btn-lg" data-act="fy-next">Nächster Begriff</button>`}
  `;
  const inp = $('#fyIn');
  if (inp) inp.oninput = () => { F.answer = inp.value; };
}

async function checkFeynman() {
  const it = F.pool[F.i % F.pool.length];
  if (!F.answer.trim()) { toast('Erst etwas schreiben'); return; }
  if (hasKey()) {
    F.busy = true; renderFeynman();
    try {
      const r = await AI.gradeAnswer({ key: getKey(), model: db.settings.model }, { feynman: true, term: it.term, reference: it.ref, answer: F.answer });
      F.result = r; db.settings.usd += r.cost;
    } catch (e) { toast(e.message, 4000); F.result = offlineFeynman(it); }
    F.busy = false;
  } else F.result = offlineFeynman(it);
  const rec = dayRec(); rec.q++; if (F.result.verdict === 'right') rec.qok++;
  save();
  renderFeynman();
}

function offlineFeynman(it) {
  const r = Core.checkAnswer(F.answer, it.ref);
  return { score: Math.round(r.score * 100), verdict: r.verdict === 'close' ? 'partial' : r.verdict,
    feedback: 'Ohne KI vergleicht die App nur die wichtigen Wörter mit Deinem Material. Lies die Erklärung unten und prüfe selbst, ob Du das Gleiche gemeint hast.',
    missing: r.missing.slice(0, 8) };
}

/* ── Karte erklären lassen ── */
async function explainCard(id) {
  const c = db.cards.find((x) => x.id === id);
  if (!c) return;
  if (!hasKey()) { openKeySheet(); return; }
  S.explain = '…';
  renderStudy();
  try {
    let ctx = '';
    if (c.docId) {
      const rec = await Files.get(c.docId);
      if (rec && rec.pages) {
        const ps = rec.pages.filter((p) => !c.page || Math.abs(p.n - c.page) <= 1);
        ctx = ps.map((p) => p.text).join('\n\n');
      }
    }
    const res = await AI.explainCard({ key: getKey(), model: db.settings.model,
      onText: (t) => { if (S && S.cur === id) { S.explain = t; const n = $('.explain'); if (n) n.innerHTML = Core.md(t, esc); } } }, c, ctx);
    db.settings.usd += res.cost;
    save();
    if (S && S.cur === id) { S.explain = res.text; renderStudy(); }
  } catch (e) {
    if (S && S.cur === id) { S.explain = '⚠ ' + e.message; renderStudy(); }
  }
}

/* ── 14. Einstellungen, Backup, Updates, Installieren ───────── */

function openKeySheet(after) {
  const cur = getKey();
  openSheet('KI einrichten', `
    <p class="dlg-t">Die App nutzt Claude über Deinen eigenen API-Schlüssel von Anthropic. Er bleibt auf diesem Gerät und landet nicht im Backup. Dein Material geht nur an Anthropic, sonst nirgendwohin.</p>
    <ol class="steps small">
      <li>Auf <strong>console.anthropic.com</strong> anmelden (eigenes Konto, Guthaben aufladen — ab 5 $).</li>
      <li>Links „API Keys“ → „Create Key“, Schlüssel kopieren.</li>
      <li>Hier einfügen.</li>
    </ol>
    <label>API-Schlüssel<div class="pw"><input id="keyIn" type="password" autocomplete="off" spellcheck="false" placeholder="sk-ant-…" value="${esc(cur)}"><button class="btn btn-sm" id="keyShow">${icon('eye')}</button></div></label>
    <p class="note">Richtwert: 10 Seiten Mitschrift kosten mit Opus 5 etwa 0,30–0,50 $, mit Sonnet 5 etwa 0,15 $. Die App zeigt die Kosten je Dokument an.</p>
    ${cur ? `<button class="btn btn-ghost btn-block danger-text" id="keyDel">${icon('trash')} Schlüssel entfernen</button>` : ''}
  `, async () => {
    const k = $('#keyIn').value.trim();
    if (!k) { setKey(''); closeSheet(); render(); return; }
    if (!/^sk-ant-/.test(k)) { toast('Ein Anthropic-Schlüssel beginnt mit „sk-ant-“'); return; }
    $('#sheetSave').textContent = 'Prüfe …';
    try {
      await AI.testKey(k);
      setKey(k);
      closeSheet();
      toast('Schlüssel funktioniert — KI ist an');
    } catch (e) {
      if (e.code === 'net') {
        // Offline oder vom Netz blockiert: trotzdem speichern, beim ersten Einsatz zeigt sich's
        setKey(k); closeSheet(); toast('Gespeichert — prüfen ging gerade nicht (offline?)', 4000);
      } else { $('#sheetSave').textContent = 'Prüfen & sichern'; toast(e.message, 5000); return; }
    }
    render();
    if (after) after();
  }, 'Prüfen & sichern');
  $('#keyShow').onclick = () => { const i = $('#keyIn'); i.type = i.type === 'password' ? 'text' : 'password'; };
  if ($('#keyDel')) $('#keyDel').onclick = () => { setKey(''); closeSheet(); render(); toast('Schlüssel entfernt'); };
}

async function openSettings() {
  const st = db.settings;
  const key = getKey();
  let used = '';
  try {
    if (navigator.storage && navigator.storage.estimate) {
      const e = await navigator.storage.estimate();
      used = `${bytesFmt(e.usage || 0)} belegt`;
    }
  } catch (e) { /* egal */ }
  openSheet('Einstellungen', `
    <div class="sec-h">KI (Claude)</div>
    <div class="rows">
      <button class="row" id="stKey">${icon('key')}<span class="grow"><span>API-Schlüssel</span><span class="sub">${key ? 'hinterlegt · …' + esc(key.slice(-4)) : 'nicht eingerichtet — KI aus'}</span></span>${icon('chevron', 'chev')}</button>
    </div>
    <label style="margin-top:12px">Modell<select id="stModel">${Object.entries(AI.MODELS).map(([id, m]) => `<option value="${id}"${st.model === id ? ' selected' : ''}>${esc(m.label)} — ${esc(m.note)}</option>`).join('')}</select></label>
    <label>Gründlichkeit<div class="seg" id="stEffort"><button data-v="medium" class="${st.effort === 'medium' ? 'on' : ''}">Schneller</button><button data-v="high" class="${st.effort === 'high' ? 'on' : ''}">Gründlich</button></div></label>
    <label>An Claude senden<div class="seg" id="stSend"><button data-v="auto" class="${st.send === 'auto' ? 'on' : ''}">Automatisch</button><button data-v="text" class="${st.send === 'text' ? 'on' : ''}">Nur Text</button><button data-v="pdf" class="${st.send === 'pdf' ? 'on' : ''}">Ganzes PDF</button></div></label>
    <p class="note">Automatisch: Ist alles gedruckter Text, geht nur der Text raus (günstig). Sobald Handschrift oder Bilder dabei sind, das PDF selbst, damit Claude es sehen kann.</p>
    <div class="rows" style="margin-top:12px">
      <div class="row"><span class="grow"><span>Nach dem Hinzufügen gleich erzeugen</span></span><button class="switch" id="stAuto" role="switch" aria-checked="${st.autoGen}"></button></div>
      <div class="row"><span class="grow"><span>KI-Kosten bisher (geschätzt)</span><span class="sub">abgerechnet wird bei Anthropic</span></span><span class="num">${usd(st.usd || 0)}</span></div>
    </div>

    <div class="sec-h">Lernen</div>
    <label>Neue Karten pro Tag und Stapel<input id="stNew" type="number" inputmode="numeric" step="1" min="0" max="500" value="${st.newPerDay}"></label>
    <p class="note">Mit Prüfungstermin erhöht die App das automatisch, damit bis dahin alles einmal drankommt.</p>

    <div class="sec-h">Darstellung</div>
    <div class="seg" id="stTheme">${Object.entries(THEMES).map(([k, t]) => `<button data-v="${k}" class="${db.theme === k ? 'on' : ''}">${t.label}</button>`).join('')}</div>

    <div class="sec-h">Daten</div>
    <p class="note warn-note">${icon('download', 'inl')} Alles liegt nur auf diesem Gerät. „Browserdaten löschen“ löscht auch Deine Karten — sichere regelmäßig.${db.lastBackup ? ` Letzte Sicherung: ${dfDate.format(new Date(db.lastBackup))}.` : ' Noch keine Sicherung.'}</p>
    <div class="rows">
      <button class="row" id="stBackup">${icon('download')}<span class="grow"><span>Backup speichern</span><span class="sub">Karten, Lernstand, Statistik${used ? ' · ' + used : ''}</span></span></button>
      <button class="row" id="stRestore">${icon('upload')}<span class="grow"><span>Backup laden</span><span class="sub">ersetzt die jetzigen Daten</span></span></button>
      <button class="row" id="stImportDeck">${icon('layers')}<span class="grow"><span>Stapel importieren</span><span class="sub">JSON von Freunden, aus Claude oder exportiert</span></span></button>
      <button class="row danger-text" id="stWipe">${icon('trash')}<span class="grow"><span>Alles löschen</span></span></button>
    </div>
    <input type="file" id="stFile" class="hidden" accept="application/json,.json">
    <input type="file" id="stDeckFile" class="hidden" accept="application/json,.json,.txt">

    <div class="sec-h">App</div>
    <button class="btn btn-block hidden" id="btnInstall">${icon('download')} App installieren</button>
    <button class="btn btn-block" id="stUpdate" style="margin-top:8px">Nach Update suchen</button>
    <p class="note center">Lernapp ${APP_VERSION} · PDF-Darstellung mit PDF.js (Mozilla, Apache-2.0), lokal mitgeliefert</p>
  `, null);
  $('#sheetCancel').textContent = 'Fertig';
  $('#stKey').onclick = () => openKeySheet(openSettings);
  $('#stModel').onchange = (e) => { st.model = e.target.value; save(); };
  const seg = (sel, fn) => { $(sel).onclick = (e) => { const b = e.target.closest('[data-v]'); if (!b) return; $$(sel + ' button').forEach((x) => x.classList.toggle('on', x === b)); fn(b.dataset.v); save(); }; };
  seg('#stEffort', (v) => { st.effort = v; });
  seg('#stSend', (v) => { st.send = v; });
  seg('#stTheme', (v) => { applyTheme(v); render(); });
  $('#stAuto').onclick = (e) => { st.autoGen = !st.autoGen; e.currentTarget.setAttribute('aria-checked', st.autoGen); save(); };
  $('#stNew').onchange = (e) => { st.newPerDay = Core.clamp(Math.round(num(e.target.value)), 0, 500); e.target.value = st.newPerDay; save(); render(); };
  $('#stBackup').onclick = backupSheet;
  $('#stRestore').onclick = () => $('#stFile').click();
  $('#stFile').onchange = (e) => importBackup(e.target.files[0]);
  $('#stImportDeck').onclick = () => $('#stDeckFile').click();
  $('#stDeckFile').onchange = (e) => importDeckFile(e.target.files[0]);
  $('#stWipe').onclick = () => askSheet('Alles löschen?', 'Alle Stapel, Karten, Dokumente und der Lernstand werden von diesem Gerät entfernt. Der API-Schlüssel bleibt.', 'Endgültig löschen', async () => {
    db = blank(); applyTheme(db.theme); await Files.clear(); pageImgCache.clear(); thumbCache.clear(); save(); closeSheet(); nav('home'); toast('Alles gelöscht');
  }, openSettings, true);
  $('#stUpdate').onclick = checkUpdate;
  $('#btnInstall').onclick = installApp;
  syncInstall();
}

async function backupSheet() {
  const recs = await Files.all();
  const size = recs.reduce((a, r) => a + (r.blob ? r.blob.size : 0), 0);
  openSheet('Backup speichern', `
    <p class="dlg-t">Das Backup enthält alle Stapel, Karten, Quizfragen, Lernstand und Statistik als eine JSON-Datei. Der API-Schlüssel ist nicht dabei.</p>
    <div class="rows"><div class="row"><span class="grow"><span>PDFs und Bilder mitsichern</span><span class="sub">${recs.length ? `${plural(recs.length, 'Datei', 'Dateien')}, ${bytesFmt(size)}` : 'keine Dateien'} — ohne sie fehlen Seitenansicht und Bildkarten</span></span>
      <button class="switch" id="bkFiles" role="switch" aria-checked="${size < 60e6}"></button></div></div>
  `, async () => {
    const withFiles = $('#bkFiles').getAttribute('aria-checked') === 'true';
    closeSheet();
    await exportBackup(withFiles);
  }, 'Speichern');
  $('#sheetCancel').onclick = openSettings;
  $('#bkFiles').onclick = (e) => e.currentTarget.setAttribute('aria-checked', e.currentTarget.getAttribute('aria-checked') !== 'true');
}

async function exportBackup(withFiles) {
  busy('Backup wird erstellt …');
  try {
    db.lastBackup = new Date().toISOString();
    save();
    const recs = await Files.all();
    const files = [];
    for (const r of recs) {
      // Seitentext immer, die Datei selbst nur auf Wunsch
      files.push({ id: r.id, name: r.name, type: r.type, pages: r.pages, data: withFiles && r.blob ? await blobToBase64(r.blob) : null });
    }
    /* Der gesamte Datensatz wandert unverändert in die Datei. `meta` und
       `files` stehen daneben und werden beim Import wieder entfernt (siehe
       normalize), damit sie nicht in die Daten wandern. */
    const payload = Object.assign({
      meta: { app: 'Lernapp', appVersion: APP_VERSION, format: db.v, exported: db.lastBackup, withFiles },
    }, db, { files });
    const blob = new Blob([JSON.stringify(payload)], { type: 'application/json' });
    download(`lernapp-${new Date().toISOString().slice(0, 10)}.json`, blob);
    toast(`Backup gespeichert (${bytesFmt(blob.size)})`);
  } catch (e) { infoSheet('Backup fehlgeschlagen', e.message); }
  busy(null);
}

function importBackup(file) {
  if (!file) return;
  const r = new FileReader();
  r.onload = () => {
    try {
      const d = JSON.parse(r.result);
      if (d && d.meta && d.meta.kind === 'deck') { importDeckObj(d); return; }
      if (!d || !Array.isArray(d.decks) || !Array.isArray(d.cards)) throw new Error('Die Datei ist kein Backup dieser App.');
      const stand = d.meta && d.meta.exported ? ` vom ${dfDate.format(new Date(d.meta.exported))}` : '';
      askSheet('Backup laden',
        `Das Backup${stand} enthält ${plural(d.decks.length, 'Stapel', 'Stapel')} mit ${plural(d.cards.length, 'Karte', 'Karten')}. `
        + 'Deine jetzigen Daten werden dabei ersetzt.',
        'Laden', async () => {
          busy('Backup wird geladen …');
          // normalize() ergänzt, was in einem älteren Backup fehlt, und wirft
          // die Kopfzeile `meta` und die Dateien weg — die kommen hierher:
          const files = Array.isArray(d.files) ? d.files : [];
          db = normalize(d);
          for (const f of files) {
            const old = await Files.get(f.id);
            let blob = old && old.blob;
            if (f.data) {
              const bin = atob(f.data);
              const u8 = new Uint8Array(bin.length);
              for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
              blob = new Blob([u8], { type: f.type || 'application/octet-stream' });
            }
            await Files.put({ id: f.id, name: f.name, type: f.type, blob: blob || null, pages: f.pages || (old && old.pages) || [] });
          }
          applyTheme(db.theme);
          save(); busy(null); closeSheet(); pageImgCache.clear(); thumbCache.clear(); nav('home'); toast('Backup geladen');
        }, openSettings);
    } catch (e) { infoSheet('Import fehlgeschlagen', e.message, openSettings); }
  };
  r.readAsText(file);
}

/* ── Stapel teilen ──────────────────────────────────────────────
   Export ohne Lernstand, damit eine Freundin mit frischen Karten startet.
   Das Format ist dasselbe, das auch die KI liefert — so lässt sich auch
   JSON aus einem Claude-Chat oder von Claude Code direkt importieren. */
function exportDeck(d) {
  const docs = d.docIds.map(docById).filter(Boolean);
  const subj = subjectById(d.subjectId);
  const payload = {
    meta: { app: 'Lernapp', kind: 'deck', appVersion: APP_VERSION, exported: new Date().toISOString() },
    title: d.name, subject: subj ? subj.name : '',
    summary: docs.map((x) => x.summary).filter(Boolean).join('\n\n'),
    keyPoints: [].concat(...docs.map((x) => x.keyPoints)),
    glossary: [].concat(...docs.map((x) => x.glossary)).map((g) => ({ term: g.term, definition: g.def, page: g.page || 0 })),
    cards: cardsOf(d.id).filter((c) => c.kind !== 'occl').sort((a, b) => a.ord - b.ord).map((c) => ({ front: c.front, back: c.back, hint: c.hint, page: c.page || 0 })),
    questions: questionsOf(d.id).map((q) => ({ type: q.kind, question: q.q, options: q.options, correct: q.correct, answer: q.answer, explanation: q.explain, page: q.page || 0 })),
  };
  download(`${d.name.replace(/[^\p{L}\p{N} _-]+/gu, '').trim() || 'stapel'}.json`, new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }));
  toast('Stapel exportiert');
}

/** Für Anki („Notizen aus Text importieren“) und Quizlet: Tab-getrennt. */
function exportCsv(d) {
  const clean = (s) => String(s || '').replace(/\t/g, ' ').replace(/\r?\n/g, '<br>');
  const lines = cardsOf(d.id).filter((c) => c.kind !== 'occl').sort((a, b) => a.ord - b.ord).map((c) => {
    if (c.kind === 'cloze') return clean(c.front.replace(/\{\{(?:c\d+::)?/g, '{{c1::')) + '\t' + clean(c.back);
    return clean(c.front) + '\t' + clean(c.back);
  });
  download(`${d.name.replace(/[^\p{L}\p{N} _-]+/gu, '').trim() || 'stapel'}.txt`, new Blob([lines.join('\n')], { type: 'text/plain' }));
  toast('Exportiert — in Anki: Datei → Importieren');
}

function importDeckFile(file) {
  if (!file) return;
  const r = new FileReader();
  r.onload = () => {
    try { importDeckObj(Core.parseLooseJSON(r.result)); }
    catch (e) { infoSheet('Import fehlgeschlagen', e.message, openSettings); }
  };
  r.readAsText(file);
}

function importDeckObj(o) {
  if (o && Array.isArray(o.decks) && Array.isArray(o.cards) && !o.title) { toast('Das ist ein Backup — bitte „Backup laden“ nehmen'); return; }
  const res = Core.normalizeGen(o);
  if (!res.cards.length && !res.questions.length) { infoSheet('Import fehlgeschlagen', 'In der Datei stehen keine Karten.', openSettings); return; }
  // Als Pseudo-Dokument ablegen, damit Lernzettel und Glossar einen Platz haben
  const doc = { id: uid(), name: res.title || 'Importierter Stapel', kind: 'text', mime: 'text/plain', added: Date.now(), bytes: 0, hash: null,
    pages: 0, inkPages: 0, chars: 0, subjectId: null, status: 'ready', gen: null, summary: '', keyPoints: [], glossary: [], imported: true };
  db.docs.push(doc);
  const deck = applyResult(doc, res, { mode: 'import' });
  closeSheet();
  toast(`„${deck.name}“ importiert: ${plural(res.cards.length, 'Karte', 'Karten')}`);
  nav('deck', { id: deck.id });
}

/* ── Beispielstapel ─────────────────────────────────────────────
   Damit man ohne eigenes PDF sofort sieht, was die App kann. */
const DEMO = {
  title: 'Photosynthese (Beispiel)', subject: 'Biologie',
  text: 'Photosynthese — Biologie Q1\n\nUnter Photosynthese versteht man die Umwandlung von Lichtenergie in chemische Energie. Pflanzen stellen dabei aus Kohlenstoffdioxid und Wasser Glucose und Sauerstoff her. Sie findet in den Chloroplasten statt.\n\nBruttogleichung: 6 CO₂ + 6 H₂O → C₆H₁₂O₆ + 6 O₂\n\nDie lichtabhängige Reaktion läuft an der Thylakoidmembran ab. Dort wird Wasser gespalten (Photolyse); es entstehen Sauerstoff, ATP und NADPH.\n\nIm Calvin-Zyklus (Stroma) wird mithilfe von ATP und NADPH Kohlenstoffdioxid zu Glucose fixiert. Schlüsselenzym ist RuBisCO.\n\nFaktoren: Lichtintensität, CO₂-Konzentration, Temperatur, Wasser. Der Faktor im Minimum begrenzt die Rate (Gesetz des Minimums).',
  summary: '## Worum es geht\n- **Photosynthese**: Lichtenergie → chemische Energie (Glucose)\n- Ort: **Chloroplasten** (grüner Farbstoff **Chlorophyll**)\n- Bruttogleichung: 6 CO₂ + 6 H₂O → C₆H₁₂O₆ + 6 O₂\n\n## Zwei Teilreaktionen\n| | Lichtabhängig | Calvin-Zyklus |\n|---|---|---|\n| Ort | Thylakoidmembran | Stroma |\n| braucht | Licht, Wasser | ATP, NADPH, CO₂ |\n| liefert | O₂, ATP, NADPH | Glucose |\n\n## Typische Fehler\n- Der Sauerstoff stammt aus dem **Wasser**, nicht aus dem CO₂.\n- Der Calvin-Zyklus heißt „lichtunabhängig“, läuft aber trotzdem meist am Tag.\n\n## Das kommt oft dran\n- Gesetz des Minimums an einem Diagramm erklären\n- Teilreaktionen vergleichen',
  keyPoints: ['Pflanzen wandeln Lichtenergie in chemisch gebundene Energie (Glucose) um.', 'Die Lichtreaktion liefert ATP und NADPH für den Calvin-Zyklus.', 'Der freigesetzte Sauerstoff stammt aus der Spaltung von Wasser.', 'Der Faktor im Minimum begrenzt die Photosyntheserate.'],
  glossary: [
    { term: 'Chloroplast', definition: 'Zellorganell der Pflanzenzelle, in dem die Photosynthese stattfindet.' },
    { term: 'Chlorophyll', definition: 'Grüner Blattfarbstoff, der vor allem rotes und blaues Licht absorbiert.' },
    { term: 'Thylakoid', definition: 'Membransystem im Chloroplasten, Ort der lichtabhängigen Reaktion.' },
    { term: 'Stroma', definition: 'Flüssige Grundsubstanz des Chloroplasten, Ort des Calvin-Zyklus.' },
    { term: 'Photolyse', definition: 'Spaltung von Wasser durch Lichtenergie; liefert Elektronen, Protonen und Sauerstoff.' },
    { term: 'RuBisCO', definition: 'Schlüsselenzym des Calvin-Zyklus, fixiert CO₂.' },
    { term: 'ATP', definition: 'Adenosintriphosphat, universeller Energieträger der Zelle.' },
  ],
  cards: [
    { front: 'Photosynthese: Was wird in was umgewandelt?', back: 'Lichtenergie in chemische Energie (Glucose)', hint: '' },
    { front: 'Wie lautet die Bruttogleichung der Photosynthese?', back: '6 CO₂ + 6 H₂O → C₆H₁₂O₆ + 6 O₂', hint: '6-6-1-6: sechs rein, sechs rein, eins raus, sechs raus' },
    { front: 'Die Photosynthese findet in den {{Chloroplasten}} statt.', back: '' },
    { front: 'Wo läuft die lichtabhängige Reaktion ab?', back: 'An der Thylakoidmembran', hint: '' },
    { front: 'Wo läuft der Calvin-Zyklus ab?', back: 'Im Stroma der Chloroplasten', hint: 'Stroma = Strom von Flüssigkeit' },
    { front: 'Woher stammt der bei der Photosynthese freigesetzte Sauerstoff?', back: 'Aus der Spaltung von Wasser (Photolyse)', hint: 'Nicht aus dem CO₂ — klassischer Klausurfehler' },
    { front: 'Welche zwei Stoffe liefert die Lichtreaktion an den Calvin-Zyklus?', back: 'ATP und NADPH' },
    { front: 'Das Schlüsselenzym des Calvin-Zyklus heißt {{RuBisCO}}.', back: 'Häufigstes Enzym der Erde' },
    { front: 'Chlorophyll', back: 'Grüner Blattfarbstoff, absorbiert vor allem rotes und blaues Licht' },
    { front: 'Warum sind Blätter grün?', back: 'Chlorophyll absorbiert Rot und Blau, grünes Licht wird reflektiert' },
    { front: 'Nenne die vier Faktoren, die die Photosyntheserate beeinflussen.', back: '• Lichtintensität\n• CO₂-Konzentration\n• Temperatur\n• Wasserversorgung' },
    { front: 'Was besagt das {{Gesetz des Minimums}}?', back: 'Der Faktor, der im Minimum vorliegt, begrenzt die Rate.' },
    { front: 'Photolyse', back: 'Spaltung von Wasser durch Lichtenergie' },
    { front: 'Wozu dient ATP in der Zelle?', back: 'Als universeller Energieträger' },
  ],
  questions: [
    { type: 'mc', question: 'Wo findet der Calvin-Zyklus statt?', options: ['In der Thylakoidmembran', 'Im Stroma', 'Im Zellkern', 'In den Mitochondrien'], correct: 1, answer: '', explanation: 'Der Calvin-Zyklus läuft im Stroma, der Grundsubstanz des Chloroplasten.' },
    { type: 'mc', question: 'Woher stammt der Sauerstoff, den Pflanzen abgeben?', options: ['Aus Kohlenstoffdioxid', 'Aus Glucose', 'Aus Wasser', 'Aus der Luft'], correct: 2, answer: '', explanation: 'Bei der Photolyse wird Wasser gespalten — daraus stammt der Sauerstoff.' },
    { type: 'mc', question: 'Welche Lichtfarben absorbiert Chlorophyll besonders gut?', options: ['Grün und Gelb', 'Rot und Blau', 'Nur Grün', 'Infrarot'], correct: 1, answer: '', explanation: 'Rot und Blau werden absorbiert, Grün reflektiert.' },
    { type: 'mc', question: 'Was liefert die lichtabhängige Reaktion an den Calvin-Zyklus?', options: ['Glucose und O₂', 'ATP und NADPH', 'CO₂ und Wasser', 'RuBisCO'], correct: 1, answer: '', explanation: 'ATP und NADPH treiben die CO₂-Fixierung an.' },
    { type: 'tf', question: 'Der Calvin-Zyklus braucht direkt Licht.', options: ['Richtig', 'Falsch'], correct: 1, answer: '', explanation: 'Er ist lichtunabhängig — er braucht nur ATP und NADPH aus der Lichtreaktion.' },
    { type: 'tf', question: 'RuBisCO ist das Schlüsselenzym der CO₂-Fixierung.', options: ['Richtig', 'Falsch'], correct: 0, answer: '', explanation: 'Richtig.' },
    { type: 'open', question: 'Erkläre das Gesetz des Minimums an einem Beispiel.', options: [], correct: 0, answer: 'Der Faktor, der am knappsten ist, begrenzt die Photosyntheserate. Beispiel: Bei viel Licht, aber wenig CO₂ steigt die Rate trotz mehr Licht nicht weiter — erst mehr CO₂ erhöht sie.', explanation: '' },
    { type: 'open', question: 'Vergleiche lichtabhängige Reaktion und Calvin-Zyklus (Ort, Ausgangsstoffe, Produkte).', options: [], correct: 0, answer: 'Lichtabhängig: Thylakoidmembran; Licht + Wasser → O₂, ATP, NADPH. Calvin-Zyklus: Stroma; CO₂ + ATP + NADPH → Glucose.', explanation: '' },
  ],
};

async function loadDemo() {
  const res = Core.normalizeGen(DEMO);
  const doc = { id: uid(), name: 'Photosynthese (Beispiel)', kind: 'text', mime: 'text/plain', added: Date.now(), bytes: DEMO.text.length, hash: null,
    pages: 1, inkPages: 0, chars: DEMO.text.length, subjectId: null, status: 'ready', gen: null, summary: '', keyPoints: [], glossary: [] };
  await Files.put({ id: doc.id, name: doc.name, type: 'text/plain', blob: new Blob([DEMO.text], { type: 'text/plain' }), pages: [{ n: 1, text: DEMO.text, ink: false }] });
  db.docs.push(doc);
  const deck = applyResult(doc, res, { mode: 'demo' });
  toast('Beispielstapel angelegt — probier alle Lernmethoden aus');
  nav('deck', { id: deck.id });
}

/* ── Updates ────────────────────────────────────────────────── */

/** Welche APP_VERSION liegt im Offline-Cache? Das ist die Fassung, die beim
    nächsten Laden ausgeliefert wird — nicht zwingend die laufende. */
async function cachedVersion() {
  if (!('caches' in window)) return null;
  for (const k of await caches.keys()) {
    if (!k.startsWith('lernapp-v')) continue;
    const c = await caches.open(k);
    const res = (await c.match('./app.js')) || (await c.match('app.js'));
    if (!res) continue;
    const m = (await res.text()).match(/APP_VERSION\s*=\s*'([^']+)'/);
    if (m) return m[1];
  }
  return null;
}

/** Lädt neu, wenn im Cache eine andere Fassung liegt als die laufende. Die
    Sperre in sessionStorage verhindert eine Endlosschleife, falls das
    Neuladen die Version wider Erwarten nicht ändert. */
let reloading = false;
async function applyIfNewer(announce) {
  if (reloading) return false;
  const cv = await cachedVersion();
  if (!cv || cv === APP_VERSION) return false;
  if (sessionStorage.getItem('la-reload') === cv) return false;   // schon versucht
  // Mitten im Lernen, im Formular oder während Claude schreibt nicht neu laden
  if (sheetOpen() || ['study', 'quiz', 'match', 'chat', 'feynman'].includes(view) || jobs.some((j) => j.status === 'run')) {
    toast(`Version ${cv} bereit — wird beim nächsten Start geladen`);
    return true;
  }
  reloading = true;
  sessionStorage.setItem('la-reload', cv);
  if (announce) toast(`Version ${cv} wird geladen …`);
  setTimeout(() => location.reload(), announce ? 700 : 0);
  return true;
}

let swReg = null;
function wireUpdates() {
  if (!('serviceWorker' in navigator)) return;

  /* Auf 'controllerchange' ist kein Verlass: aktualisiert sich dieselbe
     Registrierung, gilt die Seite nicht als "neu kontrolliert" und das
     Ereignis bleibt aus. Verlässlich ist der Zustandswechsel des neuen
     Workers auf 'activated' — dann liegt der frische Cache bereit. */
  const watch = (w) => {
    if (!w) return;
    if (w.state === 'activated') { applyIfNewer(false); return; }
    w.addEventListener('statechange', () => {
      if (w.state === 'activated') applyIfNewer(false);
    });
  };

  navigator.serviceWorker.addEventListener('controllerchange', () => applyIfNewer(false));

  const reg = () => navigator.serviceWorker.register('sw.js').then((r) => {
    swReg = r;
    watch(r.installing); watch(r.waiting);
    r.addEventListener('updatefound', () => watch(r.installing));
    navigator.serviceWorker.ready.then(() => applyIfNewer(false));
    setInterval(() => r.update().catch(() => {}), 60 * 60 * 1000);
  }).catch(() => {});
  if (document.readyState === 'complete') reg(); else window.addEventListener('load', reg);
}

async function checkUpdate() {
  if (!swReg) { toast('Ohne Service Worker gibt es keine Updates (lokaler Test?)'); return; }
  toast('Suche …');
  try { await swReg.update(); } catch (e) { toast('Keine Verbindung'); return; }
  setTimeout(async () => { if (!(await applyIfNewer(true))) toast(`Du hast die neueste Version (${APP_VERSION})`); }, 1500);
}

/* ── Installieren ───────────────────────────────────────────────
   Eigener Knopf statt Chrome-Menü: Chrome 154–157 meldet dort „bereits
   installiert“, sobald irgendeine andere App auf derselben Domain installiert
   ist (crbug.com/568841400, behoben ab Chrome 158). beforeinstallprompt prüft
   pro App und ist nicht betroffen. Chrome schickt das Ereignis nur, solange
   die App wirklich installierbar ist. In der installierten App und nach der
   Installation bleibt es aus, der Knopf verschwindet also von selbst. */
let installEvt = null;

/** Knopf ein- oder ausblenden. Das Ereignis kommt oft erst ein paar Sekunden
    nach dem Laden, unter Umständen bei schon offenen Einstellungen. */
function syncInstall() {
  const b = $('#btnInstall');
  if (b) b.classList.toggle('hidden', !installEvt);
}

function wireInstall() {
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();             // keine eigene Leiste von Chrome, der Knopf reicht
    installEvt = e;
    syncInstall();
  });
  window.addEventListener('appinstalled', () => {
    installEvt = null;
    syncInstall();
    toast('Lernapp ist installiert');
  });
}

async function installApp() {
  const e = installEvt;
  if (!e) return;
  installEvt = null;                // prompt() geht nur einmal pro Ereignis
  syncInstall();
  e.prompt();
  await e.userChoice.catch(() => {});
}

/* ── Teilen-Ziel ────────────────────────────────────────────────
   Installiert auf Android steht die Lernapp im Teilen-Menü (z. B. aus
   GoodNotes: Teilen → Lernapp). Der Service Worker nimmt die Dateien an,
   legt sie im Cache 'lernapp-share' ab und öffnet ./?share=1. */
async function pickupShared() {
  if (!/[?&]share=1/.test(location.search) || !('caches' in window)) return;
  try { history.replaceState(null, '', location.pathname); } catch (e) { /* egal */ }
  try {
    const c = await caches.open('lernapp-share');
    const reqs = await c.keys();
    const files = [];
    for (const r of reqs) {
      const res = await c.match(r);
      const name = decodeURIComponent(res.headers.get('x-name') || 'Geteilt');
      files.push(new File([await res.blob()], name, { type: res.headers.get('content-type') || '' }));
      await c.delete(r);
    }
    if (files.length) openAdd(files);
  } catch (e) { console.warn(e); }
}

/* ── Verdrahtung ────────────────────────────────────────────── */

/** Aktionen per data-act. Ein Handler am body statt einzeln pro Zeile:
    die Ansichten werden ständig neu gezeichnet. */
const ACT = {
  add: () => openAdd(),
  key: () => openKeySheet(),
  demo: () => loadDemo(),
  backup: () => backupSheet(),
  back: () => goBack(),
  'hide-key-hint': () => { db.settings.hideKeyHint = true; save(); render(); },
  'open-deck': (el) => nav('deck', { id: el.dataset.id }),
  'open-doc': (el) => nav('doc', { id: el.dataset.id }),
  'open-cards': (el) => { cardFilter = 'all'; cardQuery = ''; nav('cards', { id: el.dataset.id, tab: 'cards' }); },
  'open-questions': (el) => { cardQuery = ''; nav('cards', { id: el.dataset.id, tab: 'questions' }); },
  'cards-tab': (el) => { params.tab = el.dataset.v; cardQuery = ''; renderCards(); },
  'card-filter': (el) => { cardFilter = el.dataset.v; renderCards(); },
  'edit-card': (el) => editCard(el.dataset.id),
  'edit-q': (el) => editQuestion(el.dataset.id),
  'card-new': (el) => editCard(null, el.dataset.id),
  'q-new': (el) => editQuestion(null, el.dataset.id),
  'study-all': () => startStudy(allDeckIds()),
  'study-extra': () => startStudy(allDeckIds(), { extra: true }),
  'study-deck': (el) => startStudy([el.dataset.id], counts(el.dataset.id).todo ? {} : { extra: true }),
  'study-more': () => { const ids = S.ids; startStudy(ids, { extra: true }); },
  'm-study': (el) => startStudy(idsFrom(el.dataset.id)),
  'm-quiz': (el) => quizSetup(idsFrom(el.dataset.id), 'quiz'),
  'm-test': (el) => quizSetup(idsFrom(el.dataset.id), 'test'),
  'm-write': (el) => startQuiz(idsFrom(el.dataset.id), { mode: 'write', n: 15 }),
  'm-match': (el) => startMatch(idsFrom(el.dataset.id)),
  'm-feynman': (el) => startFeynman(idsFrom(el.dataset.id)),
  'm-hard': (el) => startStudy(idsFrom(el.dataset.id), { cram: 'hard' }),
  'm-cram': (el) => startStudy(idsFrom(el.dataset.id), { cram: 'all' }),
  'm-notes': (el) => nav('notes', { id: el.dataset.id }),
  'm-chat': (el) => nav('chat', { id: el.dataset.id }),
  'pr-deck': (el) => { practiceDeck = el.dataset.id; renderPractice(); },
  'deck-more': (el) => deckMenu(el.dataset.id),
  'deck-subject': (el) => pickSubject(deckById(el.dataset.id)),
  'deck-exam': (el) => examSheet(deckById(el.dataset.id)),
  'deck-more-gen': (el) => moreGen(el.dataset.id),
  'occl-pick': (el) => occlPickPage(el.dataset.id),
  'lib-filter': (el) => { libFilter = el.dataset.id; renderLibrary(); },
  'lib-more': () => menuSheet('Stapel', [
    { label: 'Neuer leerer Stapel', icon: 'plus', sub: 'Karten selbst schreiben', fn: () => askText('Neuer Stapel', 'Name', { placeholder: 'z. B. Vokabeln Unit 4' }, (v) => {
      if (!v.trim()) return;
      const d = { id: uid(), name: v.trim().slice(0, 80), subjectId: libFilter && libFilter !== '-' ? libFilter : null, docIds: [], created: Date.now(), examDate: null, newPerDay: null };
      db.decks.push(d); save(); closeSheet(); nav('deck', { id: d.id });
    }) },
    { label: 'Stapel importieren', icon: 'upload', sub: 'JSON-Datei', fn: () => { closeSheet(); $('#deckIn').click(); } },
    { label: 'Beispielstapel laden', icon: 'play', fn: () => { closeSheet(); loadDemo(); } },
  ]),
  'subject-edit': (el) => subjectEdit(el.dataset.id),
  'gen-doc': (el) => genDoc(el.dataset.id),
  'job-stop': (el) => { const j = jobs.find((x) => x.id === el.dataset.id); if (j) j.ctrl.abort(); },
  flip: () => flipCard(),
  'grade-help-off': () => { db.settings.gradeHelp = false; save(); renderStudy(); },
  speak: () => {
    const c = S && db.cards.find((x) => x.id === S.cur);
    if (!c) return;
    // Vorderseite, nach dem Umdrehen die Antwort (bei Lückentext der ganze Satz)
    speak(S.flipped ? (c.kind === 'cloze' ? c.front : c.back) : (c.kind === 'cloze' ? Core.clozeParts(c.front, 0).map((p) => (p.t === 'gap' ? '…' : p.s)).join('') : c.front), deckById(c.deckId));
  },
  grade: (el) => gradeCard(+el.dataset.g),
  undo: () => undoGrade(),
  'card-source': (el) => cardSource(el.dataset.id),
  'card-explain': (el) => explainCard(el.dataset.id),
  'card-edit-study': (el) => editCard(el.dataset.id, null, () => renderStudy()),
  opt: (el) => answerQuiz(+el.dataset.i),
  'q-next': () => nextQuiz(),
  'w-check': () => answerQuiz($('#wIn').value),
  'w-skip': () => answerQuiz(''),
  'w-override': () => selfGrade(Q.i, 'right'),
  'o-check': () => answerQuiz($('#oIn').value),
  'o-check-short': () => answerQuiz($('#wIn').value),
  'o-skip': () => answerQuiz(''),
  self: (el) => selfGrade(Q.i, el.dataset.v),
  'self-r': (el) => selfGrade(+el.dataset.i, el.dataset.v),
  'q-retry-wrong': () => {
    const wrongIdx = Q.items.map((it, i) => i).filter((i) => !Q.answers[i] || Q.answers[i].score !== 1);
    if (Q.mode === 'write') startQuiz(Q.ids, { mode: 'write', wrongIds: wrongIdx.map((i) => Q.items[i].cid) });
    else {
      const items = wrongIdx.map((i) => ({ type: 'q', qid: Q.items[i].qid, q: Object.assign({}, Q.items[i].q) }));
      startQuiz(Q.ids, { mode: 'quiz', items: Core.shuffle(items) });
    }
  },
  'q-again': () => (Q.mode === 'write' ? startQuiz(Q.ids, { mode: 'write', n: 15 }) : quizSetup(Q.ids, Q.mode)),
  mt: (el) => tapMatch(el.dataset.s, +el.dataset.i),
  'match-again': () => startMatch(M.ids),
  'notes-print': () => { document.body.classList.add('print-notes'); window.print(); setTimeout(() => document.body.classList.remove('print-notes'), 500); },
  'notes-ai': (el) => notesAi(el.dataset.id),
  'notes-edit': (el) => notesEdit(el.dataset.id),
  page: (el) => openPage(el.dataset.id, +el.dataset.n),
  'doc-more': (el) => docMenu(el.dataset.id),
  'chat-send': () => sendChat($('#chatIn').value),
  'chat-stop': () => { if (tutorCtrl) tutorCtrl.abort(); },
  'chat-quick': (el) => sendChat(el.textContent),
  'chat-clear': (el) => askSheet('Gespräch löschen?', 'Der Verlauf mit dem Tutor wird gelöscht.', 'Löschen', () => { delete db.chats[el.dataset.id]; save(); closeSheet(); renderChat(); }, null, true),
  'chat-copy': (el) => chatCopy(el.dataset.id),
  'fy-check': () => checkFeynman(),
  'fy-skip': () => { F.i++; F.answer = ''; F.result = null; renderFeynman(); },
  'fy-next': () => { F.i++; F.answer = ''; F.result = null; renderFeynman(); window.scrollTo(0, 0); },
};

function wire() {
  document.body.addEventListener('click', (e) => {
    const n = e.target.closest('[data-nav]');
    if (n) { nav(n.dataset.nav); return; }
    const a = e.target.closest('[data-act]');
    if (a && ACT[a.dataset.act] && !a.disabled) { ACT[a.dataset.act](a, e); }
  });
  $('#btnAdd').onclick = () => openAdd();
  $('#btnSettings').onclick = openSettings;
  $('#btnBack').onclick = goBack;
  $('#sheetCancel').onclick = closeSheet;
  // Über den Abbrechen-Knopf: verschachtelte Sheets haben dort ihren Rückweg
  $('#scrim').onclick = () => $('#sheetCancel').click();
  $('#sheetSave').onclick = () => sheetSaveFn && sheetSaveFn();

  $('#deckIn').onchange = (e) => { const f = e.target.files[0]; e.target.value = ''; importDeckFile(f); };
  $('#fileIn').onchange = (e) => {
    const files = Array.from(e.target.files || []);
    e.target.value = '';
    if (!files.length) return;
    if (sheetOpen() && addSheetGo && $('#addPick')) { pendingFiles = files; addSheetGo(); }
    else openAdd(files);
  };

  // Ziehen und Ablegen auf das ganze Fenster
  let dragDepth = 0;
  const hasFiles = (e) => e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files');
  window.addEventListener('dragenter', (e) => { if (!hasFiles(e)) return; dragDepth++; $('#dropHint').classList.remove('hidden'); });
  window.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
  window.addEventListener('dragleave', () => { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) $('#dropHint').classList.add('hidden'); });
  window.addEventListener('drop', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth = 0;
    $('#dropHint').classList.add('hidden');
    const files = Array.from(e.dataTransfer.files || []);
    if (files.length) openAdd(files);
  });
  // Bild aus der Zwischenablage (z. B. Screenshot einer Folie)
  window.addEventListener('paste', (e) => {
    if (e.target.closest && e.target.closest('input, textarea')) return;
    const files = Array.from((e.clipboardData && e.clipboardData.files) || []);
    if (files.length) { e.preventDefault(); openAdd(files); }
  });

  // Tastatur: am Rechner lernt es sich so deutlich schneller
  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === 'Escape') { if (sheetOpen()) $('#sheetCancel').click(); else if (!$('#overlay').classList.contains('hidden')) closeOverlay(); return; }
    // Ziel kann das Dokument selbst sein (kein Element im Fokus) — das hat kein closest()
    if (sheetOpen() || (e.target.closest && e.target.closest('input, textarea, select'))) return;
    if (view === 'study' && S && S.cur) {
      if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); if (!S.flipped) flipCard(); else gradeCard(3); }
      else if (/^[1-4]$/.test(e.key) && S.flipped) gradeCard(S.cram && (e.key === '2' || e.key === '4') ? (e.key === '2' ? 1 : 3) : +e.key);
      else if (e.key === 'u' || e.key === 'z') undoGrade();
      else if (e.key === 'e') editCard(S.cur, null, () => renderStudy());
      else if (e.key === 'v') ACT.speak();
    } else if (view === 'study' && S && S.undo && (e.key === 'u' || e.key === 'z')) undoGrade();
    else if (view === 'match' && M && M.end && e.key === 'Enter') startMatch(M.ids);
    else if (view === 'quiz' && Q && !Q.done) {
      const it = quizItem();
      if (it && it.type === 'q' && it.q.kind !== 'open' && !Q.locked && /^[1-6a-f]$/i.test(e.key)) {
        const i = /\d/.test(e.key) ? +e.key - 1 : e.key.toLowerCase().charCodeAt(0) - 97;
        if (i < it.q.options.length) answerQuiz(i);
      } else if (e.key === 'Enter' && (Q.locked || (Q.mode === 'test' && Q.sel != null))) nextQuiz();
    }
  });
}

/* ── 15. Start ──────────────────────────────────────────────── */
load();
applyTheme(db.theme);
wire();
wireBack();
nav('home');

/* Bittet den Browser, den Speicher nicht bei Platzmangel wegzuräumen. */
if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});

wireUpdates();
wireInstall();
pickupShared();
