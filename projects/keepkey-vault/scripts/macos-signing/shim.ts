import { createHash } from 'node:crypto'
import { lstatSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

const LEDGER_ENV = 'KEEPKEY_MACOS_SIGNING_LEDGER'
const digest = (path: string) => createHash('sha256').update(new Uint8Array(readFileSync(path))).digest('hex')
const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'"

interface SignedHelper { path: string; sha256: string }
export interface MacosSigningLedger { schemaVersion: 1; bundlePath: string; helpers: SignedHelper[] }
export interface MacosSigningShimOptions {
  bundlePath: string
  helpers: { bundleRelativePath: string; signedSourcePath: string }[]
  environment?: NodeJS.ProcessEnv
}

// The build output need not exist yet. Resolve existing ancestors so /var and
// /private/var (and a symlinked project parent) name the same future bundle.
function canonicalFuturePath(path: string): string {
  const absolute = resolve(path)
  try { return realpathSync(absolute) } catch {
    const parent = dirname(absolute)
    if (parent === absolute) throw new Error('Cannot resolve signing bundle path')
    return join(canonicalFuturePath(parent), basename(absolute))
  }
}

function within(directory: string, path: string): boolean {
  const suffix = relative(directory, path)
  return suffix !== '' && suffix !== '..' && !suffix.startsWith('..' + sep) && !isAbsolute(suffix)
}

function validateLedger(value: unknown): MacosSigningLedger {
  const ledger = value as MacosSigningLedger
  if (!ledger || ledger.schemaVersion !== 1 || !isAbsolute(ledger.bundlePath || '')
    || !Array.isArray(ledger.helpers) || ledger.helpers.length === 0) throw new Error('Invalid macOS helper signing ledger')
  const appCode = join(ledger.bundlePath, 'Contents', 'Resources', 'app')
  const seen = new Set<string>()
  for (const helper of ledger.helpers) {
    if (!helper || typeof helper.path !== 'string' || !isAbsolute(helper.path)
      || !within(appCode, helper.path) || helper.path !== resolve(helper.path)
      || !/^[a-f0-9]{64}$/.test(helper.sha256) || seen.has(helper.path)) throw new Error('Invalid macOS helper signing entry')
    seen.add(helper.path)
  }
  return ledger
}

/** Bind preservation to the exact bytes just signed by the release wrapper.
 * Hutch still signs every other target, including the outer app. No receipt
 * from an existing bundle or a user-supplied emulator is accepted here. */
export function createMacosSigningShim(options: MacosSigningShimOptions): { environment: NodeJS.ProcessEnv; cleanup: () => void } {
  if (!isAbsolute(options.bundlePath)) throw new Error('The signing bundle path must be absolute')
  const bundlePath = canonicalFuturePath(options.bundlePath)
  const helpers = options.helpers.map(helper => {
    if (isAbsolute(helper.bundleRelativePath)) throw new Error('Helper destinations must be bundle-relative')
    if (!lstatSync(helper.signedSourcePath).isFile()) throw new Error('Signed helper source must be a regular file')
    return { path: resolve(bundlePath, helper.bundleRelativePath), sha256: digest(helper.signedSourcePath) }
  })
  const ledger = validateLedger({ schemaVersion: 1, bundlePath, helpers })
  const directory = mkdtempSync(join(tmpdir(), 'keepkey-macos-signing-'))
  try {
    const ledgerPath = join(directory, 'helpers.json')
    writeFileSync(ledgerPath, JSON.stringify(ledger), { mode: 0o600 })
    writeFileSync(join(directory, 'codesign'), '#!/bin/sh\nexec ' + quote(process.execPath) + ' ' + quote(join(import.meta.dir, 'shim.ts')) + ' "$@"\n', { mode: 0o700 })
    const environment = options.environment ?? process.env
    return {
      environment: { ...environment, PATH: directory + ':' + (environment.PATH ?? process.env.PATH ?? '/usr/bin:/bin'), [LEDGER_ENV]: ledgerPath },
      cleanup: () => rmSync(directory, { recursive: true, force: true }),
    }
  } catch (error) {
    rmSync(directory, { recursive: true, force: true })
    throw error
  }
}

type NativeCodesign = (arguments_: string[]) => number
const nativeCodesign: NativeCodesign = arguments_ => {
  const child = Bun.spawnSync(['/usr/bin/codesign', ...arguments_], { stdin: 'inherit', stdout: 'inherit', stderr: 'inherit' })
  return child.exitCode ?? 1
}

function requireSingleHelperTarget(arguments_: string[]): void {
  const switches = new Set(['--force', '-f', '--verbose', '-v', '--timestamp'])
  const valued = new Set(['--sign', '-s', '--options', '-o', '--entitlements'])
  const positionals: string[] = []
  for (let index = 0; index < arguments_.length; index++) {
    const argument = arguments_[index]
    if (switches.has(argument)) continue
    if (valued.has(argument)) {
      const value = arguments_[++index]
      if (!value || value.startsWith('--')) throw new Error('Missing codesign option value for preserved helper')
      continue
    }
    if (/^--(?:sign|options|entitlements|timestamp|verbose)=.+$/.test(argument)) continue
    if (argument.startsWith('-')) throw new Error('Unsupported codesign option for preserved helper: ' + argument)
    positionals.push(argument)
  }
  if (positionals.length !== 1) throw new Error('Preserved helper signing requires exactly one target')
}

/** The injected runner lets tests exercise the real dispatch and byte checks
 * without reaching a signing identity. The executable always uses the fixed
 * /usr/bin/codesign implementation, never another PATH lookup. */
export function runMacosCodesign(arguments_: string[], rawLedger: unknown, runNative: NativeCodesign = nativeCodesign): number {
  const ledger = validateLedger(rawLedger)
  const signing = arguments_.includes('--sign') || arguments_.includes('-s') || arguments_.some(argument => argument.startsWith('--sign='))
  if (!signing) return runNative(arguments_)
  const target = arguments_.at(-1)
  if (!target) throw new Error('Missing codesign target')
  const namedPath = join(canonicalFuturePath(dirname(target)), basename(target))
  const path = canonicalFuturePath(target)
  // A future Hutch --deep pass must fail instead of silently rewriting the
  // preserved helpers through an ancestor's signature operation.
  if (arguments_.includes('--deep') && ledger.helpers.some(helper => within(path, helper.path))) {
    throw new Error('Deep signing would rewrite preserved macOS helpers')
  }
  const helper = ledger.helpers.find(entry => entry.path === namedPath || entry.path === path)
  if (!helper) {
    // Do not let a multiple-target invocation rewrite a protected helper just
    // because some other target happens to be last in the argument list.
    const mentionsHelper = arguments_.some(argument => !argument.startsWith('-')
      && ledger.helpers.some(entry => entry.path === canonicalFuturePath(argument)))
    if (mentionsHelper) {
      requireSingleHelperTarget(arguments_)
      throw new Error('Preserved helper signing requires exactly one target at the expected path')
    }
    return runNative(arguments_)
  }
  requireSingleHelperTarget(arguments_)
  if (namedPath !== helper.path || path !== helper.path) throw new Error('Preserved macOS helper cannot be accessed through a symlink')
  if (!lstatSync(target).isFile()) throw new Error('Preserved macOS helper must be a regular file')
  if (digest(path) !== helper.sha256) throw new Error('Preserved macOS helper bytes changed after verification: ' + path)
  const verified = runNative(['--verify', '--strict', path])
  if (verified !== 0) return verified
  if (digest(path) !== helper.sha256) throw new Error('Preserved macOS helper changed during signature verification: ' + path)
  return 0
}

if (import.meta.main) {
  try {
    const ledgerPath = process.env[LEDGER_ENV]
    if (!ledgerPath || !lstatSync(ledgerPath).isFile() || lstatSync(ledgerPath).size > 65536) throw new Error('Missing macOS helper signing ledger')
    process.exit(runMacosCodesign(process.argv.slice(2), JSON.parse(readFileSync(ledgerPath, 'utf8'))))
  } catch (error) {
    console.error('[macos-signing] ' + (error instanceof Error ? error.message : String(error)))
    process.exit(1)
  }
}
