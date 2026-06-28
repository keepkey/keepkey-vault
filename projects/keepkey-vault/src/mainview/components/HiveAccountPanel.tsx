import { useState, useEffect, useRef } from "react"
import { Box, Flex, Text, Button, Spinner, IconButton, Input } from "@chakra-ui/react"
import { FaCopy, FaCheck, FaTimes, FaChevronDown, FaChevronUp } from "react-icons/fa"
import { rpcRequest } from "../lib/rpc"

type RoleKeys = { owner: string; active: string; posting: string; memo: string }
type HiveAccount = { name: string; hive: string; hbd: string; hp?: string; rcPercent?: number }
type AccountResp = { noAccount?: boolean; account?: HiveAccount }

// Lightweight, dependency-free confetti burst.
function Confetti() {
	const pieces = Array.from({ length: 80 })
	const colors = ["#E31337", "#34D399", "#F5A33B", "#60A5FA", "#F472B6", "#FBBF24"]
	return (
		<Box position="absolute" inset="0" overflow="hidden" pointerEvents="none" zIndex={5}>
			{pieces.map((_, i) => {
				const left = Math.round((i * 137.5) % 100)
				const delay = (i % 10) * 0.06
				const dur = 1.6 + (i % 7) * 0.18
				const color = colors[i % colors.length]
				const size = 6 + (i % 3) * 3
				return (
					<Box key={i} position="absolute" top="-12px" left={`${left}%`}
						w={`${size}px`} h={`${size}px`} bg={color} borderRadius={i % 2 ? "1px" : "50%"}
						css={{ animation: `kkConfettiFall ${dur}s ${delay}s ease-in forwards` }} />
				)
			})}
			<style>{`@keyframes kkConfettiFall {
				0% { transform: translateY(-10px) rotate(0deg); opacity: 1 }
				100% { transform: translateY(620px) rotate(720deg); opacity: 0 } }`}</style>
		</Box>
	)
}
type Avail = { success: boolean; available: boolean; reason?: string }
type CreateResp = { status: number; success?: boolean; txid?: string; username?: string; error?: string; retryAfter?: number }

function KeyRow({ label, value }: { label: string; value: string }) {
	const [copied, setCopied] = useState(false)
	return (
		<Flex justify="space-between" align="center" py="1.5">
			<Text fontSize="11px" color="var(--text-3)" textTransform="uppercase" w="62px" flexShrink="0">{label}</Text>
			<Text fontSize="11px" fontFamily="mono" color="var(--text-2)" flex="1" mx="2" truncate>{value}</Text>
			<IconButton aria-label={`copy ${label} key`} size="xs" variant="ghost" flexShrink="0"
				onClick={() => { navigator.clipboard.writeText(value); setCopied(true); setTimeout(() => setCopied(false), 1200) }}>
				<Box as={copied ? FaCheck : FaCopy} fontSize="11px" color={copied ? "#34D399" : "var(--text-3)"} />
			</IconButton>
		</Flex>
	)
}

/**
 * Hive receive / onboarding panel. Hive is account-based (you receive to an
 * @username, not a key). Resolves the device's active key to an account via
 * Pioneer and shows account view, or the in-app sponsor onboarding wizard.
 */
export function HiveAccountPanel({ activeKey, color }: { activeKey: string | null; color: string }) {
	const [state, setState] = useState<"loading" | "has" | "none" | "error">("loading")
	const [account, setAccount] = useState<HiveAccount | null>(null)

	const refresh = () => {
		if (!activeKey) return
		setState("loading")
		rpcRequest<AccountResp>("hiveGetAccount", { pubkey: activeKey }, 15000)
			.then(r => { if (r.account) { setAccount(r.account); setState("has") } else setState("none") })
			.catch(() => setState("error"))
	}
	useEffect(() => { let c = false; if (activeKey) { rpcRequest<AccountResp>("hiveGetAccount", { pubkey: activeKey }, 15000).then(r => { if (c) return; if (r.account) { setAccount(r.account); setState("has") } else setState("none") }).catch(() => { if (!c) setState("error") }) } return () => { c = true } }, [activeKey])

	if (state === "loading") return <Flex justify="center" py="10"><Spinner color={color} /></Flex>

	if (state === "error") return (
		<Box className="v3-glass-card" p="4" mt="4">
			<Text fontSize="13px" color="var(--text-2)">Couldn't reach the Hive account service. Try again shortly.</Text>
			<Button mt="3" size="sm" variant="outline" onClick={refresh}>Retry</Button>
		</Box>
	)

	if (state === "has" && account) return (
		<Box className="v3-glass-card" p="4" mt="4">
			<Text fontSize="11px" color="var(--text-3)" textTransform="uppercase" letterSpacing="0.18em">Hive Account</Text>
			<Text fontSize="22px" fontWeight="700" color="var(--text-0)" mt="1">@{account.name}</Text>
			<Flex gap="6" mt="3" wrap="wrap">
				<Box><Text fontSize="11px" color="var(--text-3)">HIVE</Text><Text fontSize="14px" fontFamily="mono" color="var(--text-1)">{account.hive}</Text></Box>
				<Box><Text fontSize="11px" color="var(--text-3)">HBD</Text><Text fontSize="14px" fontFamily="mono" color="var(--text-1)">{account.hbd}</Text></Box>
				{account.hp != null && <Box><Text fontSize="11px" color="var(--text-3)">HP</Text><Text fontSize="14px" fontFamily="mono" color="var(--text-1)">{account.hp}</Text></Box>}
				{account.rcPercent != null && <Box><Text fontSize="11px" color="var(--text-3)">RC</Text><Text fontSize="14px" fontFamily="mono" color="var(--text-1)">{account.rcPercent}%</Text></Box>}
			</Flex>
		</Box>
	)

	return <HiveOnboardWizard color={color} onCreated={refresh} />
}

