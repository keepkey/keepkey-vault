# ClearSign live auditing and coverage

Status: working architecture, 2026-09-19

## Goal

Protect users at the moment they are asked to sign, while turning every unknown
EVM call or Solana instruction into a privacy-preserving demand signal for the
next coverage decision.

The goal is not “have a large catalog.” It is:

1. show what can be proven about this exact request now;
2. refuse to turn an unproven interpretation into a trusted device label;
3. learn which unknown shapes users actually encounter;
4. audit the highest-impact shapes with reproducible evidence;
5. publish, expire, and revoke device-verifiable descriptions; and
6. measure how often users receive each protection level.

## System ownership

The **ClearSign Report is a Vault capability**. Vault owns normalization of the
signing request, simulation, decoded effects, risk findings, evidence quality,
limitations, the P0-P5 verdict, local demand telemetry, and the live-audit
trigger. Every signing surface should consume the same report rather than
independently deciding what a transaction means.

Firmware is the final enforcement and trusted-display boundary. ERC-7730,
KKSOLSC1, certificates, code identities, registries, RPC simulations, and audit
jobs are evidence inputs to the Vault report. A signed artifact can raise a
report to P4/P5 only after the device accepts that artifact for the exact bytes;
finding an artifact in a host registry is not authentication.

The public distribution worker is keyless. Offline ceremony output is loaded
as an immutable artifact manifest; the worker re-verifies certificate scope and
expiry, the delegate signature, and exact equality with the reviewed catalog
before serving the original bytes. Revoked entries and any substituted bytes
fail closed. Solana transactions using address lookup tables are not certified
by this static service because their resolved accounts require a signature
bound to the exact transaction; supporting those safely requires an isolated
online signer or HSM, not a reusable delegate key in the edge worker.

## Where the current system really stands

The repository already has important pieces:

- firmware-enforced EVM and Solana schema formats;
- a root/delegate certificate chain and scope separation;
- exact-shape matching that fails closed;
- a signing worker that does not accept arbitrary descriptions;
- host-side risk rules and Solana post-state simulation;
- ClearSign Studio for authoring and device-attested evidence; and
- durable `clearsign_events` records for metadata that reached a device.

Vault now joins those pieces into a first live coverage loop for REST,
WalletConnect, and Vault swap EVM/Solana transaction requests: pre-sign effect reports,
privacy-safe observations, request-weighted P0-P5 metrics, a deduplicated audit
queue, and automatic public-chain identity snapshots. Identity snapshots are
evidence only and never self-promote into an authenticated definition.

An authenticated `POST /clearsign/report` request and the Vault swap-preview
report path also enqueue and immediately attempt an audit when no current
promoted artifact applies. These report-only demands increment the deduplicated
audit job's demand count and exposure priority but are deliberately not inserted
into `clearsign_observations`; therefore asking for analysis cannot inflate or
depress the signing-coverage denominator. A later signing attempt remains its
own independently finalized observation.

An authenticated `POST /clearsign/promotion/fixture-plan` request accepts an
explicitly opted-in or operator-reproduced instruction payload and generates
the positive fixture plus all chain-required adversarial vectors. For EVM this
includes truncation, selector, field, and chain/contract mutations; for Solana
it includes truncation, discriminator, field, and account-privilege mutations.
The response contains raw vectors so an operator can run the real device oracle,
but the plan is transient: promotion storage accepts only payload/meaning/effect
hashes, mutation result hashes, and the device transcript hash. Ordinary signing
requests are never copied into this workflow.

`runClearSignDeviceOracle` is the transport-independent evidence judge for
those vectors. A Vault, emulator, or hardware harness supplies the executor and
must return a digest of the ordered screens actually rendered by firmware. The
positive vector must render; reject mutations must be refused; field mutations
must render a different screen digest. The resulting transcript contains only
vector hashes, outcomes, screen digests, firmware version, and artifact hash.
A transport failure or unchanged display fails the oracle closed. Raw vectors
are intentionally excluded from the transcript and promotion bundle.

Swap review displays separate reports for an ERC-20 approval and the subsequent
swap call. Both signatures are counted independently because an approval is a
real authority change, not an implementation detail of the swap.

