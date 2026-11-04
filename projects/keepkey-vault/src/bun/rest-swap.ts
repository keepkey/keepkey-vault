/**
 * REST swap routes — `/api/v2/swap/*`.
 *
 * Two families share this prefix:
 *
 * 1. Remote-control of the in-app SwapDialog (drive vault's own window):
 *   - GET  /state    → snapshot of the dialog's visible state
 *   - POST /open     → pop the dialog with optional seed fields
 *   - POST /set      → change a field while the dialog is open
 *   - POST /requote  → force a re-quote with current inputs
 *   - POST /advance / /confirm / /close
 *
 * 2. Headless (BEX swap epic) — the caller composes its OWN swap UI and uses
 *    vault only for the engine + the device signature:
 *   - GET  /assets   → firmware-filtered SwapAsset[] for the picker
 *   - POST /quote    → SwapQuote (no GUI; wraps getSwapQuote + reserve re-quote)
 *   - POST /execute  → SwapResult{txid} (signs on the device, then trackSwap)
 *
 * Headless = "no vault GUI in the loop," NOT "no device confirmation": /execute
 * still signs on the physical KeepKey (firmware shows details; user presses the
 * button). All endpoints require bearer-token auth.
 */
import type { AuthStore } from './auth'
import type { RestApiCallbacks } from './rest-api'
import { parseRequest } from './validate'
import * as S from './schemas'
import type { SwapAsset, SwapUiCommand } from '../shared/types'
import { blocksSwapUiCommand } from '../shared/swap-ui-control'

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
    const command = path.slice('/api/v2/swap/'.length)
    if (method === 'POST' && blocksSwapUiCommand(callbacks?.getSwapUiState?.().state.phase, command)) {
      auth.requireAuth(req)
      return json({ error: 'Swap inputs are locked while signing or showing a submitted transaction. Close the receipt before opening another swap.' }, 409)
    }
    if (path === '/api/v2/swap/state' && method === 'GET') {
      auth.requireAuth(req)
      if (!callbacks?.getSwapUiState) return json({ error: 'Swap UI mirror not wired' }, 503)
      const snap = callbacks.getSwapUiState()
      return json({ data: snap.state, updatedAt: snap.updatedAt })
    }

    if (path === '/api/v2/swap/assets' && method === 'GET') {
      auth.requireAuth(req)
      // Firmware-filtered so REST clients never see assets the connected
      // device can't sign (e.g. ZEC below 7.15.0) — mirrors the RPC + picker.
      const assets = await resolveDeviceSwapAssets(callbacks)
      return json({ data: assets })
    }

    if (path === '/api/v2/swap/quote' && method === 'POST') {
      auth.requireAuth(req)
      if (!callbacks?.getSwapQuoteHeadless) return json({ error: 'Headless swap not wired' }, 503)
      const body = await parseRequest(req, S.SwapQuoteHeadlessRequest)
      // Reject unknown assets at the boundary (CAIP form), same as the dialog seed path.
      const resolved = await resolveSeedAssets({ fromAsset: body.fromCaip, toAsset: body.toCaip }, callbacks)
      if ('error' in resolved) return json(resolved, 400)
      const quote = await callbacks.getSwapQuoteHeadless({ ...body,
        fromCaip: resolved.fromAssetDefinition!.caip!, toCaip: resolved.toAssetDefinition!.caip! } as any)
      return json({ data: quote })
    }

    if (path === '/api/v2/swap/execute' && method === 'POST') {
      auth.requireAuth(req)
      if (!callbacks?.executeSwapHeadless) return json({ error: 'Headless swap not wired' }, 503)
      const body = await parseRequest(req, S.SwapExecuteHeadlessRequest)
      // Device-interactive: signs on the physical KeepKey, then broadcasts. The
      // caller should use a long (≈5 min) client timeout; no shorter server cap.
      const result = await callbacks.executeSwapHeadless(body as any)
      return json({ data: result })
    }

    if (path === '/api/v2/swap/open' && method === 'POST') {
      auth.requireAuth(req)
      const body = await parseRequest(req, S.SwapUiOpenRequest)
      if (!callbacks?.sendSwapCmd) return json({ error: 'Swap UI bridge not wired' }, 503)
      const resolved = await resolveSeedAssets(body, callbacks)
      if ('error' in resolved) return json(resolved, 400)
      callbacks.sendSwapCmd({ ...body, kind: 'open', fromAssetDefinition: undefined, toAssetDefinition: undefined, ...resolved } as SwapUiCommand)
      return json({ data: { ok: true } })
    }

    if (path === '/api/v2/swap/set' && method === 'POST') {
      auth.requireAuth(req)
      const body = await parseRequest(req, S.SwapUiSetRequest)
      if (!callbacks?.sendSwapCmd) return json({ error: 'Swap UI bridge not wired' }, 503)
      const resolved = await resolveSeedAssets(body, callbacks)
      if ('error' in resolved) return json(resolved, 400)
      callbacks.sendSwapCmd({ ...body, kind: 'set', fromAssetDefinition: undefined, toAssetDefinition: undefined, ...resolved } as SwapUiCommand)
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

// Firmware-filtered swap assets for the connected device. Prefers the wired
// callback (mirrors the RPC + picker gate); falls back to the raw list only
// when no callback is wired (e.g. tests), since the device context lives in
// index.ts and isn't otherwise reachable from this route module.
async function resolveDeviceSwapAssets(callbacks: RestApiCallbacks | undefined) {
  if (callbacks?.getDeviceSwapAssets) return callbacks.getDeviceSwapAssets()
  const { getSwapAssets } = await import('./swap')
  return getSwapAssets()
}

// Reject seeds with unknown asset keys at the REST boundary instead of letting
// SwapDialog silently no-op the lookup. Accepts either the `.asset` form
// ("ETH.ETH") or the `.caip` form ("eip155:1/slip44:60") for forward-compat.
// Uses the firmware-filtered list so a seed naming a chain the device can't
// sign (e.g. ZEC on old firmware) is rejected here rather than accepted and
// then unresolvable in the UI asset list.
async function resolveSeedAssets(body: { fromAsset?: string; toAsset?: string }, callbacks: RestApiCallbacks | undefined): Promise<{
  fromAssetDefinition?: SwapAsset; toAssetDefinition?: SwapAsset
} | { error: string; details: { unknownAsset: string; field: string } }> {
  const resolved: { fromAssetDefinition?: SwapAsset; toAssetDefinition?: SwapAsset } = {}
  for (const field of ['fromAsset', 'toAsset'] as const) {
    const key = body[field]
    if (!key) continue
    const asset = callbacks?.resolveSwapAsset ? await callbacks.resolveSwapAsset(key)
      : (await resolveDeviceSwapAssets(callbacks)).find(a => a.asset === key || a.caip === key)
    if (!asset?.caip) return { error: `Unknown or unsupported ${field}`, details: { unknownAsset: key, field } }
    resolved[field === 'fromAsset' ? 'fromAssetDefinition' : 'toAssetDefinition'] = asset
  }
  return resolved
}
