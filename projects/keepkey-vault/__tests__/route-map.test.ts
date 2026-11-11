import { expect, test } from 'bun:test'

test('RouteMap renders packaged HTML images, stable fallbacks and reduced-motion routes', () => {
  const run = Bun.spawnSync([process.execPath, new URL('./support/route-map.tsx', import.meta.url).pathname], {
    cwd: new URL('../', import.meta.url).pathname, stdout: 'pipe', stderr: 'pipe', timeout: 10000,
  })
  if (run.exitCode) throw new Error((run.stderr.toString() || run.stdout.toString()).slice(0, 7000))
  expect(JSON.parse(run.stdout.toString().trim().split('\n').at(-1)!)).toEqual({
    htmlIcons: true, badges: true, uniqueGradients: true, imageFallbacks: true, reducedMotion: true,
  })
})
