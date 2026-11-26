// KEEPKEY-177 (Audit v7 S11): send builders' balance errors reached the UI in
// English ("Insufficient OSMO spendable balance for amount and transaction fee"),
// and nothing warned while the amount was typed that it did not cover the fee.
import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { BALANCE_ERRORS, balanceErrorMessage, describeBalanceError, parseBalanceError, type BalanceErrorKind } from '../src/shared/send-balance-errors'
import { amountPlusFeeExceedsBalance, cosmosDisplayFee, cosmosSendFee } from '../src/shared/cosmos-fee'
import { dustErrorMessage } from '../src/shared/utxo-dust-errors'

const t = (key: string, options: Record<string, unknown> = {}) =>
  [key, ...Object.entries(options).filter(([k]) => k !== 'ns').map(([k, v]) => `${k}=${v}`)].join('|')

const SAMPLES: Record<BalanceErrorKind, Record<string, string | number>> = {
  amountAndFee: { symbol: 'OSMO' },
  nothingAfterFees: {},
  token: {},
  tokenAmount: { available: '80.923336', requested: '100' },
  gas: { symbol: 'ETH', have: 0.001, need: 0.0021 },
  gasForMax: {},
  amountAndGas: { symbol: 'BNB', have: 0.5, need: 0.5002 },
  amount: { have: 0.005, need: 0.008, symbol: 'BTC' },
  amountAndUtxoFee: {},
  dogeMinimumFee: {},
  zcashMinimumFee: { zats: 15000, actions: 3 },
  zcashMinimumFeeExact: { zats: 15000, actions: 3 },
  xrpReserve: {},
  tronMaxReserve: { reserve: 30 },
  staking: { symbol: 'ATOM' },
  registration: { symbol: 'RUNE' },
  solanaMaxSwap: {},
}

describe('send balance errors', () => {
  test('every builder message reads back as its own kind and values', () => {
    for (const kind of Object.keys(BALANCE_ERRORS) as BalanceErrorKind[]) {
      const parsed = parseBalanceError(balanceErrorMessage(kind, SAMPLES[kind]))
      expect(parsed?.kind).toBe(kind)
      expect(parsed?.params).toEqual(Object.fromEntries(Object.entries(SAMPLES[kind]).map(([k, v]) => [k, String(v)])))
    }
  })

  test('keeps the English text the REST API, tests and the swap dialog already read', () => {
    expect(balanceErrorMessage('amountAndFee', { symbol: 'OSMO' })).toBe('Insufficient OSMO spendable balance for amount and transaction fee')
    expect(balanceErrorMessage('tokenAmount', { available: '80.923336', requested: '100' })).toBe('Insufficient balance: 80.923336 available, 100 requested')
    expect(balanceErrorMessage('gas', { symbol: 'ETH', have: 0.001, need: 0.0021 })).toBe('Insufficient ETH for gas: have 0.001, need ~0.0021 ETH')
    expect(balanceErrorMessage('amountAndUtxoFee')).toBe('Coin selection failed (possibly high fees)')
    expect(() => balanceErrorMessage('amountAndFee')).toThrow('missing {symbol}')
  })

  test('the UI shows the translated message with the values in the UI locale', () => {
    expect(describeBalanceError('Insufficient OSMO spendable balance for amount and transaction fee', t, 'pt-BR')).toBe('insufficientAmountAndFee|symbol=OSMO')
    expect(describeBalanceError('Insufficient funds: have 0.005, need 0.008 BTC', t, 'pt-BR')).toBe('insufficientAmount|have=0,005|need=0,008|symbol=BTC')
    expect(describeBalanceError('Insufficient ETH for gas: have 1e-7, need ~0.0021 ETH', t, 'pt-BR')).toBe('insufficientGas|symbol=ETH|have=1e-7|need=0,0021')
    expect(describeBalanceError(balanceErrorMessage('zcashMinimumFee', { zats: 15000, actions: 3 }), t, 'en-US')).toBe('insufficientZcashMinimumFee|zats=15000|actions=3|fee=0.00015')
  })

  test('any other error is left alone', () => {
    expect(describeBalanceError('Network unreachable', t)).toBeNull()
    expect(describeBalanceError(dustErrorMessage('amount', '0.00000546', 'BTC'), t)).toBeNull()
    // The same symbol twice must match: a mangled message is not read as a balance error.
    expect(parseBalanceError('Insufficient ETH for gas: have 1, need ~2 BNB')).toBeNull()
  })

  // Zcash shielding has its own screen and messages.
  const OTHER_FLOWS = /Insufficient transparent balance/

  test('no send builder throws a balance error text of its own', () => {
    const dir = join(import.meta.dir, '../src/bun/txbuilder')
    const offenders: string[] = []
    for (const file of readdirSync(dir).filter(f => f.endsWith('.ts') && !f.endsWith('.test.ts'))) {
      readFileSync(join(dir, file), 'utf8').split('\n').forEach((line, i) => {
        if (/Error\(\s*[`'"](Insufficient|Coin selection failed)/.test(line) && !OTHER_FLOWS.test(line)) offenders.push(`${file}:${i + 1}`)
      })
    }
    expect(offenders).toEqual([])
  })
})

describe('Cosmos amount + fee while typing', () => {
  test('the shared fee is the one the builder signs', () => {
    expect(cosmosSendFee('osmosis', 3)).toEqual({ gas: '1500000', amount: [{ denom: 'uosmo', amount: '15000' }] })
    expect(cosmosDisplayFee('osmosis', 6, cosmosSendFee('osmosis', 3))).toBe('0.015')
    expect(cosmosDisplayFee('osmosis', 6, cosmosSendFee('osmosis', 1))).toBe('0.01')
    expect(cosmosDisplayFee('cosmos', 6, cosmosSendFee('cosmos', 10))).toBe('0.01')
    expect(cosmosDisplayFee('thorchain', 8, cosmosSendFee('thorchain', 3))).toBe('0.02')
  })

  test('compares in base units, so a float sum never warns wrongly', () => {
    expect(0.2 + 0.1 > 0.3).toBe(true) // the float trap
    expect(amountPlusFeeExceedsBalance('0.2', '0.1', '0.3', 6)).toBe(false)
    expect(amountPlusFeeExceedsBalance('0.200001', '0.1', '0.3', 6)).toBe(true)
    expect(amountPlusFeeExceedsBalance('abc', '0.01', '0.3', 6)).toBe(false)
  })

  test('SendForm warns on OSMO amount + fee over the balance and shows the build error translated', () => {
    const run = Bun.spawnSync([process.execPath, new URL('./support/send-form-balance-errors.tsx', import.meta.url).pathname], {
      cwd: new URL('../', import.meta.url).pathname, stdout: 'pipe', stderr: 'pipe', timeout: 30000,
    })
    if (run.exitCode !== 0) throw new Error(run.stderr.toString() || run.stdout.toString())
    expect(JSON.parse(run.stdout.toString().trim().split('\n').at(-1)!)).toEqual({
      overByFee: { withFee: true, overBalance: false },
      exactlyBalance: { withFee: false, overBalance: false },
      underBalance: { withFee: false, overBalance: false },
      overBalance: { withFee: false, overBalance: true },
      buildError: true,
    })
  }, 35000)
})
