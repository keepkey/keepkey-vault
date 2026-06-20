/**
 * Single source of truth for which REST routes are device-signing routes.
 *
 * Kept in its own side-effect-free module (no DB/engine imports) so both the
 * REST server (src/bun/rest-api.ts) and the regression test
 * (__tests__/rest-sign-gating.test.ts) can import it without pulling in the
 * server runtime.
 *
 * Any POST whose path is in SIGNING_ROUTES is intercepted by the central
 * approval gate before its handler: empty-probe rejection (via
 * requiredSigningFields) then the Vault approval overlay. A signing route NOT
 * in this set reaches the device with no in-Vault review — so every endpoint
 * that can make the device sign MUST be listed here.
 */
export const SIGNING_ROUTES = new Set([
  '/eth/sign-transaction', '/eth/sign-typed-data', '/eth/sign',
  '/utxo/sign-transaction', '/xrp/sign-transaction', '/solana/sign-transaction', '/solana/sign-message', '/tron/sign-transaction', '/ton/sign-transaction',
  // Message / off-chain signing. The firmware always confirms these on its
  // OLED, but that is the device surface only — without these in the set a
  // REST caller reaches the device with no in-Vault review. Gate them so the
  // approval overlay shows the message before the device is touched.
  '/tron/sign-message', '/tron/sign-typed-hash', '/ton/sign-message', '/solana/sign-offchain-message',
  '/cosmos/sign-amino', '/cosmos/sign-amino-delegate', '/cosmos/sign-amino-undelegate',
  '/cosmos/sign-amino-redelegate', '/cosmos/sign-amino-withdraw-delegator-rewards-all',
  '/cosmos/sign-amino-ibc-transfer',
  '/osmosis/sign-amino', '/osmosis/sign-amino-delegate', '/osmosis/sign-amino-undelegate',
  '/osmosis/sign-amino-redelegate', '/osmosis/sign-amino-withdraw-delegator-rewards-all',
  '/osmosis/sign-amino-ibc-transfer', '/osmosis/sign-amino-lp-remove',
  '/osmosis/sign-amino-lp-add', '/osmosis/sign-amino-swap',
  '/thorchain/sign-amino-transfer', '/thorchain/sign-amino-deposit',
  '/mayachain/sign-amino-transfer', '/mayachain/sign-amino-deposit',
  // Headless swap execute (BEX). executeSwapHeadless signs on the device with
  // no SwapDialog in the loop — gate it so the same approval overlay used by
  // every other raw-sign route (and WalletConnect) shows the swap (amount,
  // destination, memo) before the device is touched.
  '/api/v2/swap/execute',
])

/**
 * Minimum-payload fingerprint per signing route.
 *
 * Empty-body probes (observed hitting /solana/sign-transaction etc. with
 * `{}`) used to reach the approval dialog and spam the user with dialogs
 * for requests that had nothing to sign. This function returns the list
 * of top-level payload keys where *any* one being present indicates a
 * real signing attempt. The approval gate short-circuits with 400 when
 * the body contains none of them.
 *
 * Keys mirror the schemas in schemas.ts exactly; when a new sign route is
 * added to SIGNING_ROUTES it must also be added here or it'll fall
 * through as "no required fields known" → no probe gating (the handler's
 * schema.parse will still reject the empty body, just one layer deeper).
 *
 * Route families that share a schema (all the Cosmos/Osmosis amino
 * variants use CosmosAminoSignRequest — { signerAddress, signDoc }) are
 * covered by a single prefix check so we don't have to enumerate every
 * variant and risk missing one.
 */
export function requiredSigningFields(path: string): string[] | null {
  const exact: Record<string, string[]> = {
    '/eth/sign-transaction':    ['to', 'data', 'value', 'nonce'],
    '/eth/sign-typed-data':     ['typedData'],
    '/eth/sign':                ['message'],
    '/utxo/sign-transaction':   ['inputs', 'outputs'],
    '/xrp/sign-transaction':    ['payment', 'sequence'],
    '/solana/sign-transaction': ['raw_tx', 'rawTx'],
    '/solana/sign-message':     ['message'],
    '/tron/sign-transaction':   ['raw_tx', 'rawTx', 'to_address', 'amount'],
    '/ton/sign-transaction':    ['raw_tx', 'rawTx', 'to_address', 'amount'],
    '/tron/sign-message':       ['message'],
    '/tron/sign-typed-hash':    ['domain_separator_hash'],
    '/ton/sign-message':        ['message'],
    '/solana/sign-offchain-message': ['message'],
    '/api/v2/swap/execute':     ['fromCaip', 'toCaip', 'amount', 'inboundAddress'],
  }
  if (exact[path]) return exact[path]
  // All Cosmos-family amino sign endpoints (cosmos/osmosis/thorchain/
  // mayachain delegates, swaps, LP ops, IBC transfers, etc.) use
  // CosmosAminoSignRequest.
  if (/^\/(cosmos|osmosis|thorchain|mayachain)\/sign-amino/.test(path)) {
    return ['signerAddress', 'signDoc']
  }
  return null
}
