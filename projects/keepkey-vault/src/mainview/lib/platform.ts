export const IS_WINDOWS = navigator.platform?.startsWith('Win') ?? false
export const IS_MAC = navigator.platform?.startsWith('Mac') ?? false
export const IS_LINUX = !IS_WINDOWS && !IS_MAC
