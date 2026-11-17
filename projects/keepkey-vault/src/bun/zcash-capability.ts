import { versionCompare } from '../shared/firmware-versions'
import { ZCASH_NU7_MIN_FIRMWARE } from '../shared/zcash-nu7'

/** Wallet connection/monitoring needs firmware 7.17 and its native sidecar.
 * Send admission separately checks the qualified Nu7 signer and builder. */
export function supportsZcashPrivacyBuild(
	firmwareVersion: string | undefined,
	sidecarBinary: string | undefined,
): boolean {
	return !!sidecarBinary && !!firmwareVersion && versionCompare(firmwareVersion, ZCASH_NU7_MIN_FIRMWARE) >= 0
}