The certified production catalog on the current branch contains two EVM shapes
(Relay and Portals) and two Solana shapes (Relay native/token deposits). The
local test registries contain one EVM shape and two Solana shapes. Vault PR #450
adds one SoltoshiDICE Cee-lo instruction. The live case study found nine distinct
instruction shapes in 21 signing requests; the most frequently used shape was
unknown.

`clearsign_events` remains an evidence log for material that reached a device;
it is not the coverage denominator. `clearsign_observations` records every
eligible request, including unknown shapes, and is the source for request-
weighted coverage. REST, swaps, direct Vault RPC, and WalletConnect now promote
an observation to certified only after successful device acceptance of the
attached artifact.

## Protection spectrum

Coverage is not boolean. Every signing request must be assigned the highest
level actually proven for that request:

| Level | User protection | Authority | Honest UI language |
|---|---|---|---|
| P0 | Malformed or policy-forbidden request is rejected | Host and firmware | “Blocked” |
| P1 | Request bytes and destination are shown, but semantics are unknown | Firmware | “Blind / unknown” |
| P2 | Known primitive operations and payload-only risks are decoded | Host decoder | “Checked on this computer” |
| P3 | Likely asset effects are simulated, with failures and blind spots explicit | Selected RPC/node | “Simulation predicts…” |
| P4 | Names and fields are authenticated and independently decoded from the exact bytes | Firmware + certified definition | “Authenticated by KeepKey” |
| P5 | P4 plus code/version binding, expiry, monitoring, and revocation | Firmware + catalog operations | “Authenticated for this deployed code” |

P2 and P3 can raise risk or improve an unknown-request warning. They must never
be presented as P4, and they must never lower a firmware or payload-derived risk.

### Concrete protection already demonstrated

The 2026-09-17 Solana case study demonstrates why the spectrum matters:

- `EnterPokerTournament` moved 10,000 tokens through a CPI. Payload inspection
  could warn that the unknown program could move funds, but only simulation or
  execution state could provide the amount.
- `AuthorizeSession` transferred 0.02 SOL to a browser-controlled session key.
  The System transfer was decodable, while the authority granted by the game
  program depended on program semantics.
- a raw login message enabled session-wide Advanced Mode, allowing later opaque
  transactions to proceed. Firmware parsing now distinguishes safe printable
  text from transaction-shaped messages, removing that unnecessary escalation.
- the Cee-lo schema work found two misleading first-pass descriptions: a
  silently omitted token balance and an understated SOL value. This proves why
  catalog membership requires adversarial fixtures, not merely an ABI/IDL.

## Live unknown-request path

An unknown request must not wait for an audit and must not be automatically
certified. The synchronous path is deliberately small:

1. Normalize a privacy-safe shape key.
2. Check native firmware support and the certified catalog.
3. Decode known primitives and compute payload-only risks.
4. Attempt simulation where supported; show unavailable as unknown, never zero.
5. Tell the user exactly which protection level is available.
6. Enqueue the shape for asynchronous audit if it is new or materially changed.
7. Continue only through the existing explicit blind-signing policy.

Suggested shape keys:

- EVM: `(chainId, code-address, selector/type-hash, calldata-shape)` plus the
  implementation/code hash when a proxy or upgradeable target is involved.
- Solana: `(cluster genesis, program id, discriminator, data length, account
  privilege shape)` plus ProgramData/code identity for upgradeable programs.

Raw transactions, user addresses, amounts, order IDs, and signatures are not
needed to count demand. A separate, explicit evidence capture may retain a
redacted fixture when a user/operator chooses to submit one for audit.

## Asynchronous audit pipeline

```text
observed unknown shape
        |
        v
deduplicated demand queue ----> coverage dashboard
        |
        v
source / ABI / IDL / code identity discovery
        |
        v
candidate decoder + adversarial fixture corpus
        |
        v
effect comparison (simulation, traces, pre/post state)
        |
        v
independent review and firmware-oracle verdicts
        |
        v
certificate signing ----> catalog publish ----> client retry/cache
        |
        v
code-change monitoring / expiry / revocation
```

