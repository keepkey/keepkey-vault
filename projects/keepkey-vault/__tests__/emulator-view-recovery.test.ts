import { expect, test } from 'bun:test'
import { recoverEmulatorView } from '../src/bun/emulator-view-recovery'
function fixture() {
 const tasks: { run: () => void; delay: number; cancelled: boolean }[] = []
 let current = true, ready = false, reloads = 0
 const stop = recoverEmulatorView({ needsLoad: () => current && !ready, reload: () => { reloads++ }, onError: () => {}, schedule: (run, delay) => { const t = { run, delay, cancelled: false }; tasks.push(t); return () => { t.cancelled = true } } })
 return { tasks, stop, ready: () => { ready = true }, replace: () => { current = false }, count: () => reloads }
}
test('retries a blank startup display within the existing readiness deadline', () => {
 const f = fixture(); expect(f.tasks.map(t => t.delay)).toEqual([750, 2000, 5000, 10000]); f.tasks.forEach(t => t.run()); expect(f.count()).toBe(4)
})
test('never reloads a ready or replaced display', () => {
 const f = fixture(); f.tasks[0].run(); f.ready(); f.tasks.slice(1).forEach(t => t.run()); expect(f.count()).toBe(1)
 const old = fixture(); old.replace(); old.tasks.forEach(t => t.run()); expect(old.count()).toBe(0)
})
test('closing or successful readiness cancels every retry', () => {
 const f = fixture(); f.stop(); expect(f.tasks.every(t => t.cancelled)).toBe(true)
})
