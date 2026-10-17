/**
 * The alpha ClearSign root and its one delegate: emulator rehearsals, the
 * alpha ceremony scripts, the alpha Worker copy and tests only. Desktop code
 * (src/) never imports this file, so a shipped build trusts only
 * PRODUCTION_ROOT_PUBLIC_KEY. Pass ALPHA_ROOT_PUBLIC_KEY explicitly where a
 * rehearsal must accept an alpha certificate.
 */
export const ALPHA_ROOT_PUBLIC_KEY = '02de9231b2094433235532fb1932e324a2c7304195e12e610c675cccbbd606dae7'
export const ALPHA_DELEGATE_PUBLIC_KEY = '0342f5f9704494b3f9bd72295eecaf29d783d23ea02b2dc9f48abcd2e46d4850cf'
export const ALPHA_DELEGATE_FINGERPRINT = 'a9531b9d'
export const ALPHA_ALIAS = 'KeepKey Alpha 716'
