export type ProviderRefreshReason = 'wallet-open' | 'manual' | 'automatic' | 'focus' | 'degraded-retry' | 'swap-reconcile'
export interface ProviderUsageStatus {
 provider: string
 state: 'normal' | 'warning' | 'limited'
 reason?: 'budget'|'upstream'
 apiBase: string
 windows: Array<{kind:string;used:number;limit:number}>
}

/** Automatic chain refreshes must not trigger a paid portfolio discovery read. */
export function paidProviderRefreshOptions(reason: ProviderRefreshReason) {
 return {
  refreshReason: reason,
  providerRefreshPolicy: reason === 'wallet-open' || reason === 'manual' ? 'on-demand' as const : 'cache-only' as const,
 }
}

/** A wallet-wide EVM history snapshot serves every chain in this session. */
export function createWalletHistoryRefreshPolicy(){
 let scope='',opened=false
 return (walletScope:string,networkId:string):ProviderRefreshReason=>{
  if(scope!==walletScope){scope=walletScope;opened=false}
  if(!networkId.startsWith('eip155:'))return 'automatic'
  if(opened)return 'automatic'
  opened=true
  return 'wallet-open'
 }
}

export function supportsCachedProviderRefresh(spec:any,operationId='GetPortfolioBalances'):boolean{
 for(const path of Object.values(spec?.paths || {}) as any[]){
  const op=path?.post
  if(op?.operationId!==operationId)continue
  let schema=op.requestBody?.content?.['application/json']?.schema || op.parameters?.find((p:any)=>p.in==='body')?.schema
  if(typeof schema?.$ref==='string'&&schema.$ref.startsWith('#/'))schema=schema.$ref.slice(2).split('/').reduce((value:any,key:string)=>value?.[key],spec)
  return !!schema?.properties?.providerRefreshPolicy
 }
 return false
}

/** Older servers may reject new body fields. Manual reads stay compatible;
 * automatic reads fail before networking if cached-only semantics are absent. */
export function prepareProviderRequestBody(body:any,spec:any,operationId='GetPortfolioBalances'){
 if(!body?.providerRefreshPolicy||supportsCachedProviderRefresh(spec,operationId))return body
 if(body.providerRefreshPolicy==='cache-only' && (operationId!=='GetTransactionHistory'||body.queries?.some((row:any)=>String(row.caip).startsWith('eip155:'))))throw new Error('Automatic discovery refresh is disabled for this server; cached balances are retained')
 const {providerRefreshPolicy:_policy,refreshReason:_reason,...legacy}=body
 return legacy
}
