'use strict';
/* ═══════════════════════════════════════════════════════════════
   Lernapp — Anbindung an Claude (Anthropic API)

   Die einzige Stelle, an der die App ins Netz geht — und nur, wenn in den
   Einstellungen ein eigener API-Schlüssel hinterlegt ist. Ohne Schlüssel
   bleibt alles lokal (Offline-Generator in core.js) oder läuft über den Weg
   „Claude-Chat“: Die App baut einen Auftrag zum Kopieren, die Antwort wird
   wieder eingefügt. Dafür geht nichts von hier aus raus.

   Warum fetch statt Anthropic-SDK: Die Bauanleitung verbietet Abhängigkeiten
   und Build-Schritte, das SDK gibt es nur als npm-Paket. Die Anfragen folgen
   der offiziellen HTTP-Schnittstelle (POST /v1/messages, SSE-Streaming).
   Der Kopf `anthropic-dangerous-direct-browser-access` erlaubt den Aufruf
   direkt aus dem Browser; der Schlüssel liegt dabei auf dem Gerät des
   Nutzers — genau das ist hier gewollt, es gibt kein eigenes Backend.

   Inhalt
   1. Modelle und Preise
   2. Streaming-Aufruf mit Wiederholung bei Überlast
   3. Lernmaterial erzeugen (Prompt, Schema, Abschnitte)
   4. Weg ohne Schlüssel: Auftrag für den Claude-Chat
   5. Tutor, Erklären, Bewerten
   ═══════════════════════════════════════════════════════════════ */

const AI = (() => {

const API = 'https://api.anthropic.com/v1/messages';
const VERSION = '2023-06-01';

/* ── 1. Modelle und Preise ─────────────────────────────────────
   Preise in US-Dollar je 1 Mio. Token (Stand der Modellübersicht, Juni
   2026). Nur für die Kostenschätzung in der App — abgerechnet wird bei
   Anthropic. `effort`: Modell versteht output_config.effort.
   `fallbacks`: serverseitiger Ersatz bei einer Ablehnung durch die
   Sicherheitsfilter (bei Opus 5 empfohlen). */
const MODELS = {
  'claude-opus-5':    { label: 'Claude Opus 5', note: 'beste Qualität', in: 5, out: 25, effort: true, fallbacks: true },
  'claude-sonnet-5':  { label: 'Claude Sonnet 5', note: 'günstiger, sehr gut', in: 2, out: 10, effort: true, fallbacks: false },
  'claude-haiku-4-5': { label: 'Claude Haiku 4.5', note: 'am günstigsten, schnell', in: 1, out: 5, effort: false, fallbacks: false, maxOut: 64000 },
};
const DEFAULT_MODEL = 'claude-opus-5';

function cost(model, usage) {
  const m = MODELS[model] || MODELS[DEFAULT_MODEL];
  if (!usage) return 0;
  const inTok = (usage.input_tokens || 0) + (usage.cache_creation_input_tokens || 0) * 1.25
    + (usage.cache_read_input_tokens || 0) * 0.1;
  return (inTok * m.in + (usage.output_tokens || 0) * m.out) / 1e6;
}

/* ── 2. Streaming-Aufruf ───────────────────────────────────── */

/** Server-Sent Events zerlegen. Pufferfest: ein Ereignis kann über mehrere
    Netzwerk-Stücke verteilt ankommen. */
function sseParser(onEvent) {
  let buf = '';
  return (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.search(/\r?\n\r?\n/)) >= 0) {
      const raw = buf.slice(0, i);
      buf = buf.slice(i).replace(/^\r?\n\r?\n/, '');
      let event = 'message';
      const data = [];
      for (const line of raw.split(/\r?\n/)) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
      }
      if (!data.length) continue;
      let json = null;
      try { json = JSON.parse(data.join('\n')); } catch (e) { continue; }
      onEvent(event, json);
    }
  };
}

class AIError extends Error {
  constructor(msg, code, status) { super(msg); this.code = code; this.status = status; }
}

