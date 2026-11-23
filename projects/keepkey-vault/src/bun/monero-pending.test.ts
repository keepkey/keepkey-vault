/** KEEPKEY-141: swapping out an unreadable payment-proof file must never hide the old keys. */
import { afterAll, describe, expect, mock, spyOn, test } from 'bun:test'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// Real fs, captured before the mock. File operations that change the disk are counted; a test can make
// them fail either from the Nth one on (the app died there) or only the Nth one (a single I/O error).
const realFs = { ...(await import('node:fs')) }
const faults = { seen: 0, from: Infinity, only: 0 }
const counted = <A extends unknown[], R>(fn: (...args: A) => R) => (...args: A): R => {
	const n = ++faults.seen
	if (n >= faults.from || n === faults.only) throw new Error('EIO: simulated failure')
	return fn(...args)
}
mock.module('node:fs', () => ({
	...realFs,
	writeFileSync: counted(realFs.writeFileSync), copyFileSync: counted(realFs.copyFileSync),
	renameSync: counted(realFs.renameSync), unlinkSync: counted(realFs.unlinkSync),
}))
const crashFrom = (n: number) => Object.assign(faults, { seen: 0, from: n, only: 0 })
const failOnly = (n: number) => Object.assign(faults, { seen: 0, from: Infinity, only: n })
const healthy = () => Object.assign(faults, { seen: 0, from: Infinity, only: 0 })

const { createFilePendingStore, SENT_ARCHIVE_WARN_BYTES } = await import('./monero-pending')
const { parseSignedTransaction } = await import('./monero-wire')
const fixture = (await Bun.file(join(import.meta.dir, 'monero-stream.fixtures.json')).json()).cases[0]

const SENT = 'monero-sent-transactions.json'
/** A record that passes validation: real signed bytes whose hash is the txid. */
const valid = {
	wallet: `device:${fixture.plan.outputs[0].address}`,
	txid: parseSignedTransaction(Uint8Array.from(Buffer.from(fixture.transactionHex, 'hex'))).hash,
	txHex: fixture.transactionHex,
	createdAt: '2026-11-01T00:00:00.000Z',
}
/** One valid record plus one that fails validation, so loading swaps the file. */
const PARTLY_INVALID = JSON.stringify({ version: 1, records: [valid, { wallet: 'broken' }] })
const setup = () => {
	healthy()
	const dir = realFs.mkdtempSync(join(tmpdir(), 'kk-monero-141-'))
	realFs.writeFileSync(join(dir, SENT), PARTLY_INVALID, { mode: 0o600 })
	return dir
}
const asideCopies = (dir: string) => realFs.readdirSync(dir).filter(name => name.startsWith('monero-sent-transactions.unreadable-'))
const leftovers = (dir: string) => realFs.readdirSync(dir).filter(name => name.endsWith('.tmp') || name.endsWith('.clean'))
const liveTxids = (dir: string) => createFilePendingStore(dir).loadSent!().map(r => r.txid)

describe('KEEPKEY-141: the live proof file never disappears during the swap', () => {
	// The swap is: copy aside (1), write temp (2), rename-over (3). Crash at each point, then restart.
	test.each([1, 2, 3, 4])('a crash from file operation %i on never hides the old keys', (n) => {
		const dir = setup()
		crashFrom(n)
		try { createFilePendingStore(dir).loadSent!() } catch {}
		healthy()
		expect(realFs.existsSync(join(dir, SENT))).toBe(true)
		expect(liveTxids(dir)).toEqual([valid.txid])
	})

	test('a failed copy changes nothing on disk', () => {
		const dir = setup()
		failOnly(1)
		expect(() => createFilePendingStore(dir).loadSent!()).toThrow('could not be read')
		healthy()
		expect(realFs.readFileSync(join(dir, SENT), 'utf8')).toBe(PARTLY_INVALID)
		expect(asideCopies(dir)).toEqual([])
		expect(leftovers(dir)).toEqual([])
	})

	test('a failed final swap keeps the original live and removes its temporary file (it holds keys)', () => {
		const dir = setup()
		failOnly(3)
		expect(() => createFilePendingStore(dir).loadSent!()).toThrow('could not be read')
		healthy()
		expect(realFs.readFileSync(join(dir, SENT), 'utf8')).toBe(PARTLY_INVALID)
		expect(leftovers(dir)).toEqual([])
		expect(liveTxids(dir)).toEqual([valid.txid])
	})

	test('a failed write removes the copy made in that attempt, so retries do not pile up key files', () => {
		const dir = setup()
		for (let attempt = 0; attempt < 3; attempt++) {
			failOnly(3) // copy (1), write temp (2), rename-over (3) fails; cleanups run
			expect(() => createFilePendingStore(dir).loadSent!()).toThrow('could not be read')
		}
		healthy()
		expect(asideCopies(dir)).toEqual([])
		expect(leftovers(dir)).toEqual([])
		expect(realFs.readFileSync(join(dir, SENT), 'utf8')).toBe(PARTLY_INVALID)
	})

	test('a completed swap keeps the valid keys live and the original bytes aside', () => {
		const dir = setup()
		expect(liveTxids(dir)).toEqual([valid.txid])
		expect(JSON.parse(realFs.readFileSync(join(dir, SENT), 'utf8')).records.map((r: { txid: string }) => r.txid)).toEqual([valid.txid])
		expect(realFs.readFileSync(join(dir, asideCopies(dir)[0]), 'utf8')).toBe(PARTLY_INVALID)
		expect(leftovers(dir)).toEqual([])
		// Now clean: a later start loads it as is and makes no new copy.
		expect(liveTxids(dir)).toEqual([valid.txid])
		expect(asideCopies(dir)).toHaveLength(1)
	})

	test('a failed save never leaves its temporary file (it holds keys) behind', () => {
		const dir = realFs.mkdtempSync(join(tmpdir(), 'kk-monero-141-save-'))
		failOnly(2) // write temp (1) works, rename-over (2) fails, cleanup delete (3) runs
		expect(() => createFilePendingStore(dir).saveSent!([valid])).toThrow('simulated')
		healthy()
		expect(realFs.readdirSync(dir)).toEqual([])
	})
})

