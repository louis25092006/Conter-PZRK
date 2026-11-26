// Lab 8: мінімальний service worker для PWA (встановлення на телефон/комп'ютер).
// - навігація (index.html): спершу мережа (щоб після деплою була свіжа версія), без мережі — кеш;
// - статика (assets/: зібраний JS з хешем у назві, спрайти, звуки, арени): спершу кеш;
// - API, WebSocket, /health, /metrics — НІКОЛИ не кешуємо: це живі дані.
const CACHE = 'conter-pzrk-v1'
const NEVER = ['/api/', '/ws', '/health', '/ready', '/metrics']

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(['./', './manifest.webmanifest'])))
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  // старі версії кешу прибираємо
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  )
})

self.addEventListener('fetch', (event) => {
  const req = event.request
  const url = new URL(req.url)
  if (req.method !== 'GET' || url.origin !== self.location.origin) return
  if (NEVER.some((p) => url.pathname.includes(p))) return

  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone()
          void caches.open(CACHE).then((c) => c.put(req, copy))
          return res
        })
        .catch(() => caches.match(req).then((hit) => hit ?? caches.match('./'))),
    )
    return
  }

  if (url.pathname.includes('/assets/') || url.pathname.includes('/icons/')) {
    event.respondWith(
      caches.match(req).then(
        (hit) =>
          hit ??
          fetch(req).then((res) => {
            if (res.ok) {
              const copy = res.clone()
              void caches.open(CACHE).then((c) => c.put(req, copy))
            }
            return res
          }),
      ),
    )
  }
})
