import { useState, useEffect } from "react"
import { Box, Text, Flex } from "@chakra-ui/react"
import { Logo } from './logo/Logo'
import { EllipsisDots } from "./util/EllipsisSpinner"
import { NAV_HEIGHT, SPLASH_STAGE_Y_PADDING, SPLASH_STATUS_BOTTOM, SPLASH_STATUS_RESERVED } from "../layout"

interface SplashScreenProps {
  statusText: string
  hintText?: string
  children?: React.ReactNode
  variant?: 'searching' | 'connecting' | 'error' | 'claimed'
  /** When true, the centered logo/content stack is visible. When false, only the logo is centered. */
  childrenReady?: boolean
  /** Called when the logo is clicked (e.g. to retry connection) */
  onLogoClick?: () => void
}

const STATUS_DOT_COLORS: Record<NonNullable<SplashScreenProps['variant']>, string> = {
  searching:  'var(--text-3)',
  connecting: 'var(--teal)',
  error:      'var(--rose)',
  claimed:    'var(--teal)',
}

const RETRY_HINT_DELAY_MS = 10_000

export function SplashScreen({ statusText, hintText, children, variant = 'searching', childrenReady = false, onLogoClick }: SplashScreenProps) {
  const dotColor = STATUS_DOT_COLORS[variant]
  const [showRetry, setShowRetry] = useState(false)

  // Show "Tap to retry" hint after 10s — only when there's a click handler and grid isn't ready
  useEffect(() => {
    if (childrenReady || !onLogoClick) { setShowRetry(false); return }
    setShowRetry(false)
    const timer = setTimeout(() => setShowRetry(true), RETRY_HINT_DELAY_MS)
    return () => clearTimeout(timer)
  }, [childrenReady, variant, onLogoClick])

  return (
    <Box height="100vh" width="100vw" bg="transparent" position="relative" overflow="hidden">

      {/* Center the full splash stack inside the usable space between nav and status. */}
      <Flex
        position="absolute"
        top={NAV_HEIGHT}
        bottom={SPLASH_STATUS_RESERVED}
        left="0"
        right="0"
        justifyContent="center"
        direction="column"
        alignItems="center"
        px="4"
        py={SPLASH_STAGE_Y_PADDING}
        minH="0"
        overflow="hidden"
        zIndex={1}
      >
        <Flex
          direction="column"
          alignItems="center"
          w="100%"
          maxW="760px"
          maxH="100%"
          minH="0"
          gap={childrenReady ? "clamp(20px, 3vh, 34px)" : "0"}
          transition="gap 0.4s ease"
        >
          <Box
            as="button"
            onClick={onLogoClick}
            cursor={onLogoClick ? "pointer" : "default"}
            bg="transparent"
            border="none"
            p="0"
            flexShrink={0}
            pointerEvents={onLogoClick ? "auto" : "none"}
            _hover={onLogoClick ? { transform: "scale(1.05)" } : undefined}
            _active={onLogoClick ? { transform: "scale(0.95)" } : undefined}
            transition="transform 0.15s ease"
          >
            <Logo
              width={childrenReady ? "60px" : "100px"}
              style={{
                filter: 'brightness(1.15) drop-shadow(0 6px 24px rgba(233,196,106,0.25))',
                transition: 'width 0.5s ease, filter 0.5s ease',
              }}
            />
          </Box>
          {showRetry && !childrenReady && (
            <Text
              fontSize="xs"
              color="var(--text-3)"
              mt="3"
              style={{ animation: 'fadeIn 0.4s ease' }}
              cursor={onLogoClick ? "pointer" : "default"}
              onClick={onLogoClick}
              _hover={onLogoClick ? { color: "var(--text-1)" } : undefined}
              letterSpacing="0.04em"
              textTransform="uppercase"
              fontFamily="mono"
              pointerEvents={onLogoClick ? "auto" : "none"}
            >
              Tap to retry
            </Text>
          )}
          {/* Children stay mounted while hidden so DeviceGrid can call onReady. */}
          <Flex
            w="100%"
            direction="column"
            alignItems="center"
            minH="0"
            maxH={childrenReady ? "100%" : "0px"}
            overflowY={childrenReady ? "auto" : "hidden"}
            overflowX="hidden"
            opacity={childrenReady ? 1 : 0}
            pointerEvents={childrenReady ? "auto" : "none"}
            transition="opacity 0.4s ease, max-height 0.4s ease"
          >
            {children}
          </Flex>
        </Flex>
      </Flex>

      {/* Status bar — pinned to bottom */}
      <Box
        position="absolute"
        bottom={SPLASH_STATUS_BOTTOM}
        left="0" right="0"
        textAlign="center"
        px={3}
      >
        <Box
          display="inline-flex"
          px="3.5"
          py="1.5"
          borderRadius="999px"
          bg="rgba(11,11,14,0.65)"
          backdropFilter="blur(12px)"
          border="1px solid var(--line)"
        >
          <Flex gap="2" justifyContent="center" alignItems="center">
            <Box w="7px" h="7px" borderRadius="full" bg={dotColor} flexShrink={0}
              style={{ animation: (variant === 'searching' || variant === 'connecting') ? 'splashPulse 1.5s infinite' : undefined }}
            />
            <Text fontSize="12px" color="var(--text-1)" letterSpacing="-0.005em">
              {statusText}
            </Text>
            {(variant === 'searching' || variant === 'connecting') && <EllipsisDots interval={300} />}
          </Flex>
        </Box>
        {hintText && (
          <Text fontSize="11px" color="var(--text-3)" mt={2.5} maxW="340px" textAlign="center" mx="auto" letterSpacing="-0.005em">
            {hintText}
          </Text>
        )}
      </Box>
      <style>{`
        @keyframes splashPulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.3; }
        }
        @keyframes fadeIn {
          from { opacity: 0; transform: translateY(4px); }
          to { opacity: 1; transform: translateY(0); }
        }
      `}</style>
    </Box>
  )
}
