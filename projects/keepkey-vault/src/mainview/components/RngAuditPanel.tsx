import { Box, Button, Flex, Text, VStack } from "@chakra-ui/react"
import { useEffect, useState } from "react"
import { rpcRequest, onRpcMessage } from "../lib/rpc"
import { Z } from "../lib/z-index"
import type { RngAuditReport } from "../../shared/types"

/**
 * RNG health test — pull entropy from the device and score it.
 *
 * Deliberately does NOT claim to measure entropy. Output analysis cannot bound
 * a generator's internal state: a strong PRNG seeded with 40 bits passes every
 * one of these checks, which is exactly how the Coldcard failure went
 * undetected. The copy below says so plainly rather than showing a green
 * "entropy verified" badge that would be false comfort.
 */

/** Firmware grants this much per boot with no button press. Past it the
 *  device asks once (firmware >= 7.15.0 with the bulk-audit unlock) and then
 *  streams unmetered while it stays uninitialized. */
const PRESS_FREE_BYTES = 64 * 1024

/** Observed throughput with 8192-byte chunks (~23.7 KB/s measured on
 *  hardware). Only used for the estimate shown before a run. */
const BYTES_PER_SEC = 23.7 * 1024

const SIZES = [64 * 1024, 256 * 1024, 1024 * 1024, 4 * 1024 * 1024, 8 * 1024 * 1024]

function label(bytes: number): string {
	return bytes >= 1024 * 1024 ? `${bytes / 1024 / 1024} MB` : `${bytes / 1024} KB`
}

/** Same formula the analyser uses: blocks^2 / 2^33, blocks = bytes/4. */
function expectedCollisions(bytes: number): number {
	const blocks = Math.floor(bytes / 4)
	return (blocks * blocks) / 2 ** 33
}

function duration(bytes: number): string {
	const s = Math.round(bytes / BYTES_PER_SEC)
	return s < 90 ? `~${s}s` : `~${Math.round(s / 60)} min`
}

function Row({ label, value, muted }: { label: string; value: string; muted?: boolean }) {
	return (
		<Flex justify="space-between" gap="4" py="1">
			<Text fontSize="xs" color="kk.textSecondary">{label}</Text>
			<Text fontSize="xs" fontFamily="mono" color={muted ? "kk.textSecondary" : "kk.textPrimary"}>{value}</Text>
		</Flex>
	)
}

/** Animated pass/fail mark: circle draws, then the check (or cross) draws.
 *  Pure SVG + CSS — no animation library, honours prefers-reduced-motion. */
function VerdictMark({ ok }: { ok: boolean }) {
	const color = ok ? "#23DCC8" : "#e66464"
	return (
		<Flex justify="center" mb="3">
			<svg
				width="72"
				height="72"
				viewBox="0 0 64 64"
				aria-hidden="true"
				style={ok ? { filter: "drop-shadow(0 0 14px rgba(35,220,200,0.35))" } : undefined}
			>
				<style>{`
					@keyframes rngDraw { to { stroke-dashoffset: 0; } }
					@keyframes rngPop { from { transform: scale(0.85); opacity: 0; } to { transform: scale(1); opacity: 1; } }
					.rngPop { transform-origin: 32px 32px; animation: rngPop 240ms ease-out both; }
					.rngCircle { stroke-dasharray: 176; stroke-dashoffset: 176; animation: rngDraw 600ms ease-out 120ms forwards; }
					.rngStroke { stroke-dasharray: 40; stroke-dashoffset: 40; animation: rngDraw 350ms ease-out 550ms forwards; }
					@media (prefers-reduced-motion: reduce) {
						.rngPop, .rngCircle, .rngStroke { animation: none; stroke-dashoffset: 0; opacity: 1; }
					}
				`}</style>
				<g className="rngPop">
					<circle className="rngCircle" cx="32" cy="32" r="28" fill="none" stroke={color} strokeWidth="3" strokeLinecap="round" />
					{ok ? (
						<path className="rngStroke" d="M20 33 L28 41 L44 24" fill="none" stroke={color} strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" />
					) : (
						<>
							<path className="rngStroke" d="M24 24 L40 40" fill="none" stroke={color} strokeWidth="4" strokeLinecap="round" />
							<path className="rngStroke" d="M40 24 L24 40" fill="none" stroke={color} strokeWidth="4" strokeLinecap="round" />
						</>
					)}
				</g>
			</svg>
		</Flex>
	)
}

