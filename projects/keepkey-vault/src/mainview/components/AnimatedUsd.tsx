import CountUp from "react-countup"
import { Text, type TextProps } from "@chakra-ui/react"

interface AnimatedUsdProps extends TextProps {
	value: number
	prefix?: string
	suffix?: string
	duration?: number
}

/** Animated USD counter — drops in anywhere a static $X.XX was shown. */
export function AnimatedUsd({ value, prefix = "$", suffix, duration = 1.2, ...textProps }: AnimatedUsdProps) {
	if (!isFinite(value) || value <= 0) {
		return <Text as="span" {...textProps}>{prefix}0.00{suffix}</Text>
	}
	return (
		<Text as="span" {...textProps}>
			{prefix}
			<CountUp key={value} end={value} decimals={2} duration={duration} separator="," preserveValue={false} />
			{suffix}
		</Text>
	)
}
