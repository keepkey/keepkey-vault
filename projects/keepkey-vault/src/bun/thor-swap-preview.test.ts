import { expect, test } from 'bun:test'
import { thorDepositFields } from './thor-swap-preview'
import { decodeCalldata, firmwareClearSigns } from './calldata-decoder'

const pad = (n: bigint) => n.toString(16).padStart(64, '0')
const addr = (a: string) => a.slice(2).toLowerCase().padStart(64, '0')
const vault = '0xed23d1bf7ac2ce8b4c09a090e252ea6ee5145e6e'
const destination = '0x9f5f2e605863dcD9CCB98BC104E10fD551d8E9'
const memo = `=:ETH.USDT-0xDAC17F958D2EE523A2206206994597C13D831EC7:${destination}:8309278435:keep:30`
const bytes = Buffer.from(memo, 'utf8')
const calldata = '0x44bc937b' + addr(vault) + pad(0n) + pad(45737200000000003n)
  + pad(160n) + pad(1789280611n) + pad(BigInt(bytes.length))
  + bytes.toString('hex').padEnd(Math.ceil(bytes.length / 32) * 64, '0')

test('canonical historical-style Thorchain swap shows terms in human units', () => {
  const fields = thorDepositFields(calldata, 1)
  expect(fields?.find(f => f.name === 'Action')?.value).toContain('Swap 0.045737200000000003 ETH for at least 83.09278435 USDT on ETH via THORChain')
  expect(fields?.find(f => f.name === 'Output chain')?.value).toBe('ETH')
  expect(fields?.find(f => f.name === 'Output destination')?.value).toBe(destination)
  expect(fields?.find(f => f.name === 'Affiliate fee')?.value).toBe('0.30% (30 bps) to keep')
  expect(fields?.find(f => f.name === 'Memo (exact)')?.value).toBe(memo)
})

test('Base router decodes in Base ETH units but is not firmware-native (thortx.c knows 1 + 43114)', () => {
  const router = '0x00dc6100103bc402d490aee3f9a5560cbd91f1d4'
  expect(firmwareClearSigns(router, calldata, 43114)).toBe(true)
  expect(firmwareClearSigns(router, calldata, 8453)).toBe(false)
  expect(firmwareClearSigns(router, calldata, 1)).toBe(false)
  expect(firmwareClearSigns(router, calldata, 56)).toBe(false)
  const fields = thorDepositFields(calldata, 8453)
  expect(fields?.find(f => f.name === 'Input amount')?.value).toContain('ETH on Base')
})

test('noncanonical ABI cannot gain a reassuring swap summary', () => {
  expect(thorDepositFields(calldata + '00', 1)).toBeNull()
  expect(thorDepositFields(calldata.replace(pad(160n), pad(192n)), 1)).toBeNull()
  expect(thorDepositFields(calldata.slice(0, -2) + 'ff', 1)).toBeNull()
})

test('scientific memo limit reveals the effective one-USDT minimum', () => {
  const changedMemo = memo.replace('8309278435', '1e8')
  const changedBytes = Buffer.from(changedMemo, 'utf8')
  const changed = calldata.slice(0, 10 + 5 * 64) + pad(BigInt(changedBytes.length))
    + changedBytes.toString('hex').padEnd(Math.ceil(changedBytes.length / 32) * 64, '0')
  expect(thorDepositFields(changed, 1)?.find(f => f.name === 'Minimum output')?.value).toBe('1 USDT')
})

test('streaming suffix exposes both minimum and swap schedule', () => {
  const changedMemo = memo.replace('8309278435', '1e8/1/0')
  const changedBytes = Buffer.from(changedMemo, 'utf8')
  const changed = calldata.slice(0, 10 + 5 * 64) + pad(BigInt(changedBytes.length))
    + changedBytes.toString('hex').padEnd(Math.ceil(changedBytes.length / 32) * 64, '0')
  const fields = thorDepositFields(changed, 1)
  expect(fields?.find(f => f.name === 'Minimum output')?.value).toBe('1 USDT')
  expect(fields?.find(f => f.name === 'Streaming')?.value).toBe('Every 1 block; network chooses swap count')
})

