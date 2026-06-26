import { useEffect, useMemo, useRef, useState } from "react"
import { Box, Flex, Text, Image, Input } from "@chakra-ui/react"
import { CHAINS, isChainSupported, type ChainDef } from "../../shared/chains"
import { getAssetIcon } from "../../shared/assetLookup"
import type { ChainBalance, TokenBalance } from "../../shared/types"
import { Z } from "../lib/z-index"
import { dispatchVaultCommand } from "../lib/commandBus"
import { useFiat } from "../lib/fiat-context"

interface CommandPaletteProps {
	open: boolean
	onClose: () => void
	/** Called before dispatching commands so App can switch to the vault tab. */
	onJumpToVault: () => void
	/** Latest balances snapshot (bridged out of Dashboard). Empty Map is fine —
	 *  results just fall back to chains-only. */
	balances: Map<string, ChainBalance>
	/** Device firmware version — used to filter chains that require newer firmware. */
	firmwareVersion?: string
	/** Hive feature flag — Hive is hidden from results unless explicitly enabled in settings. */
	hiveEnabled?: boolean
}

type ChainResult = { kind: "chain"; chain: ChainDef; balanceUsd: number }
type TokenResult = { kind: "token"; chain: ChainDef; token: TokenBalance }
type Result = ChainResult | TokenResult

const MAX_RESULTS = 60

function scoreMatch(query: string, fields: { symbol?: string; coin?: string; name?: string; caip?: string }): number {
	if (!query) return 1
	const q = query.toLowerCase()
	const sym = (fields.symbol || "").toLowerCase()
	const coin = (fields.coin || "").toLowerCase()
	const name = (fields.name || "").toLowerCase()
	const caip = (fields.caip || "").toLowerCase()

	// Exact symbol match wins (e.g. typing "BTC")
	if (sym === q) return 1000
	// Symbol starts-with (e.g. "et" -> ETH)
	if (sym.startsWith(q)) return 600
	// Coin / name starts-with
	if (coin.startsWith(q) || name.startsWith(q)) return 500
	// CAIP starts-with (e.g. "eip155:1" -> Ethereum)
	if (caip.startsWith(q)) return 400
	// Substring contains
	if (sym.includes(q) || coin.includes(q) || name.includes(q)) return 200
	if (caip.includes(q)) return 100
	return 0
}

