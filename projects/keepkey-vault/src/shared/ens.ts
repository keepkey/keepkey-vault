/** A name is only a lookup input. Transaction destinations remain addresses. */
export function isEnsName(value: string): boolean {
  const name = value.trim()
  // DNS names can also be imported into ENS. Only a successful forward lookup
  // establishes ENS provenance; this predicate merely identifies lookup input.
  return name.includes('.') && !/^0x/i.test(name) && !/[\s/:\\]/.test(name)
}

export interface ResolvedEnsContact {
  ensName: string
  address: string
}
