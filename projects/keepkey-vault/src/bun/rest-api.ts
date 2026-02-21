import type { EngineController } from './engine-controller'
import type { AuthStore } from './auth'
import type { Server } from 'bun'
import { readFileSync } from 'fs'
import { join } from 'path'

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  })
}

function binary(data: Uint8Array | Buffer, status = 200): Response {
  return new Response(data, {
    status,
    headers: { 'Content-Type': 'application/octet-stream', ...CORS_HEADERS },
  })
}

function requireWallet(engine: EngineController) {
  if (!engine.wallet) throw { status: 503, message: 'No device connected' }
  return engine.wallet
}

// ── Features cache (10s TTL, matches keepkey-desktop) ──────────────────
let featuresCache: { timestamp: number; data: any } | null = null
const FEATURES_TTL_MS = 10_000

async function getCachedFeatures(wallet: any): Promise<any> {
  const now = Date.now()
  if (featuresCache && (now - featuresCache.timestamp) < FEATURES_TTL_MS) {
    return featuresCache.data
  }
  const features = await wallet.getFeatures()
  featuresCache = { timestamp: now, data: features }
  return features
}

// ── Public key cache ───────────────────────────────────────────────────
const pubkeyCache = new Map<string, any>()

// ── Address cache ──────────────────────────────────────────────────────
const addressCache = new Map<string, string>()

// ── Cosmos-family amino signing helper ─────────────────────────────────
async function cosmosAminoSign(
  wallet: any,
  auth: AuthStore,
  body: any,
  walletMethod: string,
  defaultDenom: string,
  defaultFeeAmount: string,
  defaultGas: string,
): Promise<any> {
  const { signDoc, signerAddress } = body
  if (!signDoc) throw { status: 400, message: 'Missing signDoc' }
  if (!signerAddress) throw { status: 400, message: 'Missing signerAddress' }

  // Default fee if not provided
  if (!signDoc.fee || !signDoc.fee.amount || signDoc.fee.amount.length === 0) {
    signDoc.fee = {
      amount: [{ denom: defaultDenom, amount: defaultFeeAmount }],
      gas: defaultGas,
    }
  }

  const tx = {
    account_number: String(signDoc.account_number),
    chain_id: signDoc.chain_id,
    fee: signDoc.fee,
    memo: signDoc.memo || '',
    msg: [signDoc.msgs?.[0] || signDoc.msg?.[0]],
    signatures: [],
    sequence: signDoc.sequence,
  }

  const { addressNList } = auth.getAccount(signerAddress)

  const input = {
    tx,
    addressNList,
    chain_id: tx.chain_id,
    account_number: tx.account_number,
    sequence: tx.sequence,
  }

  const response = await (wallet as any)[walletMethod](input)

  return {
    signature: response?.signatures?.[0] ?? response?.signature,
    serialized: response?.serialized,
    signed: signDoc,
  }
}

// ── ETH account scanning (scan first 5 accounts) ──────────────────────
async function findEthAddressNList(
  wallet: any,
  auth: AuthStore,
  fromAddress: string,
): Promise<number[]> {
  const lower = fromAddress.toLowerCase()

  // Check cache first
  try {
    return auth.getAccount(lower).addressNList
  } catch { /* not cached */ }

  // Scan first 5 account indices
  for (let i = 0; i < 5; i++) {
    const addressNList = [0x8000002C, 0x8000003C, 0x80000000 + i, 0, 0]
    const result = await wallet.ethGetAddress({ addressNList, showDisplay: false })
    const addr = (typeof result === 'string' ? result : result?.address || '').toLowerCase()
    if (addr) {
      auth.saveAccount(addr, addressNList)
      if (addr === lower) return addressNList
    }
  }
  throw { status: 400, message: `Could not find addressNList for ${fromAddress} (scanned 5 accounts)` }
}

// ── Load swagger.json once ─────────────────────────────────────────────
let swaggerContent: string | null = null
function getSwagger(): string {
  if (!swaggerContent) {
    swaggerContent = readFileSync(join(__dirname, 'swagger.json'), 'utf-8')
  }
  return swaggerContent
}

