import { describe, expect, test } from 'bun:test'
import { defiExplorerUrl, defiPositionName, defiProtocolUrl, defiManagementLinks, isNativeDefiToken } from '../src/mainview/lib/defi-position'

const address = '0x1234567890123456789012345678901234567890'

describe('DeFi detail links', () => {
  test('uses the token network even when different from the position network', () => {
    const position = { network: 'Ethereum', networkId: 'eip155:1' }
    expect(defiExplorerUrl(position, address)).toBe(`https://etherscan.io/address/${address}`)
    expect(defiExplorerUrl(position, address, 'eip155:42161')).toBe(`https://arbiscan.io/address/${address}`)
  })

  test('supports legacy network names without sending unknown networks to Ethereum', () => {
    expect(defiExplorerUrl({ network: 'Ethereum' }, address)).toContain('etherscan.io/address/')
    expect(defiExplorerUrl({ network: 'eip155:42161' }, address)).toContain('arbiscan.io/address/')
    expect(defiExplorerUrl({ network: 'unknown' }, address)).toBeUndefined()
    expect(defiExplorerUrl({ network: 'Ethereum', networkId: 'eip155:999999' }, address)).toBeUndefined()
    expect(defiExplorerUrl({ network: 'Ethereum' }, address, 'eip155:999999')).toBeUndefined()
  })

  test('rejects malformed addresses and identifies native-token placeholders', () => {
    expect(defiExplorerUrl({ network: 'Ethereum' }, 'javascript:alert(1)')).toBeUndefined()
    expect(defiExplorerUrl({ network: 'Ethereum' }, null)).toBeUndefined()
    expect(isNativeDefiToken(`0x${'0'.repeat(40)}`)).toBe(true)
    expect(isNativeDefiToken(`0x${'E'.repeat(40)}`)).toBe(true)
    expect(isNativeDefiToken(address)).toBe(false)
  })

  test('links only known protocol apps', () => {
    expect(defiProtocolUrl('AAVE-V3')).toBe('https://app.aave.com')
    expect(defiProtocolUrl('lido')).toBe('https://stake.lido.fi')
    expect(defiProtocolUrl('unknown-protocol')).toBeUndefined()
    expect(defiProtocolUrl('__proto__')).toBeUndefined()
    expect(defiProtocolUrl(null)).toBeUndefined()
  })
})

test('positions without legacy names still have a useful title', () => {
  const position = { protocol: 'lido', network: 'Ethereum', balanceUsd: 10 }
  expect(defiPositionName({ ...position, displayName: 'Lido' })).toBe('Lido')
  expect(defiPositionName({ ...position, displayName: 'Lido', name: 'stETH' })).toBe('stETH')
  expect(defiPositionName({ ...position, protocol: null })).toBe('DeFi Position')
})


describe('DeFi management destinations', () => {
 const base = { protocol: 'Aerodrome', network: 'base', networkId: 'eip155:8453', balanceUsd: 15.53 };
 const usdc = { networkId: 'eip155:8453', address: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', symbol: 'USDC' };
 test('the reported one-leg position opens the positions dashboard without inventing a pool', () => {
  expect(defiManagementLinks({...base, tokens:[usdc]})).toEqual({url:'https://aerodrome.finance/dash',protocol:'Aerodrome',poolUrl:undefined});
 });
 test('a known pair opens the official pool filter with Base selected', () => {
  const link = defiManagementLinks({...base, tokens:[usdc,{...usdc,address}]})!;
  const pool = new URL(link.poolUrl!);
  expect(pool.origin+pool.pathname).toBe('https://aerodrome.finance/pools');
  expect(pool.searchParams.get('token0')).toBe(usdc.address);
  expect(pool.searchParams.get('token1')).toBe(address);
  expect(pool.searchParams.get('chain')).toBe('8453');
  expect(pool.searchParams.has('position')).toBe(false);
 });
 test('unknown protocols, misleading names and cross-chain pairs never manufacture a management URL', () => {
  expect(defiManagementLinks({...base,protocol:'aerodrome.evil.example'})).toBeUndefined();
  expect(defiManagementLinks({...base,protocol:'__proto__'})).toBeUndefined();
  expect(defiManagementLinks({...base,networkId:'eip155:1'})).toBeUndefined();
  expect(defiManagementLinks({...base,tokens:[usdc,{...usdc,address,networkId:'eip155:1'}]})?.poolUrl).toBeUndefined();
  expect(defiManagementLinks({...base,tokens:[usdc,{...usdc,address:'javascript:alert(1)'}]})?.poolUrl).toBeUndefined();
 });
 test('known apps retain their verified registry destination', () => {
  expect(defiManagementLinks({...base,protocol:'aave-v3'})?.url).toBe('https://app.aave.com');
 });
});
