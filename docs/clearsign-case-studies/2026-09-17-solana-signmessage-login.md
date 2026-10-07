# Live clear-sign review — Solana dApp login via raw `signMessage`

Date: 2026-09-17 · Surface: KeepKey Browser Extension → Vault → firmware alpha
(`BitHighlander/keepkey-firmware@6ab634546`) · Vault `develop@87a2e7675`

## What the user saw

```
ACTION REQUIRED — KeepKey Browser Extension — Solana Sign Message

[1] Advanced Mode Required
    "This enables blind signing for ALL transactions until the device locks
     or is unplugged."            [Cancel] [Yes, enable for this session]

[2] Unsafe Solana Message Signing
    "This dApp does not use KeepKey's safe Solana off-chain message format."

Message to Sign   BASE64
Signer            Gu83nVMD8qh948D1vqe8UPoUHaFuSwcHrvNHetcM4Xux
Looks Like        Text message
Bytes             221

  SoltoshiDICE wallet
  Network: mainnet-beta:CuTLp7pDmNGkFgi4aoh8Ef1YSjc2BzECQRLzYqaoVWBR:4nCmpwne7hCoWTSpAd54uENmCgHJrHTyn4DMPCEMpump
  Session: ca5ed7a8-5df1-41bf-91ca-c3de4c1c56f6
  Nonce:   37c40667-576d-4054-9064-618614ab88c1
```

The dApp is asking for a wallet login: a 221-byte UTF-8 text message signed with raw
Ed25519 (Wallet Standard `solana:signMessage`).

## How the request is routed today

| Layer | Code | Behaviour |
|---|---|---|
| Vault preview | `src/bun/rest-api.ts` `/solana/sign-message` branch | **Always** sets `needsBlindSigning = true` and `requiresAdvancedMode = true`, whatever the content |
| Vault UI | `SigningApproval.tsx` `SolanaUnsafeMessageBanner` | Classifies the payload (`text` vs `solana-transaction[-message]`) but uses the result only to pick the banner wording |
| Firmware | `fsm_msg_solana.h` `fsm_msgSolanaSignMessage` | Hard-refuses unless the `AdvancedMode` policy is on, then shows "Format: raw Ed25519…" and pages **every byte** through `confirm_bytes` (printable characters appear as-is, everything else is escaped) |

