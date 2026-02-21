/**
 * Self-contained QR code SVG generator. No external dependencies.
 * Supports byte-mode encoding with error correction level M.
 * Generates version 1-10 QR codes (up to ~200 chars).
 */

// Error correction level M constants per version (1-10)
const EC_CODEWORDS = [10, 16, 26, 36, 48, 64, 72, 88, 110, 130]
const DATA_CODEWORDS = [16, 28, 44, 64, 86, 108, 124, 154, 182, 216]
const NUM_BLOCKS = [1, 1, 1, 2, 2, 4, 4, 4, 5, 5]

// Format bits for mask patterns 0-7 with EC level M
const FORMAT_BITS = [
  0x5412, 0x5125, 0x5E7C, 0x5B4B, 0x45F9, 0x40CE, 0x4F97, 0x4AA0,
]

function getVersion(dataLen: number): number {
  for (let v = 0; v < 10; v++) {
    // Byte mode: 4 (mode) + 8 (count) + dataLen*8 + 4 (terminator) bits
    const capacity = DATA_CODEWORDS[v]
    if (dataLen + 3 <= capacity) return v + 1
  }
  throw new Error('Data too long for QR code')
}

function getSize(version: number): number {
  return 17 + version * 4
}

// Generate GF(256) log/exp tables
const EXP = new Uint8Array(256)
const LOG = new Uint8Array(256)
{
  let x = 1
  for (let i = 0; i < 255; i++) {
    EXP[i] = x
    LOG[x] = i
    x = (x << 1) ^ (x & 128 ? 0x11D : 0)
  }
  EXP[255] = EXP[0]
}

function gfMul(a: number, b: number): number {
  if (a === 0 || b === 0) return 0
  return EXP[(LOG[a] + LOG[b]) % 255]
}

function rsEncode(data: Uint8Array, ecLen: number): Uint8Array {
  // Build generator polynomial
  const gen = new Uint8Array(ecLen + 1)
  gen[0] = 1
  for (let i = 0; i < ecLen; i++) {
    for (let j = i + 1; j >= 1; j--) {
      gen[j] = gen[j] ^ gfMul(gen[j - 1], EXP[i])
    }
  }

  const result = new Uint8Array(ecLen)
  for (let i = 0; i < data.length; i++) {
    const factor = data[i] ^ result[0]
    result.copyWithin(0, 1)
    result[ecLen - 1] = 0
    for (let j = 0; j < ecLen; j++) {
      result[j] ^= gfMul(gen[j + 1], factor)
    }
  }
  return result
}

function encodeData(text: string, version: number): Uint8Array {
  const totalCodewords = DATA_CODEWORDS[version - 1] + EC_CODEWORDS[version - 1]
  const dataCapacity = DATA_CODEWORDS[version - 1]
  const bytes = new TextEncoder().encode(text)

  // Build bit stream: mode(4) + count(8) + data + terminator
  const bits: number[] = []
  const push = (val: number, len: number) => {
    for (let i = len - 1; i >= 0; i--) bits.push((val >> i) & 1)
  }

  push(0b0100, 4) // byte mode
  push(bytes.length, 8) // count
  for (const b of bytes) push(b, 8)
  push(0, Math.min(4, dataCapacity * 8 - bits.length)) // terminator

  // Pad to byte boundary
  while (bits.length % 8 !== 0) bits.push(0)

  // Pad codewords
  const padBytes = [0xEC, 0x11]
  let padIdx = 0
  while (bits.length < dataCapacity * 8) {
    push(padBytes[padIdx % 2], 8)
    padIdx++
  }

  // Convert to bytes
  const dataBytes = new Uint8Array(dataCapacity)
  for (let i = 0; i < dataCapacity; i++) {
    let byte = 0
    for (let j = 0; j < 8; j++) byte = (byte << 1) | (bits[i * 8 + j] || 0)
    dataBytes[i] = byte
  }

  // Split into blocks and compute EC
  const numBlocks = NUM_BLOCKS[version - 1]
  const ecPerBlock = EC_CODEWORDS[version - 1] / numBlocks
  const baseBlockSize = Math.floor(dataCapacity / numBlocks)
  const largerBlocks = dataCapacity % numBlocks

  const dataBlocks: Uint8Array[] = []
  const ecBlocks: Uint8Array[] = []
  let offset = 0

  for (let b = 0; b < numBlocks; b++) {
    const blockSize = baseBlockSize + (b >= numBlocks - largerBlocks ? 1 : 0)
    const block = dataBytes.slice(offset, offset + blockSize)
    dataBlocks.push(block)
    ecBlocks.push(rsEncode(block, ecPerBlock))
    offset += blockSize
  }

  // Interleave data blocks
  const result = new Uint8Array(totalCodewords)
  let idx = 0
  const maxDataBlock = baseBlockSize + (largerBlocks > 0 ? 1 : 0)
  for (let i = 0; i < maxDataBlock; i++) {
    for (let b = 0; b < numBlocks; b++) {
      if (i < dataBlocks[b].length) result[idx++] = dataBlocks[b][i]
    }
  }
  // Interleave EC blocks
  for (let i = 0; i < ecPerBlock; i++) {
    for (let b = 0; b < numBlocks; b++) {
      result[idx++] = ecBlocks[b][i]
    }
  }

  return result
}

