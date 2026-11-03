// "Install the app": the browser's own prompt where there is one (Android,
// desktop Chrome/Edge); step-by-step help on iPhone/iPad and elsewhere.
import { useState } from 'react'
import { promptInstall, usePwa } from '../pwa'

export function useInstall() {
  const pwa = usePwa()
  const [help, setHelp] = useState(false)
  return {
    show: !pwa.installed, ios: pwa.ios, help,
    start: async () => { if (pwa.canInstall) await promptInstall(); else setHelp(true) },
    closeHelp: () => setHelp(false),
  }
}

export function InstallHelp({ ios, onClose }: { ios: boolean; onClose: () => void }) {
  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet install-help" role="dialog" aria-modal="true" aria-label="Install the app" onClick={(e) => e.stopPropagation()}>
        <div className="sheet-grab" aria-hidden="true" />
        <div className="row" style={{ gap: 12 }}>
          <img src="/icons/icon-192.png" alt="" width={48} height={48} style={{ borderRadius: 12 }} />
          <div><strong style={{ fontSize: 17 }}>Install LeadStrategus CRM</strong><br /><span className="muted small">Opens full screen from your home screen, like any app.</span></div>
        </div>
        {ios ? (
          <ol className="install-steps">
            <li>Open this page in <strong>Safari</strong>.</li>
            <li>Tap the <strong>Share</strong> button <span aria-hidden="true" className="install-glyph">⬆︎</span> at the bottom of the screen.</li>
            <li>Scroll down and tap <strong>Add to Home Screen</strong>, then <strong>Add</strong>.</li>
          </ol>
        ) : (
          <ol className="install-steps">
            <li><strong>Android (Chrome):</strong> tap the <strong>⋮</strong> menu, then <strong>Install app</strong> or <strong>Add to Home screen</strong>.</li>
            <li><strong>Computer (Chrome or Edge):</strong> click the install icon at the right end of the address bar, or the menu → <strong>Install LeadStrategus CRM</strong>.</li>
          </ol>
        )}
        <button type="button" className="btn btn-dark" onClick={onClose}>Got it</button>
      </div>
    </div>
  )
}
