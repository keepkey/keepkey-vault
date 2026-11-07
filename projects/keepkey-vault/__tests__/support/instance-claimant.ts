/** A stand-in Desktop for single-instance.test.ts: claims the instance socket,
 * reports how it went, then optionally stalls its event loop (a slow sync DB
 * call, an emulator FFI call, a blocking quit) and releases.
 *
 *   CLAIM_PATH      socket path
 *   CLAIM_VERSION   this copy's version
 *   BLOCK_MS        stall the event loop this long after printing "blocking"
 *   RELEASE         'before-block' | 'after-block' | 'never' (default 'never')
 *   HOLD_MS         stay alive this long after the stall (default 10 s)
 */
import { claimSingleInstance } from '../../src/bun/single-instance'

const path = process.env.CLAIM_PATH!
const blockMs = Number(process.env.BLOCK_MS || 0)
const release = process.env.RELEASE || 'never'
const claim = await claimSingleInstance(path, { version: process.env.CLAIM_VERSION || '1.0.0', onFocusRequest: () => console.log('focused') })
console.log(JSON.stringify(claim))
if (claim.role === 'primary') {
  await Bun.sleep(Number(process.env.START_DELAY_MS || 50))
  if (blockMs) {
    if (release === 'before-block') claim.release()
    console.log('blocking')
    const until = Date.now() + blockMs
    while (Date.now() < until) { /* the event loop is stalled */ }
    if (release === 'after-block') claim.release()
    console.log('unblocked')
  }
}
setTimeout(() => process.exit(0), Number(process.env.HOLD_MS || 10_000))
