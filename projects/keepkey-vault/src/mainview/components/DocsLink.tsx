import { Text } from "@chakra-ui/react"
import type { TextProps } from "@chakra-ui/react"
import { FaExternalLinkAlt } from "react-icons/fa"
import { useTranslation } from "react-i18next"
import { rpcRequest } from "../lib/rpc"

/**
 * "Learn more" link to a docs.keepkey.com article.
 *
 * One component so every screen links identically — same wording, same
 * styling, same behaviour. Pass a slug from shared/docs-links.
 *
 * Opens through the `openUrl` RPC, NOT `target="_blank"`: this runs in an
 * Electrobun webview with no tab to open into, so an anchor's default
 * navigation is a dead click. `href` stays for right-click / copy-link.
 *
 * Style props are spread last, so callers can restyle it (the tutorial cards
 * render it as an accent pill) without a variant enum here.
 */
export function DocsLink({ href, label, color = "kk.textMuted", ...rest }: { href: string; label?: string } & TextProps) {
	const { t } = useTranslation("setup")
	return (
		<Text
			as="a"
			// @ts-expect-error -- Chakra's polymorphic props don't model anchor attrs
			href={href}
			onClick={(e: React.MouseEvent) => {
				e.preventDefault()
				e.stopPropagation()
				rpcRequest("openUrl", { url: href }).catch(() => {})
			}}
			cursor="pointer"
			display="inline-flex"
			alignItems="center"
			gap="1.5"
			fontSize="xs"
			color={color}
			textDecoration="underline"
			_hover={{ color: "gray.300" }}
			{...rest}
		>
			{label ?? t("initChoose.learnMore", { defaultValue: "Learn more" })}
			<FaExternalLinkAlt size={9} />
		</Text>
	)
}
