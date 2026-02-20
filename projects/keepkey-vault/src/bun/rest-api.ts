import type { EngineController } from './engine-controller'
import type { Server } from 'bun'

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  })
}

function requireWallet(engine: EngineController) {
  if (!engine.wallet) throw { status: 503, message: 'No device connected' }
  return engine.wallet
}

export function startRestApi(engine: EngineController, port = 1646): Server {
  const server = Bun.serve({
    reusePort: true,
    port,
    async fetch(req) {
      const url = new URL(req.url)
      const path = url.pathname

      // CORS preflight
      if (req.method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: CORS_HEADERS })
      }

      try {
        // ── System ─────────────────────────────────────────────────────

        if (path === '/api/health') {
          return json({
            status: 'ok',
            timestamp: Date.now(),
            device: engine.getDeviceState().state,
          })
        }

        if (path === '/api/device') {
          return json(engine.getDeviceState())
        }

        if (path === '/api/device/features' && req.method === 'GET') {
          const wallet = requireWallet(engine)
          return json(await wallet.getFeatures())
        }

        if (path === '/api/device/ping' && req.method === 'GET') {
          const wallet = requireWallet(engine)
          const result = await wallet.ping({ msg: 'pong', passphrase: false })
          return json({ result })
        }

        // ── Public Keys ────────────────────────────────────────────────

        if (path === '/api/xpub' && req.method === 'POST') {
          const wallet = requireWallet(engine)
          const body = await req.json() as any
          const result = await wallet.getPublicKeys([{
            addressNList: body.addressNList,
            curve: body.curve || 'secp256k1',
            showDisplay: body.showDisplay ?? false,
            coin: body.coin || 'Bitcoin',
          }])
          return json(result)
        }

        // ── Bitcoin ────────────────────────────────────────────────────

        if (path === '/api/btc/address' && req.method === 'POST') {
          const wallet = requireWallet(engine)
          const body = await req.json() as any
          const address = await wallet.btcGetAddress({
            addressNList: body.addressNList || [0x80000000 + 44, 0x80000000, 0x80000000, 0, 0],
            coin: body.coin || 'Bitcoin',
            scriptType: body.scriptType || 'p2wpkh',
            showDisplay: body.showDisplay ?? false,
          })
          return json({ address })
        }

        if (path === '/api/btc/sign' && req.method === 'POST') {
          const wallet = requireWallet(engine)
          const body = await req.json() as any
          const signed = await wallet.btcSignTx(body)
          return json(signed)
        }

        // ── Ethereum ───────────────────────────────────────────────────

        if (path === '/api/eth/address' && req.method === 'POST') {
          const wallet = requireWallet(engine)
          const body = await req.json() as any
          const address = await wallet.ethGetAddress({
            addressNList: body.addressNList || [0x80000000 + 44, 0x80000000 + 60, 0x80000000, 0, 0],
            showDisplay: body.showDisplay ?? false,
          })
          return json({ address })
        }

        if (path === '/api/eth/sign' && req.method === 'POST') {
          const wallet = requireWallet(engine)
          const body = await req.json() as any
          const signed = await wallet.ethSignTx(body)
          return json(signed)
        }

        // ── Cosmos-SDK Chains ──────────────────────────────────────────

        if (path === '/api/cosmos/address' && req.method === 'POST') {
          const wallet = requireWallet(engine)
          const body = await req.json() as any
          const address = await wallet.cosmosGetAddress({
            addressNList: body.addressNList || [0x80000000 + 44, 0x80000000 + 118, 0x80000000, 0, 0],
            showDisplay: body.showDisplay ?? false,
          })
          return json({ address })
        }

        if (path === '/api/thorchain/address' && req.method === 'POST') {
          const wallet = requireWallet(engine)
          const body = await req.json() as any
          const address = await wallet.thorchainGetAddress({
            addressNList: body.addressNList || [0x80000000 + 44, 0x80000000 + 931, 0x80000000, 0, 0],
            showDisplay: body.showDisplay ?? false,
          })
          return json({ address })
        }

        if (path === '/api/mayachain/address' && req.method === 'POST') {
          const wallet = requireWallet(engine)
          const body = await req.json() as any
          const address = await wallet.mayachainGetAddress({
            addressNList: body.addressNList || [0x80000000 + 44, 0x80000000 + 931, 0x80000000, 0, 0],
            showDisplay: body.showDisplay ?? false,
          })
          return json({ address })
        }

        // ── Device Management ──────────────────────────────────────────

        if (path === '/api/device/wipe' && req.method === 'POST') {
          const wallet = requireWallet(engine)
          await wallet.wipe()
          await engine.syncState()
          return json({ success: true })
        }

        // ── Catch-all ──────────────────────────────────────────────────

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
