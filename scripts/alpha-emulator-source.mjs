#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

export const FIRMWARE_REPOSITORY = 'BitHighlander/keepkey-firmware'
export const FIRMWARE_BRANCH = 'alpha'
export function firmwareVersion(cmake) {
  const match = /^\s*project\(\s*KeepKeyFirmware\s+VERSION\s+(\d+\.\d+\.\d+)\s+LANGUAGES\b/m.exec(cmake)
  if (!match) throw new Error('Alpha source has no KeepKey firmware project version')
  return match[1]
}
export function alphaHead(run = execFileSync) {
  const refs = run('git', ['ls-remote', `https://github.com/${FIRMWARE_REPOSITORY}.git`, 'refs/heads/alpha'], { encoding: 'utf8' }).trim()
  const match = /^([a-f0-9]{40})\s+refs\/heads\/alpha$/.exec(refs)
  if (!match) throw new Error('Could not resolve the fork alpha head')
  return match[1]
}

export function qualifiedAlpha(sha, run = execFileSync) {
  if (!/^[a-f0-9]{40}$/.test(sha)) throw new Error('Invalid alpha commit')
  const data = JSON.parse(run('gh', ['api', `repos/${FIRMWARE_REPOSITORY}/actions/workflows/ci.yml/runs?head_sha=${sha}&status=success&per_page=20`], { encoding: 'utf8' }))
  const good = data.workflow_runs?.find(r => r.head_sha === sha && r.status === 'completed' && r.conclusion === 'success')
  if (!good) throw new Error(`Fork alpha ${sha} has no successful exact-head firmware CI run`)
  return { repository: FIRMWARE_REPOSITORY, branch: FIRMWARE_BRANCH, commit: sha, runId: good.id, runUrl: good.html_url }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [checkout, receipt] = process.argv.slice(2)
  if (!checkout || !receipt) throw new Error('Usage: alpha-emulator-source.mjs CHECKOUT_DIR RECEIPT_FILE')
  const sha = alphaHead()
  if (process.env.EMU_REQUESTED_FIRMWARE_SHA && process.env.EMU_REQUESTED_FIRMWARE_SHA !== sha) {
    throw new Error('Requested firmware is no longer the fork alpha head; rebuild from current alpha')
  }
  const source = qualifiedAlpha(sha)
  const directory = resolve(checkout)
  const vault = resolve(dirname(fileURLToPath(import.meta.url)), '..')
  if (directory === resolve(vault, 'modules/keepkey-firmware') || directory.startsWith(resolve(vault, 'modules') + '/')) {
    throw new Error('Alpha emulator intake must use an independent source checkout')
  }
  if (existsSync(directory)) throw new Error('Alpha source checkout already exists; choose a fresh build directory')
  mkdirSync(dirname(directory), { recursive: true })
  const git = (...args) => execFileSync('git', ['-C', directory, ...args], { stdio: 'inherit' })
  execFileSync('git', ['clone', '--no-checkout', '--filter=blob:none', `https://github.com/${FIRMWARE_REPOSITORY}.git`, directory], { stdio: 'inherit' })
  git('checkout', '--detach', sha)
  git('submodule', 'update', '--init', '--', 'code-signing-keys', 'deps/crypto/trezor-firmware', 'deps/device-protocol', 'deps/python-keepkey', 'deps/googletest', 'deps/qrenc/QR-Code-generator', 'deps/sca-hardening/SecAESSTM32')
  execFileSync('git', ['-C', resolve(directory, 'deps/python-keepkey'), 'submodule', 'update', '--init', '--', 'device-protocol', 'keepkeylib/eth/ethereum-lists'], { stdio: 'inherit' })
  source.version = firmwareVersion(readFileSync(resolve(directory, 'CMakeLists.txt'), 'utf8'))
  writeFileSync(receipt, JSON.stringify(source, null, 2) + '\n')
  console.log(`Alpha emulator source: ${sha}; firmware CI ${source.runId}`)
}
