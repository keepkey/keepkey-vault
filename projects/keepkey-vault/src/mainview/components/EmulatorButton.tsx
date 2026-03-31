/**
 * Emulator button — bottom-right corner of splash screen.
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
	const [rpcError, setRpcError] = useState<string | null>(null)
	const [mounted, setMounted] = useState(false)

	useEffect(() => {
		setMounted(true)
		console.log("[EMU-BTN] ===== EmulatorButton MOUNTED =====")
		rpcRequest<EmulatorStatus>("emulatorStatus", undefined, 5000)
			.then((s) => {
				console.log("[EMU-BTN] emulatorStatus response:", JSON.stringify(s))
				setStatus(s)
			})
			.catch((e) => {
				console.error("[EMU-BTN] emulatorStatus FAILED:", e?.message || e)
				setRpcError(e?.message || String(e))
			})
	}, [])

	console.log("[EMU-BTN] render — mounted:", mounted, "status:", status ? "loaded" : "null", "rpcError:", rpcError)

	const handleClick = async () => {
		console.log("[EMU-BTN] handleClick — status:", status, "loading:", loading)
		if (loading) return
		if (!status) {
			setLoading(true)
			console.log("[EMU-BTN] No status, retrying RPC...")
			try {
				const s = await rpcRequest<EmulatorStatus>("emulatorStatus", undefined, 5000)
				console.log("[EMU-BTN] Retry OK:", JSON.stringify(s))
				setStatus(s)
				setRpcError(null)
			} catch (e: any) {
				console.error("[EMU-BTN] Retry FAILED:", e)
				setRpcError(e?.message || String(e))
			}
			setLoading(false)
			return
		}

		if (!status.paired) {
			setLoading(true)
			console.log("[EMU-BTN] Pairing...")
			try {
				const s = await rpcRequest<EmulatorStatus>("emulatorPair", undefined, 10000)
				console.log("[EMU-BTN] Paired:", JSON.stringify(s))
				setStatus(s)
			} catch (e: any) { console.error("[EMU-BTN] Pair FAILED:", e) }
			setLoading(false)
			return
		}

		if (status.state === "stopped" || status.state === "error") {
			setLoading(true)
			console.log("[EMU-BTN] Starting emulator...")
			try {
				const s = await rpcRequest<EmulatorStatus>("emulatorInit", undefined, 15000)
				console.log("[EMU-BTN] Started:", JSON.stringify(s))
				setStatus(s)
			} catch (e: any) { console.error("[EMU-BTN] Init FAILED:", e) }
			setLoading(false)
			return
		}

		if (status.state === "running") {
			setLoading(true)
			console.log("[EMU-BTN] Stopping emulator...")
			try {
				const s = await rpcRequest<EmulatorStatus>("emulatorStop", undefined, 10000)
				console.log("[EMU-BTN] Stopped:", JSON.stringify(s))
				setStatus(s)
			} catch (e: any) { console.error("[EMU-BTN] Stop FAILED:", e) }
			setLoading(false)
			return
		}
	}

	const isRunning = status?.state === "running"
	const isPaired = status?.paired ?? false
	const isError = status?.state === "error"

	const label = loading ? "..."
		: !status ? "Connect Emulator"
		: !isPaired ? "Pair Emulator"
		: isRunning ? "Stop Emulator"
		: isError ? "Retry"
		: "Start Emulator"

	const dotColor = isRunning ? "#22C55E" : isError ? "#EF4444" : isPaired ? "#C0A860" : "gray"

	return (
		<Box position="fixed" bottom="24px" right="24px" zIndex={9999}>
			{/* Expanded panel */}
			{expanded && (
				<Box
					bg="rgba(0,0,0,0.92)"
					border="1px solid rgba(192,168,96,0.4)"
					borderRadius="lg"
					p="3"
					mb="2"
					minW="220px"
				>
					<Text fontSize="xs" color="#C0A860" fontWeight="700" mb="2">Emulator (dev)</Text>

					<Flex justify="space-between" align="center" mb="1">
						<Text fontSize="xs" color="gray.400">Status</Text>
						<Flex align="center" gap="1.5">
							<Box w="6px" h="6px" borderRadius="full" bg={dotColor} />
							<Text fontSize="xs" color="gray.200">
								{!status ? "Loading..." : isRunning ? "Running" : isError ? "Error" : isPaired ? "Paired" : "Not paired"}
							</Text>
						</Flex>
					</Flex>

					{(status?.error || rpcError) && (
						<Text fontSize="10px" color="#EF4444" mt="1" mb="1" wordBreak="break-all">
							{status?.error || rpcError}
						</Text>
					)}

					{isPaired && (status?.flashImages?.length ?? 0) > 0 && (
						<Flex justify="space-between" align="center" mb="1">
							<Text fontSize="xs" color="gray.400">Flash</Text>
							<Text fontSize="xs" color="gray.300" fontFamily="mono">{status!.flashImages.join(", ")}</Text>
						</Flex>
					)}

					<Box
						as="button"
						mt="2"
						w="100%"
						py="6px"
						borderRadius="md"
						fontSize="xs"
						fontWeight="700"
						textAlign="center"
						cursor={loading ? "wait" : "pointer"}
						bg={isRunning ? "rgba(239,68,68,0.2)" : "rgba(192,168,96,0.2)"}
						color={isRunning ? "#EF4444" : "#C0A860"}
						border="1px solid"
						borderColor={isRunning ? "rgba(239,68,68,0.4)" : "rgba(192,168,96,0.4)"}
						_hover={{ bg: isRunning ? "rgba(239,68,68,0.35)" : "rgba(192,168,96,0.35)" }}
						onClick={handleClick}
					>
						{label}
					</Box>

					<Text fontSize="9px" color="gray.500" mt="2" textAlign="center">
						Testing only — not for real funds
					</Text>
				</Box>
			)}

			{/* Toggle button — always visible, bright for debugging */}
			<Box
				as="button"
				w="44px"
				h="44px"
				borderRadius="full"
				bg={isRunning ? "rgba(34,197,94,0.25)" : "rgba(192,168,96,0.2)"}
				border="2px solid"
				borderColor={isRunning ? "#22C55E" : "#C0A860"}
				display="flex"
				alignItems="center"
				justifyContent="center"
				cursor="pointer"
				transition="all 0.2s"
				_hover={{
					transform: "scale(1.1)",
					boxShadow: "0 0 16px rgba(192,168,96,0.4)",
				}}
				_active={{ transform: "scale(0.95)" }}
				onClick={() => setExpanded(e => !e)}
				title="KeepKey Emulator"
			>
				<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke={isRunning ? "#22C55E" : "#C0A860"} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
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
