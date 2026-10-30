import type { CalldataDecodedField } from '../shared/types'
import { REVIEWED_EVM_TOKENS } from '../shared/reviewed-evm-tokens'

const field = (name: string, value: string, type = 'string'): CalldataDecodedField => ({ name, value, type, format: 'raw' })
const fixed = (raw: bigint, decimals: number): string => {
  const scale = 10n ** BigInt(decimals)
  const whole = (raw / scale).toString()
  const fraction = (raw % scale).toString().padStart(decimals, '0').replace(/0+$/, '')
  return fraction ? `${whole}.${fraction}` : whole
}
const thorLimit = (raw: string): bigint | null => {
  const match = /^(\d{1,20})(?:[eE](\d{1,2}))?$/.exec(raw)
  if (!match) return null
  const exponent = Number(match[2] || '0')
  if (match[1].length + exponent > 20) return null
  return BigInt(match[1]) * 10n ** BigInt(exponent)
}

/** Input tokens named only at these exact contracts: Ethereum USDC and USDT,
 *  and the reviewed Base and Arbitrum deployments. */
const INPUT_TOKENS: Record<string, { symbol: string; decimals: number }> = {
  '1:0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48': { symbol: 'USDC', decimals: 6 },
  '1:0xdac17f958d2ee523a2206206994597c13d831ec7': { symbol: 'USDT', decimals: 6 },
  ...REVIEWED_EVM_TOKENS,
}
const INPUT_CHAIN_NAMES: Record<number, string> = { 1: 'Ethereum', 8453: 'Base', 42161: 'Arbitrum' }

/** Short codes the network expands in a memo (THORChain common/asset.go
 *  ShortCode, thornode 55ac22c7; Mayachain common/asset.go ShortCode and
 *  TwoLetterShortCodeV129, as NewAssetWithShortCodesV129 reads them, mayanode
 *  de97de72). The two networks use different codes ('tr' is TRON.TRX on
 *  THORChain, THOR.RUNE on Maya). A code names its contract itself. */
const SHORT_CODES: Record<'THORChain' | 'Mayachain', Record<string, string>> = {
  THORChain: {
    r: 'THOR.RUNE', b: 'BTC.BTC', e: 'ETH.ETH', g: 'GAIA.ATOM', d: 'DOGE.DOGE', l: 'LTC.LTC', c: 'BCH.BCH',
    a: 'AVAX.AVAX', s: 'BSC.BNB', f: 'BASE.ETH', tr: 'TRON.TRX', x: 'XRP.XRP', o: 'SOL.SOL', ta: 'TAO.TAO',
    z: 'ZEC.ZEC', m: 'XMR.XMR', p: 'POL.POL', u: 'SUI.SUI', do: 'DOT.DOT', ad: 'ADA.ADA',
  },
  Mayachain: {
    a: 'ARB.ETH', b: 'BTC.BTC', d: 'DASH.DASH', e: 'ETH.ETH', k: 'KUJI.KUJI', c: 'MAYA.CACAO',
    r: 'THOR.RUNE', x: 'XRD.XRD', z: 'ZEC.ZEC',
    ae: 'ARB.ETH', at: 'ARB.USDT-0XFD086BC7CD5C481DCC9C85EBE478A1C0B69FCBB9',
    ac: 'ARB.USDC-0XAF88D065E77C8CC2239327C5EDB3A432268E5831', ad: 'ARB.DAI-0XDA10009CBD5D07DD0CECC66161FC93D7C9000DA1',
    ap: 'ARB.PEPE-0X25D887CE7A35172C62FEBFD67A1856F20FAEBB00', aw: 'ARB.WSTETH-0X5979D7B546E38E414F7E9822514BE443A4800529',
    ab: 'ARB.WBTC-0X2F2A2543B76A4166549F7AAB2E75BEF0AEFC5B0F', bb: 'BTC.BTC', dd: 'DASH.DASH',
    et: 'ETH.USDT-0XDAC17F958D2EE523A2206206994597C13D831EC7', ec: 'ETH.USDC-0XA0B86991C6218B36C1D19D4A2E9EB0CE3606EB48',
    ep: 'ETH.PEPE-0X6982508145454CE325DDBE47A25D4EC3D2311933', ew: 'ETH.WSTETH-0X7F39C581F595B53C5CB19BD0B3F8DA6C935E2CA0',
    ku: 'KUJI.USK', mc: 'MAYA.CACAO', tr: 'THOR.RUNE', xx: 'XRD.XRD', ee: 'ETH.ETH', kk: 'KUJI.KUJI',
    aa: 'ADA.ADA', zz: 'ZEC.ZEC',
  },
}

