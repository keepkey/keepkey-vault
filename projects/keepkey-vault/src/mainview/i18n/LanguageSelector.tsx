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
] as const

export function LanguageSelector() {
	const { i18n } = useTranslation()

	return (
		<Flex flexWrap="wrap" gap="2">
			{LANGUAGES.map(({ code, label }) => {
				const active = i18n.language === code
				return (
					<Button
						key={code}
						size="xs"
						px="3"
						py="1"
						borderRadius="full"
						fontWeight={active ? "600" : "400"}
						fontSize="xs"
						bg={active ? "kk.gold" : "transparent"}
						color={active ? "black" : "kk.textSecondary"}
						border="1px solid"
						borderColor={active ? "kk.gold" : "kk.border"}
						_hover={{
							bg: active ? "kk.goldHover" : "rgba(192,168,96,0.1)",
							borderColor: active ? "kk.goldHover" : "kk.textMuted",
						}}
						onClick={() => i18n.changeLanguage(code)}
					>
						{label}
					</Button>
				)
			})}
		</Flex>
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
