import { useCallback, useEffect, useRef, useState } from "react"
import { Box, Image } from "@chakra-ui/react"
import { playBark } from "../lib/sounds"
import dogeImg from "../assets/doge.png"

const PHRASES = [
	// Classic doge
	"wow!",
	"much wow",
	"such doge",
	"very bark",
	"so amaze",
	"many wow",
	"so scare",
	"very confuse",
	"such excite",
	"plz",
	"hello frens",
	// Crypto-flavored
	"to the moon",
	"hodl strong",
	"much hodl",
	"such crypto",
	"very blockchain",
	"so decentralize",
	"many gainz",
	"such bull",
	"wow much profit",
	"diamond paws",
	"never sell",
	// KeepKey / vault-flavored
	"such cold storage",
	"very keepkey",
	"much secure",
	"many chains",
	"so private key",
	"such hardware",
	"very sign",
	"no rug",
	"so balance",
	"many token",
]
/** Auto-dismiss timeout (ms). Resets each time the user clicks the dog. */
const DISMISS_AFTER_MS = 8000

const ANIMS = `
@keyframes doge-slide-in {
  from { transform: translate(140%, 60%) rotate(12deg); opacity: 0; }
  to   { transform: translate(0, 0) rotate(0); opacity: 1; }
}
@keyframes doge-slide-out {
  from { transform: translate(0, 0); opacity: 1; }
  to   { transform: translate(140%, 60%) rotate(12deg); opacity: 0; }
}
@keyframes doge-bob {
  0%, 100% { transform: translateY(0) rotate(-3deg); }
  50%      { transform: translateY(-8px) rotate(3deg); }
}
@keyframes doge-bubble-pop {
  0%   { opacity: 0; transform: translate(-50%, 12px) scale(0.85); }
  60%  { opacity: 1; transform: translate(-50%, 0) scale(1.06); }
  100% { opacity: 1; transform: translate(-50%, 0) scale(1); }
}
`

/** Bottom-right mascot, shown only when the user has drilled into Dogecoin.
 *  Slides in, gently bobs, barks on first appearance and on click, then
 *  auto-dismisses after a few seconds (timer resets on each click). */
export function DogeEasterEgg() {
	const [bubble, setBubble] = useState<string | null>(null)
	const [leaving, setLeaving] = useState(false)
	const [unmounted, setUnmounted] = useState(false)
	const bubbleTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
	const dismissTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

	function flashBubble(msg: string) {
		setBubble(msg)
		if (bubbleTimer.current) clearTimeout(bubbleTimer.current)
		bubbleTimer.current = setTimeout(() => setBubble(null), 1800)
	}

	const scheduleDismiss = useCallback(() => {
		if (dismissTimer.current) clearTimeout(dismissTimer.current)
		dismissTimer.current = setTimeout(() => setLeaving(true), DISMISS_AFTER_MS)
	}, [])

	// Auto-bark shortly after appearing + arm the auto-dismiss timer.
	// Pick a random phrase so every remount (e.g. when the user navigates
	// back to Dogecoin from another chain) feels different.
	useEffect(() => {
		const id = setTimeout(() => {
			playBark()
			flashBubble(PHRASES[Math.floor(Math.random() * PHRASES.length)]!)
		}, 650)
		scheduleDismiss()
		return () => {
			clearTimeout(id)
			if (bubbleTimer.current) clearTimeout(bubbleTimer.current)
			if (dismissTimer.current) clearTimeout(dismissTimer.current)
		}
	}, [scheduleDismiss])

	if (unmounted) return null

	return (
		<Box
			position="fixed"
			right="24px"
			bottom="24px"
			zIndex={50}
			pointerEvents={leaving ? "none" : "auto"}
			onAnimationEnd={(e) => {
				if (e.animationName === "doge-slide-out") setUnmounted(true)
			}}
			style={{
				animation: leaving
					? "doge-slide-out 0.6s cubic-bezier(0.4,0,0.2,1) both"
					: "doge-slide-in 0.7s cubic-bezier(0.2,0.8,0.2,1) both",
			}}
		>
			<style>{ANIMS}</style>

			{bubble && (
				<Box
					position="absolute"
					bottom="100%"
					left="50%"
					transform="translateX(-50%)"
					mb="3"
					px="3"
					py="1.5"
					bg="var(--gold)"
					color="var(--ink-0)"
					borderRadius="999px"
					fontWeight={600}
					fontSize="13px"
					whiteSpace="nowrap"
					boxShadow="0 8px 24px -8px rgba(233,196,106,0.6)"
					style={{ animation: "doge-bubble-pop 0.32s cubic-bezier(0.2,0.8,0.2,1) both" }}
				>
					{bubble}
				</Box>
			)}

			<Box
				as="button"
				bg="transparent"
				border="0"
				p={0}
				cursor="pointer"
				onClick={() => {
					playBark()
					flashBubble(PHRASES[Math.floor(Math.random() * PHRASES.length)]!)
					scheduleDismiss()
				}}
				style={{
					animation: "doge-bob 2.2s ease-in-out infinite",
					filter: "drop-shadow(0 8px 18px rgba(0,0,0,0.5)) drop-shadow(0 0 28px rgba(233,196,106,0.55))",
				}}
				title="click for bark"
			>
				<Image
					src={dogeImg}
					alt="doge"
					w={{ base: "120px", md: "150px" }}
					h="auto"
					draggable={false}
					userSelect="none"
				/>
			</Box>
		</Box>
	)
}