/** Verständliche Meldung zu einem HTTP-Fehler der API. */
function explainError(status, body) {
  const t = (body && body.error && body.error.type) || '';
  const m = (body && body.error && body.error.message) || '';
  if (status === 401 || t === 'authentication_error') return new AIError('Der API-Schlüssel wird nicht akzeptiert. Bitte in den Einstellungen prüfen.', 'auth', status);
  if (status === 403 || t === 'permission_error') return new AIError('Dieser API-Schlüssel darf das gewählte Modell nicht nutzen.', 'perm', status);
  if (status === 402 || /credit|billing|balance/i.test(m)) return new AIError('Auf dem Anthropic-Konto ist kein Guthaben mehr. Unter console.anthropic.com aufladen.', 'billing', status);
  if (status === 404 || t === 'not_found_error') return new AIError('Das gewählte Modell gibt es für diesen Schlüssel nicht. Anderes Modell in den Einstellungen wählen.', 'model', status);
  if (status === 413 || t === 'request_too_large') return new AIError('Die Datei ist zu groß für eine Anfrage. Die App teilt sie beim nächsten Versuch in Abschnitte.', 'size', status);
  if (status === 429 || t === 'rate_limit_error') return new AIError('Zu viele Anfragen kurz hintereinander. Bitte eine Minute warten.', 'rate', status);
  if (status === 529 || t === 'overloaded_error') return new AIError('Claude ist gerade überlastet. Bitte gleich noch einmal versuchen.', 'overload', status);
  if (status >= 500) return new AIError('Fehler bei Anthropic (' + status + '). Bitte später noch einmal versuchen.', 'server', status);
  return new AIError('Die Anfrage wurde abgelehnt: ' + (m || 'Status ' + status), 'bad', status);
}

/**
 * Eine Nachricht per Streaming holen.
 * opts: {key, signal, onText(fullText), onStatus(text)}
 * Ergebnis: {text, usage, stop, model, cost}
 */
async function stream(body, opts) {
  const req = Object.assign({}, body, { stream: true });
  const betas = [];
  const m = MODELS[req.model];
  if (m && m.fallbacks && !opts.noFallback) {
    req.fallbacks = 'default';
    betas.push('server-side-fallback-2026-07-01');
  }
  const headers = {
    'content-type': 'application/json',
    'x-api-key': opts.key,
    'anthropic-version': VERSION,
    'anthropic-dangerous-direct-browser-access': 'true',
  };
  if (betas.length) headers['anthropic-beta'] = betas.join(',');

  let res;
  try {
    res = await fetch(API, { method: 'POST', headers, body: JSON.stringify(req), signal: opts.signal });
  } catch (e) {
    if (e && e.name === 'AbortError') throw new AIError('Abgebrochen.', 'abort');
    throw new AIError('Keine Verbindung zu Claude. Bist Du online?', 'net');
  }
  if (!res.ok) {
    let j = null;
    try { j = await res.json(); } catch (e) { /* kein JSON */ }
    const err = explainError(res.status, j);
    err.retryAfter = parseFloat(res.headers.get('retry-after')) || 0;
    err.raw = j && j.error && j.error.message;
    throw err;
  }

  let text = '';
  let usage = {};
  let stop = null;
  let model = req.model;
  let streamErr = null;
  const blocks = {};
  const feed = sseParser((ev, d) => {
    switch (d.type) {
      case 'message_start':
        usage = Object.assign({}, d.message && d.message.usage);
        if (d.message && d.message.model) model = d.message.model;
        if (opts.onStatus) opts.onStatus('denkt nach …');
        break;
      case 'content_block_start': {
        const cb = d.content_block || {};
        blocks[d.index] = cb.type;
        // Ersatzmodell übernimmt: was das abgelehnte Modell bis hierher
        // geschrieben hat, ist verworfen — von vorn sammeln
        if (cb.type === 'fallback') {
          text = '';
          if (cb.to && cb.to.model) model = cb.to.model;
          if (opts.onStatus) opts.onStatus('Ersatzmodell übernimmt …');
        }
        if (cb.type === 'text' && opts.onStatus) opts.onStatus('schreibt …');
        break;
      }
      case 'content_block_delta':
        if (d.delta && d.delta.type === 'text_delta') {
          text += d.delta.text;
          if (opts.onText) opts.onText(text);
        }
        break;
      case 'message_delta':
        if (d.delta && d.delta.stop_reason) stop = d.delta.stop_reason;
        if (d.usage) Object.assign(usage, d.usage);
        break;
      case 'error':
        streamErr = d.error || { type: 'api_error', message: 'Unbekannter Fehler' };
        break;
      default: break;
    }
  });

  const reader = res.body.getReader();
  const dec = new TextDecoder();
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      feed(dec.decode(value, { stream: true }));
    }
    feed(dec.decode() + '\n\n');
  } catch (e) {
    if (e && e.name === 'AbortError') throw new AIError('Abgebrochen.', 'abort');
    throw new AIError('Die Verbindung ist während der Antwort abgerissen.', 'net');
  }
  if (streamErr) {
    const st = streamErr.type === 'overloaded_error' ? 529 : streamErr.type === 'rate_limit_error' ? 429 : 500;
    throw explainError(st, { error: streamErr });
  }
  if (stop === 'refusal') throw new AIError('Claude hat diese Anfrage abgelehnt. Probiere den Offline-Generator oder ein anderes Modell.', 'refusal');
  return { text, usage, stop, model, cost: cost(model, usage) };
}

