import { Flex, Button } from "@chakra-ui/react"
import { useTranslation } from "react-i18next"

const LANGUAGES = [
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
