/**
 * ActivityPanel — drawer showing recent transaction activity per network.
 *
 * Opens in "All" mode showing every chain. User picks a specific chain to
 * enable the refresh/scan button. Each tx row shows chain icon + symbol.
 */
import { useState, useEffect, useMemo, useCallback, useRef } from "react"
import { Box, Text, Flex, VStack, HStack, Image } from "@chakra-ui/react"
import { rpcRequest } from "../lib/rpc"
import { Z } from "../lib/z-index"
import { CHAINS, getExplorerTxUrl } from "../../shared/chains"
import { caipToIcon } from "../../shared/assetLookup"
import type { RecentActivity, PendingSwap, ChainBalance, SwapTrackingStatus } from "../../shared/types"

interface ActivityPanelProps {
  open: boolean
  onClose: () => void
  activities: RecentActivity[]
  pendingSwaps: PendingSwap[]
  onRefresh: () => void
  onResumeSwap?: (swap: PendingSwap) => void
  onOpenFullPage?: () => void
}

const CHAIN_COLORS: Record<string, string> = {}
CHAINS.forEach(c => { CHAIN_COLORS[c.symbol] = c.color; CHAIN_COLORS[c.id] = c.color })

// Colors are spec-palette hex (not CSS vars) because they're alpha-appended as
// `${color}22` for badge backgrounds — `var(--x)22` is invalid CSS. Hex maps:
// rose #e08c7b, teal #8be3c4, gold #e9c46a (see theme.ts).
const TYPE_CONFIG: Record<string, { label: string; color: string }> = {
  send: { label: 'Sent', color: '#e08c7b' },
  receive: { label: 'Received', color: '#8be3c4' },
  swap: { label: 'Swap', color: '#e9c46a' },
  sign: { label: 'Signed', color: '#627EEA' },
  message: { label: 'Message', color: '#8247E5' },
  approve: { label: 'Approve', color: '#e08c7b' },
}

const STATUS_CONFIG: Record<string, { label: string; color: string }> = {
  broadcast: { label: 'Broadcast', color: '#8be3c4' },
  signed: { label: 'Signed', color: '#e9c46a' },
  completed: { label: 'Completed', color: '#8be3c4' },
  refunded: { label: 'Refunded', color: '#e9c46a' },
  failed: { label: 'Failed', color: '#e08c7b' },
}

// How a record reached us — surfaced in the detail panel so nothing is implicit.
const SOURCE_LABELS: Record<string, string> = {
  scan: 'On-chain scan',
  app: 'In-app',
  api: 'External app',
}

const SWAP_STATUS_CONFIG: Record<string, { label: string; color: string; dot?: boolean }> = {
  signing:             { label: 'Signing',            color: '#627EEA', dot: true },
  pending:             { label: 'Pending',            color: '#F7931A', dot: true },
  confirming:          { label: 'Confirming',         color: '#627EEA', dot: true },
  output_detected:     { label: 'Output Detected',    color: '#23DCC8', dot: true },
  output_confirming:   { label: 'Confirming Output',  color: '#23DCC8', dot: true },
  output_confirmed:    { label: 'Output Confirmed',   color: 'var(--teal)' },
  completed:           { label: 'Complete',            color: 'var(--teal)' },
  failed:              { label: 'Failed',              color: '#E53E3E' },
  refunded:            { label: 'Refunded',            color: '#FB923C' },
}

function SwapStatusBadge({ status }: { status?: SwapTrackingStatus | string }) {
  if (!status) return null
  const conf = SWAP_STATUS_CONFIG[status] || { label: status, color: '#627EEA' }
  return (
    <HStack gap="1" px="1.5" py="0.5" borderRadius="md" bg={`${conf.color}18`}>
      {conf.dot && <Box w="6px" h="6px" borderRadius="full" bg={conf.color} flexShrink={0} style={{ animation: 'kkActivityPulse 2s ease-in-out infinite' }} />}
      <Text fontSize="2xs" fontWeight="700" color={conf.color}>{conf.label}</Text>
    </HStack>
  )
}

// Required confirmations per chain family before considered "confirmed"
const CONF_REQUIRED: Record<string, number> = {
  BTC: 6, LTC: 6, DOGE: 6, DASH: 6, BCH: 6, DGB: 6, ZEC: 24,
  ETH: 12, MATIC: 128, AVAX: 12, BNB: 15, ARB: 12, OP: 12, BASE: 12,
  ATOM: 1, RUNE: 1, CACAO: 1, OSMO: 1,
  XRP: 1, SOL: 32, TRX: 19, TON: 1, MON: 12, HYPE: 12,
}
function getRequiredConfs(symbol: string): number { return CONF_REQUIRED[symbol] || 6 }

/** Confirmation badge: red = unconfirmed, yellow = partial, green = confirmed */
function ConfBadge({ confirmations, chain }: { confirmations?: number; chain: string }) {
  if (confirmations === undefined) return null
  const required = getRequiredConfs(chain)
  const isConfirmed = confirmations >= required
  const isUnconfirmed = confirmations === 0
  const color = isUnconfirmed ? '#E53E3E' : isConfirmed ? '#23DCC8' : '#F7931A'
  const label = isUnconfirmed ? 'Unconfirmed' : isConfirmed ? 'Confirmed' : `${confirmations}/${required}`
  return (
    <HStack gap="1">
      <Box w="6px" h="6px" borderRadius="full" bg={color} flexShrink={0} />
      <Text fontSize="9px" color={color} fontWeight="600">{label}</Text>
    </HStack>
  )
}

function getExplorerUrl(chainSymbol: string, txid: string): string | null {
  if (!chainSymbol || !txid) return null
  const chain = CHAINS.find(c => c.symbol === chainSymbol || c.id === chainSymbol)
  if (!chain?.explorerTxUrl) return null
  const normalizedTxid = chain.chainFamily === 'evm'
    ? (txid.startsWith('0x') ? txid : '0x' + txid)
    : txid.replace(/^0x/i, '')
  return chain.explorerTxUrl.replace('{{txid}}', normalizedTxid)
}

export function truncateTxid(txid: string): string {
  if (txid.length <= 16) return txid
  return txid.slice(0, 8) + '...' + txid.slice(-8)
}

