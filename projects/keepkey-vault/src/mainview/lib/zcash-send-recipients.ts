/** Address Book rows the transparent ZEC Send form may offer: transparent (t1, t3) and TEX addresses only.
 *  A unified address (u1…), including the wallet's own (KEEPKEY-180), is a shielded recipient: shielded sends
 *  go through the Zcash privacy tab. */
export function isTransparentZcashRecipient(address: string): boolean {
  return /^(t1|t3|tex1)/i.test(address.trim())
}
