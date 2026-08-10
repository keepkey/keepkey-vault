import { Text } from "@chakra-ui/react"
import { useTranslation } from "react-i18next"

/**
 * "Learn more" link to a docs.keepkey.com article.
 *
 * One component so every screen links identically — same wording, same
 * styling, same new-tab safety attrs. Pass a slug from shared/docs-links.
 */
export function DocsLink({ href, label, color = "kk.textMuted" }: { href: string; label?: string; color?: string }) {
	const { t } = useTranslation("setup")
	return (
		<Text
			as="a"
			// @ts-expect-error -- Chakra's polymorphic props don't model anchor attrs
			href={href}
			target="_blank"
			rel="noopener noreferrer"
			fontSize="2xs"
			color={color}
			textDecoration="underline"
			_hover={{ color: "gray.300" }}
			onClick={(e: React.MouseEvent) => e.stopPropagation()}
		>
			{label ?? t("initChoose.learnMore", { defaultValue: "Learn more" })}
		</Text>
	)
}