describe('KEEPKEY-144: a large payment-proof archive is reported in the log, and no record is ever dropped', () => {
	// A canonical scalar (little-endian, below the group order), as validTransactionKeys requires.
	const TX_KEY = 'ab'.repeat(31) + '0b'
	const keyed = { ...valid, transactionKeys: { txKey: TX_KEY, additionalTxKeys: [] as string[] } }
	/** Enough copies of a real record to pass the threshold; one in ten is labelled as never landed. */
	const large = () => {
		const count = Math.ceil(SENT_ARCHIVE_WARN_BYTES / JSON.stringify(keyed).length) + 50
		return Array.from({ length: count }, (_, i) => i % 10 === 0 ? { ...keyed, outcome: 'rejected' as const } : keyed)
	}
	// These directories hold test key files of several MB each: remove them afterwards.
	const dirs: string[] = []
	afterAll(() => { for (const dir of dirs) realFs.rmSync(dir, { recursive: true, force: true }) })
	const archiveDir = () => { healthy(); const dir = realFs.mkdtempSync(join(tmpdir(), 'kk-monero-144-')); dirs.push(dir); return dir }
	const writeArchive = (dir: string, records: unknown[]) => realFs.writeFileSync(join(dir, SENT), JSON.stringify({ version: 1, records }), { mode: 0o600 })
	/** The archive-size warnings logged while `run` runs. */
	const sizeWarnings = (run: () => void) => {
		const logged: string[] = []
		const warn = spyOn(console, 'warn').mockImplementation((...args: unknown[]) => { logged.push(args.map(String).join(' ')) })
		try { run() } finally { warn.mockRestore() }
		return logged.filter(line => line.includes('payment-proof archive is large'))
	}

	test('below the threshold nothing is logged, on load or save', () => {
		const dir = archiveDir(), store = createFilePendingStore(dir)
		expect(sizeWarnings(() => { store.saveSent!([keyed]); expect(store.loadSent!()).toHaveLength(1) })).toEqual([])
	})

	test('a large archive found at startup is reported once per store (wallet session), with counts only, and every record loads', () => {
		const dir = archiveDir(), records = large()
		writeArchive(dir, records)
		const store = createFilePendingStore(dir)
		let loaded: unknown[] = []
		const logged = sizeWarnings(() => { loaded = store.loadSent!(); store.loadSent!(); store.saveSent!(records) })
		expect(loaded).toHaveLength(records.length)
		expect(logged).toHaveLength(1)
		expect(logged[0]).toContain(`${records.length} records`)
		expect(logged[0]).toContain(`${Math.ceil(records.length / 10)} of them for transactions a node said never landed`)
		expect(logged[0]).not.toContain(valid.txid)
		expect(logged[0]).not.toContain(TX_KEY)
		expect(logged[0]).not.toContain(valid.wallet.split(':')[1])
		// A new store (the next wallet session or app run) reports it again.
		expect(sizeWarnings(() => { createFilePendingStore(dir).loadSent!() })).toHaveLength(1)
	})

	test('an archive that grows past the threshold is reported when saved, and the file keeps every record', () => {
		const dir = archiveDir(), records = large(), store = createFilePendingStore(dir)
		const logged = sizeWarnings(() => { store.saveSent!(records.slice(0, 10)); store.saveSent!(records); store.saveSent!(records) })
		expect(logged).toHaveLength(1)
		expect(JSON.parse(realFs.readFileSync(join(dir, SENT), 'utf8')).records).toHaveLength(records.length)
	})

	test('a large archive with damaged records is still kept aside and reported', () => {
		const dir = archiveDir(), records = large()
		writeArchive(dir, [...records, { wallet: 'broken' }])
		let loaded: unknown[] = []
		const logged = sizeWarnings(() => { loaded = createFilePendingStore(dir).loadSent!() })
		expect(loaded).toHaveLength(records.length)
		expect(asideCopies(dir)).toHaveLength(1)
		expect(logged).toHaveLength(1)
	})

	test('a failing log never affects loading or saving keys', () => {
		const dir = archiveDir(), records = large()
		const warn = spyOn(console, 'warn').mockImplementation(() => { throw new Error('log sink broken') })
		try {
			const store = createFilePendingStore(dir)
			expect(() => store.saveSent!(records)).not.toThrow()
			expect(createFilePendingStore(dir).loadSent!()).toHaveLength(records.length)
		} finally { warn.mockRestore() }
	})
})
