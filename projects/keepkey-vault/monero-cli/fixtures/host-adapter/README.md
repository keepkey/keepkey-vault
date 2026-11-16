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
