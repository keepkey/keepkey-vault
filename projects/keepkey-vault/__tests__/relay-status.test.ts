import { describe, expect, test } from 'bun:test'
import {
  mapRelayExecutionStatus,
  relayOutboundTxid,
  shouldApplyRelayStatus,
} from '../src/shared/relay-status'

describe('Relay status mapping', () => {
  test('maps terminal Relay statuses to vault swap statuses', () => {
    expect(mapRelayExecutionStatus('success')).toBe('completed')
    expect(mapRelayExecutionStatus('failure')).toBe('failed')
    expect(mapRelayExecutionStatus('failed')).toBe('failed')
    expect(mapRelayExecutionStatus('fallback')).toBe('refunded')
    expect(mapRelayExecutionStatus('refund')).toBe('refunded')
  })

  test('maps in-flight Relay statuses without treating them as complete', () => {
    expect(mapRelayExecutionStatus('waiting')).toBe('pending')
    expect(mapRelayExecutionStatus('received')).toBe('confirming')
    expect(mapRelayExecutionStatus('depositing')).toBe('confirming')
    expect(mapRelayExecutionStatus('pending')).toBe('confirming')
    expect(mapRelayExecutionStatus('delayed')).toBe('confirming')
    expect(mapRelayExecutionStatus('submitted')).toBe('output_confirming')
    expect(mapRelayExecutionStatus('unknown')).toBeNull()
  })

  test('does not let an in-flight Relay status downgrade a richer local state', () => {
    expect(shouldApplyRelayStatus('output_detected', 'confirming')).toBe(false)
    expect(shouldApplyRelayStatus('confirming', 'pending')).toBe(false)
    expect(shouldApplyRelayStatus('pending', 'confirming')).toBe(true)
    expect(shouldApplyRelayStatus('output_confirming', 'completed')).toBe(true)
  })

  test('uses inbound tx as outbound tx for same-chain successful Relay fills', () => {
    expect(relayOutboundTxid({
      status: 'success',
      originChainId: 1,
      destinationChainId: 1,
      inTxHashes: ['0xinput'],
      txHashes: [],
    }, '0xfallback')).toBe('0xinput')
  })
})
