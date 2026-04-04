/**
 * DeviceGrid — unified grid of all registered devices + emulator wallets.
 * Shown on the splash screen (center-center) when disconnected.
 * Each card: label, type badge, last seen, View Portfolio / Start / Forget.
 */
import { useState, useEffect, useCallback } from "react"
import { Box, Flex, Text } from "@chakra-ui/react"
import { rpcRequest, onRpcMessage } from "../lib/rpc"
import type { RegisteredDevice, EmulatorStatus, EmulatorWalletInfo } from "../../shared/types"

interface DeviceGridProps {
	onViewPortfolio: (deviceId: string, label: string) => void
}

const REVEAL_DELAY_MS = 2500 // wait before showing grid so USB scan can find a device first

export function DeviceGrid({ onViewPortfolio }: DeviceGridProps) {
	const [devices, setDevices] = useState<RegisteredDevice[]>([])
	const [emuWallets, setEmuWallets] = useState<EmulatorWalletInfo[]>([])
	const [emuStatus, setEmuStatus] = useState<EmulatorStatus | null>(null)
	const [emuPaired, setEmuPaired] = useState(false)
	const [loading, setLoading] = useState<string | null>(null)
	const [showAdd, setShowAdd] = useState(false)
	const [newName, setNewName] = useState("")
	const [newMnemonic, setNewMnemonic] = useState("")
	const [newLabel, setNewLabel] = useState("")
	const [confirmForget, setConfirmForget] = useState<string | null>(null)
	const [confirmDeleteEmu, setConfirmDeleteEmu] = useState<string | null>(null)
	const [error, setError] = useState<string | null>(null)
	const [revealed, setRevealed] = useState(false)

	// Delay reveal so the splash "Searching for KeepKey..." has time to find a device
	useEffect(() => {
		const timer = setTimeout(() => setRevealed(true), REVEAL_DELAY_MS)
		return () => clearTimeout(timer)
	}, [])

	const refresh = useCallback(async () => {
		try {
			const [devs, status, wallets] = await Promise.all([
				rpcRequest<RegisteredDevice[]>("getRegisteredDevices", undefined, 5000),
				rpcRequest<EmulatorStatus>("emulatorStatus", undefined, 5000).catch(() => null),
				rpcRequest<EmulatorWalletInfo[]>("emulatorListWallets", undefined, 5000).catch(() => [] as EmulatorWalletInfo[]),
			])
			setDevices(devs)
			if (status) { setEmuStatus(status); setEmuPaired(status.paired) }
			setEmuWallets(wallets)
			setError(null)
		} catch (e: any) {
			setError(e?.message || String(e))
		}
	}, [])

	useEffect(() => {
		refresh()
		const unsub = onRpcMessage("emulator-status", (s) => {
			setEmuStatus(s as EmulatorStatus)
			rpcRequest<EmulatorWalletInfo[]>("emulatorListWallets", undefined, 5000)
				.then(setEmuWallets).catch(() => {})
		})
		return unsub
	}, [refresh])

	// ── Handlers ────────────────────────────────────────────────────

	const handleForgetDevice = useCallback(async (deviceId: string) => {
		setLoading(deviceId)
		try {
			await rpcRequest("forgetDevice", { deviceId }, 5000)
			await refresh()
		} catch (e: any) { setError(e?.message || String(e)) }
		setLoading(null)
		setConfirmForget(null)
	}, [refresh])

	const handleStartEmu = useCallback(async (name: string) => {
		setLoading(`emu:${name}`)
		setError(null)
		try {
			await rpcRequest<EmulatorStatus>("emulatorSwitchWallet", { name }, 20000)
			await refresh()
		} catch (e: any) { setError(e?.message || String(e)) }
		setLoading(null)
	}, [refresh])

	const handleStopEmu = useCallback(async () => {
		setLoading("emu:__stop")
		try {
			await rpcRequest<EmulatorStatus>("emulatorStop", undefined, 10000)
			await refresh()
		} catch (e: any) { setError(e?.message || String(e)) }
		setLoading(null)
	}, [refresh])

	const handleDeleteEmu = useCallback(async (name: string) => {
		setLoading(`emu:${name}`)
		try {
			await rpcRequest("emulatorDeleteFlash", { name }, 5000)
			await refresh()
		} catch (e: any) { setError(e?.message || String(e)) }
		setLoading(null)
		setConfirmDeleteEmu(null)
	}, [refresh])

	const handlePairEmu = useCallback(async () => {
		setLoading("emu:__pair")
		try {
			const s = await rpcRequest<EmulatorStatus>("emulatorPair", undefined, 10000)
			setEmuStatus(s)
			setEmuPaired(s.paired)
			await refresh()
		} catch (e: any) { setError(e?.message || String(e)) }
		setLoading(null)
	}, [refresh])

	const handleImportEmu = useCallback(async () => {
		const name = newName.trim()
		const mnemonic = newMnemonic.trim()
		if (!name || !mnemonic) return
		if (name.length > 64 || /[\/\\]/.test(name) || name.includes('..') || name.includes('.mnemonic.')) {
			setError('Invalid name: avoid path characters (/ \\ ..), max 64 chars'); return
		}
		setLoading("emu:__import")
		setError(null)
		try {
			await rpcRequest<EmulatorStatus>("emulatorImportWallet", {
				name, mnemonic, label: newLabel.trim() || undefined,
			}, 30000)
			setShowAdd(false)
			setNewName(""); setNewMnemonic(""); setNewLabel("")
			await refresh()
		} catch (e: any) { setError(e?.message || String(e)) }
		setLoading(null)
	}, [newName, newMnemonic, newLabel, refresh])

	// ── Helpers ──────────────────────────────────────────────────────

	function timeAgo(ts: number): string {
		const diff = Date.now() - ts
		const mins = Math.floor(diff / 60_000)
		if (mins < 1) return "just now"
		if (mins < 60) return `${mins}m ago`
		const hrs = Math.floor(mins / 60)
		if (hrs < 24) return `${hrs}h ago`
		const days = Math.floor(hrs / 24)
		return `${days}d ago`
	}

	const emuRunning = emuStatus?.state === "running"
	// Show grid if there are devices, emulator wallets, OR if the emulator
	// system responded at all (so "Pair Emulator" card is reachable on clean install)
	const hasContent = devices.length > 0 || emuWallets.length > 0 || emuPaired || emuStatus !== null

	// Wait for reveal delay + content before rendering
	if (!revealed || !hasContent) return null

	// ── Render ───────────────────────────────────────────────────────
	return (
		<Box
			w="100%"
			maxW="640px"
			opacity={1}
			style={{ animation: 'fadeIn 0.4s ease' }}
		>
			{/* Error banner */}
			{error && (
				<Box mb="3" px="3" py="2" bg="rgba(239,68,68,0.12)" borderRadius="lg">
					<Text fontSize="10px" color="#EF4444" wordBreak="break-all">{error}</Text>
				</Box>
			)}

			{/* Grid of cards */}
			<Flex wrap="wrap" gap="3" justify="center">

				{/* ── Physical device cards ─────────────────────────── */}
				{devices.map((d) => (
					<DeviceCard key={d.deviceId}>
						<Flex align="center" gap="2" mb="1.5">
							<HardwareIcon />
							<Box flex="1" minW="0">
								<Text fontSize="xs" fontWeight="600" color="gray.200" truncate>
									{d.label || "KeepKey"}
								</Text>
								<Text fontSize="9px" color="gray.500">
									fw {d.firmwareVer} &middot; {timeAgo(d.updatedAt)}
								</Text>
							</Box>
						</Flex>
						<Flex gap="1.5">
							<CardBtn label="View" color="#C0A860" onClick={() => onViewPortfolio(d.deviceId, d.label || 'KeepKey')} />
							{confirmForget === d.deviceId ? (
								<>
									<CardBtn label="Yes" color="#EF4444" onClick={() => handleForgetDevice(d.deviceId)} loading={loading === d.deviceId} />
									<CardBtn label="No" color="#666" onClick={() => setConfirmForget(null)} />
								</>
							) : (
								<CardBtn label="Forget" color="#666" onClick={() => setConfirmForget(d.deviceId)} />
							)}
						</Flex>
					</DeviceCard>
				))}

				{/* ── Emulator wallet cards ─────────────────────────── */}
				{emuWallets.map((w) => {
					const active = w.isActive && emuRunning
					const isDeleting = confirmDeleteEmu === w.name
					return (
						<DeviceCard key={`emu:${w.name}`} active={active}>
							<Flex align="center" gap="2" mb="1.5">
								<EmulatorIcon active={active} />
								<Box flex="1" minW="0">
									<Text fontSize="xs" fontWeight="600" color={active ? "#22C55E" : "gray.200"} truncate>
										{w.name}
									</Text>
									<Flex gap="1.5" mt="0.5">
										<Text fontSize="9px" color={active ? "#22C55E" : "gray.500"}>
											{active ? "running" : "emulator"}
										</Text>
										{w.hasMnemonic && <Text fontSize="9px" color="gray.600">seed saved</Text>}
									</Flex>
								</Box>
							</Flex>
							{isDeleting ? (
								<Box mb="1.5">
									<Text fontSize="10px" color="#EF4444" mb="1.5" lineHeight="1.4">
										This will delete the encrypted flash from disk. You will need the recovery phrase to re-load this wallet.
									</Text>
									<Flex gap="1.5">
										<CardBtn label="Delete" color="#EF4444" onClick={() => handleDeleteEmu(w.name)} loading={loading === `emu:${w.name}`} />
										<CardBtn label="Cancel" color="#666" onClick={() => setConfirmDeleteEmu(null)} />
									</Flex>
								</Box>
							) : (
								<Flex gap="1.5">
									{active ? (
										<CardBtn label="Stop" color="#EF4444" onClick={handleStopEmu} loading={loading === "emu:__stop"} />
									) : (
										<CardBtn label="Start" color="#C0A860" onClick={() => handleStartEmu(w.name)} loading={loading === `emu:${w.name}`} />
									)}
									{!active && (
										<CardBtn label="Delete" color="#666" onClick={() => setConfirmDeleteEmu(w.name)} />
									)}
								</Flex>
							)}
						</DeviceCard>
					)
				})}

				{/* ── Add Emulator card ─────────────────────────────── */}
				{emuPaired && !showAdd && (
					<Box
						as="button"
						w="180px"
						minH="100px"
						bg="rgba(255,255,255,0.02)"
						border="1px dashed rgba(192,168,96,0.3)"
						borderRadius="xl"
						display="flex"
						flexDirection="column"
						alignItems="center"
						justifyContent="center"
						gap="1"
						cursor="pointer"
						transition="all 0.2s"
						_hover={{ bg: "rgba(192,168,96,0.06)", borderColor: "rgba(192,168,96,0.5)" }}
						onClick={() => setShowAdd(true)}
					>
						<Text fontSize="lg" color="rgba(192,168,96,0.6)">+</Text>
						<Text fontSize="10px" color="gray.500">Add Emulator</Text>
					</Box>
				)}

				{/* ── Pair Emulator card (if not paired) ──────────── */}
				{!emuPaired && emuStatus && (
					<Box
						as="button"
						w="180px"
						minH="100px"
						bg="rgba(255,255,255,0.02)"
						border="1px dashed rgba(192,168,96,0.3)"
						borderRadius="xl"
						display="flex"
						flexDirection="column"
						alignItems="center"
						justifyContent="center"
						gap="1"
						cursor={loading === "emu:__pair" ? "wait" : "pointer"}
						transition="all 0.2s"
						_hover={{ bg: "rgba(192,168,96,0.06)", borderColor: "rgba(192,168,96,0.5)" }}
						onClick={handlePairEmu}
					>
						<EmulatorIcon active={false} />
						<Text fontSize="10px" color="gray.500" mt="1">
							{loading === "emu:__pair" ? "Pairing..." : "Pair Emulator"}
						</Text>
					</Box>
				)}
			</Flex>

			{/* ── Import form (inline below grid) ────────────────────── */}
			{showAdd && (
				<Box
					mt="3"
					mx="auto"
					maxW="340px"
					bg="rgba(0,0,0,0.85)"
					border="1px solid rgba(192,168,96,0.3)"
					borderRadius="xl"
					px="4" py="3"
				>
					<Text fontSize="xs" fontWeight="600" color="#C0A860" mb="2">Import Emulator Wallet</Text>
					<InputField placeholder="Wallet name" value={newName} onChange={setNewName} />
					<Box
						as="textarea"
						w="100%" px="3" py="1.5" mb="2" fontSize="xs"
						bg="rgba(255,255,255,0.05)" border="1px solid rgba(255,255,255,0.1)"
						borderRadius="md" color="gray.200" rows={3} resize="none"
						placeholder="Seed phrase (12 or 24 words)"
						_placeholder={{ color: "gray.600" }}
						_focus={{ borderColor: "rgba(192,168,96,0.5)", outline: "none" }}
						value={newMnemonic}
						onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => setNewMnemonic(e.target.value)}
					/>
					<InputField placeholder="Label (optional)" value={newLabel} onChange={setNewLabel} />
					<Flex gap="2" mt="1">
						<CardBtn label={loading === "emu:__import" ? "Importing..." : "Import & Start"} color="#C0A860" onClick={handleImportEmu} loading={loading === "emu:__import"} />
						<CardBtn label="Cancel" color="#666" onClick={() => { setShowAdd(false); setNewName(""); setNewMnemonic(""); setNewLabel("") }} />
					</Flex>
				</Box>
			)}
			<style>{`
				@keyframes fadeIn {
					from { opacity: 0; transform: translateY(8px); }
					to { opacity: 1; transform: translateY(0); }
				}
			`}</style>
		</Box>
	)
}

