# Native Base Safe UI

The connected-wallet navigation includes **Multisig**. The tab is hidden for
Bitcoin-only firmware and watch-only views. Vault cards appear on the wallet
landing page as saved snapshots. The connected portfolio does not show this panel. Bitcoin
vaults use a Bitcoin-only shield; Base Safes use a Base shield and chain ID 8453.

## Operator flow

1. Open Multisig. If Pioneer does not expose contract reads, choose a Base RPC
   using **Verify & use RPC**. This explicitly updates the Base simulation RPC
   setting; there is no silent public-node fallback.
2. Choose **Create a Safe → Load prepared setup** and select
   `deployment/safe-deployment-review.json` from this handoff directory.
3. Review the two owners, threshold **2 of 2**, and predicted address
   `0x57c193Ea42ae3992D1350099670D672c4dA4f9D9`. The UI re-verifies pinned v1.4.1
   bytecode and simulates deployment using fresh fees.
   **Save setup for later** adds an undeployed vault to the directory and address
   book without signing. Its funding and certification remain disabled until
   deployment is confirmed. **Review deployment** resumes that exact salt/setup.
4. Only **Confirm on KeepKey & submit** requests the deployment signature and
   broadcasts the exact reviewed transaction. No deployment occurred during QA.
5. Refresh after confirmation. The account view shows ETH, native Base USDC,
   current owners, threshold, and nonce.
6. Create an ETH or USDC transfer proposal, review it, approve with KeepKey, and
   export the proposal JSON. The second owner imports the Safe and proposal,
   approves it, and returns the exported JSON. Importing approvals verifies all
   EIP-712 signatures against the current owners and on-chain transaction hash.
   Importing a Safe has a separate full owner/threshold review, followed by an
   on-chain recheck before the reviewed configuration is saved.
7. Once the threshold is met, **Review execution** simulates execution and opens
   a separate transaction review. The connected account pays execution gas.

## Scope and readiness

- Base only; creates SafeL2 v1.4.1 and imports pinned SafeL2 v1.4.1 / v1.5.0; direct ETH and native Base USDC transfers.
- Proposal exchange uses the `keepkey-safe-v1` JSON format. Safe Transaction
  Service synchronization, arbitrary calls/batches, contract-owner signatures,
  and owner/module management are outside this first UI release.
- Only canonical 65-byte EIP-712 EOA signatures are accepted. Safe gas refunds
  and delegatecalls are rejected by the proposal boundary.
- Standard-wallet accounts/proposals are saved per device and seed identity.
  Hidden-wallet data stays in RAM and is cleared at session end or seed change.
- Pending deployment/execution links are submissions; they are not presented as
  confirmed payments. Refresh reads the deployed account and nonce again.
- Execution gas estimates exclude Base's additional L1 data fee. Reviews expire
  after five minutes and bind signer, chain, destination, data, value, nonce,
  gas limit and gas price. Legacy transaction signing avoids the known
  EIP-1559 firmware issue for chain IDs above 255.
- The connected 7.16.0 firmware lacks capability 28 for nested Safe ClearSign.
  The UI says hardware descriptions may be limited. Rich certified descriptions
  still require the prepared firmware support and issuer-signed metadata. The
  metadata bundle in this handoff remains unsigned and unpublished.

## Validation

- 17 backend security tests: deterministic preparation, duplicate owners,
  pinned bytecode, hidden-session isolation, async device switches, exact USDC
  decoding, tampered proposals, nonowner signatures, sorted owner approvals,
  fresh nonce/owner checks, bound broadcasts, expiry, and retry deduplication.
- Bitcoin-only boundary regression suite and existing Safe ClearSign tests pass.
- Browser smoke checks cover visible navigation, explicit provider selection,
  prepared setup import, exact-address deployment review, no signing before
  confirmation, Safe import, recoverable transfer errors, and narrow layouts.
  Browser data is injected by an external test harness, not shipped in the app.
- Read-only live Base preparation reproduces the approved predicted address;
  signing and broadcast are prohibited by that smoke check.
- Backend and frontend bundles build. The repository-wide TypeScript check has
  existing unrelated failures; no diagnostics point to the new Safe modules.