/** Mit Wiederholung bei Überlast (429/529/5xx) und ohne den Ersatz-Parameter,
    falls der Schlüssel die Beta-Funktion nicht kennt. */
async function call(body, opts) {
  let noFallback = false;
  for (let attempt = 0; ; attempt++) {
    try {
      return await stream(body, Object.assign({}, opts, { noFallback }));
    } catch (e) {
      if (e.code === 'bad' && !noFallback && /fallback|beta/i.test(e.raw || '')) { noFallback = true; continue; }
      const retry = ['rate', 'overload', 'server'].includes(e.code) && attempt < 2;
      if (!retry) throw e;
      const wait = Math.min(30, e.retryAfter || (attempt + 1) * 6);
      if (opts.onStatus) opts.onStatus(`überlastet, neuer Versuch in ${Math.round(wait)} s …`);
      await new Promise((r) => setTimeout(r, wait * 1000));
      if (opts.signal && opts.signal.aborted) throw new AIError('Abgebrochen.', 'abort');
    }
  }
}

/** Gemeinsame Felder: Modell, Ausgabelänge, Gründlichkeit. */
function base(model, effort, maxTokens) {
  const m = MODELS[model] ? model : DEFAULT_MODEL;
  const b = { model: m, max_tokens: Math.min(maxTokens || 64000, MODELS[m].maxOut || 128000) };
  if (MODELS[m].effort && effort) b.output_config = { effort };
  return b;
}

/** Schlüssel prüfen, ohne etwas zu bezahlen: die Modellliste kostet nichts. */
async function testKey(key) {
  let res;
  try {
    res = await fetch('https://api.anthropic.com/v1/models?limit=20', {
      headers: { 'x-api-key': key, 'anthropic-version': VERSION, 'anthropic-dangerous-direct-browser-access': 'true' },
    });
  } catch (e) { throw new AIError('Keine Verbindung zu Anthropic. Bist Du online?', 'net'); }
  if (!res.ok) {
    let j = null; try { j = await res.json(); } catch (e) { /* egal */ }
    throw explainError(res.status, j);
  }
  const j = await res.json().catch(() => ({}));
  return (j.data || []).map((x) => x.id);
}

/* ── 3. Lernmaterial erzeugen ──────────────────────────────── */

const GEN_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['title', 'subject', 'summary', 'keyPoints', 'glossary', 'cards', 'questions'],
  properties: {
    title: { type: 'string', description: 'Kurzer, sprechender Titel für den Kartenstapel (max. 6 Wörter)' },
    subject: { type: 'string', description: 'Schulfach, z. B. Biologie, Geschichte, Englisch, Mathematik' },
    summary: { type: 'string', description: 'Lernzettel in Markdown' },
    keyPoints: { type: 'array', items: { type: 'string' }, description: 'Die wichtigsten Kernaussagen' },
    glossary: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false, required: ['term', 'definition', 'page'],
        properties: { term: { type: 'string' }, definition: { type: 'string' }, page: { type: 'integer' } },
      },
    },
    cards: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false, required: ['front', 'back', 'hint', 'page'],
        properties: {
          front: { type: 'string', description: 'Frage oder Lückentext mit {{…}}' },
          back: { type: 'string', description: 'Antwort; bei Lückentext optionaler Zusatz, sonst leer' },
          hint: { type: 'string', description: 'Eselsbrücke, Beispiel oder Hinweis — oder leer' },
          page: { type: 'integer', description: 'Seitenzahl im Material, 0 wenn unklar' },
        },
      },
    },
    questions: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        required: ['type', 'question', 'options', 'correct', 'answer', 'explanation', 'page'],
        properties: {
          type: { type: 'string', enum: ['mc', 'tf', 'open'] },
          question: { type: 'string' },
          options: { type: 'array', items: { type: 'string' } },
          correct: { type: 'integer', description: 'Index der richtigen Option (mc), 0 = richtig / 1 = falsch (tf), 0 bei open' },
          answer: { type: 'string', description: 'Musterlösung (open), sonst leer' },
          explanation: { type: 'string', description: 'Warum die Lösung stimmt, 1–2 Sätze' },
          page: { type: 'integer' },
        },
      },
    },
  },
};

