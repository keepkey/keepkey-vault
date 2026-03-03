import { useCallback } from 'react'
import { IS_WINDOWS } from '../lib/platform'
import { rpcRequest, rpcFire } from '../lib/rpc'

const INTERACTIVE = 'button,a,input,textarea,select,[role="button"],[data-no-drag]'

export interface WindowDragHandlers {
  onMouseDown: (e: React.MouseEvent) => void
}

/**
 * Custom window drag for Windows — returns null on macOS (use Electrobun class instead).
 *
 * On mousedown in the drag region, captures the initial window frame and mouse
 * screen position, then tracks mousemove on `document` to fire-and-forget
 * `windowSetFrame` calls (keeping width/height constant). Uses setFrame instead
 * of setPosition because Electrobun's setWindowPosition FFI is broken on
 * Windows WS_POPUP windows while setWindowFrame works correctly.
 */
export function useWindowDrag(): WindowDragHandlers | null {
  const onMouseDown = useCallback((e: React.MouseEvent) => {
    // Only primary button
    if (e.button !== 0) return
    // Don't drag from interactive elements
    if ((e.target as HTMLElement).closest?.(INTERACTIVE)) return

    e.preventDefault()
    e.stopPropagation()

    const startScreenX = e.screenX
    const startScreenY = e.screenY

    rpcRequest<{ x: number; y: number; width: number; height: number }>('windowGetFrame').then((frame) => {
      const startX = frame.x
      const startY = frame.y
      const w = frame.width
      const h = frame.height

      const onMove = (ev: MouseEvent) => {
        const dx = ev.screenX - startScreenX
        const dy = ev.screenY - startScreenY
        rpcFire('windowSetFrame', { x: startX + dx, y: startY + dy, width: w, height: h })
      }

      const onUp = () => {
        document.removeEventListener('mousemove', onMove)
        document.removeEventListener('mouseup', onUp)
      }

      document.addEventListener('mousemove', onMove)
      document.addEventListener('mouseup', onUp)
    }).catch(() => {
      // RPC unavailable (dev mode) — ignore
    })
  }, [])

  if (!IS_WINDOWS) return null
  return { onMouseDown }
}