Local QA logs and screenshots: `/tmp/kk-safe-ui-*`.

## Vault identity and funding protection

Every vault carries an exact CAIP-2 network, CAIP-10 account identity, and managed
CAIP-19 assets. Base entries are never collapsed across EVM networks. The initial
managed assets are:

| Vault | Network | Managed asset |
| --- | --- | --- |
| Base Safe | `eip155:8453` | `eip155:8453/slip44:60` (ETH, 18 decimals) |
| Base Safe | `eip155:8453` | `eip155:8453/erc20:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913` (native USDC, 6 decimals) |
| Bitcoin multisig | `bip122:000000000019d6689c085ae165831e93` | `bip122:000000000019d6689c085ae165831e93/slip44:0` (BTC, 8 decimals) |

Known vault destinations reject another network, unsupported token contracts
(including bridged USDC), and unconfirmed deployments. These checks run in the
recipient picker/form, transaction build, EVM signing, and EVM broadcast paths;
broadcast checks parse the signed bytes rather than trusting form labels. Safe
proposal import and execution also pass the destination boundary.

Funding a known Safe rechecks its proxy/implementation, owners and threshold.
Control reads use one fixed Base block. Configuration changes block funding and
owner signing until a separate owner review and explicit import confirmation.
These are checks of the latest observed state, not an on-chain guarantee against
control changes after signing. Sending from other applications is outside this UI
boundary.

## Address book and ClearSign

The address book has a **Vaults** tab. Vault entries show their network, exact
assets, threshold and full cosigner addresses or Bitcoin fingerprints, paths and
xpubs. They remain separate from personal-wallet and saved-recipient rows. The
projection has its own SQLite table, preserving the existing contacts/history
schema; hidden-wallet vaults remain RAM-only. Repeated device copies resolve to
the latest reviewed identity. Forgetting a device removes its Safe projection
and stored Safe account settings.

Confirmed Base vault destinations participate in the existing hardware-reviewed
address-book certification flow, using an explicit `Base Safe ...` label. Review
shows the exact network and address. Drafts and configuration changes awaiting
review cannot be certified, even under an older ordinary-contact alias.

The v1 certificate authenticates only destination label + address + network. It
does **not** certify cosigners, threshold, deployment code or supported tokens.
The UI states that scope. Bitcoin vaults continue to use device policy verification;
they are excluded from the EVM destination-certificate flow. Current physical
firmware/attestor support and the user's final device approval are still required.
No destination certificate or issuer catalog was signed during this implementation.

## Extended validation

- 82 tests pass across Safe account/proposal controls, vault identity and SQLite
  projection, address-book ClearSign, Bitcoin-only boundaries, Safe ClearSign,
  Bitcoin policy/device enrollment and feature gates.
- Browser checks pass for landing-page snapshots, Bitcoin/Base
  badges, exact CAIP/token identities, address-book cosigners, explicit import
  owner review, undeployed saved drafts, certificate review scope, no signing
  before final confirmation, and narrow layouts.
- Updated screenshots/logs: `/tmp/kk-vault-identities-*`.

## Add an existing vault from wallet select

**Vaults → Add vault** is available on the wallet-select page, including without
an attached device. Choose the exact network, paste the Safe contract address,
and name it. The verification RPC is explicit (Base's official public endpoint
by default). Verification checks the chain ID, proxy and singleton runtime code
hashes, version, owners and threshold. All control reads use one fixed block.
The owner review precedes saving; the server rechecks its original snapshot at
confirmation. A changed configuration, expired review or wallet-session switch
cannot be saved under the previous review.

Saving adds the public identity to the landing-page directory and address book.
Hidden-session additions stay in RAM. Opening a directory-only entry from a
connected wallet pre-fills that exact Safe's import review instead of selecting
another saved account. Bitcoin imports route to the existing device-verified
policy flow; Base imports are blocked by Bitcoin-only firmware boundaries.

