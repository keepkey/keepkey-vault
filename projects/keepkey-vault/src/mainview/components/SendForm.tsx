import { useUiTranslation } from "../i18n/ui"
import { addressBookLabel } from "../lib/addressbook-label"
import { useState, useEffect, useCallback, useMemo, useRef, Fragment } from "react"
import { useTranslation } from "react-i18next"
import { Box, Flex, Text, VStack, Button, Input, Spinner } from "@chakra-ui/react"
import { rpcRequest } from "../lib/rpc"
import { playSent } from "../lib/sounds"
import { formatBalance } from "../lib/formatting"
import { describeSigningError } from "../lib/signing-errors"
import { cancelDeviceSigning, signOnDevice } from "../lib/device-signing"
import { useFiat } from "../lib/fiat-context"
import { getAsset } from "../../shared/assetLookup"
import { QrScannerOverlay } from "./QrScannerOverlay"
import { AddressBookPicker } from "./AddressBookPicker"
import { isTransparentZcashRecipient } from "../lib/zcash-send-recipients"
import { AddressIdenticon } from "./AddressIdenticon"
import { SaveRecipientDialog } from "./SaveRecipientDialog"
import { DocsLink } from "./DocsLink"
import { DOCS_LINKS, watch } from "../../shared/docs-links"
import { caipToNetworkId, isTokenCaip } from "../../shared/chains"
import type { ChainDef } from "../../shared/chains"
import type { ChainBalance, TokenBalance, BuildTxResult, BroadcastResult, AddressBookEntry } from "../../shared/types"
import { validateAddress, isBurnAddress, knownTokenContract, sameAddress as isSameAddress } from "../../shared/address-validation"
import { balanceUnverifiedReason, isBalanceUnverified } from "../../shared/balance-display-state"
import { normalizeAmountInput, usdToCryptoAmount } from '../../shared/locale'
import { baseUnitsToDecimalString } from '../../shared/max-send'
import { describeGasPriceError, networkGasPriceGwei } from '../../shared/gas-price-errors'
import { feeFiatLabel, feeUsdFromNative } from '../../shared/fee-fiat'
import { describeDustError } from '../../shared/utxo-dust-errors'
import { describeBalanceError } from '../../shared/send-balance-errors'
import { amountPlusFeeExceedsBalance, cosmosDisplayFee, cosmosSendFee } from '../../shared/cosmos-fee'
import { getNumberLocale } from '../lib/number-locale'
import { useZcashNu7Support } from '../hooks/useZcashNu7Support'
import { ZCASH_NU7_UNSUPPORTED_MESSAGE } from '../../shared/zcash-nu7'
import { parseSendQrResult } from '../../shared/send-qr'

type SendPhase = 'input' | 'built' | 'signed' | 'broadcast'

interface SigningContext {
	requestKey: string
	chainId: string
	signMethod: string
	recipient: string
	amount: string
	isMax: boolean
	isTokenSend: boolean
	displaySymbol: string
	displayBalance: string
	activeCaip: string
	address: string | null
}


// ── Confetti ────────────────────────────────────────────────────────────────
const CONFETTI_COLORS = ['#8be3c4', '#e9c46a', '#a8efd2', '#9f8ce0', '#e08c7b', '#f2d27e']
const confettiPieces = Array.from({ length: 40 }, (_, i) => ({
  id: i,
  color: CONFETTI_COLORS[i % CONFETTI_COLORS.length],
  left: `${Math.random() * 100}%`,
  delay: `${Math.random() * 2}s`,
  duration: `${2.5 + Math.random() * 2}s`,
}))

const CONFETTI_CSS = `
  @keyframes kkSendConfetti {
    0%   { transform: translateY(-20px) rotate(0deg); opacity: 1; }
    100% { transform: translateY(300px) rotate(720deg); opacity: 0; }
  }
`

// Nudges the swap arrows on hover so the converted-amount pill reads as a
// tappable unit toggle (USD ⇄ native) rather than static helper text.
const AMOUNT_FLIP_CSS = `
  @keyframes kkAmountFlipNudge {
    0%, 100% { transform: translateY(0) rotate(0deg); }
    30%      { transform: translateY(-2px) rotate(-10deg); }
    65%      { transform: translateY(1px) rotate(10deg); }
  }
  .kk-amount-flip:hover .kk-amount-flip-icon {
    animation: kkAmountFlipNudge 0.5s ease-in-out;
  }
`

interface SendFormProps {
	chain: ChainDef
	address: string | null
	balance?: ChainBalance
	/** A balance lookup is pending; retain known amounts while it refreshes. */
	balanceLoading?: boolean
	token?: TokenBalance | null
	onClearToken?: () => void
	xpubOverride?: string         // BTC multi-account: use this xpub for buildTx
	scriptTypeOverride?: string   // BTC multi-account: use this scriptType for buildTx
	evmAddressIndex?: number      // EVM multi-address: derivation index for buildTx
}

