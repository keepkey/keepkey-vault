/** A shield broadcast but not yet found by a scan: its transparent coins are
 *  already spent, so its value is shown as pending until the note appears. */
export interface PendingShield { txid: string; amountZat: number; afterHeight: number; at: number }

// ponytail: wall-clock expiry; a shield unmined after 2 h has passed its
// expiry height (~40 blocks) and its coins are transparent again.
export const PENDING_SHIELD_MAX_AGE_MS = 2 * 60 * 60 * 1000

/** Shields still unseen. A shield pays its whole amount into one note, so a
 *  note of that exact value in a later block is the shield landing (scanned
 *  notes may not carry a txid). Each note settles at most one shield. */
export function unresolvedShields(
  shields: PendingShield[],
  notes: { value: number | string; block_height: number | string }[],
  now: number,
): PendingShield[] {
  const used = new Set<object>()
  return shields.filter(s => {
    if (now - s.at >= PENDING_SHIELD_MAX_AGE_MS) return false
    const note = notes.find(n => !used.has(n) && Number(n.value) === s.amountZat && Number(n.block_height) > s.afterHeight)
    if (note) used.add(note)
    return !note
  })
}
