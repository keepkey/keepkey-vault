import type { CalldataDecodedField } from '../shared/types'

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
  const ethereumInputTokens: Record<string, string> = {
    '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48': 'USDC',
    '0xdac17f958d2ee523a2206206994597c13d831ec7': 'USDT',
  }
  const inputToken = !native && chainId === 1 ? ethereumInputTokens[asset.toLowerCase()] : undefined
  const inputUnit = native ? (chainId === 43114 ? 'AVAX' : chainId === 8453 ? 'ETH on Base' : chainId === 1 ? 'ETH'
    : chainId === 56 ? 'BNB' : chainId === 42161 ? 'ETH on Arbitrum' : 'native coin')
    : inputToken ?? 'raw token units'
  const amountText = native && (chainId === 1 || chainId === 43114 || chainId === 8453 || chainId === 56 || chainId === 42161)
    ? `${fixed(amount, 18)} ${inputUnit}` : inputToken
      ? `${fixed(amount, 6)} ${inputToken}` : `${amount} ${inputUnit}`
  const fields = [
    field('Protocol', `${protocol} Router`),
    field('Vault', vault, 'address'),
    field('Input asset', native ? inputUnit : asset, native ? 'string' : 'address'),
    field('Input amount', amountText),
  ]
  if (inputToken) fields.push(field('Input token', `Verified Ethereum ${inputToken} contract`))
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
      const tokenWarning = outputContract
        ? expectedContract && outputContract.toLowerCase() === expectedContract
          ? null : `UNVERIFIED ${output} token contract ${outputContract}`
        : expectedContract ? `UNVERIFIED ${output} token contract (none in memo)` : null
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
