/** Deterministic keys for prose extracted from UI components. */
export function messageKey(text: string): string {
  let hash = 2166136261
  for (let index = 0; index < text.length; index++) hash = Math.imul(hash ^ text.charCodeAt(index), 16777619)
  return `m${(hash >>> 0).toString(16)}`
}
