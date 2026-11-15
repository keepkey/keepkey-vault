import {expect,test} from 'bun:test'
import {paidProviderRefreshOptions,createWalletHistoryRefreshPolicy,prepareProviderRequestBody} from '../src/shared/provider-refresh'

test('only wallet opening and manual actions authorize paid provider discovery',()=>{
 for(const reason of ['wallet-open','manual'] as const)expect(paidProviderRefreshOptions(reason).providerRefreshPolicy).toBe('on-demand')
 for(const reason of ['automatic','focus','degraded-retry','swap-reconcile'] as const)expect(paidProviderRefreshOptions(reason).providerRefreshPolicy).toBe('cache-only')
})

test('EVM history opens once per wallet session instead of once per chain or retry',()=>{
 const reason=createWalletHistoryRefreshPolicy()
 expect(reason('wallet-a:1','bip122:fixture')).toBe('automatic')
 expect(reason('wallet-a:1','eip155:1')).toBe('wallet-open')
 expect(reason('wallet-a:1','eip155:8453')).toBe('automatic')
 expect(reason('wallet-a:1','eip155:1')).toBe('automatic')
 expect(reason('wallet-a:2','eip155:1')).toBe('wallet-open')
})

test('old providers cannot turn automatic retries into paid requests and manual reads keep their old body',()=>{
 const body={pubkeys:[{caip:'eip155:1/slip44:60',pubkey:'fixture'}],...paidProviderRefreshOptions('manual')}
 expect(prepareProviderRequestBody(body,{})).toEqual({pubkeys:body.pubkeys})
 expect(()=>prepareProviderRequestBody({...body,...paidProviderRefreshOptions('automatic')},{})).toThrow('cached balances')
 const spec={paths:{'/portfolio':{post:{operationId:'GetPortfolioBalances',requestBody:{content:{'application/json':{schema:{properties:{providerRefreshPolicy:{type:'string'}}}}}}}}}}
 const automatic={...body,...paidProviderRefreshOptions('automatic')}
 expect(prepareProviderRequestBody(automatic,spec)).toBe(automatic)
})

 test('legacy chain history keeps native RPC behavior while unsupported automatic EVM discovery fails closed',()=>{
  const automatic={queries:[{caip:'bip122:fixture/slip44:0',pubkey:'fixture'}],...paidProviderRefreshOptions('automatic')}
  expect(prepareProviderRequestBody(automatic,{},'GetTransactionHistory')).toEqual({queries:automatic.queries})
  expect(()=>prepareProviderRequestBody({...automatic,queries:[{caip:'eip155:1/slip44:60',pubkey:'fixture'}]},{},'GetTransactionHistory')).toThrow('cached balances')
 })
