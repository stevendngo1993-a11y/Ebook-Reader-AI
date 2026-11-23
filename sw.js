/* Steven N. Ebook — Offline App-Shell, Low-RAM Range-Streaming & Sharded Dictionary Service Worker (GitHub Pages subpath-safe) */
const CACHE_VERSION = 'steven-ebook-shell-v11';
const RUNTIME_CACHE = 'steven-ebook-runtime-v11';
const DICT_CACHE = 'steven-ebook-dict-v1';

const RA_STREAM_MARKER = '/__read_along_audio__/';
const RA_DB_NAME = 'lumina_epub_db';
const RA_AUDIO_STORE = 'audiobooks';
const RA_MAX_CHUNK_BYTES = 512 * 1024; // 512 KB cap per Range chunk prevents iOS Safari AVFoundation OOM crashes

const APP_SHELL_URLS = [
  './',
  './index.html',
  './manifest.webmanifest',
  './icon-180.png',
  './icon-192.png',
  './icon-512.png'
];

const CACHEABLE_CDN_HOSTS = new Set([
  'cdn.tailwindcss.com',
  'cdn.jsdelivr.net',
  'fonts.googleapis.com',
  'fonts.gstatic.com'
]);

let swAudioDb = null;
let cachedAudioRef = null;
let cachedAudioEvictTimer = null;

function clearCachedAudioRef(trackId) {
  if (!trackId || (cachedAudioRef && cachedAudioRef.id === trackId)) {
    cachedAudioRef = null;
  }
  if (!cachedAudioRef && cachedAudioEvictTimer) {
    clearTimeout(cachedAudioEvictTimer);
    cachedAudioEvictTimer = null;
  }
}

function scheduleAudioRefEviction() {
  if (cachedAudioEvictTimer) clearTimeout(cachedAudioEvictTimer);
  cachedAudioEvictTimer = setTimeout(() => {
    cachedAudioRef = null;
    cachedAudioEvictTimer = null;
  }, 90000);
}

function openSwAudioDb() {
  if (swAudioDb) return Promise.resolve(swAudioDb);
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(RA_DB_NAME);
    req.onsuccess = () => {
      const db = req.result;
      swAudioDb = db;
      db.onclose = () => { if (swAudioDb === db) swAudioDb = null; };
      db.onversionchange = () => {
        try { db.close(); } catch (_) {}
        if (swAudioDb === db) swAudioDb = null;
        clearCachedAudioRef();
      };
      resolve(db);
    };
    req.onerror = () => reject(req.error || new Error('IndexedDB open failed'));
  });
}

function resolveSafeAudioMime(fileName, mimeType) {
  const lower = String(fileName || '').toLowerCase();
  if (lower.endsWith('.m4b') || lower.endsWith('.m4a')) return 'audio/mp4';
  if (lower.endsWith('.wav')) return 'audio/wav';
  if (lower.endsWith('.ogg') || lower.endsWith('.opus')) return 'audio/ogg';
  if (lower.endsWith('.flac')) return 'audio/flac';
  if (mimeType && mimeType !== 'application/octet-stream') return mimeType;
  return 'audio/mpeg';
}

async function getSwAudioEntry(trackId) {
  if (cachedAudioRef && cachedAudioRef.id === trackId && cachedAudioRef.blob) {
    scheduleAudioRefEviction();
    return cachedAudioRef;
  }
  const db = await openSwAudioDb();
  if (!db.objectStoreNames.contains(RA_AUDIO_STORE)) return null;
  const rec = await new Promise((resolve, reject) => {
    const tx = db.transaction(RA_AUDIO_STORE, 'readonly');
    const getReq = tx.objectStore(RA_AUDIO_STORE).get(trackId);
    getReq.onsuccess = () => resolve(getReq.result || null);
    getReq.onerror = () => reject(getReq.error);
  });
  if (!rec || !rec.audioBlob) return null;
  const mimeType = resolveSafeAudioMime(rec.fileName, rec.mimeType || rec.audioBlob.type);
  cachedAudioRef = {
    id: trackId,
    blob: rec.audioBlob,
    mimeType,
    size: rec.audioBlob.size
  };
  scheduleAudioRefEviction();
  return cachedAudioRef;
}

