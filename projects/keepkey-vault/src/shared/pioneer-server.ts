export const DEFAULT_PIONEER_API_BASE = 'https://api.keepkey.info'

/** The in-app server selection is the sole override for the official API. */
export function resolvePioneerApiBase(savedBase: string | null | undefined): string {
  return savedBase?.trim().replace(/\/+$/, '') || DEFAULT_PIONEER_API_BASE
}

/** Saved server labels must never substitute for the actual connected URL. */
export function isActivePioneerServer(actualBase: string, serverUrl: string): boolean {
  const actual = actualBase.trim().replace(/\/+$/, '')
  return !!actual && actual === serverUrl.trim().replace(/\/+$/, '')
}
