/**
 * Sweep Engine — scans non-standard BTC derivation paths and sweeps funds.
 *
 * Recovers BTC stuck at:
 *   A) Account-level keys (3-element paths like m/84'/0'/0' — no /0/0 suffix)
 *   B) Purpose/scriptType mismatches (e.g., BIP44 path + p2wpkh encoding)
 *
 * Workflow: generate path matrix → derive addresses from device →
 *   check balances via Pioneer → build sweep tx → sign → broadcast.
 */
import { BTC_SCRIPT_TYPES, btcAccountPath } from '../shared/chains'
import { getBackendForNetwork } from './btc-backend'
import coinSelectSplit from 'coinselect/split'

const TAG = '[sweep]'

const BTC_NETWORK_ID = 'bip122:000000000019d6689c085ae165831e93'

// Standard combos (these are normal — skip them in sweep scan)
const STANDARD_COMBOS = new Set([
  '44:p2pkh',
  '49:p2sh-p2wpkh',
  '84:p2wpkh',
])

// ── Types ──────────────────────────────────────────────────────────

export interface SweepAddress {
  path: number[]
  pathStr: string
  scriptType: string
  address: string
  category: 'account-key' | 'mismatch' | 'higher-account'
  accountIndex?: number
  balanceSats: number
  utxos: SweepUtxo[]
}

export interface SweepUtxo {
  txid: string
  vout: number
  value: number // satoshis
  hex?: string  // raw tx hex (needed for non-segwit inputs)
}

export interface SweepScan {
  id: string
  status: 'scanning' | 'complete' | 'error'
  progress: { current: number; total: number; phase: string }
  startedAt: number
  completedAt?: number
  results: SweepAddress[]
  totalFoundSats: number
  error?: string
  // Signing guard (set by the RPC layer for the audit recovery path): the wallet
  // handle + seed identity captured when the scan ran. Re-checked before signing
  // so UTXOs found under a since-replaced wallet/seed are never swept.
  capturedWallet?: any
  seedIdentity?: string | null
}

export interface SweepScanConfig {
  accountRange?: [number, number] // default [0, 4]
  mismatchAccounts?: number       // default 1
  currentMaxAccount?: number      // user's highest configured account index (default 0)
  higherAccountScanLimit?: number // scan standard combos up to this account index (default 9)
  // Gap-limit expansion (audit "scan deeper indices"). Receive indices probed are
  // 0..gapLimitReceive-1, change 0..gapLimitChange-1. Defaults preserve the prior
  // hardcoded behaviour (Cat B receive 5 / Cat C receive 3, change 1).
  gapLimitReceive?: number        // Category B receive depth (default 5)
  gapLimitChange?: number         // change-branch depth for Cat B + Cat C (default 1)
  higherReceiveLimit?: number     // Category C receive depth (default 3)
}

// Live per-path progress, emitted as each path is derived/checked so the UI can
// stream what it's doing (rather than a bare current/total counter). Optional —
// only wired when the caller asks (the audit "unusual paths" panel).
export interface SweepProgressEvent {
  scanId: string
  phase: 'deriving' | 'found'
  current?: number
  total?: number
  pathStr: string
  scriptType: string
  category?: PathEntry['category']
  address?: string
  balanceSats?: number
}
export type SweepProgressFn = (evt: SweepProgressEvent) => void

// ── Scan store (in-memory) ─────────────────────────────────────────

const scans = new Map<string, SweepScan>()

export function getScan(id: string): SweepScan | undefined {
  return scans.get(id)
}

// ── Path matrix generation ─────────────────────────────────────────

export interface PathEntry {
  path: number[]
  pathStr: string
  scriptType: string
  category: 'account-key' | 'mismatch' | 'higher-account'
  accountIndex?: number
}

function pathToString(path: number[]): string {
  return 'm/' + path.map(p => p >= 0x80000000 ? `${p - 0x80000000}'` : String(p)).join('/')
}

