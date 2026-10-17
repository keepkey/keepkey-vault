import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// This copy pins the alpha root: it must never reach the production Worker.
const repo = join(import.meta.dir, '../../../..')
const make = (target: string) => Bun.spawnSync(['make', '-s', target], { cwd: repo, stderr: 'pipe', stdout: 'pipe' })

describe('the in-repo alpha rehearsal Worker is not deployable to production', () => {
  test('no production deploy target; the rehearsal Worker has its own name', () => {
    const makefile = readFileSync(join(repo, 'Makefile'), 'utf8')
    expect(makefile).not.toMatch(/^clearsign-worker-deploy:/m)
    expect(makefile).toMatch(/^clearsign-worker-rehearsal-deploy: clearsign-worker-rehearsal-guard /m)
    const toml = readFileSync(join(import.meta.dir, '../wrangler.toml'), 'utf8')
    expect(toml).toMatch(/^name = "keepkey-clearsign-alpha-rehearsal"$/m)
    expect(toml).not.toMatch(/CLEARSIGN_ENVIRONMENT = "production"/)
    // The README says so and gives no hand deploy.
    const readme = readFileSync(join(import.meta.dir, '../README.md'), 'utf8')
    expect(readme).toContain('**not deployable to production**')
    expect(readme).not.toContain('npx wrangler deploy')
    // No package script deploys around the guard either.
    const pkg = readFileSync(join(import.meta.dir, '../../package.json'), 'utf8')
    expect(pkg).not.toContain('wrangler deploy')
  })

  test('the guard refuses while the Worker code pins the alpha root', () => {
    const result = make('clearsign-worker-rehearsal-guard')
    expect(result.exitCode).not.toBe(0)
    expect(result.stderr.toString()).toContain('pins the alpha root')
  })
})