export function RngAuditPanel({
	open,
	onClose,
	onVerdict,
}: {
	open: boolean
	onClose: () => void
	/** Fires once per completed run, so the caller can gate on the outcome. */
	onVerdict?: (verdict: RngAuditReport["verdict"]) => void
}) {
	const [sizeIdx, setSizeIdx] = useState(0)
	const [running, setRunning] = useState(false)
	const [progress, setProgress] = useState(0)
	const [report, setReport] = useState<RngAuditReport | null>(null)
	const [error, setError] = useState<string | null>(null)

	useEffect(() => {
		if (!open) return
		return onRpcMessage("rng-audit-progress", ({ collected, total }) => {
			setProgress(total > 0 ? collected / total : 0)
		})
	}, [open])

	useEffect(() => {
		if (!open) { setReport(null); setError(null); setProgress(0); setRunning(false) }
	}, [open])

	if (!open) return null

	const run = async () => {
		setRunning(true); setError(null); setReport(null); setProgress(0)
		try {
			// 0 timeout: the device may require a button press per request once
			// the press-free budget is spent.
			const r = await rpcRequest("rngAuditRun", { bytes: SIZES[sizeIdx] }, 0)
			setReport(r)
			onVerdict?.(r.verdict)
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e))
		} finally {
			setRunning(false)
		}
	}

	const s = report?.stats

	return (
		<>
			<Box position="fixed" inset="0" bg="rgba(0,0,0,0.6)" zIndex={Z.dialog} onClick={running ? undefined : onClose} />
			<Flex position="fixed" inset="0" align="center" justify="center" zIndex={Z.dialog + 1} pointerEvents="none">
				<Box
					role="dialog"
					aria-modal="true"
					aria-label="RNG health test"
					pointerEvents="auto"
					w="min(560px, 92vw)"
					maxH="86vh"
					overflowY="auto"
					bg="kk.cardBg"
					border="1px solid rgba(255,255,255,0.10)"
					boxShadow="0 24px 64px rgba(0,0,0,0.6)"
					borderRadius="16px"
					p="5"
				>
					<Text fontSize="md" fontWeight="700" color="kk.textPrimary">RNG health test</Text>
					<Text fontSize="xs" color="kk.textSecondary" mt="1">
						Pulls entropy from the device's random number generator and checks it for stuck,
						repeated, or grossly biased output.
					</Text>

					<Box mt="3" px="3" py="2" borderRadius="10px" bg="rgba(233,196,106,0.06)" border="1px solid rgba(233,196,106,0.18)">
						<Text fontSize="xs" color="kk.textSecondary">
							This is a health test, not an entropy measurement. A strong generator seeded with
							very little secret state passes every check here, so a pass cannot prove the device's
							randomness is unpredictable — only that it is not obviously broken.
						</Text>
					</Box>

					{!running && !report && (
						<Box mt="4">
							<Flex justify="space-between" align="baseline" mb="1">
								<Text fontSize="xs" color="kk.textSecondary">Sample size</Text>
								<Text fontSize="xs" fontFamily="mono" color="kk.textPrimary">
									{label(SIZES[sizeIdx])} · {duration(SIZES[sizeIdx])}
								</Text>
							</Flex>

							{/* Native range input: no slider dependency, and it is keyboard
							    accessible for free. Discrete indices, not raw bytes. */}
							<Box
								as="input"
								// @ts-expect-error -- Chakra's polymorphic props do not model input attrs
								type="range"
								min={0}
								max={SIZES.length - 1}
								step={1}
								value={sizeIdx}
								onChange={(e: React.ChangeEvent<HTMLInputElement>) => setSizeIdx(Number(e.target.value))}
								w="100%"
								style={{ accentColor: "#e9c46a" }}
							/>

							<Flex justify="space-between" mt="0.5">
								{SIZES.map((b, i) => (
									<Text
										key={b}
										fontSize="2xs"
										color={i === sizeIdx ? "var(--gold)" : "kk.textMuted"}
										cursor="pointer"
										onClick={() => setSizeIdx(i)}
									>
										{label(b)}
									</Text>
								))}
							</Flex>

							<Text fontSize="2xs" color="kk.textSecondary" mt="2" lineHeight="tall">
								{expectedCollisions(SIZES[sizeIdx]) >= 1
									? `At this size the collision positive control expects ~${expectedCollisions(SIZES[sizeIdx]).toFixed(0)} hits, so the result is meaningful — it can tell a working detector from a broken one.`
									: `At this size the collision positive control expects only ${expectedCollisions(SIZES[sizeIdx]).toFixed(2)} hits, so finding none proves nothing. Pick 1 MB or more for that check to carry information.`}
							</Text>

							{SIZES[sizeIdx] > PRESS_FREE_BYTES && (
								<Text fontSize="2xs" color="kk.textSecondary" mt="1.5" lineHeight="tall">
									Past {label(PRESS_FREE_BYTES)} the device asks for one button press, then
									streams the rest unmetered. Requires firmware 7.15.0+ and an uninitialized
									device; on older firmware every kilobyte needs its own press.
								</Text>
							)}
						</Box>
					)}

					{running && (
						<Box mt="4">
							<Text fontSize="xs" color="kk.textSecondary" mb="1">
								Collecting… {(progress * 100).toFixed(0)}%
							</Text>
							<Box h="6px" bg="rgba(255,255,255,0.08)" borderRadius="3px" overflow="hidden">
								<Box h="100%" w={`${progress * 100}%`} bg="kk.gold" transition="width 120ms linear" />
							</Box>
						</Box>
					)}

					{error && (
						<Box mt="4" px="3" py="2" borderRadius="10px" bg="rgba(230,100,100,0.08)" border="1px solid rgba(230,100,100,0.3)">
							<Text fontSize="xs" color="kk.textPrimary">{error}</Text>
						</Box>
					)}

					{report && s && (
						<Box mt="4">
							<VerdictMark ok={report.verdict === "healthy"} />
							{(() => {
								const ran = report.checks.filter((c) => c.status !== "not-run")
								const skipped = report.checks.length - ran.length
								const failed = report.checks.filter((c) => c.status === "fail").length
								return (
									<>
										<Text fontSize="md" fontWeight="800" textAlign="center" color={failed ? "#e66464" : "kk.success"}>
											{failed ? "Health test failed" : "Health test passed"}
										</Text>
										<Text fontSize="xs" fontWeight="500" textAlign="center" color="kk.textSecondary" mt="0.5">
											{failed
												? `${failed} of ${ran.length} check${ran.length === 1 ? "" : "s"} failed`
												: `${ran.length} check${ran.length === 1 ? "" : "s"} passed`}
											{/* Never imply the skipped ones passed. */}
											{skipped > 0 && ` · ${skipped} not run`}
										</Text>
										{report.verdict === "failed" && (
											<Box mt="3" px="3" py="2" borderRadius="10px" bg="rgba(230,100,100,0.08)" border="1px solid rgba(230,100,100,0.3)">
												<Text fontSize="xs" fontWeight="600" color="kk.textPrimary">
													Do not create a wallet with this device. Its generator produced output
													that real randomness never produces.
												</Text>
											</Box>
										)}

										<VStack align="stretch" gap="1.5" mt="2.5">
											{report.checks.map((c) => (
												<Flex key={c.id} gap="2.5" align="flex-start">
													<Text
														fontSize="xs"
														w="14px"
														flexShrink={0}
														textAlign="center"
														color={c.status === "pass" ? "kk.success" : c.status === "fail" ? "#e66464" : "kk.textMuted"}
													>
														{c.status === "pass" ? "\u2713" : c.status === "fail" ? "\u2717" : "\u2013"}
													</Text>
													<Box>
														<Text fontSize="xs" color={c.status === "not-run" ? "kk.textMuted" : "kk.textPrimary"}>
															{c.label}
														</Text>
														<Text fontSize="2xs" color="kk.textSecondary" lineHeight="1.5">
															{c.detail}
														</Text>
													</Box>
												</Flex>
											))}
										</VStack>
									</>
								)
							})()}

							<Box as="details" mt="3" pt="2" borderTop="1px solid rgba(255,255,255,0.06)">
								<Box as="summary" cursor="pointer" mb="1">
									<Text as="span" fontSize="xs" color="kk.textSecondary">Advanced details</Text>
								</Box>
								<Row label="Sample size" value={`${(s.bytes / 1024).toFixed(0)} KB`} />
								<Row label="Shannon entropy" value={`${s.shannonBitsPerByte.toFixed(5)} bits/byte`} />
								<Row label="Bit balance (ideal 0.5)" value={s.onesFraction.toFixed(5)} />
								<Row label="Byte chi-square (255 dof)" value={s.chiSquare.toFixed(1)} />
								<Row label="Distinct byte values" value={`${s.distinctBytes}/256`} />
								<Row label="Longest identical-bit run" value={String(s.longestBitRun)} />
								<Row label="Repeated 8-byte blocks" value={String(s.repeatedBlocks8)} />
								<Row
									label="4-byte collisions (control)"
									value={
										s.collisionControlUsable
											? `${s.collisions4} seen / ${s.expectedCollisions4.toFixed(1)} expected`
											: `not usable at this size`
									}
									muted={!s.collisionControlUsable}
								/>
								<Row label="Sample SHA-256" value={`${report.sampleSha256.slice(0, 16)}…`} />
							</Box>

							{!s.collisionControlUsable && (
								<Text fontSize="xs" color="kk.textSecondary" mt="2">
									The collision check is the positive control — the one test that proves the
									detector works at all. At {(s.bytes / 1024).toFixed(0)} KB it expects{" "}
									{s.expectedCollisions4.toFixed(2)} collisions, so finding none says nothing.
									Re-run at a larger size to make it meaningful: past the first 64 KB the
									device asks once, then streams unmetered while it holds no seed.
								</Text>
							)}
						</Box>
					)}

					{/* Pass -> Continue is the primary action; fail -> re-run or close
					    (closing lands on the wizard's blocked screen). */}
					<Flex mt="5" gap="2" justify="flex-end">
						{report?.verdict === "healthy" ? (
							<>
								<Button size="sm" variant="ghost" onClick={run}>Run again</Button>
								<Button
									size="sm"
									bg="var(--gold)"
									color="black"
									fontWeight="600"
									_hover={{ bg: "#D4BC6A" }}
									onClick={onClose}
								>
									Continue
								</Button>
							</>
						) : (
							<>
								<Button size="sm" variant="ghost" onClick={onClose} disabled={running}>Close</Button>
								<Button
									size="sm"
									variant="outline"
									borderColor="rgba(233,196,106,0.45)"
									color="kk.gold"
									onClick={run}
									disabled={running}
								>
									{running ? "Running…" : report ? "Run again" : `Run ${label(SIZES[sizeIdx])} test`}
								</Button>
							</>
						)}
					</Flex>
				</Box>
			</Flex>
		</>
	)
}
