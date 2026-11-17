/** Wallet mutations stay serialized. Cached status reads must remain available
 * while a transaction is being prepared, so polling cannot time out the worker. */
export function createMoneroRequestQueue(dispatch: (value: any) => Promise<void>) {
  let pending = Promise.resolve()
  return {
    submit(value: any): Promise<void> {
      // dispatch still validates every request before accessing the service.
      // get_status is the only synchronous, in-memory observation command.
      if (value?.cmd === 'get_status') return dispatch(value)
      pending = pending.then(() => dispatch(value))
      return pending
    },
    drain(): Promise<void> { return pending },
  }
}
