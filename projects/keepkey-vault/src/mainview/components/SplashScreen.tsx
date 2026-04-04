import { useState, useEffect } from "react"
import { Box, Text, Flex } from "@chakra-ui/react"
import { Logo } from './logo/Logo'
import { EllipsisDots } from "./util/EllipsisSpinner"

interface SplashScreenProps {
  statusText: string
  hintText?: string
  children?: React.ReactNode
  variant?: 'searching' | 'connecting' | 'error' | 'claimed'
  /** When true, logo moves to top and children are visible. When false, logo stays centered. */
  childrenReady?: boolean
  /** Called when the logo is clicked (e.g. to retry connection) */
  onLogoClick?: () => void
}

const STATUS_DOT_COLORS: Record<string, string> = {
  searching: 'gray.500',
  connecting: '#3B82F6',
  error: 'red.400',
  claimed: '#3B82F6',
}

const RETRY_HINT_DELAY_MS = 10_000

export function SplashScreen({ statusText, hintText, children, variant = 'searching', childrenReady = false, onLogoClick }: SplashScreenProps) {
  const dotColor = STATUS_DOT_COLORS[variant] || 'gray.500'
  const [showRetry, setShowRetry] = useState(false)

  // Show "Tap to retry" hint after 10s of searching/connecting (not when grid is ready)
  useEffect(() => {
    if (childrenReady) { setShowRetry(false); return }
    setShowRetry(false)
    const timer = setTimeout(() => setShowRetry(true), RETRY_HINT_DELAY_MS)
    return () => clearTimeout(timer)
  }, [childrenReady, variant])

  return (
    <Box height="100vh" width="100vw" bg="transparent" position="relative">

      {/* Logo — centered when loading, slides to top when grid appears */}
      <Flex
        position="absolute"
        left="0" right="0"
        top={childrenReady ? "6vh" : "35vh"}
        justifyContent="center"
        direction="column"
        alignItems="center"
        transition="top 0.5s ease"
        zIndex={1}
        pointerEvents={onLogoClick ? "auto" : "none"}
      >
        <Box
          as="button"
          onClick={onLogoClick}
          cursor={onLogoClick ? "pointer" : "default"}
          bg="transparent"
          border="none"
          p="0"
          _hover={onLogoClick ? { transform: "scale(1.05)" } : undefined}
          _active={onLogoClick ? { transform: "scale(0.95)" } : undefined}
          transition="transform 0.15s ease"
        >
          <Logo
            width={childrenReady ? "60px" : "100px"}
            style={{
              filter: 'brightness(1.3)',
              transition: 'all 0.5s ease',
            }}
          />
        </Box>
        {showRetry && !childrenReady && (
          <Text
            fontSize="xs"
            color="gray.500"
            mt="3"
            style={{ animation: 'fadeIn 0.4s ease' }}
            cursor={onLogoClick ? "pointer" : "default"}
            onClick={onLogoClick}
            _hover={onLogoClick ? { color: "gray.300" } : undefined}
          >
            Tap to retry
          </Text>
        )}
      </Flex>

      {/* Children (always mounted so DeviceGrid can fire onReady, hidden until ready) */}
      <Flex
        position="absolute"
        left="0" right="0"
        top={childrenReady ? "16vh" : "0"}
        bottom="80px"
        direction="column"
        alignItems="center"
        overflow="auto"
        px="4"
        opacity={childrenReady ? 1 : 0}
        pointerEvents={childrenReady ? "auto" : "none"}
        transition="opacity 0.4s ease"
      >
        {children}
      </Flex>

      {/* Status bar — pinned to bottom */}
      <Box
        position="absolute"
        bottom="30px"
        left="0" right="0"
        textAlign="center"
        px={3}
      >
        <Box display="inline-flex" px={3} py={1} borderRadius="md" bg="rgba(0, 0, 0, 0.5)">
          <Flex gap="2" justifyContent="center" alignItems="center">
            <Box w="8px" h="8px" borderRadius="full" bg={dotColor} flexShrink={0}
              style={{ animation: (variant === 'searching' || variant === 'connecting') ? 'pulse 1.5s infinite' : undefined }}
            />
            <Text fontSize="xs" color="gray.300">
              {statusText}
            </Text>
            {(variant === 'searching' || variant === 'connecting') && <EllipsisDots interval={300} />}
          </Flex>
        </Box>
        {hintText && (
          <Text fontSize="xs" color="gray.500" mt={2} maxW="340px" textAlign="center" mx="auto">
            {hintText}
          </Text>
        )}
      </Box>
      <style>{`
        @keyframes pulse {
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
