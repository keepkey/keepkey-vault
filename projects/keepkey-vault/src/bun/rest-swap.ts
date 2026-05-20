/**
 * REST swap routes — `/api/v2/swap/*`.
 *
 * Strict scope: drive the in-app SwapDialog as if a user were clicking it.
 * Nothing else lives here. No headless quoting, no asset list, no history,
 * no debug passthroughs. Quoting + signing + broadcast all flow through the
 * dialog and the device, where the user can review and approve.
 *
 *   - GET  /state    → snapshot of the dialog's visible state
 *   - POST /open     → pop the dialog with optional seed fields
 *   - POST /set      → change a field while the dialog is open
 *   - POST /requote  → force a re-quote with current inputs
 *   - POST /close    → dismiss the dialog
 *
 * All endpoints require bearer-token auth.
 */
import type { AuthStore } from './auth'
import type { RestApiCallbacks } from './rest-api'
import { parseRequest } from './validate'
import * as S from './schemas'
import type { SwapUiCommand } from '../shared/types'

const TAG = '[rest-swap]'

type JsonFn = (data: unknown, status?: number) => Response

/**
 * Handle /api/v2/swap/ routes. Returns a Response if matched, null otherwise.
 */
export async function handleSwapRoute(
  path: string,
  method: string,
  req: Request,
  auth: AuthStore,
  json: JsonFn,
  callbacks: RestApiCallbacks | undefined,
): Promise<Response | null> {
  if (!path.startsWith('/api/v2/swap/') && path !== '/api/v2/swap') return null

  try {
    if (path === '/api/v2/swap/state' && method === 'GET') {
      auth.requireAuth(req)
      if (!callbacks?.getSwapUiState) return json({ error: 'Swap UI mirror not wired' }, 503)
      const snap = callbacks.getSwapUiState()
      return json({ data: snap.state, updatedAt: snap.updatedAt })
    }

    if (path === '/api/v2/swap/assets' && method === 'GET') {
      auth.requireAuth(req)
      const { getSwapAssets } = await import('./swap')
      const assets = await getSwapAssets()
      return json({ data: assets })
    }

    if (path === '/api/v2/swap/open' && method === 'POST') {
      auth.requireAuth(req)
      const body = await parseRequest(req, S.SwapUiOpenRequest)
      if (!callbacks?.sendSwapCmd) return json({ error: 'Swap UI bridge not wired' }, 503)
      const validation = await validateSeedAssets(body)
      if (validation) return json(validation, 400)
      callbacks.sendSwapCmd({ kind: 'open', ...body } as SwapUiCommand)
      return json({ data: { ok: true } })
    }

    if (path === '/api/v2/swap/set' && method === 'POST') {
      auth.requireAuth(req)
      const body = await parseRequest(req, S.SwapUiSetRequest)
      if (!callbacks?.sendSwapCmd) return json({ error: 'Swap UI bridge not wired' }, 503)
      const validation = await validateSeedAssets(body)
      if (validation) return json(validation, 400)
      callbacks.sendSwapCmd({ kind: 'set', ...body } as SwapUiCommand)
      return json({ data: { ok: true } })
    }

    if (path === '/api/v2/swap/requote' && method === 'POST') {
      auth.requireAuth(req)
      if (!callbacks?.sendSwapCmd) return json({ error: 'Swap UI bridge not wired' }, 503)
      callbacks.sendSwapCmd({ kind: 'requote' })
      return json({ data: { ok: true } })
    }

    if (path === '/api/v2/swap/advance' && method === 'POST') {
      auth.requireAuth(req)
      if (!callbacks?.sendSwapCmd) return json({ error: 'Swap UI bridge not wired' }, 503)
      // UI-navigation only: input → review. No signing triggered by this call.
      callbacks.sendSwapCmd({ kind: 'advance' } as SwapUiCommand)
      return json({ data: { ok: true } })
    }

    if (path === '/api/v2/swap/confirm' && method === 'POST') {
      auth.requireAuth(req)
      if (!callbacks?.sendSwapCmd) return json({ error: 'Swap UI bridge not wired' }, 503)
      // Equivalent to clicking "Confirm Swap" / "Approve & Swap" — kicks off
      // executeSwap. The physical device button press still applies.
      callbacks.sendSwapCmd({ kind: 'confirm' } as SwapUiCommand)
      return json({ data: { ok: true } })
    }

    if (path === '/api/v2/swap/close' && method === 'POST') {
      auth.requireAuth(req)
      if (!callbacks?.sendSwapCmd) return json({ error: 'Swap UI bridge not wired' }, 503)
      callbacks.sendSwapCmd({ kind: 'close' })
      // Belt-and-braces: dispatch the cmd to any mounted dialog AND reset the
      // Bun-side cached snapshot. Without this reset, a prior 'submitted'
      // state can survive close (no dialog mounted → no unmount publish), and
      // subsequent /state reads keep returning the stale failed swap.
      const { resetSwapUiState } = await import('./index')
      resetSwapUiState()
      return json({ data: { ok: true } })
    }

    return null

  } catch (err: any) {
    if (err?.status) throw err
    console.error(`${TAG} Error on ${path}:`, err.message)
    return json({ error: 'Swap API error', details: err.message }, 502)
  }
}

// Reject seeds with unknown asset keys at the REST boundary instead of letting
// SwapDialog silently no-op the lookup. Accepts either the `.asset` form
// ("ETH.ETH") or the `.caip` form ("eip155:1/slip44:60") for forward-compat.
async function validateSeedAssets(body: { fromAsset?: string; toAsset?: string }): Promise<{ error: string; details: { unknownAsset: string; field: 'fromAsset' | 'toAsset' } } | null> {
  if (!body.fromAsset && !body.toAsset) return null
  const { getSwapAssets } = await import('./swap')
  let assets: Awaited<ReturnType<typeof getSwapAssets>>
  try { assets = await getSwapAssets() } catch { return null /* don't block on transient asset-list failures */ }
  const has = (key: string) => assets.some(a => a.asset === key || a.caip === key)
  if (body.fromAsset && !has(body.fromAsset)) return { error: 'Unknown fromAsset', details: { unknownAsset: body.fromAsset, field: 'fromAsset' } }
  if (body.toAsset && !has(body.toAsset)) return { error: 'Unknown toAsset', details: { unknownAsset: body.toAsset, field: 'toAsset' } }
  return null
}
