/**
 * ERC-7730 signed-catalog transport: NOT_IMPLEMENTED in the pinned hdwallet.
 *
 * `ETHSignTx.erc7730` existed only on the BitHighlander/hdwallet fork line
 * (feature/erc7730-catalog-transport). The vault now pins keepkey/hdwallet
 * master, which silently drops the field, so a catalog never reaches the
 * device. Until that transport lands upstream, an attached catalog must not
 * relax any gate, label a review as ERC-7730, or be reported as
 * device-authenticated: the transaction is treated exactly as if no catalog
 * had been attached (AdvancedMode / blind-signing rules apply).
 *
 * Flip this to true only together with an hdwallet pin that sends the catalog.
 */
export const ERC7730_TRANSPORT_SUPPORTED: boolean = false

/** Remove an `erc7730` catalog the pinned transport cannot deliver, and say so. */
export function withoutUnsupportedErc7730<T>(tx: T, where: string): T {
  if (ERC7730_TRANSPORT_SUPPORTED || !tx || typeof tx !== 'object' || (tx as any).erc7730 == null) return tx
  console.warn(`[clearsign] ${where}: ERC-7730 catalog ignored (NOT_IMPLEMENTED: pinned hdwallet has no ERC-7730 transport); reviewed and gated as if no catalog were attached`)
  const { erc7730: _unsupported, ...rest } = tx as any
  return rest as T
}
