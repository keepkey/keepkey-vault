/**
 * Emulator button — small chip icon in bottom-right corner of splash screen.
 * macOS-only. Handles pairing (keychain) + init (decrypt flash + load dylib).
 */
import { useState, useEffect } from "react"
import { Box, Flex, Text } from "@chakra-ui/react"
import { rpcRequest } from "../lib/rpc"
import type { EmulatorStatus } from "../../shared/types"

export function EmulatorButton() {
	const [status, setStatus] = useState<EmulatorStatus | null>(null)
	const [loading, setLoading] = useState(false)
	const [expanded, setExpanded] = useState(false)

	useEffect(() => {
		rpcRequest<EmulatorStatus>("emulatorStatus", undefined, 5000)
			.then(setStatus)
			.catch(() => {})
	}, [])

	// Not macOS — don't render
	if (status && status.platform !== "darwin") return null
	// Status not loaded yet
	if (!status) return null

	const handleClick = async () => {
		if (loading) return

		// If not paired, pair first
		if (!status.paired) {
			setLoading(true)
			try {
				const s = await rpcRequest<EmulatorStatus>("emulatorPair", undefined, 10000)
				setStatus(s)
			} catch (e: any) {
				console.error("emulatorPair:", e)
			}
			setLoading(false)
			return
		}

		// If paired but stopped, start
		if (status.state === "stopped") {
			setLoading(true)
			try {
				const s = await rpcRequest<EmulatorStatus>("emulatorInit", undefined, 15000)
				setStatus(s)
			} catch (e: any) {
				console.error("emulatorInit:", e)
			}
			setLoading(false)
			return
		}

		// If running, stop
		if (status.state === "running") {
			setLoading(true)
			try {
				const s = await rpcRequest<EmulatorStatus>("emulatorStop", undefined, 10000)
				setStatus(s)
			} catch (e: any) {
				console.error("emulatorStop:", e)
			}
			setLoading(false)
			return
		}
	}

	const isRunning = status.state === "running"
	const isPaired = status.paired
	const isError = status.state === "error"

	const label = loading
		? "..."
		: !isPaired ? "Pair Emulator"
		: isRunning ? "Stop Emulator"
		: isError ? "Retry"
		: "Start Emulator"

	const dotColor = isRunning ? "#22C55E" : isError ? "#EF4444" : isPaired ? "#C0A860" : "gray"

	return (
		<Box
			position="fixed"
			bottom="24px"
			right="24px"
			zIndex={20}
		>
			{/* Expanded panel */}
			{expanded && (
				<Box
					bg="rgba(0,0,0,0.85)"
					border="1px solid"
					borderColor="rgba(192,168,96,0.3)"
					borderRadius="lg"
					p="3"
					mb="2"
					minW="200px"
					backdropFilter="blur(12px)"
				>
					<Text fontSize="xs" color="kk.gold" fontWeight="600" mb="2">Emulator</Text>

					<Flex justify="space-between" align="center" mb="1">
						<Text fontSize="xs" color="gray.400">Status</Text>
						<Flex align="center" gap="1.5">
							<Box w="6px" h="6px" borderRadius="full" bg={dotColor} />
							<Text fontSize="xs" color="gray.300">
								{isRunning ? "Running" : isError ? "Error" : isPaired ? "Paired" : "Not paired"}
							</Text>
						</Flex>
					</Flex>

					{status.error && (
						<Text fontSize="xs" color="red.400" mt="1" mb="1">{status.error}</Text>
					)}

					{isPaired && status.flashImages.length > 0 && (
						<Flex justify="space-between" align="center" mb="1">
							<Text fontSize="xs" color="gray.400">Flash</Text>
							<Text fontSize="xs" color="gray.300" fontFamily="mono">{status.flashImages.join(", ")}</Text>
						</Flex>
					)}

					<Box
						as="button"
						mt="2"
						w="100%"
						py="1.5"
						borderRadius="md"
						fontSize="xs"
						fontWeight="600"
						textAlign="center"
						cursor={loading ? "wait" : "pointer"}
						bg={isRunning ? "rgba(239,68,68,0.15)" : "rgba(192,168,96,0.15)"}
						color={isRunning ? "#EF4444" : "#C0A860"}
						border="1px solid"
						borderColor={isRunning ? "rgba(239,68,68,0.3)" : "rgba(192,168,96,0.3)"}
						_hover={{ bg: isRunning ? "rgba(239,68,68,0.25)" : "rgba(192,168,96,0.25)" }}
						onClick={handleClick}
					>
						{label}
					</Box>

					<Text fontSize="9px" color="gray.600" mt="2" textAlign="center">
						Testing only — do not use real funds
					</Text>
				</Box>
			)}

			{/* Toggle button — chip icon */}
			<Box
				as="button"
				w="40px"
				h="40px"
				borderRadius="full"
				bg={isRunning ? "rgba(34,197,94,0.15)" : "rgba(255,255,255,0.04)"}
				border="1px solid"
				borderColor={isRunning ? "rgba(34,197,94,0.3)" : "rgba(255,255,255,0.08)"}
				display="flex"
				alignItems="center"
				justifyContent="center"
				cursor="pointer"
				transition="all 0.2s"
				opacity={isRunning ? 1 : 0.5}
				_hover={{
					opacity: 1,
					bg: "rgba(192,168,96,0.15)",
					borderColor: "rgba(192,168,96,0.3)",
					transform: "scale(1.08)",
				}}
				_active={{ transform: "scale(0.95)" }}
				onClick={() => setExpanded(e => !e)}
				title="KeepKey Emulator"
			>
				{/* Chip/CPU icon */}
				<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke={isRunning ? "#22C55E" : "#C0A860"} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
					<rect x="4" y="4" width="16" height="16" rx="2" />
					<rect x="9" y="9" width="6" height="6" />
					<line x1="9" y1="1" x2="9" y2="4" />
					<line x1="15" y1="1" x2="15" y2="4" />
					<line x1="9" y1="20" x2="9" y2="23" />
					<line x1="15" y1="20" x2="15" y2="23" />
					<line x1="20" y1="9" x2="23" y2="9" />
					<line x1="20" y1="15" x2="23" y2="15" />
					<line x1="1" y1="9" x2="4" y2="9" />
					<line x1="1" y1="15" x2="4" y2="15" />
				</svg>
			</Box>
		</Box>
	)
}
