import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createMoneroNodeManager } from './monero-node'
import { moneroNodeMode, moneroNodeProgress } from '../shared/monero-node'

const cleanup: Array<() => Promise<void> | void> = []
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn() })
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'vault-node-test-'))
  cleanup.push(() => rmSync(root, { recursive: true, force: true }))
  const server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response('occupied') })
  const port = server.port!; server.stop(true)
  const script = join(root, 'daemon.ts'), binary = join(root, 'daemon')
  writeFileSync(script, `import {writeFileSync} from 'node:fs';
const args=process.argv.slice(2); const value=(key)=>args[args.indexOf(key)+1];
writeFileSync(${JSON.stringify(join(root, 'args.json'))},JSON.stringify(args));
const server=Bun.serve({hostname:value('--rpc-bind-ip'),port:Number(value('--rpc-bind-port')),fetch:()=>Response.json({result:{status:'OK',nettype:'mainnet',height:200,target_height:200,synchronized:true,busy_syncing:false,outgoing_connections_count:3}})});
process.on('SIGTERM',()=>{server.stop(true);process.exit(0)});`)
  const quote = (value: string) => "'" + value.replace(/'/g, "'\\''") + "'"
  writeFileSync(binary, '#!/bin/sh\nexec ' + quote(process.execPath) + ' ' + quote(script) + ' "$@"\n', { mode: 0o755 })
  let freeBytes = 10000, diskMissing = false
  const options = { stateFile: join(root, 'state.json'), binary: async () => binary, port, reserveBytes: 1000,
    estimatedBytes: 4000, pollMs: 60000, stopWaitMs: 3000,
    // The fixture's shell wrapper execs Bun; a real monerod keeps its launch argv.
    processCommand: (pid: number) => pid === process.pid ? 'unrelated actual process' : JSON.parse(readFileSync(join(root, 'state.json'), 'utf8')).command.join(' '),
    disk: () => { if (diskMissing) throw new Error('Storage drive missing'); return { freeBytes, device: 42 } } }
  const manager = createMoneroNodeManager(options)
  cleanup.push(async () => { try { await manager.stop() } finally { manager.dispose() } })
  await manager.configure(join(root, 'chain'))
  return { root, port, manager, options, space: (value: number) => { freeBytes = value }, low: () => { freeBytes = 500 }, missing: () => { diskMissing = true } }
}
async function ready(manager: ReturnType<typeof createMoneroNodeManager>) {
  for (let i = 0; i < 100; i++) { const next = await manager.status(); if (next.state === 'ready') return next; await delay(20) }
  throw new Error('Fixture node did not become ready')
}

test('own node is preferred for new installs; deliberate remote settings survive upgrades', () => {
  expect(moneroNodeMode(null, null)).toBe('local')
  expect(moneroNodeMode(null, 'http://127.0.0.1:18081')).toBe('local')
  expect(moneroNodeMode(null, 'https://my-node.example')).toBe('remote')
  expect(moneroNodeMode('remote', null)).toBe('remote')
  expect(moneroNodeMode('local', 'https://my-node.example')).toBe('local')
})
test('height ratio never implies completion without the daemon confirming sync', () => {
  const info = { status: 'OK', nettype: 'mainnet', height: 200, target_height: 0, synchronized: false }
  expect(moneroNodeProgress(info)).toMatchObject({ state: 'syncing', height: 200, targetHeight: null, percent: null })
  expect(moneroNodeProgress({ ...info, target_height: 200 })).toMatchObject({ state: 'syncing', percent: 99.9 })
  expect(moneroNodeProgress({ ...info, synchronized: true })).toMatchObject({ state: 'ready', percent: 100 })
  expect(() => moneroNodeProgress({ ...info, nettype: 'fakechain' })).toThrow('mainnet')
})
describe('managed process and storage', () => {
  test('does not start with insufficient capacity or accept relative storage paths', async () => {
    const f = await fixture(); f.low()
    await expect(f.manager.start()).rejects.toThrow('Not enough free space')
    await expect(f.manager.configure('relative/chain')).rejects.toThrow('absolute')
    expect(JSON.parse(readFileSync(f.options.stateFile, 'utf8')).pid).toBeUndefined()
  })
  test('does not replace a process already using its RPC port', async () => {
    const f = await fixture()
    const server = Bun.serve({ hostname: '127.0.0.1', port: f.port, fetch: () => new Response('other') })
    cleanup.push(() => server.stop(true))
    await expect(f.manager.start()).rejects.toThrow('already in use')
    expect(await (await fetch(`http://127.0.0.1:${f.port}`)).text()).toBe('other')
  })
  test('unrelated files do not count as downloaded blockchain when checking capacity', async () => {
    const f = await fixture()
    await f.manager.configure(f.root)
    writeFileSync(join(f.root, 'unrelated.dat'), new Uint8Array(10000))
    f.space(3000)
    await expect(f.manager.start()).rejects.toThrow('Not enough free space')
  })
  test('starts once, uses restricted loopback RPC and pruning, then stops without retaining a ready state', async () => {
    const f = await fixture()
    await Promise.all([f.manager.start(), f.manager.start()])
    expect(await ready(f.manager)).toMatchObject({ height: 200, peers: 3, pruned: true })
    const args: string[] = JSON.parse(readFileSync(join(f.root, 'args.json'), 'utf8'))
    expect(args).toContain('--prune-blockchain'); expect(args).toContain('--sync-pruned-blocks'); expect(args).toContain('--restricted-rpc')
    expect(args[args.indexOf('--rpc-bind-ip') + 1]).toBe('127.0.0.1')
    await expect(f.manager.configure(join(f.root, 'other'))).rejects.toThrow('Stop the node')
    expect((await f.manager.stop()).state).toBe('stopped')
  })
  test('a new app instance can identify and stop its daemon; stale PID records cannot stop unrelated processes', async () => {
    const f = await fixture(); await f.manager.start(); await ready(f.manager); f.manager.dispose()
    const replacement = createMoneroNodeManager(f.options)
    cleanup.push(() => replacement.dispose())
    expect((await replacement.status()).state).toBe('ready')
    expect((await replacement.stop()).state).toBe('stopped')
    writeFileSync(f.options.stateFile, JSON.stringify({ dataDir: join(f.root, 'chain'), pid: process.pid, command: ['unrelated'], configPath: '/not-ours' }))
    const stale = createMoneroNodeManager(f.options); cleanup.push(() => stale.dispose())
    expect((await stale.status()).state).toBe('error')
    await expect(stale.stop()).rejects.toThrow('ownership')
  })
  test.each(['low', 'missing'] as const)('%s storage stops only the owned daemon and retains the reason', async reason => {
    const f = await fixture(); await f.manager.start(); await ready(f.manager); f[reason]()
    expect((await f.manager.status()).state).toBe('stopping')
    await delay(100)
    const stopped = await f.manager.status()
    expect(stopped.state).toBe('stopped')
    expect(stopped.error).toContain(reason === 'low' ? '25 GiB' : 'storage drive')
  })
})
