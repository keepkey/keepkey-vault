import { useMemo } from "react"
import CountUp from "react-countup"
import { Text, type TextProps } from "@chakra-ui/react"
import { useFiat } from "../lib/fiat-context"
import { getFiatConfig } from "../../shared/fiat"

interface AnimatedUsdProps extends TextProps {
	value: number
	/** Wrapper text before the formatted value (e.g. "(" for parenthesized display) */
	prefix?: string
	/** Wrapper text after the formatted value (e.g. ")") */
	suffix?: string
	duration?: number
	/** Override decimal places (defaults to the currency's configured decimals) */
	decimals?: number
}

/** Animated fiat counter. Delegates all number+symbol formatting to Intl.NumberFormat. */
export function AnimatedUsd({ value, prefix = "", suffix = "", duration = 1.2, decimals, color = "#23DCC8", ...textProps }: AnimatedUsdProps) {
	const { currency, locale } = useFiat()
	const cfg = getFiatConfig(currency)
	const dec = decimals ?? cfg.decimals

	const formatter = useMemo(() => {
		try {
			return new Intl.NumberFormat(locale, {
				style: 'currency',
				currency,
				minimumFractionDigits: dec,
				maximumFractionDigits: dec,
				currencyDisplay: 'narrowSymbol',
			})
		} catch {
			return null
		}
	}, [locale, currency, dec])

	const formatValue = (n: number) => {
		const formatted = formatter ? formatter.format(n) : `${cfg.symbol}${n.toFixed(dec)}`
		return `${prefix}${formatted}${suffix}`
	}

	if (!isFinite(value) || value <= 0) {
		return <Text as="span" color={color} {...textProps}>{formatValue(0)}</Text>
	}
	return (
		<Text as="span" color={color} {...textProps}>
			<CountUp key={value} start={0} end={value} decimals={dec} duration={duration} formattingFn={formatValue} preserveValue={false} />
		</Text>
	)
}
