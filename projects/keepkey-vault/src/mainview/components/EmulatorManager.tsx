/**
 * EmulatorManager — multi-wallet emulator panel for the splash screen.
 * macOS only. Shows a list of emulator wallets (flash images tied to seeds),
 * allows starting/stopping/switching, creating new wallets, and importing seeds.
 */
import { useState, useEffect, useCallback } from "react"
import { Box, Flex, Text } from "@chakra-ui/react"
import { rpcRequest, onRpcMessage } from "../lib/rpc"
import type { EmulatorStatus, EmulatorWalletInfo } from "../../shared/types"

type EmulatorChannel = 'alpha' | 'beta' | 'release'

interface ChannelEntry {
	channel: string
	version: string
	description: string
	installed: boolean
	source: { repo: string; ref: string; type: string }
}

export function EmulatorManager() {
	const [wallets, setWallets] = useState<EmulatorWalletInfo[]>([])
	const [status, setStatus] = useState<(EmulatorStatus & { channel?: EmulatorChannel }) | null>(null)
	const [channels, setChannels] = useState<ChannelEntry[]>([])
	const [selectedChannel, setSelectedChannel] = useState<EmulatorChannel>('alpha')
	const [loading, setLoading] = useState<string | null>(null)
	const [expanded, setExpanded] = useState(false)
	const [showAdd, setShowAdd] = useState(false)
	const [newName, setNewName] = useState("")
	const [newMnemonic, setNewMnemonic] = useState("")
	const [newLabel, setNewLabel] = useState("")
	const [error, setError] = useState<string | null>(null)

	const refresh = useCallback(async () => {
		try {
			const [s, w, ch] = await Promise.all([
				rpcRequest<EmulatorStatus & { channel?: EmulatorChannel }>("emulatorStatus", undefined, 5000),
				rpcRequest<EmulatorWalletInfo[]>("emulatorListWallets", undefined, 5000),
				rpcRequest<ChannelEntry[]>("emulatorGetChannels", undefined, 5000),
			])
			setStatus(s)
			setWallets(w)
			setChannels(ch)
			if (s.channel) setSelectedChannel(s.channel)
			setError(null)
		} catch (e: any) {
			setError(e?.message || String(e))
		}
	}, [])

	useEffect(() => {
		refresh()
		const unsub = onRpcMessage("emulator-status", (s) => {
			setStatus(s as EmulatorStatus)
			// Refresh wallet list when emulator status changes
			rpcRequest<EmulatorWalletInfo[]>("emulatorListWallets", undefined, 5000)
				.then(setWallets)
				.catch(() => {})
		})
		return unsub
	}, [refresh])

	const handleStart = useCallback(async (name: string) => {
		setLoading(name)
		setError(null)
		try {
			// If another is running, switch; otherwise init — always pass selected channel
			if (status?.state === 'running') {
				const s = await rpcRequest<EmulatorStatus>("emulatorSwitchWallet", { name, channel: selectedChannel }, 20000)
				setStatus(s)
			} else {
				const s = await rpcRequest<EmulatorStatus>("emulatorInit", { flashName: name, channel: selectedChannel }, 20000)
				setStatus(s)
			}
			await refresh()
		} catch (e: any) {
			setError(e?.message || String(e))
		}
		setLoading(null)
	}, [refresh, status?.state, selectedChannel])

	const handleStop = useCallback(async () => {
		setLoading("__stop")
		setError(null)
		try {
			const s = await rpcRequest<EmulatorStatus>("emulatorStop", undefined, 10000)
			setStatus(s)
			await refresh()
		} catch (e: any) {
			setError(e?.message || String(e))
		}
		setLoading(null)
	}, [refresh])

	const handleDelete = useCallback(async (name: string) => {
		setLoading(name)
		setError(null)
		try {
			await rpcRequest("emulatorDeleteFlash", { name }, 5000)
			await refresh()
		} catch (e: any) {
			setError(e?.message || String(e))
		}
		setLoading(null)
	}, [refresh])

	const handleImport = useCallback(async () => {
		const name = newName.trim()
		if (!name) return
		const mnemonic = newMnemonic.trim()
		if (!mnemonic) return
		setLoading("__import")
		setError(null)
		try {
			const s = await rpcRequest<EmulatorStatus>("emulatorImportWallet", {
				name,
				mnemonic,
				label: newLabel.trim() || undefined,
				channel: selectedChannel,
			}, 30000)
			setStatus(s)
			setShowAdd(false)
			setNewName("")
			setNewMnemonic("")
			setNewLabel("")
			await refresh()
		} catch (e: any) {
			setError(e?.message || String(e))
		}
		setLoading(null)
	}, [newName, newMnemonic, newLabel, selectedChannel, refresh])

	const handlePair = useCallback(async () => {
		setLoading("__pair")
		try {
			const s = await rpcRequest<EmulatorStatus>("emulatorPair", undefined, 10000)
			setStatus(s)
			await refresh()
		} catch (e: any) {
			setError(e?.message || String(e))
		}
		setLoading(null)
	}, [refresh])

	const isRunning = status?.state === "running"
	const isPaired = status?.paired ?? false

	// ── Collapsed toggle button ────────────────────────────────────
	if (!expanded) {
		return (
			<Box position="fixed" bottom="24px" right="24px" zIndex={9999}>
				<Box
					as="button"
					display="flex"
					alignItems="center"
					gap="2"
					px="4"
					py="2"
					borderRadius="full"
					bg={isRunning ? "rgba(34,197,94,0.15)" : "rgba(192,168,96,0.15)"}
					border="1px solid"
					borderColor={isRunning ? "rgba(34,197,94,0.5)" : "rgba(192,168,96,0.4)"}
					cursor="pointer"
					transition="all 0.2s"
					_hover={{
						transform: "scale(1.05)",
						boxShadow: "0 0 16px rgba(192,168,96,0.3)",
					}}
					onClick={() => setExpanded(true)}
				>
					<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke={isRunning ? "#22C55E" : "#C0A860"} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
						<rect x="4" y="4" width="16" height="16" rx="2" />
						<rect x="9" y="9" width="6" height="6" />
						<line x1="9" y1="1" x2="9" y2="4" /><line x1="15" y1="1" x2="15" y2="4" />
						<line x1="9" y1="20" x2="9" y2="23" /><line x1="15" y1="20" x2="15" y2="23" />
						<line x1="20" y1="9" x2="23" y2="9" /><line x1="20" y1="15" x2="23" y2="15" />
						<line x1="1" y1="9" x2="4" y2="9" /><line x1="1" y1="15" x2="4" y2="15" />
					</svg>
					<Text fontSize="xs" fontWeight="600" color={isRunning ? "#22C55E" : "#C0A860"}>
						Emulators{isRunning ? ` (1)` : ""}
					</Text>
				</Box>
			</Box>
		)
	}

	// ── Expanded panel ──��──────────────────────────────────────────
	return (
		<Box
			position="fixed"
			bottom="24px"
			right="24px"
			zIndex={9999}
			w="340px"
			maxH="70vh"
			overflowY="auto"
			bg="rgba(0,0,0,0.94)"
			border="1px solid rgba(192,168,96,0.35)"
			borderRadius="xl"
			boxShadow="0 8px 32px rgba(0,0,0,0.6)"
		>
			{/* Header */}
			<Flex
				px="4" py="3"
				justify="space-between"
				align="center"
				borderBottom="1px solid rgba(255,255,255,0.06)"
			>
				<Flex align="center" gap="2">
					<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#C0A860" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
						<rect x="4" y="4" width="16" height="16" rx="2" /><rect x="9" y="9" width="6" height="6" />
					</svg>
					<Text fontSize="sm" fontWeight="700" color="#C0A860">Emulators</Text>
				</Flex>
				<Flex gap="2">
					{isPaired && (
						<Box
							as="button"
							fontSize="10px"
							fontWeight="600"
							color="#C0A860"
							bg="rgba(192,168,96,0.12)"
							border="1px solid rgba(192,168,96,0.3)"
							borderRadius="md"
							px="2" py="1"
							cursor="pointer"
							_hover={{ bg: "rgba(192,168,96,0.25)" }}
							onClick={() => { setShowAdd(true); setError(null) }}
						>
							+ Add
						</Box>
					)}
					<Box
						as="button"
						fontSize="10px"
						color="gray.400"
						cursor="pointer"
						px="1"
						_hover={{ color: "gray.200" }}
						onClick={() => setExpanded(false)}
					>
						&times;
					</Box>
				</Flex>
			</Flex>

			{/* Error bar */}
			{error && (
				<Box px="4" py="2" bg="rgba(239,68,68,0.1)">
					<Text fontSize="10px" color="#EF4444" wordBreak="break-all">{error}</Text>
				</Box>
			)}

			{/* Not paired state */}
			{!isPaired && status && (
				<Box px="4" py="4" textAlign="center">
					<Text fontSize="xs" color="gray.400" mb="3">Pair with macOS Keychain to use emulators</Text>
					<Box
						as="button"
						px="4" py="2"
						borderRadius="md"
						fontSize="xs"
						fontWeight="600"
						bg="rgba(192,168,96,0.2)"
						color="#C0A860"
						border="1px solid rgba(192,168,96,0.4)"
						cursor={loading ? "wait" : "pointer"}
						_hover={{ bg: "rgba(192,168,96,0.35)" }}
						onClick={handlePair}
					>
						{loading === "__pair" ? "Pairing..." : "Pair Emulator"}
					</Box>
				</Box>
			)}

			{/* Channel selector */}
			{isPaired && channels.length > 0 && (
				<Box px="4" py="3" borderBottom="1px solid rgba(255,255,255,0.06)">
					<Text fontSize="10px" fontWeight="600" color="gray.400" mb="2">FIRMWARE CHANNEL</Text>
					<Flex gap="2">
						{channels.map(ch => {
							const active = selectedChannel === ch.channel
							const isActive = isRunning && status?.channel === ch.channel
							const channelColors: Record<string, string> = {
								alpha: '#F59E0B',
								beta: '#3B82F6',
								release: '#22C55E',
							}
							const color = channelColors[ch.channel] || '#C0A860'
							return (
								<Box
									key={ch.channel}
									as="button"
									flex="1"
									py="6px"
									px="2"
									borderRadius="md"
									fontSize="10px"
									fontWeight="600"
									textAlign="center"
									cursor={isRunning ? "not-allowed" : "pointer"}
									opacity={!ch.installed ? 0.4 : 1}
									bg={active ? `rgba(${color === '#F59E0B' ? '245,158,11' : color === '#3B82F6' ? '59,130,246' : '34,197,94'},0.15)` : 'rgba(255,255,255,0.03)'}
									color={active ? color : 'gray.400'}
									border="1px solid"
									borderColor={active ? `rgba(${color === '#F59E0B' ? '245,158,11' : color === '#3B82F6' ? '59,130,246' : '34,197,94'},0.5)` : 'rgba(255,255,255,0.08)'}
									_hover={!isRunning ? { bg: `rgba(${color === '#F59E0B' ? '245,158,11' : color === '#3B82F6' ? '59,130,246' : '34,197,94'},0.1)` } : undefined}
									onClick={() => {
										if (!isRunning && ch.installed) setSelectedChannel(ch.channel as EmulatorChannel)
									}}
									title={ch.description + (ch.installed ? '' : '\n(Not installed)')}
								>
									{ch.channel.toUpperCase()}
									{isActive && <Text as="span" fontSize="8px" ml="1">(active)</Text>}
									{!ch.installed && <Text as="span" fontSize="8px" ml="1" color="red.300">!</Text>}
								</Box>
							)
						})}
					</Flex>
					{channels.find(c => c.channel === selectedChannel) && (
						<Text fontSize="9px" color="gray.500" mt="1">
							{channels.find(c => c.channel === selectedChannel)?.description}
						</Text>
					)}
				</Box>
			)}

			{/* Wallet list */}
			{isPaired && wallets.length === 0 && !showAdd && (
				<Box px="4" py="4" textAlign="center">
					<Text fontSize="xs" color="gray.500" mb="2">No emulator wallets yet</Text>
					<Text fontSize="10px" color="gray.600">Click "+ Add" to create one with a seed phrase</Text>
				</Box>
			)}

			{isPaired && wallets.map((w) => {
				const active = w.isActive && isRunning
				const isLoading = loading === w.name
				return (
					<Flex
						key={w.name}
						px="4" py="3"
						align="center"
						gap="3"
						borderBottom="1px solid rgba(255,255,255,0.04)"
						bg={active ? "rgba(34,197,94,0.06)" : "transparent"}
						_hover={{ bg: active ? "rgba(34,197,94,0.1)" : "rgba(255,255,255,0.03)" }}
						transition="background 0.15s"
					>
						{/* Status dot */}
						<Box
							w="8px" h="8px"
							borderRadius="full"
							bg={active ? "#22C55E" : "gray.600"}
							flexShrink={0}
							style={active ? { animation: "pulse 2s infinite" } : undefined}
						/>

						{/* Name + meta */}
						<Box flex="1" minW="0">
							<Text fontSize="xs" fontWeight="600" color={active ? "#22C55E" : "gray.200"} truncate>
								{w.name}
							</Text>
							<Flex gap="2" mt="0.5">
								{w.hasMnemonic && (
									<Text fontSize="9px" color="gray.500">seed saved</Text>
								)}
								{active && (
									<Text fontSize="9px" color="#22C55E">running</Text>
								)}
							</Flex>
						</Box>

						{/* Actions */}
						<Flex gap="1.5" flexShrink={0}>
							{active ? (
								<ActionBtn
									label="Stop"
									color="#EF4444"
									loading={isLoading || loading === "__stop"}
									onClick={handleStop}
								/>
							) : (
								<ActionBtn
									label="Start"
									color="#C0A860"
									loading={isLoading}
									onClick={() => handleStart(w.name)}
								/>
							)}
							{!active && (
								<ActionBtn
									label="&times;"
									color="#666"
									loading={isLoading}
									onClick={() => handleDelete(w.name)}
									small
								/>
							)}
						</Flex>
					</Flex>
				)
			})}

			{/* Add wallet form */}
			{showAdd && (
				<Box px="4" py="3" borderTop="1px solid rgba(192,168,96,0.2)">
					<Text fontSize="xs" fontWeight="600" color="#C0A860" mb="2">Import Wallet</Text>

					<Box
						as="input"
						w="100%"
						px="3" py="1.5"
						mb="2"
						fontSize="xs"
						bg="rgba(255,255,255,0.05)"
						border="1px solid rgba(255,255,255,0.1)"
						borderRadius="md"
						color="gray.200"
						placeholder="Wallet name (e.g. test-wallet-1)"
						_placeholder={{ color: "gray.600" }}
						_focus={{ borderColor: "rgba(192,168,96,0.5)", outline: "none" }}
						value={newName}
						onChange={(e: React.ChangeEvent<HTMLInputElement>) => setNewName(e.target.value)}
					/>

					<Box
						as="textarea"
						w="100%"
						px="3" py="1.5"
						mb="2"
						fontSize="xs"
						bg="rgba(255,255,255,0.05)"
						border="1px solid rgba(255,255,255,0.1)"
						borderRadius="md"
						color="gray.200"
						placeholder="Seed phrase (12 or 24 words)"
						_placeholder={{ color: "gray.600" }}
						_focus={{ borderColor: "rgba(192,168,96,0.5)", outline: "none" }}
						rows={3}
						resize="none"
						value={newMnemonic}
						onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => setNewMnemonic(e.target.value)}
					/>

					<Box
						as="input"
						w="100%"
						px="3" py="1.5"
						mb="3"
						fontSize="xs"
						bg="rgba(255,255,255,0.05)"
						border="1px solid rgba(255,255,255,0.1)"
						borderRadius="md"
						color="gray.200"
						placeholder="Label (optional, defaults to name)"
						_placeholder={{ color: "gray.600" }}
						_focus={{ borderColor: "rgba(192,168,96,0.5)", outline: "none" }}
						value={newLabel}
						onChange={(e: React.ChangeEvent<HTMLInputElement>) => setNewLabel(e.target.value)}
					/>

					<Flex gap="2">
						<Box
							as="button"
							flex="1"
							py="6px"
							borderRadius="md"
							fontSize="xs"
							fontWeight="600"
							textAlign="center"
							cursor={loading === "__import" ? "wait" : "pointer"}
							bg="rgba(192,168,96,0.2)"
							color="#C0A860"
							border="1px solid rgba(192,168,96,0.4)"
							_hover={{ bg: "rgba(192,168,96,0.35)" }}
							onClick={handleImport}
						>
							{loading === "__import" ? "Importing..." : "Import & Start"}
						</Box>
						<Box
							as="button"
							py="6px"
							px="3"
							borderRadius="md"
							fontSize="xs"
							color="gray.400"
							cursor="pointer"
							_hover={{ color: "gray.200" }}
							onClick={() => { setShowAdd(false); setNewName(""); setNewMnemonic(""); setNewLabel("") }}
						>
							Cancel
						</Box>
					</Flex>
				</Box>
			)}

			{/* Footer */}
			<Box px="4" py="2" borderTop="1px solid rgba(255,255,255,0.04)">
				<Text fontSize="9px" color="gray.600" textAlign="center">
					Emulator wallets are encrypted in macOS Keychain
				</Text>
			</Box>

			<style>{`
				@keyframes pulse {
					0%, 100% { opacity: 1; }
					50% { opacity: 0.4; }
				}
			`}</style>
		</Box>
	)
}

/** Small action button used in wallet rows */
function ActionBtn({ label, color, loading, onClick, small }: {
	label: string
	color: string
	loading: boolean
	onClick: () => void
	small?: boolean
}) {
	return (
		<Box
			as="button"
			px={small ? "4px" : "8px"}
			py="3px"
			borderRadius="md"
			fontSize={small ? "11px" : "10px"}
			fontWeight="600"
			color={color}
			bg={`rgba(${color === "#EF4444" ? "239,68,68" : color === "#C0A860" ? "192,168,96" : "102,102,102"},0.12)`}
			border="1px solid"
			borderColor={`rgba(${color === "#EF4444" ? "239,68,68" : color === "#C0A860" ? "192,168,96" : "102,102,102"},0.3)`}
			cursor={loading ? "wait" : "pointer"}
			opacity={loading ? 0.5 : 1}
			_hover={{ bg: `rgba(${color === "#EF4444" ? "239,68,68" : color === "#C0A860" ? "192,168,96" : "102,102,102"},0.25)` }}
			onClick={onClick}
			dangerouslySetInnerHTML={{ __html: label }}
		/>
	)
}