const GEN_SYSTEM = `Du bist ein erfahrener Gymnasiallehrer und Lerncoach. Ein Schüler gibt Dir sein Unterrichtsmaterial — Mitschriften (oft handschriftlich aus GoodNotes), Arbeitsblätter, Präsentationen, Buchseiten. Daraus machst Du Lernmaterial, mit dem er sich gezielt auf Tests und Klausuren vorbereitet.

Grundsätze
- Bleib beim Inhalt des Materials. Ergänze höchstens kurze Erklärungen, die zum Verständnis nötig sind, und erfinde keine Fakten. Offensichtliche Fehler in einer Mitschrift korrigierst Du in der Antwort und erwähnst das im Feld hint.
- Lies Handschrift, Skizzen, Tabellen und Beschriftungen in Abbildungen mit. Was unleserlich ist, lässt Du weg, statt zu raten.
- Sprache: die des Materials. Bei Fremdsprachen-Unterricht Vokabeln und Wendungen in beide Richtungen (Fremdsprache → Deutsch und umgekehrt), Grammatikregeln auf Deutsch erklärt.
- Formeln in Unicode (x², √, ≤, →, Δ, ∫, ·), kein LaTeX. Chemische Formeln wie H₂O, CO₂.
- Seitenzahl (page) jeweils dort, wo der Inhalt im Material steht; 0, wenn unklar.

Karteikarten (cards)
- Eine Information pro Karte. Lieber zwei kleine Karten als eine überladene.
- Die Frage muss ohne das Material verständlich sein: Thema nennen („Photosynthese: Wo findet der Calvin-Zyklus statt?“ statt „Wo findet er statt?“).
- Antworten kurz und präzise, möglichst unter 25 Wörtern. Aufzählungen nur, wenn die Aufzählung selbst gelernt werden muss (dann höchstens 5 Punkte, als „• …“ je Zeile).
- Mische Kartentypen: Begriff → Definition, Frage → Antwort, Ursache → Wirkung, Vergleich, Beispiel erkennen, Jahreszahl → Ereignis, Formel → Bedeutung.
- Lückentext für Definitionen und Merksätze: Schreibe den ganzen Satz in front und setze genau den zu lernenden Begriff in doppelte geschweifte Klammern, z. B. „Die {{Photosynthese}} findet in den Chloroplasten statt.“ Pro Satz höchstens eine Lücke; back bleibt dann leer oder enthält einen kurzen Zusatz.
- hint: eine Eselsbrücke, ein Beispiel oder ein Merksatz, wenn es wirklich hilft — sonst leer.
- Keine Karten über Organisatorisches (Datum der Stunde, Hausaufgaben, Lehrername).

Quizfragen (questions)
- type "mc": genau 4 Optionen, genau eine richtig, die falschen plausibel (typische Verwechslungen, ähnliche Begriffe), alle etwa gleich lang. Kein „Alle genannten“ und kein „Keine davon“. Die Position der richtigen Antwort variiert.
- type "tf": eine klare Aussage; options ["Richtig", "Falsch"]; correct 0 wenn die Aussage stimmt, 1 wenn nicht. Etwa die Hälfte der Aussagen ist falsch, mit typischem Fehler.
- type "open": Verständnis- und Transferfragen wie in einer Klausur (erkläre, vergleiche, begründe, wende an); options leer, correct 0, answer ist eine knappe Musterlösung mit den Punkten, die ein Lehrer erwartet.
- explanation: 1–2 Sätze, warum die Lösung stimmt.
- Mische etwa 60 % mc, 20 % tf, 20 % open.

Lernzettel (summary)
- Markdown, eine Seite: Überschriften mit ##, Stichpunkte mit -, wichtige Begriffe **fett**. Einfache Tabellen sind erlaubt, wenn sie einen Vergleich klarer machen.
- Aufbau: worum es geht, die wichtigsten Zusammenhänge, typische Fehler und worauf in der Klausur geachtet wird.

keyPoints: 3 bis 10 Kernaussagen, je ein Satz.
glossary: alle Fachbegriffe mit kurzer Definition.`;

