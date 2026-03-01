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

  // Warning/error: render as subtle bottom-right toast
  if (phase === "warning" || phase === "error") {
    if (!toastVisible) return null

    const isError = phase === "error"
    const bg = isError ? "rgba(255,23,68,0.12)" : "rgba(251,191,36,0.08)"
    const border = isError ? "rgba(255,23,68,0.25)" : "rgba(251,191,36,0.18)"
    const accent = isError ? "#FF6B6B" : "#FBBF24"

    return (
      <Box
        position="fixed"
        bottom="16px"
        right="16px"
        zIndex={999}
        maxW="340px"
        opacity={toastVisible ? 1 : 0}
        transform={toastVisible ? "translateY(0)" : "translateY(8px)"}
        transition="opacity 0.3s, transform 0.3s"
      >
        <Flex
          align="center"
          bg={bg}
          border="1px solid"
          borderColor={border}
          borderRadius="lg"
          px="3"
          py="2"
          gap="2"
          backdropFilter="blur(8px)"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" style={{ flexShrink: 0 }}>
            {isError ? (
              <>
                <path d="M12 2L1 21h22L12 2z" fill={accent} />
                <path d="M12 9v4M12 17h.01" stroke="white" strokeWidth="2" strokeLinecap="round" />
              </>
            ) : (
              <>
                <circle cx="12" cy="12" r="10" fill={accent} />
                <path d="M12 8v4M12 16h.01" stroke="white" strokeWidth="2" strokeLinecap="round" />
              </>
            )}
          </svg>
          <Text fontSize="xs" color={accent} flex="1" minW="0" truncate>
            {isError
              ? t("errorWithMessage", { error: error || message || "Unknown error" })
              : t("checkFailed", { defaultValue: "Update check failed" })}
          </Text>
          <Button
            size="xs"
            variant="ghost"
            color="kk.textSecondary"
            _hover={{ color: "kk.textPrimary" }}
            onClick={() => { setToastVisible(false); onDismiss() }}
            px="1"
            minW="auto"
            h="auto"
          >
            ✕
          </Button>
        </Flex>
      </Box>
    )
  }

  // Actionable phases (available, downloading, ready, applying): full-width top banner
  const bgColor =
    phase === "ready" ? "rgba(34,197,94,0.12)"
    : "rgba(192,168,96,0.12)"

  const borderColor =
    phase === "ready" ? "rgba(34,197,94,0.3)"
    : "rgba(192,168,96,0.3)"

  const accentColor =
    phase === "ready" ? "#22C55E"
    : "kk.gold"

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
        bg={bgColor}
        border="1px solid"
        borderColor={borderColor}
        borderRadius="lg"
        px="4"
        py="2.5"
        mx="auto"
        maxW="900px"
        mt="2"
        gap="3"
      >
        {/* Icon */}
        <Flex align="center" gap="3" flex="1" minW="0">
          {phase === "ready" ? (
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
              <circle cx="12" cy="12" r="10" fill="#22C55E" />
              <path d="M9 12l2 2 4-4" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          ) : (
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#C0A860" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <polyline points="7 10 12 15 17 10" />
              <line x1="12" y1="15" x2="12" y2="3" />
            </svg>
          )}

          {/* Text */}
          <Box flex="1" minW="0">
            <Text fontSize="sm" color={accentColor} fontWeight="500" truncate>
              {phase === "available" && (message || t("newVersionAvailable"))}
              {phase === "downloading" && (
                progress !== undefined
                  ? t("downloadingWithProgress", { progress: Math.round(progress) })
                  : t("downloading")
              )}
              {phase === "ready" && t("readyToInstall")}
              {phase === "applying" && t("applying")}
            </Text>
            {/* Progress bar for downloading */}
            {phase === "downloading" && progress !== undefined && (
              <Box mt="1" h="3px" bg="rgba(255,255,255,0.1)" borderRadius="full" overflow="hidden">
                <Box h="100%" w={`${Math.min(progress, 100)}%`} bg="kk.gold" borderRadius="full" transition="width 0.3s" />
              </Box>
            )}
          </Box>
        </Flex>

        {/* Actions */}
        <Flex gap="2" flexShrink={0}>
          {phase === "available" && (
            <>
              <Button size="xs" bg="kk.gold" color="black" _hover={{ bg: "kk.goldHover" }} onClick={onDownload}>
                {t("download")}
              </Button>
              <Button size="xs" variant="ghost" color="kk.textSecondary" _hover={{ color: "kk.textPrimary" }} onClick={onDismiss}>
                {t("later")}
              </Button>
            </>
          )}
          {phase === "ready" && (
            <>
              <Button size="xs" bg="#22C55E" color="white" _hover={{ bg: "#16A34A" }} onClick={onApply}>
                {t("restartToUpdate")}
              </Button>
              <Button size="xs" variant="ghost" color="kk.textSecondary" _hover={{ color: "kk.textPrimary" }} onClick={onDismiss}>
                {t("later")}
              </Button>
            </>
          )}
        </Flex>
      </Flex>
    </Box>
  )
}
