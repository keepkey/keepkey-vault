import { useState, useEffect, useCallback, useRef } from "react"
import { Box, Flex, Text, Button, Input, Spinner } from "@chakra-ui/react"
import { useTranslation } from "react-i18next"
import { rpcRequest } from "../lib/rpc"
import { Z } from "../lib/z-index"
import type { Bip85SeedMeta } from "../../shared/types"

interface Bip85VaultDialogProps {
	onClose: () => void
}

export function Bip85VaultDialog({ onClose }: Bip85VaultDialogProps) {
	const { t } = useTranslation("settings")

	// Create form
	const [creating, setCreating] = useState(false)
	const [label, setLabel] = useState("")
	const [wordCount, setWordCount] = useState<12 | 18 | 24>(12)
	const [showAdvanced, setShowAdvanced] = useState(false)
	const [customIndex, setCustomIndex] = useState<string>("")  // empty = auto

	// Derive state
	const [deriving, setDeriving] = useState(false)
	const [displayedSeed, setDisplayedSeed] = useState<{ wordCount: number; index: number; derivationPath: string } | null>(null)
	const [error, setError] = useState<string | null>(null)

	// Saved seeds
	const [savedSeeds, setSavedSeeds] = useState<Bip85SeedMeta[]>([])
	const [loadingSeeds, setLoadingSeeds] = useState(true)
	const [confirmDeleteKey, setConfirmDeleteKey] = useState<string | null>(null)
	const [activeViewKey, setActiveViewKey] = useState<string | null>(null)

	// Animation: track just-created seed key for green highlight
	const [justCreatedKey, setJustCreatedKey] = useState<string | null>(null)
	const highlightTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

	// Load saved seeds on mount — pure DB read, no device needed
	useEffect(() => {
		;(async () => {
			try {
				const seeds = await rpcRequest<Bip85SeedMeta[]>("listBip85Seeds", undefined, 5000)
				setSavedSeeds(seeds)
			} catch (e: any) {
				console.warn("Failed to load BIP-85 seeds:", e.message)
			} finally {
				setLoadingSeeds(false)
			}
		})()
	}, [])

	useEffect(() => {
		return () => {
			if (highlightTimer.current) clearTimeout(highlightTimer.current)
		}
	}, [])

	useEffect(() => {
		const handler = (e: KeyboardEvent) => { if (e.key === "Escape") onClose() }
		window.addEventListener("keydown", handler)
		return () => window.removeEventListener("keydown", handler)
	}, [onClose])

	const clearDisplay = useCallback(() => {
		setDisplayedSeed(null)
		setError(null)
		setActiveViewKey(null)
	}, [])

	/** Compute next available index for a given word count */
	const nextIndex = useCallback((wc: 12 | 18 | 24) => {
		const used = savedSeeds.filter((s) => s.wordCount === wc).map((s) => s.index)
		if (used.length === 0) return 0
		return Math.max(...used) + 1
	}, [savedSeeds])

	/** Derive a new seed — device displays it on screen */
	const handleCreate = useCallback(async () => {
		const parsedCustom = customIndex.trim() !== '' ? parseInt(customIndex.trim(), 10) : NaN
		const idx = Number.isFinite(parsedCustom) && parsedCustom >= 0 ? parsedCustom : nextIndex(wordCount)
		const seedLabel = label.trim() || `Seed ${savedSeeds.length + 1}`
		clearDisplay()
		setDeriving(true)
		try {
			const result = await rpcRequest<{ displayed: boolean; derivationPath: string; wordCount: number; index: number }>(
				"getBip85Mnemonic",
				{ wordCount, index: idx, label: seedLabel },
				300000
			)
			setDisplayedSeed({ wordCount: result.wordCount, index: result.index, derivationPath: result.derivationPath })

			const key = `${wordCount}-${idx}`
			setActiveViewKey(key)

			// Optimistic: immediately add to list so user sees it
			const optimisticMeta: Bip85SeedMeta = {
				walletFingerprint: '',
				wordCount,
				index: idx,
				derivationPath: result.derivationPath,
				label: seedLabel,
				createdAt: Date.now(),
			}
			setSavedSeeds((prev) => [optimisticMeta, ...prev])

			// Highlight animation — green glow then ease out
			setJustCreatedKey(key)
			if (highlightTimer.current) clearTimeout(highlightTimer.current)
			highlightTimer.current = setTimeout(() => setJustCreatedKey(null), 2500)

			setCreating(false)
			setLabel("")
			setCustomIndex("")
		} catch (e: any) {
			setError(e?.message || t("bip85.derivationFailed"))
		} finally {
			setDeriving(false)
		}
	}, [wordCount, label, customIndex, savedSeeds, nextIndex, clearDisplay, t])

	/** Re-derive an existing saved seed (click on history item) — device displays on screen */
	const handleView = useCallback(async (seed: Bip85SeedMeta) => {
		clearDisplay()
		setDeriving(true)
		setActiveViewKey(`${seed.wordCount}-${seed.index}`)
		try {
			const result = await rpcRequest<{ displayed: boolean; derivationPath: string; wordCount: number; index: number }>(
				"getBip85Mnemonic",
				{ wordCount: seed.wordCount, index: seed.index },
				300000
			)
			setDisplayedSeed({ wordCount: result.wordCount, index: result.index, derivationPath: result.derivationPath })
		} catch (e: any) {
			setError(e?.message || t("bip85.derivationFailed"))
			setActiveViewKey(null)
		} finally {
			setDeriving(false)
		}
	}, [clearDisplay, t])

	const handleDelete = useCallback(async (seed: Bip85SeedMeta) => {
		try {
			await rpcRequest("deleteBip85SeedMeta", { wordCount: seed.wordCount, index: seed.index }, 5000)
			setSavedSeeds((prev) => prev.filter((s) => !(s.wordCount === seed.wordCount && s.index === seed.index)))
			if (activeViewKey === `${seed.wordCount}-${seed.index}`) clearDisplay()
		} catch (e: any) {
			console.warn("Failed to delete seed:", e.message)
		}
		setConfirmDeleteKey(null)
	}, [activeViewKey, clearDisplay])

	return (
		<>
			<Box position="fixed" inset="0" bg="blackAlpha.700" zIndex={Z.dialog} onClick={onClose} />
			<Box
				position="fixed" top="50%" left="50%" transform="translate(-50%, -50%)"
				w="440px" maxW="92vw" maxH="85vh"
				bg="kk.bg" border="1px solid" borderColor="kk.border" borderRadius="xl"
				zIndex={Z.dialog + 1} overflow="hidden" display="flex" flexDirection="column"
				role="dialog" aria-modal="true" aria-label="BIP-85 Seed Vault"
			>
				{/* Header */}
				<Flex px="5" py="4" align="center" justify="space-between" borderBottom="1px solid" borderColor="kk.border" flexShrink={0}>
					<Flex align="center" gap="2.5">
						<Box w="32px" h="32px" borderRadius="lg" bg="rgba(192,168,96,0.15)" display="flex" alignItems="center" justifyContent="center">
							<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#C0A860" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
								<rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
								<path d="M7 11V7a5 5 0 0 1 10 0v4" />
							</svg>
						</Box>
						<Box>
							<Text fontSize="md" fontWeight="600" color="kk.textPrimary">{t("bip85.title")}</Text>
						</Box>
					</Flex>
					<Box as="button" p="1" borderRadius="md" cursor="pointer" color="kk.textMuted" _hover={{ color: "kk.textPrimary", bg: "rgba(255,255,255,0.06)" }} onClick={onClose}>
						<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
							<line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
						</svg>
					</Box>
				</Flex>

				{/* Body */}
				<Box flex="1" overflow="auto" px="5" py="4">
					{/* Warning */}
					<Flex bg="rgba(251,146,60,0.08)" border="1px solid rgba(251,146,60,0.2)" borderRadius="lg" p="3" gap="2" align="start" mb="4">
						<Text fontSize="sm" color="#FB923C" mt="0.5">&#9888;</Text>
						<Text fontSize="xs" color="kk.textSecondary" lineHeight="1.5">{t("bip85.warning")}</Text>
					</Flex>

					{/* On-device display confirmation — shown after successful derivation */}
					{displayedSeed && (
						<Box bg="rgba(255,255,255,0.03)" border="1px solid" borderColor="kk.gold" borderRadius="lg" p="4" mb="4">
							<Text fontSize="xs" color="kk.textMuted" fontFamily="mono" mb="2">{displayedSeed.derivationPath}</Text>
							<Flex
								direction="column" align="center" justify="center"
								p="4" bg="rgba(0,0,0,0.3)" borderRadius="md" gap="3"
							>
								<Box w="40px" h="40px" borderRadius="full" bg="rgba(192,168,96,0.15)" display="flex" alignItems="center" justifyContent="center">
									<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#C0A860" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
										<rect x="2" y="3" width="20" height="14" rx="2" ry="2" />
										<line x1="8" y1="21" x2="16" y2="21" />
										<line x1="12" y1="17" x2="12" y2="21" />
									</svg>
								</Box>
								<Text fontSize="sm" fontWeight="600" color="kk.gold" textAlign="center">
									Your slot {displayedSeed.index} key is shown on the screen of the device
								</Text>
								<Text fontSize="xs" color="kk.textMuted" textAlign="center">
									{displayedSeed.wordCount}-word seed &middot; Write it down carefully
								</Text>
							</Flex>
							<Flex gap="2" mt="3" justify="center">
								<Button size="xs" variant="outline" borderColor="kk.border" color="kk.textSecondary" _hover={{ bg: "rgba(255,255,255,0.06)" }} onClick={clearDisplay}>
									{t("bip85.dismiss")}
								</Button>
							</Flex>
						</Box>
					)}

					{/* Confirm on device */}
					{deriving && (
						<Flex align="center" justify="center" gap="2" py="3" mb="3">
							<Spinner size="sm" color="kk.gold" />
							<Text fontSize="xs" color="kk.gold" fontStyle="italic">{t("bip85.confirmOnDevice")}</Text>
						</Flex>
					)}

					{/* Error */}
					{error && (
						<Text fontSize="xs" color="kk.error" textAlign="center" mb="3">{error}</Text>
					)}

					{/* Create new seed — collapsed to single button, expands inline */}
					{!creating ? (
						<Button
							w="100%" size="sm" bg="kk.gold" color="black" fontWeight="600"
							borderRadius="lg" _hover={{ bg: "kk.goldHover" }} mb="4"
							disabled={deriving}
							onClick={() => { setCreating(true); clearDisplay() }}
						>
							<Flex align="center" gap="2">
								<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
									<line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
								</svg>
								New Derived Seed
							</Flex>
						</Button>
					) : (
						<Box bg="rgba(255,255,255,0.03)" border="1px solid" borderColor="kk.border" borderRadius="lg" p="4" mb="4">
							<Flex align="center" justify="space-between" mb="3">
								<Text fontSize="sm" fontWeight="600" color="kk.textPrimary">New Derived Seed</Text>
								<Box as="button" fontSize="xs" color="kk.textMuted" cursor="pointer" _hover={{ color: "kk.textPrimary" }} onClick={() => setCreating(false)}>
									Cancel
								</Box>
							</Flex>

							{/* Label — the main input */}
							<Box mb="3">
								<Text fontSize="xs" color="kk.textSecondary" mb="1" fontWeight="500">Label</Text>
								<Input
									size="sm"
									placeholder={`e.g. Hot wallet, Trading, Savings...`}
									value={label}
									onChange={(e) => setLabel(e.target.value)}
									bg="rgba(255,255,255,0.04)" border="1px solid" borderColor="kk.border"
									borderRadius="lg" color="kk.textPrimary"
									_hover={{ borderColor: "kk.gold" }}
									_focus={{ borderColor: "kk.gold", boxShadow: "none" }}
									autoFocus
								/>
							</Box>

							{/* Advanced: word count toggle */}
							<Box mb="3">
								<Box as="button" fontSize="xs" color="kk.textMuted" cursor="pointer" _hover={{ color: "kk.textSecondary" }} onClick={() => setShowAdvanced(!showAdvanced)} mb={showAdvanced ? "2" : "0"}>
									{showAdvanced ? "- Hide options" : "+ Options"}
									<Text as="span" color="kk.textMuted" ml="1">({wordCount} words)</Text>
								</Box>
								{showAdvanced && (
									<>
									<Flex gap="2" mb="2">
										{([12, 18, 24] as const).map((wc) => (
											<Box
												key={wc} as="button" flex="1" py="1.5" borderRadius="lg"
												fontSize="sm" fontWeight="500" cursor="pointer"
												bg={wordCount === wc ? "kk.gold" : "rgba(255,255,255,0.06)"}
												color={wordCount === wc ? "black" : "kk.textSecondary"}
												_hover={{ bg: wordCount === wc ? "kk.goldHover" : "rgba(255,255,255,0.1)" }}
												transition="all 0.15s"
												onClick={() => setWordCount(wc)}
											>
												{wc} words
											</Box>
										))}
									</Flex>
									<Flex align="center" gap="2">
										<Text fontSize="xs" color="kk.textMuted" flexShrink={0}>Index:</Text>
										<Input
											size="sm" type="number" min={0} placeholder={`auto (${nextIndex(wordCount)})`}
											value={customIndex} onChange={(e) => setCustomIndex(e.target.value)}
											bg="rgba(255,255,255,0.06)" border="1px solid" borderColor="kk.border"
											borderRadius="lg" fontSize="xs" color="white" w="120px"
											_placeholder={{ color: "kk.textMuted" }}
										/>
									</Flex>
									</>
								)}
							</Box>

							<Button
								w="100%" size="sm" bg="kk.gold" color="black" fontWeight="600"
								borderRadius="lg" _hover={{ bg: "kk.goldHover" }}
								disabled={deriving}
								onClick={handleCreate}
							>
								{deriving ? t("bip85.deriving") : `Derive ${wordCount}-word seed #${customIndex.trim() !== '' && Number.isFinite(parseInt(customIndex)) && parseInt(customIndex) >= 0 ? parseInt(customIndex) : nextIndex(wordCount)}`}
							</Button>
						</Box>
					)}

					{/* Saved seeds list */}
					<Box>
						<Text fontSize="xs" color="kk.textMuted" fontWeight="600" mb="2" textTransform="uppercase" letterSpacing="0.5px">
							Your Seeds
						</Text>

						{loadingSeeds ? (
							<Flex justify="center" py="4"><Spinner size="sm" color="kk.gold" /></Flex>
						) : savedSeeds.length === 0 ? (
							<Text fontSize="xs" color="kk.textMuted" textAlign="center" py="4">
								No seeds yet. Create your first derived seed above.
							</Text>
						) : (
							<Flex direction="column" gap="1.5">
								{savedSeeds.map((seed) => {
									const key = `${seed.wordCount}-${seed.index}`
									const isActive = activeViewKey === key && displayedSeed
									const isJustCreated = justCreatedKey === key
									return (
										<Flex
											key={key} align="center" justify="space-between"
											bg={
												isJustCreated ? "rgba(74,222,128,0.12)"
												: isActive ? "rgba(192,168,96,0.08)"
												: "rgba(255,255,255,0.03)"
											}
											border="1px solid"
											borderColor={
												isJustCreated ? "rgba(74,222,128,0.5)"
												: isActive ? "kk.gold"
												: "kk.border"
											}
											borderRadius="lg" px="3" py="2.5"
											cursor="pointer"
											_hover={{ borderColor: "kk.gold", bg: "rgba(192,168,96,0.05)" }}
											transition="all 0.8s ease-out"
											boxShadow={isJustCreated ? "0 0 12px rgba(74,222,128,0.25)" : "none"}
											onClick={() => handleView(seed)}
										>
											<Box flex="1" minW="0">
												<Flex align="center" gap="2">
													<Text fontSize="sm" fontWeight="600" color={isJustCreated ? "#4ade80" : "kk.textPrimary"} truncate
														style={{ transition: "color 0.8s ease-out" }}>
														{seed.label || `Seed #${seed.index}`}
													</Text>
													{isJustCreated && (
														<Text fontSize="9px" fontWeight="700" color="#4ade80" bg="rgba(74,222,128,0.15)"
															px="1.5" py="0.5" borderRadius="sm" letterSpacing="0.5px"
															style={{ animation: "fadeInScale 0.3s ease-out" }}>
															SAVED
														</Text>
													)}
												</Flex>
												<Flex align="center" gap="2" mt="0.5">
													<Text fontSize="10px" color="kk.textMuted" fontFamily="mono">
														{seed.wordCount}w
													</Text>
													<Text fontSize="10px" color="kk.textMuted" fontFamily="mono">
														idx:{seed.index}
													</Text>
													<Text fontSize="10px" color="kk.textMuted">
														{new Date(seed.createdAt).toLocaleDateString()}
													</Text>
												</Flex>
											</Box>
											<Flex align="center" gap="1.5" flexShrink={0}>
												{isActive && (
													<Text fontSize="10px" color="kk.gold" fontWeight="600">ON DEVICE</Text>
												)}
												{confirmDeleteKey === key ? (
													<Flex gap="1">
														<Box as="button" px="2" py="0.5" fontSize="10px" color="kk.error" bg="rgba(239,68,68,0.1)" borderRadius="md" cursor="pointer" _hover={{ bg: "rgba(239,68,68,0.2)" }}
															onClick={(e: React.MouseEvent) => { e.stopPropagation(); handleDelete(seed) }}>
															Delete
														</Box>
														<Box as="button" px="2" py="0.5" fontSize="10px" color="kk.textMuted" borderRadius="md" cursor="pointer" _hover={{ color: "kk.textPrimary" }}
															onClick={(e: React.MouseEvent) => { e.stopPropagation(); setConfirmDeleteKey(null) }}>
															Cancel
														</Box>
													</Flex>
												) : (
													<Box as="button" p="1" borderRadius="md" cursor="pointer" color="kk.textMuted" _hover={{ color: "kk.error" }}
														onClick={(e: React.MouseEvent) => { e.stopPropagation(); setConfirmDeleteKey(key) }}>
														<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
															<polyline points="3 6 5 6 21 6" />
															<path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
														</svg>
													</Box>
												)}
											</Flex>
										</Flex>
									)
								})}
							</Flex>
						)}
					</Box>
				</Box>
			</Box>

			{/* Keyframe for the SAVED badge */}
			<style>{`
				@keyframes fadeInScale {
					from { opacity: 0; transform: scale(0.7); }
					to { opacity: 1; transform: scale(1); }
				}
			`}</style>
		</>
	)
}
