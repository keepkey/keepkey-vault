import CountUp from "react-countup"
import { Text, type TextProps } from "@chakra-ui/react"

interface AnimatedUsdProps extends TextProps {
	value: number
	prefix?: string
	suffix?: string
	duration?: number
	decimals?: number
}

/** Animated USD counter with CountUp animation. */
export function AnimatedUsd({ value, prefix = "$", suffix, duration = 1.2, decimals = 2, color = "#23DCC8", ...textProps }: AnimatedUsdProps) {
	if (!isFinite(value) || value <= 0) {
		return <Text as="span" color={color} {...textProps}>{prefix}0.{'0'.repeat(decimals)}{suffix}</Text>
	}
	return (
		<Text as="span" color={color} {...textProps}>
			{prefix}
			<CountUp key={value} start={0} end={value} decimals={decimals} duration={duration} separator="," preserveValue={false} />
			{suffix}
		</Text>
	)
}
