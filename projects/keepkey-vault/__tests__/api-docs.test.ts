/** Audit v6 D1: /docs showed no endpoints in the packaged app, and loaded an unpinned Swagger UI on the API's origin. */
import { describe, expect, mock, test } from 'bun:test'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const userData = mkdtempSync(join(tmpdir(), 'vault-api-docs-'))
mock.module('electrobun/main', () => ({ Utils: { paths: { userData } } }))
mock.module('electrobun/main/utils', () => ({ paths: { userData } }))
mock.module('@keepkey/hdwallet-keepkey-nodehid', () => ({ HIDKeepKeyAdapter: class {} }))
const { getSwagger, getSwaggerUiHtml, SWAGGER_UI_CSS, SWAGGER_UI_JS, SWAGGER_UI_VERSION } = await import('../src/bun/rest-api')

const src = (path: string) => readFileSync(join(import.meta.dir, '..', path), 'utf8')

describe('/spec/swagger.json', () => {
  test('serves the real spec, not a "not found" placeholder', () => {
    const served = JSON.parse(getSwagger())
    expect(served.error).toBeUndefined()
    expect(served).toEqual(JSON.parse(src('src/bun/swagger.json')))
    expect(Object.keys(served.paths).length).toBeGreaterThan(50)
    expect(served.paths['/api/v2/tx/build']).toBeDefined()
  })
  test('the spec survives bundling: the built module still serves it once its source folder is gone', async () => {
    // The packaged backend is one bundled index.js. Bun bakes the build machine's source folder into __dirname, so a
    // runtime read of swagger.json works where the app was built and fails on every user's machine. Reproduce that:
    // build from a copy of the source, delete the copy, then load the build.
    const root = mkdtempSync(join(tmpdir(), 'vault-api-docs-bundle-'))
    const source = join(root, 'src')
    try {
      mkdirSync(source)
      for (const file of ['api-docs-spec.ts', 'swagger.json']) copyFileSync(join(import.meta.dir, '../src/bun', file), join(source, file))
      const built = await Bun.build({ entrypoints: [join(source, 'api-docs-spec.ts')], target: 'bun', outdir: join(root, 'out') })
      expect(built.success).toBe(true)
      rmSync(source, { recursive: true, force: true })
      const bundled = await import(join(root, 'out', 'api-docs-spec.js'))
      expect(JSON.parse(bundled.swaggerJson())).toEqual(JSON.parse(src('src/bun/swagger.json')))
    } finally { rmSync(root, { recursive: true, force: true }) }
    // And /spec/swagger.json is served from that module, not from a file read at runtime.
    const code = src('src/bun/rest-api.ts')
    expect(code).toContain("import { swaggerJson } from './api-docs-spec'")
    expect(code).not.toMatch(/swagger\.json['"]\s*\)|readFileSync\([^)]*swagger|Bun\.file\([^)]*swagger/)
  })
})

describe('/docs', () => {
  const html = getSwaggerUiHtml()
  const external = [...html.matchAll(/<(script|link)\b[^>]*\b(?:src|href)="(https?:\/\/[^"]+)"[^>]*>/g)]

  test('loads Swagger UI at an exact version with Subresource Integrity', () => {
    expect(SWAGGER_UI_VERSION).toMatch(/^\d+\.\d+\.\d+$/)
    expect(external.map(match => match[2]).sort()).toEqual([SWAGGER_UI_CSS.href, SWAGGER_UI_JS.src].sort())
    for (const [tag] of external) {
      expect(tag).toMatch(/\bintegrity="sha384-[A-Za-z0-9+/]{64}"/)
      expect(tag).toContain('crossorigin="anonymous"')
      expect(tag).toContain(`swagger-ui-dist@${SWAGGER_UI_VERSION}/`)
    }
    expect(html).toContain(`integrity="${SWAGGER_UI_CSS.integrity}"`)
    expect(html).toContain(`integrity="${SWAGGER_UI_JS.integrity}"`)
    // A floating major tag (the old @5/) could serve any future file.
    expect(html).not.toMatch(/swagger-ui-dist@\d+\//)
  })

  test('still points Swagger UI at the served spec, and says so when Swagger UI cannot load', () => {
    expect(html).toContain("url:'/spec/swagger.json'")
    expect(html).toContain("if(typeof SwaggerUIBundle==='undefined'){")
    expect(html).toContain(`The API explorer could not load (Swagger UI ${SWAGGER_UI_VERSION} from unpkg.com)`)
    // swagger-ui-bundle.js has no standalone preset; the page never loaded that file.
    expect(html).not.toContain('SwaggerUIStandalonePreset')
  })
})
