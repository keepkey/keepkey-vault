// Single source of truth for "what swap provider is this and how do we show it?"
//
// Resolves a swapper/integration string to a (icon, label) pair and renders it
// in one of two layouts. Used in quote display, pre-sign review, in-flight
// tracker, and history.
//
// Resolution prefers `swapper` (the actual executor — Relay, 0x, Uniswap, etc.)
// over `integration` (the upstream source — usually shapeshift or thorchain).
// When both are present and differ, callers can opt in to a "via {integration}"
// suffix so the user sees both the executor and the aggregator that surfaced it.

import { Box, Flex, HStack, Image, Text } from "@chakra-ui/react"

import logoThorchain from "../assets/providers/thorchain.png"
import logoMayachain from "../assets/providers/mayachain.png"
import logo0x from "../assets/providers/0x.png"
import logoUniswap from "../assets/providers/uniswap.png"
import logo1inch from "../assets/providers/1inch.png"
import logoCow from "../assets/providers/cow.png"
import logoBalancer from "../assets/providers/balancer.png"
import logoSushi from "../assets/providers/sushi.png"
import logoRelay from "../assets/providers/relay.svg"
import logoShapeshift from "../assets/providers/shapeshift.svg"
import logoLifi from "../assets/providers/lifi.svg"
import logoChainflip from "../assets/providers/chainflip.svg"
import logoAcross from "../assets/providers/across.svg"
import logoCurve from "../assets/providers/curve.svg"

export type ProviderInfo = {
  key: string        // canonical lowercase id
  label: string      // user-facing display name
  icon: string       // bundled asset URL
  color: string      // brand accent (used for chip/border tints)
}

const UNKNOWN: ProviderInfo = {
  key: "unknown",
  label: "Unknown route",
  // Inline data URI so unknown providers never trigger a 404. Neutral grey circle.
  icon:
    "data:image/svg+xml;utf8," +
    encodeURIComponent(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><circle cx="32" cy="32" r="32" fill="#3a3a44"/><text x="32" y="42" font-family="-apple-system,system-ui,sans-serif" font-size="32" font-weight="700" text-anchor="middle" fill="#9ca3af">?</text></svg>',
    ),
  color: "#6b7280",
}

// Match the same normalization rules used in lib/trackers.ts so behavior stays
// in lockstep when callers pass identical strings.
function normalize(raw: string | undefined | null): string {
  return (raw || "").toLowerCase().replace(/[\s_.-]/g, "")
}

const REGISTRY: Array<{ match: (s: string) => boolean; info: ProviderInfo }> = [
  { match: (s) => s.includes("thor"), info: { key: "thorchain", label: "THORChain", icon: logoThorchain, color: "#33ff99" } },
  { match: (s) => s.includes("maya"), info: { key: "mayachain", label: "Maya", icon: logoMayachain, color: "#15c6c2" } },
  { match: (s) => s === "relay" || s === "relaylink" || s === "relayexchange", info: { key: "relay", label: "Relay", icon: logoRelay, color: "#ff5b22" } },
  { match: (s) => s === "shapeshift" || s === "ss" || s === "ssquote", info: { key: "shapeshift", label: "ShapeShift", icon: logoShapeshift, color: "#386ff9" } },
  { match: (s) => s === "0x" || s === "zeroex", info: { key: "0x", label: "0x", icon: logo0x, color: "#000000" } },
  { match: (s) => s === "uniswap" || s.startsWith("univ"), info: { key: "uniswap", label: "Uniswap", icon: logoUniswap, color: "#ff007a" } },
  { match: (s) => s === "oneinch" || s === "1inch", info: { key: "1inch", label: "1inch", icon: logo1inch, color: "#1f2937" } },
  { match: (s) => s === "cow" || s === "cowswap", info: { key: "cow", label: "CoW Swap", icon: logoCow, color: "#cb73a4" } },
  { match: (s) => s === "lifi" || s === "lifip" || s === "lifiquote", info: { key: "lifi", label: "LI.FI", icon: logoLifi, color: "#f5b5fc" } },
  { match: (s) => s === "chainflip" || s === "cf", info: { key: "chainflip", label: "Chainflip", icon: logoChainflip, color: "#46da93" } },
  { match: (s) => s === "across", info: { key: "across", label: "Across", icon: logoAcross, color: "#6cf9d8" } },
  { match: (s) => s === "curve" || s === "curvefi", info: { key: "curve", label: "Curve", icon: logoCurve, color: "#a4c8ff" } },
  { match: (s) => s === "balancer", info: { key: "balancer", label: "Balancer", icon: logoBalancer, color: "#536dfe" } },
  { match: (s) => s === "sushi" || s === "sushiswap", info: { key: "sushi", label: "Sushi", icon: logoSushi, color: "#fa52a0" } },
]

