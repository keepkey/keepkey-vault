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

  // Actionable phases: full-width top banner
  const isReady = phase === "ready"
  const accentColor = isReady ? "var(--teal)" : "var(--gold)"
  const accentRgb   = isReady ? "139,227,196"  : "233,196,106"

  return (
    <Box
      position="fixed"
      top="50px"
      left="0"
      right="0"
      zIndex={999}
      px="4"
      py="0"
    >
      <Flex
        align="center"
        justify="space-between"
        bg={`rgba(${accentRgb},0.08)`}
        border="1px solid"
        borderColor={`rgba(${accentRgb},0.22)`}
        borderRadius="14px"
        px="4"
        py="2.5"
        mx="auto"
        maxW="900px"
        mt="2"
        gap="3"
        backdropFilter="blur(8px)"
      >
        <Flex align="center" gap="3" flex="1" minW="0">
          {isReady ? (
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
              <circle cx="12" cy="12" r="10" fill={accentColor} />
              <path d="M9 12l2 2 4-4" stroke="var(--ink-0)" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          ) : (
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke={accentColor} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <polyline points="7 10 12 15 17 10" />
              <line x1="12" y1="15" x2="12" y2="3" />
            </svg>
          )}

          <Box flex="1" minW="0">
            <Text fontSize="13px" color={accentColor} fontWeight="500" truncate letterSpacing="-0.005em">
              {phase === "available" && t("newVersionAvailable")}
              {phase === "downloading" && (
                progress !== undefined
                  ? t("downloadingWithProgress", { progress: Math.round(progress) })
                  : t("downloading")
              )}
              {phase === "ready" && t("readyToInstall")}
              {phase === "applying" && t("applying")}
            </Text>
            {phase === "downloading" && progress !== undefined && (
              <Box mt="1.5" h="3px" bg="var(--ink-3)" borderRadius="999px" overflow="hidden">
                <Box h="100%" w={`${Math.min(progress, 100)}%`} bg="var(--gold)" borderRadius="999px" transition="width 0.3s" />
              </Box>
            )}
          </Box>
        </Flex>

        <Flex gap="2" flexShrink={0}>
          {phase === "available" && (
            <>
              <Button
                size="xs"
                bg="var(--gold)"
                color="var(--ink-0)"
                fontWeight="600"
                _hover={{ bg: "var(--gold-2)" }}
                onClick={onDownload}
              >
                {t("download")}
              </Button>
              <Button
                size="xs"
                variant="ghost"
                color="var(--text-2)"
                _hover={{ color: "var(--text-0)" }}
                onClick={onDismiss}
              >
                {t("later")}
              </Button>
            </>
          )}
          {phase === "ready" && (
            <>
              <Button
                size="xs"
                bg="var(--teal)"
                color="var(--ink-0)"
                fontWeight="600"
                _hover={{ bg: "var(--teal-2)" }}
                onClick={onApply}
              >
                {t("restartToUpdate")}
              </Button>
              <Button
                size="xs"
                variant="ghost"
                color="var(--text-2)"
                _hover={{ color: "var(--text-0)" }}
                onClick={onDismiss}
              >
                {t("later")}
              </Button>
            </>
          )}
        </Flex>
      </Flex>
    </Box>
  )
}
