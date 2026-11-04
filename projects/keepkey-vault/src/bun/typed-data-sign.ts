/**
 * wallet.ethSignTypedData with hdwallet's Features cache filled first.
 *
 * hdwallet 88044654 picks 1 KB chunking for typed-data values from that
 * cache, and ClearSession, ApplyPolicy, ApplySettings and LoadDevice empty
 * it. Empty, it treats a 7.16 device as older firmware: the device starts
 * the review of a Safe batch over 1 KB and the host aborts it ("over the
 * 1024-byte wire limit"). keepkey/hdwallet#83 fixes this in hdwallet.
 */
export async function signTypedDataWithFeatures(wallet: Record<string, any>, params: unknown): Promise<any> {
  if (!wallet.featuresCache) await wallet.getFeatures()
  return wallet.ethSignTypedData(params)
}
