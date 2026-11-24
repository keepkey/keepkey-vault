import type { VolumeImage, VolumeInventory } from '../shared/volumes'

/** Native operations on an image file owned by a Vault volume package. */
export interface VolumeBackend {
  filename: string
  inventory(): Promise<VolumeInventory>
  state(path: string): Promise<VolumeImage['state']>
  /** Consult OS attachments independently of whether the image header is readable. */
  isDetached(path: string): Promise<boolean>
  create(path: string, name: string, sizeMiB: number, credential: Buffer, recordId: string): Promise<void>
  unlock(path: string, credential: Buffer, recordId: string): Promise<void>
  lock(path: string): Promise<void>
  open(path: string): Promise<void>
}
