import { expect, test } from "bun:test"
import { createUiWatchdog } from "./ui-watchdog"

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

function harness(timeoutMs: number) {
	const logs: string[] = []
	const errors: string[] = []
	const watchdog = createUiWatchdog({ timeoutMs, log: m => logs.push(m), error: m => errors.push(m) })
	return { watchdog, logs, errors }
}

test("logs once when the UI makes contact, and never reports a blank window", async () => {
	const { watchdog, logs, errors } = harness(20)
	watchdog.start()
	watchdog.seen()
	watchdog.seen()
	await sleep(40)
	expect(logs).toHaveLength(1)
	expect(logs[0]).toMatch(/^\[UI\] loaded after \d+ms$/)
	expect(errors).toHaveLength(0)
})

test("reports a blank window when the UI never makes contact", async () => {
	const { watchdog, logs, errors } = harness(20)
	watchdog.start()
	await sleep(40)
	expect(logs).toHaveLength(0)
	expect(errors).toHaveLength(1)
	expect(errors[0]).toContain("nothing has loaded in the window")
})

test("a slow UI is still recorded as loaded after the warning", async () => {
	const { watchdog, logs, errors } = harness(20)
	watchdog.start()
	await sleep(40)
	watchdog.seen()
	expect(errors).toHaveLength(1)
	expect(logs).toHaveLength(1)
})