export function SendForm({ chain, address, balance, balanceLoading = false, token, onClearToken, xpubOverride, scriptTypeOverride, evmAddressIndex }: SendFormProps) {
  const uiText = useUiTranslation()

	const { t, i18n } = useTranslation("send")
	const { fmt, fmtCompact, locale } = useFiat()
	const [recipientState, setRecipientState] = useState({ value: '', revision: 0 })
	const recipient = recipientState.value
	// A fresh edit or scan retires old confirmations, even when it returns to an
	// earlier recipient or fills the same address again.
	const setRecipient = useCallback((value: string) => {
		setRecipientState(previous => ({ value, revision: previous.revision + 1 }))
	}, [])
	const [amount, setAmount] = useState("")
	const [usdAmount, setUsdAmount] = useState("")
	const [inputMode, setInputMode] = useState<'crypto' | 'usd'>('crypto')
	const [memo, setMemo] = useState("")
	const [isMax, setIsMax] = useState(false)
	const [feeLevel, setFeeLevel] = useState(3) // preset buttons send 1=slow / 3=normal(avg) / 10=fast
	const [feeMode, setFeeMode] = useState<'preset' | 'custom'>('preset')
	const [customGasPrice, setCustomGasPrice] = useState("")     // EVM gas price (gwei)
	const [customGasLimit, setCustomGasLimit] = useState("")     // EVM gas limit (units, optional)
	const [customSatPerVByte, setCustomSatPerVByte] = useState("") // UTXO fee rate (sat/vByte)
	const [networkGasPrice, setNetworkGasPrice] = useState<string | null>(null) // gwei quote shown in Custom

	const [phase, setPhase] = useState<SendPhase>('input')
	const [loading, setLoading] = useState(false)
	const [error, setError] = useState<string | null>(null)

	const [buildResult, setBuildResult] = useState<BuildTxResult | null>(null)
	const [signingContext, setSigningContext] = useState<SigningContext | null>(null)
	const [signedTx, setSignedTx] = useState<any>(null)
	const [txid, setTxid] = useState<string | null>(null)
	const [copied, setCopied] = useState(false)
	const [showPayload, setShowPayload] = useState(false)
	const [showScanner, setShowScanner] = useState(false)
	const [showAddressBook, setShowAddressBook] = useState(false)
	// R5 form-fill detection: as the recipient is entered, match it against the book.
	const [matchedContact, setMatchedContact] = useState<AddressBookEntry | null>(null)
	const [vaultDestinationError, setVaultDestinationError] = useState('')
	const [checkingVaultDestination, setCheckingVaultDestination] = useState(false)
	const [destinationVerifiedFor, setDestinationVerifiedFor] = useState<string | null>(null)
	const [vaultDestinationRetry, setVaultDestinationRetry] = useState(0)
	const [addressIsNew, setAddressIsNew] = useState(false)
	const [showSaveDialog, setShowSaveDialog] = useState(false)
	// Address we've already auto-prompted to save, so the dialog doesn't re-pop.
	const promptedAddressRef = useRef<string | null>(null)

	// Reset form when token selection changes
	const tokenCaip = token?.caip ?? null
	// Balances/prices can update without changing the send. Only actual owner,
	// asset and input changes retire work already awaiting an RPC response.
	const owner = xpubOverride || address || ''
	const zcashSupport = useZcashNu7Support(chain.id === 'zcash', JSON.stringify([chain.id, chain.networkId, owner]))
	// The owner hook can be pending/empty while its default index is zero.
	// Only the matching device-derived address makes that EVM sender usable.
	const senderReady = chain.chainFamily !== 'evm' || !!address
	const requestKey = JSON.stringify([chain.id, chain.signMethod, tokenCaip,
		chain.chainFamily === 'evm' ? owner.toLowerCase() : owner,
		scriptTypeOverride, evmAddressIndex, recipient, recipientState.revision, amount, usdAmount, inputMode,
		memo, isMax, feeLevel, feeMode, customGasPrice, customGasLimit, customSatPerVByte, zcashSupport.sessionEpoch])
	const requestKeyRef = useRef(requestKey)
	const operationGeneration = useRef(0)
	// Set synchronously: a second Broadcast click before React commits `disabled` is ignored (V12).
	const broadcasting = useRef(false)
	const mounted = useRef(true)
	if (requestKeyRef.current !== requestKey) {
		requestKeyRef.current = requestKey
		operationGeneration.current++
	}
	useEffect(() => {
		mounted.current = true
		return () => { mounted.current = false; operationGeneration.current++ }
	}, [])
	const operationIsCurrent = (generation: number) => mounted.current && generation === operationGeneration.current
	useEffect(() => {
		setPhase('input')
		setBuildResult(null)
		setSigningContext(null)
		setSignedTx(null)
		setTxid(null)
		setError(null)
		setLoading(false)
	}, [requestKey])
	// Hide retired review controls during the render before effects clear them.
	const currentSigningContext = signingContext?.requestKey === requestKey ? signingContext : null
	const visiblePhase = phase === 'input' || currentSigningContext ? phase : 'input'
	useEffect(() => {
		setPhase('input')
		setBuildResult(null)
		setSignedTx(null)
		setTxid(null)
		setError(null)
		setRecipient("")
		setAmount("")
		setUsdAmount("")
		setMemo("")
		setIsMax(false)
		setMatchedContact(null)
		setVaultDestinationError('')
		setCheckingVaultDestination(false)
		setAddressIsNew(false)
		setShowSaveDialog(false)
		promptedAddressRef.current = null
		setShowAddressBook(false)
	}, [tokenCaip])

	// Reset fee selection back to presets when the chain family OR the selected asset
	// changes, so a custom fee doesn't leak across a chain switch or a token<->native
	// (or token A->B) toggle on the same chain — both would otherwise reuse a stale
	// gas limit / rate and mis-compute the MAX gas reserve.
	useEffect(() => {
		setFeeMode('preset')
		setFeeLevel(3) // default every send to Normal
		setCustomGasPrice("")
		setCustomGasLimit("")
		setCustomSatPerVByte("")
	}, [chain.chainFamily, tokenCaip])

	// Custom EVM gas: show the network's own price, which an empty field also uses.
	useEffect(() => {
		setNetworkGasPrice(null)
		if (feeMode !== 'custom' || chain.chainFamily !== 'evm') return
		let alive = true
		rpcRequest<{ gasPrice?: unknown }>('getFees', { chainId: chain.id }, 15000)
			.then(r => { if (alive) setNetworkGasPrice(networkGasPriceGwei(r?.gasPrice)) })
			.catch(() => { /* placeholder stays "auto"; the builder still checks the price */ })
		return () => { alive = false }
	}, [feeMode, chain.id, chain.chainFamily])

	// Derived display values — token mode vs native mode
	const isTokenSend = !!token && isTokenCaip(token.caip)
	const displaySymbol = isTokenSend ? token!.symbol : chain.symbol
	const displayBalance = isTokenSend ? token!.balance : (balance?.balance || '0')
	// No entry, or the chain's fetch failed: `displayBalance` is a placeholder
	// zero, not a figure. Every readout below has to say "we don't know" rather
	// than "you have none" — the second is a claim we cannot back.
	// A selected token always carries its last-known amount: show it. Max reads it
	// fresh when the tx is built (txbuilder/evm.ts).
	const activeAssetUnverified = !isTokenSend && isBalanceUnverified(balance, chain.caip)
	// Confidence in the chain's NATIVE balance — a separate question, because
	// the gas warning below is about the coin that pays the fee, not the asset
	// being sent. A directly-confirmed token cleared the shared flag and let the
	// warning judge a SOL balance that was still a placeholder zero.
	const nativeBalanceUnverified = isBalanceUnverified(balance, chain.caip)
	// "Could not reach this chain" is only true when the refresh said so; no entry = not loaded yet.
	const unverifiedTitle = balanceUnverifiedReason(balance, chain.caip) === 'missing'
		? `${chain.coin} balance has not loaded yet`
		: `${chain.coin} balance unavailable — the last refresh could not reach this chain`
	// Fee controls: presets where a builder honors feeLevel; free-form custom only where
	// the builder accepts an exact rate (EVM gas price/limit, UTXO sat/vByte).
	const supportsFeePresets = chain.chainFamily === 'utxo' || chain.chainFamily === 'evm' || chain.chainFamily === 'cosmos'
	const supportsCustomFee = chain.chainFamily === 'evm' || chain.chainFamily === 'utxo'
	// The CAIP the Address Book picker filters by (token caip for token sends, else native).
	const activeCaip = isTokenSend && token?.caip ? token.caip : chain.caip

	// Basic client-side validation
	const canonicalAmount = normalizeAmountInput(amount, locale, i18n.language)
	const amountNum = canonicalAmount === null ? NaN : Number(canonicalAmount)
	const enteredAmount = inputMode === 'usd' ? usdAmount : amount
	const invalidAmountInput = !isMax && enteredAmount !== '' && normalizeAmountInput(enteredAmount, locale, i18n.language) === null
	const balanceNum = parseFloat(displayBalance)
	// EVM: the builder re-reads the balance at send and refuses only if the amount
	// is more than that fresh figure; the cached figure on screen never blocks.
	const exceedsBalance = chain.chainFamily !== 'evm' && !isMax && !isNaN(amountNum) && amountNum > 0 && balanceNum > 0 && amountNum > balanceNum
	// A Cosmos fee is fixed per chain and fee level, so the form can already say that
	// amount + fee is over the balance while it is typed (KEEPKEY-177). A warning only:
	// the builder decides on the live spendable balance. Elsewhere the fee comes from the build.
	const cosmosFee = chain.chainFamily === 'cosmos' && !isTokenSend ? cosmosDisplayFee(chain.id, chain.decimals, cosmosSendFee(chain.id, feeLevel)) : null
	const exceedsBalanceWithFee = !exceedsBalance && cosmosFee !== null && !isMax && canonicalAmount !== null && amountNum > 0 && balanceNum > 0
		&& amountPlusFeeExceedsBalance(canonicalAmount, cosmosFee, displayBalance, chain.decimals)

	// Derive per-unit USD price from available balance data
	// NOTE: balance.balanceUsd includes token USD — use nativeBalanceUsd for native price
	const pricePerUnit = useMemo(() => {
		if (isTokenSend && token?.priceUsd) return token.priceUsd
		if (!isTokenSend && balance?.balance) {
			const bal = parseFloat(balance.balance)
			if (bal <= 0) return 0
			const nativeUsd = balance.nativeBalanceUsd ?? balance.balanceUsd ?? 0
			return nativeUsd > 0 ? nativeUsd / bal : 0
		}
		return 0
	}, [isTokenSend, token?.priceUsd, balance?.nativeBalanceUsd, balance?.balanceUsd, balance?.balance])

	const hasPrice = pricePerUnit > 0

	// Bidirectional conversion: crypto → USD
	const handleCryptoChange = useCallback((v: string) => {
		setIsMax(false)
		const canonical = normalizeAmountInput(v, locale, i18n.language)
		setAmount(canonical ?? v)
		if (hasPrice && v) {
			const n = canonical === null ? NaN : Number(canonical)
			if (!isNaN(n)) setUsdAmount((n * pricePerUnit).toFixed(2))
			else setUsdAmount("")
		} else {
			setUsdAmount("")
		}
	}, [hasPrice, pricePerUnit, locale, i18n.language])

	// Bidirectional conversion: USD → crypto
	const handleUsdChange = useCallback((v: string) => {
		setIsMax(false)
		const canonical = normalizeAmountInput(v, locale, i18n.language)
		setUsdAmount(canonical ?? v)
		if (hasPrice && v) {
			const decimals = (isTokenSend ? token?.decimals : chain.decimals) ?? 8
			setAmount(canonical === null ? '' : usdToCryptoAmount(canonical, pricePerUnit, decimals))
		} else {
			setAmount("")
		}
	}, [hasPrice, pricePerUnit, locale, i18n.language, isTokenSend, token?.decimals, chain.decimals])

	// Swap input mode
	const toggleInputMode = useCallback(() => {
		setInputMode(prev => prev === 'crypto' ? 'usd' : 'crypto')
	}, [])

	// USD equivalent of current amount for display
	const amountUsdPreview = useMemo(() => {
		if (!hasPrice || isMax) return null
		const n = canonicalAmount === null ? NaN : Number(canonicalAmount)
		if (isNaN(n) || n <= 0) return null
		return n * pricePerUnit
	}, [canonicalAmount, hasPrice, pricePerUnit, isMax])

	// MAX: the amount actually sent, read from the built transaction (Bitcoin-style
	// recipient output, EVM value or ERC-20 transfer amount), so the review matches
	// what the device shows.
	const maxSentAmount = useMemo(() => {
		if (!isMax) return null
		const tx = buildResult?.unsignedTx
		if (chain.chainFamily === 'utxo') {
			const out = tx?.outputs?.find((o: any) => o.addressType === 'spend' && isSameAddress(o.address, recipient, chain))
			if (!out || !/^\d+$/.test(String(out.amount))) return null
			const [whole, fraction = ''] = baseUnitsToDecimalString(BigInt(out.amount), chain.decimals).split('.')
			return chain.decimals > 0 ? `${whole}.${fraction.padEnd(chain.decimals, '0')}` : whole
		}
		if (chain.chainFamily !== 'evm' || !tx) return null
		try {
			if (!isTokenSend) return tx.value ? baseUnitsToDecimalString(BigInt(tx.value), chain.decimals) : null
			const data = String(tx.data || '')
			return /^0xa9059cbb[0-9a-f]{128}$/i.test(data) && token?.decimals != null
				? baseUnitsToDecimalString(BigInt('0x' + data.slice(74)), token.decimals) : null
		} catch { return null }
	}, [isMax, chain, buildResult, recipient, isTokenSend, token?.decimals])

	const addressValidation = useMemo(() => {
		if (!recipient) return null
		return validateAddress(recipient, chain)
	}, [recipient, chain])

	// R5: instantly detect whether the recipient is a known contact/own wallet (show
	// its logo) or a new external address (offer to save). Debounced; clears on every
	// edit so we never show stale info while the next lookup resolves.
	const addressValid = addressValidation?.valid === true
	const destinationKey = JSON.stringify([activeCaip, owner, recipient.trim(), vaultDestinationRetry])
	const destinationReady = !addressValid || destinationVerifiedFor === destinationKey
	// The shared matcher recognizes equivalent validated address encodings.
	const sameAddress = useCallback((a: string, b: string | null | undefined) => isSameAddress(a, b, chain), [chain])
	const isSelfSend = addressValid && sameAddress(recipient.trim(), address)
	const confirmationIdentity = JSON.stringify([chain.id, chain.networkId, activeCaip, owner, address,
		scriptTypeOverride, evmAddressIndex, zcashSupport.sessionEpoch])
	const confirmationIdentityRef = useRef({ key: confirmationIdentity, revision: 0 })
	if (confirmationIdentityRef.current.key !== confirmationIdentity) {
		confirmationIdentityRef.current = { key: confirmationIdentity, revision: confirmationIdentityRef.current.revision + 1 }
	}
	const confirmationKey = JSON.stringify([confirmationIdentity, confirmationIdentityRef.current.revision, recipient, recipientState.revision])
	const [selfSendConfirmedFor, setSelfSendConfirmedFor] = useState<string | null>(null)
	const selfSendConfirmed = selfSendConfirmedFor === confirmationKey
	// Read by the recipient-lookup effect without adding to its dependency list.
	const isOwnSendingAddressRef = useRef((a: string) => sameAddress(a, address))
	isOwnSendingAddressRef.current = (a: string) => sameAddress(a, address)
	// Zero/burn and token-contract recipients: funds sent there are lost. The token's
	// own contract is refused outright; the others need an explicit acknowledgement.
	const recipientRisk = useMemo(() => {
		if (!addressValid) return null
		const addr = recipient.trim()
		if (isBurnAddress(addr)) return { kind: 'burn' as const }
		if (chain.chainFamily !== 'evm') return null
		const sentContract = isTokenSend ? (token?.contractAddress || token?.caip.split(':').pop() || '') : ''
		if (sentContract.toLowerCase() === addr.toLowerCase()) return { kind: 'sentToken' as const }
		const known = knownTokenContract(addr, chain)
		return known ? { kind: 'tokenContract' as const, token: known.symbol } : null
	}, [addressValid, recipient, chain, isTokenSend, token?.contractAddress, token?.caip])
	const recipientNeedsAck = recipientRisk?.kind === 'burn' || recipientRisk?.kind === 'tokenContract'
	const [riskConfirmedFor, setRiskConfirmedFor] = useState<string | null>(null)
	const riskConfirmed = riskConfirmedFor === confirmationKey
	const [recipientIsContract, setRecipientIsContract] = useState(false)
	const evmChainId = chain.chainFamily === 'evm' ? chain.id : null
	useEffect(() => {
		setMatchedContact(null)
		setAddressIsNew(false)
		setRecipientIsContract(false)
		setVaultDestinationError('')
		setCheckingVaultDestination(false)
		setDestinationVerifiedFor(null)
		const addr = recipient.trim()
		if (!addr || !addressValid) return
		setCheckingVaultDestination(true)
		let alive = true
		const networkId = caipToNetworkId(activeCaip)
		const handle = setTimeout(() => {
			rpcRequest('checkVaultDestination', { networkId, address: addr, assetCaip: activeCaip }, 60000)
				.then(() => {
					if (alive) setDestinationVerifiedFor(destinationKey)
					return rpcRequest<AddressBookEntry | null>("matchAddress", { networkId, address: addr }, 5000)
					.then(entry => {
						if (!alive) return
						if (entry) {
							setMatchedContact(entry)
						} else if (isOwnSendingAddressRef.current(addr)) {
							// Our own sending address is not a "new external address" to save.
						} else if (isBurnAddress(addr)) {
							// Never offer to save a burn address; the warning above covers it.
						} else {
							setAddressIsNew(true)
							// A contract is not necessarily a wallet: note it (best-effort, no verdict on failure).
							if (evmChainId) rpcRequest<boolean>('isEvmContract', { chainId: evmChainId, address: addr }, 15000)
								.then(isContract => { if (alive) setRecipientIsContract(isContract === true) })
								.catch(() => {})
							// Auto-prompt to save — once per distinct new address.
							if (promptedAddressRef.current !== addr) {
								promptedAddressRef.current = addr
								setShowSaveDialog(true)
							}
						}
					})
					.catch(() => { /* contact detection is best-effort; never block sending */ })
				})
				.catch(e => { if (alive) setVaultDestinationError(e.message || 'Could not verify vault destination') })
				.finally(() => { if (alive) setCheckingVaultDestination(false) })
		}, 300)
		return () => { alive = false; clearTimeout(handle) }
	}, [recipient, activeCaip, addressValid, vaultDestinationRetry, evmChainId, destinationKey])

	// Why Build is disabled, so a greyed-out button never looks like a dead click.
	const buildBlocker = !recipient ? t('buildNeedsRecipient')
		: isSelfSend && !selfSendConfirmed ? t('buildNeedsSelfSendConfirm')
		: recipientNeedsAck && !riskConfirmed ? t('buildNeedsRiskConfirm')
		: !amount && !isMax ? t('buildNeedsAmount') : null

	const handleBuild = useCallback(async () => {
		if (!senderReady || !zcashSupport.canSend()) return
		if ((isSelfSend && !selfSendConfirmed) || (recipientNeedsAck && !riskConfirmed) || recipientRisk?.kind === 'sentToken') return
		if (!recipient || (!amount && !isMax)) return
		if (isMax && balanceLoading && activeAssetUnverified) return
		if (!isMax && (invalidAmountInput || canonicalAmount === null || !Number.isFinite(amountNum) || amountNum <= 0)) {
			setError(t('invalidAmount', { defaultValue: 'Enter an ungrouped decimal amount, for example 1.5. Thousands separators are not accepted.' })); return
		}
		if (checkingVaultDestination || !destinationReady || vaultDestinationError) { setError(vaultDestinationError || 'Checking vault destination…'); return }
		if (addressValidation && !addressValidation.valid) { setError(t(addressValidation.error!)); return }
		if (exceedsBalance) { setError(t("exceedsBalanceShort")); return }
		const assetDecimals = isTokenSend ? token?.decimals : chain.decimals
		if (!isMax && canonicalAmount && assetDecimals != null && (canonicalAmount.split('.')[1]?.length ?? 0) > assetDecimals) {
			setError(t('tooManyDecimals', { symbol: displaySymbol, decimals: assetDecimals })); return
		}

		// Custom fee validation — only the field(s) relevant to this chain family.
		const useCustom = feeMode === 'custom' && supportsCustomFee
		const gasPrice = normalizeAmountInput(customGasPrice, locale, i18n.language)
		const satRate = normalizeAmountInput(customSatPerVByte, locale, i18n.language)
		if (useCustom && chain.chainFamily === 'evm') {
			const gwei = gasPrice === null ? NaN : Number(gasPrice)
			// Empty = the network quote shown as the placeholder.
			if (customGasPrice.trim() && (!isFinite(gwei) || gwei <= 0)) { setError(t("invalidGasPrice")); return }
			if (customGasLimit && (!/^\d+$/.test(customGasLimit.trim()) || parseInt(customGasLimit, 10) < 21000)) { setError(t("invalidGasLimit")); return }
		}
		if (useCustom && chain.chainFamily === 'utxo') {
			const rate = satRate === null ? NaN : Number(satRate)
			if (!customSatPerVByte || !isFinite(rate) || rate <= 0) { setError(t("invalidSatPerVByte")); return }
		}

		setLoading(true)
		setError(null)
		const generation = ++operationGeneration.current
		const context: SigningContext = {
			requestKey, chainId: chain.id, signMethod: chain.signMethod,
			recipient, amount: canonicalAmount ?? '', isMax, isTokenSend,
			displaySymbol, displayBalance, activeCaip, address,
		}

		try {
			const result = await rpcRequest<BuildTxResult>('buildTx', {
				chainId: chain.id,
				to: recipient.trim(),
				amount: isMax ? '0' : canonicalAmount!,
				memo: memo || undefined,
				// Custom EVM gas is checked against (and an empty field uses) the average quote.
				feeLevel: useCustom && chain.chainFamily === 'evm' ? 3 : feeLevel,
				isMax,
				caip: isTokenSend ? token!.caip : undefined,
				nativeBalance: !isTokenSend ? balance?.balance : undefined,
				tokenBalance: isTokenSend ? token!.balance : undefined,
				tokenDecimals: isTokenSend && token!.decimals != null ? token!.decimals : undefined,
				xpubOverride: xpubOverride || undefined,
				scriptTypeOverride: scriptTypeOverride || undefined,
				evmAddressIndex: evmAddressIndex,
				gasPriceGwei: useCustom && chain.chainFamily === 'evm' && customGasPrice.trim() ? gasPrice! : undefined,
				gasLimit: useCustom && chain.chainFamily === 'evm' && customGasLimit ? customGasLimit : undefined,
				satPerVByte: useCustom && chain.chainFamily === 'utxo' ? Number(satRate) : undefined,
			}, 60000)

			if (!operationIsCurrent(generation)) return
			setSigningContext(context)
			setBuildResult(result)
			setPhase('built')
		} catch (e: any) {
			if (operationIsCurrent(generation)) setError(describeGasPriceError(e.message || '', t) || describeDustError(e.message || '', t, getNumberLocale()) || describeBalanceError(e.message || '', t, getNumberLocale()) || e.message || t("failedToBuild"))
		} finally {
			if (operationIsCurrent(generation)) setLoading(false)
		}
	}, [chain, recipient, amount, canonicalAmount, amountNum, invalidAmountInput, locale, i18n.language, t, memo, feeLevel, feeMode, supportsCustomFee, customGasPrice, customGasLimit, customSatPerVByte, isMax, addressValidation, exceedsBalance, isTokenSend, token, balance?.balance, xpubOverride, scriptTypeOverride, evmAddressIndex, checkingVaultDestination, destinationReady, vaultDestinationError, requestKey, displaySymbol, displayBalance, activeCaip, address, balanceLoading, activeAssetUnverified, senderReady, zcashSupport.canSend, isSelfSend, selfSendConfirmed, recipientNeedsAck, riskConfirmed, recipientRisk?.kind])

	const handleSign = useCallback(async () => {
		if (!senderReady || !zcashSupport.canSend() || !buildResult || !currentSigningContext) return
		const context = currentSigningContext
		const generation = ++operationGeneration.current
		setLoading(true)
		setError(null)

		try {
			const result = await signOnDevice(context.signMethod, buildResult.unsignedTx, () => operationIsCurrent(generation))
			if (!operationIsCurrent(generation)) return
			setSignedTx(result)
			setPhase('signed')
		} catch (e: any) {
			if (operationIsCurrent(generation)) setError(describeSigningError(e, t))
		} finally {
			if (operationIsCurrent(generation)) setLoading(false)
		}
	}, [buildResult, currentSigningContext, t, senderReady, zcashSupport.canSend])

	const handleBroadcast = useCallback(async () => {
		if (!zcashSupport.canSend() || !signedTx || !currentSigningContext || broadcasting.current) return
		broadcasting.current = true
		const context = currentSigningContext
		const generation = ++operationGeneration.current
		setLoading(true)
		setError(null)

		// History needs a real amount even for MAX sends (BuildTxResult has none):
		// token MAX = full token balance; native MAX = balance − network fee.
		let sendAmount: string | undefined
		if (!context.isMax) {
			sendAmount = context.amount || undefined
		} else if (maxSentAmount) {
			sendAmount = maxSentAmount
		} else if (context.isTokenSend) {
			sendAmount = context.displayBalance || undefined
		} else {
			const net = parseFloat(context.displayBalance) - parseFloat(buildResult?.fee || '0')
			sendAmount = net > 0 ? String(net) : (context.displayBalance || undefined)
		}

		try {
			const result = await rpcRequest<BroadcastResult>('broadcastTx', {
				chainId: context.chainId,
				signedTx,
				to: context.recipient,
				amount: sendAmount,
				fee: buildResult?.fee,
				symbol: context.displaySymbol,
				caip: context.activeCaip,
				fromAddress: context.address || undefined,
			}, 60000)
			if (!operationIsCurrent(generation)) return
			setTxid(result.txid)
			setPhase('broadcast')
			playSent()
			// Balance resync + confirmation tracking are owned by the backend for every
			// broadcast source (in-app, REST, swap): broadcastTx → onActivityLogged.
		} catch (e: any) {
			if (operationIsCurrent(generation)) setError(e.message || t("broadcastFailed"))
		} finally {
			broadcasting.current = false
			if (operationIsCurrent(generation)) setLoading(false)
		}
	}, [signedTx, buildResult, currentSigningContext, maxSentAmount, t, zcashSupport.canSend])

	const edit = useCallback(() => {
		operationGeneration.current++
		setLoading(false)
		setPhase('input')
		setBuildResult(null)
		setSigningContext(null)
		setSignedTx(null)
		setError(null)
	}, [])

	const reset = useCallback(() => {
		operationGeneration.current++
		setLoading(false)
		setPhase('input')
		setBuildResult(null)
		setSigningContext(null)
		setSignedTx(null)
		setTxid(null)
		setError(null)
		setRecipient("")
		setAmount("")
		setUsdAmount("")
		setMemo("")
		setIsMax(false)
		setMatchedContact(null)
		setAddressIsNew(false)
		setShowSaveDialog(false)
		promptedAddressRef.current = null
		setShowAddressBook(false)
	}, [])

	const copyTxid = useCallback(() => {
		if (!txid) return
		navigator.clipboard.writeText(txid)
			.then(() => { setCopied(true); setTimeout(() => setCopied(false), 2000) })
			.catch(() => console.warn('[SendForm] Clipboard not available'))
	}, [txid])

	// Parse QR scan result — handles plain addresses and BIP-21 / EIP-681 URIs
	const handleQrScan = useCallback((data: string) => {
		setShowScanner(false)
		const result = parseSendQrResult(data, chain, isTokenSend)
		if (!result.ok) {
			setError(result.reason === 'unsupported' ? t('qrUnsupported') : result.reason === 'amount' ? t('qrBadAmount')
				: result.reason === 'network' ? t('qrWrongNetwork') : t('invalidAddress'))
			return
		}
		const parsed = result.payment
		setRecipient(parsed.recipient)
		// A label is not an on-chain memo; a new scan also clears a stale tag.
		setMemo(parsed.memo)
		if (parsed.amount !== undefined) {
			setInputMode('crypto')
			setAmount(parsed.amount)
			setIsMax(false)
			const usd = Number(parsed.amount) * pricePerUnit
			setUsdAmount(hasPrice && Number.isFinite(usd) ? usd.toFixed(2) : '')
		}
	}, [chain, isTokenSend, hasPrice, pricePerUnit, t])

	// Build explorer URL from assetData
	const explorerUrl = useMemo(() => {
		if (!txid) return null
		// EVM explorers expect 0x prefix; all others do not
		let normalizedTxid = chain.chainFamily === 'evm'
			? (txid.startsWith('0x') ? txid : '0x' + txid)
			: txid.replace(/^0x/i, '')
		// Tronscan URL routing is case-sensitive — keep the same posture as
		// shared/chains.ts:getExplorerTxUrl so TRON outbound txids (often emitted
		// uppercase by THORChain) produce a working tronscan link.
		if (chain.chainFamily === 'tron') normalizedTxid = normalizedTxid.toLowerCase()
		const caip = isTokenSend && token?.caip ? token.caip : chain.caip
		const asset = getAsset(caip)
		if (asset?.explorerTxLink) return asset.explorerTxLink.replace('{{txid}}', normalizedTxid)
		// Fallback: try the chain's native CAIP
		const chainAsset = getAsset(chain.caip)
		if (chainAsset?.explorerTxLink) return chainAsset.explorerTxLink.replace('{{txid}}', normalizedTxid)
		return null
	}, [txid, chain, token, isTokenSend])

	const truncatedTxid = useMemo(() => {
		if (!txid) return ''
		return txid
	}, [txid])

	const needsMemo = !isTokenSend && (chain.chainFamily === 'cosmos' || chain.chainFamily === 'xrp')

	// Fee > 25% of what is sent. Token amounts are in other units, so compare in USD
	// (only when both prices are known; never claim it without them).
	const reviewAmount = currentSigningContext?.isMax ? maxSentAmount : currentSigningContext?.amount
	const nativeUnitPrice = balance?.nativeBalanceUsd && parseFloat(balance.balance) > 0 ? balance.nativeBalanceUsd / parseFloat(balance.balance) : 0
	// The fee is paid in the native asset: priced with the same native price as the warning below.
	const feeLabelUsd = buildResult ? feeFiatLabel(feeUsdFromNative(buildResult.fee, nativeUnitPrice), fmtCompact) : ''
	const feeOverQuarter = !!buildResult && !!currentSigningContext && !!reviewAmount && (currentSigningContext.isTokenSend
		? nativeUnitPrice > 0 && (token?.priceUsd ?? 0) > 0 && Number(buildResult.fee) * nativeUnitPrice > Number(reviewAmount) * token!.priceUsd * 0.25
		: Number(buildResult.fee) > Number(reviewAmount) * 0.25)

	return (
		<VStack gap="4" align="stretch" py="2" px="2">
			<Flex justify="flex-end" gap="3">
				<DocsLink href={DOCS_LINKS.send} />
				<DocsLink href={watch('course-05-send')} label={uiText("Watch video")} />
			</Flex>
			{/* Token badge — shown when sending a token */}
			{isTokenSend && (
				<Flex align="center" justify="space-between" bg="rgba(233,196,106,0.06)" border="1px solid rgba(233,196,106,0.22)" px="3" py="2" borderRadius="999px">
					<Flex align="center" gap="2">
						<Text fontSize="xs" color="kk.gold" fontWeight="600">{t("sendingToken")}</Text>
						<Text fontSize="xs" fontWeight="600" color="kk.textPrimary">{token!.symbol}</Text>
						<Text fontSize="10px" color="kk.textMuted">{token!.name}</Text>
					</Flex>
					{onClearToken && (
						<Button size="xs" variant="ghost" color="kk.textMuted" _hover={{ color: "kk.textPrimary" }} onClick={onClearToken} px="1" minW="auto">{uiText("×")}</Button>
					)}
				</Flex>
			)}

			{/* Available balance — centered, borderless. The label sits as a
			    small overline above the number so the figure itself reads as the
			    focal point of the row instead of a labeled card. */}
			<Flex direction="column" align="center" gap="0.5" py="2">
				<Text fontSize="9px" color="kk.textMuted" letterSpacing="0.18em" textTransform="uppercase" fontFamily="mono">
					{t("available")}
				</Text>
				<Flex align="baseline" gap="2" css={{ fontVariantNumeric: "tabular-nums" }}>
					<Text
						fontSize={{ base: "18px", md: "22px" }}
						fontFamily="mono"
						fontWeight="600"
						color="kk.textPrimary"
						letterSpacing="-0.01em"
						title={balanceLoading && activeAssetUnverified ? uiText("Refreshing balance") : activeAssetUnverified
							? unverifiedTitle
							: `${displayBalance} ${displaySymbol}`}
						cursor="help"
					>
						{activeAssetUnverified ? "—" : formatBalance(displayBalance)}
					</Text>
					<Text fontSize={{ base: "12px", md: "13px" }} fontFamily="mono" color="kk.textMuted" letterSpacing="0.04em">
						{displaySymbol}
					</Text>
					{balanceLoading && <Spinner size="xs" color="kk.textMuted" aria-label={uiText("Refreshing balance")} />}
					{hasPrice && !activeAssetUnverified && (
						<Text fontSize="12px" fontFamily="mono" color="kk.textMuted" ml="2">
							{fmtCompact(parseFloat(displayBalance) * pricePerUnit)}
						</Text>
					)}
				</Flex>
			</Flex>
			{/* Host readiness binds the current signer and Nu7 builder. */}
			{chain.id === 'zcash' && !zcashSupport.available && (zcashSupport.pending || zcashSupport.reason) && (
				<Flex role="status" align="center" gap="2" px="3" py="2" borderRadius="10px" bg="var(--ink-2)">
					{zcashSupport.pending && <Spinner size="xs" flexShrink={0} aria-label={uiText("Checking Zcash sending support…")} />}
					<Text fontSize="xs" color="kk.textMuted">{zcashSupport.pending ? uiText("Checking Zcash sending support…")
						: zcashSupport.reason === ZCASH_NU7_UNSUPPORTED_MESSAGE ? uiText("Your KeepKey needs firmware 7.17 or later to send Zcash.")
						: zcashSupport.reason?.includes('transaction builder') ? uiText("Update KeepKey Desktop to send Zcash.")
						: uiText("Couldn't check Zcash sending support. Try again.")}</Text>
				</Flex>
			)}
			{/* Gas balance hint for token sends */}
			{isTokenSend && balance && (() => {
				// ponytail: gate on the native balance itself, not on nativeBalanceUsd.
				// That field is a subtraction (chain total − tokens − defi) and collapses to ~0
				// whenever token USD is double-counted, which fired this warning on L2s where
				// the user plainly had gas. Zero native = definitely can't pay gas; anything
				// above that is left to buildEvmTx's real gasPrice*gasLimit check.
				const nativeBal = parseFloat(balance.balance || '0')
				// An unverified balance is a placeholder zero, so `!(0 > 0)` fired
				// this warning on accounts holding plenty of gas and sent the user
				// off to deposit more. A failed lookup earns no verdict at all.
				const isLow = !nativeBalanceUnverified && !(nativeBal > 0)
				if (isLow) {
					return (
						<Box bg="rgba(224,140,123,0.10)" border="1px solid rgba(224,140,123,0.28)" borderRadius="14px" px="3.5" py="3">
							<Flex align="center" gap="2" mb="1">
								<svg width="20" height="20" viewBox="0 0 24 24" fill="var(--rose)" xmlns="http://www.w3.org/2000/svg">
									<path d="M3 22V4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v9h1a3 3 0 0 1 3 3v3a1 1 0 0 0 2 0v-7.5l-2.4-2.4a1 1 0 0 1 1.4-1.4l3.3 3.3c.2.2.3.4.3.7V19a3 3 0 0 1-6 0v-3a1 1 0 0 0-1-1h-1v7H3zM7 6h4v5H7V6z"/>
								</svg>
								<Text fontSize="sm" fontWeight="700" color="var(--rose)">{uiText("Low")}{" "}{chain.symbol}{" "}{uiText("for Gas")}</Text>
							</Flex>
							<Text fontSize="xs" color="var(--rose)">{uiText("You need")}{" "}{chain.symbol}{" "}{uiText("to pay network fees. Deposit")}{" "}{chain.symbol}{" "}{uiText("to send tokens on")}{" "}{chain.coin}.
							</Text>
							<Text fontSize="xs" fontFamily="mono" color="var(--rose)" mt="1">
								{t("balance", "Balance")}: {formatBalance(balance.balance)} {chain.symbol}
							</Text>
						</Box>
					)
				}
				return (
					<Flex justify="space-between" align="center" px="3">
						<Text fontSize="10px" color="kk.textMuted">{t("balance", "Balance")} ({chain.symbol})</Text>
						<Text
							fontSize="10px"
							fontFamily="mono"
							color="kk.textMuted"
							title={nativeBalanceUnverified ? unverifiedTitle : undefined}
						>
							{nativeBalanceUnverified ? "—" : formatBalance(balance.balance)} {chain.symbol}
						</Text>
					</Flex>
				)
			})()}

			{/* Phase: Input */}
			{visiblePhase === 'input' && (
				<>
					<Box>
						<Text fontSize="xs" color="kk.textMuted" mb="1">{t("recipient")}</Text>
						<Flex gap="2">
							<Input
								value={recipient}
								onChange={(e) => setRecipient(e.target.value)}
								placeholder={t("addressPlaceholder")}
								bg="transparent"
								border="1px solid var(--line-2)"
								borderRadius="12px"
								color="var(--text-0)"
								size="sm"
								fontFamily="mono"
								px="3"
								flex="1"
								_hover={{ borderColor: "rgba(255,255,255,0.18)" }}
								_focus={{ borderColor: "var(--gold)", bg: "rgba(255,255,255,0.02)" }}
							/>
							<Button
								size="sm"
								variant="outline"
								borderColor="kk.border"
								color="kk.textSecondary"
								_hover={{ borderColor: "kk.gold", color: "kk.gold", bg: "rgba(233,196,106,0.06)" }}
								onClick={() => setShowAddressBook(true)}
								px="2"
								minW="36px"
								h="32px"
								title={t("openAddressBook", { ns: "addressbook" })}
							>
								<BookIcon />
							</Button>
							<Button
								size="sm"
								variant="outline"
								borderColor="kk.border"
								color="kk.textSecondary"
								_hover={{ borderColor: "kk.gold", color: "kk.gold", bg: "rgba(233,196,106,0.06)" }}
								onClick={() => setShowScanner(true)}
								px="2"
								minW="36px"
								h="32px"
								title={t("scanQrCode")}
							>
								<QrIcon />
							</Button>
						</Flex>
						{addressValidation && !addressValidation.valid && (
							<Text fontSize="11px" color="kk.error" mt="1">{t(addressValidation.error!)}</Text>
						)}
						{checkingVaultDestination && <Text fontSize="11px" color="kk.textMuted" mt="1" role="status">{uiText('Verifying destination network and vault configuration…')}</Text>}
						{vaultDestinationError && <Flex align="center" gap="2" mt="1"><Text fontSize="11px" color="kk.error" role="alert">{vaultDestinationError}</Text><Button size="xs" variant="outline" onClick={() => setVaultDestinationRetry(n => n + 1)}>{uiText('Retry verification')}</Button></Flex>}
						{/* R5: known contact/own wallet — show its identicon + label. */}
						{matchedContact && (
							<Flex align="center" gap="2" mt="1.5" px="2" py="1" w="fit-content" bg="rgba(233,196,106,0.06)" border="1px solid rgba(233,196,106,0.22)" borderRadius="999px">
								<AddressIdenticon seed={matchedContact.kind === "own" ? (matchedContact.deviceId || matchedContact.address) : matchedContact.address} size={16} />
								<Text fontSize="11px" color="kk.gold" fontWeight="600" truncate maxW="220px">
									{addressBookLabel(matchedContact, t) || (matchedContact.kind === "own" ? (matchedContact.deviceLabel || t("ownWallet", { ns: "addressbook" })) : t("unlabeled", { ns: "addressbook" }))}
								</Text>
								{matchedContact.vault && <Text fontSize="10px" color="kk.gold">{uiText("Vault ·")}{" "}{matchedContact.networkId} · {matchedContact.vault.threshold}{" "}{uiText("of")}{" "}{matchedContact.vault.cosigners.length}</Text>}
							</Flex>
						)}
						{isSelfSend && (
							<Box mt="2" p="3" borderRadius="10px" bg="rgba(233,196,106,0.08)" border="1px solid rgba(233,196,106,0.35)" role="alert">
								<Text fontSize="12px" fontWeight="700" color="kk.gold">{t("selfSendTitle", { defaultValue: "This is your own address" })}</Text>
								<Text fontSize="11px" color="kk.textSecondary" mt="1" lineHeight="1.5">
									{t("selfSendBody", { symbol: displaySymbol, defaultValue: "This sends {{symbol}} from this account back to the same address. Nothing arrives anywhere new, and you still pay the network fee." })}
								</Text>
								<Flex as="label" align="center" gap="2" mt="2" cursor="pointer">
									<input type="checkbox" checked={selfSendConfirmed} onChange={e => setSelfSendConfirmedFor(e.target.checked ? confirmationKey : null)} style={{ accentColor: 'var(--gold)' }} />
									<Text fontSize="11px" color="kk.textPrimary">{t("selfSendConfirm", { defaultValue: "I understand, send to my own address anyway" })}</Text>
								</Flex>
							</Box>
						)}
						{recipientRisk?.kind === 'sentToken' && (
							<Text fontSize="11px" color="kk.error" mt="1" role="alert">{t("recipientIsSentToken", { symbol: displaySymbol })}</Text>
						)}
						{recipientNeedsAck && (
							<Box mt="2" p="3" borderRadius="10px" bg="rgba(224,140,123,0.10)" border="1px solid rgba(224,140,123,0.35)" role="alert">
								<Text fontSize="12px" fontWeight="700" color="kk.error">
									{recipientRisk?.kind === 'burn' ? t("recipientBurnTitle") : t("recipientTokenContractTitle", { token: recipientRisk?.kind === 'tokenContract' ? recipientRisk.token : '' })}
								</Text>
								<Text fontSize="11px" color="kk.textSecondary" mt="1" lineHeight="1.5">
									{recipientRisk?.kind === 'burn' ? t("recipientBurnBody") : t("recipientTokenContractBody")}
								</Text>
								<Flex as="label" align="center" gap="2" mt="2" cursor="pointer">
									<input type="checkbox" checked={riskConfirmed} onChange={e => setRiskConfirmedFor(e.target.checked ? confirmationKey : null)} style={{ accentColor: 'var(--rose)' }} />
									<Text fontSize="11px" color="kk.textPrimary">{recipientRisk?.kind === 'burn' ? t("recipientBurnConfirm") : t("recipientTokenContractConfirm")}</Text>
								</Flex>
							</Box>
						)}
						{recipientIsContract && !recipientRisk && (
							<Text fontSize="11px" color="kk.gold" mt="1.5">{t("recipientContractNote", { symbol: displaySymbol })}</Text>
						)}
						{!isSelfSend && matchedContact?.kind === "own" && (
							<Text fontSize="11px" color="kk.textSecondary" mt="1.5">
								{t("ownWalletNote", { defaultValue: "This address belongs to your wallet. You are moving funds between your own accounts." })}
							</Text>
						)}
						{/* R5: new external address — flag it + offer to save (opens dialog). */}
						{addressIsNew && !matchedContact && (
							<Flex align="center" gap="2" mt="1.5" px="2" py="1" w="fit-content" bg="rgba(224,140,123,0.08)" border="1px solid rgba(224,140,123,0.28)" borderRadius="999px">
								<AddressIdenticon seed={recipient.trim()} size={16} />
								<Text fontSize="11px" color="var(--rose)" fontWeight="600">
									{t("newAddressBadge", { ns: "addressbook", defaultValue: "New address" })}
								</Text>
								<Box as="button" fontSize="11px" color="kk.gold" fontWeight="700" textDecoration="underline"
									onClick={() => setShowSaveDialog(true)}>
									{t("save", { ns: "common", defaultValue: "Save" })}
								</Box>
							</Flex>
						)}
					</Box>

					{/* Amount input with USD conversion */}
					<Box>
						<Flex justify="space-between" align="center" mb="1">
							<Text fontSize="xs" color="kk.textMuted">
								{inputMode === 'crypto' ? `${t("amount")} (${displaySymbol})` : `${t("amount")} (USD)`}
							</Text>
						</Flex>
						<Flex gap="2" align="center">
							<Box flex="1">
								<Input
									inputMode="decimal"
									aria-invalid={invalidAmountInput || undefined}
									value={isMax ? 'MAX' : (inputMode === 'crypto' ? amount : usdAmount)}
									onChange={(e) => inputMode === 'crypto' ? handleCryptoChange(e.target.value) : handleUsdChange(e.target.value)}
									placeholder={inputMode === 'usd' ? '0.00' : t("amountPlaceholder")}
									bg="transparent"
									border="1px solid var(--line-2)"
									borderRadius="12px"
									color="var(--text-0)"
									size="sm"
									fontFamily="mono"
									disabled={isMax}
									px="3"
									_hover={{ borderColor: "rgba(255,255,255,0.18)" }}
									_focus={{ borderColor: "var(--gold)", bg: "rgba(255,255,255,0.02)" }}
								/>
								{invalidAmountInput && <Text fontSize="xs" color="kk.error" mt="1">{t('invalidAmount', { defaultValue: 'Enter an ungrouped decimal amount, for example 1.5. Thousands separators are not accepted.' })}</Text>}
							</Box>
							<Button
								size="sm"
								variant={isMax ? "solid" : "outline"}
								bg={isMax ? "var(--gold)" : "var(--ink-3)"}
								color={isMax ? "var(--ink-0)" : "var(--text-1)"}
								border="1px solid var(--line)"
								borderRadius="10px"
								fontWeight="600"
								fontSize="11px"
								_hover={{ bg: isMax ? "var(--gold-2)" : "var(--ink-4)" }}
								onClick={() => { setIsMax(prev => !prev); setAmount(""); setUsdAmount("") }}
								disabled={!senderReady || (balanceLoading && activeAssetUnverified)}
								px="4" py="2"
								h="32px"
							>
								{t("max")}
							</Button>
						</Flex>

						{/* Clickable secondary value — tap to flip input mode (USD ⇄ native) */}
						{hasPrice && (
							<Flex mt="1.5" px="1" justify="space-between" align="center" py="0.5">
								<style>{AMOUNT_FLIP_CSS}</style>
								{!isMax ? (
									<Flex
										as="button"
										className="kk-amount-flip"
										align="center"
										gap="1.5"
										onClick={toggleInputMode}
										cursor="pointer"
										px="2.5"
										py="1"
										borderRadius="999px"
										bg="rgba(233,196,106,0.10)"
										border="1px solid rgba(233,196,106,0.30)"
										color="kk.gold"
										transition="all 0.15s"
										_hover={{ bg: "rgba(233,196,106,0.18)", borderColor: "rgba(233,196,106,0.55)" }}
										title={t("switchAmountUnit", { defaultValue: "Tap to switch between USD and native amount" })}
									>
										<Text fontSize="12px" fontWeight="600" fontFamily="mono" letterSpacing="0.01em">
											{inputMode === 'crypto'
												? (amountUsdPreview !== null ? (fmtCompact(amountUsdPreview) || fmt(0)) : fmt(0))
												: (amount ? `${formatBalance(amount)} ${displaySymbol}` : `0 ${displaySymbol}`)}
										</Text>
										<Box className="kk-amount-flip-icon" display="flex">
											<SwapIcon />
										</Box>
									</Flex>
								) : <Box />}
								{pricePerUnit > 0 && (
									<Text fontSize="10px" color="kk.textMuted">1 {displaySymbol} = {fmtCompact(pricePerUnit)}</Text>
								)}
							</Flex>
						)}
					</Box>

					{needsMemo && (
						<Field
							label={chain.chainFamily === 'xrp' ? t("memoLabel") : t("memoLabelShort")}
							value={memo}
							onChange={setMemo}
							placeholder={t("memoPlaceholder")}
						/>
					)}

					{supportsFeePresets && (
						<Box>
							<Flex justify="space-between" align="center" mb="1">
								<Text fontSize="xs" color="kk.textMuted">{t("feePriority")}</Text>
								{supportsCustomFee && (
									<Text
										as="button"
										fontSize="10px"
										color={feeMode === 'custom' ? "var(--gold)" : "kk.textMuted"}
										_hover={{ color: "var(--gold)" }}
										cursor="pointer"
										onClick={() => setFeeMode(feeMode === 'custom' ? 'preset' : 'custom')}
									>
										{feeMode === 'custom' ? t("feeUsePreset") : t("feeCustom")}
									</Text>
								)}
							</Flex>

							{/* Default, low-friction view: just the three presets. */}
							{feeMode === 'preset' && (
								<Flex gap="2">
									{[{ label: t("feeSlow"), val: 1 }, { label: t("feeNormal"), val: 3 }, { label: t("feeFast"), val: 10 }].map((opt) => {
										const active = feeLevel === opt.val
										return (
											<Button
												key={opt.val}
												size="xs"
												flex="1"
												variant="outline"
												bg={active ? "rgba(233,196,106,0.12)" : "transparent"}
												color={active ? "var(--gold)" : "kk.textMuted"}
												border="1px solid"
												borderColor={active ? "rgba(233,196,106,0.45)" : "var(--line)"}
												borderRadius="10px"
												fontWeight={active ? "600" : "400"}
												_hover={{ bg: active ? "rgba(233,196,106,0.18)" : "var(--ink-3)", color: active ? "var(--gold)" : "var(--text-1)" }}
												onClick={() => setFeeLevel(opt.val)}
											>
												{opt.label}
											</Button>
										)
									})}
								</Flex>
							)}

							{/* Advanced view: shown only after the user opts into Custom. */}
							{feeMode === 'custom' && chain.chainFamily === 'evm' && (
								<Flex gap="2">
									<Box flex="1">
										<Text fontSize="10px" color="kk.textMuted" mb="1">{t("gasPriceGwei")}</Text>
										<Input
											size="xs" value={customGasPrice}
											onChange={(e) => setCustomGasPrice(e.target.value)}
											placeholder={networkGasPrice ?? t("gasPriceAuto")} inputMode="decimal"
											bg="var(--ink-3)" border="1px solid var(--line)" borderRadius="10px"
										/>
									</Box>
									{/* Gas limit is hidden for token sends — the safe ERC-20 default (100k)
									    must not be lowered into an out-of-gas revert. Native only. */}
									{!isTokenSend && (
										<Box flex="1">
											<Text fontSize="10px" color="kk.textMuted" mb="1">{t("gasLimitOptional")}</Text>
											<Input
												size="xs" value={customGasLimit}
												onChange={(e) => setCustomGasLimit(e.target.value)}
												placeholder="21000" inputMode="numeric"
												bg="var(--ink-3)" border="1px solid var(--line)" borderRadius="10px"
											/>
										</Box>
									)}
								</Flex>
							)}

							{feeMode === 'custom' && chain.chainFamily === 'utxo' && (
								<Box>
									<Text fontSize="10px" color="kk.textMuted" mb="1">{t("satPerVByte")}</Text>
									<Input
										size="xs" value={customSatPerVByte}
										onChange={(e) => setCustomSatPerVByte(e.target.value)}
										placeholder="5" inputMode="decimal"
										bg="var(--ink-3)" border="1px solid var(--line)" borderRadius="10px"
									/>
								</Box>
							)}

							{feeMode === 'custom' && (
								<Text fontSize="10px" color="kk.textMuted" mt="1">{t("customFeeHint")}</Text>
							)}
						</Box>
					)}

					{exceedsBalance && (
						<Text fontSize="xs" color="kk.error">{t("exceedsBalance", { balance: formatBalance(displayBalance), symbol: displaySymbol })}</Text>
					)}
					{exceedsBalanceWithFee && (
						<Text fontSize="xs" color="kk.error">{t("exceedsBalanceWithFee", { fee: formatBalance(cosmosFee!), balance: formatBalance(displayBalance), symbol: displaySymbol })}</Text>
					)}

					{buildBlocker && (
						<Text fontSize="xs" color="kk.textMuted" role="status">{buildBlocker}</Text>
					)}
					{/* Self-send and burn/contract recipients: Build waits for the explicit confirmation above. */}
					{(isSelfSend && !selfSendConfirmed) || (recipientNeedsAck && !riskConfirmed) ? (
						<Button w="full" px="4" py="2" borderRadius="12px" bg="var(--gold)" color="var(--ink-0)" fontWeight="600" onClick={handleBuild} disabled>
							{t("buildTransaction")}
						</Button>
					) : (
					<Button
						size="sm"
						bg="var(--gold)"
						color="var(--ink-0)"
						fontWeight="600"
						borderRadius="12px"
						_hover={{ bg: "var(--gold-2)" }}
						onClick={handleBuild}
						disabled={loading || !senderReady || !zcashSupport.available || (isMax && balanceLoading && activeAssetUnverified) || invalidAmountInput || checkingVaultDestination || !destinationReady || !!vaultDestinationError || !recipient || (!amount && !isMax) || (addressValidation != null && !addressValidation.valid) || recipientRisk?.kind === 'sentToken'}
						px="4" py="2"
						w="full"
					>
						{loading ? t("buildingTransaction") : t("buildTransaction")}
					</Button>
					)}
				</>
			)}

			{/* Phase: Built — show fee, sign button */}
			{visiblePhase === 'built' && buildResult && currentSigningContext && (
				<>
					<Box bg="rgba(233,196,106,0.06)" border="1px solid rgba(233,196,106,0.22)" borderRadius="14px" p="4">
						<Text fontSize="xs" color="kk.textMuted" mb="2">{t("transactionReady")}</Text>
						<Flex justify="space-between" mb="1">
							<Text fontSize="xs" color="kk.textSecondary">{t("to")}</Text>
							{/* Full address, never truncated: this is what the user checks against the device. */}
							<Text fontSize="xs" fontFamily="mono" color="kk.textPrimary" flex="1" minW="0" ml="3" textAlign="right" wordBreak="break-all">{currentSigningContext.recipient}</Text>
						</Flex>
						<Flex justify="space-between" mb="1">
							<Text fontSize="xs" color="kk.textSecondary">{t("amount")}</Text>
							<Flex direction="column" align="flex-end">
								<Text fontSize="xs" fontFamily="mono" color="kk.textPrimary" title={currentSigningContext.isMax && maxSentAmount ? maxSentAmount : undefined}>{currentSigningContext.isMax ? (maxSentAmount ? formatBalance(maxSentAmount) : 'MAX') : currentSigningContext.amount} {currentSigningContext.displaySymbol}</Text>
								{!isMax && amountUsdPreview !== null && (
									<Text fontSize="10px" fontFamily="mono" color="kk.textMuted">{fmtCompact(amountUsdPreview)}</Text>
								)}
							</Flex>
						</Flex>
						<Flex justify="space-between">
							<Text fontSize="xs" color="kk.textSecondary">{t("fee")}</Text>
							<Flex direction="column" align="flex-end">
								<Text fontSize="xs" fontFamily="mono" color="kk.textPrimary">{formatBalance(buildResult.fee)} {chain.symbol}</Text>
								{feeLabelUsd && (
									<Text fontSize="10px" fontFamily="mono" color="kk.textMuted">{feeLabelUsd}</Text>
								)}
							</Flex>
						</Flex>
						{feeOverQuarter && (
							<Text fontSize="xs" color="kk.error" mt="1">{supportsCustomFee ? t('feeOverQuarter') : t('feeOverQuarterFixed')}</Text>
						)}
					</Box>

					{/* Debug: hdwallet payload */}
					<Box>
						<Button
							size="xs" variant="ghost" color="kk.textMuted" w="full"
							onClick={() => setShowPayload(!showPayload)}
							_hover={{ color: "kk.textSecondary" }}
						>
							{showPayload ? t("hidePayload") : t("showPayload")}
						</Button>
						{showPayload && buildResult.unsignedTx && (
							<Box bg="rgba(0,0,0,0.3)" borderRadius="md" p="2" mt="1" maxH="300px" overflow="auto">
								<Text fontSize="10px" fontFamily="mono" color="kk.textSecondary" whiteSpace="pre-wrap" wordBreak="break-all">
									{JSON.stringify(buildResult.unsignedTx, null, 2)}
								</Text>
							</Box>
						)}
					</Box>

					{loading && (
						<Flex align="center" justify="space-between" gap="3" bg="rgba(233,196,106,0.06)" border="1px solid rgba(233,196,106,0.22)" borderRadius="14px" p="3" role="status">
							<Box>
								<Text fontSize="xs" color="kk.textPrimary" fontWeight="600">{t("waitingForKeepKey")}</Text>
								<Text fontSize="xs" color="kk.textMuted">{t("waitingForKeepKeyHint")}</Text>
							</Box>
							<Button size="xs" variant="outline" onClick={cancelDeviceSigning}>{t("cancel", { ns: "common" })}</Button>
						</Flex>
					)}

					<Flex gap="2">
						<Button
							size="sm"
							flex="1"
							variant="outline"
							color="var(--text-2)"
							border="1px solid var(--line)"
							borderRadius="12px"
							_hover={{ color: "var(--text-0)", bg: "var(--ink-2)" }}
							onClick={edit}
							px="4" py="2"
						>
							{t("back", { ns: "common" })}
						</Button>
						<Button
							size="sm"
							flex="2"
							bg="kk.gold"
							color="black"
							_hover={{ bg: "kk.goldHover" }}
							onClick={handleSign}
							disabled={loading || !senderReady || !zcashSupport.available}
							px="4" py="2"
						>
							{loading ? t("confirmOnDevice") : t("signOnDevice")}
						</Button>
					</Flex>
				</>
			)}

			{/* Phase: Signed — show broadcast button */}
			{visiblePhase === 'signed' && signedTx && (
				<>
					<Box bg="rgba(139,227,196,0.06)" border="1px solid rgba(139,227,196,0.22)" borderRadius="14px" p="4">
						<Text fontSize="xs" color="var(--teal)" mb="1">{t("transactionSigned")}</Text>
						<Text fontSize="xs" fontFamily="mono" color="kk.textSecondary" maxH="80px" overflow="auto" wordBreak="break-all">
							{typeof signedTx === 'string' ? signedTx : (signedTx?.value?.signatures?.[0]?.serializedTx || signedTx?.serializedTx || signedTx?.serialized || JSON.stringify(signedTx))}
						</Text>
					</Box>

					<Flex gap="2">
						<Button
							size="sm"
							flex="1"
							variant="outline"
							color="var(--text-2)"
							border="1px solid var(--line)"
							borderRadius="12px"
							_hover={{ color: "var(--text-0)", bg: "var(--ink-2)" }}
							onClick={edit}
							px="4" py="2"
						>
							{t("cancel", { ns: "common" })}
						</Button>
						<Button
							size="sm"
							flex="2"
							bg="var(--teal)"
							color="black"
							_hover={{ opacity: 0.9 }}
							onClick={handleBroadcast}
							disabled={loading || !zcashSupport.available}
							px="4" py="2"
						>
							{loading ? t("broadcasting") : t("broadcastTransaction")}
						</Button>
					</Flex>
				</>
			)}

			{/* Phase: Broadcast — success with confetti */}
			{visiblePhase === 'broadcast' && txid && (
				<Box position="relative" overflow="hidden" borderRadius="lg">
					<style>{CONFETTI_CSS}</style>
					{confettiPieces.map(p => (
						<Box
							key={p.id} position="absolute" w="6px" h="6px" bg={p.color}
							left={p.left} top="-6px" borderRadius="1px" transform="rotate(45deg)"
							style={{ animation: `kkSendConfetti ${p.duration} linear ${p.delay} 1 forwards` }}
						/>
					))}

					<VStack gap="3" position="relative" zIndex={1}>
						<Box bg="rgba(139,227,196,0.08)" border="1px solid rgba(139,227,196,0.25)" borderRadius="14px" p="3.5" w="full">
							<Text fontSize="xs" color="var(--teal)" fontWeight="600" mb="2">{t("sent")}</Text>
							<Flex justify="space-between" align="center" gap="2">
								<Flex align="center" gap="1" minW="0" flex="1">
									<Text fontSize="10px" color="kk.textMuted" flexShrink={0}>{t("tx")}</Text>
									<Text fontSize="10px" fontFamily="mono" color="kk.textPrimary" truncate title={txid}>
										{truncatedTxid}
									</Text>
								</Flex>
								<Button size="xs" variant="ghost" color="kk.textSecondary" onClick={copyTxid} px="1" minW="auto" h="auto" py="0.5">
									{copied ? t("copied", { ns: "common" }) : t("copy", { ns: "common" })}
								</Button>
							</Flex>
						</Box>

						<Flex gap="2" w="full">
							{explorerUrl && (
								<Button
									size="sm" flex="1" bg="var(--teal)" color="black"
									_hover={{ opacity: 0.9 }}
									onClick={() => rpcRequest('openUrl', { url: explorerUrl! }).catch(() => {})}
								>
									{t("viewInExplorer")}
								</Button>
							)}
							<Button
								size="sm" flex="1" bg="var(--gold)" color="var(--ink-0)" fontWeight="600" borderRadius="12px"
								_hover={{ bg: "var(--gold-2)" }}
								onClick={reset}
							>
								{t("sendAnother")}
							</Button>
						</Flex>
					</VStack>
				</Box>
			)}

			{/* Error display */}
			{error && (
				<Box bg="rgba(224,140,123,0.08)" border="1px solid rgba(224,140,123,0.25)" borderRadius="14px" p="3">
					<Text fontSize="xs" color="kk.error">{error}</Text>
				</Box>
			)}

			{/* QR Scanner overlay */}
			{showScanner && (
				<QrScannerOverlay onScan={handleQrScan} onClose={() => setShowScanner(false)} />
			)}

			{/* Address Book picker (R5) — entries matching this send's network */}
			{showAddressBook && (
				<AddressBookPicker
					networkId={caipToNetworkId(activeCaip)}
					chainFamily={chain.chainFamily}
					assetCaip={activeCaip}
					// This form spends transparent ZEC; shielded recipients use the shielded balance selector.
					entryFilter={chain.id === 'zcash' ? (e) => isTransparentZcashRecipient(e.address) : undefined}
					onSelect={(e) => { setRecipient(e.address); promptedAddressRef.current = e.address; setShowAddressBook(false) }}
					onClose={() => setShowAddressBook(false)}
				/>
			)}

			{/* R5: save dialog for a new external recipient — at form-fill, before sending */}
			{showSaveDialog && (
				<SaveRecipientDialog
					address={recipient.trim()}
					networkId={caipToNetworkId(activeCaip)}
					assetCaip={activeCaip}
					symbol={displaySymbol}
					onClose={() => setShowSaveDialog(false)}
					onSaved={(entry) => { setMatchedContact(entry); setAddressIsNew(false); setShowSaveDialog(false) }}
				/>
			)}
		</VStack>
	)
}

