import { mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const out = resolve(process.env.UPDATE_BANNER_STORY_DIR || join(tmpdir(), 'keepkey-update-banner-story'))
mkdirSync(out, { recursive: true })
const result = await Bun.build({
  entrypoints: [fileURLToPath(new URL('./entry.tsx', import.meta.url))],
  outdir: out, target: 'browser', format: 'esm', naming: '[name].[ext]',
})
if (!result.success) throw new Error(result.logs.join('\n'))
const script = result.outputs.find(output => output.path.endsWith('.js'))
const styles = result.outputs.find(output => output.path.endsWith('.css'))
if (!script || !styles) throw new Error('Expected the actual component bundle and imported app styles')
writeFileSync(join(out, 'manifest.json'), JSON.stringify({ script: basename(script.path), styles: basename(styles.path) }) + '\n')
console.log(`UpdateBanner story built in ${out}`)
