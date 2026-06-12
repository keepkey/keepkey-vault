/**
 * ChainLogo — network logo via the same keepkey.info CDN the dashboard uses
 * (getAssetIcon by CAIP). Used by the Audit wizard's filmstrip stepper + cards.
 */
import { Box, Image } from "@chakra-ui/react"
import { getAssetIcon } from "../../shared/assetLookup"

interface ChainLogoProps {
  caip?: string
  symbol: string
  size?: number
  /** Ring color (status). Null = no ring. */
  ring?: string | null
  /** Dim un-visited/pending chains. */
  dim?: boolean
  /** Pulsing ring while scanning this chain. */
  scanning?: boolean
  /** Small check badge for visited/cleared chains. */
  done?: boolean
}

export function ChainLogo({ caip, symbol, size = 28, ring, dim, scanning, done }: ChainLogoProps) {
  return (
    <Box position="relative" w={`${size}px`} h={`${size}px`} flexShrink={0}>
      <Box
        w="100%" h="100%" borderRadius="full"
        boxShadow={ring ? `0 0 0 2px ${ring}` : undefined}
        opacity={dim ? 0.4 : 1}
        transition="opacity 0.2s, box-shadow 0.2s"
        css={scanning ? { animation: "auditPulse 1.4s ease-in-out infinite" } : undefined}
      >
        {caip
          ? <Image src={getAssetIcon(caip)} alt={symbol} w="100%" h="100%" borderRadius="full" bg="var(--ink-2)" />
          : <Box w="100%" h="100%" borderRadius="full" bg="var(--ink-2)" display="flex" alignItems="center" justifyContent="center" fontSize="9px" color="kk.textMuted">{symbol.slice(0, 3)}</Box>}
      </Box>
      {done && (
        <Box position="absolute" bottom="-2px" right="-2px" w={`${Math.round(size * 0.45)}px`} h={`${Math.round(size * 0.45)}px`}
          borderRadius="full" bg="var(--teal)" display="flex" alignItems="center" justifyContent="center" border="1.5px solid" borderColor="kk.cardBg">
          <svg width="60%" height="60%" viewBox="0 0 24 24" fill="none" stroke="black" strokeWidth="4"><polyline points="20 6 9 17 4 12" /></svg>
        </Box>
      )}
    </Box>
  )
}