/** Decode only canonical THORChain router ABI. A partial selector match must
 * never produce a reassuring swap summary in the Vault approval dialog. */
export function thorDepositFields(data: string, chainId?: number, protocol: 'THORChain' | 'Mayachain' | 'Unverified' = 'THORChain'): CalldataDecodedField[] | null {
  if (!/^0x[0-9a-fA-F]+$/.test(data)) return null
  const selector = data.slice(0, 10).toLowerCase()
  const words = selector === '0x44bc937b' ? 5 : selector === '0x1fece7b4' ? 4 : 0
  if (!words) return null
  const body = data.slice(10)
  const headChars = words * 64
  if (body.length < headChars + 64) return null
  const word = (index: number) => body.slice(index * 64, (index + 1) * 64)
  const address = (index: number) => /^0{24}[0-9a-fA-F]{40}$/.test(word(index)) ? `0x${word(index).slice(24)}` : null
  const vault = address(0)
  const asset = address(1)
  if (!vault || !asset || BigInt(`0x${word(3)}`) !== BigInt(words * 32)) return null
  const amount = BigInt(`0x${word(2)}`)
  const memoLength = BigInt(`0x${body.slice(headChars, headChars + 64)}`)
  if (memoLength > 1024n) return null
  const memoBytes = Number(memoLength)
  const paddedChars = Math.ceil(memoBytes / 32) * 64
  if (body.length !== headChars + 64 + paddedChars) return null
  const memoHex = body.slice(headChars + 64, headChars + 64 + memoBytes * 2)
  if (!/^0*$/.test(body.slice(headChars + 64 + memoBytes * 2))) return null
  let memo: string
  try { memo = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(memoHex, 'hex')) } catch { return null }
  if (memo.includes('\0')) return null

  const native = /^0x0{40}$/i.test(asset)
  const inputToken = !native && chainId && INPUT_CHAIN_NAMES[chainId] ? INPUT_TOKENS[`${chainId}:${asset.toLowerCase()}`] : undefined
  const inputUnit = native ? (chainId === 43114 ? 'AVAX' : chainId === 8453 ? 'ETH on Base' : chainId === 1 ? 'ETH'
    : chainId === 56 ? 'BNB' : chainId === 42161 ? 'ETH on Arbitrum' : 'native coin')
    : inputToken?.symbol ?? 'raw token units'
  const amountText = native && (chainId === 1 || chainId === 43114 || chainId === 8453 || chainId === 56 || chainId === 42161)
    ? `${fixed(amount, 18)} ${inputUnit}` : inputToken
      ? `${fixed(amount, inputToken.decimals)} ${inputToken.symbol}` : `${amount} ${inputUnit}`
  const fields = [
    field('Protocol', `${protocol} Router`),
    field('Vault', vault, 'address'),
    field('Input asset', native ? inputUnit : asset, native ? 'string' : 'address'),
    field('Input amount', amountText),
  ]
  if (inputToken) fields.push(field('Input token', `Verified ${INPUT_CHAIN_NAMES[chainId!]} ${inputToken.symbol} contract`))
  else if (!native) fields.push(field('Input token warning', `UNVERIFIED input token contract ${asset}`))
  let expired = false
  if (words === 5) {
    const epoch = BigInt(`0x${word(4)}`)
    expired = epoch < BigInt(Math.floor(Date.now() / 1000))
    fields.push(field('Expiry', epoch <= 253402300799n
      ? `${new Date(Number(epoch) * 1000).toISOString()}${expired ? ' (EXPIRED)' : ''}` : epoch.toString()))
  }

  const parts = memo.split(':')
  if (parts.length >= 3 && parts.length <= 6 && ['=', 's', 'SWAP'].includes(parts[0])) {
    const short = protocol !== 'Unverified' && Object.prototype.hasOwnProperty.call(SHORT_CODES[protocol], parts[1]) ? SHORT_CODES[protocol][parts[1]] : undefined
    if (short) parts[1] = short
    const assetMatch = /^([A-Z0-9]+)\.([A-Z0-9]{1,12})(?:-.+)?$/.exec(parts[1])
    if (assetMatch) {
      const output = assetMatch[2]
      const outputChain = assetMatch[1]
      const outputContract = /^([A-Z0-9]+)\.([A-Z0-9]{1,12})-(0x[0-9a-fA-F]{40})$/i.exec(parts[1])?.[3]
      // Only these exact Ethereum contracts are pinned. A memo's ticker is
      // caller-controlled text and cannot authenticate the output token.
      const pinnedStablecoins: Record<string, string> = {
        'ETH.USDC': '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
        'ETH.USDT': '0xdac17f958d2ee523a2206206994597c13d831ec7',
        'BASE.USDC': '0x833589fcD6eDb6E08f4c7C32D4f71b54bdA02913',
      }
      const expectedContract = pinnedStablecoins[`${outputChain}.${output}`]?.toLowerCase()
      // A ticker with no contract is the network's own pool asset: it matches
      // the deepest pool with that ticker (THORChain docs, memo-length-reduction
      // "Asset Abbreviations"), so it is not a token the memo can fake. A short
      // code names its contract from the network's own table (SHORT_CODES).
      const suffix = /-(.+)$/.exec(parts[1])?.[1]
      const tokenWarning = short ? null : outputContract
        ? expectedContract && outputContract.toLowerCase() === expectedContract
          ? null : `UNVERIFIED ${output} token contract ${outputContract}`
        : expectedContract && suffix && !expectedContract.endsWith(suffix.toLowerCase())
          ? `UNVERIFIED ${output} token contract (memo names -${suffix})` : null
      const destination = parts[2] || 'self'
      const rawLimit = parts[3] ?? ''
      const streamMatch = /^(.*)\/(\d{1,5})\/(\d{1,5})$/.exec(rawLimit)
      const limit = thorLimit(streamMatch ? streamMatch[1] : rawLimit)
      const minimum = rawLimit === '' ? 'No minimum specified' : limit !== null
        ? `${fixed(limit, 8)} ${output}` : `${rawLimit} (raw ${protocol} limit)`
      fields.unshift(field('Action', `Swap ${amountText} for ${rawLimit === '' ? `${output} with NO MINIMUM` : `at least ${minimum}`} on ${outputChain} via ${protocol}${expired ? ' — EXPIRED' : ''}${tokenWarning ? ` — ${tokenWarning}` : ''}${streamMatch && limit !== null ? ' (streaming)' : ''}`))
      fields.push(field('Output chain', outputChain), field('Output asset', parts[1]), field('Output destination', destination), field('Minimum output', minimum))
      if (tokenWarning) fields.push(field('Token warning', tokenWarning))
      if (streamMatch && limit !== null) {
        const interval = Number(streamMatch[2])
        const count = Number(streamMatch[3])
        fields.push(field('Streaming', `Every ${interval} block${interval === 1 ? '' : 's'}; ${count === 0 ? 'network chooses swap count' : `${count} swaps`}`))
      }
      if (parts[4] || parts[5]) {
        const rawBps = parts[5] || 'unspecified'
        const bps = /^\d{1,4}$/.test(rawBps) ? Number(rawBps) : NaN
        const fee = Number.isInteger(bps) && bps <= 1000
          ? `${Math.floor(bps / 100)}.${String(bps % 100).padStart(2, '0')}% (${rawBps} bps)`
          : `${rawBps} bps`
        fields.push(field('Affiliate fee', `${fee} to ${parts[4] || '(none given)'}`))
      }
    }
  }
  fields.push(field('Memo (exact)', memo))
  return fields
}
