import { useEffect, useMemo, useRef, useState } from "react"
import { Box, Flex, Text, Image } from "@chakra-ui/react"
import { useTranslation } from "react-i18next"
import { rpcRequest } from "../lib/rpc"
import kkIcon from "../assets/icon.png"
import type { RegisteredDevice } from "../../shared/types"

interface WalletSelectorProps {
	/** True when popover is open. Parent owns the toggle. */
	open: boolean
	close: () => void
	/** Pixel-positioned anchor (relative to the viewport). */
	anchor: { left: number; top: number } | null
	/** Device the live USB session is paired with — null when nothing is plugged in. */
	connectedDeviceId: string | null
	connectedLabel?: string
	/** Wallet currently being viewed in watch-only mode (undefined when viewing the connected device). */
	watchingDeviceId: string | null
	/** Switch to watch-only view of a non-connected wallet. */
	onWatch: (deviceId: string, label: string) => void
	/** Return to the connected wallet view from a watch-only session. */
	onReturnToConnected: () => void
}

/** Short relative-time label, e.g. "2m ago", "3h ago", "5d ago". */
function relTime(ms: number): string {
	if (!ms) return ""
	const dt = Date.now() - ms
	if (dt < 60_000) return "just now"
	if (dt < 3_600_000) return `${Math.floor(dt / 60_000)}m ago`
	if (dt < 86_400_000) return `${Math.floor(dt / 3_600_000)}h ago`
	return `${Math.floor(dt / 86_400_000)}d ago`
}

