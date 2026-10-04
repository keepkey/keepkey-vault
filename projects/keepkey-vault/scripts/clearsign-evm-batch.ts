import { buildAlphaCertificateBody, inspectAlphaCertificate, inspectAlphaCertificateBody } from '../src/bun/clearsign-alpha-ceremony'

const chains = [[10, 'Optimism'], [8453, 'Base'], [137, 'Polygon'], [56, 'BNB Smart Chain'],
  [43114, 'Avalanche'], [100, 'Gnosis'], [130, 'Unichain'], [5000, 'Mantle'],
  [42170, 'Arbitrum Nova'], [80094, 'Berachain'], [81457, 'Blast']] as const
const directory = '../../docs/clearsign-case-studies/uniswap-usdt/evm-certificates'
const sign = process.argv.includes('--sign')
const requests = []
for (const [chainId, name] of chains) {
  const request = buildAlphaCertificateBody('KeepKey Alpha 716', 1798675200, chainId)
  const inspection = inspectAlphaCertificateBody(request.signedBodyHex, request.expectedMessageHashHex)
  const requestPath = `${directory}/${chainId}-request.json`
  const outputPath = `${directory}/${chainId}-certificate.json`
  await Bun.write(requestPath, JSON.stringify({ ...request, chainId, name, signingDigest: inspection.signingDigest }, null, 2) + '\n')
  requests.push({ chainId, name, requestPath, outputPath, messageHash: inspection.messageHash })
}
await Bun.write(`${directory}/review.json`, JSON.stringify(requests, null, 2) + '\n')
for (const request of requests) {
  console.log(JSON.stringify(request))
  if (!sign) continue
  if (await Bun.file(request.outputPath).exists()) {
    const saved = await Bun.file(request.outputPath).json()
    const certificate = inspectAlphaCertificate(saved.certificateHex)
    if (certificate.chainId !== request.chainId || certificate.messageHash !== request.messageHash) {
      throw new Error('Saved certificate does not match this reviewed request')
    }
    console.log(`Already verified: ${request.name}`)
    continue
  }
  const child = Bun.spawn([process.execPath, 'scripts/clearsign-root-ceremony.ts', '--sign',
    `--request=${request.requestPath}`, `--output=${request.outputPath}`], {
    stdin: 'inherit', stdout: 'inherit', stderr: 'inherit',
  })
  if (await child.exited !== 0) throw new Error(`Ceremony stopped at ${request.name}; completed certificates are saved`)
}
