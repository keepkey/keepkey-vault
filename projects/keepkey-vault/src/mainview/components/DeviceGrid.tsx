/**
 * DeviceGrid — unified grid of all registered devices + emulator wallets.
 * Shown on the splash screen (center-center) when disconnected.
 * Each card: label, type badge, last seen, View Portfolio / Start / Forget.
 */
import { useState, useEffect, useCallback } from "react"
import { Box, Flex, Text, Image } from "@chakra-ui/react"
import kkIcon from "../assets/icon.png"
import { rpcRequest, onRpcMessage } from "../lib/rpc"
import type { RegisteredDevice, EmulatorStatus, EmulatorWalletInfo } from "../../shared/types"

interface DeviceGridProps {
	onViewPortfolio: (deviceId: string, label: string) => void
	onReady?: () => void
	/** When false, no emulator UI is fetched or rendered (feature flag, default off). */
	emulatorEnabled?: boolean
}

const REVEAL_DELAY_MS = 2500
const CHANNEL_COLORS: Record<string, string> = { alpha: '#F59E0B', beta: '#3B82F6', release: '#22C55E' }

function ChannelPicker({ name, channels, onSelect, onCancel, loading }: {
	name: string
	channels: { channel: string; installed: boolean }[]
	onSelect: (name: string, channel: string) => void
	onCancel: () => void
	loading: boolean
}) {
	const installed = channels.filter(c => c.installed)
	return (
		<Box mt="auto">
			<Text fontSize="9px" color="gray.400" mb="1.5">Select firmware:</Text>
			<Flex gap="1.5" wrap="wrap">
				{installed.map(c => (
					<SolidBtn
						key={c.channel}
						label={c.channel}
						bg={CHANNEL_COLORS[c.channel] || '#C0A860'}
						onClick={() => onSelect(name, c.channel)}
						loading={loading}
					/>
				))}
				<SmallCircleBtn color="#666" label="&times;" onClick={onCancel} />
			</Flex>
			{installed.length === 0 && (
				<Text fontSize="9px" color="#EF4444" mt="1">No firmware installed</Text>
			)}
		</Box>
	)
}
let hasRevealedOnce = false // module-level: skip delay after first reveal (e.g. returning from X)

