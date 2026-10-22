/**
 * ReproducibleBuildNotice — shown before installing official firmware.
 * Describes the download hash check separately from independent reproduction,
 * publisher authentication and checking the installed image.
 */
import { Box, Text, VStack, HStack } from '@chakra-ui/react'
import { rpcRequest } from '../lib/rpc'

const REPRO_DOC_URL = 'https://github.com/keepkey/keepkey-firmware#verifying-published-binaries'

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
            Download integrity checked before install
          </Text>
          <Text fontSize="2xs" color="whiteAlpha.600" lineHeight="1.5">
            Vault compares the downloaded firmware&apos;s payload SHA256 (the signed
            file minus its 256-byte signature header) with the pinned release hash
            before flashing. This checks download integrity; it does not rebuild the source.
          </Text>
          <Text fontSize="2xs" color="whiteAlpha.600" lineHeight="1.5">
            Reproduction compares locally built application code with the published payload.
            Publisher signatures authenticate the release. A device-reported hash
            cross-checks the installed image. A matching hash does not prove the source is bug-free.
          </Text>
          {payloadHash && (
            <Text fontSize="2xs" color="whiteAlpha.500" fontFamily="mono" wordBreak="break-all">
              payload sha256 {payloadHash}
            </Text>
          )}
          <HStack gap={3} pt={0.5}>
            <Box
              as="a"
              href={releaseUrl}
              onClick={(e) => {
                e.preventDefault()
                rpcRequest('openUrl', { url: releaseUrl }).catch(() => {})
              }}
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
              onClick={(e) => {
                e.preventDefault()
                rpcRequest('openUrl', { url: REPRO_DOC_URL }).catch(() => {})
              }}
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
