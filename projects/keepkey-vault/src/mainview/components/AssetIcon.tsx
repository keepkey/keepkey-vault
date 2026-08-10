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
import { useEffect, useMemo, useState } from "react"
import { Box, Image, Text } from "@chakra-ui/react"
import { caipToIcon, getAssetIcon, isBundledAssetIcon } from "../../shared/assetLookup"

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

/** Render a clean letter-bubble fallback when the icon image fails to load.
 *  We never use `alt` text as the visible fallback — the browser default for
 *  broken images is to render the alt text raw, which on a fixed-size circular
 *  bubble clips ugly (e.g. "USDT" → "JSDT" with the U cut off). Using a
 *  positioned <Text> with overflow:hidden + the symbol initial gives a
 *  predictable shape at every size. */
export function AssetIcon({ caip, iconUrl, chainCaip, size, alt, ring }: AssetIconProps) {
  const lookupSrc = caip ? getAssetIcon(caip) : undefined
  const mainSources = useMemo(() => {
    // Packaged assets win over remote metadata. For uncatalogued assets, try
    // the metadata URL first and then KeepKey's CAIP-derived CDN URL.
    const candidates = isBundledAssetIcon(lookupSrc)
      ? [lookupSrc, iconUrl]
      : [iconUrl, lookupSrc]
    return candidates.filter((item, index): item is string =>
      !!item && candidates.indexOf(item) === index)
  }, [iconUrl, lookupSrc])
  const showBadge = !!chainCaip && chainCaip !== caip && size >= 24
  const badgeSize = Math.max(12, Math.round(size * 0.38))
  const [mainAttempt, setMainAttempt] = useState(0)
  const [badgeBroken, setBadgeBroken] = useState(false)
  const initial = (alt || '?').trim().charAt(0).toUpperCase() || '?'
  const mainSrc = mainSources[mainAttempt]

  useEffect(() => { setMainAttempt(0) }, [caip, iconUrl])
  useEffect(() => { setBadgeBroken(false) }, [chainCaip])

  return (
    <Box position="relative" display="inline-flex" flexShrink={0} w={`${size}px`} h={`${size}px`}>
      <Box
        w={`${size}px`}
        h={`${size}px`}
        borderRadius="full"
        bg={FALLBACK_BG}
        border={ring ? `2px solid ${ring}` : "2px solid rgba(255,255,255,0.08)"}
        overflow="hidden"
        display="flex"
        alignItems="center"
        justifyContent="center"
        position="relative"
      >
        {mainSrc ? (
          <Image
            src={mainSrc}
            alt=""
            w="100%"
            h="100%"
            objectFit="cover"
            onError={() => setMainAttempt(attempt => attempt + 1)}
          />
        ) : (
          <Text
            fontSize={`${Math.max(8, Math.round(size * 0.42))}px`}
            fontWeight="700"
            color="kk.textSecondary"
            lineHeight="1"
            userSelect="none"
          >
            {initial}
          </Text>
        )}
      </Box>
      {showBadge && (
        <Box
          position="absolute"
          right="-2px"
          bottom="-2px"
          w={`${badgeSize}px`}
          h={`${badgeSize}px`}
          borderRadius="full"
          bg="kk.bg"
          border="2px solid"
          borderColor="kk.bg"
          overflow="hidden"
          display="flex"
          alignItems="center"
          justifyContent="center"
        >
          {!badgeBroken ? (
            <Image
              src={caipToIcon(chainCaip!)}
              alt=""
              w="100%"
              h="100%"
              onError={() => setBadgeBroken(true)}
            />
          ) : null}
        </Box>
      )}
    </Box>
  )
}
