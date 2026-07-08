/**
 * ReproducibleBuildNotice — shown before installing official firmware.
 * States the reproducible-build guarantee, the pinned payload hash Vault
 * verifies the download against, and links for independent verification.
 */
import { Box, Text, VStack, HStack } from '@chakra-ui/react'

const REPRO_DOC_URL = 'https://github.com/keepkey/keepkey-firmware/blob/master/docs/ReproducibleBuilds.md'

interface Props {
  /** Target firmware version being installed (no leading "v") */
  version: string
  /** Pinned payload sha256 from the manifest, if known */
  payloadHash?: string
}

export function ReproducibleBuildNotice({ version, payloadHash }: Props) {
  const releaseUrl = `https://github.com/keepkey/keepkey-firmware/releases/tag/v${version}`

  return (
    <Box
      w="100%"
      p={3}
      borderRadius="lg"
      bg="rgba(72,187,120,0.06)"
      border="1px solid"
      borderColor="rgba(72,187,120,0.25)"
    >
      <HStack gap={2} align="start">
        <Box flexShrink={0} mt={0.5}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#48BB78" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
            <polyline points="9 12 11 14 15 10" />
          </svg>
        </Box>
        <VStack gap={1} align="start" flex={1} minW={0}>
          <Text fontSize="xs" fontWeight="700" color="green.300">
            Reproducible build — verified before install
          </Text>
          <Text fontSize="2xs" color="whiteAlpha.600" lineHeight="1.5">
            This release is built deterministically from public source code. Vault
            checks the binary&apos;s sha256 against the pinned release hash before
            flashing anything to your device.
          </Text>
          {payloadHash && (
            <Text fontSize="2xs" color="whiteAlpha.500" fontFamily="mono" wordBreak="break-all">
              sha256 {payloadHash}
            </Text>
          )}
          <HStack gap={3} pt={0.5}>
            <Box
              as="a"
              href={releaseUrl}
              target="_blank"
              rel="noopener noreferrer"
              fontSize="2xs"
              color="green.400"
              textDecoration="underline"
              _hover={{ color: 'green.300' }}
            >
              Release hashes
            </Box>
            <Box
              as="a"
              href={REPRO_DOC_URL}
              target="_blank"
              rel="noopener noreferrer"
              fontSize="2xs"
              color="green.400"
              textDecoration="underline"
              _hover={{ color: 'green.300' }}
            >
              Verify it yourself
            </Box>
          </HStack>
        </VStack>
      </HStack>
    </Box>
  )
}
