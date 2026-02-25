import { getDevice } from '../device'

export async function pinCommand(args: string[]) {
  const action = args[0]

  if (!action || !['set', 'change', 'remove'].includes(action)) {
    console.error('Usage: keepkey pin <set|change|remove>')
    process.exit(1)
  }

  const { wallet } = await getDevice()

  switch (action) {
    case 'set':
    case 'change':
      console.log('Follow the PIN prompts on your KeepKey device.')
      await wallet.changePin()
      console.log('PIN updated.')
      break

    case 'remove':
      console.log('Removing PIN... Confirm on your KeepKey.')
      await wallet.removePin()
      console.log('PIN removed.')
      break
  }

  process.exit(0)
}
