/** A bridge timeout is not evidence of a disconnected network. */
export function createConnectivityState(failuresBeforeOffline = 2) {
  let online = true, failures = 0
  return {
    observe(result: boolean | undefined): boolean {
      if (result === true) { online = true; failures = 0 }
      else if (result === false && ++failures >= failuresBeforeOffline) online = false
      return online
    },
    reset() { online = true; failures = 0 },
  }
}
