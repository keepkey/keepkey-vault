/**
 * Interactive stdin prompts for CLI.
 */
import * as readline from 'readline'

function createInterface(): readline.Interface {
  return readline.createInterface({ input: process.stdin, output: process.stdout })
}

/** Prompt user for a line of text. */
export function readLine(prompt: string): Promise<string> {
  const rl = createInterface()
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => {
      rl.close()
      resolve(answer)
    })
  })
}

/** Prompt user for a line of text without echoing (for secrets). */
export function readLineHidden(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    process.stdout.write(prompt)
    const rl = readline.createInterface({ input: process.stdin, terminal: false })
    // Mute stdout so characters aren't echoed
    if (process.stdin.isTTY) process.stdin.setRawMode?.(false)
    rl.once('line', (line) => {
      rl.close()
      process.stdout.write('\n')
      resolve(line)
    })
  })
}

/** Ask y/N confirmation. Returns true only if user types "y" or "yes". */
export async function confirm(message: string): Promise<boolean> {
  const answer = await readLine(`${message} [y/N] `)
  return /^y(es)?$/i.test(answer.trim())
}
