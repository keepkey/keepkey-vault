import { Box } from "@chakra-ui/react"

/** FNV-1a 32-bit — synchronous, zero-dep, deterministic. */
function fnv1a(str: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i)
    // 32-bit FNV prime (0x01000193) via shifts to avoid float-precision loss.
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0
  }
  return h >>> 0
}

interface Props {
  /** What the avatar identifies. Pass a deviceId for own-wallet entries (so every
   *  address on one device shares an avatar) or an address for external contacts. */
  seed: string
  size?: number
}

/** GitHub-style 5×5 mirrored-grid identicon, derived deterministically from the
 *  seed. Pure inline SVG — no library, works for any string (deviceId, 0x addr,
 *  bech32, base58, xpub …) which R3 requires. */
export function AddressIdenticon({ seed: rawSeed, size = 28 }: Props) {
  const seed = (rawSeed || "?").toLowerCase()
  const hCells = fnv1a(seed)
  const hColor = fnv1a(seed + "#c")

  const hue = hColor % 360
  const sat = 55 + ((hColor >> 9) & 0x1f)    // 55–86%
  const light = 48 + ((hColor >> 14) & 0x0f) // 48–63%
  const fg = `hsl(${hue} ${sat}% ${light}%)`

  const CELL = 5 // viewBox units per cell (5×5 grid → 25×25)
  const rects: JSX.Element[] = []
  for (let col = 0; col < 3; col++) {
    for (let row = 0; row < 5; row++) {
      if (((hCells >> (col * 5 + row)) & 1) === 0) continue
      const mirror = 4 - col // 0→4, 1→3, 2→center
      rects.push(<rect key={`${col}-${row}`} x={col * CELL} y={row * CELL} width={CELL} height={CELL} fill={fg} />)
      if (mirror !== col) rects.push(<rect key={`m-${col}-${row}`} x={mirror * CELL} y={row * CELL} width={CELL} height={CELL} fill={fg} />)
    }
  }

  return (
    <Box w={`${size}px`} h={`${size}px`} borderRadius="6px" overflow="hidden" flexShrink={0}
         bg="rgba(255,255,255,0.05)" border="1px solid rgba(255,255,255,0.08)">
      <svg width={size} height={size} viewBox="0 0 25 25" shapeRendering="crispEdges">
        {rects}
      </svg>
    </Box>
  )
}
