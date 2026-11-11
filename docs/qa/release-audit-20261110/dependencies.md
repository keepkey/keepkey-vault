# Dependency reachability review — November 10, 2026

**The dependency scan is not clean.** This bounded review covers the four
critical advisory families identified during the release audit. It separates
installed-version matches from a proven attacker-controlled runtime path; it
does not waive other advisories or establish that an entire dependency is safe.
No package version or lockfile was changed by this review.

## Snapshot and method

The supplied `/private/tmp/keepkey-release-dependency-audit-20261110.json`
contains 35 package names and 170 unique advisory record IDs, representing
133 distinct advisory URLs. Each installed version was checked against each
reported `vulnerable_versions` range using `Bun.semver.satisfies`. At least one
installed version still matches every one of the 133 URLs in this snapshot.
Multiple range-specific records can refer to one advisory; raw record counts
must not be presented as distinct vulnerabilities or proven exploit paths.

The installed-version/path inventory is saved at
`/private/tmp/keepkey-release-dependency-reachability-20261110.json`; the
read-only inventory script is
`/private/tmp/keepkey-dependency-inventory-20261110.ts`. The source node_modules
tree includes local linked-package development dependencies. It is broader
than the shipped runtime. The locally staged `_build/_ext_modules` was inspected
separately, without rebuilding, updating or running its application.

These are the pre-remediation scan/staging observations. A later lockfile
override or fresh package collection requires its own exact-version inventory;
the numbers above do not claim to describe a future signed artifact.

## Four critical families

| Family | Installed/staged evidence | Runtime conclusion |
| --- | --- | --- |
| elliptic | Root 6.6.1; installed nested 6.5.4 and 6.5.7. Staging retained Pioneer Discovery's 6.5.4 and two WalletConnect 6.5.7 copies. | The critical malformed-signing-input precondition was not found in the examined nested runtime uses; vulnerable versions are nevertheless shipped. |
| handlebars | Installed 4.7.8; found through TypeDoc and development metadata, absent from inspected runtime staging. | No application import/template-compilation path was found. Treat as development/documentation-tool exposure, not a proven Vault endpoint RCE. |
| protobufjs | Root/staged 6.11.4; installed linked/dev copies also include 6.11.3, 6.8.8 and ts-proto's 7.5.4. | No untrusted schema-loading path was found for the critical schema-code-generation advisory. A separate binary-recursion path was reproduced and narrowly rejected in the TRON memo helper. |
| shell-quote | Installed 1.8.3, through devDependency concurrently 9.2.1; absent from inspected runtime staging. | No application import or attacker-controlled object-token-to-shell path was found. Development-tool exposure remains. |

### elliptic