// ── Reusable sub-components ─────────────────────────────────────────────

function DeviceCard({ children, active }: { children: React.ReactNode; active?: boolean }) {
	return (
		<Box
			w="180px"
			bg={active ? "rgba(34,197,94,0.05)" : "rgba(255,255,255,0.03)"}
			border="1px solid"
			borderColor={active ? "rgba(34,197,94,0.25)" : "rgba(255,255,255,0.08)"}
			borderRadius="xl"
			px="3" py="2.5"
			transition="all 0.2s"
			_hover={{ bg: active ? "rgba(34,197,94,0.08)" : "rgba(255,255,255,0.05)" }}
		>
			{children}
		</Box>
	)
}

function CardBtn({ label, color, onClick, loading, small }: {
	label: string; color: string; onClick: () => void; loading?: boolean; small?: boolean
}) {
	const rgb = color === "#EF4444" ? "239,68,68" : color === "#C0A860" ? "192,168,96" : "102,102,102"
	return (
		<Box
			as="button"
			px={small ? "4px" : "8px"} py="3px"
			borderRadius="md" fontSize="10px" fontWeight="600"
			color={color} bg={`rgba(${rgb},0.12)`}
			border="1px solid" borderColor={`rgba(${rgb},0.3)`}
			cursor={loading ? "wait" : "pointer"} opacity={loading ? 0.5 : 1}
			_hover={{ bg: `rgba(${rgb},0.25)` }}
			onClick={onClick}
		>
			{label}
		</Box>
	)
}

