/** Calls with the same key while one is in flight share its promise. */
export function singleFlight<T>() {
  const inFlight = new Map<string, Promise<T>>()
  return (key: string, work: () => Promise<T>): Promise<T> => {
    const running = inFlight.get(key)
    if (running) return running
    const started = work().finally(() => inFlight.delete(key))
    inFlight.set(key, started)
    return started
  }
}
