/** Read-only Base Safe preparation. No signing, policy changes or broadcast. */
import { mkdir, readFile, writeFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { utils, BigNumber } from 'ethers'

const arg = (name: string) => process.argv.find((x) => x.startsWith(`--${name}=`))?.slice(name.length + 3)
const output = arg('output')
const records = arg('deployments')
const owner = arg('keepkey-owner')
const cosigner = arg('cosigner')
const saltNonce = arg('salt-nonce')
if (!output || !records || !owner || !cosigner || !saltNonce) {
  throw new Error('Required: --output=DIR --deployments=DIR --keepkey-owner=ADDRESS --cosigner=ADDRESS --salt-nonce=UINT256')
}
const endpoints = [arg('rpc') ?? 'https://mainnet.base.org', 'https://base-rpc.publicnode.com']
const chainId = 8453
const from = utils.getAddress(owner)
const owners = [from, utils.getAddress(cosigner)].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()))
if (owners[0] === owners[1] || owners.includes(utils.getAddress(utils.hexZeroPad('0x00', 20)))) throw new Error('Two distinct nonzero owners required')
const nonce = BigNumber.from(saltNonce)
if (nonce.lt(0) || nonce.gte(BigNumber.from(2).pow(256))) throw new Error('Invalid salt nonce')
const threshold = 2
const zero = utils.getAddress(utils.hexZeroPad('0x00', 20))
let sequence = 0
async function rpc(endpoint: string, method: string, params: unknown[]) {
  const allowed = ['eth_chainId', 'eth_getBlockByNumber', 'eth_getCode', 'eth_call', 'eth_estimateGas',
    'eth_getBalance', 'eth_getTransactionCount', 'eth_maxPriorityFeePerGas']
  if (!allowed.includes(method)) throw new Error('Preparation permits read-only RPC methods only')
  const response = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++sequence, method, params }), signal: AbortSignal.timeout(20_000) })
  if (!response.ok) throw new Error(`${method}: HTTP ${response.status}`)
  const body = await response.json() as any
  if (body.error) throw new Error(`${method}: ${JSON.stringify(body.error)}`)
  return body.result
}
await mkdir(output, { recursive: true })
if ((await readdir(output)).length) throw new Error('Output directory must be empty')
const block = await rpc(endpoints[0], 'eth_getBlockByNumber', ['latest', false])
const deployments: Record<string, any> = {}
for (const name of ['safe_proxy_factory', 'safe_l2', 'compatibility_fallback_handler']) {
  const record = JSON.parse(await readFile(join(records, `${name}.json`), 'utf8'))
  if (record.version !== '1.4.1' || record.networkAddresses[String(chainId)] !== 'canonical') throw new Error(`Unexpected deployment ${name}`)
  const deployment = record.deployments.canonical
  const evidence = []
  for (const endpoint of endpoints) {
    if (Number(await rpc(endpoint, 'eth_chainId', [])) !== chainId) throw new Error('RPC chain mismatch')
    const code = await rpc(endpoint, 'eth_getCode', [deployment.address, block.number])
    const codeHash = utils.keccak256(code)
    if (codeHash !== deployment.codeHash) throw new Error(`Deployment code hash mismatch: ${name}`)
    evidence.push({ endpoint, blockNumber: block.number, codeHash })
  }
  deployments[name] = { address: deployment.address, codeHash: deployment.codeHash, evidence, abi: record.abi }
}
const factory = deployments.safe_proxy_factory
const singleton = deployments.safe_l2
const handler = deployments.compatibility_fallback_handler
const safeInterface = new utils.Interface(singleton.abi)
const factoryInterface = new utils.Interface(factory.abi)
const initializer = safeInterface.encodeFunctionData('setup', [owners, threshold, zero, '0x', handler.address, zero, 0, zero])
const proxyCreationResult = await rpc(endpoints[0], 'eth_call', [{ to: factory.address,
  data: factoryInterface.encodeFunctionData('proxyCreationCode') }, block.number])
