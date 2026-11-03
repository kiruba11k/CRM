// Offline and "new version" notices for the installed app.
import { useEffect, useState } from 'react'
import { applyUpdate, usePwa } from '../pwa'

export default function AppNotices() {
  const { updateReady } = usePwa()
  const [online, setOnline] = useState(typeof navigator === 'undefined' ? true : navigator.onLine)
  useEffect(() => {
    const up = () => setOnline(true), down = () => setOnline(false)
    window.addEventListener('online', up); window.addEventListener('offline', down)
    return () => { window.removeEventListener('online', up); window.removeEventListener('offline', down) }
  }, [])
  return (
    <>
      {!online && <div className="app-notice offline" role="status">You’re offline. What’s on screen may be out of date; changes can’t be saved until you’re back online.</div>}
      {updateReady && (
        <div className="app-notice update" role="status">
          <span>A new version of the CRM is ready.</span>
          <button type="button" className="btn btn-dark" onClick={applyUpdate}>Refresh</button>
        </div>
      )}
    </>
  )
}
