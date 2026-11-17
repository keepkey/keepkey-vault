import { expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { createMoneroWatchStore } from './monero-watch-store'
const ADDRESS='44jKQv6ZKMd5ecLLmkNJGi7azgSptEq8ki7TFiat1TfLfdDQ1tQ7ZYa3cRh7X2uRwvLDjddWh97ajeyhR2seKSECQeDx1WR'
const OTHER='4Ahp23WfMrMFK3wYL2hLWQFGt87ZTeRkufS6JoQZu6MEFDokAQeGWmu9MA3GFq1yVLSJQbKJqVAn9F9DLYGpRzRAEXqAXKM'
const VIEW=new Uint8Array(32).fill(7)
function fixture() {
 const db=new Database(':memory:')
 let available=true
 const options={database:()=>db,profile:'disposable-test',key:async()=>{if(!available)throw Error('PRIVATE ERROR');return new Uint8Array(32).fill(9)}}
 return {db,options,store:createMoneroWatchStore(options),lock:()=>{available=false}}
}
test('view key survives a store restart as ciphertext; wallet, address and profile cannot substitute it',async()=>{
 const f=fixture()
 try {
  await f.store.saveWatch('seed-A',ADDRESS,VIEW)
  const row=f.db.query('SELECT ciphertext FROM monero_watch_cache').get() as {ciphertext:Uint8Array}
  expect(Buffer.from(row.ciphertext).toString('hex').includes('07'.repeat(32))).toBe(false)
  const loaded=await createMoneroWatchStore(f.options).loadWatch('seed-A',ADDRESS)
  expect(loaded).toEqual(VIEW);loaded?.fill(0)
  expect(await f.store.loadWatch('seed-B',ADDRESS)).toBeNull()
  expect(await f.store.loadWatch('seed-A',OTHER)).toBeNull()
  f.db.query('UPDATE monero_watch_cache SET scope=?').run('seed-B')
  await expect(f.store.loadWatch('seed-B',ADDRESS)).rejects.toThrow('could not be opened')
  f.db.query('UPDATE monero_watch_cache SET scope=?').run('seed-A')
  await expect(createMoneroWatchStore({...f.options,profile:'other-profile'}).loadWatch('seed-A',ADDRESS)).rejects.toThrow('could not be opened')
 } finally {f.db.close()}
})
test('locked OS storage never yields plaintext, logs credentials or saves an unencrypted fallback',async()=>{
 const f=fixture()
 try {
  await f.store.saveWatch('seed-A',ADDRESS,VIEW);f.lock()
  await expect(f.store.loadWatch('seed-A',ADDRESS)).rejects.toThrow('Monero saved access could not be opened')
  await expect(f.store.saveWatch('seed-B',ADDRESS,VIEW)).rejects.toThrow('Monero access could not be saved securely')
  expect(f.db.query('SELECT count(*) AS n FROM monero_watch_cache').get()).toEqual({n:1})
 } finally {f.db.close()}
})
test('cached receive addresses and signed image proofs stay bound to their wallet and exact outputs',async()=>{
 const f=fixture(),proofs=[{keyImage:'ab'.repeat(32),signature:'cd'.repeat(64)}]
 try {
  await f.store.saveAddress('seed-A',ADDRESS,0,ADDRESS)
  expect(await f.store.loadAddress('seed-A',ADDRESS,0)).toBe(ADDRESS)
  expect(await f.store.loadAddress('seed-B',ADDRESS,0)).toBeNull()
  await f.store.saveImages('seed-A',ADDRESS,'outputs-A',proofs)
  expect(await f.store.loadImages('seed-A',ADDRESS,'outputs-A')).toEqual(proofs)
  expect(await f.store.loadImages('seed-A',ADDRESS,'new-output')).toBeNull()
  expect(await f.store.loadImages('seed-B',ADDRESS,'outputs-A')).toBeNull()
 } finally {f.db.close()}
})

test('balance observations survive restart encrypted, retain source time and replace nonzero with authoritative zero', async () => {
 const f=fixture(),balance={balanceAtomic:'84653050000',unlockedBalanceAtomic:'84653050000',walletHeight:120,updatedAt:'2026-01-01T12:00:00.000Z',spendStateKnown:true}
 try {
  await f.store.saveBalance!('seed-A',ADDRESS,balance)
  expect(await createMoneroWatchStore(f.options).loadBalance!('seed-A')).toEqual(balance)
  expect(await f.store.loadBalance!('seed-B')).toBeNull()
  const row=f.db.query("SELECT ciphertext FROM monero_watch_cache WHERE kind='balance-v1'").get() as {ciphertext:Uint8Array}
  expect(new TextDecoder().decode(row.ciphertext)).not.toContain(balance.balanceAtomic)
  const zero={...balance,balanceAtomic:'0',unlockedBalanceAtomic:'0',walletHeight:121,updatedAt:'2026-01-01T12:02:00.000Z'}
  await f.store.saveBalance!('seed-A',ADDRESS,zero)
  expect(await createMoneroWatchStore(f.options).loadBalance!('seed-A')).toEqual(zero)
  f.db.query("UPDATE monero_watch_cache SET scope='seed-B' WHERE kind='balance-v1'").run()
  await expect(f.store.loadBalance!('seed-B')).rejects.toThrow('could not be opened')
 } finally {f.db.close()}
})
test('balance cache refuses invalid amounts, unbound primary identities and a plaintext fallback', async () => {
 const f=fixture(),balance={balanceAtomic:'12',unlockedBalanceAtomic:'7',walletHeight:120,updatedAt:'2026-01-01T12:00:00.000Z',spendStateKnown:false}
 try {
  for(const bad of [{balanceAtomic:'-1'},{unlockedBalanceAtomic:'13'},{balanceAtomic:'18446744073709551616'},{walletHeight:0},{updatedAt:'bad'},{updatedAt:'9999-01-01T00:00:00Z'}]) {
   await expect(f.store.saveBalance!('seed-A',ADDRESS,{...balance,...bad})).rejects.toThrow('Invalid')
  }
  await expect(f.store.saveBalance!('seed-A','not-an-address',balance)).rejects.toThrow('Invalid')
  f.lock()
  await expect(f.store.saveBalance!('seed-A',ADDRESS,balance)).rejects.toThrow('saved securely')
  expect(f.db.query("SELECT count(*) AS n FROM sqlite_master WHERE name='monero_watch_cache'").get()).toEqual({n:0})
 } finally {f.db.close()}
})