export function generatePathMatrix(config: SweepScanConfig): PathEntry[] {
  const entries: PathEntry[] = []
  const [acctMin, acctMax] = config.accountRange || [0, 4]
  const mismatchAccts = config.mismatchAccounts ?? 1
  const gapReceive = Math.max(config.gapLimitReceive ?? 5, 1)
  const gapChange = Math.max(config.gapLimitChange ?? 1, 0)
  const higherReceive = Math.max(config.higherReceiveLimit ?? 3, 1)

  const scriptTypes = BTC_SCRIPT_TYPES.map(st => st.scriptType)

  // Category A: Account-level keys (3-element paths)
  for (const st of BTC_SCRIPT_TYPES) {
    for (let acct = acctMin; acct <= acctMax; acct++) {
      const acctPath = btcAccountPath(st.purpose, acct) // 3-element
      for (const encodeAs of scriptTypes) {
        entries.push({
          path: acctPath,
          pathStr: pathToString(acctPath),
          scriptType: encodeAs,
          category: 'account-key',
        })
      }
    }
  }

  // Category B: Purpose/scriptType mismatches (5-element paths)
  for (let acct = 0; acct < mismatchAccts; acct++) {
    for (const st of BTC_SCRIPT_TYPES) {
      for (const encodeAs of scriptTypes) {
        // Skip standard combos
        if (STANDARD_COMBOS.has(`${st.purpose}:${encodeAs}`)) continue

        // Receive indices 0..gapReceive-1
        for (let idx = 0; idx < gapReceive; idx++) {
          const path = [...btcAccountPath(st.purpose, acct), 0, idx]
          entries.push({ path, pathStr: pathToString(path), scriptType: encodeAs, category: 'mismatch' })
        }
        // Change indices 0..gapChange-1
        for (let idx = 0; idx < gapChange; idx++) {
          const changePath = [...btcAccountPath(st.purpose, acct), 1, idx]
          entries.push({ path: changePath, pathStr: pathToString(changePath), scriptType: encodeAs, category: 'mismatch' })
        }
      }
    }
  }

  // Category C: Standard combos at higher account indices (beyond user's tracked accounts)
  // Default scan limit: currentMax + 10, capped by schema max (19)
  const currentMax = config.currentMaxAccount ?? 0
  const higherLimit = config.higherAccountScanLimit ?? Math.min(currentMax + 10, 19)
  for (let acct = currentMax + 1; acct <= higherLimit; acct++) {
    for (const st of BTC_SCRIPT_TYPES) {
      // Standard combo: purpose matches scriptType
      // Probe receive indices 0..higherReceive-1 + change to catch funds beyond first address
      for (let idx = 0; idx < higherReceive; idx++) {
        const path = [...btcAccountPath(st.purpose, acct), 0, idx]
        entries.push({
          path,
          pathStr: pathToString(path),
          scriptType: st.scriptType,
          category: 'higher-account',
          accountIndex: acct,
        })
      }
      for (let idx = 0; idx < gapChange; idx++) {
        const changePath = [...btcAccountPath(st.purpose, acct), 1, idx]
        entries.push({
          path: changePath,
          pathStr: pathToString(changePath),
          scriptType: st.scriptType,
          category: 'higher-account',
          accountIndex: acct,
        })
      }
    }
  }

  return entries
}

// ── Address derivation ─────────────────────────────────────────────

async function deriveAddress(wallet: any, path: number[], scriptType: string): Promise<string> {
  const result = await wallet.btcGetAddress({
    addressNList: path,
    coin: 'Bitcoin',
    scriptType,
    showDisplay: false,
  })
  return typeof result === 'string' ? result : result?.address
}

// ── Balance & UTXO checking ────────────────────────────────────────

// Per-address balance in satoshis, sourced from the UTXO set (ListUnspent).
//
// Do NOT use Pioneer's GetBalanceAddressByNetwork here. Despite the name, that
// endpoint is EVM-only (route /evm/balance/{networkId}/{address} → ETH JSON-RPC):
// passing a bip122 networkId + a Bitcoin address routes into the ETH provider,
// which throws on the non-hex address, so it ALWAYS returned 0. The sweep/audit
// gate is `balanceSats > 0`, so it never opened and funded BTC addresses were
// silently missed. ListUnspent is the only Pioneer endpoint that serves Bitcoin,
// and its UTXO `value` is integer satoshis — no unit guessing needed.
export async function checkAddressBalance(address: string): Promise<number> {
  const utxos = await fetchUtxos(address)
  return utxos.reduce((sum, u) => sum + u.value, 0)
}