function InputField({ placeholder, value, onChange }: { placeholder: string; value: string; onChange: (v: string) => void }) {
	return (
		<Box
			as="input" w="100%" px="3" py="1.5" mb="2" fontSize="xs"
			bg="rgba(255,255,255,0.05)" border="1px solid rgba(255,255,255,0.1)"
			borderRadius="md" color="gray.200" placeholder={placeholder}
			_placeholder={{ color: "gray.600" }}
			_focus={{ borderColor: "rgba(192,168,96,0.5)", outline: "none" }}
			value={value}
			onChange={(e: React.ChangeEvent<HTMLInputElement>) => onChange(e.target.value)}
		/>
	)
}

function HardwareIcon() {
	return (
		<Box w="28px" h="28px" flexShrink={0} display="flex" alignItems="center" justifyContent="center"
			bg="rgba(192,168,96,0.1)" borderRadius="lg">
			<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#C0A860" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
				<rect x="2" y="6" width="20" height="12" rx="2" />
				<line x1="6" y1="10" x2="6" y2="14" />
				<line x1="18" y1="10" x2="18" y2="14" />
			</svg>
		</Box>
	)
}

function EmulatorIcon({ active }: { active: boolean }) {
	const c = active ? "#22C55E" : "#C0A860"
	return (
		<Box w="28px" h="28px" flexShrink={0} display="flex" alignItems="center" justifyContent="center"
			bg={active ? "rgba(34,197,94,0.1)" : "rgba(192,168,96,0.1)"} borderRadius="lg">
			<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
				<rect x="4" y="4" width="16" height="16" rx="2" /><rect x="9" y="9" width="6" height="6" />
				<line x1="9" y1="1" x2="9" y2="4" /><line x1="15" y1="1" x2="15" y2="4" />
				<line x1="9" y1="20" x2="9" y2="23" /><line x1="15" y1="20" x2="15" y2="23" />
			</svg>
		</Box>
	)
}