const AMOUNT = { wenig: 0.5, normal: 1, viel: 1.7 };

/** Grobe Größe des Stoffs → Zielmenge an Karten und Fragen. */
function targets(info, amount) {
  const f = AMOUNT[amount] || 1;
  const fromText = info.chars / 170;
  const fromPages = info.inkPages * 4;
  // Obergrenze wächst mit der gewählten Menge: ein 30-Seiten-Skript auf „viel“ darf über 200 Karten haben
  const cards = Math.round(Math.max(8, Math.min(160 * f, (fromText + fromPages) * f)));
  const questions = Math.round(Math.max(5, Math.min(60 * f, cards * 0.45)));
  return { cards, questions };
}

/**
 * Inhalt eines Dokuments in Anfrage-Abschnitte aufteilen.
 * doc: {pages: [{n, text, ink}], pdfBase64?: () => Promise<string>, bytes}
 * mode: 'auto' | 'text' | 'pdf'
 * Ergebnis: [{kind: 'text'|'pdf'|'mixed', from, to, pages}]
 * Bilder von Seiten rendert die App erst beim Senden (renderPage).
 */
function plan(pages, bytes, mode) {
  const ink = pages.filter((p) => p.ink);
  const textOnly = mode === 'text' || (mode !== 'pdf' && ink.length === 0);
  // Zeichen je Abschnitt: etwa 80 000 Token. Lieber ein großer Auftrag als
  // viele kleine — sonst zerfällt der Lernzettel in Teile.
  const MAX_TEXT = 250000;
  if (textOnly) {
    const chunks = [];
    let cur = null;
    for (const p of pages) {
      const len = (p.text || '').length;
      if (!cur || (cur.chars + len > MAX_TEXT && cur.pages.length)) { cur = { kind: 'text', pages: [], chars: 0 }; chunks.push(cur); }
      cur.pages.push(p);
      cur.chars += len;
    }
    return chunks.map(range);
  }
  // Ganzes PDF in einer Anfrage: bis 100 Seiten und ~20 MB (Base64 bläht um
  // ein Drittel auf, die Grenze der API liegt bei 32 MB je Anfrage).
  if (bytes && bytes <= 20 * 1024 * 1024 && pages.length <= 100) {
    return [range({ kind: 'pdf', pages })];
  }
  // Sonst in Stücken zu 15 Seiten: Text, wo Text ist, sonst ein Bild der Seite
  const chunks = [];
  for (let i = 0; i < pages.length; i += 15) chunks.push(range({ kind: 'mixed', pages: pages.slice(i, i + 15) }));
  return chunks;
}
const range = (c) => Object.assign(c, { from: c.pages[0] ? c.pages[0].n : 1, to: c.pages.length ? c.pages[c.pages.length - 1].n : 1 });

/** Kostenschätzung für einen Plan, bevor etwas gesendet wird. */
function estimate(model, chunks, tg) {
  let input = 0;
  for (const c of chunks) {
    input += 3500;                                         // Auftrag + Schema
    for (const p of c.pages) {
      if (c.kind === 'pdf') input += 1700 + (p.text || '').length / 3.2;   // Seitenbild + Text
      else if (c.kind === 'mixed' && p.ink) input += 1600;
      else input += (p.text || '').length / 3.2;
    }
  }
  const output = tg.cards * 70 + tg.questions * 150 + 2500 + 3000 * chunks.length;   // inkl. Nachdenken
  return { input: Math.round(input), output: Math.round(output), usd: cost(model, { input_tokens: input, output_tokens: output }) };
}

/** Text der Seiten mit klaren Seitenmarken. */
const pagesText = (pages) => pages.map((p) => `--- Seite ${p.n} ---\n${(p.text || '').trim() || '(kein Text — handschriftlich oder Bild)'}`).join('\n\n');

