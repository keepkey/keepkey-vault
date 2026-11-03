import { expect, test } from 'bun:test'
import { supportsDurableWalletMonitoring, registerPioneerEventCapabilities, pioneerSupportsDurableWalletMonitoring } from '../src/shared/pioneer-event-capabilities'
test('legacy and incomplete server documents do not authorize durable ownership', () => {
  for (const spec of [undefined, {}, { paths: { '/events/subscribe': { post: {} } } }, { paths: { '/events/watches': { post: {} } } }]) expect(supportsDurableWalletMonitoring(spec)).toBe(false)
})
test('durable endpoints are negotiated from the resolved selected client document', () => {
  const old = {}, gateway = {}
  registerPioneerEventCapabilities(old, { paths: {} })
  for (const prefix of ['/events', '/api/v1/events']) {
    const spec = { paths: { [`${prefix}/watches`]: { post: {} }, [`${prefix}/replay`]: { get: {} }, [`${prefix}/ack`]: { post: {} } } }
    expect(supportsDurableWalletMonitoring(spec)).toBe(true); registerPioneerEventCapabilities(gateway, spec)
    expect(pioneerSupportsDurableWalletMonitoring(gateway)).toBe(true); expect(pioneerSupportsDurableWalletMonitoring(old)).toBe(false)
  }
  expect(pioneerSupportsDurableWalletMonitoring({})).toBe(false)
})
