/**
 * Test: chain.listUnspent + chain.getPubkeyInfo
 *
 * Requires device connected — derives BTC zpub to query UTXOs.
 */
const { run } = require('../_helpers')

const BTC_ZPUB_PATH = [0x80000000 + 84, 0x80000000, 0x80000000] // m/84'/0'/0'

run('Chain — UTXO (listUnspent + pubkeyInfo)', async (getSdk, assert) => {
  const sdk = await getSdk()

  // Derive zpub from device
  const pubkeyResp = await sdk.xpub.getPublicKey({
    address_n: BTC_ZPUB_PATH,
    coin_name: 'Bitcoin',
    script_type: 'p2wpkh',
  })
  const zpub = pubkeyResp?.xpub
  assert('Got zpub', zpub && (zpub.startsWith('zpub') || zpub.startsWith('xpub')))

  if (!zpub) return

  // ── listUnspent ────────────────────────────────────────────────
  const utxoResp = await sdk.chain.listUnspent({ network: 'BTC', xpub: zpub })
  const utxoData = utxoResp?.data || utxoResp
  assert('listUnspent returns data', utxoData !== undefined)
  // Could be empty array if no UTXOs — that's fine
  const utxos = Array.isArray(utxoData) ? utxoData : utxoData?.data || []
  assert('UTXOs is an array', Array.isArray(utxos))

  // ── getPubkeyInfo ──────────────────────────────────────────────
  const infoResp = await sdk.chain.getPubkeyInfo({ network: 'BTC', xpub: zpub })
  const infoData = infoResp?.data || infoResp
  assert('getPubkeyInfo returns data', infoData !== undefined)
})
