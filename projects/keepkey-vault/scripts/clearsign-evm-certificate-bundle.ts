import { CLEARSIGN_EVM_SCOPES, inspectAlphaCertificate } from '../src/bun/clearsign-alpha-ceremony'

const root = '../../docs/clearsign-case-studies/uniswap-usdt'
const certificates: Record<string, string> = {}
for (const chainId of CLEARSIGN_EVM_SCOPES) {
  // Mainnet remains in its existing dedicated worker binding.
  if (chainId === 1) continue
  const path = chainId === 42161 ? `${root}/arbitrum-certificate.json`
    : `${root}/evm-certificates/${chainId}-certificate.json`
  const saved = await Bun.file(path).json()
  const certificate = inspectAlphaCertificate(saved.certificateHex)
  if (certificate.chainId !== chainId) throw new Error(`Wrong certificate scope in ${path}`)
  certificates[String(chainId)] = saved.certificateHex
}
await Bun.write(`${root}/evm-certificates/worker-public-certificates.json`, JSON.stringify(certificates, null, 2) + '\n')
console.log(`Verified ${Object.keys(certificates).length} certificates; existing mainnet certificate retained separately.`)