function genInstruction(meta, tg, chunk, nChunks) {
  const part = nChunks > 1
    ? `\nDies ist Teil ${meta.part} von ${nChunks} (Seiten ${chunk.from}–${chunk.to}). Erstelle Material nur für diese Seiten; summary ist der Lernzettel dieses Teils.`
    : '';
  const share = (x) => Math.max(nChunks > 1 ? 3 : 5, Math.round(x / nChunks));
  return `Erstelle Lernmaterial aus dem Material oben.

Datei: ${meta.name}${meta.subject ? `\nFach: ${meta.subject}` : ''}${meta.wish ? `\nWunsch des Schülers: ${meta.wish}` : ''}${part}

Umfang: etwa ${share(tg.cards)} Karteikarten und ${share(tg.questions)} Quizfragen — weniger, wenn der Stoff nicht mehr hergibt. Keine Füllkarten, keine Dopplungen.`;
}

/**
 * Inhaltsblöcke für einen Abschnitt bauen.
 * src: {pdfBase64(): Promise<string>, renderPage(n): Promise<string(base64 jpeg)>}
 */
async function contentFor(chunk, src, meta) {
  const blocks = [];
  if (chunk.kind === 'pdf') {
    blocks.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: await src.pdfBase64() }, title: meta.name });
    // Der erkannte Text hilft bei schlecht gesetzten PDFs (Spalten, Formeln)
    const t = chunk.pages.filter((p) => !p.ink && p.text).length;
    if (t) blocks.push({ type: 'text', text: `Zur Orientierung der maschinell gelesene Text der Seiten (kann Fehler enthalten):\n<text>\n${pagesText(chunk.pages)}\n</text>` });
  } else if (chunk.kind === 'image') {
    blocks.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: await src.imageBase64() } });
  } else if (chunk.kind === 'mixed') {
    for (const p of chunk.pages) {
      if (p.ink) {
        blocks.push({ type: 'text', text: `--- Seite ${p.n} (Bild) ---` });
        blocks.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: await src.renderPage(p.n) } });
      } else blocks.push({ type: 'text', text: `--- Seite ${p.n} ---\n${p.text}` });
    }
  } else {
    blocks.push({ type: 'text', text: `<material>\n${pagesText(chunk.pages)}\n</material>` });
  }
  return blocks;
}

/**
 * Lernmaterial für ein Dokument erzeugen.
 * job: {key, model, effort, amount, meta: {name, subject, wish, mediaType}, pages, bytes, mode,
 *       src: {pdfBase64, renderPage, imageBase64}, kind ('pdf'|'image'|'text'), signal,
 *       onProgress({part, parts, cards, status})}
 */
async function generate(job) {
  const info = { chars: job.pages.reduce((a, p) => a + (p.text || '').length, 0), inkPages: job.pages.filter((p) => p.ink).length };
  const tg = targets(info, job.amount);
  const chunks = job.kind === 'image' ? [range({ kind: 'image', pages: job.pages })] : plan(job.pages, job.bytes, job.mode);
  const merged = { title: '', subject: '', summary: [], keyPoints: [], glossary: [], cards: [], questions: [] };
  let usd = 0, model = job.model;

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    const meta = Object.assign({}, job.meta, { part: i + 1 });
    const content = await contentFor(chunk, job.src, meta);
    content.push({ type: 'text', text: genInstruction(meta, tg, chunk, chunks.length) });
    const body = Object.assign(base(job.model, job.effort, 64000), {
      system: GEN_SYSTEM,
      messages: [{ role: 'user', content }],
    });
    body.output_config = Object.assign({}, body.output_config, { format: { type: 'json_schema', schema: GEN_SCHEMA } });

    const report = (status, text) => job.onProgress && job.onProgress({
      part: i + 1, parts: chunks.length, status,
      cards: merged.cards.length + (text ? (text.match(/"front"\s*:/g) || []).length : 0),
    });
    report('sendet …');
    const res = await call(body, {
      key: job.key, signal: job.signal,
      onStatus: (s) => report(s),
      onText: (t) => report('schreibt …', t),
    });
    usd += res.cost;
    model = res.model;
    let obj;
    try { obj = Core.parseLooseJSON(res.text); }
    catch (e) { throw new AIError('Die Antwort von Claude war kein gültiges JSON. Bitte noch einmal versuchen.', 'json'); }
    const r = Core.normalizeGen(obj);
    if (!merged.title) merged.title = r.title;
    if (!merged.subject) merged.subject = r.subject;
    if (r.summary) merged.summary.push(chunks.length > 1 ? `# Seiten ${chunk.from}–${chunk.to}\n\n${r.summary}` : r.summary);
    merged.keyPoints.push(...r.keyPoints);
    merged.glossary.push(...r.glossary);
    merged.cards.push(...r.cards);
    merged.questions.push(...r.questions);
    if (res.stop === 'max_tokens') merged.truncated = true;
  }
  merged.summary = merged.summary.join('\n\n');
  // Abschnitte können dieselben Begriffe liefern
  return { result: Core.normalizeGen(merged), usd, model, parts: chunks.length, truncated: !!merged.truncated };
}

