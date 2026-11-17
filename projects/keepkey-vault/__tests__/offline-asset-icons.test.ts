import { describe, expect, test } from 'bun:test'
import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { JSDOM } from 'jsdom'
import manifestJson from '../src/shared/offlineAssetIcons.json'
import { BASE_NATIVE_CAIP, ICON_CAIP_ALIASES, caipToIcon, getAssetIcon, isBundledAssetIcon } from '../src/shared/assetLookup'

const manifest = manifestJson as Record<string, string>
const iconDir = join(import.meta.dir, '../src/mainview/public/assets/token-icons')
const SOL_USDT = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp/token:Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB'
const SOL_USDC = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp/token:EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
const TRON_USDT = 'tron:0x2b6653dc/token:TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'

describe('offline asset icon pack', () => {
  test('contains a broad cross-chain set and critical swap assets', () => {
    expect(Object.keys(manifest).length).toBeGreaterThanOrEqual(180)
    expect(manifest[SOL_USDT]).toBeTruthy()
    expect(manifest[SOL_USDC]).toBeTruthy()
    expect(manifest[TRON_USDT]).toBeTruthy()
    expect(isBundledAssetIcon(getAssetIcon(SOL_USDT))).toBe(true)
  })

  test('Base native ETH has its own bundled mark, not the Ethereum diamond', () => {
    const base = getAssetIcon(BASE_NATIVE_CAIP)
    const ethereum = getAssetIcon('eip155:1/slip44:60')
    expect(isBundledAssetIcon(base)).toBe(true)
    expect(base).not.toBe(ethereum)
    expect(caipToIcon(BASE_NATIVE_CAIP)).toBe(base)
    expect(decodeURIComponent(base)).toContain('#0000ff')
  })

  test('HyperEVM (eip155:999) has a bundled icon; the CDN only stores it under 2868', () => {
    const hype = 'eip155:999/slip44:60'
    expect(manifest[hype]).toBeTruthy()
    expect(isBundledAssetIcon(caipToIcon(hype))).toBe(true)
    expect(ICON_CAIP_ALIASES[hype]).toBe('eip155:2868/slip44:60')
  })

  test('dashboard chains use their official inline SVG logos: offline, 64x64, no scripts or external refs', () => {
    const chains = {
      ethereum: 'eip155:1/slip44:60',
      arbitrum: 'eip155:42161/slip44:60',
      optimism: 'eip155:10/slip44:60',
      polygon: 'eip155:137/slip44:60',
      base: BASE_NATIVE_CAIP,
      thorchain: 'cosmos:thorchain-mainnet-v1/slip44:931',
      dogecoin: 'bip122:00000000001a91e3dace36e2be3bf030/slip44:3',
    }
    const seen = new Set<string>()
    for (const [name, caip] of Object.entries(chains)) {
      const icon = getAssetIcon(caip)
      expect(icon.startsWith('data:image/svg+xml,'), name).toBe(true)
      expect(caipToIcon(caip), name).toBe(icon)
      const svg = decodeURIComponent(icon.slice('data:image/svg+xml,'.length))
      expect(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">'), name).toBe(true)
      expect(svg, name).not.toMatch(/<script|href=|<foreignObject|\son[a-z]+=/i)
      expect(svg.replace('http://www.w3.org/2000/svg', ''), name).not.toMatch(/https?:\/\//)
      // Parse each data-URL image as its own SVG document, as <img> does.
      // IDs may repeat across images; every reference must resolve within
      // its own document, including references inside a <style> element.
      const dom = new JSDOM(svg, { contentType: 'image/svg+xml' })
      try {
        const elementsWithIds = [...dom.window.document.querySelectorAll('[id]')]
        const ids = new Set(elementsWithIds.map(element => element.id))
        expect(ids.size, `${name}: duplicate SVG IDs`).toBe(elementsWithIds.length)
        for (const reference of svg.matchAll(/url\(\s*['"]?#([^\s)'"\]]+)['"]?\s*\)/g)) {
          expect(ids.has(reference[1]), `${name}: unresolved SVG fragment #${reference[1]}`).toBe(true)
        }
      } finally {
        dom.window.close()
      }
      seen.add(icon)
    }
    expect(seen.size).toBe(Object.keys(chains).length)
  })

  test('every manifest target is a bounded raster file', async () => {
    for (const filename of new Set(Object.values(manifest))) {
      expect(filename).toMatch(/^[a-f0-9]{24}\.(png|jpg|webp|gif)$/)
      const path = join(iconDir, filename)
      const fileStat = await stat(path)
      expect(fileStat.size).toBeGreaterThan(0)
      expect(fileStat.size).toBeLessThanOrEqual(768 * 1024)
      const bytes = new Uint8Array(await readFile(path))
      const isPng = bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47
      const isJpeg = bytes[0] === 0xff && bytes[1] === 0xd8
      const isGif = bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46
      const isWebp = bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46
      expect(isPng || isJpeg || isGif || isWebp).toBe(true)
    }
  })
})
