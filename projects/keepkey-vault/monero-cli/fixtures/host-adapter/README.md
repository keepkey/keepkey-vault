# Public Monero adapter fixtures

These encrypted requests are published test material from
[`keepkey-firmware` at `97236a794c5953dfcb892578ec464992f962a493`](https://github.com/BitHighlander/keepkey-firmware/tree/97236a794c5953dfcb892578ec464992f962a493/tools/monero-feasibility/evidence/2026-11-04-host/fixtures).
They include a published disposable view key, never a user wallet credential.

| File | SHA-256 |
| --- | --- |
| `base-request.json` | `db324fe397101bd4979ee60d9040d3386229145305fa1a9ea7891f5db6e64263` |
| `subaddress-request.json` | `c98988af65743a811cede808ab1c69ebba0455dd76dbea336e863973c7f7df1d` |
| `four-inputs-reversed-selection-request.json` | `f60fc92c064a245344b4fbff8760fb766c1f66e2aaddf49ae6f59f6ce508c354` |

`host-adapter.test.ts` runs the reviewed executable against these authenticated
Core output exports and unsigned transaction sets. It compares every decoded
field with the independently generated plans and output metadata already retained
in `src/bun/monero-send.fixtures.json`. Numbers pass through the exact JSON parser
so uint64 values are compared without floating-point rounding.

The tests also reject modified encrypted containers and spend-key request fields.
They do not start wallet RPC, connect to a node, open a device, sign, or relay.

`sweep-{standard,subaddress}-dummy-{first,last}-request.json` are offline Max
regressions derived from `base-request.json` and `subaddress-request.json` with
the same pinned Core 0.18.5.4 serializer and authenticated encryption. Core's
`wallet2.cpp` adds a standard, zero-value dummy output when a single recipient
uses the complete input amount after fees. The dummy address is also recorded
in `change_dts`; output shuffling can place it before or after the recipient.
The public generator uses recovery scalar `25` followed by 62 zeroes for a
repeatable dummy address. Its disposable keys and all other credentials here
are public test data.

The sweep keeps the original inputs and fee, assigns the original recipient plus
change amount to the recipient, and includes one zero dummy. The corresponding
`-expected-outputs.json` files come directly from that construction metadata,
independently of the decoder under test. Authenticated `invalid-*-request.json`
cases cover mismatched dummy addresses, positive change combined with a dummy,
a subaddress dummy, all-zero outputs, repeated dummies, three outputs with a
dummy, and forged positive change ownership.

To regenerate with an existing pinned Core build of the adapter:

```sh
python3 projects/keepkey-vault/monero-cli/fixtures/host-adapter/make-sweep-fixtures.py /path/to/core-build
```

This compiles `make-sweep-fixtures.cpp` using the adapter target's existing
compiler settings and Core libraries. Authenticated encryption uses fresh
randomness, so ciphertext bytes change on regeneration; the decoded plans and
expected outputs remain identical. The previous reviewed adapter, SHA-256
`8569f6afd4f62c750b96c6b567c258efaed02209a9af8feb2a6c548b17de8b59`,
rejects all four valid sweeps with its zero-value output error. The native suite
also exercises `MoneroWatchService.createTransfer` through the reviewed decoder
and serialized worker reply using a fake RPC that serves only these fixtures.