/* ── 4. Ohne Schlüssel: Auftrag für den Claude-Chat ───────────
   Der Schüler kopiert den Auftrag in claude.ai (oder die Claude-App),
   hängt bei Handschrift das PDF an und fügt die Antwort wieder ein.
   Das Antwortformat ist dasselbe wie bei der API. */
function chatPrompt(meta, pages, opts) {
  opts = opts || {};
  const info = { chars: pages.reduce((a, p) => a + (p.text || '').length, 0), inkPages: pages.filter((p) => p.ink).length };
  const tg = targets(info, opts.amount);
  const hasText = pages.some((p) => !p.ink && p.text);
  const needFile = opts.attach || info.inkPages > 0 || !hasText;
  const example = {
    title: 'Photosynthese', subject: 'Biologie',
    summary: '## Worum es geht\n- …',
    keyPoints: ['…'],
    glossary: [{ term: 'Chlorophyll', definition: 'Grüner Blattfarbstoff …', page: 2 }],
    cards: [
      { front: 'Photosynthese: Wo läuft der Calvin-Zyklus ab?', back: 'Im Stroma der Chloroplasten', hint: '', page: 3 },
      { front: 'Die {{Photolyse}} spaltet Wasser in der lichtabhängigen Reaktion.', back: '', hint: '', page: 3 },
    ],
    questions: [
      { type: 'mc', question: '…', options: ['…', '…', '…', '…'], correct: 2, answer: '', explanation: '…', page: 1 },
      { type: 'tf', question: '…', options: ['Richtig', 'Falsch'], correct: 1, answer: '', explanation: '…', page: 1 },
      { type: 'open', question: '…', options: [], correct: 0, answer: '…', explanation: '…', page: 1 },
    ],
  };
  return `${GEN_SYSTEM}

Antwortformat
Antworte ausschließlich mit einem einzigen JSON-Objekt in einem Codeblock, ohne Text davor oder danach, genau in dieser Form:
\`\`\`json
${JSON.stringify(example, null, 2)}
\`\`\`

${needFile ? `Das Material ist die angehängte Datei „${meta.name}“.${hasText ? ' Unten steht zusätzlich der maschinell gelesene Text.' : ''}\n\n` : ''}${hasText ? `<material>\n${pagesText(pages)}\n</material>\n\n` : ''}${genInstruction(meta, tg, { from: 1, to: pages.length }, 1)}`;
}

/* ── 5. Tutor, Erklären, Bewerten ──────────────────────────── */

const TUTOR_SYSTEM = `Du bist ein geduldiger, freundlicher Nachhilfelehrer für einen Schüler der Oberstufe. Grundlage ist sein Unterrichtsmaterial, das am Anfang des Gesprächs steht.
- Antworte in der Sprache der Frage, knapp und anschaulich, mit Beispielen aus dem Alltag, wenn das hilft.
- Markdown ist erlaubt: ## Überschriften, - Listen, **fett**, einfache Tabellen. Formeln in Unicode, kein LaTeX.
- Geht eine Frage über das Material hinaus, sag das in einem Halbsatz und hilf trotzdem.
- Wenn der Schüler etwas falsch verstanden hat, korrigiere es freundlich und klar.
- Bei „Prüfe mich“ oder „Frag mich ab“: stelle EINE Frage, warte auf die Antwort, bewerte sie und stelle dann die nächste.`;

/** Material als erster Block des Gesprächs, mit Cache-Marke: Folgefragen
    lesen es aus dem Cache und kosten so nur einen Bruchteil. */
async function materialBlocks(mat) {
  const blocks = [];
  if (mat.pdfBase64) {
    blocks.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: await mat.pdfBase64() }, title: mat.name });
  } else if (mat.imageBase64) {
    blocks.push({ type: 'image', source: { type: 'base64', media_type: mat.mediaType || 'image/jpeg', data: await mat.imageBase64() } });
  } else {
    blocks.push({ type: 'text', text: `<material name="${mat.name}">\n${mat.text}\n</material>` });
  }
  blocks[blocks.length - 1].cache_control = { type: 'ephemeral' };
  return blocks;
}

