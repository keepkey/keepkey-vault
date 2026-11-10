import { Button, type ButtonProps } from "@chakra-ui/react"
import { forwardRef } from "react"

/**
 * Shared accent buttons. Use these instead of one-off inline button styles.
 *
 *   tone="gold" | "teal" | "rose"   tinted: soft fill, accent border + text
 *                                   (wallet-card CTAs, "Import watch-only")
 *   tone="primary"                  solid gold, dark text: the one main action
 *                                   on a screen or dialog (Save, Sign, Continue)
 *
 * Neutral actions keep using Chakra's <Button variant="outline" | "ghost">,
 * which theme.ts tunes for the dark shell. Size, radius and type scale come
 * from the same button recipe, so a tinted and a neutral button of the same
 * size line up exactly.
 */
export type ActionTone = "gold" | "teal" | "rose" | "primary"

const TINT: Record<Exclude<ActionTone, "primary">, { rgb: string; fg: string }> = {
	gold: { rgb: "233,196,106", fg: "var(--gold)" },
	teal: { rgb: "139,227,196", fg: "var(--teal)" },
	rose: { rgb: "224,140,123", fg: "var(--rose)" },
}

export function actionToneProps(tone: ActionTone): ButtonProps {
	if (tone === "primary") {
		return {
			variant: "solid",
			bg: "var(--gold)",
			color: "var(--ink-0)",
			borderColor: "transparent",
			_hover: { bg: "var(--gold-2)" },
			_expanded: { bg: "var(--gold-2)" },
		}
	}
	const { rgb, fg } = TINT[tone]
	return {
		variant: "outline",
		bg: `rgba(${rgb},0.10)`,
		color: fg,
		borderColor: `rgba(${rgb},0.30)`,
		_hover: { bg: `rgba(${rgb},0.18)`, borderColor: `rgba(${rgb},0.45)` },
		_expanded: { bg: `rgba(${rgb},0.18)` },
	}
}

export const ActionButton = forwardRef<HTMLButtonElement, ButtonProps & { tone?: ActionTone }>(
	function ActionButton({ tone = "gold", size = "sm", ...rest }, ref) {
		return <Button ref={ref} size={size} {...actionToneProps(tone)} {...rest} />
	},
)