export function timeAgo(ts: number): string {
  const diff = Date.now() - ts
  if (diff < 60_000) return 'just now'
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)}m ago`
  if (diff < 86400_000) return `${Math.floor(diff / 3600_000)}h ago`
  return `${Math.floor(diff / 86400_000)}d ago`
}

function recentTimestamp(item: { createdAt: number }): number {
  const timestamp = Number(item.createdAt)
  return Number.isFinite(timestamp) ? timestamp : 0
}

export function recentFirst<T extends { createdAt: number }>(items: T[]): T[] {
  return [...items].sort((a, b) => recentTimestamp(b) - recentTimestamp(a))
}

const USD_FORMATTER = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
})

function formatUsd(value: number | null | undefined): string | null {
  if (!Number.isFinite(value ?? NaN)) return null
  const n = Number(value)
  if (n > 0 && n < 0.01) return '<$0.01'
  return USD_FORMATTER.format(n)
}

function commifyInteger(value: string): string {
  return value.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

function formatBaseUnits(raw: string | undefined, decimals: number, maxFraction = 8): string | null {
  const value = String(raw ?? '').trim()
  if (!value) return null
  if (!/^-?\d+$/.test(value)) return value
  const negative = value.startsWith('-')
  const abs = BigInt(negative ? value.slice(1) : value)
  const denom = 10n ** BigInt(decimals)
  const whole = abs / denom
  const fraction = abs % denom
  let fractionText = decimals > 0
    ? fraction.toString().padStart(decimals, '0').slice(0, maxFraction).replace(/0+$/, '')
    : ''
  if (whole === 0n && fraction > 0n && !fractionText) {
    fractionText = `${'0'.repeat(Math.max(maxFraction - 1, 0))}1`
    return `${negative ? '-' : ''}<0.${fractionText}`
  }
  return `${negative ? '-' : ''}${commifyInteger(whole.toString())}${fractionText ? `.${fractionText}` : ''}`
}

function numericDisplayValue(display: string | null): number | null {
  if (!display || display.startsWith('<')) return null
  const n = Number(display.replace(/,/g, ''))
  return Number.isFinite(n) ? n : null
}

function formatNativeValue(raw: string | undefined, chainDef: { decimals: number; symbol: string } | undefined, source: string, priceUsd?: number) {
  if (!raw) return null
  const amount = source === 'scan' && chainDef
    ? formatBaseUnits(raw, chainDef.decimals)
    : raw
  if (!amount) return null
  const usd = priceUsd ? formatUsd((numericDisplayValue(amount) ?? 0) * priceUsd) : null
  return { amount, usd }
}

export function nativePriceByChain(balances: ChainBalance[]): Record<string, number> {
  const prices: Record<string, number> = {}
  for (const b of balances) {
    const balance = Number(b.balance)
    const tokenUsd = b.tokens?.reduce((sum, t) => sum + (t.balanceUsd || 0), 0) || 0
    const nativeUsd = Number(b.nativeBalanceUsd ?? Math.max((b.balanceUsd || 0) - tokenUsd, 0))
    if (Number.isFinite(balance) && balance > 0 && Number.isFinite(nativeUsd) && nativeUsd > 0) {
      prices[b.chainId] = nativeUsd / balance
    }
  }
  return prices
}

// ── Detail types for the TX detail dialog ───────────────────────────
export type TxDetail = {
  kind: 'activity'
  activity: RecentActivity
} | {
  kind: 'swap'
  swap: PendingSwap
}

export type ActivityTimelineItem =
  | { kind: 'activity'; id: string; createdAt: number; activity: RecentActivity }
  | { kind: 'swap'; id: string; createdAt: number; swap: PendingSwap }

export function formatFullDate(ts: number): string {
  const d = new Date(ts)
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) +
    ' ' + d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })
}

function TxDetailRow({ label, value, mono, color: c }: { label: string; value: string; mono?: boolean; color?: string }) {
  return (
    <Flex justify="space-between" align="center" py="1.5" gap="3">
      <Text fontSize="11px" color="kk.textMuted" minW="100px" flexShrink={0}>{label}</Text>
      <Text fontSize="11px" color={c || 'kk.textSecondary'} textAlign="right" fontFamily={mono ? 'mono' : undefined} wordBreak="break-all" maxW="280px">{value}</Text>
    </Flex>
  )
}

function CopyableRow({ label, value, explorerUrl }: { label: string; value: string; explorerUrl?: string | null }) {
  const [copied, setCopied] = useState(false)
  const handleCopy = () => { navigator.clipboard.writeText(value); setCopied(true); setTimeout(() => setCopied(false), 1500) }
  return (
    <Flex justify="space-between" align="center" py="1.5" gap="3">
      <Text fontSize="11px" color="kk.textMuted" minW="100px" flexShrink={0}>{label}</Text>
      <HStack gap="1" justify="flex-end" minW="0">
        <Text
          fontSize="11px" color="var(--teal)" fontFamily="mono" cursor="pointer" wordBreak="break-all" textAlign="right"
          _hover={{ opacity: 0.8 }} onClick={handleCopy} title={copied ? 'Copied!' : 'Click to copy'}
        >
          {copied ? 'Copied!' : value}
        </Text>
        {explorerUrl && (
          <Text as="button" fontSize="10px" color="kk.textMuted" _hover={{ color: 'var(--teal)' }} flexShrink={0}
            onClick={() => rpcRequest('openUrl', { url: explorerUrl }).catch(() => {})}>
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
              <polyline points="15 3 21 3 21 9" />
              <line x1="10" y1="14" x2="21" y2="3" />
            </svg>
          </Text>
        )}
      </HStack>
    </Flex>
  )
}

export function TxDetailDialog({ detail, onClose, nativePrices }: { detail: TxDetail; onClose: () => void; nativePrices: Record<string, number> }) {
  if (detail.kind === 'activity') {
    const a = detail.activity
    const typeConf = TYPE_CONFIG[a.type] || TYPE_CONFIG.sign
    const statusConf = STATUS_CONFIG[a.status] || STATUS_CONFIG.signed
    const chainDef = CHAINS.find(c => a.chainId && c.id === a.chainId) || CHAINS.find(c => c.symbol === a.chain || c.id === a.chain)
    const chainSymbol = chainDef?.symbol || a.chain
    const nativePrice = chainDef ? nativePrices[chainDef.id] : undefined
    const amountValue = formatNativeValue(a.amount, chainDef, a.source, nativePrice)
    const feeValue = formatNativeValue(a.fee, chainDef, a.source, nativePrice)
    const explorerUrl = a.txid && chainDef ? getExplorerTxUrl(chainDef.id, a.txid) : null
    // Only build address explorer links for a single address (not "addr +N" fan-out summaries).
    const explorerAddrUrl = a.to && !a.to.includes(' ') && chainDef?.explorerAddressUrl ? chainDef.explorerAddressUrl.replace('{{address}}', a.to) : null
    const explorerFromUrl = a.from && !a.from.includes(' ') && chainDef?.explorerAddressUrl ? chainDef.explorerAddressUrl.replace('{{address}}', a.from) : null
    const required = getRequiredConfs(chainSymbol)

    return (
      <Box position="fixed" inset="0" zIndex={Z.dialog} display="flex" alignItems="center" justifyContent="center" onClick={onClose}>
        <Box position="absolute" inset="0" bg="blackAlpha.700" />
        <Box
          position="relative" bg="kk.cardBg" border="1px solid" borderColor="kk.border"
          borderRadius="xl" w="440px" maxW="95vw" maxH="85vh" overflow="auto"
          onClick={e => e.stopPropagation()}
          boxShadow="0 12px 40px rgba(0,0,0,0.6)"
          style={{ animation: 'kkTxDetailFadeIn 0.15s ease-out' }}
        >
          {/* Header */}
          <Flex px="5" py="3" borderBottom="1px solid" borderColor="kk.border" align="center" justify="space-between">
            <HStack gap="2">
              <Box px="2" py="0.5" borderRadius="md" fontSize="xs" fontWeight="700" bg={`${typeConf.color}22`} color={typeConf.color}>{typeConf.label}</Box>
              {a.type === 'swap' && a.swapStatus ? (
                <SwapStatusBadge status={a.swapStatus} />
              ) : (
                <Box px="2" py="0.5" borderRadius="md" fontSize="xs" fontWeight="600" bg={`${statusConf.color}22`} color={statusConf.color}>{statusConf.label}</Box>
              )}
              {a.source === 'api' && <Box px="2" py="0.5" borderRadius="md" fontSize="xs" fontWeight="600" bg="rgba(130,71,229,0.15)" color="#8247E5">API</Box>}
            </HStack>
            <Text as="button" fontSize="lg" color="kk.textMuted" _hover={{ color: 'kk.textPrimary' }} onClick={onClose}>&times;</Text>
          </Flex>

          {/* Body */}
          <VStack px="5" py="4" gap="0" align="stretch">
            {/* Chain */}
            <Flex justify="space-between" align="center" py="1.5" gap="3">
              <Text fontSize="11px" color="kk.textMuted" minW="100px" flexShrink={0}>Chain</Text>
              <HStack gap="2">
                {chainDef && (
                  <Image src={caipToIcon(chainDef.caip)} w="16px" h="16px" borderRadius="full"
                    fallback={<Box w="16px" h="16px" borderRadius="full" bg={chainDef.color} />}
                  />
                )}
                <Text fontSize="11px" color="kk.textPrimary" fontWeight="600">{chainDef?.coin || a.chain} ({chainSymbol})</Text>
              </HStack>
            </Flex>

            {/* Amount */}
            {amountValue && <TxDetailRow label="Amount" value={`${amountValue.amount} ${a.asset || chainSymbol}${amountValue.usd ? ` (${amountValue.usd})` : ''}`} />}

            {/* Received (swap output, when this activity is a swap) */}
            {a.type === 'swap' && a.outAmount && <TxDetailRow label="Received" value={`${a.outAmount} ${a.outAsset || ''}`.trim()} color="var(--teal)" />}

            {/* Fee */}
            {feeValue && <TxDetailRow label="Fee" value={`${feeValue.amount} ${chainSymbol}${feeValue.usd ? ` (${feeValue.usd})` : ''}`} />}

            {/* Separator */}
            <Box h="1px" bg="kk.border" my="2" />

            {/* TxID */}
            {a.txid && <CopyableRow label="Transaction ID" value={a.txid} explorerUrl={explorerUrl} />}

            {/* From address (counterparty — most useful for received txs) */}
            {a.from && <CopyableRow label="From" value={a.from} explorerUrl={explorerFromUrl} />}

            {/* To address */}
            {a.to && <CopyableRow label="To" value={a.to} explorerUrl={explorerAddrUrl} />}

            {/* Confirmations */}
            {a.confirmations !== undefined && (
              <Flex justify="space-between" align="center" py="1.5" gap="3">
                <Text fontSize="11px" color="kk.textMuted" minW="100px" flexShrink={0}>Confirmations</Text>
                <HStack gap="2">
                  <ConfBadge confirmations={a.confirmations} chain={a.chain} />
                  <Text fontSize="11px" color="kk.textMuted">({a.confirmations} / {required})</Text>
                </HStack>
              </Flex>
            )}

            {/* Block height */}
            {a.blockHeight ? <TxDetailRow label="Block" value={String(a.blockHeight)} mono /> : null}

            {/* Source — how this record reached us (on-chain scan / in-app / external app) */}
            <TxDetailRow label="Source" value={SOURCE_LABELS[a.source] || a.source} />

            {/* App name */}
            {a.appName && <TxDetailRow label="App" value={a.appName} />}

            {/* Timestamp */}
            <TxDetailRow label="Time" value={formatFullDate(a.createdAt)} />

            {/* Explorer button */}
            {explorerUrl && (
              <Box mt="3">
                <Flex
                  as="button" w="100%" justify="center" align="center" gap="2"
                  bg="rgba(139,227,196,0.10)" border="1px solid" borderColor="rgba(139,227,196,0.30)"
                  borderRadius="lg" py="2" cursor="pointer"
                  _hover={{ bg: 'rgba(139,227,196,0.18)' }} transition="all 0.15s"
                  onClick={() => rpcRequest('openUrl', { url: explorerUrl }).catch(() => {})}
                >
                  <Text fontSize="xs" fontWeight="600" color="var(--teal)">View on Explorer</Text>
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--teal)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
                    <polyline points="15 3 21 3 21 9" />
                    <line x1="10" y1="14" x2="21" y2="3" />
                  </svg>
                </Flex>
              </Box>
            )}
          </VStack>
        </Box>
      </Box>
    )
  }

  // ── Swap detail ───────────────────────────────────────────────────
  const s = detail.swap
  const inboundUrl = getExplorerTxUrl(s.fromChainId, s.txid)
  // Refunds outbound on source chain (Maya returns inbound asset). Prefer the
  // classifier-populated outboundChainId so refunded ETH→ZEC opens Etherscan,
  // not a Zcash explorer pointed at a non-existent hash.
  const outboundUrl = s.outboundTxid ? getExplorerTxUrl(s.outboundChainId || s.toChainId, s.outboundTxid) : null
  const isFinal = s.status === 'completed' || s.status === 'failed' || s.status === 'refunded'

  return (
    <Box position="fixed" inset="0" zIndex={Z.dialog} display="flex" alignItems="center" justifyContent="center" onClick={onClose}>
      <Box position="absolute" inset="0" bg="blackAlpha.700" />
      <Box
        position="relative" bg="kk.cardBg" border="1px solid" borderColor="kk.border"
        borderRadius="xl" w="440px" maxW="95vw" maxH="85vh" overflow="auto"
        onClick={e => e.stopPropagation()}
        boxShadow="0 12px 40px rgba(0,0,0,0.6)"
        style={{ animation: 'kkTxDetailFadeIn 0.15s ease-out' }}
      >
        {/* Header */}
        <Flex px="5" py="3" borderBottom="1px solid" borderColor="kk.border" align="center" justify="space-between">
          <HStack gap="2">
            <Box px="2" py="0.5" borderRadius="md" fontSize="xs" fontWeight="700" bg="rgba(233,196,106,0.15)" color="var(--gold)">Swap</Box>
            <Text fontSize="sm" fontWeight="600" color="kk.textPrimary">{s.fromSymbol} &rarr; {s.toSymbol}</Text>
            <SwapStatusBadge status={s.status} />
          </HStack>
          <Text as="button" fontSize="lg" color="kk.textMuted" _hover={{ color: 'kk.textPrimary' }} onClick={onClose}>&times;</Text>
        </Flex>

        {/* Body */}
        <VStack px="5" py="4" gap="0" align="stretch">
          <TxDetailRow label="From" value={`${s.fromAmount} ${s.fromSymbol}`} />
          <TxDetailRow label="Expected" value={`${s.expectedOutput} ${s.toSymbol}`} />
          {s.integration && <TxDetailRow label="Integration" value={s.integration} />}

          <Box h="1px" bg="kk.border" my="2" />

          <CopyableRow label="Inbound TX" value={s.txid} explorerUrl={inboundUrl} />
          {s.outboundTxid && <CopyableRow label="Outbound TX" value={s.outboundTxid} explorerUrl={outboundUrl} />}
          {s.inboundAddress && <CopyableRow label="Inbound Address" value={s.inboundAddress} />}
          {s.memo && <CopyableRow label="Memo" value={s.memo} />}
          {s.router && <CopyableRow label="Router" value={s.router} />}

          <Box h="1px" bg="kk.border" my="2" />

          {/* Confirmations */}
          {s.confirmations > 0 && <TxDetailRow label="Inbound Confs" value={String(s.confirmations)} />}
          {s.outboundConfirmations !== undefined && s.outboundRequiredConfirmations !== undefined && (
            <TxDetailRow label="Outbound Confs" value={`${s.outboundConfirmations} / ${s.outboundRequiredConfirmations}`} />
          )}

          {s.error && <TxDetailRow label="Error" value={s.error} color="var(--rose)" />}

          <TxDetailRow label="Started" value={formatFullDate(s.createdAt)} />
          {s.estimatedTime > 0 && <TxDetailRow label="Est. Time" value={`${Math.floor(s.estimatedTime / 60)}m ${s.estimatedTime % 60}s`} />}

          {/* Explorer buttons */}
          <HStack gap="2" mt="3">
            {inboundUrl && (
              <Flex
                as="button" flex="1" justify="center" align="center" gap="2"
                bg="rgba(139,227,196,0.10)" border="1px solid" borderColor="rgba(139,227,196,0.30)"
                borderRadius="lg" py="2" cursor="pointer"
                _hover={{ bg: 'rgba(139,227,196,0.18)' }} transition="all 0.15s"
                onClick={() => rpcRequest('openUrl', { url: inboundUrl }).catch(() => {})}
              >
                <Text fontSize="xs" fontWeight="600" color="var(--teal)">Inbound Explorer</Text>
              </Flex>
            )}
            {outboundUrl && (
              <Flex
                as="button" flex="1" justify="center" align="center" gap="2"
                bg="rgba(233,196,106,0.10)" border="1px solid" borderColor="rgba(233,196,106,0.30)"
                borderRadius="lg" py="2" cursor="pointer"
                _hover={{ bg: 'rgba(233,196,106,0.18)' }} transition="all 0.15s"
                onClick={() => rpcRequest('openUrl', { url: outboundUrl }).catch(() => {})}
              >
                <Text fontSize="xs" fontWeight="600" color="var(--gold)">Outbound Explorer</Text>
              </Flex>
            )}
          </HStack>
        </VStack>
      </Box>
    </Box>
  )
}

export function ActivityRow({ activity, onSelect, nativePrices }: { activity: RecentActivity; onSelect: (a: RecentActivity) => void; nativePrices: Record<string, number> }) {
  const [copied, setCopied] = useState(false)
  const typeConf = TYPE_CONFIG[activity.type] || TYPE_CONFIG.sign
  const chainDef = CHAINS.find(c => activity.chainId && c.id === activity.chainId) || CHAINS.find(c => c.symbol === activity.chain || c.id === activity.chain)
  const chainSymbol = chainDef?.symbol || activity.chain
  const nativePrice = chainDef ? nativePrices[chainDef.id] : undefined

  const handleCopy = (text: string) => {
    navigator.clipboard.writeText(text)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  const explorerUrl = activity.txid ? getExplorerUrl(activity.chainId || activity.chain, activity.txid) : null

  const isUnconfirmed = activity.confirmations !== undefined && activity.confirmations === 0
  const chainLabel = `${chainDef?.coin || activity.chain} (${chainSymbol})`
  const nativeAmount = formatNativeValue(activity.amount, chainDef, activity.source, nativePrice)
  const nativeFee = formatNativeValue(activity.fee, chainDef, activity.source, nativePrice)
  const amountLine = activity.type === 'swap' && (activity.amount || activity.outAmount)
    ? `${activity.amount ? `${activity.amount} ${activity.asset || activity.chain}` : ''}${activity.amount || activity.outAmount ? ' \u2192 ' : ''}${activity.outAmount ? `${activity.swapStatus === 'completed' ? '' : '~'}${activity.outAmount} ${activity.outAsset || ''}` : activity.outAsset || '?'}`
    : nativeAmount || nativeFee
      ? `${nativeAmount ? `${nativeAmount.amount} ${activity.asset || chainSymbol}${nativeAmount.usd ? ` (${nativeAmount.usd})` : ''}` : ''}${nativeAmount && nativeFee ? '  ' : ''}${nativeFee ? `fee: ${nativeFee.amount} ${chainSymbol}${nativeFee.usd ? ` (${nativeFee.usd})` : ''}` : ''}`
      : null

  return (
    <Box
      bg="rgba(255,255,255,0.03)"
      border="1px solid"
      borderColor={isUnconfirmed ? 'rgba(229,62,62,0.3)' : 'rgba(255,255,255,0.06)'}
      borderRadius="lg" px="3" py="2.5"
      cursor="pointer"
      _hover={{ bg: "rgba(255,255,255,0.06)", borderColor: 'rgba(35,220,200,0.25)' }}
      transition="all 0.15s"
      onClick={() => onSelect(activity)}
    >
      <Flex justify="space-between" align="flex-start" gap="2">
        <HStack gap="2" minW="0" flex="1" align="flex-start">
          {chainDef ? (
            <Image src={caipToIcon(chainDef.caip)} w="16px" h="16px" mt="1px" borderRadius="full" flexShrink={0}
              fallback={<Box w="16px" h="16px" mt="1px" borderRadius="full" bg={chainDef.color} flexShrink={0} />}
            />
          ) : (
            <Box w="16px" h="16px" mt="1px" borderRadius="full" bg="whiteAlpha.200" flexShrink={0} />
          )}
          <Box minW="0" flex="1">
            <HStack gap="1.5" minW="0">
              <Text fontSize="xs" fontWeight="700" color="white" truncate>{chainLabel}</Text>
              <Box px="1.5" py="0.5" borderRadius="sm" fontSize="2xs" lineHeight="1" fontWeight="700" bg={`${typeConf.color}22`} color={typeConf.color} flexShrink={0}>{typeConf.label}</Box>
              {activity.source === 'api' && (
                <Box px="1.5" py="0.5" borderRadius="sm" fontSize="2xs" lineHeight="1" fontWeight="700" bg="rgba(130,71,229,0.15)" color="#8247E5" flexShrink={0}>API</Box>
              )}
            </HStack>
            {amountLine && <Text fontSize="2xs" color="whiteAlpha.500" mt="0.5" truncate>{amountLine}</Text>}
          </Box>
        </HStack>
        <VStack gap="0.5" align="flex-end" flexShrink={0}>
          {activity.type === 'swap' && activity.swapStatus ? (
            <SwapStatusBadge status={activity.swapStatus} />
          ) : (
            <ConfBadge confirmations={activity.confirmations} chain={chainSymbol} />
          )}
          <Text fontSize="2xs" color="whiteAlpha.300">{timeAgo(activity.createdAt)}</Text>
        </VStack>
      </Flex>
      <Flex justify="space-between" align="center" gap="2" mt="1.5">
        {activity.txid ? (
          <Text flex="1" minW="0" fontSize="2xs" color="whiteAlpha.600" fontFamily="mono" cursor="pointer" truncate _hover={{ color: "var(--teal)" }} onClick={(e) => { e.stopPropagation(); handleCopy(activity.txid!) }} title={copied ? 'Copied!' : 'Click to copy'}>
            {copied ? 'Copied!' : truncateTxid(activity.txid)}
          </Text>
        ) : (
          <Text flex="1" minW="0" fontSize="2xs" color="whiteAlpha.400" fontStyle="italic">no txid</Text>
        )}
        <HStack gap="2" flexShrink={0}>
          {activity.blockHeight ? <Text fontSize="9px" color="whiteAlpha.200" fontFamily="mono">blk {activity.blockHeight}</Text> : null}
          {explorerUrl && <Text as="button" fontSize="2xs" color="whiteAlpha.400" _hover={{ color: "var(--teal)" }} onClick={(e) => { e.stopPropagation(); rpcRequest('openUrl', { url: explorerUrl }) }}>Explorer</Text>}
        </HStack>
      </Flex>
    </Box>
  )
}

export function ActivityTableRow({ activity, onSelect, nativePrices }: { activity: RecentActivity; onSelect: (a: RecentActivity) => void; nativePrices: Record<string, number> }) {
  const typeConf = TYPE_CONFIG[activity.type] || TYPE_CONFIG.sign
  const chainDef = CHAINS.find(c => activity.chainId && c.id === activity.chainId) || CHAINS.find(c => c.symbol === activity.chain || c.id === activity.chain)
  const chainSymbol = chainDef?.symbol || activity.chain
  const nativePrice = chainDef ? nativePrices[chainDef.id] : undefined
  const explorerUrl = activity.txid ? getExplorerUrl(activity.chainId || activity.chain, activity.txid) : null
  const nativeAmount = formatNativeValue(activity.amount, chainDef, activity.source, nativePrice)
  const nativeFee = formatNativeValue(activity.fee, chainDef, activity.source, nativePrice)
  const amountLine = activity.type === 'swap' && (activity.amount || activity.outAmount)
    ? `${activity.amount ? `${activity.amount} ${activity.asset || activity.chain}` : ''}${activity.amount || activity.outAmount ? ' → ' : ''}${activity.outAmount ? `${activity.swapStatus === 'completed' ? '' : '~'}${activity.outAmount} ${activity.outAsset || ''}` : activity.outAsset || '?'}`
    : nativeAmount || nativeFee
      ? `${nativeAmount ? `${nativeAmount.amount} ${activity.asset || chainSymbol}${nativeAmount.usd ? ` (${nativeAmount.usd})` : ''}` : ''}${nativeAmount && nativeFee ? '  ' : ''}${nativeFee ? `fee: ${nativeFee.amount} ${chainSymbol}${nativeFee.usd ? ` (${nativeFee.usd})` : ''}` : ''}`
      : (activity.txid ? truncateTxid(activity.txid) : null)

  return (
    <Flex
      align="center" gap="2" px="3" py="1.5"
      cursor="pointer"
      _hover={{ bg: 'rgba(255,255,255,0.04)' }}
      transition="background 0.1s"
      onClick={() => onSelect(activity)}
    >
      {chainDef ? (
        <Image src={caipToIcon(chainDef.caip)} w="18px" h="18px" borderRadius="full" flexShrink={0}
          fallback={<Box w="18px" h="18px" borderRadius="full" bg={chainDef.color} flexShrink={0} />}
        />
      ) : (
        <Box w="18px" h="18px" borderRadius="full" bg="whiteAlpha.200" flexShrink={0} />
      )}
      <HStack gap="1.5" w="170px" flexShrink={0} minW="0">
        <Text fontSize="xs" fontWeight="600" color="white" truncate>{chainDef?.coin || activity.chain} ({chainSymbol})</Text>
        <Box px="1.5" py="0.5" borderRadius="sm" fontSize="2xs" lineHeight="1" fontWeight="700" bg={`${typeConf.color}22`} color={typeConf.color} flexShrink={0}>{typeConf.label}</Box>
      </HStack>
      <Text flex="1" fontSize="xs" color="whiteAlpha.500" truncate minW="0" fontFamily={amountLine && activity.txid && !nativeAmount ? 'mono' : undefined}>
        {amountLine || '—'}
      </Text>
      <Box flexShrink={0} w="90px" display="flex" justifyContent="flex-end">
        {activity.type === 'swap' && activity.swapStatus ? (
          <SwapStatusBadge status={activity.swapStatus} />
        ) : (
          <ConfBadge confirmations={activity.confirmations} chain={chainSymbol} />
        )}
      </Box>
      <Text fontSize="2xs" color="whiteAlpha.300" flexShrink={0} w="50px" textAlign="right">{timeAgo(activity.createdAt)}</Text>
      {explorerUrl ? (
        <Text as="button" fontSize="2xs" color="whiteAlpha.400" _hover={{ color: 'var(--teal)' }} flexShrink={0} w="50px" textAlign="right"
          onClick={e => { e.stopPropagation(); rpcRequest('openUrl', { url: explorerUrl }).catch(() => {}) }}>
          Explorer
        </Text>
      ) : (
        <Box w="50px" flexShrink={0} />
      )}
    </Flex>
  )
}

export function ActivityTable({ activities, nativePrices, onSelect }: { activities: RecentActivity[]; nativePrices: Record<string, number>; onSelect: (a: RecentActivity) => void }) {
  return (
    <Box border="1px solid" borderColor="rgba(255,255,255,0.08)" borderRadius="lg" overflow="hidden">
      <Flex align="center" gap="2" px="3" py="1.5" borderBottom="1px solid" borderColor="rgba(255,255,255,0.08)" bg="rgba(255,255,255,0.02)">
        <Box w="18px" flexShrink={0} />
        <Text fontSize="9px" fontWeight="700" color="whiteAlpha.400" textTransform="uppercase" letterSpacing="0.12em" w="170px" flexShrink={0}>Asset</Text>
        <Text fontSize="9px" fontWeight="700" color="whiteAlpha.400" textTransform="uppercase" letterSpacing="0.12em" flex="1">Amount</Text>
        <Text fontSize="9px" fontWeight="700" color="whiteAlpha.400" textTransform="uppercase" letterSpacing="0.12em" w="90px" textAlign="right">Status</Text>
        <Text fontSize="9px" fontWeight="700" color="whiteAlpha.400" textTransform="uppercase" letterSpacing="0.12em" w="50px" textAlign="right">Time</Text>
        <Box w="50px" flexShrink={0} />
      </Flex>
      {activities.map((a, i) => (
        <Box key={a.id} borderBottom={i < activities.length - 1 ? '1px solid' : undefined} borderColor="rgba(255,255,255,0.06)">
          <ActivityTableRow activity={a} nativePrices={nativePrices} onSelect={onSelect} />
        </Box>
      ))}
    </Box>
  )
}

export function SwapRow({ swap, onSelect }: { swap: PendingSwap; onSelect: (s: PendingSwap) => void }) {
  const [copied, setCopied] = useState(false)
  const handleCopy = (text: string) => { navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 1500) }
  const explorerUrl = getExplorerUrl(swap.fromSymbol, swap.txid)
  const amountLine = swap.fromAmount
    ? `${swap.fromAmount} ${swap.fromSymbol}${swap.expectedOutput ? ` \u2192 ${swap.expectedOutput} ${swap.toSymbol}` : ''}`
    : null

  return (
    <Box bg="rgba(255,255,255,0.03)" border="1px solid" borderColor="rgba(255,255,255,0.06)" borderRadius="lg" px="3" py="2.5"
      cursor="pointer"
      _hover={{ bg: "rgba(255,255,255,0.06)", borderColor: 'rgba(35,220,200,0.25)' }}
      transition="all 0.15s"
      onClick={() => onSelect(swap)}
    >
      <Flex justify="space-between" align="flex-start" gap="2">
        <Box minW="0" flex="1">
          <HStack gap="1.5" minW="0">
            <Text fontSize="xs" fontWeight="700" color="white" truncate>{swap.fromSymbol} {'\u2192'} {swap.toSymbol}</Text>
            <Box px="1.5" py="0.5" borderRadius="sm" fontSize="2xs" lineHeight="1" fontWeight="700" bg="rgba(247,147,26,0.15)" color="#F7931A" flexShrink={0}>Swap</Box>
          </HStack>
          {amountLine && <Text fontSize="2xs" color="whiteAlpha.500" mt="0.5" truncate>{amountLine}</Text>}
        </Box>
        <VStack gap="0.5" align="flex-end" flexShrink={0}>
          <SwapStatusBadge status={swap.status} />
          <Text fontSize="2xs" color="whiteAlpha.300">{timeAgo(swap.createdAt)}</Text>
        </VStack>
      </Flex>
      <Flex justify="space-between" align="center" gap="2" mt="1.5">
        <Text flex="1" minW="0" fontSize="2xs" color="whiteAlpha.600" fontFamily="mono" cursor="pointer" truncate _hover={{ color: "var(--teal)" }} onClick={(e) => { e.stopPropagation(); handleCopy(swap.txid) }} title={copied ? 'Copied!' : 'Click to copy'}>
          {copied ? 'Copied!' : truncateTxid(swap.txid)}
        </Text>
        <HStack gap="2" flexShrink={0}>
          {explorerUrl && <Text as="button" fontSize="2xs" color="whiteAlpha.400" _hover={{ color: "var(--teal)" }} onClick={(e) => { e.stopPropagation(); rpcRequest('openUrl', { url: explorerUrl }) }}>Explorer</Text>}
        </HStack>
      </Flex>
    </Box>
  )
}

/** Refresh/scan icon SVG */
const RefreshIcon = ({ spinning }: { spinning?: boolean }) => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" style={spinning ? { animation: 'spin 1s linear infinite' } : {}}>
    <path d="M13.65 2.35A7.96 7.96 0 0 0 8 0C3.58 0 0 3.58 0 8s3.58 8 8 8c3.73 0 6.84-2.55 7.73-6h-2.08A5.99 5.99 0 0 1 8 14 6 6 0 1 1 8 2c1.66 0 3.14.69 4.22 1.78L9 7h7V0l-2.35 2.35z" fill="currentColor" />
  </svg>
)

type ChainOption = { id: string; symbol: string; coin: string; caip: string; networkId: string; color: string; balanceUsd: number }

/** Custom dropdown with chain logos */
function NetworkSelector({ chainOptions, selectedChain, selectedDef, scanning, scanResult, onSelect, onScan }: {
  chainOptions: ChainOption[]
  selectedChain: string
  selectedDef: ReturnType<typeof CHAINS['find']>
  scanning: boolean
  scanResult: string | null
  onSelect: (id: string) => void
  onScan: () => void
}) {
  const [dropdownOpen, setDropdownOpen] = useState(false)

  return (
    <Flex px="3" pb="2.5" gap="2" align="center" flexShrink={0} position="relative">
      {/* Trigger */}
      <Flex
        flex="1" align="center" gap="2" cursor="pointer"
        bg="rgba(255,255,255,0.05)" border="1px solid" borderColor={dropdownOpen ? 'rgba(35,220,200,0.4)' : 'rgba(255,255,255,0.1)'}
        borderRadius="lg" px="3" py="1.5"
        _hover={{ borderColor: 'rgba(35,220,200,0.3)' }}
        transition="border-color 0.15s"
        onClick={() => setDropdownOpen(!dropdownOpen)}
      >
        {selectedDef ? (
          <Image src={caipToIcon(selectedDef.caip)} w="18px" h="18px" borderRadius="full" flexShrink={0}
            fallback={<Box w="18px" h="18px" borderRadius="full" bg={selectedDef.color} flexShrink={0} />}
          />
        ) : (
          <Box w="18px" h="18px" borderRadius="full" bg="whiteAlpha.200" display="flex" alignItems="center" justifyContent="center" flexShrink={0}>
            <Text fontSize="9px" color="whiteAlpha.600" fontWeight="700">*</Text>
          </Box>
        )}
        <Text flex="1" fontSize="xs" fontWeight="600" color="white" truncate>
          {selectedDef ? `${selectedDef.coin} (${selectedDef.symbol})` : 'All Networks'}
        </Text>
        {selectedDef && <Text fontSize="9px" color="whiteAlpha.300" flexShrink={0} truncate maxW="100px" fontFamily="mono">{selectedDef.networkId}</Text>}
        <Text fontSize="2xs" color="whiteAlpha.400" flexShrink={0}>{dropdownOpen ? '\u25B2' : '\u25BC'}</Text>
      </Flex>

      {/* Refresh icon — disabled when "All" is selected */}
      <Box
        as="button"
        display="flex" alignItems="center" justifyContent="center"
        w="34px" h="34px" borderRadius="lg" flexShrink={0}
        bg={scanning ? 'rgba(255,255,255,0.03)' : !selectedChain ? 'rgba(255,255,255,0.03)' : 'rgba(35,220,200,0.12)'}
        border="1px solid"
        borderColor={scanning || !selectedChain ? 'rgba(255,255,255,0.05)' : 'rgba(35,220,200,0.3)'}
        color={scanning || !selectedChain ? 'whiteAlpha.300' : '#23DCC8'}
        cursor={scanning || !selectedChain ? 'not-allowed' : 'pointer'}
        opacity={!selectedChain ? 0.3 : 1}
        _hover={scanning || !selectedChain ? {} : { bg: 'rgba(35,220,200,0.2)' }}
        transition="all 0.15s"
        onClick={onScan}
        title={!selectedChain ? 'Select a chain to scan' : scanning ? 'Scanning...' : `Scan ${selectedDef?.symbol || ''} history`}
      >
        <RefreshIcon spinning={scanning} />
      </Box>

      {/* Scan result */}
      {scanResult && (
        <Text fontSize="2xs" flexShrink={0} color={scanResult.startsWith('+') ? '#23DCC8' : scanResult === 'Up to date' ? 'whiteAlpha.500' : '#E53E3E'}>
          {scanResult}
        </Text>
      )}

      {/* Dropdown list */}
      {dropdownOpen && (
        <>
          {/* Click-away */}
          <Box position="fixed" inset="0" zIndex={0} onClick={() => setDropdownOpen(false)} />
          <Box
            position="absolute" top="100%" left="16px" right="60px"
            mt="2px" zIndex={1}
            bg="kk.bg" border="1px solid" borderColor="rgba(35,220,200,0.3)"
            borderRadius="lg" overflow="hidden"
            boxShadow="0 8px 24px rgba(0,0,0,0.5)"
          >
            <Box maxH="180px" overflowY="auto" py="1">
              {/* "All" option */}
              <Flex
                align="center" gap="2" px="3" py="1.5"
                cursor="pointer"
                bg={!selectedChain ? 'rgba(35,220,200,0.1)' : 'transparent'}
                _hover={{ bg: 'rgba(255,255,255,0.06)' }}
                transition="background 0.1s"
                onClick={() => { onSelect(''); setDropdownOpen(false) }}
              >
                <Box w="18px" h="18px" borderRadius="full" bg="whiteAlpha.200" display="flex" alignItems="center" justifyContent="center" flexShrink={0}>
                  <Text fontSize="9px" color="whiteAlpha.600" fontWeight="700">*</Text>
                </Box>
                <Text fontSize="xs" fontWeight="600" color="white">All</Text>
                <Text fontSize="2xs" color="whiteAlpha.400" flex="1">All Networks</Text>
                {!selectedChain && <Text fontSize="2xs" color="var(--teal)">{'\u2713'}</Text>}
              </Flex>
              {chainOptions.map(c => (
                <Flex
                  key={c.id}
                  align="center" gap="2" px="3" py="1.5"
                  cursor="pointer"
                  bg={selectedChain === c.id ? 'rgba(35,220,200,0.1)' : 'transparent'}
                  _hover={{ bg: 'rgba(255,255,255,0.06)' }}
                  transition="background 0.1s"
                  onClick={() => { onSelect(c.id); setDropdownOpen(false) }}
                >
                  <Image src={caipToIcon(c.caip)} w="18px" h="18px" borderRadius="full" flexShrink={0}
                    fallback={<Box w="18px" h="18px" borderRadius="full" bg={c.color} flexShrink={0} />}
                  />
                  <Text fontSize="xs" fontWeight="600" color="white">{c.symbol}</Text>
                  <Text fontSize="2xs" color="whiteAlpha.400" flex="1" truncate>{c.coin}</Text>
                  <Text fontSize="9px" color="whiteAlpha.200" flexShrink={0} truncate maxW="90px" fontFamily="mono">{c.networkId}</Text>
                  {selectedChain === c.id && <Text fontSize="2xs" color="var(--teal)">{'\u2713'}</Text>}
                </Flex>
              ))}
            </Box>
          </Box>
        </>
      )}
    </Flex>
  )
}

export function ActivityPanel({ open, onClose, activities, pendingSwaps, onRefresh, onResumeSwap, onOpenFullPage }: ActivityPanelProps) {
  const [tab, setTab] = useState<'activity' | 'swaps'>('activity')
  const [selectedChain, setSelectedChain] = useState<string>('')
  const [scanning, setScanning] = useState(false)
  const [scanResult, setScanResult] = useState<string | null>(null)
  const [availableChains, setAvailableChains] = useState<ChainBalance[]>([])
  const [selectedDetail, setSelectedDetail] = useState<TxDetail | null>(null)

  // Load chains that have balances
  useEffect(() => {
    if (!open) return
    rpcRequest<{ balances: ChainBalance[]; updatedAt: number } | null>('getCachedBalances')
      .then(result => {
        if (result?.balances) {
          setAvailableChains(result.balances)
        }
      })
      .catch(() => {})
  }, [open])

  const chainMap = useMemo(() => new Map(CHAINS.map(c => [c.id, c])), [])
  const chainOptions = useMemo(() => {
    return availableChains
      .map(b => {
        const def = chainMap.get(b.chainId)
        if (!def) return null
        return { id: def.id, symbol: def.symbol, coin: def.coin, caip: def.caip, networkId: def.networkId, color: def.color, balanceUsd: b.balanceUsd }
      })
      .filter((c): c is NonNullable<typeof c> => c !== null)
      .sort((a, b) => b.balanceUsd - a.balanceUsd)
  }, [availableChains, chainMap])
  const nativePrices = useMemo(() => nativePriceByChain(availableChains), [availableChains])

  const selectedDef = useMemo(() => CHAINS.find(c => c.id === selectedChain), [selectedChain])

  // Filter activities to selected chain (empty = all)
  const filteredActivities = useMemo(() => {
    const next = selectedDef
      ? activities.filter(a => a.chainId ? a.chainId === selectedDef.id : (a.chain === selectedDef.symbol || a.chain === selectedDef.id))
      : activities
    return recentFirst(next)
  }, [activities, selectedDef])

  const activeSwaps = useMemo(() =>
    recentFirst(pendingSwaps.filter(s => s.status !== 'completed' && s.status !== 'failed' && s.status !== 'refunded')),
    [pendingSwaps]
  )

  const filteredSwaps = useMemo(() => {
    const next = selectedDef
      ? activeSwaps.filter(s => s.fromSymbol === selectedDef.symbol || s.toSymbol === selectedDef.symbol || s.fromChainId === selectedDef.id || s.toChainId === selectedDef.id)
      : activeSwaps
    return recentFirst(next)
  }, [activeSwaps, selectedDef])

  const nonSwapActivities = useMemo(() => {
    const swapTxids = new Set(pendingSwaps.map(s => s.txid))
    return recentFirst(filteredActivities.filter(a => !(a.type === 'swap' && a.txid && swapTxids.has(a.txid))))
  }, [filteredActivities, pendingSwaps])

  const activityTimeline = useMemo<ActivityTimelineItem[]>(() => {
    return recentFirst([
      ...filteredSwaps.map(swap => ({ kind: 'swap' as const, id: `swap-${swap.txid}`, createdAt: swap.createdAt, swap })),
      ...nonSwapActivities.map(activity => ({ kind: 'activity' as const, id: `activity-${activity.id}`, createdAt: activity.createdAt, activity })),
    ])
  }, [filteredSwaps, nonSwapActivities])

  const recentPendingSwaps = useMemo(() => recentFirst(pendingSwaps), [pendingSwaps])

  const fetchingSwapRef = useRef(false)
  const scanningRef = useRef(false)
  const handleScan = useCallback(async () => {
    if (!selectedChain || scanningRef.current) return
    scanningRef.current = true
    setScanning(true)
    setScanResult(null)
    try {
      const result = await rpcRequest<{ count: number }>('scanChainHistory', { chainId: selectedChain }, 60000)
      setScanResult(result.count > 0 ? `+${result.count} tx${result.count > 1 ? 's' : ''}` : 'Up to date')
      onRefresh()
    } catch (e: any) {
      setScanResult(e.message || 'Failed')
    } finally {
      scanningRef.current = false
      setScanning(false)
    }
  }, [selectedChain, onRefresh])

  useEffect(() => { setScanResult(null) }, [selectedChain])

  if (!open) return null

  return (
    <>
      <style>{`
        @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
        @keyframes kkTxDetailFadeIn { from { opacity: 0; transform: scale(0.96) translateY(8px); } to { opacity: 1; transform: scale(1) translateY(0); } }
      `}</style>
      <Box position="fixed" inset="0" bg="blackAlpha.600" zIndex={Z.drawerBackdrop} onClick={onClose} />

      <Box
        position="fixed" bottom="0" right="0"
        w="min(100vw, 430px)" h="min(72vh, 680px)" maxH="calc(100vh - 20px)"
        bg="kk.bg" border="1px solid" borderColor="kk.border" borderTopLeftRadius="xl"
        zIndex={Z.drawerPanel} display="flex" flexDirection="column" overflow="hidden"
      >
        {/* Header */}
        <Flex px="4" pt="4" pb="2" justify="space-between" align="center" flexShrink={0}>
          <Text fontSize="sm" fontWeight="700" color="white">Recent Activity</Text>
          <HStack gap="2">
            {onOpenFullPage && (
              <Text
                as="button" fontSize="xs" color="var(--teal)" fontWeight="600"
                _hover={{ opacity: 0.75 }} transition="opacity 0.15s"
                onClick={() => { onClose(); onOpenFullPage() }}
                display="flex" alignItems="center" gap="1"
              >
                Full page
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M5 12h14M12 5l7 7-7 7"/>
                </svg>
              </Text>
            )}
            <Text as="button" fontSize="sm" color="whiteAlpha.500" _hover={{ color: "white" }} onClick={onClose} fontWeight="600">&times;</Text>
          </HStack>
        </Flex>

        {/* Tabs */}
        <Flex px="4" pb="2" gap="3" flexShrink={0}>
          <Text
            as="button" fontSize="xs"
            fontWeight={tab === 'activity' ? '700' : '500'}
            color={tab === 'activity' ? '#23DCC8' : 'whiteAlpha.500'}
            borderBottom={tab === 'activity' ? '2px solid #23DCC8' : '2px solid transparent'}
            pb="1" onClick={() => setTab('activity')}
          >
            History
          </Text>
          {pendingSwaps.length > 0 && (
            <Text
              as="button" fontSize="xs"
              fontWeight={tab === 'swaps' ? '700' : '500'}
              color={tab === 'swaps' ? '#F7931A' : 'whiteAlpha.500'}
              borderBottom={tab === 'swaps' ? '2px solid #F7931A' : '2px solid transparent'}
              pb="1" onClick={() => setTab('swaps')}
            >
              Swaps ({pendingSwaps.length})
            </Text>
          )}
        </Flex>

        {/* Network selector + refresh */}
        {tab === 'activity' && (
          <NetworkSelector
            chainOptions={chainOptions}
            selectedChain={selectedChain}
            selectedDef={selectedDef}
            scanning={scanning}
            scanResult={scanResult}
            onSelect={setSelectedChain}
            onScan={handleScan}
          />
        )}

        {/* Content */}
        <Box flex="1" overflowY="auto" px="3" pb="3">
          <VStack gap="1.5" align="stretch">
            {tab === 'activity' && (
              <>
                {activityTimeline.map(item => item.kind === 'swap' ? (
                  <SwapRow key={item.id} swap={item.swap} onSelect={s => onResumeSwap ? onResumeSwap(s) : setSelectedDetail({ kind: 'swap', swap: s })} />
                ) : (
                  <ActivityRow key={item.id} activity={item.activity} nativePrices={nativePrices} onSelect={a => {
                    if (a.type === 'swap' && a.txid && onResumeSwap) {
                      if (fetchingSwapRef.current) return
                      fetchingSwapRef.current = true
                      rpcRequest<PendingSwap | null>('getSwapByTxid', { txid: a.txid })
                        .then(swap => { if (swap) onResumeSwap(swap); else setSelectedDetail({ kind: 'activity', activity: a }) })
                        .catch(() => setSelectedDetail({ kind: 'activity', activity: a }))
                        .finally(() => { fetchingSwapRef.current = false })
                    } else {
                      setSelectedDetail({ kind: 'activity', activity: a })
                    }
                  }} />
                ))}
                {activityTimeline.length === 0 && (
                  <Text fontSize="xs" color="whiteAlpha.400" textAlign="center" py="8">
                    {selectedDef ? `No indexed ${selectedDef.symbol} activity. Refresh to scan.` : 'No indexed activity loaded. Choose a network to scan.'}
                  </Text>
                )}
              </>
            )}
            {tab === 'swaps' && (
              <>
                {recentPendingSwaps.map(swap => (
                  <SwapRow key={`swap-${swap.txid}`} swap={swap} onSelect={s => onResumeSwap ? onResumeSwap(s) : setSelectedDetail({ kind: 'swap', swap: s })} />
                ))}
                {recentPendingSwaps.length === 0 && (
                  <Text fontSize="xs" color="whiteAlpha.400" textAlign="center" py="8">No swaps</Text>
                )}
              </>
            )}
          </VStack>
        </Box>
      </Box>

      {/* TX Detail Dialog */}
      {selectedDetail && (
        <TxDetailDialog detail={selectedDetail} nativePrices={nativePrices} onClose={() => setSelectedDetail(null)} />
      )}
    </>
  )
}