Automation may produce a candidate and evidence bundle. It may not promote its
own interpretation into a production certificate. The promotion gate must
include a second reviewer or an equivalently independent deterministic oracle.

The implemented first audit stage records EVM target and EIP-1967 proxy code
hashes at a block, and Solana program/program-data hashes, loader, deployment
slot, and upgrade authority at a slot. Snapshots are refreshed after five
minutes of renewed demand. A changed identity becomes an `identity-changed`
job requiring operator attention. Provider credentials are never stored; only
the RPC origin is retained. Non-EIP-1967 proxies remain explicitly unresolved.

Candidate discovery is deliberately provenance-bearing. EVM jobs query
Sourcify API v2 verified-contract records, recompute canonical ABI selectors,
and retain only exact selector matches with verification quality and timestamp.
In parallel they query the canonical ERC-7730 calldata index, accept only the
active immutable v2 schema, re-check the descriptor's exact chain/contract
context, derive the selector from its ABI fragment, and retain a parsed-content
SHA-256 digest with the registry URL. Registry descriptors are promotion
candidates rather than trusted device definitions: includes, reference tests,
code identity, effects, and rendering still pass the same fixtures, mutation,
firmware-oracle, and two-reviewer gate.

EIP-712 signing attempts use a separate privacy-safe shape containing only the
chain, verifying contract, primary type, and reachable type graph. Domain names
and message values are never retained. REST, WalletConnect, and direct Vault
RPC all create and correctly finalize these observations. Live auditing queries
the canonical `index.eip712.json`, recomputes the EIP-712 `encodeTypeHash`, and
requires an exact chain, verifying-contract, primary-type, index-hash, and
descriptor-format hash match. Matching descriptors are evidence candidates
only: the current firmware metadata envelope cannot authenticate generic
EIP-712 display programs, so they cannot become P4 through the calldata
compiler.

ERC-7730 promotion does not treat an ABI match as display coverage. The
compiler preserves the matched registry `intent` and field labels and only
accepts the narrow subset firmware v2 can render without changing meaning:
flat fixed-width calldata, every argument displayed exactly once in ABI order,
direct paths, unconditional fields, full addresses (`addressName`/`raw`), and
native integer `amount` displayed in base-unit wei. It fails closed on
includes, interpolation, required/excluded fields, parameters such as
`tokenPath`, token amounts without signed decimals/symbol, encryption,
conditional visibility, nested paths, bytes, dynamic types, and omitted or
reordered fields. These remain discovered audit candidates but are not
compilable coverage.
Solana jobs query the current PMP-first IDL resolver (with legacy Anchor-account
fallback), require an exact observed 8-byte discriminator match, retain the
metadata account, publisher authority, source type, argument types, and account
privileges as provenance, then fall back to the local/published program
registry. IDL and registry results remain candidates, never P4 coverage. See
https://docs.sourcify.dev/docs/api/,
https://www.anchor-lang.com/docs/basics/idl, and https://idl.solana.com/docs.

Solana audit demand and new promotion bundles are keyed per instruction rather
than per enclosing transaction. The same program, discriminator, byte length,
and account-privilege shape therefore accumulates one demand count even when
Compute Budget or companion instructions change. Request-level observations
remain one row per user prompt. The resolver accepts the instruction-level key
and still re-checks the exact instruction bytes and privileges in the current
transaction; legacy whole-transaction artifacts remain readable during
migration.

Promotion is a separate fail-closed state machine. A canonical bundle binds the
candidate to the current code-identity hash, privacy-safe positive fixture
hashes, chain-specific negative mutations, firmware artifact and transcript,
expiry, and revocation state. Publication eligibility requires valid signatures
from two distinct secp256k1 reviewer keys covering both semantics and security
roles. The promotion evaluator has no catalog-signing key and cannot publish;
passing it only makes an artifact eligible for the later signing ceremony.

Each audit bundle should contain:

- normalized shape key and first/last seen counts;
- source of semantics (verified source, ABI, IDL, dApp encoder, or inference);
- deployed code identity and upgrade authority/proxy path;
- positive fixtures captured from real requests;
- mutated fixtures for every length, offset, account, privilege, and selector
  boundary;
