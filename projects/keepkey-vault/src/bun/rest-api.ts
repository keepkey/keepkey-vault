import type { EngineController } from './engine-controller'
import type { Server } from 'bun'
import { CHAINS } from '../shared/chains'

function getChain(id: string) {
  const chain = CHAINS.find(c => c.id === id)
  if (!chain) throw { status: 400, message: `Unknown chain: ${id}` }
  return chain
}

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

        // ── Chain address derivation (uses CHAINS for default paths) ────

        if (path.match(/^\/api\/(\w+)\/address$/) && req.method === 'POST') {
          const slug = path.match(/^\/api\/(\w+)\/address$/)![1]
          // Map URL slugs to chain IDs
          const slugToChainId: Record<string, string> = {
            btc: 'bitcoin', eth: 'ethereum', cosmos: 'cosmos',
            thorchain: 'thorchain', mayachain: 'mayachain',
          }
          const chainId = slugToChainId[slug]
          if (chainId) {
            const wallet = requireWallet(engine)
            const chain = getChain(chainId)
            const body = await req.json() as any
            const params: any = {
              addressNList: body.addressNList || chain.defaultPath,
              showDisplay: body.showDisplay ?? false,
            }
            if (chain.coin) params.coin = body.coin || chain.coin
            if (chain.scriptType) params.scriptType = body.scriptType || chain.scriptType
            const method = chainId === 'ripple' ? 'rippleGetAddress' : chain.rpcMethod
            const result = await (wallet as any)[method](params)
            const address = typeof result === 'string' ? result : result?.address || result
            return json({ address })
          }
        }

        // ── Transaction signing ──────────────────────────────────────────

        if (path === '/api/btc/sign' && req.method === 'POST') {
          const wallet = requireWallet(engine)
          const body = await req.json() as any
          return json(await wallet.btcSignTx(body))
        }

        if (path === '/api/eth/sign' && req.method === 'POST') {
          const wallet = requireWallet(engine)
          const body = await req.json() as any
          return json(await wallet.ethSignTx(body))
        }

        // ── PIN Management ────────────────────────────────────────────

        if (path === '/api/device/pin/prompt' && req.method === 'POST') {
          const result = await engine.promptPin()
          return json(result)
        }

        if (path === '/api/device/pin/submit' && req.method === 'POST') {
          const body = await req.json() as any
          if (!body.pin) return json({ error: 'Missing pin field' }, 400)
          await engine.sendPin(body.pin)
          return json({ success: true, message: 'PIN accepted' })
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
