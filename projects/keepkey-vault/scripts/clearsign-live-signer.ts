/** Local 7.16 ClearSign service. The delegate key never enters Vault. */
import { createHash } from 'node:crypto'
import bs58 from 'bs58'
import {
  ALPHA_DELEGATE_FINGERPRINT,
  ALPHA_DELEGATE_PUBLIC_KEY,
  CLEARSIGN_SCOPE_SOLANA,
  inspectAlphaCertificate,
} from '../src/bun/clearsign-alpha-ceremony'
import { signCertifiedSolanaLutAttestation } from '../src/bun/solana-certified-lut'
import { signCertifiedSolanaSchema, CERTIFIED_SOLANA_CATALOG } from '../src/bun/solana-certified-schema'
import { resolveCanonicalLutAccounts } from '../src/bun/solana-lut-resolver'
import { createRpcAltFetcher, DEFAULT_SOLANA_RPC_ENDPOINT } from '../src/bun/solana-alt'
import { parseSolanaTx, solanaMessageSlice, parseSolanaMessage } from '../src/bun/solana-tx'

interface SignerFile {
  alias: string
  fingerprint: string
  publicKeyHex: string
  privateKeyHex: string
}

const keyFile = process.env.CLEARSIGN_SIGNER_KEY_FILE
if (!keyFile) throw new Error('CLEARSIGN_SIGNER_KEY_FILE is required')
const signer = await Bun.file(keyFile).json() as SignerFile
if (signer.fingerprint !== ALPHA_DELEGATE_FINGERPRINT || signer.publicKeyHex.toLowerCase() !== ALPHA_DELEGATE_PUBLIC_KEY) {
  throw new Error(`signer file does not match reviewed delegate ${ALPHA_DELEGATE_FINGERPRINT}`)
}
if (!/^[0-9a-fA-F]{64}$/.test(String(signer.privateKeyHex || ''))) {
  throw new Error('signer file does not contain a 32-byte private key')
}

async function loadCertificateHex(hexEnv: string, fileEnv: string): Promise<string | undefined> {
  let hex = process.env[hexEnv]
  if (!hex && process.env[fileEnv]) {
    hex = (await Bun.file(process.env[fileEnv]!).text()).trim()
  }
  if (!hex) return undefined
  if (hex.trim().startsWith('{')) {
    const parsed = JSON.parse(hex)
    hex = String(parsed?.certificateHex || '')
  }
  return hex.replace(/^0x/i, '')
}

const solanaCertificateHex = await loadCertificateHex('CLEARSIGN_SOLANA_CERTIFICATE_HEX', 'CLEARSIGN_SOLANA_CERTIFICATE_FILE')
if (!solanaCertificateHex) throw new Error('CLEARSIGN_SOLANA_CERTIFICATE_HEX/FILE is required')
const solanaCertificate = solanaCertificateHex ? inspectAlphaCertificate(solanaCertificateHex) : undefined
if (solanaCertificate && solanaCertificate.chainId !== CLEARSIGN_SCOPE_SOLANA) {
  throw new Error(`CLEARSIGN_SOLANA_CERTIFICATE_HEX is scoped to ${solanaCertificate.chainId}, expected Solana (${CLEARSIGN_SCOPE_SOLANA})`)
}

const solanaRpcEndpoint = process.env.CLEARSIGN_SOLANA_RPC_ENDPOINT || DEFAULT_SOLANA_RPC_ENDPOINT

const port = Number(process.env.CLEARSIGN_SIGNER_PORT || 1647)
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('invalid CLEARSIGN_SIGNER_PORT')

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), {
  status,
  headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
})