/**
 * Tutor-Gespräch. history: [{role:'user'|'assistant', text}] — die letzte
 * Nachricht ist die neue Frage. mat: {name, text | pdfBase64 | imageBase64}
 */
async function tutor(opts, mat, history) {
  const first = await materialBlocks(mat);
  const messages = history.map((h, i) => ({
    role: h.role,
    content: i === 0 ? [...first, { type: 'text', text: h.text }] : h.text,
  }));
  const body = Object.assign(base(opts.model, 'medium', 8000), { system: TUTOR_SYSTEM, messages });
  return call(body, opts);
}

/** Eine Karte erklären: in einfachen Worten, mit Beispiel und Eselsbrücke. */
async function explainCard(opts, card, context) {
  const body = Object.assign(base(opts.model, 'low', 3000), {
    system: 'Du erklärst einem Schüler der Oberstufe eine Karteikarte, die er nicht verstanden hat. Auf Deutsch (oder in der Sprache der Karte), höchstens 150 Wörter, Markdown erlaubt. Aufbau: kurze Erklärung in einfachen Worten, ein Beispiel, zum Schluss eine Eselsbrücke mit „**Merkhilfe:**“. Formeln in Unicode.',
    messages: [{ role: 'user', content: `Karte:\nVorderseite: ${card.front}\nRückseite: ${card.back || '(Lückentext)'}${card.hint ? `\nHinweis: ${card.hint}` : ''}${context ? `\n\nAusschnitt aus dem Unterrichtsmaterial:\n<material>\n${context.slice(0, 6000)}\n</material>` : ''}` }],
  });
  return call(body, opts);
}

const GRADE_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['score', 'verdict', 'feedback', 'missing'],
  properties: {
    score: { type: 'integer', description: '0 bis 100' },
    verdict: { type: 'string', enum: ['right', 'partial', 'wrong'] },
    feedback: { type: 'string', description: 'Kurzes, ermutigendes Feedback, 1–3 Sätze, Du-Form' },
    missing: { type: 'array', items: { type: 'string' }, description: 'Was fehlt oder falsch ist, Stichworte' },
  },
};

/** Freie Antwort (offene Quizfrage, Feynman) bewerten lassen. */
async function gradeAnswer(opts, task) {
  const body = Object.assign(base(opts.model, 'low', 4000), {
    system: task.feynman
      ? 'Du prüfst, ob ein Schüler einen Begriff verstanden hat (Feynman-Methode: er erklärt ihn in eigenen Worten, als würde er ihn einem jüngeren Mitschüler erklären). Bewerte fachliche Richtigkeit und Vollständigkeit, nicht Rechtschreibung oder Stil. Benenne Fehlvorstellungen klar. Antworte als JSON.'
      : 'Du bewertest die Antwort eines Schülers auf eine Klausurfrage anhand der Musterlösung. Bewerte den Inhalt, nicht Rechtschreibung oder Formulierung. Andere, aber fachlich richtige Formulierungen zählen als richtig. Antworte als JSON.',
    messages: [{ role: 'user', content: task.feynman
      ? `Begriff: ${task.term}\nReferenz aus dem Material: ${task.reference}\n\nErklärung des Schülers:\n${task.answer}`
      : `Frage: ${task.question}\nMusterlösung: ${task.reference}\n\nAntwort des Schülers:\n${task.answer}` }],
  });
  body.output_config = Object.assign({}, body.output_config, { format: { type: 'json_schema', schema: GRADE_SCHEMA } });
  const res = await call(body, opts);
  const o = Core.parseLooseJSON(res.text);
  return {
    score: Core.clamp(parseInt(o.score, 10) || 0, 0, 100),
    verdict: ['right', 'partial', 'wrong'].includes(o.verdict) ? o.verdict : 'partial',
    feedback: String(o.feedback || ''),
    missing: Array.isArray(o.missing) ? o.missing.map(String) : [],
    cost: res.cost,
  };
}

return {
  MODELS, DEFAULT_MODEL, AIError, cost, sseParser, stream, call, testKey,
  targets, plan, estimate, generate, chatPrompt, GEN_SCHEMA, GEN_SYSTEM,
  tutor, explainCard, gradeAnswer,
};
})();

if (typeof module === 'object' && module.exports) module.exports = AI;
