/**
 * Branded "loading dashboard" state — shown after the splash clears and the
 * Dashboard chrome is mounted, but before any balances have arrived. Replaces
 * the dead empty canvas with the same 6-face CSS-3D KeepKey the swap controller
 * spins, wrapped in radar pulses, a breathing glow, and a cycling status line so
 * the wait reads as "your device is working" rather than "nothing happened".
 */
import { useEffect, useState } from "react"
import { Box, Flex, Text } from "@chakra-ui/react"
import { useTranslation } from "react-i18next"
import { SpinningDevice } from "./v3"

// Honest descriptions of the real sync pipeline — connect, pull balances, price
// them. No fake counts or dollar values; the bar is indeterminate on purpose.
const STATUS_KEYS = [
	{ key: "loadingConnect", fallback: "Connecting to your KeepKey" },
	{ key: "loadingSync", fallback: "Syncing balances across chains" },
	{ key: "loadingPrices", fallback: "Fetching the latest prices" },
] as const

const STATUS_INTERVAL_MS = 2200

/** OLED face content for the spinning device — a "syncing portfolio" readout
 *  with an indeterminate scan bar that sweeps under the gloss. */
function OledSyncScreen() {
	return (
		<div style={{ width: "100%" }}>
			<div style={{ fontSize: 11, opacity: 0.55, letterSpacing: 2, marginBottom: 8 }}>
				SYNCING PORTFOLIO
			</div>
			<div
				style={{
					position: "relative",
					height: 10,
					borderRadius: 3,
					background: "rgba(232,230,220,0.10)",
					overflow: "hidden",
				}}
			>
				<div
					style={{
						position: "absolute",
						top: 0,
						bottom: 0,
						left: 0,
						width: "38%",
						borderRadius: 3,
						background:
							"linear-gradient(90deg, transparent 0%, rgba(233,196,106,0.95) 50%, transparent 100%)",
						animation: "kkdlScan 1.5s ease-in-out infinite",
					}}
				/>
			</div>
			<div style={{ fontSize: 9, opacity: 0.45, letterSpacing: 1.5, marginTop: 8 }}>
				FETCHING BALANCES
			</div>
		</div>
	)
}

export function DashboardLoading() {
	const { t } = useTranslation("dashboard")
	const [statusIndex, setStatusIndex] = useState(0)

	useEffect(() => {
		const id = setInterval(() => {
			setStatusIndex((i) => (i + 1) % STATUS_KEYS.length)
		}, STATUS_INTERVAL_MS)
		return () => clearInterval(id)
	}, [])

	const status = STATUS_KEYS[statusIndex]!

	return (
		<Flex
			direction="column"
			align="center"
			justify="center"
			w="100%"
			h="100%"
			position="relative"
			gap="0"
			style={{ animation: "kkdlEnter 0.5s ease both" }}
		>
			{/* Stage: radar pulses + glow halo sit behind the rotating device. */}
			<Box position="relative" w="340px" maxW="78%" mb="6">
				{/* Breathing glow halo */}
				<Box
					position="absolute"
					inset="-22% -8%"
					pointerEvents="none"
					zIndex={0}
					style={{
						background:
							"radial-gradient(ellipse 60% 52% at 50% 50%, rgba(233,196,106,0.26) 0%, rgba(139,227,196,0.07) 42%, transparent 72%)",
						animation: "kkdlBreathe 3.6s ease-in-out infinite",
					}}
				/>
				{/* Expanding radar rings — two staggered so one is always emanating. */}
				<Box position="absolute" inset="0" display="grid" placeItems="center" pointerEvents="none" zIndex={0}>
					<Box className="kkdl-ring" style={{ animationDelay: "0s" }} />
					<Box className="kkdl-ring" style={{ animationDelay: "1.4s" }} />
				</Box>
				{/* The spinning device itself */}
				<Box position="relative" zIndex={1}>
					<SpinningDevice durationSeconds={9} screen={<OledSyncScreen />} />
				</Box>
			</Box>

			{/* Headline + cycling status + indeterminate shimmer bar. */}
			<Flex direction="column" align="center" gap="3" position="relative" zIndex={1} maxW="420px" px="4">
				<Text
					fontSize="22px"
					fontWeight="700"
					letterSpacing="-0.02em"
					color="var(--text-0)"
					textAlign="center"
					style={{
						background: "linear-gradient(180deg, #fff 0%, #e9c46a 140%)",
						WebkitBackgroundClip: "text",
						WebkitTextFillColor: "transparent",
						backgroundClip: "text",
					}}
				>
					{t("loadingDashboardTitle", "Loading dashboard")}
				</Text>

				{/* Status line — crossfades as the step changes. key= forces remount → fade. */}
				<Box h="18px" position="relative" w="100%" textAlign="center">
					<Text
						key={statusIndex}
						fontSize="13px"
						color="var(--text-2)"
						letterSpacing="-0.005em"
						style={{ animation: "kkdlFadeUp 0.45s ease both" }}
					>
						{t(status.key, status.fallback)}
						<Box as="span" ml="1px" style={{ animation: "kkdlBlink 1.2s step-end infinite" }}>…</Box>
					</Text>
				</Box>

				{/* Indeterminate gold shimmer bar. */}
				<Box
					position="relative"
					w="200px"
					maxW="60vw"
					h="3px"
					borderRadius="999px"
					overflow="hidden"
					bg="rgba(255,255,255,0.07)"
					mt="1"
				>
					<Box
						position="absolute"
						top="0"
						bottom="0"
						left="0"
						w="42%"
						borderRadius="999px"
						style={{
							background:
								"linear-gradient(90deg, transparent 0%, var(--gold) 45%, var(--teal) 75%, transparent 100%)",
							animation: "kkdlShimmer 1.6s cubic-bezier(0.45,0,0.55,1) infinite",
						}}
					/>
				</Box>
			</Flex>

			<style>{`
				@keyframes kkdlEnter {
					from { opacity: 0; transform: translateY(8px); }
					to   { opacity: 1; transform: translateY(0); }
				}
				@keyframes kkdlBreathe {
					0%, 100% { opacity: 0.65; transform: scale(0.97); }
					50%      { opacity: 1;    transform: scale(1.04); }
				}
				@keyframes kkdlScan {
					0%   { transform: translateX(-110%); }
					100% { transform: translateX(285%); }
				}
				@keyframes kkdlShimmer {
					0%   { transform: translateX(-120%); }
					100% { transform: translateX(360%); }
				}
				@keyframes kkdlFadeUp {
					from { opacity: 0; transform: translateY(5px); }
					to   { opacity: 1; transform: translateY(0); }
				}
				@keyframes kkdlBlink {
					0%, 60% { opacity: 1; }
					80%, 100% { opacity: 0.15; }
				}
				@keyframes kkdlRing {
					0%   { width: 120px; height: 120px; opacity: 0.5; }
					100% { width: 360px; height: 360px; opacity: 0; }
				}
				.kkdl-ring {
					position: absolute;
					border-radius: 50%;
					border: 1px solid rgba(233,196,106,0.32);
					animation: kkdlRing 2.8s ease-out infinite;
				}
				@media (prefers-reduced-motion: reduce) {
					.kkdl-ring { display: none; }
				}
			`}</style>
		</Flex>
	)
}
