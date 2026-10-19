/* Service Worker — Lernapp offline verfügbar halten.

   Zwei Caches:
   - CACHE   die App selbst. Bei JEDER Änderung an den Dateien hochzählen,
             sonst liefert der Worker die alte Fassung weiter.
   - VENDOR  PDF.js (~6 MB). Ändert sich nur mit einer neuen PDF.js-Version
             und heißt deshalb nach ihr — so lädt nicht jedes App-Update die
             6 MB noch einmal herunter.
   Dazu 'lernapp-share' als Zwischenablage für Dateien, die über das
   Teilen-Menü von Android hereinkommen (siehe unten). */
const CACHE = 'lernapp-v1';
const VENDOR = 'lernapp-pdfjs-6.4.299';
const SHARE = 'lernapp-share';

const ASSETS = [
  './', './index.html', './style.css', './core.js', './ai.js', './app.js', './manifest.webmanifest',
  './icons/icon-192.png', './icons/icon-512.png', './icons/icon-maskable-512.png',
];

/* Alles, was PDF.js zur Laufzeit nachlädt: Schriften für PDFs ohne
   eingebettete Schrift, Zeichentabellen für asiatische Schriften (gebündelt
   in cmaps.bin, siehe unten), Decoder für JPEG 2000 / JBIG2 (häufig in
   Scans) und ein Farbprofil für CMYK. */
const FONTS = [
  'FoxitDingbats.pfb', 'FoxitFixed.pfb', 'FoxitFixedBold.pfb', 'FoxitFixedBoldItalic.pfb', 'FoxitFixedItalic.pfb',
  'FoxitSerif.pfb', 'FoxitSerifBold.pfb', 'FoxitSerifBoldItalic.pfb', 'FoxitSerifItalic.pfb', 'FoxitSymbol.pfb',
  'LiberationSans-Regular.ttf', 'LiberationSans-Bold.ttf', 'LiberationSans-Italic.ttf', 'LiberationSans-BoldItalic.ttf',
];
const VENDOR_ASSETS = [
  './vendor/pdfjs/pdf.mjs', './vendor/pdfjs/pdf.worker.mjs',
  './vendor/pdfjs/wasm/openjpeg.wasm', './vendor/pdfjs/wasm/jbig2.wasm', './vendor/pdfjs/wasm/qcms_bg.wasm',
  './vendor/pdfjs/iccs/CGATS001Compat-v2-micro.icc',
  './vendor/pdfjs/cmaps.bin',
  ...FONTS.map((f) => './vendor/pdfjs/standard_fonts/' + f),
];

/* Zeichentabellen: PDF.js fragt einzelne Dateien an (cmaps/Name.bcmap), sie
   liegen aber gebündelt in cmaps.bin — der Upload über die GitHub-Weboberfläche
   nimmt nur 100 Dateien auf einmal, PDF.js bringt allein 168 Tabellen mit.
   Format und Erzeugung: vendor/pack-cmaps.py. */
let cmapPack = null;
function loadCmapPack() {
  if (!cmapPack) {
    cmapPack = caches.open(VENDOR).then(async (c) => {
      const url = './vendor/pdfjs/cmaps.bin';
      let res = await c.match(url);
      if (!res) {
        res = await fetch(url);
        if (!res.ok) throw new Error('cmaps.bin fehlt');
        await c.put(url, res.clone());
      }
      const buf = await res.arrayBuffer();
      const n = new DataView(buf).getUint32(0, true);
      const index = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 4, n)));
      return { buf, base: 4 + n, index };
    }).catch((e) => { cmapPack = null; throw e; });
  }
  return cmapPack;
}
async function cmapResponse(name) {
  const p = await loadCmapPack();
  const e = p.index[name];
  if (!e) return new Response('', { status: 404 });
  return new Response(p.buf.slice(p.base + e[0], p.base + e[0] + e[1]),
    { headers: { 'Content-Type': 'application/octet-stream' } });
}

