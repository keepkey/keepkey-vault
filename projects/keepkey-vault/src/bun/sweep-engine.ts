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
import { getPioneer, getPioneerApiBase } from './pioneer'
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
}

export interface SweepScanConfig {
  accountRange?: [number, number] // default [0, 4]
  mismatchAccounts?: number       // default 1
  currentMaxAccount?: number      // user's highest configured account index (default 0)
  higherAccountScanLimit?: number // scan standard combos up to this account index (default 9)
}

// ── Scan store (in-memory) ─────────────────────────────────────────

const scans = new Map<string, SweepScan>()

export function getScan(id: string): SweepScan | undefined {
  return scans.get(id)
}

// ── Path matrix generation ─────────────────────────────────────────

interface PathEntry {
  path: number[]
  pathStr: string
  scriptType: string
  category: 'account-key' | 'mismatch' | 'higher-account'
  accountIndex?: number
}

function pathToString(path: number[]): string {
  return 'm/' + path.map(p => p >= 0x80000000 ? `${p - 0x80000000}'` : String(p)).join('/')
}

function generatePathMatrix(config: SweepScanConfig): PathEntry[] {
  const entries: PathEntry[] = []
  const [acctMin, acctMax] = config.accountRange || [0, 4]
  const mismatchAccts = config.mismatchAccounts ?? 1

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

        // Receive indices 0-4
        for (let idx = 0; idx < 5; idx++) {
          const path = [...btcAccountPath(st.purpose, acct), 0, idx]
          entries.push({ path, pathStr: pathToString(path), scriptType: encodeAs, category: 'mismatch' })
        }
        // Change index 0
        const changePath = [...btcAccountPath(st.purpose, acct), 1, 0]
        entries.push({ path: changePath, pathStr: pathToString(changePath), scriptType: encodeAs, category: 'mismatch' })
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
      // Probe receive indices 0-2 + change index 0 to catch funds beyond first address
      for (let idx = 0; idx < 3; idx++) {
        const path = [...btcAccountPath(st.purpose, acct), 0, idx]
        entries.push({
          path,
          pathStr: pathToString(path),
          scriptType: st.scriptType,
          category: 'higher-account',
          accountIndex: acct,
        })
      }
      const changePath = [...btcAccountPath(st.purpose, acct), 1, 0]
      entries.push({
        path: changePath,
        pathStr: pathToString(changePath),
        scriptType: st.scriptType,
        category: 'higher-account',
        accountIndex: acct,
      })
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

async function checkAddressBalance(address: string): Promise<number> {
  try {
    const pioneer = await getPioneer()
    const resp = await pioneer.GetBalanceAddressByNetwork({
      networkId: BTC_NETWORK_ID,
      address,
    })
    const data = resp?.data || resp
    const balStr = data?.nativeBalance || data?.balance || '0'
    // Balance comes as BTC string or satoshis — detect by magnitude
    const val = parseFloat(balStr)
    if (isNaN(val) || val === 0) return 0
    // If value < 1, assume BTC; if >= 1 and looks like sats, use as-is
    // Pioneer returns BTC for UTXO chains typically
    return val < 21_000_000 ? Math.round(val * 1e8) : Math.round(val)
  } catch (e: any) {
    console.warn(`${TAG} Balance check failed for ${address}: ${e.message}`)
    return 0
  }
}

async function fetchUtxos(address: string): Promise<SweepUtxo[]> {
  try {
    // Use blockbook API directly — Pioneer's ListUnspent needs xpub, not address
    const base = getPioneerApiBase()
    const resp = await fetch(`${base}/api/v2/utxo/${address}`)
    if (!resp.ok) {
      console.warn(`${TAG} Blockbook UTXO fetch failed for ${address}: ${resp.status}`)
      return []
    }
    const data = await resp.json() as any[]
    if (!Array.isArray(data)) return []

    return data.map((u: any) => ({
      txid: u.txid,
      vout: u.vout,
      value: parseInt(u.value, 10) || 0,
      hex: u.hex || undefined,
    })).filter((u: SweepUtxo) => u.value > 0)
  } catch (e: any) {
    console.warn(`${TAG} UTXO fetch failed for ${address}: ${e.message}`)
    return []
  }
}

async function fetchTxHex(txid: string): Promise<string | undefined> {
  try {
    const base = getPioneerApiBase()
    const resp = await fetch(`${base}/api/v2/tx-specific/${txid}`)
    if (!resp.ok) return undefined
    const data = await resp.json() as any
    return data?.hex || undefined
  } catch {
    return undefined
  }
}

// ─�� Scan worker ────────────────────────────────────────────────────

export async function startScan(wallet: any, config: SweepScanConfig = {}): Promise<string> {
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
  scanWorker(scan, wallet, matrix).catch(e => {
    scan.status = 'error'
    scan.error = e.message
    console.error(`${TAG} Scan ${id} failed:`, e)
  })

  return id
}

async function scanWorker(scan: SweepScan, wallet: any, matrix: PathEntry[]): Promise<void> {
  console.log(`${TAG} Scan ${scan.id}: deriving ${matrix.length} addresses...`)

  // Phase 1: Derive all addresses from device (sequential — USB is serial)
  scan.progress.phase = 'deriving'
  const derived: Array<PathEntry & { address: string }> = []

  for (let i = 0; i < matrix.length; i++) {
    const entry = matrix[i]
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
): Promise<SweepTxResult> {
  // Only sweep mismatch/account-key entries — higher-account funds are recovered by adding the account
  const funded = scan.results.filter(r => r.utxos.length > 0 && r.category !== 'higher-account')
  if (funded.length === 0) throw new Error('No UTXOs found to sweep')

  // Fetch fee rate
  const pioneer = await getPioneer()
  let feeRate = 5 // sat/byte default
  try {
    const feeResp = await pioneer.GetFeeRateByNetwork({ networkId: BTC_NETWORK_ID })
    const feeData = feeResp?.data || feeResp
    const fast = feeData?.fast || feeData?.average || 5
    // Auto-detect sat/kB vs sat/byte
    feeRate = fast > 500 ? Math.ceil(fast / 1000) : Math.ceil(fast)
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
      u.utxo.hex = await fetchTxHex(u.utxo.txid) || ''
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
    coin: 'Bitcoin',
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