- decoded fields compared with simulation/trace and actual state transitions;
- device screenshots or emulator frames showing every label and value;
- declared blind spots (CPI/delegatecall, dynamic fields, token metadata,
  external state, and simulation assumptions);
- expiry and revocation owner; and
- exact catalog artifact hashes.

## Chain-specific limits

### EVM / ERC-7730

- A selector is not an identity; collisions exist and proxies can change the
  implementation behind a stable address.
- An ABI describes encoding, not effects. `delegatecall`, callbacks, existing
  allowances, and arbitrary external calls can change what assets move.
- Dynamic tuples and protocol-specific packed bytes exceed fixed-word schema
  expressiveness and require reviewed firmware decoders or a richer bounded VM.
- Simulation is node/state dependent and is vulnerable to state changes,
  front-running, and conditional execution. It is a forecast, not a guarantee.
- Typed-data descriptions must bind domain, chain, verifying contract, primary
  type, and the exact type graph; a friendly type name is insufficient.

### Solana

- The security unit is an instruction shape, not a program. One user session
  can encounter many discriminators from the same program.
- CPI can move assets whose amount is absent from the outer instruction bytes.
- Account order, signer/writable privileges, and lookup-table resolution are
  part of meaning and must be bound or independently checked.
- Upgradeable programs make a program-id-only certificate perishable. Program
  data/code identity, authority status, expiry, and monitoring are required for
  P5.
- `KKSOLSC1` currently supports fixed-width data, at most four arguments and
  four labelled accounts. Variable-length or richer instructions need a new
  bounded format, not misleading partial coverage.

## Metrics that cannot lie

Count attempts, not just successful signatures. Publish at least:

- request coverage by P0-P5, chain, app origin (locally grouped), and time;
- unique shape coverage and request-weighted coverage;
- top unknown shapes by frequency and by maximum potential loss;
- time from first seen to triage, verified fixture, and published definition;
- simulation availability/failure rate;
- definition refusal and fallback rate on device;
- stale/expired/revoked definition attempts; and
- protection regressions when a previously covered shape changes code or form.

“Covered” means the definition applied to the exact request and the device
verified it. A catalog entry that was available but did not apply is not a
covered request. A host-only decode is P2, not ClearSign coverage.

Vault currently exposes request-weighted P0-P5 totals, authenticated coverage
by chain and signing surface, rolling 24-hour and 7-day slices, outcomes, and
the most frequent unknown shapes. The rolling slices are computed from the
bounded local observation query (currently the newest 10,000 records), so they
are operational views rather than claims of complete historical retention.
Simulation outcome is stored as immutable observation evidence (`success`,
`revert`, `incomplete`, `unavailable`, or `not-requested`) and Studio reports
attempt and success counts independently of P0-P5. This matters because a
request may correctly be both P4-authenticated and simulation-unavailable.
Definition resolution is also stored independently as `selected`,
`no-artifact`, `shape-mismatch`, `revoked`, `expired`, an identity failure,
`unsupported-alt`, `invalid-request`, or `not-checked`. `selected` only means
Vault chose a definition candidate; it does not mean the device authenticated
it. Studio reports selected, absent, and refused definitions separately.
Potential loss is retained as a privacy-safe class rather than an amount:
`not-evaluated`, `unknown-effects`, `unlimited-authority`,
`delegated-authority`, `bounded-outflow`, or `none-observed`. It contains no
amount, balance, account, or asset identifier. Unknown-shape queues sort first
by this maximum observed class and then by request frequency. Exact fiat loss
ranking remains unsupported because it would require time-sensitive prices,
token metadata, and more sensitive transaction data; Vault must not present
the exposure class as a monetary estimate. Code/program identity changes are
recorded in an append-only transition ledger containing the shape key,
timestamp, and hashes of the before/after public identity sets. Studio exposes
both currently blocked regressions and the durable historical count.
Coverage also exposes an instruction-level demand spectrum. EVM calls and each
Solana instruction component are counted independently of their enclosing
transaction shape, using only public contract/program, selector/discriminator,
length, and privilege structure. This prevents a multi-instruction transaction
fingerprint from hiding the specific program instruction that should be audited
next. Component frequency is explicitly demand, not component coverage.
Vault separately counts authenticated component appearances. Device acceptance
of one Solana schema credits one instruction, not every instruction in the
transaction. A request can therefore be P4 because an authenticated description
was used while still being reported as partially authenticated. Older P4 rows
without component evidence receive conservative credit for one component only.
Studio does expose the authoritative live-audit pipeline counts and the number
of shapes currently halted in `identity-changed`; this is the immediate
code/program-identity regression signal alongside the append-only historical
counter.