export function DeviceGrid({ onViewPortfolio, onReady, emulatorEnabled = false }: DeviceGridProps) {
	const [devices, setDevices] = useState<RegisteredDevice[]>([])
	const [emuWallets, setEmuWallets] = useState<EmulatorWalletInfo[]>([])
	const [emuStatus, setEmuStatus] = useState<EmulatorStatus | null>(null)
	const [emuPaired, setEmuPaired] = useState(false)
	const [loading, setLoading] = useState<string | null>(null)
	const [confirmForget, setConfirmForget] = useState<string | null>(null)
	const [confirmDeleteEmu, setConfirmDeleteEmu] = useState<string | null>(null)
	const [channelPicker, setChannelPicker] = useState<string | null>(null) // emu name showing channel picker
	const [emuChannels, setEmuChannels] = useState<{ channel: string; installed: boolean }[]>([])
	const [error, setError] = useState<string | null>(null)
	const [showValues, setShowValues] = useState(false)
	const [revealed, setRevealed] = useState(hasRevealedOnce)

	// Delay reveal only on first app launch so animated logo shows during USB scan.
	// On re-entry (pressing X from emu/watch-only), tiles show immediately.
	useEffect(() => {
		if (hasRevealedOnce) { setRevealed(true); return }
		const timer = setTimeout(() => { setRevealed(true); hasRevealedOnce = true }, REVEAL_DELAY_MS)
		return () => clearTimeout(timer)
	}, [])

	const refresh = useCallback(async () => {
		try {
			// Skip all emulator RPCs when the feature flag is off — keeps the
			// rendered grid clean of Pair/Add cards and empty wallet tiles.
			const [devs, status, wallets] = await Promise.all([
				rpcRequest<RegisteredDevice[]>("getRegisteredDevices", undefined, 5000),
				emulatorEnabled
					? rpcRequest<EmulatorStatus>("emulatorStatus", undefined, 5000).catch(() => null)
					: Promise.resolve(null),
				emulatorEnabled
					? rpcRequest<EmulatorWalletInfo[]>("emulatorListWallets", undefined, 5000).catch(() => [] as EmulatorWalletInfo[])
					: Promise.resolve([] as EmulatorWalletInfo[]),
			])
			setDevices(devs)
			if (status) { setEmuStatus(status); setEmuPaired(status.paired) }
			setEmuWallets(wallets)
			setError(null)
		} catch (e: any) {
			setError(e?.message || String(e))
		}
	}, [emulatorEnabled])

	useEffect(() => {
		refresh()
		if (!emulatorEnabled) return
		const unsub = onRpcMessage("emulator-status", (s) => {
			setEmuStatus(s as EmulatorStatus)
			rpcRequest<EmulatorWalletInfo[]>("emulatorListWallets", undefined, 5000)
				.then(setEmuWallets).catch(() => {})
		})
		return unsub
	}, [refresh, emulatorEnabled])

	// When the flag is flipped off while the grid is mounted, clear any stale
	// emulator state so the render-site conditionals (emuPaired, emuStatus,
	// emuWallets.length) all short-circuit cleanly.
	useEffect(() => {
		if (!emulatorEnabled) {
			setEmuStatus(null)
			setEmuPaired(false)
			setEmuWallets([])
			setChannelPicker(null)
			setConfirmDeleteEmu(null)
		}
	}, [emulatorEnabled])

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
		// Fetch available channels and show picker
		setError(null)
		setChannelPicker(name)
		try {
			const ch = await rpcRequest<{ channel: string; installed: boolean }[]>("emulatorGetChannels", undefined, 5000)
			setEmuChannels(ch)
		} catch {
			setEmuChannels([])
		}
	}, [])

	const handleStartEmuWithChannel = useCallback(async (name: string, channel: string) => {
		setChannelPicker(null)
		setLoading(`emu:${name}`)
		setError(null)
		try {
			await rpcRequest<EmulatorStatus>("emulatorSwitchWallet", { name, channel }, 20000)
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


	// ── Helpers ──────────────────────────────────────────────────────

	function formatUsd(n: number): string {
		return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
	}

	const grandTotal = devices.reduce((sum, d) => sum + (d.totalUsd || 0), 0)
		+ emuWallets.reduce((sum, w) => sum + (w.totalUsd || 0), 0)

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

	// Notify parent when grid is ready to display
	useEffect(() => {
		if (revealed && hasContent) onReady?.()
	}, [revealed, hasContent, onReady])

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

			{/* Section label */}
			<Text fontSize="xs" fontWeight="600" color="gray.500" mb="3" textAlign="center" letterSpacing="0.05em" textTransform="uppercase">
				Registered Devices
			</Text>

			{/* Grid of cards */}
			<Flex wrap="wrap" gap="3" justify="center">

				{/* ── Physical device cards ─────────────────────────── */}
				{devices.map((d) => {
					const color = deviceIdToColor(d.deviceId)
					return (
					<DeviceCard key={d.deviceId} accentColor={color}>
						{/* Forget X — top right */}
						{confirmForget === d.deviceId ? (
							<Flex justify="flex-end" gap="1" mb="1">
								<Text fontSize="9px" color="#EF4444" alignSelf="center" mr="1">Forget?</Text>
								<SmallCircleBtn color="#EF4444" label="Y" onClick={() => handleForgetDevice(d.deviceId)} loading={loading === d.deviceId} />
								<SmallCircleBtn color="#666" label="N" onClick={() => setConfirmForget(null)} />
							</Flex>
						) : (
							<Flex justify="flex-end" mb="1">
								<SmallCircleBtn color="#EF4444" label="&times;" onClick={() => setConfirmForget(d.deviceId)} />
							</Flex>
						)}
						<Flex align="center" gap="2" mb="1">
							<Image src={kkIcon} alt="KeepKey" w="28px" h="28px" borderRadius="lg" border="1.5px solid" borderColor={color} flexShrink={0} />
							<Box flex="1" minW="0">
								<Text fontSize="xs" fontWeight="600" color="gray.200" truncate>
									{d.label || "KeepKey"}
								</Text>
								<Text fontSize="9px" color="gray.500">
									fw {d.firmwareVer} &middot; {timeAgo(d.updatedAt)}
								</Text>
							</Box>
						</Flex>
						{d.totalUsd > 0 && (
							<Text fontSize="sm" fontWeight="700" color={showValues ? color : "gray.600"} mb="1">
								{showValues ? `$${formatUsd(d.totalUsd)}` : "$ ****"}
							</Text>
						)}
						<Box mt="auto">
							<CardBtn label="View" color="#C0A860" onClick={() => onViewPortfolio(d.deviceId, d.label || 'KeepKey')} />
						</Box>
					</DeviceCard>
				)})}

				{/* ── Emulator wallet cards ─────────────────────────── */}
				{emuWallets.map((w) => {
					const active = w.isActive && emuRunning
					const isDeleting = confirmDeleteEmu === w.name
					const channelColor = w.channel ? CHANNEL_COLORS[w.channel] || '#C0A860' : null
					const displayName = w.label || w.name
					return (
						<DeviceCard key={`emu:${w.name}`} active={active} accentColor={active ? undefined : "#C0A860"}>
							<Flex align="center" gap="2" mb="1">
								<EmulatorIcon active={active} />
								<Box flex="1" minW="0">
									<Text fontSize="xs" fontWeight="600" color={active ? "#22C55E" : "gray.200"} truncate>
										{displayName}
									</Text>
									{w.label && w.label !== w.name && (
										<Text fontSize="9px" color="gray.600" truncate>{w.name}</Text>
									)}
									<Flex gap="1.5" mt="0.5" align="center" wrap="wrap">
										<Text fontSize="9px" fontWeight="700" color={active ? "#22C55E" : "#3B82F6"} bg={active ? "rgba(34,197,94,0.12)" : "rgba(59,130,246,0.15)"} px="1.5" py="0.5" borderRadius="sm">
											{active ? "running" : "EMULATOR"}
										</Text>
										{w.firmwareVersion && (
											<Text fontSize="9px" color="gray.500">
												fw {w.firmwareVersion}
											</Text>
										)}
										{w.channel && channelColor && (
											<Text fontSize="9px" fontWeight="700" color={channelColor} textTransform="uppercase" letterSpacing="wider">
												{w.channel}
											</Text>
										)}
									</Flex>
									{w.hasMnemonic && <Text fontSize="9px" color="gray.600" mt="0.5">seed saved</Text>}
								</Box>
							</Flex>
							{(w.totalUsd ?? 0) > 0 && (
								<Text fontSize="sm" fontWeight="700" color={showValues ? (active ? "#22C55E" : "#C0A860") : "gray.600"} mb="1">
									{showValues ? `$${formatUsd(w.totalUsd ?? 0)}` : "$ ****"}
								</Text>
							)}
							{isDeleting ? (
								<Box mt="auto">
									<Text fontSize="10px" color="#EF4444" mb="1.5" lineHeight="1.4">
										Delete from disk? Recovery phrase needed to re-load.
									</Text>
									<Flex gap="1.5">
										<SmallCircleBtn color="#EF4444" label="Y" onClick={() => handleDeleteEmu(w.name)} loading={loading === `emu:${w.name}`} />
										<SmallCircleBtn color="#666" label="N" onClick={() => setConfirmDeleteEmu(null)} />
									</Flex>
								</Box>
							) : channelPicker === w.name ? (
								<ChannelPicker
									name={w.name}
									channels={emuChannels}
									onSelect={handleStartEmuWithChannel}
									onCancel={() => setChannelPicker(null)}
									loading={loading === `emu:${w.name}`}
								/>
							) : (
								<Flex mt="auto" justify="space-between" align="center">
									{active ? (
										<CardBtn label="Stop" color="#EF4444" onClick={handleStopEmu} loading={loading === "emu:__stop"} />
									) : (
										<SolidBtn label="Start" bg="#22C55E" onClick={() => handleStartEmu(w.name)} loading={loading === `emu:${w.name}`} />
									)}
									{!active && (
										<SmallCircleBtn color="#EF4444" label="&times;" onClick={() => setConfirmDeleteEmu(w.name)} />
									)}
								</Flex>
							)}
						</DeviceCard>
					)
				})}

				{/* New emulators are added via the bottom-right EmulatorManager pill,
				    which routes through the standard OobSetupWizard. */}

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

			{/* Grand total + eyeball toggle */}
			{grandTotal > 0 && (
				<Flex justify="center" align="center" gap="2" mt="4">
					<Text fontSize="xs" color="gray.500">
						Total across all devices: <Text as="span" fontWeight="700" color={showValues ? "gray.300" : "gray.600"}>
							{showValues ? `$${formatUsd(grandTotal)}` : "$ ****"}
						</Text>
					</Text>
					<Box as="button" cursor="pointer" opacity={0.6} _hover={{ opacity: 1 }} transition="opacity 0.15s"
						onClick={() => setShowValues(v => !v)} title={showValues ? "Hide values" : "Show values"}>
						{showValues ? (
							<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#999" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
								<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" /><circle cx="12" cy="12" r="3" />
							</svg>
						) : (
							<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#666" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
								<path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94" />
								<path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19" />
								<line x1="1" y1="1" x2="23" y2="23" />
							</svg>
						)}
					</Box>
				</Flex>
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

// ── Color from deviceId ─────────────────────────────────────────────────
// Deterministic HSL color derived from a simple string hash so each device
// always gets the same accent color.
function deviceIdToColor(id: string): string {
	let hash = 0
	for (let i = 0; i < id.length; i++) {
		hash = ((hash << 5) - hash + id.charCodeAt(i)) | 0
	}
	const hue = ((hash % 360) + 360) % 360
	return `hsl(${hue}, 55%, 55%)`
}

function hexToRgb(hsl: string): string {
	// Parse hsl and convert to approximate rgb for rgba usage
	const m = hsl.match(/hsl\((\d+),\s*(\d+)%,\s*(\d+)%\)/)
	if (!m) return '192,168,96'
	const [, h, s, l] = m.map(Number)
	const a = (s / 100) * Math.min(l / 100, 1 - l / 100)
	const f = (n: number) => {
		const k = (n + h / 30) % 12
		return Math.round((l / 100 - a * Math.max(Math.min(k - 3, 9 - k, 1), -1)) * 255)
	}
	return `${f(0)},${f(8)},${f(4)}`
}

// ── Reusable sub-components ─────────────────────────────────────────────

function DeviceCard({ children, active, accentColor }: { children: React.ReactNode; active?: boolean; accentColor?: string }) {
	const rgb = accentColor ? hexToRgb(accentColor) : null
	return (
		<Flex
			direction="column"
			w="180px"
			minH="130px"
			bg={active ? "rgba(34,197,94,0.16)" : rgb ? `rgba(${rgb},0.14)` : "rgba(255,255,255,0.12)"}
			border="2px solid"
			borderColor={active ? "rgba(34,197,94,0.7)" : rgb ? `rgba(${rgb},0.6)` : "rgba(255,255,255,0.35)"}
			borderRadius="xl"
			px="3" py="2.5"
			transition="all 0.2s"
			_hover={{ bg: active ? "rgba(34,197,94,0.22)" : rgb ? `rgba(${rgb},0.2)` : "rgba(255,255,255,0.16)" }}
		>
			{children}
		</Flex>
	)
}

function SmallCircleBtn({ color, label, onClick, loading }: { color: string; label: string; onClick: () => void; loading?: boolean }) {
	const rgb = color === "#EF4444" ? "239,68,68" : "102,102,102"
	return (
		<Box
			as="button" w="16px" h="16px" borderRadius="full" display="flex" alignItems="center" justifyContent="center"
			fontSize="10px" fontWeight="700" lineHeight="1" color={color}
			bg={`rgba(${rgb},0.15)`} border="1px solid" borderColor={`rgba(${rgb},0.4)`}
			cursor={loading ? "wait" : "pointer"} opacity={loading ? 0.5 : 1}
			_hover={{ bg: `rgba(${rgb},0.35)` }} transition="all 0.15s"
			onClick={onClick} dangerouslySetInnerHTML={{ __html: label }}
		/>
	)
}

function SolidBtn({ label, bg, onClick, loading }: { label: string; bg: string; onClick: () => void; loading?: boolean }) {
	return (
		<Box
			as="button"
			px="12px" py="4px"
			borderRadius="md" fontSize="11px" fontWeight="700"
			color="black" bg={bg}
			cursor={loading ? "wait" : "pointer"} opacity={loading ? 0.6 : 1}
			_hover={{ opacity: 0.85 }} transition="all 0.15s"
			onClick={onClick}
		>
			{label}
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



/** Chip icon — emulator device */
function EmulatorIcon({ active }: { active: boolean }) {
	const c = active ? "#22C55E" : "#C0A860"
	return (
		<Box w="28px" h="28px" flexShrink={0} display="flex" alignItems="center" justifyContent="center"
			bg={active ? "rgba(34,197,94,0.12)" : "rgba(192,168,96,0.12)"} borderRadius="lg">
			<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
				<rect x="4" y="4" width="16" height="16" rx="2" /><rect x="9" y="9" width="6" height="6" />
				<line x1="9" y1="1" x2="9" y2="4" /><line x1="15" y1="1" x2="15" y2="4" />
				<line x1="9" y1="20" x2="9" y2="23" /><line x1="15" y1="20" x2="15" y2="23" />
			</svg>
		</Box>
	)
}
