import { Box, Text, Flex, VStack, Image } from "@chakra-ui/react"
import { useTranslation } from "react-i18next"
import connectSvg from "../assets/svg/connect-keepkey.svg"

function DeviceDialog({ i18nPrefix, borderColor, shadowColor }: {
  i18nPrefix: string
  borderColor: string
  shadowColor: string
}) {
  const { t } = useTranslation("device")
  return (
    <Box
      position="absolute"
      top="50%"
      left="50%"
      transform="translate(-50%, -50%)"
      mt="60px"
      bg="rgba(10, 15, 30, 0.95)"
      border="1px solid"
      borderColor={borderColor}
      borderRadius="lg"
      px={6}
      py={5}
      maxW="420px"
      w="90%"
      boxShadow={`0 0 30px ${shadowColor}`}
    >
      <VStack gap={3} align="stretch">
        <Flex align="center" gap={2}>
          <Text fontSize="lg" fontWeight="bold" color="blue.300">
            {t(`${i18nPrefix}.title`)}
          </Text>
        </Flex>

        <Text fontSize="sm" color="gray.300" lineHeight="tall">
          {t(`${i18nPrefix}.description`)}
        </Text>

        <Flex justify="center" py={2}>
          <Image src={connectSvg} alt="Unplug and replug KeepKey" w="80px" h="80px" />
        </Flex>

        <Text fontSize="sm" color="gray.400" fontWeight="semibold">
          {t(`${i18nPrefix}.toConnect`)}
        </Text>
        <VStack gap={1} align="stretch" pl={2}>
          <Text fontSize="sm" color="gray.400">{t(`${i18nPrefix}.step1`)}</Text>
          <Text fontSize="sm" color="gray.400">{t(`${i18nPrefix}.step2`)}</Text>
          <Text fontSize="sm" color="gray.400">{t(`${i18nPrefix}.step3`)}</Text>
        </VStack>

        <Text fontSize="xs" color="gray.600" textAlign="center" mt={1}>
          {t(`${i18nPrefix}.waiting`)}
        </Text>
      </VStack>
    </Box>
  )
}

export function DeviceClaimedDialog({ error }: { error: string }) {
  return <DeviceDialog i18nPrefix="claimed" borderColor="blue.700" shadowColor="rgba(59, 130, 246, 0.15)" />
}

export function DeviceConnectionFailedDialog() {
  return <DeviceDialog i18nPrefix="connectionFailed" borderColor="orange.700" shadowColor="rgba(245, 158, 11, 0.15)" />
}
