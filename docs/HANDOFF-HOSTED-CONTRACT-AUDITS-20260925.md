# Hosted contract audits — review handoff

## Result

Vault shows the review submitter's name and a **More info** link to a public
HTML audit report hosted by the ClearSign server itself. The report includes
findings, references, audit date, and exact deployment identities. Its stable
content-derived URL keeps the original report accessible after later audits.

The audit is an attributed assessment. Publishing uses existing operator bearer
access. No audit signature, new signing prompt, rater wallet, or rater key is
required. Existing clear-sign definition authentication and device behavior are
unchanged by this diff. An audit cannot grant a protection level or authentication
claim. The existing risk display can reflect adverse findings.

## Review bases and locations

- Server: `/private/tmp/clearsign-audit-hosting-agent3`, branch
  `fix/hosted-contract-audits-agent3`, base
  `4ba8d323044d1698c8232c7e4d507f483ee749fe`, implementation `6fe723a`.
- Vault: `/private/tmp/vault-contract-audits-agent3`, same branch name, base
  `4823955a2a2ffa98ee4dfa90c46556bb6332638b` from
  `feature/clearsign-review-request`.

Review each diff against its stated base. These are isolated checkouts; the
shared main worktrees have not been edited. The earlier firmware block-9 work
remains isolated and unpushed in `/private/tmp/kk715-stack09-agent3` and is not
part of these changes.

## API and rollout

The server's `worker/README.md` documents the publishing JSON and public API.
`POST /v1/admin/discovery/ratings` takes `{ author, rating }` through existing
operator authentication. `GET /v1/ratings` returns the latest assessment and its
`ratingId`. `GET /audits/<ratingId>` hosts the full report without operator access.
Vault builds the report link from the configured ClearSign service URL, not from
submitted report text. Findings and names are rendered as escaped text.

No database migration is needed: new records leave the legacy signature column
empty. Stored legacy audit signatures are not represented as authenticated
auditor identities. Server and Vault updates should be released together: older
Vault versions expecting signed ratings will omit these new assessments. The
service still supplies clear-sign definitions through the existing paths.

The unsigned publication request is an intentional API change for operators.
Audit clients must use the new author field instead of a signature.

## Validation

- Worker suite: 120 passed, zero failed.
- Vault audit lookup, risk, and rendered UI tests: 49 passed, zero failed.
- Actual Worker-to-Vault roundtrip: passed publication, public lookup, wrong
  network suppression, and changed-deployment suppression.
- Wrangler deployment dry run: passed; no deployment performed.
- Vault report component browser bundle: passed.
- Diff whitespace checks: passed.

Coverage includes authentication on writes, public reads, immutable report URLs,
HTML escaping/CSP, invalid authors/dates/deployments, aggregate risk no lower than
critical findings, submitter/link rendering, and audit opinions leaving
clear-sign protection levels and authentication claims unchanged.

These checks are not a full desktop application build or interactive device test.
No live contract audit was fabricated or published. A real audit record must
supply its evidence, deployment identities, findings, and submitter.

## Review checkpoint

The original Vault review reached three Copilot rounds. Work is now split into
A: server publication and hosted report (`BitHighlander/keepkey-clearsign-server#1`),
B: Vault response parsing and deployment matching, and C: Vault display and risk.
The phase branches are stacked in that order. Phase C reached its three-round
Copilot cap; the third-round timeout findings were fixed locally and need a
final human review. No production deployment occurred.
