import { describe, expect, it } from 'bun:test'
import { createHash, randomBytes } from 'crypto'
import { analyzeEntropy, collectAndAnalyze, MAX_CHUNK_BYTES, verdictSummary } from './rng-audit'

const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex')
const analyze = (b: Uint8Array) => analyzeEntropy(b, sha(b))

describe('RNG health testing', () => {
	it('passes a healthy sample and reports ~8 bits/byte', () => {
		const sample = new Uint8Array(randomBytes(256 * 1024))
		const report = analyze(sample)

		expect(report.verdict).toBe('healthy')
		expect(report.failures).toEqual([])
		expect(report.stats.distinctBytes).toBe(256)
		expect(report.stats.shannonBitsPerByte).toBeGreaterThan(7.99)
		expect(Math.abs(report.stats.onesFraction - 0.5)).toBeLessThan(0.01)
	})

	it('fails a stuck RNG that repeats a block', () => {
		const sample = new Uint8Array(64 * 1024)
		const block = randomBytes(8)
		for (let i = 0; i < sample.length; i += 8) sample.set(block, i)

		const report = analyze(sample)
		expect(report.verdict).toBe('failed')
		expect(report.stats.repeatedBlocks8).toBeGreaterThan(0)
		expect(report.failures.join(' ')).toContain('repeated')
	})

	it('fails a biased RNG that never sets the high nibble', () => {
		const sample = new Uint8Array(randomBytes(128 * 1024)).map((b) => b & 0x0f)

		const report = analyze(sample)
		expect(report.verdict).toBe('failed')
		expect(report.stats.distinctBytes).toBe(16)
	})

	it('fails a counter masquerading as entropy', () => {
		// Every byte value equally often and perfect bit balance, but the
		// 4-byte stream is a permutation, so it produces zero collisions where
		// theory expects many. This is what the positive control is for.
		const n = 4 * 1024 * 1024
		const sample = new Uint8Array(n)
		const view = new DataView(sample.buffer)
		for (let i = 0; i < n / 4; i++) view.setUint32(i * 4, i, true)

		const report = analyze(sample)
		expect(report.stats.collisionControlUsable).toBe(true)
		expect(report.stats.collisions4).toBe(0)
		expect(report.verdict).toBe('failed')
		expect(report.failures.join(' ')).toContain('positive control failed')
	})

	it('refuses to treat a 64 KB zero-collision result as evidence', () => {
		// 64 KB is the firmware's press-free budget, so it is the size a user
		// can realistically pull today — and at that size the collision test
		// expects 0.03 hits, meaning "zero collisions" says nothing at all.
		const report = analyze(new Uint8Array(randomBytes(64 * 1024)))

		expect(report.stats.collisionControlUsable).toBe(false)
		expect(report.stats.expectedCollisions4).toBeLessThan(1)
		expect(verdictSummary(report)).toContain('too small')
	})

	it('runs the positive control once the sample is large enough', () => {
		const report = analyze(new Uint8Array(randomBytes(2 * 1024 * 1024)))

		expect(report.stats.collisionControlUsable).toBe(true)
		expect(report.stats.expectedCollisions4).toBeGreaterThan(1)
		expect(report.verdict).toBe('healthy')
	})

	it('never claims to have measured entropy', () => {
		const summary = verdictSummary(analyze(new Uint8Array(randomBytes(128 * 1024))))
		expect(summary).toContain('does NOT measure')
	})

	it('binds a report to the exact bytes it analysed', () => {
		const sample = new Uint8Array(randomBytes(8192))
		expect(analyze(sample).sampleSha256).toBe(sha(sample))
	})
})

