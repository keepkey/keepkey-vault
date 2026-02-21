/** BIP44 derivation path utilities. */

export const HARDENED = 0x80000000
export const MAX_PATH_DEPTH = 10
export const MAX_PATH_VALUE = 0x7FFFFFFF

export function pathToString(path: number[]): string {
  return "m/" + path.map(n => n >= HARDENED ? `${n - HARDENED}'` : `${n}`).join("/")
}

export function stringToPath(str: string): number[] | null {
  const s = str.trim().replace(/^m\/?/, "")
  if (!s) return null
  const parts = s.split("/")
  if (parts.length > MAX_PATH_DEPTH) return null
  const result: number[] = []
  for (const p of parts) {
    const hardened = p.endsWith("'") || p.endsWith("h") || p.endsWith("H")
    const num = parseInt(hardened ? p.slice(0, -1) : p, 10)
    if (isNaN(num) || num < 0 || num > MAX_PATH_VALUE) return null
    result.push(hardened ? num + HARDENED : num)
  }
  return result
}
