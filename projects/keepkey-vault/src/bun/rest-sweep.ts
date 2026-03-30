/**
 * Sweep REST routes — scan non-standard BTC paths and recover funds.
 *
 * POST /api/v2/sweep/scan          — start async scan, returns { scanId }
 * GET  /api/v2/sweep/scan/:scanId  — poll scan progress + results
 * POST /api/v2/sweep/execute       — build sweep tx, sign on device, broadcast
 */
import type { EngineController } from './engine-controller'
import type { AuthStore } from './auth'
import { HttpError } from './auth'
import type { RestApiCallbacks } from './rest-api'
import { parseRequest } from './validate'
import * as S from './schemas'
import { startScan, getScan, buildSweepTx } from './sweep-engine'
import { getPioneer } from './pioneer'

const TAG = '[sweep-api]'

const BTC_NETWORK_ID = 'bip122:000000000019d6689c085ae165831e93'

type JsonFn = (data: unknown, status?: number) => Response

function requireWallet(engine: EngineController) {
  if (!engine.wallet) throw new HttpError(503, 'No device connected')
  return engine.wallet
}

/**
 * Handle /api/v2/sweep/* routes. Returns a Response if matched, null otherwise.
 */
export async function handleSweepRoute(
  path: string,
  method: string,
  req: Request,
  engine: EngineController,
  auth: AuthStore,
  json: JsonFn,
  callbacks?: RestApiCallbacks,
): Promise<Response | null> {
  try {
    // ── Start scan ─────────────────────────────────────────────────
    if (path === '/api/v2/sweep/scan' && method === 'POST') {
      auth.requireAuth(req)
      const wallet = requireWallet(engine)
      const body = await parseRequest(req, S.SweepScanRequest)

      const scanId = await startScan(wallet, {
        accountRange: body.accountRange,
        mismatchAccounts: body.mismatchAccounts,
      })

      return json({ scanId }, 202)
    }

    // ── Poll scan status ───────────────────────────────────────────
    if (path.startsWith('/api/v2/sweep/scan/') && method === 'GET') {
      auth.requireAuth(req)
      const scanId = path.split('/').pop()
      if (!scanId) throw new HttpError(400, 'Missing scanId')

      const scan = getScan(scanId)
      if (!scan) throw new HttpError(404, 'Scan not found')

      return json({
        id: scan.id,
        status: scan.status,
        progress: scan.progress,
        startedAt: scan.startedAt,
        completedAt: scan.completedAt,
        totalFoundSats: scan.totalFoundSats,
        results: scan.results.map(r => ({
          path: r.pathStr,
          scriptType: r.scriptType,
          address: r.address,
          category: r.category,
          balanceSats: r.balanceSats,
          utxoCount: r.utxos.length,
        })),
        error: scan.error,
      })
    }

    // ── Execute sweep ──────────────────────────────────────────────
    if (path === '/api/v2/sweep/execute' && method === 'POST') {
      auth.requireAuth(req)
      const wallet = requireWallet(engine)
      const body = await parseRequest(req, S.SweepExecuteRequest)

      const scan = getScan(body.scanId)
      if (!scan) throw new HttpError(404, 'Scan not found')
      if (scan.status !== 'complete') throw new HttpError(400, `Scan status is '${scan.status}', must be 'complete'`)
      if (scan.totalFoundSats === 0) throw new HttpError(400, 'No funds found to sweep')

      // Derive standard destination if not provided
      let destination = body.destinationAddress
      if (!destination) {
        const result = await wallet.btcGetAddress({
          addressNList: [0x80000054, 0x80000000, 0x80000000, 0, 0], // m/84'/0'/0'/0/0
          coin: 'Bitcoin',
          scriptType: 'p2wpkh',
          showDisplay: false,
        })
        destination = typeof result === 'string' ? result : result?.address
        if (!destination) throw new Error('Could not derive standard BTC receive address')
        console.log(`${TAG} Auto-derived destination: ${destination}`)
      }

      // Build the sweep transaction
      const sweepResult = await buildSweepTx(scan, destination)

      // Dry run — return unsigned tx without signing
      if (body.dryRun) {
        return json({
          dryRun: true,
          destination,
          inputCount: sweepResult.inputCount,
          totalInputSats: sweepResult.totalInputSats,
          fee: sweepResult.fee,
          outputSats: sweepResult.totalInputSats - sweepResult.fee,
          unsignedTx: sweepResult.unsignedTx,
        })
      }

      // Sign on device
      console.log(`${TAG} Signing sweep tx: ${sweepResult.inputCount} inputs, ${sweepResult.totalInputSats} sats → ${destination}`)
      const signedTx = await wallet.btcSignTx(sweepResult.unsignedTx)
      const serializedTx = signedTx?.serializedTx || signedTx?.serialized
      if (!serializedTx) throw new Error('Device signing failed — no serialized tx returned')

      // Broadcast
      const pioneer = await getPioneer()
      const broadcastResp = await pioneer.Broadcast({ networkId: BTC_NETWORK_ID, serialized: serializedTx })
      const bdata = broadcastResp?.data || broadcastResp
      const txid = bdata?.txid || bdata?.tx_hash || bdata?.hash
      if (!txid) throw new Error(`Broadcast failed: ${JSON.stringify(bdata).slice(0, 200)}`)

      console.log(`${TAG} Sweep broadcast: txid=${txid}`)

      return json({
        txid,
        destination,
        inputCount: sweepResult.inputCount,
        totalSweptSats: sweepResult.totalInputSats,
        fee: sweepResult.fee,
        outputSats: sweepResult.totalInputSats - sweepResult.fee,
      })
    }

    return null

  } catch (err: any) {
    if (err.status) throw err
    console.error(`${TAG} Error on ${path}:`, err.message)
    return json({ error: err.message }, 500)
  }
}
