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
      bg="linear-gradient(180deg, var(--ink-2), var(--ink-1))"
      border="1px solid var(--line-2)"
      borderRadius="var(--r-lg)"
      px={8}
      py={7}
      maxW="460px"
      w="90%"
      boxShadow="var(--shadow-2)"
    >
      <VStack gap={4} align="stretch">
        <Flex align="center" gap={2}>
          <Box w="6px" h="6px" borderRadius="full" bg="var(--gold)" />
          <Text fontSize="lg" fontWeight="600" color="var(--text-0)" letterSpacing="-0.01em">
            {t("claimed.title")}
          </Text>
        </Flex>

        <Text fontSize="14px" color="var(--text-1)" lineHeight="1.55">
          {t("claimed.description")}
        </Text>

        <Box
          bg="var(--ink-0)"
          border="1px solid var(--line)"
          borderRadius="var(--r-md)"
          px={4}
          py={3}
        >
          <Text fontSize="12px" color="var(--text-2)" fontFamily="mono" wordBreak="break-word">
            {error}
          </Text>
        </Box>

        <Flex justify="center" py={3}>
          <Box
            w="90px"
            h="90px"
            opacity="0.85"
            dangerouslySetInnerHTML={{ __html: connectSvgRaw }}
            sx={{ '& svg': { width: '100%', height: '100%' } }}
          />
        </Flex>

        <Text fontSize="13px" color="var(--gold)" fontWeight="600" letterSpacing="0.04em" textTransform="uppercase">
          {t("claimed.toConnect")}
        </Text>
        <VStack gap={2} align="stretch" pl={2}>
          <Text fontSize="14px" color="var(--text-1)" lineHeight="1.5">{t("claimed.step1")}</Text>
          <Text fontSize="14px" color="var(--text-1)" lineHeight="1.5">{t("claimed.step2")}</Text>
          <Text fontSize="14px" color="var(--text-1)" lineHeight="1.5">{t("claimed.step3")}</Text>
        </VStack>

        <Flex align="center" justify="center" gap="2" mt={2}>
          <Box w="6px" h="6px" borderRadius="full" bg="var(--teal)" style={{ animation: "splashPulse 1.5s infinite" }} />
          <Text fontSize="12px" color="var(--text-2)" letterSpacing="-0.005em">
            {t("claimed.waiting")}
          </Text>
        </Flex>

        <Link
          href="https://support.keepkey.com"
          target="_blank"
          fontSize="12px"
          color="var(--text-3)"
          textAlign="center"
          fontWeight="500"
          letterSpacing="0.04em"
          _hover={{ color: "var(--teal)", textDecoration: "underline" }}
        >
          {t("claimed.supportLink")}
        </Link>
      </VStack>
    </Box>
  )
}