const server = Bun.serve({
  hostname: '127.0.0.1',
  port,
  async fetch(request) {
    const url = new URL(request.url)
    if (request.method === 'GET' && url.pathname === '/health') {
      return json({ ok: true, service: 'keepkey-clearsign', fingerprint: ALPHA_DELEGATE_FINGERPRINT })
    }
    if (request.method === 'GET' && url.pathname === '/signer') {
      return json({
        alias: solanaCertificate?.alias,
        fingerprint: signer.fingerprint,
        publicKeyHex: signer.publicKeyHex,
        keyId: 0x80,
        scopes: [CLEARSIGN_SCOPE_SOLANA],
      })
    }
    if (request.method === 'POST' && (url.pathname === '/v1/evm/schema' || url.pathname === '/sign')) {
      return json({ error: 'this signer is scoped to Solana only' }, 501)
    }
    if (request.method === 'POST' && url.pathname === '/v1/solana/certify') {
      if (!solanaCertificateHex) return json({ error: 'this signer has no Solana-scoped certificate loaded' }, 501)
      const contentLength = Number(request.headers.get('content-length') || 0)
      if (contentLength > 64 * 1024) return json({ error: 'request too large' }, 413)
      let body: any
      try {
        body = await request.json()
      } catch {
        return json({ error: 'invalid JSON' }, 400)
      }
      const rawTxBase64 = String(body?.rawTx || '')
      const catalogKey = String(body?.catalogKey || '')
      const spec = (CERTIFIED_SOLANA_CATALOG as any)[catalogKey]
      if (!rawTxBase64 || !spec) {
        return json({ error: 'rawTx and a recognized catalogKey are required' }, 400)
      }
      try {
        const fullTx = Buffer.from(rawTxBase64, 'base64')
        const parsedTx = parseSolanaTx(fullTx)
        const messageBytes = solanaMessageSlice(fullTx, parsedTx)
        const message = parseSolanaMessage(messageBytes)

        // Refuse to sign unless the exact instruction this schema describes
        // is actually present — a schema is never a blank check for "trust
        // whatever program this transaction touches".
        const programBytes = Buffer.from(bs58.decode(spec.programId))
        const matchesInstruction = message.instructions.some((ix) => {
          const programKey = message.staticAccounts[ix.programIdIndex]
          if (!programKey || !Buffer.from(programKey).equals(programBytes)) return false
          const data = Buffer.from(ix.data)
          return data.length >= spec.discriminator.length
            && data.subarray(0, spec.discriminator.length).equals(Buffer.from(spec.discriminator))
        })
        if (!matchesInstruction) {
          return json({ error: `catalog entry ${catalogKey} does not match any instruction in this transaction` }, 422)
        }

        const schema = signCertifiedSolanaSchema(solanaCertificateHex, signer.privateKeyHex, spec)

        // A self-contained legacy/v0 message commits every instruction account
        // directly in the signed bytes. It needs the certified instruction
        // schema, but there is no external account-resolution claim to sign.
        // Return no lutProof at all: an empty proof would be a different wire
        // statement and could hide accidental coupling between certification
        // and Relay's current transaction compiler.
        if (message.altEntries.length === 0) {
          return json({
            success: true,
            classification: 'VERIFIED',
            schema: {
              payload: schema.schemaPayload,
              signature: schema.schemaSignature,
              signerKeyId: schema.keyId,
            },
            certificate: `0x${solanaCertificateHex}`,
            alias: schema.alias,
            fingerprint: schema.fingerprint,
            transactionShape: message.version,
            lookupTableCount: 0,
          })
        }

        const lutResolution = await resolveCanonicalLutAccounts(message, createRpcAltFetcher(solanaRpcEndpoint))
        const messageHash = createHash('sha256').update(messageBytes).digest()
        const lutProof = signCertifiedSolanaLutAttestation(
          solanaCertificateHex,
          signer.privateKeyHex,
          messageHash,
          lutResolution.accounts,
        )
        return json({
          success: true,
          classification: 'VERIFIED',
          lutProof: {
            accounts: lutResolution.accounts.map((a) => a.toString('base64')),
            signature: lutProof.lutSignature,
            signerKeyId: lutProof.keyId,
          },
          schema: {
            payload: schema.schemaPayload,
            signature: schema.schemaSignature,
            signerKeyId: schema.keyId,
          },
          certificate: `0x${solanaCertificateHex}`,
          alias: lutProof.alias,
          fingerprint: lutProof.fingerprint,
          writableCount: lutResolution.writableCount,
          readonlyCount: lutResolution.readonlyCount,
          transactionShape: message.version,
          lookupTableCount: message.altEntries.length,
        })
      } catch (error: any) {
        return json({ error: error?.message || 'could not build certified Solana proof' }, 500)
      }
    }
    return json({ error: 'not found' }, 404)
  },
})

console.log(`[clearsign] local signer ready at http://${server.hostname}:${server.port}`)
console.log(`[clearsign] delegate ${solanaCertificate?.alias} · ${signer.fingerprint} (scopes: solana)`)
