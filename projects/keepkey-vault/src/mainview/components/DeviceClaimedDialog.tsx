import { Box, Text, Flex, VStack } from "@chakra-ui/react"

export function DeviceClaimedDialog({ error }: { error: string }) {
  return (
    <Box
      position="absolute"
      top="50%"
      left="50%"
      transform="translate(-50%, -50%)"
      mt="60px"
      bg="rgba(30, 20, 10, 0.95)"
      border="1px solid"
      borderColor="orange.700"
      borderRadius="lg"
      px={6}
      py={5}
      maxW="420px"
      w="90%"
      boxShadow="0 0 30px rgba(200, 120, 0, 0.15)"
    >
      <VStack gap={3} align="stretch">
        <Flex align="center" gap={2}>
          <Text fontSize="lg" fontWeight="bold" color="orange.300">
            Device In Use
          </Text>
        </Flex>

        <Text fontSize="sm" color="gray.300" lineHeight="tall">
          Your KeepKey was detected but is currently claimed by another application
          (e.g. KeepKey Desktop, a browser extension, or scdaemon).
        </Text>

        <Box bg="rgba(0,0,0,0.3)" borderRadius="md" px={3} py={2}>
          <Text fontSize="xs" color="gray.500" fontFamily="mono" wordBreak="break-word">
            {error}
          </Text>
        </Box>

        <Text fontSize="sm" color="gray.400" fontWeight="semibold">
          To connect:
        </Text>
        <VStack gap={1} align="stretch" pl={2}>
          <Text fontSize="sm" color="gray.400">1. Close other apps using your KeepKey</Text>
          <Text fontSize="sm" color="gray.400">2. Unplug and replug the device</Text>
          <Text fontSize="sm" color="gray.400">3. This app will reconnect automatically</Text>
        </VStack>

        <Text fontSize="xs" color="gray.600" textAlign="center" mt={1}>
          Waiting for device to become available...
        </Text>
      </VStack>
    </Box>
  )
}
