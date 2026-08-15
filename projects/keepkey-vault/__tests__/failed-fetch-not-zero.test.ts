/**
 * "A failed lookup is not a zero" — the non-EVM half of the class.
 *
 * #411/#414 fixed this for EVM (getEvmBalance, readPioneerBalance). That sweep
 * never left the EVM builders. These cover the two places it also lived:
 *
 *   - txbuilder/cosmos.ts — `?? '0'` on all three MAX balance reads
 *   - txbuilder/utxo.ts   — Promise.allSettled silently dropping an xpub whose
 *                           ListUnspent failed, after which every statement
 *                           about the total describes a subset
 *
 * Run: bun test __tests__/failed-fetch-not-zero.test.ts
 */
import { describe, test, expect } from 'bun:test'
import { buildCosmosTx, readCosmosBalance } from '../src/bun/txbuilder/cosmos'
import { buildUtxoTx, estimateUtxoFee } from '../src/bun/txbuilder/utxo'
import { isBalanceUnverified } from '../src/shared/balance-display-state'

describe('readCosmosBalance', () => {
  test('reads a real balance', () => {
    expect(readCosmosBalance({ data: { balances: [{ balance: '778.25' }] } }, 'RUNE')).toBe('778.25')
  })

  test('a real zero survives — a verified empty account is not a missing one', () => {
    expect(readCosmosBalance({ data: { balances: [{ balance: '0' }] } }, 'RUNE')).toBe('0')
    expect(readCosmosBalance({ data: { balances: [{ balance: 0 }] } }, 'RUNE')).toBe('0')
  })

  test('throws on an empty balances array rather than reading 0 through it', () => {
    // The shape a partial/failed portfolio response actually produces. `?? '0'`
    // turned this into `0 - fee` → clamped to 0 → "Amount must be greater than
    // zero" on a funded account hitting MAX.
    expect(() => readCosmosBalance({ data: { balances: [] } }, 'RUNE')).toThrow('Unable to verify')
  })

  test('throws on a missing balance field', () => {
    expect(() => readCosmosBalance({ data: { balances: [{}] } }, 'RUNE')).toThrow('no balance field')
  })

  test('throws on blank and null balances', () => {
    expect(() => readCosmosBalance({ data: { balances: [{ balance: '   ' }] } }, 'RUNE')).toThrow('no balance field')
    expect(() => readCosmosBalance({ data: { balances: [{ balance: null }] } }, 'RUNE')).toThrow('no balance field')
  })

  test('throws on null/undefined shapes rather than reading through them', () => {
    expect(() => readCosmosBalance({}, 'RUNE')).toThrow('Unable to verify')
    expect(() => readCosmosBalance(undefined, 'RUNE')).toThrow('Unable to verify')
  })
})

// ── The frontend-supplied balance can bypass the guard above ─────────────────

const THOR = {
  id: 'thorchain', coin: 'THORChain', symbol: 'RUNE',
  caip: 'cosmos:thorchain-mainnet-v1/slip44:931',
  decimals: 8, denom: 'rune', chainId: 'thorchain-1',
  defaultPath: [0x8000002c, 0x800003a3, 0x80000000, 0, 0],
} as any
const THOR_FROM = 'thor1g9el7lzjwh9yun2c4jjzhy09j98vkhfxfhgnzx'
const TCY_CAIP = 'cosmos:thorchain-mainnet-v1/denom:tcy'

const cosmosPioneer = (balances: any[]) => ({
  GetAccountInfo: async () => ({ data: { account: { account_number: '17', sequence: '2' } } }),
  GetPortfolioBalances: async () => ({ data: { balances } }),
})

const tokenMax = (pioneer: any, tokenBalance?: string) => buildCosmosTx(pioneer, THOR, {
  to: THOR_FROM, amount: '0', fromAddress: THOR_FROM, isMax: true, caip: TCY_CAIP, tokenBalance,
} as any)

describe('buildCosmosTx token MAX with a frontend balance', () => {
  test('a frontend "0" does not win over the fetch — that is the degraded value', async () => {
    // What the send form holds for a chain whose fetch failed. `??` treated the
    // string '0' as a supplied balance, so readCosmosBalance never ran and the
    // user got "Amount must be greater than zero" on a funded account.
    const err = await tokenMax(cosmosPioneer([]), '0').catch((e: Error) => e)
    expect(err.message).toContain('Unable to verify')
    expect(err.message).not.toContain('greater than zero')
  })

  test('a frontend "0" falls through to a balance the server can confirm', async () => {
    const tx = await tokenMax(cosmosPioneer([{ balance: '50' }]), '0')
    expect(tx.tx.msg[0].value.amount[0].amount).toBe('5000000000')
  })

  test('a real frontend balance is still trusted (no extra round trip)', async () => {
    const tx = await tokenMax({
      GetAccountInfo: async () => ({ data: { account: { account_number: '17', sequence: '2' } } }),
      GetPortfolioBalances: async () => { throw new Error('must not be called') },
    }, '12.5')
    expect(tx.tx.msg[0].value.amount[0].amount).toBe('1250000000')
  })
})

describe('isBalanceUnverified', () => {
  test('only degraded is unverified', () => {
    expect(isBalanceUnverified({ syncState: 'degraded' })).toBe(true)
    expect(isBalanceUnverified({ syncState: 'confirmed' })).toBe(false)
    // Stale is old, not unknown — it has its own messaging and stays a figure.
    expect(isBalanceUnverified({ syncState: 'stale' })).toBe(false)
    // Cached and legacy rows carry no syncState and are real numbers.
    expect(isBalanceUnverified({})).toBe(false)
    expect(isBalanceUnverified(undefined)).toBe(false)
  })
})