function dollars(n: number): string {
	if (!n) return "$0.00"
	if (n >= 10_000) return `$${(n / 1000).toFixed(1)}k`
	return `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

/**
 * Dropdown launched from the navbar LogoTile. Lists every KeepKey the vault
 * has cached so the user can switch between them without unplugging or
 * walking through the splash flow. The currently-connected device is pinned
 * at the top with a green status dot; the rest are tagged with their cached
 * USD total and last-seen relative time so it's obvious what's stale.
 *
 * Clicking a non-connected wallet hands control back to App (via onWatch),
 * which flips watchOnlyMode on and renders the Dashboard against that
 * device's cached balances. Clicking the connected wallet (or pressing
 * Escape) closes the menu without any state change.
 */
export function WalletSelector({
	open,
	close,
	anchor,
	connectedDeviceId,
	connectedLabel,
	watchingDeviceId,
	onWatch,
	onReturnToConnected,
}: WalletSelectorProps) {
	const { t } = useTranslation("nav")
	const [devices, setDevices] = useState<RegisteredDevice[]>([])
	const [loading, setLoading] = useState(false)
	const ref = useRef<HTMLDivElement | null>(null)

	useEffect(() => {
		if (!open) return
		let cancelled = false
		setLoading(true)
		rpcRequest<RegisteredDevice[]>("getRegisteredDevices", undefined, 5000)
			.then((res) => { if (!cancelled) setDevices(Array.isArray(res) ? res : []) })
			.catch((e) => { if (!cancelled) { console.warn("[WalletSelector] fetch failed:", e); setDevices([]) } })
			.finally(() => { if (!cancelled) setLoading(false) })
		return () => { cancelled = true }
	}, [open])

	// Click-outside + Escape to close. Listener bound only while open so we
	// don't fight other popovers (settings, wallet-connect) the rest of the time.
	useEffect(() => {
		if (!open) return
		const onDown = (e: MouseEvent) => {
			if (!ref.current) return
			if (ref.current.contains(e.target as Node)) return
			close()
		}
		const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") close() }
		document.addEventListener("mousedown", onDown)
		document.addEventListener("keydown", onKey)
		return () => {
			document.removeEventListener("mousedown", onDown)
			document.removeEventListener("keydown", onKey)
		}
	}, [open, close])

	// Pin connected wallet to the top of the list so it's always the first
	// row even if last-seen ordering would push it down (e.g. fresh device).
	const ordered = useMemo(() => {
		if (!connectedDeviceId) return devices
		const connected = devices.find(d => d.deviceId === connectedDeviceId)
		const rest = devices.filter(d => d.deviceId !== connectedDeviceId)
		return connected ? [connected, ...rest] : devices
	}, [devices, connectedDeviceId])

	if (!open || !anchor) return null

	const activeDeviceId = watchingDeviceId || connectedDeviceId

	return (
		<Box
			ref={ref}
			position="fixed"
			top={`${anchor.top}px`}
			left={`${anchor.left}px`}
			zIndex={9999}
			bg="rgba(11,11,14,0.98)"
			backdropFilter="blur(20px)"
			border="1px solid var(--line)"
			borderRadius="lg"
			boxShadow="0 12px 40px rgba(0,0,0,0.6)"
			w="320px"
			maxH="min(70vh, 480px)"
			overflowY="auto"
			py="1.5"
			className="electrobun-webkit-app-region-no-drag"
		>
			<Flex align="center" justify="space-between" px="3" py="1.5" mb="0.5">
				<Text fontSize="10px" color="var(--text-3)" letterSpacing="0.18em" textTransform="uppercase">
					{t("walletSelectorTitle", { defaultValue: "Wallets" })}
				</Text>
				{loading && (
					<Text fontSize="9px" color="var(--text-3)">…</Text>
				)}
			</Flex>

			{ordered.length === 0 && !loading && (
				<Text fontSize="12px" color="var(--text-3)" px="3" py="3">
					{t("walletSelectorEmpty", { defaultValue: "No wallets cached yet — connect a KeepKey." })}
				</Text>
			)}

			{ordered.map((d) => {
				const isConnected = !!connectedDeviceId && d.deviceId === connectedDeviceId
				const isActive = d.deviceId === activeDeviceId
				const displayLabel = isConnected
					? (connectedLabel || d.label || "KeepKey")
					: (d.label || "KeepKey")
				const onClick = () => {
					if (isConnected) {
						// Active wallet IS the connected one — clicking either
						// returns to it (when in watch-only) or no-ops.
						if (watchingDeviceId) onReturnToConnected()
						close()
					} else {
						onWatch(d.deviceId, displayLabel)
						close()
					}
				}
				return (
					<Box
						key={d.deviceId}
						as="button"
						w="100%"
						px="3"
						py="2"
						bg={isActive ? "rgba(233,196,106,0.08)" : "transparent"}
						borderLeft="2px solid"
						borderLeftColor={isActive ? "var(--gold)" : "transparent"}
						_hover={{ bg: "rgba(255,255,255,0.04)" }}
						cursor="pointer"
						textAlign="left"
						onClick={onClick}
					>
						<Flex align="center" gap="2.5">
							<Box position="relative" w="32px" h="32px" borderRadius="8px" overflow="hidden" bg="#000" border="1px solid var(--line-2)" flexShrink={0}>
								<Image src={kkIcon} alt="" w="100%" h="100%" objectFit="cover" />
								<Box
									position="absolute"
									bottom="-2px"
									right="-2px"
									w="10px"
									h="10px"
									borderRadius="full"
									bg={isConnected ? "var(--mint, #8be3c4)" : "var(--text-3)"}
									border="2px solid rgba(11,11,14,1)"
									title={isConnected ? "Connected" : "Cached (not connected)"}
								/>
							</Box>
							<Box flex="1" minW="0">
								<Flex align="center" gap="1.5">
									<Text fontSize="13px" fontWeight="600" color="var(--text-0)" truncate>
										{displayLabel}
									</Text>
									{isConnected && (
										<Text fontSize="9px" color="var(--mint, #8be3c4)" fontWeight="600" letterSpacing="0.06em" textTransform="uppercase">
											{t("connected", { defaultValue: "connected" })}
										</Text>
									)}
									{!isConnected && isActive && (
										<Text fontSize="9px" color="var(--gold)" fontWeight="600" letterSpacing="0.06em" textTransform="uppercase">
											{t("viewing", { defaultValue: "viewing" })}
										</Text>
									)}
								</Flex>
								<Flex align="center" gap="2" mt="0.5">
									<Text fontSize="10px" color="var(--text-3)" fontFamily="mono" truncate>
										{d.deviceId.slice(0, 8)}…{d.deviceId.slice(-4)}
									</Text>
									{d.updatedAt > 0 && (
										<Text fontSize="10px" color="var(--text-3)">
											· {relTime(d.updatedAt)}
										</Text>
									)}
								</Flex>
							</Box>
							<Text fontSize="11px" color="var(--text-2)" fontFamily="mono" fontWeight="500" flexShrink={0}>
								{dollars(d.totalUsd || 0)}
							</Text>
						</Flex>
					</Box>
				)
			})}
		</Box>
	)
}
