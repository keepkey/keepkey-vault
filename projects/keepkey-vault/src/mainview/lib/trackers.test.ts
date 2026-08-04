import { describe, expect, test } from 'bun:test'
import { providerTrackerUrl } from './trackers'

describe('providerTrackerUrl', () => {
  test('labels NEAR Intents as a route tracker, not the destination network', () => {
    const tracker = providerTrackerUrl('NEAR Intents', 'source-tx', {
      nearTxHash: 'near-route-tx',
    })

    expect(tracker).toMatchObject({
      url: 'https://nearblocks.io/txns/near-route-tx',
      label: 'NEAR Intents Track',
    })
  })

  test('waits for the provider route hash before exposing the tracker', () => {
    expect(providerTrackerUrl('NEAR Intents', 'source-tx')).toBeNull()
  })
})