describe('entropy collection', () => {
	it('asks for the largest chunk and reports progress', async () => {
		const asked: number[] = []
		const progress: number[] = []
		const report = await collectAndAnalyze(
			async (size) => { asked.push(size); return new Uint8Array(randomBytes(size)) },
			4 * 8192,
			(collected) => progress.push(collected),
		)

		expect(MAX_CHUNK_BYTES).toBe(8192) // firmware Entropy.entropy max_size (7.15+)
		expect(asked).toEqual([8192, 8192, 8192, 8192])
		expect(progress).toEqual([8192, 16384, 24576, 32768])
		expect(report.stats.bytes).toBe(4 * 8192)
		expect(report.chunkBytes).toBe(8192)
	})

	it('adapts to older firmware that caps replies at 1024', async () => {
		// Pre-2f9269f64 firmware compiles Entropy.entropy at max_size 1024 and
		// silently truncates. The first short reply IS the device stating its
		// cap, so adopt it rather than failing the audit.
		const asked: number[] = []
		const report = await collectAndAnalyze(
			async (size) => {
				asked.push(size)
				const n = Math.min(size, 1024)
				return new Uint8Array(randomBytes(n))
			},
			4096,
		)

		expect(asked[0]).toBe(4096)          // asked big
		expect(asked.slice(1)).toEqual([1024, 1024, 1024]) // then settled at the cap
		expect(report.stats.bytes).toBe(4096)
		expect(report.chunkBytes).toBe(1024)
	})

	it('asks for only the remainder on the final chunk', async () => {
		const asked: number[] = []
		await collectAndAnalyze(
			async (size) => { asked.push(size); return new Uint8Array(randomBytes(size)) },
			10000,
		)
		expect(asked).toEqual([8192, 1808])
	})

	it('rejects a short read that appears MID-STREAM', async () => {
		// Only the first reply may redefine the chunk size. A device that
		// under-delivers later is anomalous, and analysing padded or truncated
		// data would invent a result.
		let call = 0
		await expect(
			collectAndAnalyze(async (size) => {
				call++
				return new Uint8Array(randomBytes(call === 1 ? size : 8))
			}, 3 * 8192),
		).rejects.toThrow(/returned 8 bytes/)
	})

	it('rejects an empty reply outright', async () => {
		await expect(
			collectAndAnalyze(async () => new Uint8Array(0), 8192),
		).rejects.toThrow(/no entropy/)
	})

	it('hashes exactly the bytes it analysed', async () => {
		const fixed = new Uint8Array(randomBytes(8192))
		const report = await collectAndAnalyze(async () => fixed, 8192)
		expect(report.sampleSha256).toBe(sha(fixed))
	})
})

describe('honesty contract', () => {
	it('never reports a skipped check as a pass', () => {
		// The bug this locks out: below its size gate a check was silently
		// dropped and the panel still said "No failures detected", putting a
		// green tick on evidence that was never gathered.
		const report = analyze(new Uint8Array(randomBytes(2048)))

		const notRun = report.checks.filter((c) => c.status === 'not-run').map((c) => c.id)
		expect(notRun).toContain('byte-coverage')      // needs 4 KB
		expect(notRun).toContain('chi-square')         // needs 64 KB
		expect(notRun).toContain('bit-balance')
		expect(notRun).toContain('longest-run')
		expect(notRun).toContain('collision-control')  // needs ~1 MB

		// and none of them is dressed up as a pass
		for (const id of notRun) {
			expect(report.checks.find((c) => c.id === id)!.status).not.toBe('pass')
		}
	})

	it('every not-run check explains why', () => {
		for (const c of analyze(new Uint8Array(randomBytes(2048))).checks) {
			if (c.status === 'not-run') expect(c.detail.length).toBeGreaterThan(0)
		}
	})

	it('a healthy verdict on a small sample still admits what did not run', () => {
		const report = analyze(new Uint8Array(randomBytes(2048)))
		expect(report.verdict).toBe('healthy')  // nothing FAILED
		expect(report.checks.some((c) => c.status === 'not-run')).toBe(true)
	})

	it('runs every check once the sample is large enough', () => {
		const report = analyze(new Uint8Array(randomBytes(2 * 1024 * 1024)))
		expect(report.checks.every((c) => c.status !== 'not-run')).toBe(true)
		expect(report.verdict).toBe('healthy')
	})

	it('a failure names the check that failed', () => {
		const stuck = new Uint8Array(64 * 1024)
		const block = randomBytes(8)
		for (let i = 0; i < stuck.length; i += 8) stuck.set(block, i)

		const report = analyze(stuck)
		const failed = report.checks.filter((c) => c.status === 'fail')
		expect(failed.map((c) => c.id)).toContain('repeated-blocks')
		expect(report.failures.length).toBe(failed.length)
	})
})