function createMatrix(version: number): { matrix: number[][]; reserved: boolean[][] } {
  const size = getSize(version)
  const matrix = Array.from({ length: size }, () => Array(size).fill(0))
  const reserved = Array.from({ length: size }, () => Array(size).fill(false))

  // Finder patterns
  const placeFinderPattern = (row: number, col: number) => {
    for (let r = -1; r <= 7; r++) {
      for (let c = -1; c <= 7; c++) {
        const mr = row + r, mc = col + c
        if (mr < 0 || mr >= size || mc < 0 || mc >= size) continue
        reserved[mr][mc] = true
        if (r >= 0 && r <= 6 && c >= 0 && c <= 6) {
          const isBlack = r === 0 || r === 6 || c === 0 || c === 6 ||
            (r >= 2 && r <= 4 && c >= 2 && c <= 4)
          matrix[mr][mc] = isBlack ? 1 : 0
        }
      }
    }
  }
  placeFinderPattern(0, 0)
  placeFinderPattern(0, size - 7)
  placeFinderPattern(size - 7, 0)

  // Timing patterns
  for (let i = 8; i < size - 8; i++) {
    reserved[6][i] = true
    matrix[6][i] = i % 2 === 0 ? 1 : 0
    reserved[i][6] = true
    matrix[i][6] = i % 2 === 0 ? 1 : 0
  }

  // Dark module
  reserved[size - 8][8] = true
  matrix[size - 8][8] = 1

  // Reserve format info areas
  for (let i = 0; i < 9; i++) {
    if (i < size) { reserved[8][i] = true; reserved[i][8] = true }
  }
  for (let i = 0; i < 8; i++) {
    reserved[8][size - 8 + i] = true
    reserved[size - 8 + i][8] = true
  }

  // Alignment pattern for version >= 2
  if (version >= 2) {
    const pos = [6, size - 7]
    for (const r of pos) {
      for (const c of pos) {
        if (reserved[r][c]) continue
        for (let dr = -2; dr <= 2; dr++) {
          for (let dc = -2; dc <= 2; dc++) {
            const mr = r + dr, mc = c + dc
            reserved[mr][mc] = true
            const isBlack = Math.abs(dr) === 2 || Math.abs(dc) === 2 || (dr === 0 && dc === 0)
            matrix[mr][mc] = isBlack ? 1 : 0
          }
        }
      }
    }
  }

  return { matrix, reserved }
}

function placeData(matrix: number[][], reserved: boolean[][], data: Uint8Array) {
  const size = matrix.length
  const bits: number[] = []
  for (const b of data) {
    for (let i = 7; i >= 0; i--) bits.push((b >> i) & 1)
  }

  let bitIdx = 0
  let upward = true

  for (let col = size - 1; col >= 0; col -= 2) {
    if (col === 6) col = 5 // skip timing column
    const rows = upward ? Array.from({ length: size }, (_, i) => size - 1 - i) : Array.from({ length: size }, (_, i) => i)
    for (const row of rows) {
      for (const c of [col, col - 1]) {
        if (c < 0 || reserved[row][c]) continue
        matrix[row][c] = bitIdx < bits.length ? bits[bitIdx++] : 0
      }
    }
    upward = !upward
  }
}

