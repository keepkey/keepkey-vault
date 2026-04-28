/**
 * evm-eip712/permit2-onchain-validate.js — prove on-chain validity of
 * the most recent Permit2 sig the BEX produced.
 *
 * Pulls the latest /eth/sign-typed-data entry from the vault audit log,
 * then runs THREE checks against the live Permit2 contract on mainnet:
 *
 *   1. allowance(owner, token, spender) — gets current on-chain nonce.
 *      If our typed-data nonce ≠ on-chain nonce, the dApp built a
 *      stale typed-data and Uniswap's /v1/swap will 404 with InvalidNonce
 *      (or its server equivalent). NOT a sig bug.
 *
 *   2. ECDSA recovery off-chain (already proven, redundant safety net).
 *
 *   3. permit(owner, permitSingle, signature) via eth_call — simulates
 *      the actual on-chain consumption of our sig. If this succeeds with
 *      no revert, our sig is provably valid on mainnet. The Permit2
 *      contract is the ultimate authority on whether a Permit2 sig is
 *      "good"; a successful eth_call here is ironclad proof that the
 *      vault → device → BEX chain produces sigs the canonical contract
 *      accepts.
 *
 *      If it reverts, the revert selector tells us exactly what's wrong:
 *        - 0x756688fe InvalidNonce()       → stale nonce
 *        - 0xcd21db4f SignatureExpired()    → sigDeadline in the past
 *        - 0x815e1d64 InvalidSigner()       → recovery doesn't match owner
 *        - 0x8baa579f InvalidSignature()    → bytes are not a valid sig
 *        - 0x8755c33f LengthMismatch()      → wrong sig length
 *
 * Run:
 *   KEEPKEY_API_KEY=<bearer> node tests/evm-eip712/permit2-onchain-validate.js
 *   # optional: ETH_RPC=https://your-rpc node tests/...
 */
const { utils, providers, Contract, BigNumber } = require('/Users/highlander/WebstormProjects/keepkey-stack/projects/keepkey-vault-v11/projects/keepkey-vault/node_modules/ethers')

const VAULT_URL = process.env.KEEPKEY_URL || 'http://localhost:1646'
const ETH_RPC = process.env.ETH_RPC || 'https://eth.llamarpc.com'
const PERMIT2 = '0x000000000022D473030F116dDEE9F6B43aC78BA3'

const PERMIT2_ABI = [
  'function allowance(address user, address token, address spender) view returns (uint160 amount, uint48 expiration, uint48 nonce)',
  'function permit(address owner, ((address,uint160,uint48,uint48),address,uint256) permitSingle, bytes signature)',
]

// Custom-error selectors from Permit2's source
// https://github.com/Uniswap/permit2/blob/main/src/PermitErrors.sol
const KNOWN_ERRORS = {
  '0x756688fe': 'InvalidNonce()',
  '0xcd21db4f': 'SignatureExpired()',
  '0x815e1d64': 'InvalidSigner()',
  '0x8baa579f': 'InvalidSignature()',
  '0x8755c33f': 'LengthMismatch()',
  '0x1f6a65b6': 'InvalidContractSignature()',
  '0x77e0b9b3': 'AllowanceExpired()',
  '0x4d68b6df': 'InsufficientAllowance()',
  '0xfb4ee9d4': 'InvalidAmount()',
}

function decodeRevert(err) {
  const data = err?.error?.data || err?.data || err?.errorArgs || ''
  const hex = typeof data === 'string' ? data : (data?.data || '')
  if (!hex || typeof hex !== 'string') return null
  const sel = hex.slice(0, 10).toLowerCase()
  return KNOWN_ERRORS[sel] || `unknown selector ${sel}`
}

async function pullLatestEntry() {
  const apiKey = process.env.KEEPKEY_API_KEY
  if (!apiKey) throw new Error('KEEPKEY_API_KEY env var required (POST /auth/pair to get one)')
  const r = await fetch(`${VAULT_URL}/api/v1/activity?route=/eth/sign-typed-data&limit=1`, {
    headers: { 'Authorization': `Bearer ${apiKey}` },
  })
  if (!r.ok) throw new Error(`activity fetch ${r.status}`)
  const { entries } = await r.json()
  if (!entries.length) throw new Error('no /eth/sign-typed-data entries in activity log — sign one first')
  return entries[0]
}