async function handleReadAlongStreamRequest(req, trackId) {
  try {
    const entry = await getSwAudioEntry(trackId);
    if (!entry || !entry.blob || !entry.size) {
      return new Response('Audio track not found', {
        status: 404,
        headers: { 'Cache-Control': 'no-store', 'X-RA-Stream': '1' }
      });
    }

    const totalSize = entry.size;
    const mimeType = entry.mimeType;

    if (req.method === 'HEAD') {
      return new Response(null, {
        status: 200,
        headers: {
          'Content-Type': mimeType,
          'Content-Length': String(totalSize),
          'Accept-Ranges': 'bytes',
          'Cache-Control': 'no-store',
          'X-RA-Stream': '1'
        }
      });
    }

    const rangeHeader = req.headers.get('range');
    if (rangeHeader) {
      const m = /bytes=(\d*)-(\d*)/i.exec(rangeHeader);
      if (!m) {
        return new Response('Invalid Range', {
          status: 416,
          headers: { 'Content-Range': `bytes */${totalSize}`, 'Cache-Control': 'no-store' }
        });
      }
      let start = 0;
      let end = totalSize - 1;
      if (m[1] === '' && m[2] !== '') {
        const suffixLen = Math.min(totalSize, Math.max(1, Number(m[2]) || 0));
        start = Math.max(0, totalSize - suffixLen);
        end = totalSize - 1;
      } else {
        start = Number(m[1]) || 0;
        if (m[2] !== '') {
          end = Math.min(totalSize - 1, Number(m[2]));
        } else {
          end = Math.min(totalSize - 1, start + RA_MAX_CHUNK_BYTES - 1);
        }
      }
      if (start < 0 || start >= totalSize || end < start) {
        return new Response('Range Not Satisfiable', {
          status: 416,
          headers: { 'Content-Range': `bytes */${totalSize}`, 'Cache-Control': 'no-store' }
        });
      }
      // Always cap response window to 512 KB so iOS AVFoundation streams on demand without blowing RAM
      if (end - start + 1 > RA_MAX_CHUNK_BYTES) {
        end = start + RA_MAX_CHUNK_BYTES - 1;
      }
      const chunkLen = end - start + 1;
      const chunkBlob = entry.blob.slice(start, end + 1, mimeType);
      return new Response(chunkBlob, {
        status: 206,
        statusText: 'Partial Content',
        headers: {
          'Content-Type': mimeType,
          'Accept-Ranges': 'bytes',
          'Content-Range': `bytes ${start}-${end}/${totalSize}`,
          'Content-Length': String(chunkLen),
          'Cache-Control': 'no-store',
          'X-RA-Stream': '1'
        }
      });
    }

    // Non-Range GET: small files return directly; large files stream in 256 KB slices to avoid RAM spikes
    if (totalSize <= 2 * 1024 * 1024) {
      return new Response(entry.blob, {
        status: 200,
        headers: {
          'Content-Type': mimeType,
          'Accept-Ranges': 'bytes',
          'Content-Length': String(totalSize),
          'Cache-Control': 'no-store',
          'X-RA-Stream': '1'
        }
      });
    }

    let offset = 0;
    const STREAM_SLICE = 256 * 1024;
    const blobRef = entry.blob;
    const stream = new ReadableStream({
      async pull(controller) {
        if (offset >= totalSize) {
          controller.close();
          return;
        }
        const nextEnd = Math.min(totalSize, offset + STREAM_SLICE);
        const buf = await blobRef.slice(offset, nextEnd).arrayBuffer();
        offset = nextEnd;
        controller.enqueue(new Uint8Array(buf));
      }
    });
    return new Response(stream, {
      status: 200,
      headers: {
        'Content-Type': mimeType,
        'Accept-Ranges': 'bytes',
        'Content-Length': String(totalSize),
        'Cache-Control': 'no-store',
        'X-RA-Stream': '1'
      }
    });
  } catch (err) {
    return new Response(`Stream error: ${err && err.message ? err.message : 'unknown'}`, {
      status: 500,
      headers: { 'Cache-Control': 'no-store', 'X-RA-Stream': '1' }
    });
  }
}