[GHSA-vjh7-7g9h-fjfh](https://github.com/advisories/GHSA-vjh7-7g9h-fjfh)
requires malformed attacker-influenced input to reach ECDSA signing. Version
6.6.1 fixes this advisory; it is the root `@ethersproject/signing-key` dependency.
That statement is specific to this advisory: other elliptic records, including
the lower-severity implementation advisory, still include 6.6.1.

The installed WalletConnect web3wallet/sign-client nested `utils@2.17.1`
bundles import elliptic 6.5.7. Their examined EC use constructs a P-256 public
key for signature verification; the bundles contain no ECDSA `.sign(`,
`keyFromPrivate` or `ecsign` call. This does expose public verification to
external input, but does not establish the critical private-key-extraction
signing precondition. WalletConnect being disabled by default is not used as
the sole argument for this conclusion.

Pioneer Discovery 10.3.2 imports used by Vault expose data/types. Its inspected
installed lib JavaScript does not use ethers, Wallet, SigningKey or private-key
signing, despite retaining ethers 5.7.2 and its elliptic 6.5.4 dependency. This
appears to be unused dependency baggage at the examined import boundary.
Another installed 6.5.4 copy under proto-tx-builder is reachable through
CosmJS's software-signature implementation. The examined Vault
Cosmos/THORChain/Osmosis integration instead passes an OfflineAminoSigner that
returns the firmware-produced signature; no software private key was found
supplied to that vulnerable JavaScript signer on those paths. This does not
cover every upstream SDK entry point. The collector removes local `@keepkey/*`
nested node_modules and inspected staging instead has root elliptic 6.6.1 for
that shared dependency resolution.

Relevant source: [WalletConnect integration](../../../projects/keepkey-vault/src/bun/walletconnect.ts),
[backend external-package policy](../../../projects/keepkey-vault/scripts/bundle-backend.ts),
and [collector resolution/pruning](../../../projects/keepkey-vault/scripts/collect-externals.ts).
An approved compatible elliptic override should be checked in fresh staging;
this source review is not proof that all copies were upgraded.

Root subsequently pinned all elliptic resolutions to 6.6.1 in the candidate
lockfile. This addresses the critical signing advisory's version range; exact
installed/staged verification belongs to the final candidate evidence and does
not clear unrelated elliptic advisories.

### Handlebars

The installed 4.7.8 matches
[AST type-confusion injection](https://github.com/advisories/GHSA-2w6w-674q-4c4q),
the later [AST validation bypass](https://github.com/advisories/GHSA-8r5x-fm3f-whwj),
and [own-property-check bypass](https://github.com/advisories/GHSA-p8wg-vrv2-v86f).
The first two require attacker-controlled AST objects to reach compilation;
the latter requires a controlled template and permissive prototype-method
options. Updating only to 4.7.9 would not cover the later advisories.

The installed dependency parents are TypeDoc's runtime renderer plus development
metadata in Ramda/Axios. Vault source/scripts have no Handlebars import or
compile call, and the inspected external staging contains no Handlebars.
Documentation/build processing of untrusted templates was not evaluated; its
absence from an examined desktop runtime is not a development-environment
clean-scan claim.

### protobufjs

[GHSA-xq3m-2v4x-88gg](https://github.com/advisories/GHSA-xq3m-2v4x-88gg)
requires control over a schema/JSON descriptor loaded through reflection APIs.
The advisory distinguishes this from decoding with trusted application schemas.
The direct TRON paths use `Reader`/`Writer`, while Cosmos code uses packaged
generated definitions. No attacker-supplied `Root.fromJSON`, `.proto` parsing
or descriptor-loading path was found in the inspected application sources.
This does not dismiss protobuf's separate binary-input advisories.

One such advisory is
[GHSA-685m-2w69-288q](https://github.com/advisories/GHSA-685m-2w69-288q):
`Reader.skipType(3)` recursively skips protobuf groups without a depth limit.
The [TRON memo injector](../../../projects/keepkey-vault/src/bun/txbuilder/index.ts)
processes `raw_data_hex` returned by an upstream transaction-building response
before the later strict payload check. A 400 KB synthetic nested-group payload
caused `RangeError: Maximum call stack size exceeded` in the actual helper body
with protobufjs 6.11.4. The isolated process remained alive; no process-wide
crash, code execution or signing was demonstrated. An attacker would need to
influence that upstream response; arbitrary REST-client control was not proved.

The approved narrow patch rejects wire types 3/4 before `skipType`, because
TRON has no protobuf groups. The existing
[strict TRON preview decoder](../../../projects/keepkey-vault/src/bun/tron-preview.ts)
already rejects those wire types. The
[real-helper regression](../../../projects/keepkey-vault/__tests__/tron-memo-inject.test.ts)
was red on the previous source for a small group, unexpected end-group and deep
nesting; all 11 tests/19 assertions now pass, including original memo ordering,
txID and immutability cases. The test mocks Electrobun before dynamically
importing the builder and uses a temporary profile, not native app startup.
Proof: `/private/tmp/keepkey-protobuf-reachability-20261110.json`.

The collector excludes ts-proto tooling, strips protobuf CLI/dist folders, and
removes linked-package nested modules. That explains the smaller observed
runtime inventory; it does not make protobufjs 6.11.4 an unaffected version or
prove other static-schema binary-decoding advisories unreachable.

### shell-quote

[GHSA-w7jw-789q-3m8p](https://github.com/advisories/GHSA-w7jw-789q-3m8p)
requires attacker-influenced operator objects to reach `quote()` and then a
shell. The additional
[parse-complexity advisory](https://github.com/advisories/GHSA-395f-4hp3-45gv)
requires an attacker-influenced input string to reach `parse()`.

The installed parent is concurrently, a root development dependency. Its
examined argument-expansion path quotes CLI string arguments; no application
source imports shell-quote, and neither package appears in inspected external
staging. No remote Vault path satisfying either precondition was found.
Developer-supplied commands and third-party build tooling remain outside this
bounded runtime conclusion.

## Remaining limits

This is source/staging reachability evidence for four families, not a complete
security audit of all 35 reported packages. Other installed high-severity
families, including Axios, remain reported and have not been cleared here.
The narrow TRON change does not update protobuf or resolve unrelated advisory
ranges. Fresh frozen-lock installation, exact artifact inventory, advisory
re-scan and platform acceptance remain release gates. No audit autofix,
dependency update, wallet operation, live API request or signing action was
performed by this review.

## Bun 1.3.14 local protocol alias repair

Lock-only regeneration changed the nested
`@keepkey/hdwallet-keepkey/@keepkey/device-protocol` entry from the reviewed local
file package to registry `@bithighlander/device-protocol@7.20.0`, despite the root
override. Temporary-only fresh installs reproduced that resolution drift;
overrides for both the alias name and the registry target failed to preserve
the local package. Restoring the one reviewed local-file lock entry passed a
minimal fresh frozen probe. The first full integration CI nevertheless failed
frozen validation because six other file-package entries retained incomplete
dependency metadata. The minimal probe did not establish full-project readiness.

A clean full-project reproduction with all pinned local package manifests
expanded that metadata and its nested dependency graph. The repaired lock then
installed 1,183 packages from empty node_modules for both macOS arm64 and Linux
x64 dependency selection using Bun 1.3.14, frozen mode and disabled lifecycle
scripts. Its SHA-256 stayed
`71db41b5b8addfe995cc3897995e8aa78930ed1c25d7dad10de44f750b4b7c4c`.
The semantic comparison finds no new registry package/version targets; all four
SDK protocol paths resolve to the reviewed local source and elliptic remains
6.6.1. Lifecycle scripts, packaging and platform startup still require exact-head
CI. Evidence: `/private/tmp/keepkey-full-lock-ci-20261110/summary.json`,
`semantic-lock-diff.json` and `lock-diff.patch` in the same directory.

The repaired frozen lockfile and
[device-protocol installation invariant](../../../projects/keepkey-vault/__tests__/device-protocol-install.test.ts)
are the candidate workaround. Do not run an ordinary install/regeneration after
that repair without rechecking the invariant. The
[backend bundler's explicit local onResolve mapping](../../../projects/keepkey-vault/scripts/bundle-backend.ts)
also protects the packaged protocol path. Renaming the lock's local builder
package labels does not change that protocol source boundary.

Temporary probe evidence supplied by the reliability agent is under
`/private/tmp/keepkey-bun-alias-probe-20261110/{app,app-target-override,app-restored-lock}`.
This section records that bounded reproduction and workaround; it does not
claim the upstream Bun alias-resolution issue is fixed.
