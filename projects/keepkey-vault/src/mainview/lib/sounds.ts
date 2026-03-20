/**
 * Web Audio API sound effects — no external files needed.
 */

let audioCtx: AudioContext | null = null

function getCtx(): AudioContext {
  if (!audioCtx) audioCtx = new AudioContext()
  return audioCtx
}

/** Play a short cha-ching coin sound (two rising tones). */
export function playChaChing() {
  try {
    const ctx = getCtx()
    const now = ctx.currentTime

    // First coin clink
    playTone(ctx, 1200, now, 0.08, 0.3)
    playTone(ctx, 1800, now + 0.01, 0.06, 0.2)

    // Second clink (higher, like a register)
    playTone(ctx, 1600, now + 0.12, 0.08, 0.25)
    playTone(ctx, 2400, now + 0.13, 0.1, 0.2)
  } catch {
    // Audio not available (e.g. no user gesture yet) — silently skip
  }
}

function playTone(ctx: AudioContext, freq: number, startTime: number, duration: number, volume: number) {
  const osc = ctx.createOscillator()
  const gain = ctx.createGain()
  osc.type = 'sine'
  osc.frequency.value = freq
  gain.gain.setValueAtTime(volume, startTime)
  gain.gain.exponentialRampToValueAtTime(0.001, startTime + duration)
  osc.connect(gain)
  gain.connect(ctx.destination)
  osc.start(startTime)
  osc.stop(startTime + duration)
}
