/** Presentation codes travel over RPC; English messages remain useful diagnostics. */
export const FIRMWARE_PROGRESS_KEYS = {
  startingBootloader: 'setup:bootloader.updatingBootloader',
  loadingBootloader: 'setup:bootloader.updatingBootloader',
  confirmErase: 'setup:firmware.confirmOnDevice',
  uploadBootloader: 'setup:bootloader.followDirectionsOnDevice',
  bootloaderUploaded: 'setup:bootloader.deviceWillGuide',
  complete: 'common:done',
  failed: 'setup:bootloader.updateFailed',
  startingFirmware: 'setup:firmware.updatingFirmware',
  loadingFirmware: 'setup:firmware.updatingFirmware',
  verified: 'setup:firmware.firmwareVerified',
  uploadFirmware: 'setup:firmware.uploadingFirmware',
  rebooting: 'setup:firmware.deviceRebooting',
  preparingCustom: 'setup:firmware.updatingFirmware',
} as const
export type FirmwareProgressStage = keyof typeof FIRMWARE_PROGRESS_KEYS
