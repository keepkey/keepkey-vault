// Firmware EVM guard (alpha PR #255): an EIP-1559 (type-2) tx with chain_id == 0
// over-declares the RLP list header (Stage-1 counts the chain_id field, Stage-2
// hashes nothing) -> wrong signer, so the firmware must REJECT it.
//
// NOT REACHABLE via the Vault REST path: the Vault normalizes chainId 0 -> 1
// before signing (rest-api.ts: `if (chainId === 0) chainId = 1`), so a type-2
// tx with chain_id 0 never reaches the device through this API. The firmware
// guard itself is covered at the device level by python-keepkey
// (test_msg_ethereum_signing_guards). Kept as a documented skip so the rest of
// the evm-firmware suite stays green and the rationale is recorded next to it.
console.log('\n=== EIP-1559 chain_id 0 guard — SKIPPED (unreachable via Vault REST) ===\n')
console.log('  The Vault normalizes chainId 0 -> 1 before signing, so a type-2')
console.log('  chain_id 0 tx never reaches the device. The firmware guard is')
console.log('  validated by python-keepkey integration tests instead.')
console.log('  No device interaction performed.\n')
process.exit(0)
