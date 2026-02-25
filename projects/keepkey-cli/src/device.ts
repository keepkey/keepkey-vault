/**
 * Device connection helper — connect + get features in one call.
 * Sets up PIN and passphrase handlers for interactive CLI use.
 */
import * as core from '@keepkey/hdwallet-core'
import { connectDevice, type ConnectResult } from './util/transport'
import { readLine } from './util/prompt'

export interface DeviceConnection extends ConnectResult {
  features: any
}

/**
 * Register transport event handlers for PIN and passphrase prompts.
 * The hdwallet transport emits these when the device requests input.
 */
function registerDeviceHandlers(wallet: core.HDWallet & Record<string, any>): void {
  const transport = (wallet as any).transport

  if (transport?.on) {
    transport.on('PIN_REQUEST', async () => {
      console.log('\n--- Device requires PIN ---')
      console.log('Enter PIN using the 3x3 grid layout shown on your device:')
      console.log('  7 8 9')
      console.log('  4 5 6')
      console.log('  1 2 3')
      const pin = await readLine('PIN: ')
      if (pin.trim()) {
        await wallet.sendPin(pin.trim())
      }
    })

    transport.on('PASSPHRASE_REQUEST', async () => {
      console.log('\n--- Device requires passphrase ---')
      const passphrase = await readLine('Passphrase (leave empty for default wallet): ')
      await wallet.sendPassphrase(passphrase)
    })
  }
}

export async function getDevice(): Promise<DeviceConnection> {
  const { wallet, transport } = await connectDevice()
  registerDeviceHandlers(wallet)
  const features = await wallet.getFeatures()
  return { wallet, transport, features }
}
