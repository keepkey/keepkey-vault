/**
 * Hive tx builder — fetches block ref from Pioneer, resolves account name
 * from STM public key, builds HiveSignTx params, and broadcasts via Pioneer.
 */

const HIVE_DECIMALS = 3
const HIVE_API_TIMEOUT_MS = 20_000

function hiveFetch(url: string, init?: RequestInit): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), HIVE_API_TIMEOUT_MS)
  return fetch(url, { ...init, signal: controller.signal }).finally(() => clearTimeout(timer))
}

export interface HiveBuildResult {
  refBlockNum: number
  refBlockPrefix: number
  expirationIso: string
  chainId: string
  from: string       // Hive account name (resolved from STM key)
  to: string         // Hive account name
  amountStr: string  // "1.000 HIVE" — for broadcast body
  amountBase: number // integer base units for hiveSignTx
  memo?: string
  pioneerBaseUrl: string
}

export async function buildHiveTransfer(params: {
  fromPublicKey: string
  to: string
  amount: string
  memo?: string
  isMax?: boolean
  pioneerBaseUrl: string
  addressNList: number[]
}): Promise<{ unsignedTx: any; fee: string }> {
  const base = params.pioneerBaseUrl.replace(/\/$/, '')

  // Fetch tx-params and account data in parallel
  const [txParamsResp, accountResp] = await Promise.all([
    hiveFetch(`${base}/api/v1/hive/tx-params`).then(r => r.json()),
    hiveFetch(`${base}/api/v1/hive/account/${encodeURIComponent(params.fromPublicKey)}`).then(r => r.json()),
  ]) as [any, any]

  if (!txParamsResp.success) throw new Error(`Hive tx-params failed: ${txParamsResp.error || 'unknown'}`)
  if (!accountResp.success || accountResp.noAccount) {
    throw new Error(
      'No Hive account found for this key. Hive accounts must be created externally (e.g. via hive.blog) before sending.'
    )
  }

  const fromAccount: string = accountResp.account?.name
  if (!fromAccount) throw new Error('Hive: account response missing name')

  // Resolve send amount
  let amountBase: number
  if (params.isMax) {
    const balanceStr: string = accountResp.account?.hive || '0.000'
    const parsed = parseFloat(balanceStr)
    if (!isFinite(parsed) || parsed <= 0) throw new Error('HIVE balance is zero — cannot send max')
    amountBase = Math.round(parsed * 1000)
  } else {
    const parsed = parseFloat(params.amount)
    if (!isFinite(parsed) || parsed <= 0) throw new Error('Amount must be greater than zero')
    amountBase = Math.round(parsed * 1000)
  }
  if (amountBase <= 0) throw new Error('Resolved HIVE amount is zero')

  const amountStr = (amountBase / 1000).toFixed(HIVE_DECIMALS) + ' HIVE'

  const hiveBuildResult: HiveBuildResult = {
    refBlockNum: txParamsResp.refBlockNum,
    refBlockPrefix: txParamsResp.refBlockPrefix,
    expirationIso: txParamsResp.expirationIso,
    chainId: txParamsResp.chainId,
    from: fromAccount,
    to: params.to,
    amountStr,
    amountBase,
    memo: params.memo,
    pioneerBaseUrl: params.pioneerBaseUrl,
  }

  const unsignedTx = {
    addressNList: params.addressNList,
    chainId: txParamsResp.chainId,
    refBlockNum: txParamsResp.refBlockNum,
    refBlockPrefix: txParamsResp.refBlockPrefix,
    expiration: txParamsResp.expirationUnix,
    from: fromAccount,
    to: params.to,
    amount: amountBase,
    decimals: HIVE_DECIMALS,
    assetSymbol: 'HIVE',
    memo: params.memo,
    hiveBuildResult,
  }

  // Hive transfers have no mandatory fee
  return { unsignedTx, fee: '0' }
}

export async function broadcastHiveTx(signedTx: any): Promise<{ txid: string }> {
  const build: HiveBuildResult = signedTx?.hiveBuildResult
  if (!build) throw new Error('Hive broadcast requires hiveBuildResult in signedTx')

  const rawSig = signedTx?.signature
  if (!rawSig) throw new Error('Hive broadcast requires signature in signedTx')

  const sigHex =
    rawSig instanceof Uint8Array || Buffer.isBuffer(rawSig)
      ? Buffer.from(rawSig).toString('hex')
      : typeof rawSig === 'string'
        ? rawSig.replace(/^0x/, '')
        : null
  if (!sigHex || !/^[0-9a-fA-F]+$/.test(sigHex)) {
    throw new Error(`Hive: malformed signature (type=${typeof rawSig})`)
  }

  const body = {
    ref_block_num: build.refBlockNum,
    ref_block_prefix: build.refBlockPrefix,
    expiration: build.expirationIso,
    from: build.from,
    to: build.to,
    amount: build.amountStr,
    memo: build.memo,
    signature: sigHex,
  }

  const base = build.pioneerBaseUrl.replace(/\/$/, '')
  const resp = await fetch(`${base}/api/v1/hive/broadcast`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const data = await resp.json() as any

  if (!data.success) {
    throw new Error(`Hive broadcast failed: ${data.error || JSON.stringify(data).slice(0, 200)}`)
  }
  if (!data.txid) {
    throw new Error(`Hive broadcast returned no txid: ${JSON.stringify(data).slice(0, 200)}`)
  }

  return { txid: data.txid }
}
