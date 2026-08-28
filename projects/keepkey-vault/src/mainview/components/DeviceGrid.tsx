/**
 * DeviceGrid — wallet selector shown on the splash screen.
 *
 * Renders cards for every registered KeepKey (live or watch-only cache) plus
 * any emulator wallets when that flag is on. Empty grid is now an explicit
 * "Connect your KeepKey to begin" hero instead of nothing — gives first-run
 * users somewhere to land. Watch-only state is called out clearly so users
 * can tell at a glance which wallets have signing live and which are cached.
 */
import { useState, useEffect, useCallback } from "react"
import { Box, Flex, Text, Image } from "@chakra-ui/react"
import kkIcon from "../assets/icon.png"
import { rpcRequest, onRpcMessage } from "../lib/rpc"
import type { RegisteredDevice, EmulatorStatus, EmulatorWalletInfo } from "../../shared/types"

interface DeviceGridProps {
	onViewPortfolio: (deviceId: string, label: string) => void
	onReady?: () => void
	onEnableEmulator?: () => Promise<void>
	/** When false, no emulator UI is fetched or rendered (feature flag, default off). */
	emulatorEnabled?: boolean
}

const REVEAL_DELAY_MS = 2500
const SUPPORT_URL = 'https://support.keepkey.com'

let hasRevealedOnce = false // module-level: skip delay after first reveal (e.g. returning from X)