export async function fetchUtxos(address: string, networkId: string = BTC_NETWORK_ID): Promise<SweepUtxo[]> {
  try {
    // ListUnspent accepts a single address as well as an xpub. The backend
    // normalizes value→int-sats and hex, and already drops zero-value rows.
    const utxos = await getBackendForNetwork(networkId).listUnspent({ network: networkId, address })
    return utxos.map((u) => ({ txid: u.txid, vout: u.vout, value: u.value, hex: u.hex }))
  } catch (e: any) {
    console.warn(`${TAG} UTXO fetch failed for ${address}: ${e.message}`)
    return []
  }
}

async function fetchTxHex(txid: string, networkId: string = BTC_NETWORK_ID): Promise<string | undefined> {
  try {
    return await getBackendForNetwork(networkId).rawTxHex({ network: networkId, txid })
  } catch {
    return undefined
  }
}

// ─�� Scan worker ────────────────────────────────────────────────────

export async function startScan(wallet: any, config: SweepScanConfig = {}, onProgress?: SweepProgressFn): Promise<string> {
  const id = crypto.randomUUID()
  const matrix = generatePathMatrix(config)

  const scan: SweepScan = {
    id,
    status: 'scanning',
    progress: { current: 0, total: matrix.length, phase: 'deriving' },
    startedAt: Date.now(),
    results: [],
    totalFoundSats: 0,
  }
  scans.set(id, scan)

  // Run async — don't block the HTTP response
  scanWorker(scan, wallet, matrix, onProgress).catch(e => {
    scan.status = 'error'
    scan.error = e.message
    console.error(`${TAG} Scan ${id} failed:`, e)
  })

  return id
}

async function scanWorker(scan: SweepScan, wallet: any, matrix: PathEntry[], onProgress?: SweepProgressFn): Promise<void> {
  console.log(`${TAG} Scan ${scan.id}: deriving ${matrix.length} addresses...`)

  // Phase 1: Derive all addresses from device (sequential — USB is serial)
  scan.progress.phase = 'deriving'
  const derived: Array<PathEntry & { address: string }> = []

  for (let i = 0; i < matrix.length; i++) {
    const entry = matrix[i]
    // Tell the UI which path we're about to check, before the device round-trip.
    onProgress?.({ scanId: scan.id, phase: 'deriving', current: i + 1, total: matrix.length, pathStr: entry.pathStr, scriptType: entry.scriptType, category: entry.category })
    try {
      const address = await deriveAddress(wallet, entry.path, entry.scriptType)
      if (address) {
        derived.push({ ...entry, address })
      }
    } catch (e: any) {
      console.warn(`${TAG} Failed to derive ${entry.pathStr} as ${entry.scriptType}: ${e.message}`)
    }
    scan.progress.current = i + 1
  }

  console.log(`${TAG} Scan ${scan.id}: derived ${derived.length} addresses, checking balances...`)

  // Phase 2: Check balances (can parallelize — 5 at a time)
  scan.progress = { current: 0, total: derived.length, phase: 'checking' }

  const BATCH_SIZE = 5
  for (let i = 0; i < derived.length; i += BATCH_SIZE) {
    const batch = derived.slice(i, i + BATCH_SIZE)
    const results = await Promise.all(batch.map(async (entry) => {
      const balance = await checkAddressBalance(entry.address)
      return { ...entry, balanceSats: balance }
    }))

    for (const r of results) {
      if (r.balanceSats > 0) {
        console.log(`${TAG} FOUND: ${r.address} (${r.pathStr} as ${r.scriptType}) [${r.category}] = ${r.balanceSats} sats`)
        onProgress?.({ scanId: scan.id, phase: 'found', pathStr: r.pathStr, scriptType: r.scriptType, category: r.category, address: r.address, balanceSats: r.balanceSats })
        const utxos = await fetchUtxos(r.address)
        scan.results.push({
          path: r.path,
          pathStr: r.pathStr,
          scriptType: r.scriptType,
          address: r.address,
          category: r.category,
          accountIndex: r.accountIndex,
          balanceSats: r.balanceSats,
          utxos,
        })
        scan.totalFoundSats += r.balanceSats
      }
    }
    scan.progress.current = Math.min(i + BATCH_SIZE, derived.length)
  }

  scan.status = 'complete'
  scan.completedAt = Date.now()
  const elapsed = ((scan.completedAt - scan.startedAt) / 1000).toFixed(1)
  console.log(`${TAG} Scan ${scan.id} complete: ${scan.results.length} funded addresses, ${scan.totalFoundSats} sats total (${elapsed}s)`)
}