Promoted artifacts also require deployed-code/program identity evidence less
than five minutes old at selection time. Stale evidence fails closed, and the
next observed request moves a covered/evidence-ready audit job back to pending
for live revalidation. A changed identity becomes `identity-changed` and the
artifact remains unavailable until a new reviewed promotion binds that code.
After the device accepts a locally promoted artifact selected through that
fresh identity gate, the observation advances to P5. Certified material from an
external service or caller remains P4 unless Vault independently has the same
current code/program identity binding; runtime metadata remains P2. P5 is
therefore evidence-driven rather than an unreachable or cosmetic tier.

## Delivery order

### Slice 1: measure demand honestly

- Add a `clearsign_observations` store separate from `clearsign_events`.
- Record every EVM transaction/typed-data and Solana transaction at the common
  pre-sign boundary, including rejected and cancelled attempts.
- Store only normalized shape, protection level, catalog result, code identity
  when known, origin/app identifier under a local privacy policy, timestamps,
  and outcome.
- Backfill the local case-study history into the same classifier for a baseline.
- Expose request-weighted coverage, chain/signing-surface and rolling-time
  slices, and the top unknown shape in Studio. Implemented for locally retained
  observations; per-dApp origin awaits an explicit privacy policy and origin
  classifier.

Legacy signing history can now be evaluated without converting old API logs
into synthetic current observations. `GET /clearsign/coverage/legacy-replay`
accepts a bounded `from`/`to` epoch-millisecond range, reads only historical EVM
and Solana signing envelopes, runs the current privacy-safe classifiers in
memory, and returns aggregate coverage plus unknown shapes. It never returns or
inserts raw transactions. Its limitations are part of the response: legacy HTTP
logs did not capture every approval attempt and cannot reliably distinguish all
user rejections from transport or validation failures.

### Slice 2: protect unknowns immediately

- Put Solana post-state simulation into the normal approval path.
- Add EVM call simulation/trace with explicit provider and failure state.
- Make the P1/P2/P3 distinction visible and prohibit green/verified styling
  below P4.

EVM simulation now pins all evidence calls to one observed block and uses a
capability ladder: `eth_simulateV1`, then `debug_traceCall` with `callTracer`
and logs, then execution-only `eth_call`. Call traces contribute nested code
identity and wallet-relative native-value flow. An `eth_call`-only result is
always incomplete because it cannot prove logs, token movements, approvals, or
nested execution. A revert is reported as a revert; unsupported methods or
provider failure are never converted into zero effects.

Solana simulation decodes canonical SPL Token and Token-2022 approve,
approve-checked, revoke, and set-authority instructions when the wallet is the
declared current authority and execution succeeds. These are labelled
`inferred` from executed instruction bytes, not as a generic state diff.
Invoked custom programs remain explicitly `PROGRAM_STATE_CHANGES_UNINTERPRETED`;
their balance effects may be observed while their session, ownership, or other
protocol-specific authority semantics remain incomplete.
The unified report also consumes the bounded Solana transaction decoder. A key
funded by a System transfer and embedded in an unknown program instruction is
reported as `SESSION_KEY_FUNDED_AND_REGISTERED`; an unknown program sharing the
transaction with System/SPL asset programs is reported as CPI-capable risk.
Unresolved lookup tables and unknown program/instruction shapes remain explicit
limitations. REST and WalletConnect therefore use the same warnings rather than
leaving session authority only in a separate approval-view model.

### Slice 3: audit queue and evidence bundles

- Deduplicate observations into audit jobs.
- Add ABI/IDL/source discovery adapters and code/upgrade identity checks.
- Generate candidate fixtures and negative mutations automatically.
- Require firmware-oracle and independent effect evidence before signing.