export function CommandPalette({ open, onClose, onJumpToVault, balances, firmwareVersion, hiveEnabled }: CommandPaletteProps) {
	const { privateModeEnabled } = useFiat()
	const [query, setQuery] = useState("")
	const [activeIdx, setActiveIdx] = useState(0)
	const inputRef = useRef<HTMLInputElement>(null)
	const listRef = useRef<HTMLDivElement>(null)

	// Reset on open
	useEffect(() => {
		if (open) {
			setQuery("")
			setActiveIdx(0)
			// Auto-focus the input on next frame to win against any other focus moves.
			const id = requestAnimationFrame(() => inputRef.current?.focus())
			return () => cancelAnimationFrame(id)
		}
	}, [open])

	const results = useMemo<Result[]>(() => {
		const chains = CHAINS.filter(c => !c.hidden && isChainSupported(c, firmwareVersion) && (c.id !== 'hive' || hiveEnabled))
		const trimmed = query.trim()

		if (!trimmed) {
			// Empty query: chains only, top-balance first, then alphabetical
			return chains
				.map(chain => ({ kind: "chain" as const, chain, balanceUsd: balances.get(chain.id)?.balanceUsd ?? 0 }))
				.sort((a, b) => {
					if (b.balanceUsd !== a.balanceUsd) return b.balanceUsd - a.balanceUsd
					return a.chain.coin.localeCompare(b.chain.coin)
				})
				.slice(0, MAX_RESULTS)
		}

		const scored: Array<{ r: Result; score: number }> = []
		for (const chain of chains) {
			const s = scoreMatch(trimmed, { symbol: chain.symbol, coin: chain.coin, caip: chain.caip })
			if (s > 0) scored.push({ r: { kind: "chain", chain, balanceUsd: balances.get(chain.id)?.balanceUsd ?? 0 }, score: s + 50 })
		}
		// Token results across all balances
		for (const bal of balances.values()) {
			const chain = chains.find(c => c.id === bal.chainId)
			if (!chain) continue
			for (const token of bal.tokens || []) {
				const s = scoreMatch(trimmed, { symbol: token.symbol, name: token.name, caip: token.caip })
				if (s > 0) scored.push({ r: { kind: "token", chain, token }, score: s })
			}
		}
		scored.sort((a, b) => b.score - a.score)
		return scored.slice(0, MAX_RESULTS).map(s => s.r)
	}, [query, balances, hiveEnabled])

	// Clamp active index when results change
	useEffect(() => {
		if (activeIdx >= results.length) setActiveIdx(Math.max(0, results.length - 1))
	}, [results.length, activeIdx])

	// Scroll active row into view
	useEffect(() => {
		const list = listRef.current
		if (!list) return
		const row = list.querySelector<HTMLDivElement>(`[data-cp-row="${activeIdx}"]`)
		if (row) row.scrollIntoView({ block: "nearest" })
	}, [activeIdx])

	const select = (r: Result) => {
		onJumpToVault()
		if (r.kind === "chain") {
			dispatchVaultCommand({ type: "open-chain", chainId: r.chain.id })
		} else {
			dispatchVaultCommand({ type: "open-token", chainId: r.chain.id, tokenCaip: r.token.caip })
		}
		onClose()
	}

	const onKeyDown = (e: React.KeyboardEvent) => {
		if (e.key === "Escape") {
			e.preventDefault()
			onClose()
			return
		}
		if (e.key === "ArrowDown") {
			e.preventDefault()
			setActiveIdx(i => Math.min(results.length - 1, i + 1))
			return
		}
		if (e.key === "ArrowUp") {
			e.preventDefault()
			setActiveIdx(i => Math.max(0, i - 1))
			return
		}
		if (e.key === "Enter") {
			e.preventDefault()
			const r = results[activeIdx]
			if (r) select(r)
			return
		}
	}

	if (!open) return null

	return (
		<Box
			position="fixed"
			inset="0"
			zIndex={Z.dialog + 5}
			bg="rgba(0,0,0,0.7)"
			backdropFilter="blur(10px)"
			display="flex"
			alignItems="flex-start"
			justifyContent="center"
			pt="14vh"
			onClick={(e) => { if (e.target === e.currentTarget) onClose() }}
			onKeyDown={onKeyDown}
			role="dialog"
			aria-modal="true"
			aria-label="Command Palette"
		>
			<Box
				bg="#101015"
				border="1px solid rgba(255,255,255,0.12)"
				borderRadius="xl"
				w="560px"
				maxW="92vw"
				maxH="70vh"
				display="flex"
				flexDirection="column"
				overflow="hidden"
				boxShadow="0 24px 64px rgba(0,0,0,0.7), 0 1px 0 rgba(255,255,255,0.05) inset"
				onClick={(e) => e.stopPropagation()}
				style={{ fontFamily: "var(--font-mono, ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace)", color: "#f5f4ef" }}
			>
				{/* Search row */}
				<Flex
					align="center"
					gap="3"
					px="4"
					py="3.5"
					borderBottom="1px solid rgba(255,255,255,0.08)"
					bg="rgba(0,0,0,0.4)"
				>
					<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#56564f" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
						<circle cx="11" cy="11" r="8" />
						<path d="M21 21l-4.35-4.35" />
					</svg>
					<Input
						ref={inputRef}
						value={query}
						onChange={(e) => { setQuery(e.target.value); setActiveIdx(0) }}
						placeholder="Search chains and tokens — name, symbol, CAIP"
						variant="unstyled"
						border="0"
						outline="none"
						bg="transparent"
						color="#f5f4ef"
						fontSize="14px"
						lineHeight="1.4"
						py="0"
						minH="0"
						h="auto"
						_placeholder={{ color: "#56564f" }}
						_focus={{ outline: "none", boxShadow: "none", borderColor: "transparent" }}
						_focusVisible={{ outline: "none", boxShadow: "none", borderColor: "transparent" }}
						spellCheck={false}
						autoComplete="off"
						style={{ fontFamily: "inherit", background: "transparent" }}
					/>
					<Box
						fontSize="10px"
						color="var(--text-3)"
						px="2"
						py="0.5"
						borderRadius="md"
						bg="var(--ink-3)"
						border="1px solid var(--line)"
						flexShrink={0}
						letterSpacing="0.05em"
						textTransform="uppercase"
						fontWeight={500}
					>
						esc
					</Box>
				</Flex>

				{/* Result list */}
				<Box ref={listRef} overflowY="auto" flex="1" minH="0" py="1" bg="#101015">
					{results.length === 0 ? (
						<Flex align="center" justify="center" py="10">
							<Text fontSize="13px" color="#8a8a82">No matches</Text>
						</Flex>
					) : (
						results.map((r, idx) => {
							const isActive = idx === activeIdx
							const caip = r.kind === "chain" ? r.chain.caip : r.token.caip
							const icon = getAssetIcon(caip)
							const primary = r.kind === "chain" ? r.chain.coin : r.token.name
							const secondary = r.kind === "chain"
								? r.chain.symbol
								: `${r.token.symbol} on ${r.chain.coin}`
							const trailing = privateModeEnabled
								? (r.kind === "chain" && r.balanceUsd > 0) || (r.kind === "token" && r.token.balanceUsd > 0) ? "••••••" : ""
								: r.kind === "chain" && r.balanceUsd > 0
									? `$${r.balanceUsd.toFixed(2)}`
									: r.kind === "token" && r.token.balanceUsd > 0
										? `$${r.token.balanceUsd.toFixed(2)}`
										: ""
							return (
								<Flex
									key={`${r.kind}:${r.kind === "chain" ? r.chain.id : r.token.caip}:${idx}`}
									data-cp-row={idx}
									align="center"
									gap="3"
									px="4"
									py="2.5"
									cursor="pointer"
									bg={isActive ? "#16161d" : "transparent"}
									borderLeft="2px solid"
									borderColor={isActive ? "#e9c46a" : "transparent"}
									onMouseEnter={() => setActiveIdx(idx)}
									onClick={() => select(r)}
								>
									<Box w="22px" h="22px" flexShrink={0} borderRadius="full" overflow="hidden" bg="rgba(255,255,255,0.06)">
										<Image
											src={icon}
											alt=""
											w="22px"
											h="22px"
											loading="lazy"
											onError={(e: React.SyntheticEvent<HTMLImageElement>) => { e.currentTarget.style.opacity = "0" }}
										/>
									</Box>
									<Flex direction="column" flex="1" minW="0" gap="0">
										<Text fontSize="13px" color="#f5f4ef" lineHeight="1.3" overflow="hidden" textOverflow="ellipsis" whiteSpace="nowrap" style={{ fontFamily: "inherit" }}>
											{primary}
										</Text>
										<Text fontSize="11px" color="#8a8a82" lineHeight="1.3" overflow="hidden" textOverflow="ellipsis" whiteSpace="nowrap" style={{ fontFamily: "inherit" }}>
											{secondary}
										</Text>
									</Flex>
									{trailing && (
										<Text fontSize="11px" color="#c8c7be" flexShrink={0} style={{ fontFamily: "inherit" }}>
											{trailing}
										</Text>
									)}
								</Flex>
							)
						})
					)}
				</Box>

				{/* Footer hint row */}
				<Flex
					align="center"
					justify="space-between"
					px="4"
					py="2"
					borderTop="1px solid"
					borderColor="kk.border"
					bg="rgba(0,0,0,0.25)"
					fontSize="10px"
					color="kk.textMuted"
				>
					<Flex gap="3" align="center">
						<Text>↑↓ navigate</Text>
						<Text>↵ open</Text>
					</Flex>
					<Text>{results.length} result{results.length === 1 ? "" : "s"}</Text>
				</Flex>
			</Box>
		</Box>
	)
}
