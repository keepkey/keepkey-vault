/** Quote extensions must be advertised by the selected API, independently of
 * firmware support. Legacy Pioneer rejects additional request properties. */
export interface SwapServerCapabilities { relaySolverDeposit: boolean }

function resolveLocalRef(spec: any, value: any): any {
  for (let depth = 0; value?.$ref && depth < 8; depth++) {
    if (typeof value.$ref !== 'string' || !value.$ref.startsWith('#/')) return undefined
    value = value.$ref.slice(2).split('/').reduce((node: any, key: string) => node?.[key.replace(/~1/g, '/').replace(/~0/g, '~')], spec)
  }
  return value?.$ref ? undefined : value
}

export function swapServerCapabilities(spec: unknown): SwapServerCapabilities {
  const document = spec as any
  const operation = document?.paths?.['/quote']?.post ?? document?.paths?.['/api/v1/quote']?.post
  const request = resolveLocalRef(document, operation?.requestBody)
  const schema = resolveLocalRef(document, request?.content?.['application/json']?.schema)
  const mode = resolveLocalRef(document, schema?.properties?.relayExecutionMode)
  return { relaySolverDeposit: mode?.type === 'string' && Array.isArray(mode?.enum) && mode.enum.includes('solver-deposit') }
}

const clientCapabilities = new WeakMap<object, SwapServerCapabilities>()

export function registerSwapServerCapabilities(client: object, spec: unknown): void {
  clientCapabilities.set(client, swapServerCapabilities(spec))
}

export function pioneerSupportsRelaySolverDeposit(client: object): boolean {
  return clientCapabilities.get(client)?.relaySolverDeposit === true
}