export function DeviceGrid({ onViewPortfolio, onReady, onEnableEmulator, emulatorEnabled = false }: DeviceGridProps) {
	const [devices, setDevices] = useState<RegisteredDevice[]>([])
	const [emuWallets, setEmuWallets] = useState<EmulatorWalletInfo[]>([])
	const [emuStatus, setEmuStatus] = useState<EmulatorStatus | null>(null)
	const [loading, setLoading] = useState<string | null>(null)
	const [confirmForget, setConfirmForget] = useState<string | null>(null)
	const [confirmDeleteEmu, setConfirmDeleteEmu] = useState<string | null>(null)
	const [error, setError] = useState<string | null>(null)
	const [showValues, setShowValues] = useState(false)
	const [revealed, setRevealed] = useState(hasRevealedOnce)

	useEffect(() => {
		if (hasRevealedOnce) { setRevealed(true); return }
		const timer = setTimeout(() => { setRevealed(true); hasRevealedOnce = true }, REVEAL_DELAY_MS)
		return () => clearTimeout(timer)
	}, [])

	const refresh = useCallback(async () => {
		try {
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
			if (status) setEmuStatus(status)
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

	useEffect(() => {
		if (!emulatorEnabled) {
			setEmuStatus(null)
			setEmuWallets([])
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
		setLoading(`emu:${name}`)
		setError(null)
		try {
			// Never dead-click: the backend throws on failure, but even if a path
			// resolves with a non-running status (or nothing), surface it rather
			// than silently reverting to the Start card.
			const status = await rpcRequest<EmulatorStatus>("emulatorSwitchWallet", { name }, 20000)
			if (!status || status.state !== "running") {
				throw new Error(status?.error || "Emulator did not start (no error reported)")
			}
			await refresh()
		} catch (e: any) { setError(e?.message || String(e) || "Emulator failed to start") }
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

	const handleEnableEmu = useCallback(async () => {
		if (!onEnableEmulator) return
		setLoading("emu:__enable")
		setError(null)
		try {
			await onEnableEmulator()
		} catch (e: any) {
			setError(e?.message || String(e) || "Emulator could not be enabled")
		}
		setLoading(null)
	}, [onEnableEmulator])

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
	const hasContent = devices.length > 0 || emuWallets.length > 0

	// Emulator entry point. Rendered identically in the empty-state hero AND the
	// populated workspace so a Start-emulator affordance is ALWAYS reachable —
	// registered devices (hasContent) must not hide it. Parity with macOS, where
	// the emulator flow is always offered regardless of what's already in the DB.
	const emulatorStartCard = (!emulatorEnabled && onEnableEmulator) ? (
		<Box
			w="100%"
			maxW="440px"
			borderRadius="18px"
			border="1px solid rgba(168,85,247,0.28)"
			bg="rgba(168,85,247,0.06)"
			p="5"
		>
			<Flex align="center" gap="3">
				<EmulatorIcon active={false} />
				<Box flex="1" minW="0">
					<Text fontSize="13px" fontWeight="600" color="var(--text-0)" mb="1">
						Testing with an emulator?
					</Text>
					<Text fontSize="12px" color="var(--text-2)" lineHeight="1.5">
						Open the local emulator wallet picker without connecting a USB device.
					</Text>
				</Box>
			</Flex>
			<Box mt="3">
				<CardCta tone="teal" onClick={handleEnableEmu} loading={loading === "emu:__enable"}>
					Start emulator
				</CardCta>
			</Box>
		</Box>
	) : null

	useEffect(() => {
		// Always notify parent once revealed — even when empty — so SplashScreen
		// can slide the logo to the top and reveal the connect-prompt hero.
		if (revealed) onReady?.()
	}, [revealed, onReady])

	if (!revealed) return null

	// ── Render ───────────────────────────────────────────────────────
	return (
		<Box
			w="100%"
			maxW="720px"
			style={{ animation: 'fadeIn 0.4s ease' }}
		>
			{/* Header */}
			<Flex direction="column" align="center" mb="5" gap="1">
				<Text
					fontSize="11px"
					color="var(--text-3)"
					letterSpacing="0.18em"
					textTransform="uppercase"
					fontFamily="mono"
				>
					{hasContent ? 'Workspace' : 'Welcome'}
				</Text>
				<Text
					fontSize="28px"
					fontWeight="500"
					color="var(--text-0)"
					letterSpacing="-0.01em"
					lineHeight="1.1"
				>
					{hasContent ? 'Choose a wallet' : 'Connect your KeepKey'}
				</Text>
				<Text fontSize="13px" color="var(--text-2)" textAlign="center" maxW="460px" mt="1" letterSpacing="-0.005em">
					{hasContent
						? 'Plug in your KeepKey to sign live, or open a saved wallet in view-only mode.'
						: 'Plug in your device with the supplied USB cable to start a session. View-only wallets will appear here once you’ve paired a device.'}
				</Text>
			</Flex>

			{/* Emulator entry point in the populated workspace — always offered,
			    never hidden by registered devices (parity with the empty state). */}
			{hasContent && emulatorStartCard && (
				<Flex justify="center" mb="4">
					{emulatorStartCard}
				</Flex>
			)}

			{/* Error banner */}
			{error && (
				<Box mb="3" px="3" py="2" bg="rgba(224,140,123,0.12)" border="1px solid" borderColor="rgba(224,140,123,0.32)" borderRadius="lg">
					<Text fontSize="11px" color="var(--rose)" wordBreak="break-all">{error}</Text>
				</Box>
			)}

			{/* Empty-state hero — when there's nothing registered yet */}
			{!hasContent && (
				<Flex direction="column" align="center" gap="3" py="2" mb="4">
					<Box
						w="100%"
						maxW="440px"
						borderRadius="18px"
						border="1px solid var(--ink-3)"
						bg="rgba(11,11,14,0.55)"
						backdropFilter="blur(8px)"
						p="5"
					>
						<Flex align="flex-start" gap="3">
							<Box
								w="40px" h="40px" borderRadius="10px" flexShrink={0}
								bg="rgba(233,196,106,0.10)"
								border="1px solid rgba(233,196,106,0.25)"
								display="flex" alignItems="center" justifyContent="center"
							>
								<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--gold)" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
									<rect x="2" y="6" width="14" height="12" rx="2"/>
									<line x1="16" y1="10" x2="20" y2="10"/>
									<line x1="16" y1="14" x2="20" y2="14"/>
									<rect x="20" y="8" width="2" height="8" rx="0.5"/>
								</svg>
							</Box>
							<Box flex="1" minW="0">
								<Text fontSize="13px" fontWeight="600" color="var(--text-0)" mb="1">
									Connect a KeepKey to begin
								</Text>
								<Text fontSize="12px" color="var(--text-2)" lineHeight="1.5">
									Once paired, your wallet keys never leave the device. Vault talks to the device over the cable — no servers in between.
								</Text>
							</Box>
						</Flex>
					</Box>
					{emulatorStartCard}
				</Flex>
			)}

			{/* Grid of cards */}
			{hasContent && (
				<Flex wrap="wrap" gap="3" justify="center">
					{/* Physical device cards (watch-only when not the active live session) */}
					{devices.map((d) => (
						<DeviceCard key={d.deviceId}>
							{/* Top row: badge + forget */}
							<Flex justify="space-between" align="center" mb="2">
								<WatchOnlyBadge />
								{confirmForget === d.deviceId ? (
									<Flex gap="1" align="center">
										<Text fontSize="10px" color="var(--rose)">Forget?</Text>
										<SmallCircleBtn color="var(--rose)" label="Y" onClick={() => handleForgetDevice(d.deviceId)} loading={loading === d.deviceId} />
										<SmallCircleBtn color="var(--text-3)" label="N" onClick={() => setConfirmForget(null)} />
									</Flex>
								) : (
									<SmallCircleBtn color="var(--text-3)" label="&times;" onClick={() => setConfirmForget(d.deviceId)} />
								)}
							</Flex>

							{/* Identity */}
							<Flex align="center" gap="2.5" mb="2.5">
								<Image src={kkIcon} alt="KeepKey" w="36px" h="36px" borderRadius="10px"
									border="1px solid var(--ink-4)" flexShrink={0} bg="var(--ink-2)" />
								<Box flex="1" minW="0">
									<Text fontSize="14px" fontWeight="500" color="var(--text-0)" truncate lineHeight="1.2">
										{d.label || "KeepKey"}
									</Text>
									<Text fontSize="10px" color="var(--text-3)" fontFamily="mono" letterSpacing="0.02em">
										fw {d.firmwareVer} · {timeAgo(d.updatedAt)}
									</Text>
								</Box>
							</Flex>

							{/* Balance */}
							{d.totalUsd > 0 && (
								<Box mb="2.5">
									<Text fontSize="10px" color="var(--text-3)" letterSpacing="0.06em" textTransform="uppercase" fontFamily="mono">
										Cached balance
									</Text>
									<Text fontSize="17px" fontWeight="500" color={showValues ? "var(--text-0)" : "var(--text-3)"} lineHeight="1.1">
										{showValues ? `$${formatUsd(d.totalUsd)}` : '$ ••••'}
									</Text>
								</Box>
							)}

							{/* Action */}
							<CardCta onClick={() => onViewPortfolio(d.deviceId, d.label || 'KeepKey')}>
								Open view-only
							</CardCta>
						</DeviceCard>
					))}

					{/* Emulator wallet cards */}
					{emuWallets.map((w) => {
						const active = w.isActive && emuRunning
						const isDeleting = confirmDeleteEmu === w.name
						const displayName = w.label || w.name
						return (
							<DeviceCard key={`emu:${w.name}`} active={active}>
								<Flex justify="space-between" align="center" mb="2">
									<EmuBadge active={active} />
									{!active && !isDeleting && (
										<SmallCircleBtn color="var(--text-3)" label="&times;" onClick={() => setConfirmDeleteEmu(w.name)} />
									)}
								</Flex>

								<Flex align="center" gap="2.5" mb="2.5">
									<EmulatorIcon active={active} />
									<Box flex="1" minW="0">
										<Text fontSize="14px" fontWeight="500" color={active ? "var(--teal)" : "var(--text-0)"} truncate lineHeight="1.2">
											{displayName}
										</Text>
										{w.label && w.label !== w.name && (
											<Text fontSize="10px" color="var(--text-3)" fontFamily="mono" truncate>{w.name}</Text>
										)}
										{w.hasMnemonic && <Text fontSize="10px" color="var(--text-3)" mt="0.5">seed saved</Text>}
									</Box>
								</Flex>

								{(w.totalUsd ?? 0) > 0 && (
									<Box mb="2.5">
										<Text fontSize="10px" color="var(--text-3)" letterSpacing="0.06em" textTransform="uppercase" fontFamily="mono">
											Cached balance
										</Text>
										<Text fontSize="17px" fontWeight="500" color={showValues ? (active ? "var(--teal)" : "var(--text-0)") : "var(--text-3)"} lineHeight="1.1">
											{showValues ? `$${formatUsd(w.totalUsd ?? 0)}` : '$ ••••'}
										</Text>
									</Box>
								)}

								{isDeleting ? (
									<Box>
										<Text fontSize="10px" color="var(--rose)" mb="1.5" lineHeight="1.4">
											Delete from disk? Recovery phrase needed to re-load.
										</Text>
										<Flex gap="1.5">
											<SmallCircleBtn color="var(--rose)" label="Y" onClick={() => handleDeleteEmu(w.name)} loading={loading === `emu:${w.name}`} />
											<SmallCircleBtn color="var(--text-3)" label="N" onClick={() => setConfirmDeleteEmu(null)} />
										</Flex>
									</Box>
								) : active ? (
									<CardCta tone="rose" onClick={handleStopEmu} loading={loading === "emu:__stop"}>
										Stop emulator
									</CardCta>
								) : (
									<CardCta tone="teal" onClick={() => handleStartEmu(w.name)} loading={loading === `emu:${w.name}`}>
										Start
									</CardCta>
								)}
							</DeviceCard>
						)
					})}
				</Flex>
			)}

			{/* Grand total + eyeball toggle */}
			{grandTotal > 0 && (
				<Flex justify="center" align="center" gap="2" mt="5">
					<Text fontSize="11px" color="var(--text-3)" letterSpacing="0.04em">
						Total across all wallets:&nbsp;
						<Text as="span" fontWeight="600" color={showValues ? "var(--text-1)" : "var(--text-3)"} fontFamily="mono">
							{showValues ? `$${formatUsd(grandTotal)}` : '$ ••••'}
						</Text>
					</Text>
					<Box as="button" cursor="pointer" opacity={0.55} _hover={{ opacity: 1 }} transition="opacity 0.15s"
						onClick={() => setShowValues(v => !v)} title={showValues ? "Hide values" : "Show values"}>
						{showValues ? (
							<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--text-2)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
								<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" /><circle cx="12" cy="12" r="3" />
							</svg>
						) : (
							<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--text-2)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
								<path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94" />
								<path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19" />
								<line x1="1" y1="1" x2="23" y2="23" />
							</svg>
						)}
					</Box>
				</Flex>
			)}

			{/* Support / troubleshooting link */}
			<Flex justify="center" align="center" gap="1.5" mt="5" opacity="0.6" _hover={{ opacity: 1 }} transition="opacity 0.15s">
				<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="var(--text-2)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
					<circle cx="12" cy="12" r="10" />
					<path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" />
					<line x1="12" y1="17" x2="12.01" y2="17" />
				</svg>
				<Text
					as="button"
					onClick={() => rpcRequest("openUrl", { url: SUPPORT_URL }).catch((e: any) => console.warn("[openUrl]", e?.message))}
					cursor="pointer"
					fontSize="11px"
					color="var(--text-2)"
					letterSpacing="0.04em"
					bg="transparent"
					_hover={{ color: "var(--gold)" }}
				>
					Trouble connecting? Visit support
				</Text>
			</Flex>

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
		<Flex
			direction="column"
			w="220px"
			minH="180px"
			bg="rgba(16,16,21,0.85)"
			border="1px solid"
			borderColor={active ? "rgba(139,227,196,0.45)" : "var(--ink-3)"}
			borderRadius="16px"
			px="3.5" py="3"
			backdropFilter="blur(8px)"
			boxShadow={active ? "0 0 0 1px rgba(139,227,196,0.22), 0 8px 24px -8px rgba(139,227,196,0.18)" : "0 1px 0 rgba(255,255,255,0.02)"}
			transition="all 0.2s"
			_hover={{
				borderColor: active ? "rgba(139,227,196,0.6)" : "rgba(233,196,106,0.45)",
				transform: "translateY(-1px)",
				boxShadow: active ? "0 0 0 1px rgba(139,227,196,0.32), 0 12px 28px -10px rgba(139,227,196,0.22)" : "0 8px 24px -10px rgba(233,196,106,0.18)",
			}}
		>
			{children}
		</Flex>
	)
}

function WatchOnlyBadge() {
	return (
		<Flex align="center" gap="1" px="1.5" py="0.5"
			bg="rgba(139,227,196,0.10)" border="1px solid rgba(139,227,196,0.25)" borderRadius="999px">
			<Box w="5px" h="5px" borderRadius="full" bg="var(--teal)" />
			<Text fontSize="9px" color="var(--teal)" fontWeight="600" letterSpacing="0.06em" textTransform="uppercase" fontFamily="mono">
				view-only
			</Text>
		</Flex>
	)
}

function EmuBadge({ active }: { active: boolean }) {
	return (
		<Flex align="center" gap="1" px="1.5" py="0.5"
			bg={active ? "rgba(139,227,196,0.12)" : "rgba(233,196,106,0.10)"}
			border="1px solid"
			borderColor={active ? "rgba(139,227,196,0.30)" : "rgba(233,196,106,0.25)"}
			borderRadius="999px">
			<Box w="5px" h="5px" borderRadius="full"
				bg={active ? "var(--teal)" : "var(--gold)"}
				style={active ? { animation: 'fadeIn 1.5s ease-in-out infinite alternate' } : undefined}
			/>
			<Text fontSize="9px" color={active ? "var(--teal)" : "var(--gold)"} fontWeight="600" letterSpacing="0.06em" textTransform="uppercase" fontFamily="mono">
				{active ? 'running' : 'emulator'}
			</Text>
		</Flex>
	)
}

function SmallCircleBtn({ color, label, onClick, loading }: { color: string; label: string; onClick: () => void; loading?: boolean }) {
	return (
		<Box
			as="button" w="18px" h="18px" borderRadius="full" display="flex" alignItems="center" justifyContent="center"
			fontSize="11px" fontWeight="600" lineHeight="1" color={color}
			bg="transparent" border="1px solid" borderColor={color}
			cursor={loading ? "wait" : "pointer"} opacity={loading ? 0.5 : 0.7}
			_hover={{ opacity: 1, bg: "rgba(255,255,255,0.04)" }} transition="all 0.15s"
			onClick={onClick} dangerouslySetInnerHTML={{ __html: label }}
		/>
	)
}

function CardCta({
	children,
	onClick,
	loading,
	tone = 'gold',
}: {
	children: React.ReactNode
	onClick: () => void
	loading?: boolean
	tone?: 'gold' | 'teal' | 'rose'
}) {
	const accent = tone === 'teal' ? 'var(--teal)' : tone === 'rose' ? 'var(--rose)' : 'var(--gold)'
	const accentSoft = tone === 'teal' ? 'rgba(139,227,196,0.10)' : tone === 'rose' ? 'rgba(224,140,123,0.10)' : 'rgba(233,196,106,0.10)'
	const accentBorder = tone === 'teal' ? 'rgba(139,227,196,0.30)' : tone === 'rose' ? 'rgba(224,140,123,0.30)' : 'rgba(233,196,106,0.30)'
	const accentHover = tone === 'teal' ? 'rgba(139,227,196,0.20)' : tone === 'rose' ? 'rgba(224,140,123,0.20)' : 'rgba(233,196,106,0.20)'
	return (
		<Box
			as="button"
			w="100%"
			px="3" py="1.5"
			borderRadius="10px"
			fontSize="11px" fontWeight="600"
			letterSpacing="0.04em"
			color={accent} bg={accentSoft}
			border="1px solid" borderColor={accentBorder}
			cursor={loading ? "wait" : "pointer"} opacity={loading ? 0.5 : 1}
			_hover={{ bg: accentHover }}
			mt="auto"
			onClick={onClick}
		>
			{children}
		</Box>
	)
}

function EmulatorIcon({ active }: { active: boolean }) {
	const c = active ? "var(--teal)" : "var(--gold)"
	return (
		<Box w="36px" h="36px" flexShrink={0} display="flex" alignItems="center" justifyContent="center"
			bg={active ? "rgba(139,227,196,0.10)" : "rgba(233,196,106,0.10)"}
			border="1px solid"
			borderColor={active ? "rgba(139,227,196,0.25)" : "rgba(233,196,106,0.25)"}
			borderRadius="10px">
			<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
				<rect x="4" y="4" width="16" height="16" rx="2" /><rect x="9" y="9" width="6" height="6" />
				<line x1="9" y1="1" x2="9" y2="4" /><line x1="15" y1="1" x2="15" y2="4" />
				<line x1="9" y1="20" x2="9" y2="23" /><line x1="15" y1="20" x2="15" y2="23" />
			</svg>
		</Box>
	)
}