async function main() {
  console.log('=== Permit2 on-chain validation ===\n')
  console.log(`vault:  ${VAULT_URL}`)
  console.log(`rpc:    ${ETH_RPC}`)
  console.log(`Permit2:${PERMIT2}`)
  console.log()

  const entry = await pullLatestEntry()
  const { typedData } = entry.requestBody
  const sig = entry.responseBody?.signature
  if (!sig || sig === '[trimmed]') {
    throw new Error(`entry ${entry.id} has trimmed signature — restart vault on a recent build that persists sigs`)
  }
  if (typedData.primaryType !== 'PermitSingle') {
    throw new Error(`entry ${entry.id} primaryType=${typedData.primaryType}; this test only handles PermitSingle`)
  }

  const owner = entry.requestBody.address
  const { token, amount, expiration, nonce } = typedData.message.details
  const spender = typedData.message.spender
  const sigDeadline = typedData.message.sigDeadline

  console.log(`entry id:        ${entry.id}`)
  console.log(`when:            ${new Date(entry.timestamp).toISOString()}`)
  console.log(`app:             ${entry.appName}`)
  console.log(`owner:           ${owner}`)
  console.log(`token:           ${token}`)
  console.log(`spender:         ${spender}`)
  console.log(`typed-data nonce:${nonce}`)
  console.log(`sigDeadline:     ${sigDeadline} (${new Date(Number(sigDeadline) * 1000).toISOString()})`)
  console.log(`sig:             ${sig}`)
  console.log()

  // ── 1. ECDSA recover off-chain (sanity) ─────────────────────────────
  const noDomain = { ...typedData.types }
  delete noDomain.EIP712Domain
  const recovered = utils.verifyTypedData(typedData.domain, noDomain, typedData.message, sig)
  console.log(`[1] off-chain recover:   ${recovered}`)
  const ok1 = recovered.toLowerCase() === owner.toLowerCase()
  console.log(`    matches owner:        ${ok1 ? '✅ YES' : '❌ NO'}`)
  if (!ok1) {
    console.log('    Sig does not even recover off-chain — abort, fix that first.')
    process.exit(1)
  }
  console.log()

  // ── 2. Query on-chain nonce ────────────────────────────────────────
  // Pin the network in the provider config so ethers v5 doesn't try to
  // re-detect on each call (it does that for JsonRpcProvider w/o a network arg)
  const provider = new providers.StaticJsonRpcProvider(ETH_RPC, { chainId: 1, name: 'mainnet' })
  const permit2 = new Contract(PERMIT2, PERMIT2_ABI, provider)
  console.log(`[2] RPC chainId:         1 (pinned)`)

  const onChain = await permit2.allowance(owner, token, spender)
  console.log(`    on-chain amount:      ${onChain.amount.toString()}`)
  console.log(`    on-chain expiration:  ${onChain.expiration} (${onChain.expiration > 0 ? new Date(onChain.expiration * 1000).toISOString() : 'never'})`)
  console.log(`    on-chain nonce:       ${onChain.nonce}`)
  console.log(`    typed-data nonce:     ${nonce}`)
  const nonceMatch = BigNumber.from(onChain.nonce).eq(BigNumber.from(nonce))
  console.log(`    nonce matches:        ${nonceMatch ? '✅ YES' : '❌ NO — DAPP BUILT STALE TYPED-DATA'}`)
  if (!nonceMatch) {
    console.log()
    console.log('    💡 The dApp signed Permit2 with the wrong nonce. The sig is')
    console.log('       cryptographically valid but the Permit2 contract will reject')
    console.log('       it. /v1/swap 404 is downstream symptom of stale dApp state.')
    console.log('       This is NOT a KeepKey bug. Likely cause: a previous Permit2')
    console.log('       sign for the same (owner, token, spender) consumed a nonce')
    console.log('       (perhaps from another wallet, or a previous BEX session)')
    console.log('       without the dApp refreshing its quote.')
  }
  console.log()

  // ── 3. eth_call permit() ───────────────────────────────────────────
  // Use raw provider.call() so we see exactly what the RPC returns —
  // ethers's Contract.callStatic wraps revert data into a string that
  // some RPCs (llamarpc, cloudflare) strip clean of selector bytes.
  console.log('[3] eth_call Permit2.permit() ...')
  const iface = permit2.interface
  const permitSingle = [
    [token, BigNumber.from(amount), Number(expiration), Number(nonce)],
    spender,
    BigNumber.from(sigDeadline),
  ]
  const data = iface.encodeFunctionData('permit', [owner, permitSingle, sig])
  console.log(`    calldata len:         ${(data.length - 2) / 2} bytes`)

  // Try multiple RPCs — some strip revert data, others return it verbatim
  const RPC_CHAIN = [
    ETH_RPC,
    'https://rpc.ankr.com/eth',
    'https://ethereum.publicnode.com',
    'https://eth.drpc.org',
  ]
  let lastResp = null
  for (const rpc of RPC_CHAIN) {
    try {
      const r = await fetch(rpc, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0', id: 1, method: 'eth_call',
          params: [{ from: owner, to: PERMIT2, data }, 'latest'],
        }),
      })
      const j = await r.json()
      if (j.result === '0x') {
        console.log(`    [${rpc}] returned 0x → call succeeded with no return data`)
        console.log('    ✅ Permit2 contract accepts our sig — sig is on-chain valid.')
        console.log('       /v1/swap 404 is NOT caused by the sig.')
        return
      }
      if (j.error) {
        const errData = j.error.data
        const errMsg = j.error.message || ''
        const sel = (typeof errData === 'string' ? errData : errData?.data || '').slice(0, 10).toLowerCase()
        const named = KNOWN_ERRORS[sel]
        console.log(`    [${rpc}] error: ${errMsg}`)
        if (sel && sel !== '0x' && sel.length === 10) {
          console.log(`    revert selector:      ${sel} → ${named || 'unknown'}`)
          if (named) {
            console.log()
            if (named.startsWith('InvalidNonce')) console.log('    💡 Stale nonce. dApp built typed-data with wrong nonce.')
            else if (named.startsWith('SignatureExpired')) console.log('    💡 sigDeadline in past.')
            else if (named.startsWith('InvalidSigner')) console.log('    💡 Sig recovers to wrong address — real KeepKey bug.')
            else if (named.startsWith('InvalidSignature')) console.log('    💡 Sig bytes are not a valid ECDSA signature.')
            else if (named.startsWith('LengthMismatch')) console.log('    💡 Sig length mismatch (expects 64 or 65 bytes).')
            return
          }
        }
        lastResp = j
        continue
      }
      console.log(`    [${rpc}] result:`, j.result)
      console.log('    ✅ Permit2 accepts our sig (returned data).')
      return
    } catch (e) {
      console.log(`    [${rpc}] threw: ${e.message?.slice(0, 100)}`)
      lastResp = { error: { message: e.message } }
    }
  }
  console.log()
  console.log('    Could not get a definitive revert reason from any RPC.')
  console.log('    Last response:', JSON.stringify(lastResp).slice(0, 300))
}

main().then(() => process.exit(0)).catch(e => {
  console.error('crashed:', e.message || e)
  process.exit(1)
})
