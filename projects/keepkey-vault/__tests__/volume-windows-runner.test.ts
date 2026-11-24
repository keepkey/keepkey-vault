import { expect, test } from 'bun:test'
import { validateWindowsVolumeAction } from '../src/bun/volume-windows-runner'
import broker from '../src/bun/volume-windows-broker.ps1' with { type: 'text' }
import worker from '../src/bun/volume-windows-worker.ps1' with { type: 'text' }

const recordId = '123456789abcdef0123456789abcdef0'
const credential = Buffer.from('f'.repeat(64))
const target = 'E:\\KeepKey Volumes\\Personal.kkvolume\\payload.vhdx'
const staged = 'E:\\KeepKey Volumes\\.creating-aB3456\\payload.vhdx'

test('Windows mutation requests carry only public metadata outside the credential buffer', () => {
  expect(validateWindowsVolumeAction('create', staged, { name: 'Private files', sizeMiB: 256, recordId }, credential))
    .toEqual({ action: 'create', path: staged, name: 'Private files', sizeMiB: 256, recordId })
  expect(validateWindowsVolumeAction('unlock', target, { recordId }, credential).recordId).toBe(recordId)
  expect(validateWindowsVolumeAction('lock', target, {}).action).toBe('lock')
})

test('rejects raw devices, alternate streams, UNC, traversal and mixed action scopes', () => {
  for (const path of ['\\\\.\\PhysicalDrive0', '\\\\server\\share' + target.slice(2), target + ':secret',
    target.replace('Personal.kkvolume', 'Private\\..\\Personal.kkvolume'), target.replace('payload.vhdx', 'other.vhdx'),
    target.replace('KeepKey Volumes', 'Documents'), staged]) {
    expect(() => validateWindowsVolumeAction('unlock', path, {recordId}, credential)).toThrow()
  }
  expect(() => validateWindowsVolumeAction('create', target, { name: 'Private', sizeMiB: 256, recordId }, credential)).toThrow()
  expect(() => validateWindowsVolumeAction('create', staged, { name: 'Private', sizeMiB: 64, recordId }, credential)).toThrow()
  expect(() => validateWindowsVolumeAction('unlock', target, { recordId }, Buffer.alloc(64))).toThrow()
  expect(() => validateWindowsVolumeAction('unlock', target, {}, credential)).toThrow()
  expect(() => validateWindowsVolumeAction('lock', target, {}, credential)).toThrow()
})

test('broker authenticates process before sending credentials; worker checks broker before invoking storage functions', () => {
  expect(broker.indexOf('$peer -ne $child.Id')).toBeGreaterThan(0)
  expect(broker.indexOf('$stream.WriteLine($secret)')).toBeGreaterThan(broker.indexOf('$peer -ne $child.Id'))
  expect(broker.match(/__WORKER_DIGEST__/g)).toHaveLength(2)
  expect(worker.indexOf('$peer -ne $brokerPid')).toBeGreaterThan(0)
  expect(worker.indexOf('Invoke-KeepKeyVolumeAction $Request')).toBeGreaterThan(worker.indexOf('$peer -ne $brokerPid'))
  expect(worker).toContain('$disk.IsBoot -or $disk.IsSystem')
})