### Slice 4: real-time distribution and lifecycle

- Serve signed definitions by normalized shape with bounded cache TTLs.
- Add signed revocations, expiry enforcement, and upgrade/code-change monitors.
- Cache verified artifacts locally so service downtime never changes a known
  definition into a trusted-but-unverified decode.

Approved promotions can now be compiled by Vault into an **unsigned** firmware
artifact through `POST /clearsign/promotion/compile`. Compilation re-runs the
promotion gate, requires current code-identity evidence, and binds the result
to the locally observed request shape. EVM compilation permits only complete
flat fixed-word calldata; Solana compilation permits only the fixed-width
`KKSOLSC1` subset with exact instruction-byte coverage. The output carries its
payload and digest, expiry, identity and promotion hashes, and reviewer
fingerprints. It contains no signature, and the evaluator has no private-key
or publication capability; signing remains an external ceremony.

For proxies, verified ABI provenance may be the implementation address, but
the compiled EVM schema binds the proxy address that the transaction actually
calls.

The offline ceremony result is imported through
`POST /clearsign/artifacts/import`. Vault re-compiles the payload, re-runs the
promotion gate, verifies the root-signed certificate and delegate signature,
checks certificate scope and expiry, and stores only a verified artifact.
`GET /clearsign/artifacts` excludes expired and revoked records by default;
`POST /clearsign/artifacts/revoke` removes one immediately from selection.

EVM signing resolution now prefers a locally promoted artifact only when its
exact chain, destination, selector, and calldata length match and its current
audit evidence still has the imported identity hash. An identity-change job,
expiry, or revocation makes the resolver return no artifact. The external
certified service and existing fallback paths remain available after that.

Solana signing uses the same local artifact lifecycle. A promoted `KKSOLSC1`
schema is auto-attached only when exactly one instruction matches its program,
discriminator, complete data length, and declared account indices, and current
program identity still matches. The privacy-safe shape key also binds each
instruction's account indices and signer/writable privilege layout; a privilege
mutation creates a different audit job and cannot select the promoted artifact.
The compiler separately checks IDL-declared privileges against that observed
shape. Self-contained legacy and v0 transactions are supported. A v0
transaction that references address lookup tables is
deliberately declined because the reusable schema does not bind the loaded
accounts; it still requires a separate transaction-bound LUT proof. Successful
device use of an auto-attached artifact promotes the request to certified P4
coverage in the observation ledger.

### Slice 5: expand the device formats

- ERC-7730: compile the safe subset generically; add bounded reviewed decoders
  only for structures the generic format cannot express.
- Solana: design a versioned bounded layout language for variable fields and
  more accounts, while retaining exact byte coverage and display limits.

## Immediate acceptance test

Replay the 2026-09-17 Solana session and a representative EVM swap set through
one classifier. The report must:

1. count all attempts, including cancellation, timeout, policy refusal, and
   blind-sign fallback;
2. reproduce the known token CPI and session-key warnings;
3. distinguish host simulation from device-authenticated ClearSign;
4. name the most frequent unknown shape;
5. show exactly why each certified definition did or did not apply; and
6. produce a queue item that contains no raw user transaction by default.

That report is the baseline. A new schema is valuable only when it moves real
requests upward on the protection spectrum without making any claim stronger
than the evidence.

ClearSign Studio also re-fetches two completed public transactions as live
case studies rather than presenting static screenshots:

- a Relay SOL-to-ETH deposit whose receipt proves an inner System Program CPI
  transferred 569,336,560 lamports. The `KKSOLSC1` replay authenticates the
  program, discriminator, amount, order ID, and vault, while explicitly stating
  that the promised ETH output is not in the signed Solana bytes;
- a Relay ETH-to-USDT dynamic-router transaction whose successful receipt and
  full calldata are checked at refresh time. It is intentionally reported at
  P3: simulation can expose effects, but the call exceeds the generic firmware
  v2 format and is not represented as authenticated coverage.

If either RPC cannot supply the transaction and success evidence, Studio shows
the example as unavailable and emits no protection claims.
