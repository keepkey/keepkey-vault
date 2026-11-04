/** The selected account type controls both derivation and device review. */
export function selectedReceiveScriptType(defaultType: string | undefined, btcType?: string, utxoType?: string): string | undefined {
  return btcType || utxoType || defaultType
}

/** Device requests cannot be cancelled, but superseded replies must never
 * replace the address or xpub for the current account selection. */
export function createLatestReceiveRequest() {
  let generation = 0
  return {
    invalidate() { generation++ },
    async run<T>(request: () => Promise<T>, handlers: {
      pending?: () => void
      resolved: (value: T) => void
      rejected: (error: unknown) => void
      settled?: () => void
    }): Promise<void> {
      const current = ++generation
      handlers.pending?.()
      try {
        const value = await request()
        if (current === generation) handlers.resolved(value)
      } catch (error) {
        if (current === generation) handlers.rejected(error)
      } finally {
        if (current === generation) handlers.settled?.()
      }
    },
  }
}
