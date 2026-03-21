import { Box, Text, Flex, VStack, Link } from "@chakra-ui/react"
import { useTranslation } from "react-i18next"
import connectSvgRaw from "../assets/svg/connect-keepkey.svg?raw"

export function DeviceClaimedDialog({ error }: { error: string }) {
  const { t } = useTranslation("device")
  return (
    <Box
      position="absolute"
      top="50%"
      left="50%"
      transform="translate(-50%, -50%)"
      mt="60px"
      bg="rgba(0, 0, 0, 0.95)"
      border="2px solid"
      borderColor="#D4A017"
      borderRadius="xl"
      px={8}
      py={7}
      maxW="460px"
      w="90%"
      boxShadow="0 0 40px rgba(212, 160, 23, 0.3)"
    >
      <VStack gap={4} align="stretch">
        <Flex align="center" gap={2}>
          <Text fontSize="xl" fontWeight="bold" color="#F5D060">
            {t("claimed.title")}
          </Text>
        </Flex>

        <Text fontSize="md" color="gray.100" lineHeight="tall" fontWeight="medium">
          {t("claimed.description")}
        </Text>

        <Box bg="rgba(212, 160, 23, 0.1)" border="1px solid" borderColor="rgba(212, 160, 23, 0.35)" borderRadius="md" px={4} py={3}>
          <Text fontSize="sm" color="yellow.200" fontFamily="mono" wordBreak="break-word">
            {error}
          </Text>
        </Box>

        <Flex justify="center" py={3}>
          <Box w="90px" h="90px" dangerouslySetInnerHTML={{ __html: connectSvgRaw }} sx={{ '& svg': { width: '100%', height: '100%' } }} />
        </Flex>

        <Text fontSize="md" color="#F5D060" fontWeight="bold">
          {t("claimed.toConnect")}
        </Text>
        <VStack gap={2} align="stretch" pl={2}>
          <Text fontSize="md" color="gray.200" fontWeight="medium">{t("claimed.step1")}</Text>
          <Text fontSize="md" color="gray.200" fontWeight="medium">{t("claimed.step2")}</Text>
          <Text fontSize="md" color="gray.200" fontWeight="medium">{t("claimed.step3")}</Text>
        </VStack>

        <Text fontSize="sm" color="yellow.300" textAlign="center" mt={2} fontWeight="semibold">
          {t("claimed.waiting")}
        </Text>

        <Link
          href="https://support.keepkey.com"
          target="_blank"
          fontSize="sm"
          color="blue.300"
          textAlign="center"
          fontWeight="medium"
          _hover={{ color: "blue.200", textDecoration: "underline" }}
        >
          {t("claimed.supportLink")}
        </Link>
      </VStack>
    </Box>
  )
}
