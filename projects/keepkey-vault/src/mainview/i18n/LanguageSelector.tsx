import { Flex, Box, Text, Button } from "@chakra-ui/react"
import { useTranslation } from "react-i18next"
import { FaGlobe } from "react-icons/fa"
import { useState, useRef, useEffect } from "react"

export const LANGUAGES = [
	{ code: "en", label: "English" },
	{ code: "es", label: "Español" },
	{ code: "fr", label: "Français" },
	{ code: "de", label: "Deutsch" },
	{ code: "ja", label: "日本語" },
	{ code: "zh", label: "中文" },
	{ code: "ko", label: "한국어" },
	{ code: "pt", label: "Português" },
	{ code: "ru", label: "Русский" },
	{ code: "it", label: "Italiano" },
	{ code: "pl", label: "Polski" },
	{ code: "nl", label: "Nederlands" },
	{ code: "th", label: "ไทย" },
	{ code: "tr", label: "Türkçe" },
	{ code: "vi", label: "Tiếng Việt" },
] as const

export function LanguageSelector() {
	const { i18n } = useTranslation()
	const [expanded, setExpanded] = useState(false)
	const current = LANGUAGES.find(l => l.code === i18n.language) || LANGUAGES[0]

	return (
		<Box>
			<Flex
				as="button"
				align="center"
				justify="space-between"
				w="100%"
				cursor="pointer"
				onClick={() => setExpanded(o => !o)}
				py="1"
			>
				<Text fontSize="xs" color="kk.textMuted">Language</Text>
				<Flex align="center" gap="1.5">
					<Text fontSize="xs" color="kk.textPrimary" fontWeight="500">{current.label}</Text>
					<svg
						width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor"
						strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"
						style={{ transform: expanded ? "rotate(180deg)" : "rotate(0deg)", transition: "transform 0.15s", color: "var(--chakra-colors-kk-textSecondary)" }}
					>
						<polyline points="6 9 12 15 18 9" />
					</svg>
				</Flex>
			</Flex>
			{expanded && (
				<Flex flexWrap="wrap" gap="1" mt="2">
					{LANGUAGES.map(({ code, label }) => {
						const active = i18n.language === code
						return (
							<Box
								key={code}
								as="button"
								px="2"
								py="0.5"
								borderRadius="md"
								fontWeight={active ? "600" : "400"}
								fontSize="11px"
								lineHeight="1.4"
								bg={active ? "kk.gold" : "transparent"}
								color={active ? "black" : "kk.textSecondary"}
								border="1px solid"
								borderColor={active ? "kk.gold" : "kk.border"}
								cursor="pointer"
								_hover={{
									bg: active ? "kk.goldHover" : "rgba(192,168,96,0.1)",
									borderColor: active ? "kk.goldHover" : "kk.textMuted",
								}}
								transition="all 0.12s"
								onClick={() => i18n.changeLanguage(code)}
							>
								{label}
							</Box>
						)
					})}
				</Flex>
			)}
		</Box>
	)
}

/** Compact globe dropdown for use in wizard headers */
export function LanguagePicker() {
	const { i18n } = useTranslation()
	const [open, setOpen] = useState(false)
	const ref = useRef<HTMLDivElement>(null)

	useEffect(() => {
		if (!open) return
		const handler = (e: MouseEvent) => {
			if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
		}
		document.addEventListener("mousedown", handler)
		return () => document.removeEventListener("mousedown", handler)
	}, [open])

	const current = LANGUAGES.find(l => l.code === i18n.language) || LANGUAGES[0]

	return (
		<Box ref={ref} position="relative">
			<Flex
				as="button"
				align="center"
				gap="1.5"
				px="2"
				py="1"
				borderRadius="md"
				cursor="pointer"
				_hover={{ bg: "whiteAlpha.100" }}
				onClick={() => setOpen(o => !o)}
			>
				<FaGlobe color="#A0AEC0" size={12} />
				<Text fontSize="xs" color="gray.300">{current.label}</Text>
			</Flex>
			{open && (
				<Box
					position="absolute"
					top="100%"
					right="0"
					mt="1"
					bg="gray.800"
					border="1px solid"
					borderColor="gray.600"
					borderRadius="lg"
					boxShadow="0 8px 24px rgba(0,0,0,0.5)"
					py="1"
					zIndex={2000}
					minW="140px"
					maxH="280px"
					overflowY="auto"
				>
					{LANGUAGES.map(({ code, label }) => {
						const active = i18n.language === code
						return (
							<Flex
								key={code}
								as="button"
								w="100%"
								px="3"
								py="1.5"
								align="center"
								gap="2"
								fontSize="xs"
								color={active ? "green.300" : "gray.300"}
								fontWeight={active ? "600" : "400"}
								bg={active ? "whiteAlpha.100" : "transparent"}
								_hover={{ bg: "whiteAlpha.100" }}
								cursor="pointer"
								onClick={() => { i18n.changeLanguage(code); setOpen(false) }}
							>
								{label}
							</Flex>
						)
					})}
				</Box>
			)}
		</Box>
	)
}