self.addEventListener('install', (e) => {
  // cache:'reload' erzwingt frische Dateien vom Server. Ohne das würden sie aus
  // dem HTTP-Cache des Browsers geholt (GitHub Pages sendet max-age=600) — der
  // neue Cache enthielte dann die alte Version.
  const fill = (name, list) => caches.open(name)
    .then((c) => c.addAll(list.map((u) => new Request(u, { cache: 'reload' }))));
  e.waitUntil(
    Promise.all([
      fill(CACHE, ASSETS),
      // PDF.js nur laden, wenn diese Version noch nicht im Cache liegt
      caches.has(VENDOR).then((has) => (has ? null : fill(VENDOR, VENDOR_ASSETS))),
    ]).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  // Nur eigene alte Caches löschen: Alle Apps unter <name>.github.io teilen sich
  // einen Cache-Speicher — ohne den Präfix-Filter flöge deren Offline-Fassung mit raus.
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys
        .filter((k) => k.startsWith('lernapp-') && k !== CACHE && k !== VENDOR && k !== SHARE)
        .map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

/* Teilen-Ziel (manifest: share_target). Android schickt die Dateien als
   POST an ./share-target. Eine statische Seite auf GitHub Pages kann POST
   nicht beantworten — deshalb fängt der Worker ihn ab, legt die Dateien im
   Cache ab und leitet auf die App um, die sie dort abholt. */
async function handleShare(req) {
  try {
    const form = await req.formData();
    const files = form.getAll('files').filter((f) => f && typeof f === 'object' && 'size' in f);
    const c = await caches.open(SHARE);
    let i = 0;
    for (const f of files) {
      await c.put(new Request(`./shared/${Date.now()}-${i++}`), new Response(f, {
        headers: { 'content-type': f.type || 'application/octet-stream', 'x-name': encodeURIComponent(f.name || 'Geteilt') },
      }));
    }
  } catch (e) { /* dann kommt die App eben ohne Dateien hoch */ }
  return Response.redirect(new URL('./?share=1', self.registration.scope).href, 303);
}

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (url.origin !== location.origin) return;            // Claude-API & Co.: der Browser macht das selbst

  if (e.request.method === 'POST' && url.pathname.endsWith('/share-target')) {
    e.respondWith(handleShare(e.request));
    return;
  }
  if (e.request.method !== 'GET') return;

  const cm = url.pathname.match(/\/vendor\/pdfjs\/cmaps\/([^/]+)\.bcmap$/);
  if (cm) {
    e.respondWith(cmapResponse(decodeURIComponent(cm[1])).catch(() => new Response('', { status: 404 })));
    return;
  }

  /* PDF.js ändert sich innerhalb einer Version nie: Cache zuerst, kein
     Nachladen im Hintergrund. */
  if (url.pathname.includes('/vendor/pdfjs/')) {
    e.respondWith(
      caches.open(VENDOR).then((c) => c.match(e.request).then((hit) => hit || fetch(e.request).then((res) => {
        if (res && res.ok) c.put(e.request, res.clone());
        return res;
      })))
    );
    return;
  }

  /* Nur die eigenen Dateien anfassen. Andere Apps auf derselben Domain
     (…/reader/, …/dashboard/) liegen außerhalb des Scopes und kommen hier
     gar nicht vorbei; Seitenaufrufe mit ?share=1 bekommen die Startseite. */
  const own = new URL(self.registration.scope);
  if (!url.pathname.startsWith(own.pathname)) return;
  const key = url.pathname === own.pathname ? './' : e.request;

  /* App-Dateien: Stale-while-revalidate — sofort aus dem Cache liefern, im
     Hintergrund aktualisieren. */
  e.respondWith(
    caches.open(CACHE).then((c) => c.match(key, { ignoreSearch: true }).then((hit) => {
      const net = fetch(e.request).then((res) => {
        // Umgeleitete Antworten nicht cachen: Chrome lehnt sie für Seitenaufrufe ab
        if (res && res.ok && !res.redirected && !url.search) c.put(key, res.clone());
        return res;
      });
      if (hit) { e.waitUntil(net.catch(() => {})); return hit; }
      return net;
    }))
  );
});
