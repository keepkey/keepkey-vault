import { useEffect, useState } from 'react'
import type { AppSettings } from '../../shared/types'
import { rpcRequest } from '../lib/rpc'

/** Runtime flag; both enable and disable propagate before the drawer closes. */
export function usePasskeysEnabled() {
  const [enabled, setEnabled] = useState(false)
  useEffect(() => {
    let active = true, revision = 0
    const refresh = async () => {
      const current = ++revision
      try {
        const settings = await rpcRequest<AppSettings>('getAppSettings')
        if (active && current === revision) setEnabled(settings.passkeysEnabled === true)
      } catch { if (active && current === revision) setEnabled(false) }
    }
    void refresh()
    window.addEventListener('keepkey-settings-changed', refresh)
    return () => { active = false; window.removeEventListener('keepkey-settings-changed', refresh) }
  }, [])
  return enabled
}
