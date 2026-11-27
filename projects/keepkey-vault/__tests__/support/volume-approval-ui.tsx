import assert from 'node:assert/strict'
import { JSDOM } from 'jsdom'
import { mock } from 'bun:test'
import type { ConnectedVolume, VolumeDeviceStatus, VolumeImage } from '../../src/shared/volumes'

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://localhost/' })
Object.defineProperty(dom.window.navigator, 'platform', { value: 'MacIntel' })
for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'Node', 'Event', 'CustomEvent', 'MouseEvent', 'getComputedStyle', 'localStorage']) {
  Object.defineProperty(globalThis, key, { configurable: true, value: key === 'window' ? dom.window : (dom.window as any)[key] })
}
;(window as any).matchMedia = () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} })
;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

let device: VolumeDeviceStatus = { available: false, reason: 'disconnected' }
let deviceChange: (value: unknown) => void
let reportProgress: (value: unknown) => void
let unavailableReason: string | undefined
const writable: ConnectedVolume = { id: 'disk7s1', uuid: 'fixture-id', name: 'Practice USB',
  format: 'exFAT', mountPoint: '/Volumes/Practice USB', writable: true,
  availableBytes: 2e9, encrypted: false, locked: false }
const partitions: ConnectedVolume[] = [
  writable,
  { ...writable, name: 'Second partition', id: 'disk7s5', uuid: 'second-id', mountPoint: '/Volumes/Second' },
  { ...writable, name: 'Read only', id: 'disk7s2', uuid: 'read-only', writable: false },
  { ...writable, name: 'Offline', id: 'disk7s3', uuid: 'offline', mountPoint: null },
  { ...writable, name: 'Unknown ID', id: 'disk7s4', uuid: null },
]
const images: VolumeImage[] = [
  { id: 'hardware', name: 'Hardware', state: 'locked', unlockMethod: 'keepkey' },
  { id: 'legacy', name: 'Legacy', state: 'locked', unlockMethod: 'password' },
  { id: 'mounted', name: 'Mounted', state: 'mounted', unlockMethod: 'keepkey' },
]
let approve: () => void
let requested = ''
let operationId: string | undefined
const opened: string[] = []
let finderFailed = false
let failNextImageScan = false
const text = (value: string, fields: Record<string, string> = {}) =>
  value.replace(/{{(\w+)}}/g, (original, name: string) => fields[name] ?? original)
mock.module('../../src/mainview/i18n/ui', () => ({ useUiTranslation: () => text }))
mock.module('../../src/mainview/lib/rpc', () => ({
  onRpcMessage: (event: string, listener: typeof deviceChange) => {
    if (event === 'device-state') deviceChange = listener
    if (event === 'volume-progress') reportProgress = listener
    return () => {}
  },
  rpcRequest: async (method: string, params?: { id: string; operationId?: string }) => {
    if (method === 'getVolumeInventory') return {
      supported: true, unavailableReason, drives: [{ id: 'disk7', name: 'USB drive', sizeBytes: 2e10, volumes: partitions }],
      local: { name: 'Practice', totalBytes: 1e10, availableBytes: 1e9, fileVault: 'on' },
    }
    if (method === 'listVolumeImages') {
      if (failNextImageScan) { failNextImageScan = false; throw new Error('Inventory temporarily unavailable') }
      return structuredClone(images)
    }
    if (method === 'volumeDeviceStatus') return device
    if (method === 'unlockVolumeImage') {
      requested = params!.id
      operationId = params!.operationId
      await new Promise<void>(resolve => { approve = resolve })
      images.find(image => image.id === requested)!.state = 'mounted'
      return
    }
    if (method === 'openVolumeImage') {
      assert.equal(images.find(image => image.id === params!.id)?.state, 'mounted')
      opened.push(params!.id)
      if (params!.id === 'hardware' && !finderFailed) {
        finderFailed = true
        failNextImageScan = true
        throw new Error('Finder temporarily unavailable')
      }
      return
    }
    if (method === 'lockVolumeImage' && params!.id === 'external-mounted') {
      partitions.splice(0)
      images.splice(images.findIndex(image => image.id === params!.id), 1)
      throw new Error('USB disconnected before lock could be confirmed.')
    }
    throw new Error('Unexpected RPC ' + method)
  },
}))

const { act } = await import('react')
const { createRoot } = await import('react-dom/client')
const { ChakraProvider, defaultSystem } = await import('@chakra-ui/react')
const { VolumesView } = await import('../../src/mainview/components/VolumesView')
const container = document.querySelector('#root')!
const root = createRoot(container)
const button = (label: string, scope = container) => [...scope.querySelectorAll('button')].find(b => b.textContent === label)
await act(async () => { root.render(<ChakraProvider value={defaultSystem}><VolumesView /></ChakraProvider>) })

