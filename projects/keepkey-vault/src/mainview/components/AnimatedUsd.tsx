import CountUp from "react-countup"
import { Text, type TextProps } from "@chakra-ui/react"
import { useFiat } from "../lib/fiat-context"
import { getFiatConfig } from "../../shared/fiat"

interface AnimatedUsdProps extends TextProps {
	value: number
	prefix?: string
	suffix?: string
	duration?: number
}

/** Animated fiat counter — uses the user's chosen currency and locale. */
export function AnimatedUsd({ value, prefix, suffix, duration = 1.2, ...textProps }: AnimatedUsdProps) {
	const { currency, locale } = useFiat()
	const cfg = getFiatConfig(currency)
	const displayPrefix = prefix !== undefined ? prefix : cfg.symbol

	// Determine separator from locale
	const parts = new Intl.NumberFormat(locale).formatToParts(1234.5)
	const group = parts.find(p => p.type === 'group')?.value || ','
	const decimal = parts.find(p => p.type === 'decimal')?.value || '.'

	if (!isFinite(value) || value <= 0) {
		return <Text as="span" {...textProps}>{displayPrefix}0{decimal}{'0'.repeat(cfg.decimals)}{suffix}</Text>
	}
	return (
		<Text as="span" {...textProps}>
			{displayPrefix}
			<CountUp key={value} end={value} decimals={cfg.decimals} duration={duration} separator={group} decimal={decimal} preserveValue={false} />
			{suffix}
		</Text>
	)
}
