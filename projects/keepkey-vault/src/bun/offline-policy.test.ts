import { assertOnline, isOfflineNetworkRoute } from './offline-policy'

let pass = 0
function ok(value: boolean, label: string) {
  if (!value) throw new Error(`FAIL ${label}`)
  pass++
}

for (const path of [
  '/api/v2/portfolio/balances',
  '/api/v2/tx/broadcast',
  '/api/v2/swap/quote',
  '/api/v2/sweep/scan',
]) ok(isOfflineNetworkRoute(path, 'POST'), `${path} is blocked offline`)

ok(isOfflineNetworkRoute('/api/v1/activity/rebuild', 'POST'), 'activity rebuild blocked offline')
ok(!isOfflineNetworkRoute('/api/v1/activity/rebuild', 'GET'), 'activity read is not classified as a network mutation')
ok(!isOfflineNetworkRoute('/api/v2/devices', 'GET'), 'device inventory remains local')
ok(!isOfflineNetworkRoute('/api/v1/btc/sign-transaction', 'POST'), 'raw device signing remains available')

assertOnline(false, 'test')
pass++
let threw = false
try { assertOnline(true, 'test') } catch (error: any) { threw = /OFFLINE.*test/.test(error.message) }
ok(threw, 'offline operation throws a typed, actionable error')

console.log(`[offline-policy] OK — ${pass} assertions passed`)