// ── Sweep transaction builder ──────────────────────────────────────

export interface SweepTxResult {
  unsignedTx: any
  inputCount: number
  totalInputSats: number
  fee: number
  destinationAddress: string
}

export async function buildSweepTx(
  scan: SweepScan,
  destinationAddress: string,
  // Chain override for non-BTC UTXO sweeps (the audit uncommon-path sweep).
  // Defaults keep every existing BTC caller byte-identical.
  opts: { coin?: string; networkId?: string } = {},
): Promise<SweepTxResult> {
  const coin = opts.coin || 'Bitcoin'
  const networkId = opts.networkId || BTC_NETWORK_ID
  // Only sweep mismatch/account-key entries — higher-account funds are recovered by adding the account
  const funded = scan.results.filter(r => r.utxos.length > 0 && r.category !== 'higher-account')
  if (funded.length === 0) throw new Error('No UTXOs found to sweep')

  // Fetch fee rate (sat/vByte; backend handles the sat/kB↔sat/vB detection)
  let feeRate = 5
  try {
    feeRate = (await getBackendForNetwork(networkId).feeRate(networkId)).fast
  } catch (e: any) {
    console.warn(`${TAG} Fee rate fetch failed, using default ${feeRate}: ${e.message}`)
  }
  if (feeRate < 1) feeRate = 1

  // Collect all UTXOs across all funded addresses
  const allUtxos: Array<{ value: number; entry: SweepAddress; utxo: SweepUtxo }> = []
  for (const entry of funded) {
    for (const utxo of entry.utxos) {
      allUtxos.push({ value: utxo.value, entry, utxo })
    }
  }

  // Coin selection (send-max to single destination)
  const csInputs = allUtxos.map(u => ({ value: u.value }))
  const csOutputs = [{ address: destinationAddress }] // no value = send-max
  const result = coinSelectSplit(csInputs, csOutputs, feeRate)

  if (!result || !result.inputs || !result.outputs) {
    throw new Error('Coin selection failed — fee may exceed total balance')
  }

  const fee = result.fee as number
  const totalInputSats = allUtxos.reduce((sum, u) => sum + u.value, 0)

  // Fetch raw tx hex for inputs that need it (non-segwit: p2pkh)
  for (const u of allUtxos) {
    if (u.entry.scriptType === 'p2pkh' && !u.utxo.hex) {
      u.utxo.hex = await fetchTxHex(u.utxo.txid, networkId) || ''
    }
  }

  // Build hdwallet btcSignTx payload with per-input path/scriptType
  const inputs = allUtxos.map((u, i) => ({
    addressNList: u.entry.path,
    scriptType: u.entry.scriptType,
    amount: String(u.utxo.value),
    vout: u.utxo.vout,
    txid: u.utxo.txid,
    hex: u.utxo.hex || '',
  }))

  // Single output — the swept amount
  const outputAmount = result.outputs[0]?.value || (totalInputSats - fee)
  const outputs = [{
    address: destinationAddress,
    addressType: 'spend' as const,
    amount: String(outputAmount),
  }]

  const unsignedTx = {
    coin,
    inputs,
    outputs,
    version: 1,
    locktime: 0,
  }

  return {
    unsignedTx,
    inputCount: inputs.length,
    totalInputSats,
    fee,
    destinationAddress,
  }
}
