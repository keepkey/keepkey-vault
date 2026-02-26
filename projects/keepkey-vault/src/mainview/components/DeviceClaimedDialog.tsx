import { Box, Text, Flex, VStack, Image } from "@chakra-ui/react"
import { useTranslation } from "react-i18next"
import connectSvg from "../assets/svg/connect-keepkey.svg"

export function DeviceClaimedDialog({ error }: { error: string }) {
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
      borderColor="blue.700"
      borderRadius="lg"
      px={6}
      py={5}
      maxW="420px"
      w="90%"
      boxShadow="0 0 30px rgba(59, 130, 246, 0.15)"
    >
      <VStack gap={3} align="stretch">
        <Flex align="center" gap={2}>
          <Text fontSize="lg" fontWeight="bold" color="blue.300">
            {t("claimed.title")}
          </Text>
        </Flex>

        <Text fontSize="sm" color="gray.300" lineHeight="tall">
          {t("claimed.description")}
        </Text>

        <Box bg="rgba(0,0,0,0.3)" borderRadius="md" px={3} py={2}>
          <Text fontSize="xs" color="gray.500" fontFamily="mono" wordBreak="break-word">
            {error}
          </Text>
        </Box>

        <Flex justify="center" py={2}>
          <Image src={connectSvg} alt="Unplug and replug KeepKey" w="80px" h="80px" />
        </Flex>

        <Text fontSize="sm" color="gray.400" fontWeight="semibold">
          {t("claimed.toConnect")}
        </Text>
        <VStack gap={1} align="stretch" pl={2}>
          <Text fontSize="sm" color="gray.400">{t("claimed.step1")}</Text>
          <Text fontSize="sm" color="gray.400">{t("claimed.step2")}</Text>
          <Text fontSize="sm" color="gray.400">{t("claimed.step3")}</Text>
        </VStack>

        <Text fontSize="xs" color="gray.600" textAlign="center" mt={1}>
          {t("claimed.waiting")}
        </Text>
      </VStack>
    </Box>
  )
}
