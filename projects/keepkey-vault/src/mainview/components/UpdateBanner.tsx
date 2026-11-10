import { Box, Flex, Text, Button } from "@chakra-ui/react"
import { useTranslation } from "react-i18next"
import { useEffect, useState } from "react"
import type { UpdatePhaseUI } from "../hooks/useUpdateState"

interface UpdateBannerProps {
  phase: UpdatePhaseUI
  progress: number | undefined
  message: string
  error: string | undefined
  onDownload: () => void
  onApply: () => void
  onDismiss: () => void
}

export function UpdateBanner({ phase, progress, message, error, onDownload, onApply, onDismiss }: UpdateBannerProps) {
  const { t } = useTranslation("update")
  const [toastVisible, setToastVisible] = useState(false)

  // Auto-dismiss warning/error toasts after 20 seconds
  useEffect(() => {
    if (phase === "warning" || phase === "error") {
      setToastVisible(true)
      const timer = setTimeout(() => {
        setToastVisible(false)
        onDismiss()
      }, 20_000)
      return () => clearTimeout(timer)
    }
    setToastVisible(false)
  }, [phase, error, message])

  // Hidden for idle and checking phases
  if (phase === "idle" || phase === "checking") return null

  // Warning/error: subtle bottom-right toast
  if (phase === "warning" || phase === "error") {
    if (!toastVisible) return null

    const isError = phase === "error"
    const accent = isError ? "var(--rose)" : "var(--gold)"
    const bg     = isError ? "rgba(224,140,123,0.10)" : "rgba(233,196,106,0.08)"
    const border = isError ? "rgba(224,140,123,0.25)" : "rgba(233,196,106,0.22)"

    return (
      <Box
        position="fixed"
        bottom="16px"
        right="16px"
        zIndex={999}
        maxW="360px"
        opacity={toastVisible ? 1 : 0}
        transform={toastVisible ? "translateY(0)" : "translateY(8px)"}
        transition="opacity 0.3s, transform 0.3s"
      >
        <Flex
          align="center"
          bg={bg}
          border="1px solid"
          borderColor={border}
          borderRadius="999px"
          px="3.5"
          py="2"
          gap="2.5"
          backdropFilter="blur(12px)"
        >
          <Box w="6px" h="6px" borderRadius="full" bg={accent} flexShrink={0} />
          <Text fontSize="12px" color="var(--text-1)" flex="1" minW="0" truncate letterSpacing="-0.005em">
            {isError
              ? t("errorWithMessage", { error: error || message || "Unknown error" })
              : t("checkFailed", { defaultValue: "Update check failed" })}
          </Text>
          <Box
            as="button"
            onClick={() => { setToastVisible(false); onDismiss() }}
            color="var(--text-3)"
            _hover={{ color: "var(--text-0)" }}
            cursor="pointer"
            fontSize="13px"
            lineHeight="1"
            px="1"
          >
            ✕
          </Box>
        </Flex>
      </Box>
    )
  }

  // Actionable phases: top banner. Neutral surface with an accent edge and an
  // icon badge, a two-level text block (title + version / progress), and
  // padded actions — explicit px because the app's unlayered `* { padding: 0 }`
  // reset beats Chakra's layered button recipe.
  const isReady = phase === "ready"
  const accentColor = isReady ? "var(--teal)" : "var(--gold)"
  const accentRgb   = isReady ? "139,227,196"  : "233,196,106"
  // useUpdateState reports "Version X available" for the available phase.
  const version = phase === "available" ? message.match(/(\d+\.\d+\.\d+[^\s]*)/)?.[1] : undefined
  const title =
    phase === "available" ? t("newVersionAvailable")
    : phase === "downloading" ? (progress !== undefined ? t("downloadingWithProgress", { progress: Math.round(progress) }) : t("downloading"))
    : phase === "ready" ? t("readyToInstall")
    : t("applying")

  return (
    <Box position="fixed" top="50px" left="0" right="0" zIndex={999} px="4">
      <Flex
        role="status"
        align="center"
        gap="4"
        mx="auto"
        mt="3"
        maxW="720px"
        pl="4"
        pr="3"
        py="3"
        bg="rgba(22,22,29,0.92)"
        border="1px solid var(--line-2)"
        borderLeft={`3px solid ${accentColor}`}
        borderRadius="14px"
        boxShadow="0 8px 24px rgba(0,0,0,0.35)"
        backdropFilter="blur(10px)"
      >
        <Flex
          align="center"
          justify="center"
          w="34px"
          h="34px"
          borderRadius="full"
          bg={`rgba(${accentRgb},0.14)`}
          flexShrink={0}
        >
          {isReady ? (
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke={accentColor} strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M5 12l4 4 10-10" />
            </svg>
          ) : (
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke={accentColor} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <polyline points="7 10 12 15 17 10" />
              <line x1="12" y1="15" x2="12" y2="3" />
            </svg>
          )}
        </Flex>

        <Box flex="1" minW="0">
          <Text fontSize="13px" fontWeight="600" color="var(--text-0)" truncate letterSpacing="-0.005em">
            {title}
          </Text>
          {version && (
            <Text as="span" display="inline-block" mt="1" px="2" py="0.5" borderRadius="999px"
              fontSize="11px" fontFamily="mono" color={accentColor} bg={`rgba(${accentRgb},0.10)`}>
              v{version.replace(/^v/, "")}
            </Text>
          )}
          {phase === "downloading" && progress !== undefined && (
            <Box mt="2" h="4px" bg="var(--ink-3)" borderRadius="999px" overflow="hidden">
              <Box h="100%" w={`${Math.min(progress, 100)}%`} bg={accentColor} borderRadius="999px" transition="width 0.3s" />
            </Box>
          )}
        </Box>

        {(phase === "available" || phase === "ready") && (
          <Flex gap="1" align="center" flexShrink={0}>
            <Button
              size="sm"
              px="3"
              variant="ghost"
              color="var(--text-2)"
              _hover={{ color: "var(--text-0)", bg: "var(--ink-3)" }}
              onClick={onDismiss}
            >
              {t("later")}
            </Button>
            <Button
              size="sm"
              px="4"
              bg={accentColor}
              color="var(--ink-0)"
              fontWeight="600"
              _hover={{ bg: isReady ? "var(--teal-2)" : "var(--gold-2)" }}
              onClick={isReady ? onApply : onDownload}
            >
              {isReady ? t("restartToUpdate") : t("download")}
            </Button>
          </Flex>
        )}
      </Flex>
    </Box>
  )
}