const [proxyCreationCode] = factoryInterface.decodeFunctionResult('proxyCreationCode', proxyCreationResult)
const deploymentCode = utils.hexConcat([proxyCreationCode, utils.defaultAbiCoder.encode(['address'], [singleton.address])])
const salt = utils.keccak256(utils.hexConcat([utils.keccak256(initializer), utils.hexZeroPad(nonce.toHexString(), 32)]))
const safeAddress = utils.getCreate2Address(factory.address, salt, utils.keccak256(deploymentCode))
if (await rpc(endpoints[0], 'eth_getCode', [safeAddress, block.number]) !== '0x') throw new Error('Predicted address already deployed')
const data = factoryInterface.encodeFunctionData('createProxyWithNonce', [singleton.address, initializer, nonce])
const transaction = { from, to: factory.address, value: '0x0', data }
const simulated = await rpc(endpoints[0], 'eth_call', [transaction, block.number])
const [simulatedAddress] = factoryInterface.decodeFunctionResult('createProxyWithNonce', simulated)
if (utils.getAddress(simulatedAddress) !== safeAddress) throw new Error('CREATE2 prediction differs from Base eth_call')
const estimate = BigNumber.from(await rpc(endpoints[0], 'eth_estimateGas', [transaction]))
const gasLimit = estimate.mul(120).add(99).div(100)
const priority = BigNumber.from(await rpc(endpoints[0], 'eth_maxPriorityFeePerGas', []))
const maxFeePerGas = BigNumber.from(block.baseFeePerGas).mul(2).add(priority)
const balance = BigNumber.from(await rpc(endpoints[0], 'eth_getBalance', [from, block.number]))
const accountNonce = await rpc(endpoints[0], 'eth_getTransactionCount', [from, 'pending'])
const review = {
  status: 'prepared; unsigned and not deployed', chainId, network: 'Base', safeVersion: '1.4.1', safeAddress,
  owners, threshold, keepkeyOwner: from, saltNonce: nonce.toString(),
  setup: { delegatecallTarget: zero, delegatecallData: '0x', fallbackHandler: handler.address,
    paymentToken: zero, payment: '0', paymentReceiver: zero, modules: [], guard: zero },
  verification: { blockNumber: block.number, blockHash: block.hash, simulatedAddress,
    source: 'safe-global/safe-deployments@685f22be940739259cfc4148db3df7048f39a4e8',
    sourceUrl: 'https://github.com/safe-global/safe-deployments/tree/685f22be940739259cfc4148db3df7048f39a4e8/src/assets/v1.4.1',
    deployments: Object.fromEntries(Object.entries(deployments).map(([name, { abi, ...evidence }]) => [name, evidence])) },
  feeEstimate: { gas: estimate.toString(), gasLimit: gasLimit.toString(), maxFeePerGas: maxFeePerGas.toString(),
    maxPriorityFeePerGas: priority.toString(), maximumExecutionFeeEth: utils.formatEther(gasLimit.mul(maxFeePerGas)),
    excludesBaseL1DataFee: true, observedBalanceEth: utils.formatEther(balance), refreshBeforeSigning: true },
  transaction: { ...transaction, chainId, nonce: accountNonce, gasLimit: gasLimit.toHexString(),
    maxFeePerGas: maxFeePerGas.toHexString(), maxPriorityFeePerGas: priority.toHexString(), type: 2 },
  afterDeployment: ['Verify proxy implementation, both owners, threshold 2, handler, empty modules, and no guard on Base.',
    'Activate only the signed metadata for this exact chain and Safe address.'],
}
await writeFile(join(output, 'safe-deployment-review.json'), JSON.stringify(review, null, 2) + '\n')
await writeFile(join(output, 'setup-calldata.hex'), initializer + '\n')
console.log(JSON.stringify({ safeAddress, owners, threshold, gasEstimate: estimate.toString(), output }))
