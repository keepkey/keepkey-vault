/** Existing alpha root only. Never creates a key, resets a device, or exports a seed. */
import { utils } from 'ethers'
import { Keyring } from '@keepkey/hdwallet-core'
import { NodeWebUSBKeepKeyAdapter } from '@keepkey/hdwallet-keepkey-nodewebusb'
import { HIDKeepKeyAdapter } from '@keepkey/hdwallet-keepkey-nodehid'
import { getDeviceList } from 'usb'
import { ALPHA_ROOT_PUBLIC_KEY, CLEARSIGN_DOMAIN_SEPARATOR, inspectAlphaCertificateBody,
  verifyAlphaRootSignature, CLEARSIGN_EVM_SCOPES } from '../src/bun/clearsign-alpha-ceremony'

const sign = process.argv.includes('--sign')
const requestPath = process.argv.find(x => x.startsWith('--request='))?.slice('--request='.length)
const outputPath = process.argv.find(x => x.startsWith('--output='))?.slice('--output='.length)
if (sign && (!requestPath || !outputPath)) throw new Error('--sign requires --request=PUBLIC_REQUEST.json and --output=PUBLIC_CERTIFICATE.json')
const request = requestPath ? await Bun.file(requestPath).json() : undefined
const inspection = request ? inspectAlphaCertificateBody(request.signedBodyHex, request.expectedMessageHashHex) : undefined
if (sign && !CLEARSIGN_EVM_SCOPES.some(scope => scope === inspection?.chainId)) throw new Error('This ceremony is restricted to the reviewed EVM chains')

const path = [0x8000002c, 0x8000003c, 0x80000000, 0, 0]
const keyring = new Keyring()
const usb = NodeWebUSBKeepKeyAdapter.useKeyring(keyring)
const hid = HIDKeepKeyAdapter.useKeyring(keyring)
// WebUSB getDevices() only lists devices granted access in this process.
// Count physical devices first, then request the one matching the KeepKey filter.
const physicalDevices = getDeviceList().filter(d => d.deviceDescriptor.idVendor === 0x2b24)
if (physicalDevices.length !== 1) throw new Error(`Connect exactly one physical root KeepKey (found ${physicalDevices.length})`)
const productId = physicalDevices[0].deviceDescriptor.idProduct
if (productId !== 1 && productId !== 2) throw new Error('KeepKey must be running normal firmware')
const adapter = productId === 2 ? usb : hid
const device = await adapter.getDevice()
const wallet: any = await adapter.pairRawDevice(device as any)
let signingStarted = false
try {
  const features = await wallet.getFeatures()
  if (!features.initialized) throw new Error('Root device is not initialized; do not reset it')
  if (features.passphraseProtection) throw new Error('Root ceremony requires the documented non-passphrase wallet')
  if (features.pinProtection && !features.pinCached) throw new Error('Unlock the root KeepKey in Vault before continuing')
  const address = await wallet.ethGetAddress({ addressNList: path, showDisplay: false })
  const rootMatches = address?.toLowerCase() === utils.computeAddress(`0x${ALPHA_ROOT_PUBLIC_KEY}`).toLowerCase()
  console.log(JSON.stringify({ deviceId: features.deviceId, firmware: `${features.majorVersion}.${features.minorVersion}.${features.patchVersion}`,
    path: "m/44'/60'/0'/0/0", address, rootMatches }, null, 2))
  if (!rootMatches) throw new Error('This is not the existing alpha root. No signing or policy change was attempted.')
  if (sign && inspection) {
    console.log(JSON.stringify({ alias: inspection.alias, chainId: inspection.chainId,
      expires: new Date(inspection.notAfter * 1000).toISOString(), delegatePublicKey: inspection.delegatePublicKey,
      domainHash: CLEARSIGN_DOMAIN_SEPARATOR, messageHash: inspection.messageHash }, null, 2))
    console.log('Review these public certificate fields and compare both hashes on the physical device before approving.')
    signingStarted = true
    await wallet.applyPolicy({ policyName: 'AdvancedMode', enabled: true })
    const signed = await wallet.ethSignTypedHash({ addressNList: path,
      domainSeparatorHash: CLEARSIGN_DOMAIN_SEPARATOR, messageHash: inspection.messageHash })
    const verified = verifyAlphaRootSignature(inspection, signed.signature)
    await Bun.write(outputPath!, JSON.stringify({ format: 'keepkey-clearsign-delegate-cert-v1', ...verified,
      chainId: inspection.chainId, alias: inspection.alias, notAfter: inspection.notAfter }, null, 2) + '\n')
    console.log(`Verified public certificate written to ${outputPath}`)
  }
} finally {
  if (signingStarted) await wallet.clearSession().catch(() => {})
  await wallet.disconnect()
}
