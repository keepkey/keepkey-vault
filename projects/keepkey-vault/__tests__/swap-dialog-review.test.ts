import { expect, test } from 'bun:test'

test('swap review names the recipient, refuses burn addresses and gates high slippage', () => {
  const run = Bun.spawnSync([process.execPath, new URL('./support/swap-dialog-review.tsx', import.meta.url).pathname], {
    cwd: new URL('../', import.meta.url).pathname, stdout: 'pipe', stderr: 'pipe', timeout: 120000,
  })
  const stdout = run.stdout.toString()
  if (run.exitCode !== 0) throw new Error(run.stderr.toString() || stdout)
  const marker = 'SWAP_DIALOG_REVIEW_RESULT '
  const records = stdout.split(/\r?\n/).filter(line => line.startsWith(marker))
  if (records.length !== 1) throw new Error(`Expected one swap dialog fixture result, received ${records.length}\n${stdout}`)
  expect(JSON.parse(records[0].slice(marker.length))).toEqual({
    storedHighSlippageIgnored: true,
    backdropOpaqueEnough: true,
    panelOpaque: true,
    maxEnabledFromOnChainRead: true,
    accountOptionsShowOnChainBalance: true,
    burnRefused_0000: true,
    burnRefused_dEaD: true,
    badChecksumRefused: true,
    ownRecipientRowShown: true,
    relayCopyTruthful: true,
    customRecipientRowShown: true,
    relayMismatchLocked: true,
    ownCustomNotExternal: true,
    ownCustomReviewNotFlagged: true,
    highSlippageNotPersisted: true,
    lowSlippagePersisted: true,
    highSlippageNeedsConfirm: true,
    slippageAckSent: true,
    customSlippageResetAfterSwap: true,
    outputSwitchClearsError: true,
  })
}, 150000)
