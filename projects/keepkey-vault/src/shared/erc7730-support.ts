/**
 * ERC-7730 definitions on firmware 7.16: when Desktop may send one.
 *
 * The pinned hdwallet (keepkey/hdwallet master, PR #76) preloads a signed
 * definition and answers the device's chunk requests. Desktop sends only
 * definitions it fetched from the KeepKey ClearSign service and checked itself
 * (src/bun/erc7730-resolver.ts). A catalog a caller supplies (REST body, swap
 * quote) is always dropped: it may be runtime tier, which the device gates on
 * AdvancedMode, and Desktop cannot tell before the device does.
 */
import { versionCompare } from './firmware-versions'
import { deviceTrustsProductionRoot } from './certified-evm-envelope'

/** Calldata definitions: on, behind the firmware and capability gate below. */
export const ERC7730_TRANSPORT_SUPPORTED: boolean = true

/** The first firmware with the ERC-7730 v2 interpreter. */
export const ERC7730_MIN_FW = '7.16.0'

/**
 * Typed-data (EIP-712) definitions: OFF on 7.16 (owner, 2026-10-16). Measured
 * on stock 7.16.0, every field pass re-shows every message leaf (4.2x the
 * screens). 7.17 shows each value once (firmware #1025), so typed data gets a
 * definition from 7.17.0 on. A PermitSingle never gets one: a preload turns
 * off the native Permit2 review.
 *
 * Gated on the version alone (owner rule: versions, not flags). Firmware alpha
 * has reported 7.17.0 since 2026-09-21, but show-once (520ec4ed5) reached alpha
 * only on 2026-10-30 (296aa1e2c). A 7.17.0 alpha built before that re-shows
 * every value on each field pass. Those are unreleased test builds and are not
 * supported: reflash current alpha. Every released 7.17.0 carries #1025.
 */
export const ERC7730_TYPED_DATA_MIN_FW = '7.17.0'

/**
 * The first firmware that follows an embedded call to that call's own
 * definition (a Safe's execTransaction, a factory's initializer, each step of
 * a multicall; two levels deep) and checks formatter flags (RECIPIENT,
 * TX_VALUE). 7.16 refuses both, so they are never sent to it.
 */
export const ERC7730_EMBEDDED_MIN_FW = '7.17.0'

/** Features.capabilities value (messages.proto). It sits in the 7.15 block of
 *  the firmware's list, so it does not identify 7.16 alone. */
export const CAPABILITY_ERC7730_RUNTIME_REVIEW = 4

/** 7.16 refuses these with a preloaded definition ("ERC-7730 approval not supported"). */
export const ERC7730_REFUSED_SELECTORS: ReadonlySet<string> = new Set(['0x095ea7b3', '0x39509351'])

/** Desktop may send this device an ERC-7730 calldata definition. */
export function supportsErc7730Transport(firmwareVersion: string | undefined, capabilities: readonly number[] | undefined): boolean {
  return ERC7730_TRANSPORT_SUPPORTED
    && !!firmwareVersion && versionCompare(firmwareVersion, ERC7730_MIN_FW) >= 0
    && Array.isArray(capabilities) && capabilities.includes(CAPABILITY_ERC7730_RUNTIME_REVIEW)
    // The bundled emulator trusts only the alpha root (see certified-evm-envelope).
    && deviceTrustsProductionRoot()
}

/** This firmware takes definitions with embedded calls and formatter flags. */
export function supportsErc7730EmbeddedCalls(firmwareVersion: string | undefined): boolean {
  return !!firmwareVersion && versionCompare(firmwareVersion, ERC7730_EMBEDDED_MIN_FW) >= 0
}

/** Desktop may send this device an ERC-7730 typed-data definition. */
export function supportsErc7730TypedData(firmwareVersion: string | undefined, capabilities: readonly number[] | undefined): boolean {
  return supportsErc7730Transport(firmwareVersion, capabilities)
    && versionCompare(firmwareVersion!, ERC7730_TYPED_DATA_MIN_FW) >= 0
}

/**
 * Why this calldata never gets a definition, or undefined when it may.
 * approve/increaseAllowance: 7.16 refuses them with a definition. Arguments
 * that are not whole 32-byte words: 7.16 refuses the program ("Invalid ERC-7730
 * execution program").
 */
export function erc7730CalldataSkipReason(data: unknown): string | undefined {
  if (typeof data !== 'string' || !/^0x(?:[0-9a-fA-F]{2})*$/.test(data)) return 'calldata is not hex'
  const bytes = (data.length - 2) / 2
  if (bytes < 4) return 'no selector'
  if (ERC7730_REFUSED_SELECTORS.has(data.slice(0, 10).toLowerCase())) return 'approvals are refused with a definition'
  if ((bytes - 4) % 32 !== 0) return 'arguments are not whole 32-byte words'
  return undefined
}

/** Remove a caller-supplied `erc7730` catalog, and say so. Desktop sends only
 *  definitions it fetched itself. */
export function withoutCallerErc7730<T>(tx: T, where: string): T {
  if (!tx || typeof tx !== 'object' || (tx as any).erc7730 == null) return tx
  console.warn(`[clearsign] ${where}: caller-supplied ERC-7730 catalog ignored; Desktop sends only definitions from the KeepKey ClearSign service`)
  const { erc7730: _caller, ...rest } = tx as any
  return rest as T
}
