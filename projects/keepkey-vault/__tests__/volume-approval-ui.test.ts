import { test } from 'bun:test'

test('hardware and password images use distinct unlock flows across device changes and read-only platforms', () => {
  const run = Bun.spawnSync([process.execPath, new URL('./support/volume-approval-ui.tsx', import.meta.url).pathname], {
    stdout: 'pipe', stderr: 'pipe', timeout: 30_000,
  })
  if (run.exitCode !== 0) throw new Error(run.stderr.toString())
})
