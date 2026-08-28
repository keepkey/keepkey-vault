import { versionCompare } from '../shared/firmware-versions'

/** Zcash privacy requires both device support and a native sidecar compatible
 * with this app build. Transparent Zcash remains available when this is false. */
export function supportsZcashPrivacyBuild(
	firmwareVersion: string | undefined,
	sidecarBinary: string | undefined,
): boolean {
	return !!sidecarBinary && !!firmwareVersion && versionCompare(firmwareVersion, '7.15.0') >= 0
}
