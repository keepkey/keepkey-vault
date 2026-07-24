import { describe, expect, test } from 'bun:test'
import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import manifestJson from '../src/shared/offlineAssetIcons.json'
import { getAssetIcon, isBundledAssetIcon } from '../src/shared/assetLookup'

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
