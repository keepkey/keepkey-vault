/**
 * Address-poisoning check for EVM addresses: two different addresses whose
 * leading and trailing hex characters together match for 6 or more (at least
 * 2 at each end), the parts people compare by eye. Random pairs hit this
 * about once in millions; ground look-alikes are made to.
 */
export function looksAlike(a: string, b: string): boolean {
  const x = a.toLowerCase().replace(/^0x/, ''), y = b.toLowerCase().replace(/^0x/, '')
  if (x === y || x.length !== 40 || y.length !== 40) return false
  let prefix = 0, suffix = 0
  while (prefix < 40 && x[prefix] === y[prefix]) prefix++
  while (suffix < 40 && x[39 - suffix] === y[39 - suffix]) suffix++
  return prefix >= 2 && suffix >= 2 && prefix + suffix >= 6
}

export function lookalikeOf<T extends { address: string }>(address: string, known: T[]): T | undefined {
  return known.find(k => looksAlike(address, k.address))
}