This gate is deliberate. A raw Solana message has no domain separation, so a signature
over bytes that parse as a transaction message **is** a signed transaction
(trezor-firmware#4371).

## Findings

**F1: consent is far broader than the risk (highest severity).** Signing into a dApp
requires turning on Advanced Mode, and the prompt itself says that allows blind signing
of *every* transaction until the device locks. Almost every Solana dApp logs in with
raw `signMessage`, so users learn to flip on global blind signing just to log in. That
defeats the purpose of the gate.

**F2: the risk can be decided on the device, but the gate never checks it.** The danger
is specifically "these bytes parse as a Solana transaction message". Legacy messages
start with `num_required_signatures`, and v0 messages start with `0x80 | version`,
which is never printable ASCII. A printable first byte `b` (≥ 0x20) implies at least
`b × 32` bytes of account keys. For this message (`'S'` = 83 → ≥ 2,656 bytes needed,
but only 221 exist) it is **provably not a transaction**. Firmware already carries a
Solana transaction parser. Proposed gate:

> text-only UTF-8 **AND** the firmware transaction parser rejects the bytes
> → show the text, sign **without** Advanced Mode.
> Otherwise → keep today's Advanced Mode + raw-bytes path.

This has to be enforced in firmware. The host classification in the UI is advisory.

**F3: the wrong things come first in the UI.**
- The global blind-signing consent appears *before* the message content.
- The default view is BASE64 even though "Looks Like: Text message".
- For a text login, the user should see the decoded text first, with the raw bytes
  collapsible.

**F4: KeepKey's safe format doesn't help here.** `SolanaSignOffchainMessage` (the
`\xff"solana offchain"` envelope) produces a signature the dApp cannot verify, because
the dApp checks the raw bytes. So the banner "does not use KeepKey's safe format" blames
the dApp for something it cannot switch to. The actual fix is F2.

**F5: the message binds less than SIWS does (dApp-side, confirmed).** The full
221-byte payload (see the timeline) is exactly four lines: name, `Network`, `Session`,
`Nonce`. It has no `domain` / `URI` / `Issued At` / `Expiration` (Sign-In With Solana
fields), so a phishing origin could relay the same challenge. `CuTLp7p…` in the
`Network` line is **not** a genesis hash. It is the SoltoshiDICE program ID (mainnet
genesis is `5eykt4Us…`), and `4nCm…pump` is its token mint.

**Positive:** Vault derives the signer from `addressNList` and returns HTTP 400 if the
dApp's claimed pubkey differs. The address shown is the one the device will sign with.

## Session timeline (from Vault DB)

Source: `~/Library/Application Support/com.keepkey.vault/stable/vault.db`, table
`api_log`, device `550E8EEDA3E5F8C2F32F8EF9`, app "KeepKey Browser Extension". dApp:
`https://soltoshidice.wtf/?room=the-block`. The `clearsign_events` table has **no rows
for this session** (its last row is from 2026-08-28).

| Time (local) | api_log id | Route | Result |
|---|---|---|---|
| 18:47:09 | 108280–84 | pubkeys batch + tron/hive/ton/solana addresses | BEX connect fans out to every chain |
| 18:47:34 | 108357 | `/solana/sign-message` | **403 "Signing rejected by user" after 120,024 ms** |
| 18:50:02 | 108386 | `/solana/sign-message` (same payload) | 200, signed |
| 18:50:21 | 108402 | `/solana/sign-transaction` | 200, signed, 29 s |
| 18:51:16 | 108426 | `/solana/sign-transaction` | 200, signed, 8 s |

Message (base64-decoded, 221 bytes):
```
SoltoshiDICE wallet
Network: mainnet-beta:CuTLp7pDmNGkFgi4aoh8Ef1YSjc2BzECQRLzYqaoVWBR:4nCmpwne7hCoWTSpAd54uENmCgHJrHTyn4DMPCEMpump
Session: ca5ed7a8-5df1-41bf-91ca-c3de4c1c56f6
Nonce: 37c40667-576d-4054-9064-618614ab88c1
```

Transactions (decoded locally, outcomes read back from mainnet RPC):

| | tx1 `4CUN7Bii…r7vn` | tx2 `5ibnS5og…CM57` |
|---|---|---|
| Format | legacy, 9 accounts | legacy, 5 accounts |
| Program | `CuTLp7p…VWBR` (SoltoshiDICE, **upgradeable**) | `CBuVrPT…Ypkt` (**upgradeable**) |
| Data | `13 6b 6b` (3 bytes, not Anchor) | `915cd08e461ea126` = Anchor `RegisterPokerTournament` |
| Can it move the user's SOL? | **Yes**: user is signer + writable, System Program is in the account list | No: no System or Token program in the tx |
| What it actually did | user −0.00264152 SOL → `APAyVK…VUy` +0.00263652 (≈ rent for a new account) | 5,000-lamport fee only |

## Findings from the timeline

**F6: the login's consent carried over to the transactions (F1 in practice).** Both
programs are unknown to the device, and firmware refuses opaque transactions unless
Advanced Mode is on (`SOL_TX_REVIEW_OPAQUE` in `fsm_msgSolanaSignTx`). The login had
already turned Advanced Mode on for the session, so the two following transactions only
had to clear the per-request consent. tx1 *could* have drained SOL. In practice it paid
rent, but only the on-chain result shows that. Nothing on the signing screens proved it.

**F7: the first attempt looks like a timeout, but was logged as a user rejection.** A
duration of 120,024 ms is too close to a 2-minute timer to be a click. Check whether
the user pressed Cancel. If not, the log (and the dApp) are told "rejected by user" for
a timeout.

**F8: nothing reached the clear-sign evidence table.** `clearsign_events` stayed empty,
so a blind-signed transaction on an unknown upgradeable program leaves no record there
of how it was reviewed. `api_log` is the only trace.

**F9: an upgradeable program changes what a clear-sign descriptor can promise.** Both
programs are owned by `BPFLoaderUpgradeable`, so the upgrade authority can change the
behaviour behind an unchanged program ID. This is the same problem as ERC-7730 "intent
mutability" (ethereum/ERCs#1738). Any Solana descriptor for these programs has to be
bound to a program data hash or slot, not just the program ID.

## Still to capture
- What the device and Vault showed for tx1 and tx2: clear review, "unknown program",
  or blind-sign hash; and whether the Advanced Mode prompt appeared again.
- Whether Advanced Mode is still on now.
- OLED frames, if recorded.

## Follow-ups (not started)
1. Firmware: implement the F2 gate (text + fails tx parse ⇒ no Advanced Mode) with unit
   tests covering: printable text, legacy tx message, v0 tx message, and text whose first
   byte is printable but whose length is large enough to fit a tx.
2. Vault: set `requiresAdvancedMode` from the classification (the firmware still decides),
   reorder the UI so content comes before consent, and default to the text view for text.
3. Replace the banner wording in F4.

## Session 2: Hash Holdem (19:04–19:06)

Every transaction targeted program `CBuVrPT…Ypkt`, which the device doesn't know, so
**all were blind-signed**. The Levels column is from `assessSigningRisk`
(branch `feature/clearsign-risk-bar`); the on-chain column is from mainnet RPC.

| api_log | Request | Levels | What actually happened on-chain |
|---|---|---|---|
| 108748 / 108789 | SoltoshiDICE login message | Low | — |
| 108754 / 108763 / 108795 | SIWS "Sign in to Hash Holdem" (domain, URI, nonce, Issued At) | Low | — |
| 108760 | `EnterPokerTournament` | **High** (Token-2022 present) | **−10,000 `4nCm…pump` tokens** via a hidden CPI `TransferChecked`; SOL fee only |
| 108823 | `AuthorizeSession` (1st try) | High | **403 after 120,009 ms**: timeout logged as "rejected by user" (2nd time, F7) |
| 108799 | `AuthorizeSession` | **High** (System present) | −0.0212 SOL: **0.02 SOL → `6TD5D3U…`** + 0.00122 rent → `Bk7tm…` |
| 108805 | `SetReady` | Medium (no asset program) | fee only; matches |

### F10: a blind-signed transaction handed signing power to a browser hot key
After `AuthorizeSession`, `6TD5D3U…` (a System account funded with 0.02 SOL) signs the
game itself: `Act`, `RevealMentalHole`, `RevealMentalStreet`, `PublishUnlocks`, and no
KeepKey is involved. The user never saw "you are authorizing key 6TD5… to act for you".
The 0.02 SOL transfer was a *known* instruction, but the delegation is only visible by
reading the program's code. The dApp log `start_hand_mental … signing 0ms` is this
session key signing, and its failure (`TournamentResultPending`, Anchor 6072: "Record
the completed tournament hand before starting another hand") is the dApp's own state
machine, **not** a KeepKey fault.

### F11: moving tokens through a hidden CPI is invisible without simulation
`EnterPokerTournament` took 10,000 tokens, but nothing in the payload shows an amount.
The rules correctly say High ("can move your funds"), but only simulation can say *how
much*. That argues for bringing `solana-outflow` (post-state from simulation, source mint
included) into the bar next.

### F12: the SoltoshiDICE "Nonce" is a constant
The same `Nonce: 37c40667…` and `Session: ca5ed7a8…` were signed at 18:50, 19:04 and
19:05. A nonce that never changes makes the signature replayable. This is a dApp
finding. By contrast, the Hash Holdem SIWS messages use fresh nonces.

### Rule candidates this exposed
- Session-key pattern: a known System transfer to account X, where X is also passed to
  an unknown program in the same tx, should add the reason "may authorize X to sign for
  you". It should RAISE the level only.
- For known instructions, show the amount and recipient in the reason text (for example
  "Sends 0.02 SOL to 6TD5…"), so High carries a number.

### F13: the session key's reach (checked 19:41 on mainnet)
- **Cannot touch the wallet.** `Gu83…` is still owned by the System Program (0.133 SOL).
  All 4 token accounts (USDC, USDT, `3WjL…`, 7,785,382 `4nCm…pump`) have
  `delegate = None` and `closeAuthority = None`. Moving any of them needs `Gu83…`'s own
  signature.
- **Session record `Bk7tm…`** (113 bytes, owned by `CBuVrP…`) holds: owner = `Gu83…`,
  session key = `6TD5…`, scope = `FQU2…` (a 395-byte account owned by the program,
  probably the table or tournament), and an i64 of `1789697138` = **2026-09-17 20:05:38
  local**, one hour after the authorization, so presumably the expiry. These meanings
  are inferred from the byte layout, not confirmed from the program's IDL or source.
- **What it can do** is whatever `CBuVrP…` lets a session signer do inside that scope:
  play your seat with the 10,000 tokens already escrowed at `GpuJrm…`. Whether a session
  signer can also redirect payouts depends on the program's code. That hasn't been
  verified, and the program is upgradeable.
- **Hot-key float:** `6TD5…` holds 0.01003 SOL of your 0.02 SOL for fees, controlled by
  the browser page. It last signed at 19:36:51.
