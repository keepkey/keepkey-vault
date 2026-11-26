/**
 * Broadcast a KeepKey-signed Hive transaction straight to Hive nodes.
 *
 * Pioneer's /hive/broadcast only rebuilds plain HIVE transfers, so anything
 * else (an HBD transfer, a custom_json from HiveSignOperations) is assembled
 * here from the exact header the device signed and sent with
 * condenser_api.broadcast_transaction.
 *
 * The transaction id is computed locally from the bytes the device signed
 * (sha256 of the serialized tx without signatures, first 20 bytes): the async
 * broadcast call returns nothing, and the id must exist before the node
 * answers so a lost reply can still be looked up.
 */
import { createHash } from 'node:crypto'
import { hiveTimeIso, HIVE_MAINNET_CHAIN_ID, type HiveOpTuple, type HiveTxHeader } from './hive-ops'

/** Public API nodes, tried in order on network failure only. */
export const HIVE_API_NODES = ['https://api.hive.blog', 'https://api.deathwing.me', 'https://anyx.io'] as const
const NODE_TIMEOUT_MS = 15_000

export interface SignedHiveTx {
	ref_block_num: number
	ref_block_prefix: number
	expiration: string
	operations: HiveOpTuple[]
	extensions: []
	signatures: string[]
}

function bytesToHex(b: Uint8Array): string {
	let out = ''
	for (const x of b) out += x.toString(16).padStart(2, '0')
	return out
}

function toHex(sig: Uint8Array | Buffer | string): string {
	const hex = typeof sig === 'string' ? sig.replace(/^0x/, '') : bytesToHex(sig as Uint8Array)
	// Compact recoverable secp256k1 signature: 65 bytes.
	if (!/^[0-9a-f]{130}$/i.test(hex)) throw new Error('Hive: malformed signature from device')
	return hex.toLowerCase()
}

/** The JSON transaction a node accepts, rebuilt from the signed header. */
export function assembleSignedHiveTx(params: {
	header: Pick<HiveTxHeader, 'refBlockNum' | 'refBlockPrefix' | 'expirationUnix'>
	operations: HiveOpTuple[]
	signature: Uint8Array | Buffer | string
}): SignedHiveTx {
	return {
		ref_block_num: params.header.refBlockNum,
		ref_block_prefix: params.header.refBlockPrefix,
		// From the SIGNED expirationUnix, never a separately fetched ISO string:
		// a different expiration is a different transaction.
		expiration: hiveTimeIso(params.header.expirationUnix),
		operations: params.operations,
		extensions: [],
		signatures: [toHex(params.signature)],
	}
}

/** Hive transaction id: sha256(serialized tx, no signatures)[0:20], hex.
 *  Accepts the device's bytes with or without the 32-byte chain-id prefix. */
export function hiveTxId(serializedTx: Uint8Array | Buffer, chainId: string = HIVE_MAINNET_CHAIN_ID): string {
	let bytes = new Uint8Array(serializedTx)
	if (bytes.length > 32 && bytesToHex(bytes.subarray(0, 32)) === chainId.toLowerCase()) bytes = bytes.subarray(32)
	return createHash('sha256').update(bytes).digest('hex').slice(0, 40)
}

export class HiveRpcError extends Error {
	constructor(message: string, readonly node: string) { super(message) }
}

type Fetch = (url: string, init?: RequestInit) => Promise<Response>

/** JSON-RPC call with node fallback. Falls through to the next node only when
 *  a node is unreachable; an RPC error (the chain refused the tx) is final. */
export async function hiveRpc<T = unknown>(method: string, params: unknown, opts: { nodes?: readonly string[]; fetchImpl?: Fetch } = {}): Promise<T> {
	const nodes = opts.nodes ?? HIVE_API_NODES
	const doFetch = opts.fetchImpl ?? fetch
	let lastNetworkError: unknown
	for (const node of nodes) {
		let data: any
		try {
			const resp = await doFetch(node, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
				signal: AbortSignal.timeout(NODE_TIMEOUT_MS),
			})
			if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
			data = await resp.json()
		} catch (e) {
			lastNetworkError = e
			continue
		}
		if (data?.error) throw new HiveRpcError(data.error.message || JSON.stringify(data.error).slice(0, 200), node)
		return data?.result as T
	}
	throw new Error(`Hive nodes unreachable: ${(lastNetworkError as any)?.message || 'unknown error'}`)
}

/**
 * Broadcast and return the locally computed txid. A duplicate-transaction
 * error means an earlier attempt (whose reply was lost) already landed: that
 * counts as success for the same txid.
 */
export async function broadcastSignedHiveTx(tx: SignedHiveTx, txid: string, opts: { nodes?: readonly string[]; fetchImpl?: Fetch } = {}): Promise<{ txid: string }> {
	try {
		await hiveRpc('condenser_api.broadcast_transaction', [tx], opts)
	} catch (e: any) {
		if (e instanceof HiveRpcError && /duplicate transaction/i.test(e.message)) return { txid }
		throw e
	}
	return { txid }
}

/** Whether a transaction is in a block yet (null while pending). */
export async function findHiveTransaction(txid: string, opts: { nodes?: readonly string[]; fetchImpl?: Fetch } = {}): Promise<{ blockNum: number } | null> {
	try {
		const res: any = await hiveRpc('transaction_status_api.find_transaction', { transaction_id: txid }, opts)
		if (res?.status === 'within_irreversible_block' || res?.status === 'within_reversible_block') {
			return { blockNum: Number(res.block_num) }
		}
		return null
	} catch (e) {
		if (e instanceof HiveRpcError) return null
		throw e
	}
}
