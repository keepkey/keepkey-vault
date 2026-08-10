# Handoff: support.keepkey.com — accept the Vault audit `?audit=` GET param

**Date:** 2026-07-02
**From:** keepkey-vault v11 (lands in v1.4.10)
**For:** the agent working on support.keepkey.com (chat/ticket system, e.g. `/chat/ticket_*`)

## What the Vault now sends

The Balance Audit's support handoff ("Open support with report ↗", `AuditDialog.tsx`)
opens:

```
https://support.keepkey.com/?audit=<chunk>
```

`<chunk>` is **base64url** (RFC 4648 §5: `+`→`-`, `/`→`_`, padding stripped) of a
UTF-8 JSON document. Decode:

```js
const b64 = chunk.replace(/-/g, '+').replace(/_/g, '/')
const json = decodeURIComponent(escape(atob(b64)))  // or Buffer.from(b64, 'base64').toString('utf8')
const audit = JSON.parse(json)
```

## Payload schema (v: 1)

```jsonc
{
  "v": 1,
  "time": "2026-07-02T08:15:00.000Z",     // when the report was generated (ISO)
  "chainId": "litecoin",                   // vault chain id
  "symbol": "LTC",
  "dashboardUsd": 12.34,                   // what the user's dashboard showed
  "expected": "I had ~0.5 LTC",           // optional — user's free-text note
  "hidden": true,                          // optional — passphrase/hidden wallet (see privacy)
  "truncated": true,                       // optional — empty rows dropped to fit URL limits
  "results": [                             // every address/path the audit checked
    {
      "path": "m/44'/2'/1'/0/0",
      "address": "ltc1q…",                // ABSENT for hidden wallets
      "balance": "0.01273259",            // human units, native coin
      "symbol": "LTC",
      "funded": true,                      // optional — present only when funds found
      "error": true,                       // optional (boolean) — lookup THREW; balance UNKNOWN, not 0
      "tokens": [                          // optional — EVM token hits
        { "symbol": "USDC", "balance": "5.0", "usd": 5.0 }
      ]
    }
  ],
  "xpubs": [                               // deduped account-level xpubs from UTXO scans
    { "scriptType": "p2wpkh", "xpub": "zpub6…", "pathStr": "m/44'/2'/1'" }
  ]                                        // ALWAYS [] for hidden wallets
}
```

## What support should do with it

1. On page load, if `?audit=` is present, decode and attach the parsed report to
   the ticket/chat being opened — as a structured attachment or a pre-filled
   first message, so the user doesn't have to paste anything.
2. Render `results` as a table (path / address / balance / status). Rows with
   `error` set must display as **"couldn't verify"** — never as zero (Vault
   honesty rule).
3. Keep the `xpubs` array with the ticket — it's what lets an agent re-check
   balances server-side (blockbook accepts these; the SLIP-132 version bytes
   encode the script type, e.g. `zpub` = derive p2wpkh addresses).
4. Show `expected` (the user's own words) prominently to the agent.
5. If decode fails or `v !== 1`, fall back gracefully — plain support page, no
   error. The param is best-effort.

## Privacy rules (must-keep)

- `hidden: true` reports contain **no addresses and no xpubs** — the Vault
  redacts them at the source for passphrase wallets. Don't try to enrich these.
- xpubs reveal the full account address tree (privacy-sensitive but not
  spend-capable). Treat the ticket contents as private user data; don't index
  the URL or log query strings into anything public.

## Size

The Vault caps the chunk at ~7000 chars (drops empty rows and token detail,
sets `truncated: true`). Support should still accept larger values defensively
but can assume single-digit-KB.

## Context — why this exists

The `navigator.clipboard` copy in the old "Copy report & open support" button
silently failed (clipboard write after the browser stole focus), so tickets
arrived with no data. The Vault now (a) copies robustly with feedback, and
(b) carries the whole report in the URL so the ticket is self-contained even
if the user pastes nothing. The first big use case: Litecoin funds on the
legacy p2wpkh-on-BIP44 branch (pre-1.4.10 Vault convention) — the audit's
"Scan uncommon paths" surfaces those and their xpubs land in this payload.

## Test vector

Decoded example (encode it yourself for a round-trip test):

```json
{"v":1,"time":"2026-07-02T08:00:00.000Z","chainId":"litecoin","symbol":"LTC","dashboardUsd":0,"results":[{"path":"m/44'/2'/1'/0/0","address":"ltc1q8sn04sjgwtjpxgp3qw3ykjkuqskqaad8264xsr","balance":"0.01273259","symbol":"LTC","funded":true}],"xpubs":[{"scriptType":"p2wpkh","xpub":"zpub6qcqTRFFJGCXRVsDLANFY1H34677QrAdLNDXGBdEMfPRkB89Q8dSiMpuQGWa4iSNpuN9WRAJLfrkE2sREqJXuPW4JHY736ZhfdkTn5nLmsH","pathStr":"m/44'/2'/1'"}]}
```

(That xpub/address pair is the public `abandon…about` test seed — safe to use
in tests.)
