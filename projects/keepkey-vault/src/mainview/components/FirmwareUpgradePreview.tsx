/**
 * FirmwareUpgradePreview — shows users what new features they'll unlock
 * by upgrading firmware. Animated chain logos, feature cards, and a
 * glowing highlight for the primary new chain.
 */
import { useState, useEffect, useMemo } from 'react'
import { Box, Text, VStack, HStack, Flex } from '@chakra-ui/react'
import { CHAINS } from '../../shared/chains'
import { getUpgradeFeatures, getVersionInfo, type FirmwareFeature } from '../../shared/firmware-versions'

// ── Icon URL helper (same convention as assetLookup.ts) ──────────────
function chainIconUrl(caip: string): string {
  return `https://api.keepkey.info/coins/${btoa(caip).replace(/=+$/, '')}.png`
}

// ── CSS keyframe animations (injected once) ──────────────────────────
const ANIM_ID = '__fw-upgrade-anims'
function ensureAnimations() {
  if (typeof document === 'undefined') return
  if (document.getElementById(ANIM_ID)) return
  const style = document.createElement('style')
  style.id = ANIM_ID
  style.textContent = `
    @keyframes fw-glow-pulse {
      0%, 100% { box-shadow: 0 0 20px 4px var(--glow-color, rgba(20,241,149,0.3)); }
      50% { box-shadow: 0 0 40px 12px var(--glow-color, rgba(20,241,149,0.5)); }
    }
    @keyframes fw-float {
      0%, 100% { transform: translateY(0px); }
      50% { transform: translateY(-6px); }
    }
    @keyframes fw-fade-up {
      from { opacity: 0; transform: translateY(16px); }
      to { opacity: 1; transform: translateY(0); }
    }
    @keyframes fw-shine {
      0% { background-position: -200% center; }
      100% { background-position: 200% center; }
    }
    @keyframes fw-orbit {
      0% { transform: rotate(0deg) translateX(48px) rotate(0deg); }
      100% { transform: rotate(360deg) translateX(48px) rotate(-360deg); }
    }
    @keyframes fw-scale-in {
      from { opacity: 0; transform: scale(0.7); }
      to { opacity: 1; transform: scale(1); }
    }
  `
  document.head.appendChild(style)
}

interface Props {
  /** Current device firmware version (null if OOB / not installed) */
  currentVersion: string | null
  /** Target firmware version being installed */
  targetVersion: string
}

