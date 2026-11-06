import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { Box, Button, Flex, Spinner, Text } from "@chakra-ui/react"
import { FaArrowLeft, FaCheck, FaCopy, FaEye, FaMonero, FaSyncAlt } from "react-icons/fa"
import { generateQRSvg } from "../lib/qr"
import { rpcRequest } from "../lib/rpc"
import { useFiat } from "../lib/fiat-context"
import { useUiTranslation } from "../i18n/ui"
import type { MoneroStatus } from "../../shared/types"

interface MoneroPanelProps {
	onBack?: () => void
	onLoaded?: () => void
}

const ATOMIC_UNITS = 1_000_000_000_000n
const ADDRESS_PATTERN = /^[123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz]{95}$/

function atomicAmount(value: string): bigint {
	if (!/^(0|[1-9][0-9]*)$/.test(value)) throw new Error("The wallet returned an invalid balance.")
	return BigInt(value)
}

/** Keep all twelve decimal places without passing monetary values through Number. */
function formatXmr(value: bigint): string {
	return `${value / ATOMIC_UNITS}.${(value % ATOMIC_UNITS).toString().padStart(12, "0")}`
}

function checkedStatus(status: MoneroStatus): MoneroStatus {
	if (!status || typeof status.available !== "boolean" || status.network !== "mainnet") {
		throw new Error("The Monero wallet status is unavailable.")
	}
	if (!status.available) return status
	if (!ADDRESS_PATTERN.test(status.address) || typeof status.monitorReady !== "boolean") {
		throw new Error("The wallet returned an invalid receive address or status.")
	}
	const balance = atomicAmount(status.balanceAtomic)
	const unlocked = atomicAmount(status.unlockedBalanceAtomic)
	if (unlocked > balance || !Number.isSafeInteger(status.walletHeight) || status.walletHeight < 0) {
		throw new Error("The wallet returned an invalid balance or sync height.")
	}
	if (!Array.isArray(status.transactions) || status.transactions.some(tx => (
		!tx || !/^[0-9a-f]{64}$/i.test(tx.txid)
		|| !/^(0|[1-9][0-9]*)$/.test(tx.amountAtomic)
		|| !Number.isSafeInteger(tx.confirmations) || tx.confirmations < 0
		|| typeof tx.locked !== "boolean"
	))) {
		throw new Error("The wallet returned an invalid transaction list.")
	}
	return status
}

