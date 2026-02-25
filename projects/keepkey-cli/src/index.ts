#!/usr/bin/env bun
/**
 * keepkey-cli — Direct device access CLI for KeepKey hardware wallets.
 *
 * Uses @keepkey/hdwallet-* packages for HID/WebUSB dual-transport
 * device communication. No REST API dependency.
 */

const [command, ...args] = process.argv.slice(2)

if (!command || command === 'help' || command === '--help' || command === '-h') {
  console.log(`
keepkey-cli — KeepKey hardware wallet CLI

Usage:
  keepkey <command> [options]

Commands:
  features              Show device features (model, firmware, PIN, etc.)
  initialize [12|18|24] Initialize device with new seed
  wipe                  Wipe device (factory reset)
  load-seed             Load mnemonic seed onto device
  pin <set|change|remove>  PIN operations
  label <name>          Set device label
  passphrase <on|off>   Enable/disable passphrase
  firmware <path>       Flash firmware binary (device must be in bootloader)
  firmware-info         Firmware diagnostic (version, hash, signed/unsigned)
  address <coin>        Get address (bitcoin, ethereum, cosmos, etc.)
  help                  Show this help

Options:
  --mnemonic "words"    Mnemonic for load-seed command
  --show                Show address on device display (address command)

Examples:
  keepkey features
  keepkey address bitcoin
  keepkey address ethereum --show
  keepkey load-seed --mnemonic "abandon abandon ... about"
  keepkey pin set
  keepkey label "My KeepKey"
  keepkey firmware path/to/firmware.bin
`)
  process.exit(0)
}

try {
  switch (command) {
    case 'features': {
      const { featuresCommand } = await import('./commands/features')
      await featuresCommand()
      break
    }
    case 'initialize': {
      const { initializeCommand } = await import('./commands/initialize')
      await initializeCommand(args)
      break
    }
    case 'wipe': {
      const { wipeCommand } = await import('./commands/wipe')
      await wipeCommand()
      break
    }
    case 'load-seed': {
      const { loadSeedCommand } = await import('./commands/load-seed')
      await loadSeedCommand(args)
      break
    }
    case 'pin': {
      const { pinCommand } = await import('./commands/pin')
      await pinCommand(args)
      break
    }
    case 'firmware': {
      const { firmwareCommand } = await import('./commands/firmware')
      await firmwareCommand(args)
      break
    }
    case 'firmware-info': {
      const { firmwareInfoCommand } = await import('./commands/firmware-info')
      await firmwareInfoCommand()
      break
    }
    case 'label': {
      const { labelCommand } = await import('./commands/label')
      await labelCommand(args)
      break
    }
    case 'passphrase': {
      const { passphraseCommand } = await import('./commands/passphrase')
      await passphraseCommand(args)
      break
    }
    case 'address': {
      const { addressCommand } = await import('./commands/address')
      await addressCommand(args)
      break
    }
    default:
      console.error(`Unknown command: ${command}`)
      console.error('Run "keepkey help" for available commands.')
      process.exit(1)
  }
} catch (err: any) {
  console.error(`Error: ${err.message}`)
  process.exit(1)
}