test('a familiar stablecoin ticker with a different contract is explicitly unverified', () => {
  const trusted = memo.replace('USDT-0xDAC17F958D2EE523A2206206994597C13D831EC7', 'USDC-0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48')
  const fake = trusted.replace('0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', '0x1111111111111111111111111111111111111111')
  const encode = (m: string) => {
    const b = Buffer.from(m, 'utf8')
    return calldata.slice(0, 10 + 5 * 64) + pad(BigInt(b.length))
      + b.toString('hex').padEnd(Math.ceil(b.length / 32) * 64, '0')
  }
  expect(thorDepositFields(encode(trusted), 1)?.find(f => f.name === 'Token warning')).toBeUndefined()
  const fields = thorDepositFields(encode(fake), 1)
  expect(fields?.find(f => f.name === 'Token warning')?.value).toContain('UNVERIFIED USDC token contract')
  expect(fields?.find(f => f.name === 'Action')?.value).toContain('UNVERIFIED USDC token contract')
  const obscure = trusted.replace('USDC-0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', 'MYSTERY-0x2222222222222222222222222222222222222222')
  expect(thorDepositFields(encode(obscure), 1)?.find(f => f.name === 'Token warning')?.value)
    .toContain('UNVERIFIED MYSTERY token contract')
})

test('a cross-chain Base USDC swap names the destination chain and checks its contract', () => {
  const baseMemo = memo.replace('ETH.USDT-0xDAC17F958D2EE523A2206206994597C13D831EC7',
    'BASE.USDC-0x833589fcD6eDb6E08f4c7C32D4f71b54bdA02913')
  const b = Buffer.from(baseMemo, 'utf8')
  const data = calldata.slice(0, 10 + 5 * 64) + pad(BigInt(b.length))
    + b.toString('hex').padEnd(Math.ceil(b.length / 32) * 64, '0')
  const fields = thorDepositFields(data, 1)
  expect(fields?.find(f => f.name === 'Output chain')?.value).toBe('BASE')
  expect(fields?.find(f => f.name === 'Action')?.value).toContain('USDC on BASE via THORChain')
  expect(fields?.find(f => f.name === 'Token warning')).toBeUndefined()
})

test('router identity distinguishes Maya, Thorchain and an unknown destination', async () => {
  const mayaMemo = `=:MAYA.CACAO:maya1example::keep:30`
  const b = Buffer.from(mayaMemo, 'utf8')
  const mayaData = calldata.slice(0, 10 + 4 * 64) + pad(1n) + pad(BigInt(b.length))
    + b.toString('hex').padEnd(Math.ceil(b.length / 32) * 64, '0')
  const maya = await decodeCalldata('0xe3985E6b61b814F7Cdb188766562ba71b446B46d', mayaData, 1)
  expect(maya?.dappName).toBe('Mayachain')
  expect(maya?.fields.find(f => f.name === 'Action')?.value).toContain('NO MINIMUM on MAYA via Mayachain — EXPIRED')
  expect(maya?.fields.find(f => f.name === 'Expiry')?.value).toContain('EXPIRED')
  expect(maya?.fields.find(f => f.name === 'Minimum output')?.value).toBe('No minimum specified')
  expect((await decodeCalldata('0xd37bbe5744d730a1d98d8dc97c42f0ca46ad7146', calldata, 1))?.dappName).toBe('THORChain')
  expect((await decodeCalldata('0x1111111111111111111111111111111111111111', mayaData, 1))?.source).toBe('none')
  expect(firmwareClearSigns('0xe3985E6b61b814F7Cdb188766562ba71b446B46d', mayaData, 1)).toBe(false)
  expect(firmwareClearSigns('0xd89dce570de35a6f42d3bca7dba50a6d89bfc2a2', mayaData, 1)).toBe(true)
  expect(firmwareClearSigns('0xd89dce570de35a6f42d3bca7dba50a6d89bfc2a2', mayaData, 8453)).toBe(false)
  expect(firmwareClearSigns('0xd37bbe5744d730a1d98d8dc97c42f0ca46ad7146', calldata)).toBe(false)
})

test('pinned Ethereum USDT input is shown in six-decimal human units', () => {
  const withInput = (token: string) => calldata.slice(0, 10 + 64)
    + addr(token) + pad(999999999n) + calldata.slice(10 + 3 * 64)
  const usdt = thorDepositFields(withInput('0xdac17f958d2ee523a2206206994597c13d831ec7'), 1)
  expect(usdt?.find(f => f.name === 'Input amount')?.value).toBe('999.999999 USDT')
  expect(usdt?.find(f => f.name === 'Input token')?.value).toContain('Verified Ethereum USDT')
  const unknown = thorDepositFields(withInput('0x1111111111111111111111111111111111111111'), 1)
  expect(unknown?.find(f => f.name === 'Input amount')?.value).toBe('999999999 raw token units')
  expect(unknown?.find(f => f.name === 'Input token warning')?.value).toContain('UNVERIFIED input token contract')
})
