import { Box, Text, Flex, HStack } from "@chakra-ui/react"
import { Logo } from './logo/Logo'
import { EllipsisDots } from "./util/EllipsisSpinner"
import { rpcRequest } from "../lib/rpc"

interface SplashScreenProps {
  statusText: string
  hintText?: string
  children?: React.ReactNode
  variant?: 'searching' | 'connecting' | 'error' | 'claimed'
}

const STATUS_DOT_COLORS: Record<string, string> = {
  searching: 'gray.500',
  connecting: '#3B82F6',
  error: 'red.400',
  claimed: '#3B82F6',
}

export function SplashScreen({ statusText, hintText, children, variant = 'searching' }: SplashScreenProps) {
  const dotColor = STATUS_DOT_COLORS[variant] || 'gray.500'

  return (
    <Flex
      minHeight="100vh"
      width="100vw"
      bg="transparent"
      direction="column"
      alignItems="center"
      overflowY="auto"
      position="relative"
    >
      {/* Frameless window: window controls */}
      <HStack position="absolute" top={0} right={0} gap="0" zIndex={10}>
        <Box as="button" display="flex" alignItems="center" justifyContent="center" w="36px" h="28px"
          bg="transparent" color="gray.400" _hover={{ bg: "rgba(255,255,255,0.1)" }} cursor="pointer"
          onClick={() => rpcRequest("windowMinimize")}>
          <svg width="10" height="1" viewBox="0 0 10 1"><rect width="10" height="1" fill="currentColor" /></svg>
        </Box>
        <Box as="button" display="flex" alignItems="center" justifyContent="center" w="36px" h="28px"
          bg="transparent" color="gray.400" _hover={{ bg: "rgba(255,255,255,0.1)" }} cursor="pointer"
          onClick={() => rpcRequest("windowMaximize")}>
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1"><rect x="0.5" y="0.5" width="9" height="9" /></svg>
        </Box>
        <Box as="button" display="flex" alignItems="center" justifyContent="center" w="36px" h="28px"
          bg="transparent" color="gray.400" _hover={{ bg: "#e81123", color: "white" }} cursor="pointer"
          onClick={() => rpcRequest("windowClose")}>
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.2"><line x1="0" y1="0" x2="10" y2="10" /><line x1="10" y1="0" x2="0" y2="10" /></svg>
        </Box>
      </HStack>
      <Flex
        flex="1"
        width="100%"
        direction="column"
        alignItems="center"
        justifyContent="center"
        gap="6"
        minH="200px"
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
        mb="40px"
        textAlign="center"
        width="auto"
        px={3}
        py={1}
        borderRadius="md"
        bg="rgba(0, 0, 0, 0.5)"
        flexShrink={0}
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
    </Flex>
  )
}
