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
}

const STATUS_DOT_COLORS: Record<string, string> = {
  searching: 'gray.500',
  connecting: '#3B82F6',
  error: 'red.400',
  claimed: '#3B82F6',
}

export function SplashScreen({ statusText, hintText, children, variant = 'searching', childrenReady = false }: SplashScreenProps) {
  const dotColor = STATUS_DOT_COLORS[variant] || 'gray.500'

  return (
    <Box height="100vh" width="100vw" bg="transparent" position="relative">

      {/* Logo — centered when loading, slides to top when grid appears */}
      <Flex
        position="absolute"
        left="0" right="0"
        top={childrenReady ? "6vh" : "35vh"}
        justifyContent="center"
        transition="top 0.5s ease"
        zIndex={1}
        pointerEvents="none"
      >
        <Logo
          width={childrenReady ? "60px" : "100px"}
          style={{
            filter: 'brightness(1.3)',
            transition: 'all 0.5s ease',
          }}
        />
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
      `}</style>
    </Box>
  )
}
