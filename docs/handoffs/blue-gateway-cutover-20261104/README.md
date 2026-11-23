# Blue gateway cutover, 2026-11-04

The live cutover is complete. api-blue.keepkey.info/* and oracles.cc/* route
to keepkey-gateway. The existing Wrangler OAuth login was sufficient; no new
token, DNS edit, host network change or reboot was required.

## Verification

- Both domains passed health and database checks at gateway revision
  bff70f2a83e2db01a7acb8f06d2dd714974ceaf3.
- Blue advertised its own HTTPS OpenAPI origin.
- Litecoin legacy, wrapped SegWit and native SegWit discovery passed, including
  receive/change branches: 42 derived tokens per family.
- Eight concurrent requests through Vault's installed SDK returned HTTP 200
  without redirects or degraded balance responses.
- Public receive balances and transaction history passed. Authenticated SSE
  delivered connected and sync frames. No transaction was signed or broadcast.
- Green retained legacy version 1.4.5 and its pre-existing degraded status.

## Retirement and source ownership

Pioneer PR219 is merged:
https://github.com/coinmastersguild/pioneer/pull/219
Blue deploy/smoke/rollback jobs were removed from master and backported to
develop, release/v1.5.0 and release/v1.4.5. Workflow/docs maintenance does not
deploy green. Other jobs were preserved except for a guarded green rollback.

The exact old Deployment default/pioneer-server-v3-blue-2l3smo5j in context
do-sfo3-do-cluster-2b9226d was deleted after replacement checks. Its UID and
template matched the private rollback snapshot; no HPA targeted it. The old
pods are absent. Blue passed exact-revision health again after deletion.

Gateway PR12 is merged at c350d52e93a115e8aede941f0d92edf85878dd9a.
It contains canonical routes, future CI gates and rollback docs:
https://github.com/BitHighlander/keepkey-gateway/pull/12
Local verification passed 234 tests (21 integration skips), both typechecks
and actionlint. The verified route-only live revision remains bff70f2a83e2db01a7acb8f06d2dd714974ceaf3;
do not treat the config merge as proof of a new container deployment.

## Rollback and preserved work

Private snapshots are in /private/tmp/vault-blue-cutover-private/ (0700).
They include the immutable old running image and clean Deployment restore
manifest. Do not publish them: infrastructure manifests may contain secrets.
The old Service, Ingress and proxied DNS A record remain for rollback.
Restore the saved Deployment and verify readiness before removing only the blue
Worker route. Keep oracles.cc routed to the gateway.

The three patch files here are historical preparation artifacts.
legacy-ltc.patch represents separate legacy-adapter work preserved in the user's
dirty Pioneer checkout; PR219 changes workflow/docs only. Do not apply historical
patches blindly over merged changes.

Earlier name-resolution and localhost failures came from the restricted
execution sandbox. Host DNS resolved all five tested domains and host requests
succeeded. Cloudflare's DNS-record API 403 was a credential scope issue; Worker
route access worked. The proxied record was inspected using authenticated BEX
without editing it.
