// PR #694 review: the stored English default own label ("My RUNE") must follow the
// language everywhere it shows, including search and the edit field.
import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

test('search, edit and save follow the language for the default own label', () => {
  const run = Bun.spawnSync([process.execPath, fileURLToPath(new URL('./support/addressbook-own-label.tsx', import.meta.url))], {
    cwd: fileURLToPath(new URL('../', import.meta.url)), stdout: 'pipe', stderr: 'pipe', timeout: 30000,
  })
  if (run.exitCode) throw new Error(run.stderr.toString() || run.stdout.toString())
  expect(JSON.parse(run.stdout.toString().trim().split('\n').at(-1)!)).toEqual({
    // The picker's search matches the label shown after a language switch.
    pickerFindsTranslated: true,
    // The edit field starts from what is shown, not the stored English default.
    editPrefill: 'Meu RUNE',
    // Saving it unchanged keeps the stored default, so it still follows the language.
    savedUnchanged: 0,
    savedEdited: ['Cofre RUNE'],
  })
}, 35000)

test('the Zcash send tab shows the translated own label', () => {
  const source = readFileSync(fileURLToPath(new URL('../src/mainview/components/ZcashPrivacyTab.tsx', import.meta.url)), 'utf8')
  expect(source).toContain('addressBookLabel(matchedContact, t)')
  expect(source).not.toContain('{matchedContact.label ||')
})
