#!/usr/bin/env bun
import { mkdir, chmod } from 'node:fs/promises'
import { resolve } from 'node:path'

const targets: Record<string, string> = {
  'darwin-arm64': 'bun-darwin-arm64', 'darwin-x64': 'bun-darwin-x64',
  'linux-arm64': 'bun-linux-arm64', 'linux-x64': 'bun-linux-x64-baseline',
  'win32-x64': 'bun-windows-x64-baseline',
}
const platform = process.argv.find(arg => arg.startsWith('--platform='))?.slice(11) || `${process.platform}-${process.arch}`
const target = targets[platform]
if (!target) throw new Error('This platform has no supported Monero CLI sidecar target')
const directory = resolve(import.meta.dir, 'dist')
await mkdir(directory, { recursive: true })
const binary = resolve(directory, platform.startsWith('win32') ? 'monero-cli.exe' : 'monero-cli')
const compiler = process.env.MONERO_BUILD_BUN || process.execPath
const version = Bun.spawnSync([compiler, '--version'], { stdout: 'pipe', stderr: 'ignore' }).stdout.toString().trim()
const numbers = version.split('.').map(Number)
if (numbers.length < 3 || numbers.some(n => !Number.isFinite(n)) ||
    (numbers[0] === 1 && (numbers[1] < 3 || (numbers[1] === 3 && numbers[2] < 14))) || numbers[0] < 1) {
  throw new Error('Build the Monero sidecar with Bun >= 1.3.14; set MONERO_BUILD_BUN to the pinned compiler path')
}
const result = Bun.spawn([compiler, 'build', '--compile', `--target=${target}`, resolve(import.meta.dir, 'src/main.ts'), '--outfile', binary],
  { stdout: 'inherit', stderr: 'inherit' })
if (await result.exited !== 0) throw new Error('Monero CLI sidecar compilation failed')
await chmod(binary, 0o755)
console.log(JSON.stringify({ status: 'pass', platform, binary, bunVersion: version }))
