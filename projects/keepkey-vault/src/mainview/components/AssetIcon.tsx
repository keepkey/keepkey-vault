/**
 * AssetIcon — Token logo with optional network badge.
 *
 * For tokens, pass `chainCaip` to render a small chain-logo badge in the
 * bottom-right corner — distinguishes e.g. USDT-on-ETH from USDT-on-TRON.
 * For native assets, omit `chainCaip` (or pass it equal to `caip`) and the
 * badge is suppressed (it would just duplicate the main logo).
 *
 * The badge is also auto-suppressed below `size={24}` since it would render
 * as visual mush at very small sizes.
 */
import { Box, Image } from "@chakra-ui/react"
import { caipToIcon, getAssetIcon } from "../../shared/assetLookup"

interface AssetIconProps {
  /** Asset CAIP (token CAIP for ERC-20s, chain CAIP for natives) */
  caip?: string
  /** Direct icon URL — wins over `caip` lookup when provided */
  iconUrl?: string
  /** Chain CAIP for the network badge. Omit for natives; omit to suppress. */
  chainCaip?: string
  /** Pixel size of the main icon */
  size: number
  /** Accessible alt text */
  alt?: string
  /** Optional ring color override (default: subtle white) */
  ring?: string
}

const FALLBACK_BG = "rgba(255,255,255,0.06)"

export function AssetIcon({ caip, iconUrl, chainCaip, size, alt, ring }: AssetIconProps) {
  const mainSrc = iconUrl || (caip ? getAssetIcon(caip) : undefined)
  const showBadge = !!chainCaip && chainCaip !== caip && size >= 24
  const badgeSize = Math.max(12, Math.round(size * 0.38))

  return (
    <Box position="relative" display="inline-flex" flexShrink={0} w={`${size}px`} h={`${size}px`}>
      <Image
        src={mainSrc}
        alt={alt || ""}
        w={`${size}px`}
        h={`${size}px`}
        borderRadius="full"
        bg={FALLBACK_BG}
        border={ring ? `2px solid ${ring}` : "2px solid rgba(255,255,255,0.08)"}
        onError={(e: any) => { (e.target as HTMLImageElement).style.visibility = 'hidden' }}
      />
      {showBadge && (
        <Image
          src={caipToIcon(chainCaip!)}
          alt=""
          position="absolute"
          right="-2px"
          bottom="-2px"
          w={`${badgeSize}px`}
          h={`${badgeSize}px`}
          borderRadius="full"
          bg="kk.bg"
          border="2px solid"
          borderColor="kk.bg"
          onError={(e: any) => { (e.target as HTMLImageElement).style.visibility = 'hidden' }}
        />
      )}
    </Box>
  )
}
