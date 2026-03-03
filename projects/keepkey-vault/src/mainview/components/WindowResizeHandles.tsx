import { useCallback } from 'react'
import { Box } from '@chakra-ui/react'
import { IS_WINDOWS } from '../lib/platform'
import { rpcRequest, rpcFire } from '../lib/rpc'
import { Z } from '../lib/z-index'

const HANDLE_SIZE = 6
const MIN_WIDTH = 600
const MIN_HEIGHT = 400

type Edge = 'n' | 's' | 'e' | 'w' | 'nw' | 'ne' | 'sw' | 'se'

const CURSOR_MAP: Record<Edge, string> = {
  n: 'ns-resize',
  s: 'ns-resize',
  e: 'ew-resize',
  w: 'ew-resize',
  nw: 'nwse-resize',
  ne: 'nesw-resize',
  sw: 'nesw-resize',
  se: 'nwse-resize',
}

interface HandleDef {
  edge: Edge
  style: React.CSSProperties
}

const HANDLES: HandleDef[] = [
  { edge: 'n',  style: { top: 0, left: HANDLE_SIZE, right: HANDLE_SIZE, height: HANDLE_SIZE } },
  { edge: 's',  style: { bottom: 0, left: HANDLE_SIZE, right: HANDLE_SIZE, height: HANDLE_SIZE } },
  { edge: 'w',  style: { left: 0, top: HANDLE_SIZE, bottom: HANDLE_SIZE, width: HANDLE_SIZE } },
  { edge: 'e',  style: { right: 0, top: HANDLE_SIZE, bottom: HANDLE_SIZE, width: HANDLE_SIZE } },
  { edge: 'nw', style: { top: 0, left: 0, width: HANDLE_SIZE, height: HANDLE_SIZE } },
  { edge: 'ne', style: { top: 0, right: 0, width: HANDLE_SIZE, height: HANDLE_SIZE } },
  { edge: 'sw', style: { bottom: 0, left: 0, width: HANDLE_SIZE, height: HANDLE_SIZE } },
  { edge: 'se', style: { bottom: 0, right: 0, width: HANDLE_SIZE, height: HANDLE_SIZE } },
]

export function WindowResizeHandles() {
  if (!IS_WINDOWS) return null

  const onMouseDown = useCallback((edge: Edge, e: React.MouseEvent) => {
    if (e.button !== 0) return
    e.preventDefault()
    e.stopPropagation()

    const startScreenX = e.screenX
    const startScreenY = e.screenY

    rpcRequest<{ x: number; y: number; width: number; height: number }>('windowGetFrame').then((frame) => {
      const { x: startX, y: startY, width: startW, height: startH } = frame

      const onMove = (ev: MouseEvent) => {
        const dx = ev.screenX - startScreenX
        const dy = ev.screenY - startScreenY

        let x = startX
        let y = startY
        let w = startW
        let h = startH

        if (edge.includes('e')) w = Math.max(MIN_WIDTH, startW + dx)
        if (edge.includes('s')) h = Math.max(MIN_HEIGHT, startH + dy)

        if (edge.includes('w')) {
          const newW = Math.max(MIN_WIDTH, startW - dx)
          x = startX + (startW - newW)
          w = newW
        }
        if (edge.includes('n')) {
          const newH = Math.max(MIN_HEIGHT, startH - dy)
          y = startY + (startH - newH)
          h = newH
        }

        rpcFire('windowSetFrame', { x, y, width: w, height: h })
      }

      const onUp = () => {
        document.removeEventListener('mousemove', onMove)
        document.removeEventListener('mouseup', onUp)
      }

      document.addEventListener('mousemove', onMove)
      document.addEventListener('mouseup', onUp)
    }).catch(() => {})
  }, [])

  return (
    <>
      {HANDLES.map(({ edge, style }) => (
        <Box
          key={edge}
          position="fixed"
          style={{
            ...style,
            cursor: CURSOR_MAP[edge],
            zIndex: Z.nav + 2,
          }}
          onMouseDown={(e: React.MouseEvent) => onMouseDown(edge, e)}
        />
      ))}
    </>
  )
}
