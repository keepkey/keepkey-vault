/** Durable monitoring is optional on legacy Pioneer servers. Use the resolved
 * document for the selected client rather than assuming a particular host. */
export function supportsDurableWalletMonitoring(spec: unknown): boolean {
  const paths = (spec as any)?.paths
  return ['/events', '/api/v1/events'].some(prefix =>
    paths?.[`${prefix}/watches`]?.post && paths?.[`${prefix}/replay`]?.get && paths?.[`${prefix}/ack`]?.post)
}
const durableClients = new WeakMap<object, boolean>()
export function registerPioneerEventCapabilities(client: object, spec: unknown): void {
  durableClients.set(client, supportsDurableWalletMonitoring(spec))
}
export function pioneerSupportsDurableWalletMonitoring(client: object): boolean {
  return durableClients.get(client) === true
}
