/** Local/isolated transaction-bound Uniswap ClearSign provider.
 *
 * The key file is the provider-key JSON exported by ClearSign Studio. Keep it
 * outside Vault: this process receives final unsigned transactions, derives
 * every display page itself, and refuses anything incomplete.
 */
import { createUniswapRuntimeProvider, type UniswapRuntimeSigner } from '../src/bun/uniswap-runtime-envelope'

const path = process.env.CLEARSIGN_PROVIDER_KEY_FILE
if (!path) throw new Error('CLEARSIGN_PROVIDER_KEY_FILE is required')
const raw = await Bun.file(path).json() as UniswapRuntimeSigner
const signer = { ...raw, keyId: Number(process.env.CLEARSIGN_PROVIDER_KEY_SLOT || raw.keyId || 1) }
const port = Number(process.env.CLEARSIGN_PROVIDER_PORT || 1647)
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('CLEARSIGN_PROVIDER_PORT must be a valid port')

const server = Bun.serve({ hostname: '127.0.0.1', port, fetch: createUniswapRuntimeProvider(signer) })
console.log(`[uniswap-clearsign] ready at http://${server.hostname}:${server.port}`)
console.log(`[uniswap-clearsign] signer ${signer.alias} · ${signer.fingerprint} · RAM slot ${signer.keyId}`)