function HiveOnboardWizard({ color, onCreated }: { color: string; onCreated: () => void }) {
	const [keys, setKeys] = useState<RoleKeys | null>(null)
	const [showKeys, setShowKeys] = useState(false)
	const [username, setUsername] = useState("")
	const [avail, setAvail] = useState<Avail | null>(null)
	const [checking, setChecking] = useState(false)
	const [creating, setCreating] = useState(false)
	const [error, setError] = useState<string | null>(null)
	const [needsFunding, setNeedsFunding] = useState<string | null>(null) // 0x ETH address to fund, or null
	const [created, setCreated] = useState<{ name: string; txid?: string } | null>(null)
	const debounce = useRef<ReturnType<typeof setTimeout> | null>(null)

	useEffect(() => { rpcRequest<RoleKeys>("hiveGetRoleKeys", {}, 30000).then(setKeys).catch(() => {}) }, [])

	// Debounced availability check as the user types.
	useEffect(() => {
		setAvail(null); setError(null)
		if (debounce.current) clearTimeout(debounce.current)
		const name = username.trim().toLowerCase()
		if (!name) return
		setChecking(true)
		debounce.current = setTimeout(() => {
			rpcRequest<Avail>("hiveUsernameAvailable", { name }, 10000)
				.then(r => setAvail(r)).catch(() => setAvail(null)).finally(() => setChecking(false))
		}, 400)
		return () => { if (debounce.current) clearTimeout(debounce.current) }
	}, [username])

	const create = async () => {
		const name = username.trim().toLowerCase()
		if (!name || !avail?.available || creating) return
		setCreating(true); setError(null); setNeedsFunding(null)
		try {
			const r = await rpcRequest<CreateResp>("hiveCreateAccount", { username: name }, 120000)
			if (r.status === 200 && (r.success || r.txid)) {
				setCreated({ name, txid: r.txid })
				// Account is on-chain; the pubkey→account lookup may lag a block. Refresh
				// the parent (account view) after a short beat while we celebrate.
				setTimeout(() => onCreated(), 4500)
				return
			}
			// 403: ETH gate — the device's ETH address must hold mainnet ETH (one
			// sponsored account per funded address). Show a dedicated fund-me screen.
			if (r.status === 403) {
				rpcRequest<{ addresses: { addressIndex: number; address: string }[] }>("getEvmAddresses", undefined, 10000)
					.then(s => setNeedsFunding(s.addresses.find(a => a.addressIndex === 0)?.address ?? ""))
					.catch(() => setNeedsFunding(""))
			}
			// 409 is overloaded: either the username was just taken, or this ETH
			// address already claimed its one sponsored account. Server error text
			// disambiguates; reformat-fail back to name-taken.
			else if (r.status === 409) {
				if (/eth|address/i.test(r.error ?? "")) setError("This device already has a sponsored Hive account.")
				else { setError("That name was just taken — pick another."); setAvail({ success: true, available: false, reason: "taken" }) }
			}
			else if (r.status === 401) setError("Device confirmation didn't verify. Try again.")
			else if (r.status === 503) setError(`Sponsor is busy. Try again in ${r.retryAfter ?? 60}s.`)
			else if (r.status === 400) setError("Request rejected (invalid). This is a client bug — don't retry.")
			else setError(r.error || "Account creation failed. Try again later.")
		} catch {
			setError("Account creation failed — device or network error.")
		} finally { setCreating(false) }
	}

	const name = username.trim().toLowerCase()
	const canCreate = !!name && avail?.available === true && !creating

	if (needsFunding !== null) return (
		<Box className="v3-glass-card" p="5" mt="4">
			<Text fontSize="15px" fontWeight="700" color="var(--text-0)">Fund your ETH address first</Text>
			<Text fontSize="12px" color="var(--text-2)" mt="2" lineHeight="1.55">
				Sponsored Hive accounts are free, but each one needs a funded Ethereum address so the
				service can't be drained. Send <b>any</b> amount of mainnet ETH to your KeepKey ETH
				address below, then retry. One sponsored account per ETH address.
			</Text>
			{needsFunding ? (
				<Flex mt="3" p="3" borderRadius="md" bg="var(--surface-1)" align="center" gap="2">
					<Text fontSize="12px" fontFamily="mono" color="var(--text-1)" flex="1" truncate>{needsFunding}</Text>
					<IconButton aria-label="copy ETH address" size="xs" variant="ghost"
						onClick={() => navigator.clipboard.writeText(needsFunding)}>
						<Box as={FaCopy} fontSize="12px" color="var(--text-3)" />
					</IconButton>
				</Flex>
			) : <Text fontSize="11px" color="var(--text-3)" mt="3">Open the Ethereum asset to view your receive address.</Text>}
			<Button mt="4" w="100%" bg={color} color="white" _hover={{ filter: "brightness(1.1)" }}
				onClick={() => setNeedsFunding(null)}>
				I've funded it — retry
			</Button>
		</Box>
	)

	if (created) return (
		<Box className="v3-glass-card" p="6" mt="4" position="relative" overflow="hidden" textAlign="center">
			<Confetti />
			<Text fontSize="40px" lineHeight="1">🎉</Text>
			<Text fontSize="18px" fontWeight="700" color="var(--text-0)" mt="2">Account created!</Text>
			<Text fontSize="24px" fontWeight="700" color={color} mt="1">@{created.name}</Text>
			<Text fontSize="12px" color="var(--text-2)" mt="2" lineHeight="1.5">
				Secured by KeepKey — sponsored by @keepkey, no fee. Loading your account…
			</Text>
			{created.txid && (
				<Text fontSize="10px" fontFamily="mono" color="var(--text-3)" mt="2" truncate cursor="pointer"
					onClick={() => rpcRequest("openUrl", { url: `https://hiveblocks.com/tx/${created.txid}` }).catch(() => {})}>
					tx {created.txid.slice(0, 16)}…
				</Text>
			)}
			<Button mt="3" size="sm" bg={color} color="white" _hover={{ filter: "brightness(1.1)" }} onClick={onCreated}>
				View account
			</Button>
		</Box>
	)

	return (
		<Box className="v3-glass-card" p="4" mt="4">
			<Text fontSize="15px" fontWeight="700" color="var(--text-0)">Create your Hive account</Text>
			<Text fontSize="12px" color="var(--text-2)" mt="1.5" lineHeight="1.55">
				Hive funds go to a <b>username</b>, not a key. KeepKey sponsors the on-chain creation — you pay nothing
				and your keys never leave the device. Pick a name and confirm on your device.
			</Text>

			<Box mt="3" position="relative">
				<Input value={username} onChange={e => setUsername(e.target.value)} placeholder="username"
					autoCapitalize="none" autoCorrect="off" spellCheck={false}
					bg="var(--surface-1)" border="1px solid" borderColor="var(--border)" fontSize="14px" pr="9" />
				<Box position="absolute" right="3" top="50%" transform="translateY(-50%)">
					{checking ? <Spinner size="xs" color={color} />
						: avail?.available ? <Box as={FaCheck} color="#34D399" fontSize="13px" />
						: avail && !avail.available ? <Box as={FaTimes} color="#F87171" fontSize="13px" /> : null}
				</Box>
			</Box>
			{avail && !avail.available && avail.reason && (
				<Text fontSize="11px" color="#F87171" mt="1.5">{avail.reason}</Text>
			)}
			{avail?.available && <Text fontSize="11px" color="#34D399" mt="1.5">@{name} is available</Text>}

			<Button mt="3" w="100%" bg={color} color="white" _hover={{ filter: "brightness(1.1)" }}
				disabled={!canCreate} opacity={canCreate ? 1 : 0.5} onClick={create}>
				{creating ? <><Spinner size="sm" mr="2" /> Confirm on your device…</> : "Create account"}
			</Button>
			{error && <Text fontSize="11px" color="#F87171" mt="2" textAlign="center">{error}</Text>}

			<Flex mt="3" align="center" gap="1.5" cursor="pointer" onClick={() => setShowKeys(s => !s)}>
				<Box as={showKeys ? FaChevronUp : FaChevronDown} fontSize="9px" color="var(--text-3)" />
				<Text fontSize="11px" color="var(--text-3)">Device keys for this account</Text>
			</Flex>
			{showKeys && (
				<Box mt="2" p="3" borderRadius="md" bg="var(--surface-1)">
					{keys ? (<>
						<KeyRow label="owner" value={keys.owner} />
						<KeyRow label="active" value={keys.active} />
						<KeyRow label="posting" value={keys.posting} />
						<KeyRow label="memo" value={keys.memo} />
					</>) : <Flex justify="center" py="3"><Spinner size="sm" color={color} /></Flex>}
				</Box>
			)}
		</Box>
	)
}