function applyMask(matrix: number[][], reserved: boolean[][], maskNum: number): number[][] {
  const size = matrix.length
  const masked = matrix.map(r => [...r])
  const maskFn = [
    (r: number, c: number) => (r + c) % 2 === 0,
    (r: number, _: number) => r % 2 === 0,
    (_: number, c: number) => c % 3 === 0,
    (r: number, c: number) => (r + c) % 3 === 0,
    (r: number, c: number) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
    (r: number, c: number) => (r * c) % 2 + (r * c) % 3 === 0,
    (r: number, c: number) => ((r * c) % 2 + (r * c) % 3) % 2 === 0,
    (r: number, c: number) => ((r + c) % 2 + (r * c) % 3) % 2 === 0,
  ][maskNum]

  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (!reserved[r][c] && maskFn(r, c)) {
        masked[r][c] ^= 1
      }
    }
  }
  return masked
}

function placeFormatBits(matrix: number[][], version: number, maskNum: number) {
  const size = getSize(version)
  const bits = FORMAT_BITS[maskNum]

  // Around top-left finder
  for (let i = 0; i <= 5; i++) matrix[8][i] = (bits >> (14 - i)) & 1
  matrix[8][7] = (bits >> 8) & 1
  matrix[8][8] = (bits >> 7) & 1
  matrix[7][8] = (bits >> 6) & 1
  for (let i = 0; i <= 5; i++) matrix[5 - i][8] = (bits >> (5 - i)) & 1

  // Along edges
  for (let i = 0; i <= 7; i++) matrix[size - 1 - i][8] = (bits >> (14 - i)) & 1
  for (let i = 0; i <= 7; i++) matrix[8][size - 8 + i] = (bits >> (7 - i)) & 1
}

function scorePenalty(matrix: number[][]): number {
  const size = matrix.length
  let penalty = 0

  // Rule 1: runs of same color
  for (let r = 0; r < size; r++) {
    let run = 1
    for (let c = 1; c < size; c++) {
      if (matrix[r][c] === matrix[r][c - 1]) { run++; } else { if (run >= 5) penalty += run - 2; run = 1 }
    }
    if (run >= 5) penalty += run - 2
  }
  for (let c = 0; c < size; c++) {
    let run = 1
    for (let r = 1; r < size; r++) {
      if (matrix[r][c] === matrix[r - 1][c]) { run++; } else { if (run >= 5) penalty += run - 2; run = 1 }
    }
    if (run >= 5) penalty += run - 2
  }

  // Rule 3: finder-like patterns
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size - 6; c++) {
      const pat = [matrix[r][c], matrix[r][c+1], matrix[r][c+2], matrix[r][c+3], matrix[r][c+4], matrix[r][c+5], matrix[r][c+6]]
      if (pat.join('') === '1011101') penalty += 40
    }
  }
  for (let c = 0; c < size; c++) {
    for (let r = 0; r < size - 6; r++) {
      const pat = [matrix[r][c], matrix[r+1][c], matrix[r+2][c], matrix[r+3][c], matrix[r+4][c], matrix[r+5][c], matrix[r+6][c]]
      if (pat.join('') === '1011101') penalty += 40
    }
  }

  return penalty
}

export function generateQRSvg(text: string, moduleSize = 4, quietZone = 4): string {
  const version = getVersion(text.length)
  const data = encodeData(text, version)
  const { matrix, reserved } = createMatrix(version)
  placeData(matrix, reserved, data)

  // Try all 8 masks and pick the best
  let bestMask = 0
  let bestPenalty = Infinity
  for (let m = 0; m < 8; m++) {
    const masked = applyMask(matrix, reserved, m)
    placeFormatBits(masked, version, m)
    const pen = scorePenalty(masked)
    if (pen < bestPenalty) { bestPenalty = pen; bestMask = m }
  }

  const final = applyMask(matrix, reserved, bestMask)
  placeFormatBits(final, version, bestMask)

  const size = getSize(version)
  const svgSize = (size + quietZone * 2) * moduleSize
  const rects: string[] = []

  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (final[r][c]) {
        const x = (c + quietZone) * moduleSize
        const y = (r + quietZone) * moduleSize
        rects.push(`<rect x="${x}" y="${y}" width="${moduleSize}" height="${moduleSize}"/>`)
      }
    }
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${svgSize} ${svgSize}" shape-rendering="crispEdges">` +
    `<rect width="${svgSize}" height="${svgSize}" fill="#fff"/>` +
    `<g fill="#000">${rects.join('')}</g></svg>`
}