export function MoneroPanel({ onBack, onLoaded }: MoneroPanelProps = {}) {
	const uiText = useUiTranslation()
	const { privateModeEnabled } = useFiat()
	const [status, setStatus] = useState<MoneroStatus | null>(null)
	const [refreshing, setRefreshing] = useState(false)
	const [connecting, setConnecting] = useState(false)
	const [refreshError, setRefreshError] = useState<string | null>(null)
	const [actionError, setActionError] = useState<string | null>(null)
	const [showingAddress, setShowingAddress] = useState(false)
	const [verifiedAddress, setVerifiedAddress] = useState<string | null>(null)
	const [copied, setCopied] = useState(false)
	const mounted = useRef(false)
	const requestSequence = useRef(0)
	const loaded = useRef(false)
	const onLoadedRef = useRef(onLoaded)
	const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
	onLoadedRef.current = onLoaded

	const refresh = useCallback(async () => {
		const sequence = ++requestSequence.current
		setRefreshing(true)
		try {
			const next = checkedStatus(await rpcRequest<MoneroStatus>("moneroGetStatus", {}, 8000))
			if (!mounted.current || sequence !== requestSequence.current) return
			setStatus(next)
			setRefreshError(null)
		} catch (error) {
			if (!mounted.current || sequence !== requestSequence.current) return
			setRefreshError(error instanceof Error ? error.message : "Unable to refresh the Monero wallet.")
		} finally {
			if (mounted.current && sequence === requestSequence.current) {
				setRefreshing(false)
				if (!loaded.current) {
					loaded.current = true
					onLoadedRef.current?.()
				}
			}
		}
	}, [])

	useEffect(() => {
		mounted.current = true
		void refresh()
		const interval = setInterval(() => { void refresh() }, 10_000)
		return () => {
			mounted.current = false
			++requestSequence.current
			clearInterval(interval)
			if (copyTimer.current) clearTimeout(copyTimer.current)
		}
	}, [refresh])

	const wallet = status?.available ? status : null
	const address = wallet?.address ?? ""
	// Height 0 = no scan has finished yet: the sidecar's '0' is a placeholder, not a balance.
	const scanned = !!wallet && wallet.walletHeight > 0
	const balance = scanned ? atomicAmount(wallet.balanceAtomic) : null
	const unlocked = scanned ? atomicAmount(wallet.unlockedBalanceAtomic) : null
	const locked = balance !== null && unlocked !== null ? balance - unlocked : null
	const qrSvg = useMemo(() => address ? generateQRSvg(address, 4, 2) : "", [address])
	const statusError = refreshError || status?.error || null
	const monitorReady = !!wallet?.monitorReady && !statusError

	useEffect(() => {
		setCopied(false)
		setVerifiedAddress(null)
		setActionError(null)
	}, [address])

	const copyAddress = useCallback(async () => {
		if (!address) return
		setActionError(null)
		try {
			await navigator.clipboard.writeText(address)
			if (!mounted.current) return
			setCopied(true)
			if (copyTimer.current) clearTimeout(copyTimer.current)
			copyTimer.current = setTimeout(() => setCopied(false), 2000)
		} catch {
			if (mounted.current) setActionError("Unable to copy the address. You can select and copy it below.")
		}
	}, [address])

	const showAddress = useCallback(async () => {
		if (!address || showingAddress) return
		setShowingAddress(true)
		setActionError(null)
		setVerifiedAddress(null)
		try {
			const result = await rpcRequest<{ address: string; network: "mainnet"; displayed: boolean }>(
				"moneroGetAddress", { showDisplay: true }, 180_000,
			)
			if (!mounted.current) return
			if (result?.network !== "mainnet" || result.address !== address || result.displayed !== true) {
				throw new Error("The emulator did not confirm this receive address.")
			}
			setVerifiedAddress(address)
		} catch (error) {
			if (mounted.current) setActionError(error instanceof Error ? error.message : "Unable to show the address on KeepKey.")
		} finally {
			if (mounted.current) setShowingAddress(false)
		}
	}, [address, showingAddress])

	return (
		<Box data-monero-panel="mainnet" w="100%" maxW="1000px" mx="auto" px={{ base: "4", md: "8" }} py="6">
			<Flex align="center" justify="space-between" gap="4" mb="7" flexWrap="wrap">
				<Flex align="center" gap="3">
					{onBack && (
						<Button aria-label={uiText("Back to wallets")} onClick={onBack} variant="ghost" size="sm" color="var(--text-2)" className="electrobun-webkit-app-region-no-drag">
							<FaArrowLeft />
						</Button>
					)}
					<Flex align="center" justify="center" w="42px" h="42px" borderRadius="50%" bg="rgba(255, 102, 0, 0.12)" color="#ff7a26" fontSize="27px">
						<FaMonero />
					</Flex>
					<Box>
						<Text fontSize="20px" fontWeight="600" color="var(--text-0)">{uiText("Monero")}</Text>
						<Text fontSize="12px" color="var(--text-2)">{uiText("Monero mainnet")}</Text>
					</Box>
				</Flex>
				<Flex align="center" gap="3">
					<Text px="2" py="1" borderRadius="6px" fontSize="10px" letterSpacing="0.08em" color="var(--text-2)" border="1px solid var(--line)">{uiText("Experimental")}</Text>
					<Button onClick={() => { void refresh() }} disabled={refreshing} variant="ghost" size="sm" color="var(--text-2)" aria-label={uiText("Refresh Monero wallet")} className="electrobun-webkit-app-region-no-drag">
						{refreshing ? <Spinner size="xs" /> : <FaSyncAlt />}
					</Button>
				</Flex>
			</Flex>

            <Text fontSize="12px" color="var(--text-2)" mb="5">{uiText("Receive-only preview. Sending and spent-output sync are unavailable; this balance can include funds spent from another wallet.")}</Text>
			{statusError && (
				<Box role="alert" mb="5" p="3" borderRadius="10px" border="1px solid var(--line)" bg="var(--ink-2)">
					<Text fontSize="13px" color="var(--rose)">{statusError}</Text>
					{wallet && <Text fontSize="12px" color="var(--text-2)" mt="1">{uiText("Showing the last wallet update.")}</Text>}
				</Box>
			)}

			<Box border="1px solid var(--line)" borderRadius="18px" bg="var(--ink-2)" p={{ base: "5", md: "6" }} mb="5">
				<Flex justify="space-between" align="center" gap="3" mb="3">
					<Text fontSize="11px" color="var(--text-3)" letterSpacing="0.14em" textTransform="uppercase">{uiText("Received balance")}</Text>
					<Flex align="center" gap="1.5">
						<Box w="6px" h="6px" borderRadius="50%" bg={monitorReady ? "var(--teal)" : "var(--text-3)"} />
							<Text fontSize="11px" color="var(--text-2)">{monitorReady ? uiText("Watching") : statusError ? uiText("Unavailable") : wallet ? uiText("Syncing") : refreshing ? uiText("Connecting") : uiText("Unavailable")}</Text>
					</Flex>
				</Flex>
				<Text data-monero-total-balance="" fontSize={{ base: "25px", md: "34px" }} color="var(--text-0)" fontFamily="mono" letterSpacing="-0.04em" overflowWrap="anywhere">
					{balance === null ? "—" : privateModeEnabled ? "••••••" : formatXmr(balance)} <Box as="span" fontSize="16px" color="var(--text-2)" letterSpacing="0">XMR</Box>
				</Text>
				<Flex gap={{ base: "5", md: "10" }} mt="5" flexWrap="wrap">
					<Box>
						<Text fontSize="11px" color="var(--text-3)" mb="1">{uiText("Unlocked received")}</Text>
						<Text data-monero-unlocked-balance="" fontSize="13px" fontFamily="mono" color="var(--teal)">{unlocked === null ? "—" : privateModeEnabled ? uiText("•••••• XMR") : `${formatXmr(unlocked)} XMR`}</Text>
					</Box>
					<Box>
						<Text fontSize="11px" color="var(--text-3)" mb="1">{uiText("Locked")}</Text>
						<Text data-monero-locked-balance="" fontSize="13px" fontFamily="mono" color="var(--text-1)">{locked === null ? "—" : privateModeEnabled ? uiText("•••••• XMR") : `${formatXmr(locked)} XMR`}</Text>
					</Box>
				</Flex>
				{scanned && <Text fontSize="11px" color="var(--text-3)" mt="4">{uiText("Wallet scanned through block")} {wallet.walletHeight.toLocaleString()}</Text>}
			</Box>

			{wallet ? (
				<>
					<Box border="1px solid var(--line)" borderRadius="18px" bg="var(--ink-2)" p={{ base: "5", md: "6" }} mb="5">
						<Text fontSize="15px" color="var(--text-0)" fontWeight="500" mb="5">{uiText("Receive XMR")}</Text>
						<Box display="grid" gridTemplateColumns={{ base: "1fr", md: "184px minmax(0, 1fr)" }} gap="6" alignItems="center">
							<Box w="184px" h="184px" p="2" bg="white" borderRadius="12px" mx={{ base: "auto", md: "0" }} aria-label={uiText("Monero receive address QR code")} dangerouslySetInnerHTML={{ __html: qrSvg }} css={{ "& svg": { width: "100%", height: "100%" } }} />
							<Box minW="0">
								<Flex align="center" justify="space-between" mb="2" gap="3">
									<Text fontSize="10px" color="var(--text-3)" textTransform="uppercase" letterSpacing="0.14em">{uiText("Mainnet address")}</Text>
										<Button onClick={() => { void copyAddress() }} variant="ghost" size="xs" color={copied ? "var(--teal)" : "var(--text-2)"} className="electrobun-webkit-app-region-no-drag">
										{copied ? <FaCheck /> : <FaCopy />}{copied ? uiText("Copied") : uiText("Copy")}
									</Button>
								</Flex>
								<Box bg="var(--ink-0)" border="1px solid var(--line)" borderRadius="12px" px="3.5" py="3">
									<Text data-monero-address="" fontSize="13px" fontFamily="mono" color="var(--text-0)" wordBreak="break-all" lineHeight="1.65" userSelect="all">{address}</Text>
								</Box>
								<Button data-monero-show-address="" mt="3" onClick={() => { void showAddress() }} disabled={showingAddress || wallet.emulatorReady === false} size="sm" variant="outline" color="var(--text-1)" borderColor="var(--line-2)" className="electrobun-webkit-app-region-no-drag">
									{showingAddress ? <Spinner size="xs" /> : <FaEye />}
									{showingAddress ? uiText("Confirm on KeepKey…") : uiText("Show on KeepKey")}
								</Button>
								{verifiedAddress === address && <Text mt="2" fontSize="12px" color="var(--teal)" role="status">{uiText("Address confirmed on emulator.")}</Text>}
								{wallet.emulatorReady === false && <Text mt="2" fontSize="12px" color="var(--text-2)">{uiText("Start the emulator to verify this address.")}</Text>}
								{actionError && <Text mt="2" fontSize="12px" color="var(--rose)" role="alert">{actionError}</Text>}
							</Box>
						</Box>
					</Box>

					<Box border="1px solid var(--line)" borderRadius="18px" bg="var(--ink-2)" p={{ base: "5", md: "6" }}>
						<Text fontSize="15px" color="var(--text-0)" fontWeight="500" mb="4">{uiText("Transactions")}</Text>
						{wallet.transactions.length === 0 ? (
							<Text fontSize="13px" color="var(--text-2)" py="3">{monitorReady ? uiText("No incoming transactions yet.") : uiText("Transactions will appear as the wallet syncs.")}</Text>
						) : wallet.transactions.map((tx, index) => (
							<Flex key={tx.txid} justify="space-between" align="center" gap="4" py="4" borderTop={index ? "1px solid var(--line)" : undefined} flexWrap="wrap">
								<Box minW="0">
									<Text fontSize="13px" color="var(--text-0)">{tx.type === "pool" ? uiText("Incoming · Pending") : uiText("Received XMR")}</Text>
									<Text fontSize="11px" fontFamily="mono" color="var(--text-3)" mt="1" title={tx.txid}>{tx.txid.slice(0, 12)}…{tx.txid.slice(-12)}</Text>
									<Text fontSize="11px" color="var(--text-2)" mt="1">{tx.confirmations.toLocaleString()} {tx.confirmations === 1 ? uiText("confirmation") : uiText("confirmations")} · {tx.locked ? uiText("Locked") : uiText("Unlocked")}</Text>
								</Box>
								<Text fontSize="13px" fontFamily="mono" color="var(--teal)" overflowWrap="anywhere">{privateModeEnabled ? "••••••" : `+${formatXmr(atomicAmount(tx.amountAtomic))}`} XMR</Text>
							</Flex>
						))}
					</Box>
				</>
			) : !refreshing ? (
                <Box textAlign="center" py="6">
                    <Text fontSize="14px" color="var(--text-1)" mb="3">{uiText("Connect your Monero wallet")}</Text>
                    <Text fontSize="13px" color="var(--text-2)" mb="5">{uiText("Confirm view-key access on KeepKey to scan incoming payments with the local Monero sidecar.")}</Text>
                    <Button disabled={connecting} onClick={async () => {
                        setConnecting(true); setActionError(null)
                        try { await rpcRequest("moneroConnect", {}, 180_000); await refresh() }
                        catch (error) { setActionError(error instanceof Error ? error.message : "Unable to connect Monero") }
                        finally { setConnecting(false) }
                    }}>{connecting ? uiText("Confirm on KeepKey…") : uiText("Connect Monero wallet")}</Button>
                    {actionError && <Text role="alert" color="var(--rose)" fontSize="13px" mt="3">{actionError}</Text>}
                </Box>
            ) : null}
		</Box>
	)
}