assert.equal(button('Unlock with KeepKey')?.disabled, true)
assert.equal(button('Unlock')?.disabled, false)
assert.equal(button('Lock')?.disabled, false)
assert.equal(button('Open protected volume')?.disabled, false)
assert.equal(button('Open drive')?.disabled, false)
await act(async () => { button('Unlock')!.click() })
assert.equal(requested, 'legacy')
assert.equal(operationId, undefined)
assert.match(container.textContent!, /system password prompt/)
assert.doesNotMatch(container.textContent!, /Encrypt Key Value/)
await act(async () => { approve() })
assert.deepEqual(opened, ['legacy'])

device = { available: true, reason: 'ready' }
await act(async () => { deviceChange({ state: 'ready' }) })
const group = (name: string) => {
  const location = container.querySelector(`[role="group"][aria-label="${name}"]`)
  assert.ok(location, 'Missing storage location ' + name)
  return location
}
assert.equal([...container.querySelectorAll('button')].filter(b => b.textContent === 'Create volume').length, 3)
assert.ok(button('Create volume', group('Practice')))
for (const partition of partitions.slice(2)) assert.equal(button('Create volume', group(partition.name)), undefined)
const usb = group(writable.name)
await act(async () => { button('Create volume', usb)!.click() })
assert.ok(usb.querySelector('form'))
assert.equal(usb.querySelector('select'), null)
const second = group('Second partition')
await act(async () => { button('Create volume', second)!.click() })
assert.equal(usb.querySelector('form'), null)
assert.match(second.querySelector('form')!.textContent!, /\/Volumes\/Second/)
await act(async () => { button('Cancel', second)!.click() })
await act(async () => { button('Unlock with KeepKey')!.click() })
assert.equal(requested, 'hardware')
assert.ok(operationId)
assert.match(container.textContent!, /Waiting for KeepKey approval/)
const keyLabel = 'KeepKey Volume v1 0123456789abcdef0123456789abcdef'
await act(async () => { reportProgress({ operationId: 'previous', phase: 'approval', keyLabel }) })
assert.doesNotMatch(container.textContent!, /Encrypt Key Value/)
await act(async () => { reportProgress({ operationId, phase: 'approval', keyLabel }) })
const prompt = group('Hardware').querySelector('[role="status"]')!
assert.match(prompt.textContent!, /To unlock Hardware, confirm the matching prompt on your KeepKey\./)
assert.ok(prompt.textContent!.includes('Encrypt Key Value'))
assert.ok(prompt.textContent!.includes(keyLabel))
await act(async () => { reportProgress({ operationId, phase: 'unlocking' }) })
assert.match(container.textContent!, /Unlocking volume/)
await act(async () => { reportProgress({ operationId, phase: 'approval', keyLabel }) })
assert.doesNotMatch(container.textContent!, /Encrypt Key Value/)
assert.equal(container.querySelector('input[type=password]'), null)
await act(async () => { approve() })
assert.deepEqual(opened, ['legacy', 'hardware'])
// Unlock was confirmed even though launching Finder and the next refresh both failed.
const hardware = group('Hardware')
assert.match(hardware.textContent!, /Unlocked/)
assert.match(hardware.querySelector('[role="alert"]')!.textContent!, /volume unlocked/i)
assert.equal(button('Unlock with KeepKey', hardware), undefined)
await act(async () => { button('Open protected volume', hardware)!.click() })
assert.deepEqual(opened, ['legacy', 'hardware', 'hardware'])
images.find(image => image.id === 'hardware')!.state = 'locked'
await act(async () => { button('Refresh')!.click() })
device = { available: false, reason: 'unsupported' }
await act(async () => { deviceChange({ state: 'ready' }) })
assert.equal(button('Unlock with KeepKey')?.disabled, true)
assert.match(container.textContent!, /multi-chain KeepKey firmware/)
assert.equal(button('Lock')?.disabled, false)

images.push({ id: 'external-mounted', name: 'External protected volume', state: 'mounted',
  unlockMethod: 'keepkey', destination: { id: writable.id, uuid: writable.uuid! } })
await act(async () => { button('Refresh')!.click() })
await act(async () => { button('Lock', group('External protected volume'))!.click() })
assert.equal(container.querySelector('[role="group"][aria-label="External protected volume"]'), null)
assert.equal(container.querySelector('[role="group"][aria-label="Practice USB"]'), null)
assert.equal(container.querySelector('[role="alert"]')!.textContent, 'USB disconnected before lock could be confirmed.')

unavailableReason = 'Native image support is unavailable'
await act(async () => { button('Refresh')!.click() })
assert.match(container.textContent!, /Practice/)
assert.match(container.textContent!, /Connected drives/)
assert.match(container.textContent!, /Native image support is unavailable/)
assert.equal(button('Create volume'), undefined)
await act(async () => { root.unmount() })
