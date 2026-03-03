import { Box, Text, Flex } from "@chakra-ui/react"
import { Logo } from './logo/Logo'
import { EllipsisDots } from "./util/EllipsisSpinner"

interface SplashScreenProps {
  statusText: string
  hintText?: string
  children?: React.ReactNode
  variant?: 'searching' | 'connecting' | 'error' | 'claimed'
  dragProps?: Record<string, any>
}

const STATUS_DOT_COLORS: Record<string, string> = {
  searching: 'gray.500',
  connecting: '#3B82F6',
  error: 'red.400',
  claimed: '#3B82F6',
}

export function SplashScreen({ statusText, hintText, children, variant = 'searching', dragProps }: SplashScreenProps) {
  const dotColor = STATUS_DOT_COLORS[variant] || 'gray.500'

  return (
    <Box
      height="100vh"
      width="100vw"
      bg="transparent"
      position="relative"
      {...dragProps}
    >
      <Flex
        height="100%"
        width="100%"
        direction="column"
        alignItems="center"
        justifyContent="center"
        gap="6"
      >
        <Logo
          width="100px"
          style={{
            filter: 'brightness(1.3)',
            transition: 'filter 0.2s ease'
          }}
        />
      </Flex>
      <Box
        position="absolute"
        bottom="40px"
        left="50%"
        transform="translateX(-50%)"
        textAlign="center"
        width="auto"
        px={3}
        py={1}
        borderRadius="md"
        bg="rgba(0, 0, 0, 0.5)"
      >
        <Flex gap="2" justifyContent="center" alignItems="center">
          <Box w="8px" h="8px" borderRadius="full" bg={dotColor} flexShrink={0}
            style={{ animation: (variant === 'searching' || variant === 'connecting') ? 'pulse 1.5s infinite' : undefined }}
          />
          <Text fontSize="xs" color="gray.300">
            {statusText}
          </Text>
          {(variant === 'searching' || variant === 'connecting') && <EllipsisDots interval={300} />}
        </Flex>
        {hintText && (
          <Text fontSize="xs" color="gray.500" mt={2} maxW="340px" textAlign="center">
            {hintText}
          </Text>
        )}
      </Box>
      {children}
      <style>{`
        @keyframes pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.3; }
        }
      `}</style>
    </Box>
  )
}
