/** Balance errors of the send builders: thrown in English (the REST API and logs
 *  read them as they are), shown translated by the send form (KEEPKEY-177).
 *
 *  Every "not enough balance" a send builder throws is listed here and built with
 *  balanceErrorMessage, so the text the builder throws and the pattern the UI
 *  reads back cannot drift apart. send-balance-errors.test.ts fails if a builder
 *  throws an "Insufficient …" text of its own. */
import { validNumberLocale } from './locale'
import { formatBaseUnits } from './utxo-dust-errors'

export const BALANCE_ERRORS = {
  // Cosmos SDK chains
  amountAndFee: 'Insufficient {symbol} spendable balance for amount and transaction fee',
  nothingAfterFees: 'Insufficient spendable balance: amount must be greater than zero after fees',
  token: 'Insufficient spendable token balance',
  // EVM
  tokenAmount: 'Insufficient balance: {available} available, {requested} requested',
  gas: 'Insufficient {symbol} for gas: have {have}, need ~{need} {symbol}',
  gasForMax: 'Insufficient funds to cover gas fees',
  amountAndGas: 'Insufficient funds: balance {have} {symbol}, need {need} {symbol} (incl gas)',
  // UTXO
  amount: 'Insufficient funds: have {have}, need {need} {symbol}',
  amountAndUtxoFee: 'Coin selection failed (possibly high fees)',
  dogeMinimumFee: 'Insufficient DOGE to cover minimum 1 DOGE network fee',
  zcashMinimumFee: 'Insufficient ZEC to cover ZIP-317 minimum fee ({zats} zats for {actions} actions)',
  zcashMinimumFeeExact: 'Insufficient ZEC to cover ZIP-317 minimum fee ({zats} zats for {actions} actions). Try sending a slightly smaller amount.',
  // XRP and TRON
  xrpReserve: 'Insufficient XRP after account reserve and transaction fee',
  tronMaxReserve: 'Insufficient TRX for max send after reserving {reserve} TRX for network fees',
} as const

export type BalanceErrorKind = keyof typeof BALANCE_ERRORS

/** The send-namespace key of each kind. */
const KEYS: Record<BalanceErrorKind, string> = {
  amountAndFee: 'insufficientAmountAndFee',
  nothingAfterFees: 'insufficientAfterFees',
  token: 'insufficientToken',
  tokenAmount: 'insufficientTokenAmount',
  gas: 'insufficientGas',
  gasForMax: 'insufficientGasForMax',
  amountAndGas: 'insufficientAmountAndGas',
  amount: 'insufficientAmount',
  amountAndUtxoFee: 'insufficientAmountAndFeeNoSymbol',
  dogeMinimumFee: 'insufficientDogeMinimumFee',
  zcashMinimumFee: 'insufficientZcashMinimumFee',
  zcashMinimumFeeExact: 'insufficientZcashMinimumFeeExact',
  xrpReserve: 'insufficientXrpReserve',
  tronMaxReserve: 'insufficientTronMaxReserve',
}

type Params = Record<string, string | number>

/** The English message a builder throws, e.g. balanceErrorMessage('amountAndFee', { symbol: 'OSMO' }). */
export function balanceErrorMessage(kind: BalanceErrorKind, params: Params = {}): string {
  return BALANCE_ERRORS[kind].replace(/\{(\w+)\}/g, (_, name: string) => {
    if (!(name in params)) throw new Error(`balanceErrorMessage(${kind}) is missing {${name}}`)
    return String(params[name])
  })
}

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** The template as an anchored pattern; a placeholder used twice must match the same text. */
function pattern(template: string): RegExp {
  const seen = new Set<string>()
  const source = template.split(/(\{\w+\})/).map(part => {
    const name = /^\{(\w+)\}$/.exec(part)?.[1]
    if (!name) return escape(part)
    if (seen.has(name)) return `\\k<${name}>`
    seen.add(name)
    return `(?<${name}>\\S+?)`
  }).join('')
  return new RegExp(`^${source}$`)
}

const PATTERNS = (Object.keys(BALANCE_ERRORS) as BalanceErrorKind[]).map(kind => ({ kind, re: pattern(BALANCE_ERRORS[kind]) }))

/** Which balance error a message is, with its values, or null. */
export function parseBalanceError(message: string): { kind: BalanceErrorKind; params: Record<string, string> } | null {
  for (const { kind, re } of PATTERNS) {
    const match = re.exec(message.trim())
    if (match) return { kind, params: { ...match.groups } }
  }
  return null
}

/** A plain decimal in the UI locale, every decimal kept; anything else (e.g. 1e-7) as it came. */
function localizeAmount(value: string, locale: string): string {
  if (!/^\d+(?:\.\d+)?$/.test(value)) return value
  const decimals = value.split('.')[1]?.length ?? 0
  return Number(value).toLocaleString(validNumberLocale(locale), { minimumFractionDigits: decimals, maximumFractionDigits: decimals })
}

const AMOUNTS = new Set(['have', 'need', 'available', 'requested', 'reserve'])

/** The send-namespace message for a builder balance error, or null for any other error. */
export function describeBalanceError(message: string, t: (key: any, options?: any) => any, locale = 'en-US'): string | null {
  const parsed = parseBalanceError(message)
  if (!parsed) return null
  const values: Record<string, string> = {}
  for (const [name, value] of Object.entries(parsed.params)) {
    values[name] = AMOUNTS.has(name) ? localizeAmount(value, locale) : value
  }
  // The ZIP-317 fee comes in zats; people read it in ZEC.
  if (parsed.params.zats) values.fee = localizeAmount(formatBaseUnits(Number(parsed.params.zats), 8), locale)
  return t(KEYS[parsed.kind], { ns: 'send', ...values })
}