export function FirmwareUpgradePreview({ currentVersion, targetVersion }: Props) {
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    ensureAnimations()
    const timer = setTimeout(() => setVisible(true), 100)
    return () => clearTimeout(timer)
  }, [])

  const features = useMemo(
    () => getUpgradeFeatures(currentVersion, targetVersion),
    [currentVersion, targetVersion],
  )

  const versionInfo = useMemo(() => getVersionInfo(targetVersion), [targetVersion])

  if (features.length === 0) return null

  // Resolve chain data for logo display
  const chainFeatures = features.filter(f => f.chains?.length)
  const resolvedChains = chainFeatures.flatMap(f =>
    (f.chains || []).map(chainId => {
      const chain = CHAINS.find(c => c.id === chainId)
      return chain ? { ...chain, featureColor: f.color || chain.color } : null
    }).filter(Boolean)
  ) as Array<(typeof CHAINS)[0] & { featureColor: string }>

  // Primary feature (first chain feature for hero display)
  const hero = resolvedChains[0]
  const heroColor = hero?.featureColor || '#14F195'

  return (
    <Box
      w="100%"
      opacity={visible ? 1 : 0}
      transform={visible ? 'translateY(0)' : 'translateY(12px)'}
      transition="all 0.5s cubic-bezier(0.16, 1, 0.3, 1)"
    >
      <Box
        w="100%"
        borderRadius="xl"
        overflow="hidden"
        position="relative"
        bg="linear-gradient(135deg, rgba(15,15,20,0.95) 0%, rgba(20,25,35,0.95) 100%)"
        border="1px solid"
        borderColor="whiteAlpha.100"
      >
        {/* Ambient glow behind the card */}
        <Box
          position="absolute"
          top="-30%"
          left="50%"
          transform="translateX(-50%)"
          w="80%"
          h="60%"
          borderRadius="full"
          bg={`radial-gradient(ellipse, ${heroColor}15 0%, transparent 70%)`}
          pointerEvents="none"
        />

        <VStack gap={0} w="100%" position="relative">
          {/* ── Hero section ──────────────────────────────────── */}
          <Box w="100%" pt={5} pb={4} px={4} textAlign="center">
            {/* Version badge */}
            <Flex justify="center" mb={3}>
              <Box
                px={3}
                py={1}
                borderRadius="full"
                fontSize="2xs"
                fontWeight="bold"
                textTransform="uppercase"
                letterSpacing="0.1em"
                bg={`${heroColor}18`}
                color={heroColor}
                border="1px solid"
                borderColor={`${heroColor}30`}
                style={{
                  animation: visible ? 'fw-scale-in 0.4s cubic-bezier(0.16, 1, 0.3, 1) forwards' : undefined,
                }}
              >
                v{targetVersion}
              </Box>
            </Flex>

            {/* "What's New" label */}
            <Text
              fontSize="2xs"
              fontWeight="600"
              textTransform="uppercase"
              letterSpacing="0.15em"
              color="whiteAlpha.500"
              mb={1}
            >
              What's New
            </Text>

            {/* Headline */}
            <Text
              fontSize="md"
              fontWeight="bold"
              color="white"
              lineHeight="1.3"
              style={{
                animation: visible ? 'fw-fade-up 0.6s cubic-bezier(0.16, 1, 0.3, 1) 0.15s both' : undefined,
              }}
            >
              {versionInfo?.headline || `Firmware v${targetVersion}`}
            </Text>
          </Box>

          {/* ── Chain hero logo ─────────────────────────────── */}
          {hero && (
            <Box
              position="relative"
              w="100%"
              py={4}
              display="flex"
              justifyContent="center"
              alignItems="center"
            >
              {/* Orbiting particles */}
              {[0, 1, 2].map(i => (
                <Box
                  key={i}
                  position="absolute"
                  top="50%"
                  left="50%"
                  w="6px"
                  h="6px"
                  borderRadius="full"
                  bg={heroColor}
                  opacity={0.4}
                  style={{
                    animation: `fw-orbit ${3 + i * 0.8}s linear infinite`,
                    animationDelay: `${i * -1}s`,
                    marginTop: '-3px',
                    marginLeft: '-3px',
                  }}
                />
              ))}

              {/* Glow ring */}
              <Box
                position="absolute"
                w="88px"
                h="88px"
                borderRadius="full"
                style={{
                  '--glow-color': `${heroColor}40`,
                  animation: 'fw-glow-pulse 2.5s ease-in-out infinite',
                } as React.CSSProperties}
              />

              {/* Logo container */}
              <Box
                w="72px"
                h="72px"
                borderRadius="full"
                bg={`${heroColor}12`}
                border="2px solid"
                borderColor={`${heroColor}40`}
                display="flex"
                alignItems="center"
                justifyContent="center"
                position="relative"
                zIndex={1}
                style={{
                  animation: visible ? 'fw-float 3s ease-in-out infinite, fw-scale-in 0.5s cubic-bezier(0.16, 1, 0.3, 1) 0.2s both' : undefined,
                }}
              >
                <img
                  src={chainIconUrl(hero.caip)}
                  alt={hero.coin}
                  width={44}
                  height={44}
                  style={{
                    borderRadius: '50%',
                    objectFit: 'cover',
                  }}
                  onError={(e) => {
                    // Fallback: show the chain symbol text
                    const target = e.currentTarget
                    target.style.display = 'none'
                    const parent = target.parentElement
                    if (parent && !parent.querySelector('[data-fallback]')) {
                      const span = document.createElement('span')
                      span.setAttribute('data-fallback', '1')
                      span.style.cssText = `font-size:20px;font-weight:700;color:${heroColor}`
                      span.textContent = hero.symbol
                      parent.appendChild(span)
                    }
                  }}
                />
              </Box>
            </Box>
          )}

          {/* ── Feature cards ──────────────────────────────── */}
          <VStack gap={2} w="100%" px={4} pb={4}>
            {features.map((feature, i) => (
              <FeatureCard
                key={i}
                feature={feature}
                index={i}
                visible={visible}
              />
            ))}
          </VStack>
        </VStack>
      </Box>
    </Box>
  )
}

