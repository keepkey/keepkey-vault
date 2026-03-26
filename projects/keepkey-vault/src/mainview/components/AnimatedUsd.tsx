import CountUp from "react-countup"
import { Text, type TextProps } from "@chakra-ui/react"
import { useFiat } from "../lib/fiat-context"

interface AnimatedUsdProps extends TextProps {
	value: number
	prefix?: string
	suffix?: string
	duration?: number
	decimals?: number
}

/** Animated fiat counter with CountUp animation. Uses the user's fiat symbol by default. */
export function AnimatedUsd({ value, prefix, suffix, duration = 1.2, decimals = 2, color = "#23DCC8", ...textProps }: AnimatedUsdProps) {
	const { symbol, locale } = useFiat()
	const p = prefix ?? symbol
	const sep = locale.startsWith('de') || locale.startsWith('fr') || locale.startsWith('pt') || locale.startsWith('it') || locale.startsWith('pl') || locale.startsWith('cs') || locale.startsWith('da') || locale.startsWith('nb') || locale.startsWith('sv') || locale.startsWith('hu') || locale.startsWith('tr') || locale.startsWith('ru') ? '.' : ','
	const dec = sep === '.' ? ',' : '.'

	if (!isFinite(value) || value <= 0) {
		return <Text as="span" color={color} {...textProps}>{p}0{dec}{'0'.repeat(decimals)}{suffix}</Text>
	}
	return (
		<Text as="span" color={color} {...textProps}>
			{p}
			<CountUp key={value} start={0} end={value} decimals={decimals} duration={duration} separator={sep} decimal={dec} preserveValue={false} />
			{suffix}
		</Text>
	)
}
