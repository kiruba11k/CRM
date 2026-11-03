// Installable app: service worker registration, the "install" prompt and
// new-version detection, exposed as a tiny store for React.
import { useSyncExternalStore } from 'react'

interface BeforeInstallPromptEvent extends Event { prompt: () => Promise<void>; userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }> }
interface State { canInstall: boolean; installed: boolean; updateReady: boolean; ios: boolean }

let deferred: BeforeInstallPromptEvent | null = null
let waiting: ServiceWorker | null = null
const standalone = () => window.matchMedia?.('(display-mode: standalone)').matches || (navigator as unknown as { standalone?: boolean }).standalone === true
let state: State = {
  canInstall: false, installed: typeof window !== 'undefined' && standalone(), updateReady: false,
  ios: typeof navigator !== 'undefined' && /iphone|ipad|ipod/i.test(navigator.userAgent),
}
const subs = new Set<() => void>()
const set = (patch: Partial<State>) => { state = { ...state, ...patch }; subs.forEach((f) => f()) }

export function usePwa(): State {
  return useSyncExternalStore((f) => { subs.add(f); return () => subs.delete(f) }, () => state, () => state)
}

export async function promptInstall(): Promise<boolean> {
  if (!deferred) return false
  await deferred.prompt()
  const { outcome } = await deferred.userChoice
  deferred = null
  set({ canInstall: false, installed: outcome === 'accepted' })
  return outcome === 'accepted'
}

export function applyUpdate(): void {
  if (!waiting) { window.location.reload(); return }
  navigator.serviceWorker.addEventListener('controllerchange', () => window.location.reload(), { once: true })
  waiting.postMessage('skip-waiting')
}

export function registerPwa(): void {
  window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); deferred = e as BeforeInstallPromptEvent; set({ canInstall: true }) })
  window.addEventListener('appinstalled', () => { deferred = null; set({ canInstall: false, installed: true }) })
  if (!('serviceWorker' in navigator) || !import.meta.env.PROD) return
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').then((reg) => {
      const found = (w: ServiceWorker | null) => {
        if (!w) return
        w.addEventListener('statechange', () => {
          if (w.state === 'installed' && navigator.serviceWorker.controller) { waiting = w; set({ updateReady: true }) }
        })
      }
      if (reg.waiting && navigator.serviceWorker.controller) { waiting = reg.waiting; set({ updateReady: true }) }
      reg.addEventListener('updatefound', () => found(reg.installing))
      // Installed apps can stay open for days: look for a new deploy hourly.
      setInterval(() => void reg.update().catch(() => undefined), 60 * 60 * 1000)
    }).catch(() => undefined)
  })
}
