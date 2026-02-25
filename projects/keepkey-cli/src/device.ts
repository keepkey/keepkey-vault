/**
 * Device connection helper — connect + get features in one call.
 * Used by all CLI commands that need a paired device.
 */
import { connectDevice, type ConnectResult } from './util/transport'

export interface DeviceConnection extends ConnectResult {
  features: any
}

export async function getDevice(): Promise<DeviceConnection> {
  const { wallet, transport } = await connectDevice()
  const features = await wallet.getFeatures()
  return { wallet, transport, features }
}