The supplied `0x6717d97655d8fC9d05C2DD3F28b54f574309B473` was independently checked
on Base as SafeL2 v1.5.0, threshold 2, four owners. One owner is the previously
connected KeepKey's account-0 address. The read-only snapshot is in
`existing-safe-6717d976.json`. It has not been saved to the live app by QA, signed,
or broadcast. Review and confirm it through Add vault.

Version 1.5.0 trust roots come from
`safe-global/safe-deployments@685f22be940739259cfc4148db3df7048f39a4e8`
(`src/assets/v1.5.0/safe_l2.json`) and independently matching published artifacts
from `@safe-global/safe-smart-account@1.5.0`. Runtime hashes, rather than the
self-reported VERSION string alone, determine support.

Additional QA covers device-free import, v1.5.0 bytecode, owner drift between
review and confirmation, hidden-session boundaries, expiry, wrong networks and
invalid addresses. Browser checks cover the wallet-select Add action, all four
owner addresses, exact version/network, recoverable errors, explicit confirmation,
narrow layouts and Bitcoin-only keyboard behavior. QA files: `/tmp/kk-add-vault-*`.

## Use a vault from an asset page

Base and Bitcoin asset pages include **Account → Add vault**. The account selector
lists only vaults that manage that exact chain and asset. Selecting a vault replaces
the personal-wallet asset view with its own verified identity and balance; missing,
changed or unverified accounts never fall back to the personal wallet.

Base receive requests include chain ID 8453. USDC QR codes target the native USDC
contract and put the selected account in the transfer recipient parameter. Switching
back to a personal account preserves that token identity and uses its own balance.

Safe sends open proposals bound to the selected Safe and asset, then use the normal
owner approval and execution reviews. Bitcoin sends accept a coordinator PSBT bound
to the selected verified policy; native multisig coin selection and PSBT construction
are not included. Bitcoin balances remain explicitly unverified here.

119 focused tests pass, including Safe controls, vault import/address book,
chain/asset/source binding, ClearSign and Bitcoin policy/PSBT regressions. Browser
checks exercise the actual AssetPage, decode both ETH and USDC QR images, reject a
wrong-account response, check a vault USDC proposal and switch back to the personal
USDC account. No hardware signing or broadcast occurs. QA files:
`/tmp/kk-vault-source-*`. The temporary browser entry point is removed before packaging.


## Wallet tiles and account-scoped swaps (November 5)

The wallet selector uses the same tile component for wallets and vaults, inside
one grid above import/support controls. Named color chips link a Safe to saved
wallets whose cached EVM address exactly matches a cosigner, or a Bitcoin policy
to an exact cached account xpub. Names/fingerprints alone never establish a link;
hidden-session vaults never attach metadata to saved wallet tiles.

Vault import and saved-identity dialogs use a bounded shell with a scrolling body
and fixed header/actions. The full vault address and cosigners stay in the main
review, while exact network/asset CAIPs are expandable. Browser checks verify
matching tile dimensions and visible review/close controls at 390×540.

Swap Available/MAX, gas checks and source-picker tiles now read the same selected
EVM account snapshot. Missing owner data cannot borrow aggregate chain amounts.
The input form and picker show the account index and full address. A delayed
initial account response cannot overwrite a newer pushed account state. Browser
checks reproduce the 121.5076-versus-1435.923181 discrepancy with controlled data,
then verify consistent account-specific amounts and switching.

Destination preflight allows 60 seconds instead of five and no longer opens a
hardware Safe-owner session just to verify a public recipient. Pinned code,
network, token and control checks still apply during preflight and transaction
boundaries. Progress, retry, and clearing old failures on recipient edits are
covered by browser checks with a deliberately slow response. No funds are sent.

QA artifacts: `/tmp/kk-vault-tiles-browser`, `/tmp/kk-usdc-swap-browser`,
`/tmp/kk-vault-send-browser`. Temporary preview entry points are removed before packaging.


The SDK raw POST transport now selects `signingTimeoutMs` for all
`/<namespace>/sign*` routes, including binary responses and auth retries;
explicit per-request overrides still win. Existing typed signing helpers already
pass that longer timeout. The current worktree's 31-minute review/device budget
is preserved. SDK build, auth tests, timeout routing and transaction-contract
regressions pass. This SDK change is local and has not been published.
