import { describe, expect, test } from 'bun:test'
import { registerSwapServerCapabilities, pioneerSupportsRelaySolverDeposit, swapServerCapabilities } from '../src/shared/swap-server-capabilities'

const gateway = { paths: { '/quote': { post: { requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { relayExecutionMode: { type: 'string', enum: ['solver-deposit'] } } } } } } } } } }
const legacy = { paths: { '/quote': { post: { requestBody: { content: { 'application/json': { schema: { $ref: '#/components/schemas/QuoteRequest' } } } } } } }, components: { schemas: { QuoteRequest: { type: 'object', additionalProperties: false, properties: { sellAsset: { type: 'string' } } } } } }

describe('selected Pioneer quote capabilities', () => {
  test('legacy strict request body does not advertise the gateway extension', () => {
    expect(swapServerCapabilities(legacy).relaySolverDeposit).toBe(false)
  })
  test('accepts the advertised gateway enum and local schema references', () => {
    expect(swapServerCapabilities(gateway).relaySolverDeposit).toBe(true)
    const referenced = structuredClone(legacy) as any
    referenced.components.schemas.QuoteRequest.properties.relayExecutionMode = { type: 'string', enum: ['solver-deposit'] }
    expect(swapServerCapabilities(referenced).relaySolverDeposit).toBe(true)
  })
  test('missing, malformed or cyclic specifications never enable an extension', () => {
    for (const spec of [null, {}, { paths: { '/quote': { post: { requestBody: { $ref: '#/loop' } } } }, loop: { $ref: '#/loop' } }]) {
      expect(swapServerCapabilities(spec).relaySolverDeposit).toBe(false)
    }
    const otherMode = structuredClone(gateway)
    otherMode.paths['/quote'].post.requestBody.content['application/json'].schema.properties.relayExecutionMode.enum = ['other']
    expect(swapServerCapabilities(otherMode).relaySolverDeposit).toBe(false)
  })
  test('a new API instance cannot inherit capability from the previous server', () => {
    const oldClient = {}, newClient = {}, unknownClient = {}
    registerSwapServerCapabilities(oldClient, legacy)
    registerSwapServerCapabilities(newClient, gateway)
    expect(pioneerSupportsRelaySolverDeposit(oldClient)).toBe(false)
    expect(pioneerSupportsRelaySolverDeposit(newClient)).toBe(true)
    expect(pioneerSupportsRelaySolverDeposit(unknownClient)).toBe(false)
  })
})
