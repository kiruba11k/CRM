/* LeadStrategus CRM service worker.
 * Keeps the app shell (HTML, JS, CSS, icons, fonts) on the device so the
 * installed app opens instantly. CRM data is never cached: API calls go to
 * another origin and are left alone, so what you see is always live.
 * A new deploy installs alongside; the page offers "Refresh" to switch. */
const VERSION = 'v1'
const SHELL = `ls-crm-shell-${VERSION}`
const RUNTIME = `ls-crm-runtime-${VERSION}`
const PRECACHE = ['/', '/index.html', '/manifest.webmanifest', '/icons/icon-192.png', '/icons/icon-512.png', '/icons/favicon-32.png']

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(SHELL).then((c) => c.addAll(PRECACHE)))
})

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keep = new Set([SHELL, RUNTIME])
    for (const k of await caches.keys()) if (!keep.has(k)) await caches.delete(k)
    await self.clients.claim()
  })())
})

self.addEventListener('message', (event) => {
  if (event.data === 'skip-waiting') self.skipWaiting()
})

self.addEventListener('fetch', (event) => {
  const req = event.request
  if (req.method !== 'GET') return
  const url = new URL(req.url)
  const sameOrigin = url.origin === self.location.origin
  const isFont = url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com'
  if (!sameOrigin && !isFont) return          // the CRM API and Google sign-in: always network

  // Pages: network first (fresh deploys win), the cached shell when offline.
  if (req.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const res = await fetch(req)
        const c = await caches.open(SHELL)
        c.put('/index.html', res.clone())
        return res
      } catch {
        return (await caches.match('/index.html')) || (await caches.match('/')) || Response.error()
      }
    })())
    return
  }

  // Hashed build files, icons and fonts never change under the same URL: cache first.
  if (url.pathname.startsWith('/assets/') || url.pathname.startsWith('/icons/') || isFont) {
    event.respondWith((async () => {
      const hit = await caches.match(req)
      if (hit) return hit
      const res = await fetch(req)
      if (res.ok || res.type === 'opaque') (await caches.open(RUNTIME)).put(req, res.clone())
      return res
    })())
  }
})
