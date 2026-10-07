/**
 *   verified      firmware hash matches an official release
 *   genuine       firmware too old to report a hash, bootloader is an official release
 *   unrecognized  firmware hash is not an official release (custom or modified)
 *   unreported    nothing we can match
 */
export type AuthenticityVerdict = "verified" | "genuine" | "unrecognized" | "unreported"

/** Fail closed: a missing hash is "we do not know", never a pass. A known
 *  bootloader vouches only for a device whose firmware reports no hash —
 *  firmware that reports an unofficial hash stays unrecognized. */
export function authenticityVerdict(firmwareHash?: string, firmwareVerified?: boolean, bootloaderVerified?: boolean): AuthenticityVerdict {
  if (firmwareHash) return firmwareVerified === true ? "verified" : "unrecognized"
  return bootloaderVerified === true ? "genuine" : "unreported"
}
