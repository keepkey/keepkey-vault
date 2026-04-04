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

  // When children aren't ready: logo centered, full-screen loading feel
  // When children are ready: logo slides to top, children fill middle
  return (
    <Flex
      height="100vh"
      width="100vw"
      bg="transparent"
      direction="column"
      alignItems="center"
      justifyContent={childrenReady ? "flex-start" : "center"}
      transition="all 0.5s ease"
    >
      {/* Logo — centered when loading, top when grid is visible */}
      <Flex
        flex="0 0 auto"
        pt={childrenReady ? "8vh" : "0"}
        pb={childrenReady ? "4" : "6"}
        justifyContent="center"
        transition="all 0.5s ease"
      >
        <Logo
          width={childrenReady ? "60px" : "100px"}
          style={{
            filter: 'brightness(1.3)',
            transition: 'all 0.5s ease',
          }}
        />
      </Flex>

      {/* Children (DeviceGrid etc.) — only rendered when ready */}
      {childrenReady && (
        <Flex flex="1" direction="column" alignItems="center" overflow="auto" w="100%" px="4"
          style={{ animation: 'fadeIn 0.4s ease' }}>
          {children}
        </Flex>
      )}

      {/* Status bar — pinned to bottom */}
      <Box
        flex="0 0 auto"
        pb="40px"
        pt="3"
        textAlign="center"
        px={3}
        mt={childrenReady ? "0" : "auto"}
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
          from { opacity: 0; transform: translateY(8px); }
          to { opacity: 1; transform: translateY(0); }
        }
      `}</style>
    </Flex>
  )
}