export function startRestApi(engine: EngineController, auth: AuthStore, port = 1646): Server {
  const server = Bun.serve({
    reusePort: true,
    port,
    async fetch(req) {
      const url = new URL(req.url)
      const path = url.pathname
      const method = req.method

      // CORS preflight
      if (method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: CORS_HEADERS })
      }

      try {
        // ═══════════════════════════════════════════════════════════════
        // SPEC (public)
        // ═══════════════════════════════════════════════════════════════
        if (path === '/spec/swagger.json' && method === 'GET') {
          return new Response(getSwagger(), {
            headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
          })
        }

        // ═══════════════════════════════════════════════════════════════
        // AUTH
        // ═══════════════════════════════════════════════════════════════
        if (path === '/auth/pair') {
          if (method === 'GET') {
            const entry = auth.requireAuth(req)
            return json(entry.info)
          }
          if (method === 'POST') {
            const body = await req.json() as any
            if (!body.name) throw { status: 400, message: 'Missing name in pairing request' }
            const apiKey = auth.pair(body)
            return json({ apiKey })
          }
        }

        // ═══════════════════════════════════════════════════════════════
        // ADMIN (public)
        // ═══════════════════════════════════════════════════════════════
        if (path === '/admin/wallets' && method === 'GET') {
          return json([])
        }
        if (path === '/admin/wallets/current' && method === 'GET') {
          return json(null)
        }
        if (path === '/admin/wallets/switch' && method === 'POST') {
          return json({ success: true })
        }
        if (path === '/admin/usb/devices' && method === 'GET') {
          return json([])
        }
        if (path === '/admin/usb/state' && method === 'GET') {
          return json({ connected: engine.wallet !== null })
        }
        if (path === '/admin/info' && method === 'GET') {
          return json({
            wallets: [],
            currentWallet: null,
            usbState: { connected: engine.wallet !== null },
          })
        }

        // ═══════════════════════════════════════════════════════════════
        // All remaining endpoints require POST + auth
        // ═══════════════════════════════════════════════════════════════

        // ── ADDRESSES (9 endpoints) ──────────────────────────────────
        if (path === '/addresses/utxo' && method === 'POST') {
          auth.requireAuth(req)
          const wallet = requireWallet(engine)
          const body = await req.json() as any
          if (!body.address_n) throw { status: 400, message: 'Missing address_n' }
          const cacheKey = JSON.stringify(body)
          const cached = addressCache.get(cacheKey)
          if (cached) return json({ address: cached })
          const result = await wallet.btcGetAddress({
            addressNList: body.address_n,
            coin: body.coin || 'Bitcoin',
            scriptType: body.script_type,
            showDisplay: body.show_display ?? false,
          })
          const address = typeof result === 'string' ? result : result?.address || result
          addressCache.set(cacheKey, address)
          auth.saveAccount(String(address), body.address_n)
          return json({ address })
        }

        if (path === '/addresses/bnb' && method === 'POST') {
          auth.requireAuth(req)
          const wallet = requireWallet(engine)
          const body = await req.json() as any
          if (!body.address_n) throw { status: 400, message: 'Missing address_n' }
          const cacheKey = JSON.stringify(body)
          const cached = addressCache.get(cacheKey)
          if (cached) return json({ address: cached })
          const result = await wallet.binanceGetAddress({
            addressNList: body.address_n,
            showDisplay: body.show_display ?? false,
          })
          const address = typeof result === 'string' ? result : result?.address || result
          addressCache.set(cacheKey, address)
          auth.saveAccount(String(address), body.address_n)
          return json({ address })
        }

        if (path === '/addresses/cosmos' && method === 'POST') {
          auth.requireAuth(req)
          const wallet = requireWallet(engine)
          const body = await req.json() as any
          if (!body.address_n) throw { status: 400, message: 'Missing address_n' }
          const cacheKey = JSON.stringify(body)
          const cached = addressCache.get(cacheKey)
          if (cached) return json({ address: cached })
          const result = await wallet.cosmosGetAddress({
            addressNList: body.address_n,
            showDisplay: body.show_display ?? false,
          })
          const address = typeof result === 'string' ? result : result?.address || result
          addressCache.set(cacheKey, address)
          auth.saveAccount(String(address), body.address_n)
          return json({ address })
        }

        if (path === '/addresses/osmosis' && method === 'POST') {
          auth.requireAuth(req)
          const wallet = requireWallet(engine)
          const body = await req.json() as any
          if (!body.address_n) throw { status: 400, message: 'Missing address_n' }
          const cacheKey = 'osmo:' + JSON.stringify(body)
          const cached = addressCache.get(cacheKey)
          if (cached) return json({ address: cached })
          const result = await wallet.osmosisGetAddress({
            addressNList: body.address_n,
            showDisplay: body.show_display ?? false,
          })
          const address = typeof result === 'string' ? result : result?.address || result
          addressCache.set(cacheKey, address)
          auth.saveAccount(String(address), body.address_n)
          return json({ address })
        }

        if (path === '/addresses/eth' && method === 'POST') {
          auth.requireAuth(req)
          const wallet = requireWallet(engine)
          const body = await req.json() as any
          if (!body.address_n) throw { status: 400, message: 'Missing address_n' }
          const cacheKey = JSON.stringify(body)
          const cached = addressCache.get(cacheKey)
          if (cached) return json({ address: cached })
          const result = await wallet.ethGetAddress({
            addressNList: body.address_n,
            showDisplay: body.show_display ?? false,
          })
          const address = typeof result === 'string' ? result : result?.address || result
          addressCache.set(cacheKey, address)
          auth.saveAccount(String(address), body.address_n)
          return json({ address })
        }

        if (path === '/addresses/tendermint' && method === 'POST') {
          auth.requireAuth(req)
          const wallet = requireWallet(engine)
          const body = await req.json() as any
          if (!body.address_n) throw { status: 400, message: 'Missing address_n' }
          const cacheKey = JSON.stringify(body)
          const cached = addressCache.get(cacheKey)
          if (cached) return json({ address: cached })
          const result = await wallet.cosmosGetAddress({
            addressNList: body.address_n,
            showDisplay: body.show_display ?? false,
          })
          const address = typeof result === 'string' ? result : result?.address || result
          addressCache.set(cacheKey, address)
          auth.saveAccount(String(address), body.address_n)
          return json({ address })
        }

        if (path === '/addresses/thorchain' && method === 'POST') {
          auth.requireAuth(req)
          const wallet = requireWallet(engine)
          const body = await req.json() as any
          if (!body.address_n) throw { status: 400, message: 'Missing address_n' }
          const cacheKey = 'thor:' + JSON.stringify(body)
          const cached = addressCache.get(cacheKey)
          if (cached) return json({ address: cached })
          const result = await wallet.thorchainGetAddress({
            addressNList: body.address_n,
            showDisplay: body.show_display ?? false,
          })
          const address = typeof result === 'string' ? result : result?.address || result
          addressCache.set(cacheKey, address)
          auth.saveAccount(String(address), body.address_n)
          return json({ address })
        }

        if (path === '/addresses/mayachain' && method === 'POST') {
          auth.requireAuth(req)
          const wallet = requireWallet(engine)
          const body = await req.json() as any
          if (!body.address_n) throw { status: 400, message: 'Missing address_n' }
          const cacheKey = 'maya:' + JSON.stringify(body)
          const cached = addressCache.get(cacheKey)
          if (cached) return json({ address: cached })
          const result = await wallet.mayachainGetAddress({
            addressNList: body.address_n,
            showDisplay: body.show_display ?? false,
          })
          const address = typeof result === 'string' ? result : result?.address || result
          addressCache.set(cacheKey, address)
          auth.saveAccount(String(address), body.address_n)
          return json({ address })
        }

        if (path === '/addresses/xrp' && method === 'POST') {
          auth.requireAuth(req)
          const wallet = requireWallet(engine)
          const body = await req.json() as any
          if (!body.address_n) throw { status: 400, message: 'Missing address_n' }
          const cacheKey = JSON.stringify(body)
          const cached = addressCache.get(cacheKey)
          if (cached) return json({ address: cached })
          const result = await wallet.rippleGetAddress({
            addressNList: body.address_n,
            showDisplay: body.show_display ?? false,
          })
          const address = typeof result === 'string' ? result : result?.address || result
          addressCache.set(cacheKey, address)
          auth.saveAccount(String(address), body.address_n)
          return json({ address })
        }

        // ── ETH SIGNING (4 endpoints) ────────────────────────────────
        if (path === '/eth/sign-transaction' && method === 'POST') {
          auth.requireAuth(req)
          const wallet = requireWallet(engine)
          const body = await req.json() as any

          // Resolve addressNList from body or by scanning
          let addressNList = body.addressNList || body.address_n_list
          if (!addressNList && body.from) {
            addressNList = await findEthAddressNList(wallet, auth, body.from)
          }
          if (!addressNList) throw { status: 400, message: 'Missing from address or addressNList' }

          // chainId: default to 1 if 0 or missing
          let chainId = body.chainId ?? body.chain_id ?? 1
          if (typeof chainId === 'string') {
            chainId = chainId.startsWith('0x') ? parseInt(chainId, 16) : parseInt(chainId, 10)
          }
          if (!chainId || chainId === 0) chainId = 1

          const msg: any = {
            addressNList,
            to: body.to,
            value: body.value || '0x0',
            data: body.data || '0x',
            nonce: body.nonce || '0x0',
            gasLimit: body.gas || body.gasLimit || '0x5208',
            chainId,
          }

          // EIP-1559 fields
          if (body.maxFeePerGas || body.max_fee_per_gas) {
            msg.maxFeePerGas = body.maxFeePerGas || body.max_fee_per_gas
            msg.maxPriorityFeePerGas = body.maxPriorityFeePerGas || body.max_priority_fee_per_gas || '0x0'
            // Strip EIP-1559 on non-mainnet chains
            if (chainId !== 1) {
              msg.gasPrice = msg.maxFeePerGas
              delete msg.maxFeePerGas
              delete msg.maxPriorityFeePerGas
            }
          } else {
            msg.gasPrice = body.gasPrice || body.gas_price || '0x0'
          }

          const result = await wallet.ethSignTx(msg)
          return json(result)
        }

        if (path === '/eth/sign-typed-data' && method === 'POST') {
          auth.requireAuth(req)
          const wallet = requireWallet(engine)
          const body = await req.json() as any
          if (!body.address) throw { status: 400, message: 'Missing address' }
          if (!body.typedData) throw { status: 400, message: 'Missing typedData' }
          const { addressNList } = auth.getAccount(body.address)
          const result = await wallet.ethSignTypedData({ addressNList, typedData: body.typedData })
          return json(result)
        }

        if (path === '/eth/sign' && method === 'POST') {
          auth.requireAuth(req)
          const wallet = requireWallet(engine)
          const body = await req.json() as any
          if (!body.address) throw { status: 400, message: 'Missing address' }
          if (!body.message) throw { status: 400, message: 'Missing message' }
          if (typeof body.message !== 'string' || !/^0x[0-9a-fA-F]*$/.test(body.message)) {
            throw { status: 400, message: 'Message must be a 0x-prefixed hex string' }
          }
          const { addressNList } = auth.getAccount(body.address)
          const msgBytes = Buffer.from(body.message.slice(2), 'hex')
          const result = await wallet.ethSignMessage({ addressNList, message: msgBytes })
          return json(result)
        }

        if (path === '/eth/verify' && method === 'POST') {
          auth.requireAuth(req)
          const wallet = requireWallet(engine)
          const body = await req.json() as any
          if (!body.address || !body.message || !body.signature) {
            throw { status: 400, message: 'Missing address, message, or signature' }
          }
          const msgBytes = Buffer.from(body.message.replace(/^0x/, ''), 'hex')
          const result = await wallet.ethVerifyMessage({
            address: body.address,
            message: msgBytes,
            signature: body.signature,
          })
          return json(result)
        }

        // ── UTXO SIGNING (1 endpoint) ────────────────────────────────
        if (path === '/utxo/sign-transaction' && method === 'POST') {
          auth.requireAuth(req)
          const wallet = requireWallet(engine)
          const body = await req.json() as any
          const coin = body.coin || 'Bitcoin'

          // BCH: prepend bitcoincash: prefix to output addresses
          if (coin === 'BitcoinCash' && body.outputs) {
            for (const out of body.outputs) {
              if (out.address && !out.address.startsWith('bitcoincash:')) {
                out.address = 'bitcoincash:' + out.address
              }
            }
          }

          const result = await wallet.btcSignTx({
            coin,
            inputs: body.inputs,
            outputs: body.outputs,
            version: body.version ?? 1,
            locktime: body.locktime ?? 0,
          })
          return json(result)
        }

        // ── BNB SIGNING (1 endpoint) ─────────────────────────────────
        if (path === '/bnb/sign-transaction' && method === 'POST') {
          auth.requireAuth(req)
          const wallet = requireWallet(engine)
          const body = await req.json() as any
          if (!body.signerAddress) throw { status: 400, message: 'Missing signerAddress' }
          if (!body.signDoc) throw { status: 400, message: 'Missing signDoc' }
          const { addressNList } = auth.getAccount(body.signerAddress)
          const result = await wallet.binanceSignTx({ addressNList, tx: body.signDoc })
          return json(result)
        }

        // ── COSMOS SIGNING (6 endpoints) ──────────────────────────────
        if (path === '/cosmos/sign-amino' && method === 'POST') {
          auth.requireAuth(req)
          const wallet = requireWallet(engine)
          const body = await req.json() as any
          return json(await cosmosAminoSign(wallet, auth, body, 'cosmosSignTx', 'uatom', '5000', '1000000'))
        }
        if (path === '/cosmos/sign-amino-delegate' && method === 'POST') {
          auth.requireAuth(req)
          const wallet = requireWallet(engine)
          const body = await req.json() as any
          return json(await cosmosAminoSign(wallet, auth, body, 'cosmosSignTx', 'uatom', '5000', '1000000'))
        }
        if (path === '/cosmos/sign-amino-undelegate' && method === 'POST') {
          auth.requireAuth(req)
          const wallet = requireWallet(engine)
          const body = await req.json() as any
          return json(await cosmosAminoSign(wallet, auth, body, 'cosmosSignTx', 'uatom', '5000', '1000000'))
        }
        if (path === '/cosmos/sign-amino-redelegate' && method === 'POST') {
          auth.requireAuth(req)
          const wallet = requireWallet(engine)
          const body = await req.json() as any
          return json(await cosmosAminoSign(wallet, auth, body, 'cosmosSignTx', 'uatom', '5000', '1000000'))
        }
        if (path === '/cosmos/sign-amino-withdraw-delegator-rewards-all' && method === 'POST') {
          auth.requireAuth(req)
          const wallet = requireWallet(engine)
          const body = await req.json() as any
          return json(await cosmosAminoSign(wallet, auth, body, 'cosmosSignTx', 'uatom', '5000', '1000000'))
        }
        if (path === '/cosmos/sign-amino-ibc-transfer' && method === 'POST') {
          auth.requireAuth(req)
          const wallet = requireWallet(engine)
          const body = await req.json() as any
          return json(await cosmosAminoSign(wallet, auth, body, 'cosmosSignTx', 'uatom', '5000', '1000000'))
        }

        // ── OSMOSIS SIGNING (9 endpoints) ────────────────────────────
        if (path === '/osmosis/sign-amino' && method === 'POST') {
          auth.requireAuth(req)
          const wallet = requireWallet(engine)
          const body = await req.json() as any
          return json(await cosmosAminoSign(wallet, auth, body, 'osmosisSignTx', 'uosmo', '800', '290000'))
        }
        if (path === '/osmosis/sign-amino-delegate' && method === 'POST') {
          auth.requireAuth(req)
          const wallet = requireWallet(engine)
          const body = await req.json() as any
          return json(await cosmosAminoSign(wallet, auth, body, 'osmosisSignTx', 'uosmo', '800', '290000'))
        }
        if (path === '/osmosis/sign-amino-undelegate' && method === 'POST') {
          auth.requireAuth(req)
          const wallet = requireWallet(engine)
          const body = await req.json() as any
          return json(await cosmosAminoSign(wallet, auth, body, 'osmosisSignTx', 'uosmo', '800', '290000'))
        }
        if (path === '/osmosis/sign-amino-redelegate' && method === 'POST') {
          auth.requireAuth(req)
          const wallet = requireWallet(engine)
          const body = await req.json() as any
          return json(await cosmosAminoSign(wallet, auth, body, 'osmosisSignTx', 'uosmo', '800', '290000'))
        }
        if (path === '/osmosis/sign-amino-withdraw-delegator-rewards-all' && method === 'POST') {
          auth.requireAuth(req)
          const wallet = requireWallet(engine)
          const body = await req.json() as any
          return json(await cosmosAminoSign(wallet, auth, body, 'osmosisSignTx', 'uosmo', '800', '290000'))
        }
        if (path === '/osmosis/sign-amino-ibc-transfer' && method === 'POST') {
          auth.requireAuth(req)
          const wallet = requireWallet(engine)
          const body = await req.json() as any
          return json(await cosmosAminoSign(wallet, auth, body, 'osmosisSignTx', 'uosmo', '800', '290000'))
        }
        if (path === '/osmosis/sign-amino-lp-remove' && method === 'POST') {
          auth.requireAuth(req)
          const wallet = requireWallet(engine)
          const body = await req.json() as any
          return json(await cosmosAminoSign(wallet, auth, body, 'osmosisSignTx', 'uosmo', '800', '290000'))
        }
        if (path === '/osmosis/sign-amino-lp-add' && method === 'POST') {
          auth.requireAuth(req)
          const wallet = requireWallet(engine)
          const body = await req.json() as any
          return json(await cosmosAminoSign(wallet, auth, body, 'osmosisSignTx', 'uosmo', '800', '290000'))
        }
        if (path === '/osmosis/sign-amino-swap' && method === 'POST') {
          auth.requireAuth(req)
          const wallet = requireWallet(engine)
          const body = await req.json() as any
          return json(await cosmosAminoSign(wallet, auth, body, 'osmosisSignTx', 'uosmo', '800', '290000'))
        }

        // ── THORCHAIN SIGNING (2 endpoints) ──────────────────────────
        if (path === '/thorchain/sign-amino-transfer' && method === 'POST') {
          auth.requireAuth(req)
          const wallet = requireWallet(engine)
          const body = await req.json() as any
          return json(await cosmosAminoSign(wallet, auth, body, 'thorchainSignTx', 'rune', '0', '500000000'))
        }
        if (path === '/thorchain/sign-amino-desposit' && method === 'POST') {
          auth.requireAuth(req)
          const wallet = requireWallet(engine)
          const body = await req.json() as any
          return json(await cosmosAminoSign(wallet, auth, body, 'thorchainSignTx', 'rune', '0', '500000000'))
        }

        // ── MAYACHAIN SIGNING (2 endpoints) ──────────────────────────
        if (path === '/mayachain/sign-amino-transfer' && method === 'POST') {
          auth.requireAuth(req)
          const wallet = requireWallet(engine)
          const body = await req.json() as any
          return json(await cosmosAminoSign(wallet, auth, body, 'mayachainSignTx', 'cacao', '0', '500000000'))
        }
        if (path === '/mayachain/sign-amino-desposit' && method === 'POST') {
          auth.requireAuth(req)
          const wallet = requireWallet(engine)
          const body = await req.json() as any
          return json(await cosmosAminoSign(wallet, auth, body, 'mayachainSignTx', 'cacao', '0', '500000000'))
        }

        // ── XRP SIGNING (1 endpoint) ─────────────────────────────────
        if (path === '/xrp/sign-transaction' && method === 'POST') {
          auth.requireAuth(req)
          const wallet = requireWallet(engine)
          const body = await req.json() as any
          const result = await wallet.rippleSignTx(body)
          return json(result)
        }

        // ── SYSTEM INFO (5 endpoints) ────────────────────────────────
        if (path === '/system/info/get-features' && method === 'POST') {
          auth.requireAuth(req)
          const wallet = requireWallet(engine)
          const features = await getCachedFeatures(wallet)
          return json(features)
        }

        if (path === '/system/info/get-public-key' && method === 'POST') {
          auth.requireAuth(req)
          const wallet = requireWallet(engine)
          const body = await req.json() as any
          if (!body.address_n) throw { status: 400, message: 'Missing address_n' }
          const cacheKey = JSON.stringify(body)
          const cached = pubkeyCache.get(cacheKey)
          if (cached) return json(cached)
          const result = await wallet.getPublicKeys([{
            addressNList: body.address_n,
            curve: body.ecdsa_curve_name || 'secp256k1',
            showDisplay: body.show_display ?? false,
            coin: body.coin_name || 'Bitcoin',
            scriptType: body.script_type,
          }])
          const xpub = result?.[0]?.xpub
          const out = { xpub }
          pubkeyCache.set(cacheKey, out)
          return json(out)
        }

        if (path === '/system/info/list-coins' && method === 'POST') {
          auth.requireAuth(req)
          const wallet = requireWallet(engine)
          try {
            const table = await (wallet as any).getCoinTable()
            return json(table)
          } catch {
            return json([])
          }
        }

        if (path === '/system/info/ping' && method === 'POST') {
          auth.requireAuth(req)
          const wallet = requireWallet(engine)
          const body = await req.json() as any
          const result = await wallet.ping({
            msg: body.message || 'pong',
            button: body.button_protection ?? false,
            pin: body.pin_protection ?? false,
            passphrase: body.passphrase_protection ?? false,
          })
          return json({ message: typeof result === 'string' ? result : result?.msg || 'pong' })
        }

        if (path === '/system/info/get-entropy' && method === 'POST') {
          auth.requireAuth(req)
          const wallet = requireWallet(engine)
          const body = await req.json() as any
          const size = body.size || 32
          const entropy = await (wallet as any).getEntropy(size)
          if (entropy instanceof Uint8Array || Buffer.isBuffer(entropy)) {
            return binary(entropy)
          }
          return json(entropy)
        }

        // ── SYSTEM INITIALIZE (3 endpoints) ──────────────────────────
        if (path === '/system/initialize/load-device' && method === 'POST') {
          auth.requireAuth(req)
          const wallet = requireWallet(engine)
          const body = await req.json() as any
          if (!body.mnemonic) throw { status: 400, message: 'Missing mnemonic' }
          await wallet.loadDevice({
            mnemonic: body.mnemonic,
            pin: body.pin ? String(body.pin) : undefined,
            passphrase: body.passphrase_protection ?? false,
            label: body.label || 'KeepKey',
            skipChecksum: body.skip_checksum ?? false,
          })
          return json({ success: true })
        }

        if (path === '/system/initialize/recover-device' && method === 'POST') {
          auth.requireAuth(req)
          const wallet = requireWallet(engine)
          const body = await req.json() as any
          const wordCountToEntropy: Record<number, 128 | 192 | 256> = { 12: 128, 18: 192, 24: 256 }
          const entropy = wordCountToEntropy[body.word_count] || 128
          await wallet.recover({
            entropy,
            label: body.label || 'KeepKey',
            passphrase: body.passphrase_protection ?? false,
            pin: body.pin_protection ?? false,
            autoLockDelayMs: body.auto_lock_delay_ms ?? 600000,
          })
          return json({ success: true })
        }

        if (path === '/system/initialize/reset-device' && method === 'POST') {
          auth.requireAuth(req)
          const wallet = requireWallet(engine)
          const body = await req.json() as any
          await wallet.reset({
            entropy: body.strength || 128,
            label: body.label || 'KeepKey',
            passphrase: body.passphrase_protection ?? false,
            pin: body.pin_protection ?? false,
            autoLockDelayMs: body.auto_lock_delay_ms ?? 600000,
          })
          return json({ success: true })
        }

        // ── SYSTEM MANAGEMENT (9 endpoints) ──────────────────────────
        if (path === '/system/apply-policies' && method === 'POST') {
          auth.requireAuth(req)
          const wallet = requireWallet(engine)
          const body = await req.json() as any
          const policies = Array.isArray(body) ? body : body.policies || []
          for (const p of policies) {
            await wallet.applyPolicy({ policyName: p.policyName || p.policy_name, enabled: p.enabled })
          }
          return json({ success: true })
        }

        if (path === '/system/apply-settings' && method === 'POST') {
          auth.requireAuth(req)
          const wallet = requireWallet(engine)
          const body = await req.json() as any
          await wallet.applySettings({
            autoLockDelayMs: body.auto_lock_delay_ms,
            label: body.label,
            language: body.language,
            usePassphrase: body.use_passphrase,
            u2fCounter: body.u2f_counter,
          })
          return json({ success: true })
        }

        if (path === '/system/change-pin' && method === 'POST') {
          auth.requireAuth(req)
          const wallet = requireWallet(engine)
          const body = await req.json() as any
          if (body.remove) {
            await wallet.removePin()
          } else {
            await wallet.changePin()
          }
          return json({ success: true })
        }

        if (path === '/system/change-wipe-code' && method === 'POST') {
          throw { status: 501, message: 'change-wipe-code is deprecated' }
        }

        if (path === '/system/cipher-key-value' && method === 'POST') {
          auth.requireAuth(req)
          const wallet = requireWallet(engine)
          const body = await req.json() as any
          const result = await (wallet as any).cipherKeyValue({
            addressNList: body.address_n_list || body.address_n,
            key: body.key,
            value: body.value,
            encrypt: !body.decrypt,
            askOnEncrypt: body.ask_on_encrypt ?? true,
            askOnDecrypt: body.ask_on_decrypt ?? true,
            iv: body.iv ? Buffer.from(body.iv, 'hex') : undefined,
          })
          if (result instanceof Uint8Array || Buffer.isBuffer(result)) {
            return binary(result)
          }
          return json(result)
        }

        if (path === '/system/clear-session' && method === 'POST') {
          auth.requireAuth(req)
          const wallet = requireWallet(engine)
          await wallet.clearSession()
          return json({ success: true })
        }

        if (path === '/system/firmware-update' && method === 'POST') {
          auth.requireAuth(req)
          const wallet = requireWallet(engine)
          const body = Buffer.from(await req.arrayBuffer())
          await wallet.firmwareErase()
          await wallet.firmwareUpload(body)
          return json({ success: true })
        }

        if (path === '/system/sign-identity' && method === 'POST') {
          throw { status: 501, message: 'sign-identity is not supported' }
        }

        if (path === '/system/wipe-device' && method === 'POST') {
          auth.requireAuth(req)
          const wallet = requireWallet(engine)
          await wallet.wipe()
          await engine.syncState()
          return json({ success: true })
        }

        // ── RAW (1 endpoint) ─────────────────────────────────────────
        if (path === '/raw' && method === 'POST') {
          auth.requireAuth(req)
          const wallet = requireWallet(engine)
          const body = new Uint8Array(await req.arrayBuffer())
          const transport = (wallet as any).transport
          if (!transport) throw { status: 503, message: 'No transport available' }
          await transport.write(body)
          const out = await transport.read()
          return binary(out instanceof Uint8Array ? out : Buffer.from(out))
        }

        // ── Catch-all ────────────────────────────────────────────────
        return json({ error: 'Not found', path }, 404)

      } catch (err: any) {
        if (err.status) {
          return json({ error: err.message }, err.status)
        }
        console.error('[REST] Error:', err)
        return json({ error: err.message || 'Internal error' }, 500)
      }
    },
  })

  console.log(`[REST] API server listening on http://localhost:${port}`)
  return server
}