function SwapIcon() {
	return (
		<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
			<path d="M7 16V4m0 0L3 8m4-4l4 4M17 8v12m0 0l4-4m-4 4l-4-4" />
		</svg>
	)
}

function QrIcon() {
	return (
		<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" xmlns="http://www.w3.org/2000/svg">
			<rect x="2" y="2" width="8" height="8" rx="1" stroke="currentColor" strokeWidth="2" fill="none" />
			<rect x="4" y="4" width="4" height="4" fill="currentColor" />
			<rect x="14" y="2" width="8" height="8" rx="1" stroke="currentColor" strokeWidth="2" fill="none" />
			<rect x="16" y="4" width="4" height="4" fill="currentColor" />
			<rect x="2" y="14" width="8" height="8" rx="1" stroke="currentColor" strokeWidth="2" fill="none" />
			<rect x="4" y="16" width="4" height="4" fill="currentColor" />
			<rect x="14" y="14" width="3" height="3" fill="currentColor" />
			<rect x="19" y="14" width="3" height="3" fill="currentColor" />
			<rect x="14" y="19" width="3" height="3" fill="currentColor" />
			<rect x="19" y="19" width="3" height="3" fill="currentColor" />
		</svg>
	)
}

function BookIcon() {
	return (
		<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
			<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
			<path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
		</svg>
	)
}

function Field({ label, value, onChange, placeholder, disabled }: {
	label: string; value: string; onChange: (v: string) => void; placeholder: string; disabled?: boolean
}) {
	return (
		<Box>
			<Text fontSize="xs" color="kk.textMuted" mb="1">{label}</Text>
			<Input
				value={value}
				onChange={(e) => onChange(e.target.value)}
				placeholder={placeholder}
				bg="transparent"
				border="1px solid var(--line-2)"
				borderRadius="12px"
				color="var(--text-0)"
				size="sm"
				fontFamily="mono"
				disabled={disabled}
				px="3"
				_hover={{ borderColor: "rgba(255,255,255,0.18)" }}
				_focus={{ borderColor: "var(--gold)", bg: "rgba(255,255,255,0.02)" }}
			/>
		</Box>
	)
}
