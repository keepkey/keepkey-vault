/** Features.capabilities, messages.proto. A firmware version or build hash does not grant signing support. */
export const CAPABILITY_MONERO_SIGNING = 31
export const supportsMoneroSigning = (capabilities?: readonly number[]) => capabilities?.includes(CAPABILITY_MONERO_SIGNING) === true