// ── UTXO multi-xpub partial failure ──────────────────────────────────────────

const BITCOIN = {
  id: 'bitcoin',
  coin: 'Bitcoin',
  symbol: 'BTC',
  networkId: 'bip122:000000000019d6689c085ae165831e93',
  decimals: 8,
  scriptType: 'p2wpkh',
} as any

const ACCOUNT_PATH = [0x80000000 + 86, 0x80000000, 0x80000000]
const XPUB = 'xpub6BosfCnifzxcFwrSzQiqu2DBVTshkCXacvNsWGYJVVhhawA7d4R5WSWGFNbi8Aw6ZRc1brxMyWMzG3DSSSSoekkudhUd9yLb6qx39T9nMdj'
const TO = 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4'
const ADDRESS = 'bc1p5cyxnuxmeuwuvkwfem96lqzszd02n6xdcjrs20cac6yqjjwudpxqkedrcr'

// Two accounts, 0.005 BTC each. `failOnCall` rejects the Nth ListUnspent, which
// is how a single unreachable xpub reaches the builder: allSettled swallows it
// and the account's coins simply vanish from the set.
function pioneerWithFailures(failOnCall: number[]) {
  let call = 0
  return {
    ListUnspent: async () => {
      call++
      if (failOnCall.includes(call)) throw new Error('ListUnspent 503')
      return {
        data: [{
          txid: `c00b24b617db136acba4d831e31727319e6917123934f9f8b5253c7f0e89a5b${call}`,
          vout: 0,
          value: '500000',
          confirmations: 12,
          address: ADDRESS,
          path: "m/86'/0'/0'/0/0",
          hex: '00',
        }],
      }
    },
    GetFeeRateByNetwork: async () => ({ data: { slow: 1, average: 2, fast: 5 } }),
    GetPubkeyInfo: async () => ({ data: [] }),
  }
}

const TWO_ACCOUNTS = [
  { xpub: XPUB, scriptType: 'p2tr', accountPath: ACCOUNT_PATH },
  { xpub: XPUB, scriptType: 'p2tr', accountPath: ACCOUNT_PATH },
]

const build = (pioneer: any, extra: Record<string, unknown>) => buildUtxoTx(pioneer, BITCOIN, {
  to: TO, xpub: XPUB, allXpubs: TWO_ACCOUNTS, scriptTypeOverride: 'p2tr', accountPath: ACCOUNT_PATH,
  ...extra,
} as any)

describe('buildUtxoTx with an unreachable xpub', () => {
  test('MAX refuses to build — a sweep that cannot see every coin is not a sweep', async () => {
    // The dangerous one: this used to build a valid tx spending only the
    // visible half, and call it "max". A wrong amount, signed, no error.
    await expect(build(pioneerWithFailures([1]), { amount: '0', isMax: true }))
      .rejects.toThrow('Cannot send max')
  })

  test('does not quote "have X" when X is only the reachable subset', async () => {
    // 1 of 2 accounts answered → 0.005 visible, 0.01 actually held. The old
    // message was "Insufficient funds: have 0.005, need 0.008" — the same
    // confident, wrong figure as "Insufficient ETH ... have 0".
    const err = await build(pioneerWithFailures([1]), { amount: '0.008' }).catch((e: Error) => e)
    expect(err.message).toContain('Cannot verify')
    expect(err.message).not.toContain('Insufficient funds')
  })

  test('a total failure blames the server, not a pending confirmation', async () => {
    const err = await build(pioneerWithFailures([1, 2]), { amount: '0.001' }).catch((e: Error) => e)
    expect(err.message).toContain('Unable to read')
    // The old text invented a reason: "the transaction may still be confirming
    // — please wait and try again", for what is a balance server outage.
    expect(err.message).not.toContain('still be confirming')
  })
})

describe('buildUtxoTx with every xpub reachable (unchanged behaviour)', () => {
  test('builds normally when both accounts answer', async () => {
    const tx = await build(pioneerWithFailures([]), { amount: '0.008' })
    expect(tx.inputs.length).toBeGreaterThan(0)
  })

  test('a genuine shortfall still says "Insufficient funds" with the real total', async () => {
    // Nothing failed, so 0.01 BTC IS the whole balance and quoting it is honest.
    const err = await build(pioneerWithFailures([]), { amount: '5' }).catch((e: Error) => e)
    expect(err.message).toContain('Insufficient funds')
    expect(err.message).toContain('have 0.01')
  })
})

describe('estimateUtxoFee', () => {
  test('returns null rather than a fee quoted against a partial UTXO set', async () => {
    expect(await estimateUtxoFee(pioneerWithFailures([1]), BITCOIN, {
      to: TO, amount: '0.001', xpub: XPUB, allXpubs: TWO_ACCOUNTS,
      scriptTypeOverride: 'p2tr', accountPath: ACCOUNT_PATH,
    } as any)).toBeNull()
  })

  test('still estimates when every account answers', async () => {
    const est = await estimateUtxoFee(pioneerWithFailures([]), BITCOIN, {
      to: TO, amount: '0.001', xpub: XPUB, allXpubs: TWO_ACCOUNTS,
      scriptTypeOverride: 'p2tr', accountPath: ACCOUNT_PATH,
    } as any)
    expect(est).not.toBeNull()
    expect(est!.feeSat).toBeGreaterThan(0)
  })
})
