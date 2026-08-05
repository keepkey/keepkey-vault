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
	it('requests in device-sized chunks and reports progress', async () => {
		const asked: number[] = []
		const progress: number[] = []
		const report = await collectAndAnalyze(
			async (size) => { asked.push(size); return new Uint8Array(randomBytes(size)) },
			4096,
			(collected) => progress.push(collected),
		)

		expect(MAX_CHUNK_BYTES).toBe(1024) // firmware Entropy.entropy max_size
		expect(asked).toEqual([1024, 1024, 1024, 1024])
		expect(progress).toEqual([1024, 2048, 3072, 4096])
		expect(report.stats.bytes).toBe(4096)
	})

	it('asks for only the remainder on the final chunk', async () => {
		const asked: number[] = []
		await collectAndAnalyze(
			async (size) => { asked.push(size); return new Uint8Array(randomBytes(size)) },
			1500,
		)
		expect(asked).toEqual([1024, 476])
	})

	it('refuses a short read instead of padding it', async () => {
		// A silently padded sample would manufacture a bias failure (or mask a
		// real one), so a device that under-delivers must be an error.
		await expect(
			collectAndAnalyze(async () => new Uint8Array(8), 2048),
		).rejects.toThrow(/returned 8 bytes for a 1024-byte request/)
	})

	it('hashes exactly the bytes it analysed', async () => {
		const fixed = new Uint8Array(randomBytes(1024))
		const report = await collectAndAnalyze(async () => fixed, 1024)
		expect(report.sampleSha256).toBe(sha(fixed))
	})
})