/**
 * Resolve a swapper/integration string to a ProviderInfo. Falls back to a
 * neutral "Unknown route" badge — never returns null, so callers can
 * unconditionally render and the UI stays informative even for new providers
 * Pioneer hasn't trained the client about yet.
 */
export function resolveProvider(swapper: string | undefined | null): ProviderInfo {
  const s = normalize(swapper)
  if (!s) return UNKNOWN
  for (const entry of REGISTRY) {
    if (entry.match(s)) return entry.info
  }
  // Preserve the raw swapper as the label so unknown but truthy values still
  // tell the user *something* rather than collapsing to "Unknown".
  return { ...UNKNOWN, label: swapper as string, key: s }
}

export type ProviderBadgeProps = {
  swapper?: string | null
  integration?: string | null
  size?: number              // icon px (default 16)
  variant?: "compact" | "detailed" | "row"
  showVia?: boolean          // append "via {integration}" when differs
}

/**
 * Render a provider mark.
 *
 * - `compact`: just the icon, no label (use in dense rows)
 * - `detailed`: icon + label inline (footer / approval row)
 * - `row`: icon + label + optional "via {integration}" tag, takes full width
 */
export function ProviderBadge({
  swapper,
  integration,
  size = 16,
  variant = "detailed",
  showVia = true,
}: ProviderBadgeProps) {
  // Native vault routes (mayachain, thorchain) ARE the swapper — there is no
  // underlying executor to discover. Pioneer historically wrote
  // swapper='thorchain' even on Maya pools (Maya forks Thor's protocol naming),
  // and stale DB rows can still carry it. Prefer integration in that case so
  // the badge stays truthful without depending on the upstream cleanup landing.
  const integrationKey = integration?.toLowerCase().replace(/[\s_.-]/g, "")
  const isNativeVaultIntegration = integrationKey === "mayachain" || integrationKey === "thorchain"

  // Prefer swapper (the actual executor); fall back to integration so we still
  // render *something* on legacy quote shapes that only carry one of the two.
  const primary = isNativeVaultIntegration
    ? resolveProvider(integration)
    : resolveProvider(swapper || integration)
  const integrationInfo = integration ? resolveProvider(integration) : null
  const showIntegrationSuffix =
    !isNativeVaultIntegration &&
    showVia &&
    integrationInfo &&
    integrationInfo.key !== primary.key &&
    integrationInfo.key !== "unknown"

  if (variant === "compact") {
    return (
      <Image
        src={primary.icon}
        alt={primary.label}
        w={`${size}px`}
        h={`${size}px`}
        borderRadius="full"
        title={primary.label}
        flexShrink={0}
      />
    )
  }

  if (variant === "row") {
    return (
      <Flex align="center" gap="2" w="full">
        <Image src={primary.icon} alt={primary.label} w={`${size}px`} h={`${size}px`} borderRadius="full" flexShrink={0} />
        <Box flex="1" minW="0">
          <Text fontSize="11px" fontWeight="700" color="kk.textPrimary" lineHeight="1.2">
            {primary.label}
          </Text>
          {showIntegrationSuffix && (
            <Text fontSize="10px" color="kk.textMuted" lineHeight="1.2">
              via {integrationInfo!.label}
            </Text>
          )}
        </Box>
      </Flex>
    )
  }

  // detailed (inline)
  return (
    <HStack gap="1.5" flexShrink={0}>
      <Image src={primary.icon} alt={primary.label} w={`${size}px`} h={`${size}px`} borderRadius="full" flexShrink={0} />
      <Text fontSize="11px" fontWeight="600" color="kk.textPrimary">
        {primary.label}
      </Text>
      {showIntegrationSuffix && (
        <Text fontSize="10px" color="kk.textMuted">via {integrationInfo!.label}</Text>
      )}
    </HStack>
  )
}