self.addEventListener('message', (event) => {
  const data = event.data || {};
  if (data.type === 'RA_EVICT_CACHE') {
    clearCachedAudioRef(data.trackId || null);
  } else if (data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION)
      .then((cache) => cache.addAll(APP_SHELL_URLS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys
          .filter((k) => k !== CACHE_VERSION && k !== RUNTIME_CACHE && k !== DICT_CACHE)
          .map((k) => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET' && req.method !== 'HEAD') return;

  let url;
  try {
    url = new URL(req.url);
  } catch (_) {
    return;
  }

  // Only handle http/https requests
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return;

  const isSameOrigin = url.origin === self.location.origin;

  // Low-RAM Range-streamed local audiobook route (bypasses iOS Safari blob: URL memory crashes)
  if (isSameOrigin) {
    const markerIdx = url.pathname.indexOf(RA_STREAM_MARKER);
    if (markerIdx !== -1) {
      const encodedId = url.pathname.slice(markerIdx + RA_STREAM_MARKER.length);
      let trackId = encodedId;
      try { trackId = decodeURIComponent(encodedId); } catch (_) {}
      event.respondWith(handleReadAlongStreamRequest(req, trackId));
      return;
    }
  }

  if (req.method !== 'GET') return;

  // Built-in sharded offline dictionary (.json.gz & manifest.json): Cache-First in persistent DICT_CACHE
  if (isSameOrigin && url.pathname.includes('/dict/')) {
    event.respondWith(
      caches.open(DICT_CACHE).then((cache) =>
        cache.match(req).then((cached) => {
          if (cached) return cached;
          return fetch(req).then((res) => {
            if (res && res.ok) {
              cache.put(req, res.clone()).catch(() => {});
            }
            return res;
          });
        })
      )
    );
    return;
  }

  // Same-origin navigation / HTML: Network-first with offline cache fallback
  if (isSameOrigin && (req.mode === 'navigate' || url.pathname.endsWith('/') || url.pathname.endsWith('/index.html'))) {
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res && res.ok) {
            const copy = res.clone();
            caches.open(CACHE_VERSION).then((c) => c.put('./index.html', copy)).catch(() => {});
          }
          return res;
        })
        .catch(() => caches.match('./index.html').then((cached) => cached || caches.match('./')))
    );
    return;
  }

  // Same-origin app shell static files (manifest, icons): Cache-first with background refresh
  if (isSameOrigin) {
    event.respondWith(
      caches.match(req).then((cached) => {
        const networkFetch = fetch(req).then((res) => {
          if (res && res.ok) {
            const copy = res.clone();
            caches.open(CACHE_VERSION).then((c) => c.put(req, copy)).catch(() => {});
          }
          return res;
        }).catch(() => cached);
        return cached || networkFetch;
      })
    );
    return;
  }

  // Whitelisted CDN assets (Tailwind, JSZip, Google Fonts): Stale-while-revalidate for offline reading
  if (CACHEABLE_CDN_HOSTS.has(url.hostname)) {
    event.respondWith(
      caches.open(RUNTIME_CACHE).then((cache) =>
        cache.match(req).then((cached) => {
          const networkFetch = fetch(req).then((res) => {
            if (res && (res.ok || res.type === 'opaque')) {
              cache.put(req, res.clone()).catch(() => {});
            }
            return res;
          }).catch(() => cached);
          return cached || networkFetch;
        })
      )
    );
  }
});
