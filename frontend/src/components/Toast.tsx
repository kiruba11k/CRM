// Small toasts for confirmations ("Moved to Negotiation") with an optional
// action such as Undo. They slide in, stack bottom-right and fade after 4.5s.
import { createContext, useCallback, useContext, useState, type ReactNode } from 'react'

interface Toast { id: number; text: string; kind: 'ok' | 'err'; action?: { label: string; run: () => void } }
type Push = (text: string, opts?: { kind?: 'ok' | 'err'; action?: Toast['action'] }) => void

const ToastCtx = createContext<Push>(() => undefined)
let seq = 0

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([])
  const close = useCallback((id: number) => setToasts((t) => t.filter((x) => x.id !== id)), [])
  const push = useCallback<Push>((text, opts) => {
    const id = ++seq
    setToasts((t) => [...t.slice(-3), { id, text, kind: opts?.kind || 'ok', action: opts?.action }])
    window.setTimeout(() => close(id), 4500)
  }, [close])
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast${t.kind === 'err' ? ' err' : ''}`}>
            <span>{t.text}</span>
            <span className="row" style={{ gap: 10, flexWrap: 'nowrap' }}>
              {t.action && <button type="button" className="undo" onClick={() => { t.action?.run(); close(t.id) }}>{t.action.label}</button>}
              <button type="button" aria-label="Dismiss" onClick={() => close(t.id)}>×</button>
            </span>
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  )
}

export const useToast = () => useContext(ToastCtx)
