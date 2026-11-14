import { Box, Button, Flex, Text } from "@chakra-ui/react"
import { useTranslation } from "react-i18next"
import { actionToneProps } from "./ui/ActionButton"

/** A KeepKey Desktop can't talk to: the reason, what to do and Retry, as one
 * dialog. Not red — a replug is routine, not danger. The raw code is for support. */
export function DeviceErrorDialog({ title, hint, code, onRetry }: {
	title: string; hint: string; code?: string | null; onRetry: () => void
}) {
	const { t } = useTranslation()
	return (
		<Box role="alertdialog" aria-label={title} mx="auto" mb="6" maxW="440px" w="90%" px="6" py="5"
			bg="linear-gradient(180deg, var(--ink-2), var(--ink-1))" border="1px solid var(--line-2)" borderRadius="var(--r-lg)" boxShadow="var(--shadow-2)">
			<Flex align="center" gap="2">
				<Box w="6px" h="6px" borderRadius="full" bg="var(--gold)" />
				<Text fontSize="16px" fontWeight="600" color="var(--text-0)">{title}</Text>
			</Flex>
			<Text mt="2" fontSize="14px" lineHeight="1.55" color="var(--text-1)">{hint}</Text>
			<Flex mt="4" align="center" justify="space-between" gap="3">
				<Text fontSize="11px" fontFamily="mono" color="var(--text-3)" wordBreak="break-word">
					{code ? t("deviceErrorDetail", { ns: "nav", defaultValue: "Error code: {{code}}", code }) : null}
				</Text>
				<Button {...actionToneProps("primary")} size="sm" flexShrink={0} onClick={onRetry}>{t("retry", { ns: "common" })}</Button>
			</Flex>
		</Box>
	)
}