// ── Feature card ────────────────────────────────────────────────────

function FeatureCard({ feature, index, visible }: { feature: FirmwareFeature; index: number; visible: boolean }) {
  const color = feature.color || '#C0A860'

  // Resolve chain logos for this feature
  const featureChains = (feature.chains || [])
    .map(id => CHAINS.find(c => c.id === id))
    .filter(Boolean) as (typeof CHAINS)[number][]

  return (
    <Box
      w="100%"
      p={3}
      borderRadius="lg"
      bg="whiteAlpha.50"
      border="1px solid"
      borderColor="whiteAlpha.100"
      position="relative"
      overflow="hidden"
      style={{
        animation: visible
          ? `fw-fade-up 0.5s cubic-bezier(0.16, 1, 0.3, 1) ${0.3 + index * 0.1}s both`
          : undefined,
      }}
    >
      {/* Accent stripe */}
      <Box
        position="absolute"
        left={0}
        top={0}
        bottom={0}
        w="3px"
        bg={color}
        borderRadius="full"
      />

      <HStack gap={3} pl={2}>
        {/* Icon */}
        <Box flexShrink={0}>
          {feature.icon === 'chain' && featureChains.length > 0 ? (
            <Box
              w="36px"
              h="36px"
              borderRadius="lg"
              bg={`${color}15`}
              display="flex"
              alignItems="center"
              justifyContent="center"
            >
              <img
                src={chainIconUrl(featureChains[0].caip)}
                alt={featureChains[0].coin}
                width={24}
                height={24}
                style={{ borderRadius: '6px', objectFit: 'cover' }}
                onError={(e) => {
                  const t = e.currentTarget
                  t.style.display = 'none'
                }}
              />
            </Box>
          ) : feature.icon === 'security' ? (
            <Box w="36px" h="36px" borderRadius="lg" bg="green.900" display="flex" alignItems="center" justifyContent="center">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#48BB78" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
              </svg>
            </Box>
          ) : feature.icon === 'performance' ? (
            <Box w="36px" h="36px" borderRadius="lg" bg="yellow.900" display="flex" alignItems="center" justifyContent="center">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#ECC94B" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
              </svg>
            </Box>
          ) : feature.icon === 'feature' ? (
            <Box w="36px" h="36px" borderRadius="lg" bg={`${color}15`} display="flex" alignItems="center" justifyContent="center">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                <circle cx="12" cy="12" r="3" />
              </svg>
            </Box>
          ) : (
            <Box w="36px" h="36px" borderRadius="lg" bg={`${color}15`} display="flex" alignItems="center" justifyContent="center">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="10" />
                <line x1="12" y1="8" x2="12" y2="12" />
                <line x1="12" y1="16" x2="12.01" y2="16" />
              </svg>
            </Box>
          )}
        </Box>

        {/* Text */}
        <VStack gap={0.5} align="start" flex={1}>
          <HStack gap={2}>
            <Text fontSize="sm" fontWeight="600" color="white" lineHeight="1.2">
              {feature.title}
            </Text>
            {feature.comingSoon && (
              <Box
                px={1.5}
                py={0.5}
                borderRadius="full"
                fontSize="2xs"
                fontWeight="bold"
                textTransform="uppercase"
                letterSpacing="0.05em"
                bg="purple.900"
                color="purple.300"
                border="1px solid"
                borderColor="purple.700"
                lineHeight="1"
                whiteSpace="nowrap"
              >
                Coming Soon
              </Box>
            )}
          </HStack>
          <Text fontSize="xs" color="whiteAlpha.600" lineHeight="1.4">
            {feature.description}
          </Text>
        </VStack>
      </HStack>
    </Box>
  )
}
