# WonRemote Development Guardrails

These rules apply to every development activity in this repository: requirement analysis, design, implementation, testing, build, deployment, and post-release verification.

## Omission Prevention Gate

Before editing code, update `CHANGE_CONTRACT.json` with `"status": "active"` and add one `outcomes` entry for every user-requested result. Define the outermost result the user must actually see. A class, route, package, successful compile, or mocked call is not an acceptance result.

- Trace the complete vertical path from the user's action to the visible result, including every process, protocol, persistence, permission, and platform boundary.
- Cover first use, steady state, reconnect/restart, failure recovery, and every requested platform or architecture.
- Ask: "Could this proof pass while the user-visible feature is still broken?" If yes, the proof is at the wrong boundary and must be replaced or supplemented.
- Identify physical or external-service proof before implementation. If it cannot be run, the work remains explicitly incomplete at that boundary.
- For metered services, calculate idle requests per device/Viewer per day, including full-result polling and listener reconnects. Test request counts and quota-error recovery; never claim local code changes restore an already exhausted external quota.
- A functional source change must include a changed test at the leaking or user-visible boundary, not only a source-string, packaging, or constructor-presence assertion.

At completion, reread the user's exact request and map every requested outcome to one JSON entry and fresh evidence. Set `status` to `verified` only after every automatable outcome is proven; an unverified outcome must be reported as incomplete rather than omitted.

Before deployment, set `status` to `ready-to-deploy` and run `npm run change:verify:predeploy`. Only outcomes marked `deployment-required` may remain pending. After deployment, replace pending evidence with live verification, set `status` to `verified`, and run `npm run change:verify`.

## Mandatory Workflow

1. Define the observable acceptance contract and user constraints in `CHANGE_CONTRACT.json` before editing.
2. Trace the real execution path and sibling paths that share the behavior. Fix the common root cause, not one visible symptom.
3. Record affected products, platforms, architectures, persistence, security, update, and rollback boundaries.
4. For a defect, preserve a failing reproduction or focused regression test. For a feature, add or update its acceptance-contract test.
5. Make the smallest compatible change and keep unrelated work untouched.
6. Run the narrowest tests that exercise the changed boundary. Mark hardware or external-service checks as pending instead of claiming success.
7. Build only when the user explicitly requests it. Release only after the development and recurrence gate passes.
8. When any development mistake is found, add it to `INCIDENT_REGISTRY.md` immediately with its cause, permanent guard, proof, and remaining physical verification.

## Request Waste Prevention

Review request necessity BEFORE adding/changing timers, effects, listeners, retries, background services, or persistence writes. This covers local and cloud paths on every platform, not only Firestore.

- Prefer existing change notifications and loaded state over repeatedly fetching complete collections. Poll only with a documented freshness requirement and a bounded request budget. Do not combine polling with a listener for the same data.
- Assign one lifecycle owner; prevent duplicate subscriptions and overlapping requests. Cancel timers/listeners on logout, session end, unmount and service shutdown, and prevent late callbacks from restarting work.
- Bound retries with backoff; quota/auth/permission failures must not cause tight loops. Preserve session/input correctness when reducing requests. Rate limits are not a substitute for removing unnecessary work.
- Use fake time/emulators at the actual request boundary to test 24h idle, rerender/remount, slow concurrent calls, failures/reconnects and cleanup. Count requests AND documents, including startup, listener fan-out, writes, security-rule reads and reconnect costs. Do not burn production quota for load tests.
- Every `CHANGE_CONTRACT.json` requires `requestReview`: `impact` (`none` or `changed`) and a concrete `reason`. `none` means the current change cannot alter requests; it must never conceal an unreviewed request path.
- For `changed`, also supply `assumptions`, `dailyBudget` (`clients`, `readsPerClient`, `writesPerClient`, `maxReads`, `maxWrites`), `checks` evidence for `idle`, `rerender`, `concurrency`, `failure`, `cleanup`, and `contractTests` naming a changed boundary test. Derive counts from tests and declared fleet assumptions; do not invent counts or raise limits merely to pass. A nonapplicable scenario needs an explicit reason, not a blank.
- `change:verify` rejects absent review, incomplete evidence and calculated totals above the declared limits; CI also checks the committed contract on a clean checkout. This is an omission guard, not independent proof that declared counts or scope are correct. Runtime tests and human review remain required.
- Never claim all existing traffic is safe from a single-path fix or activate billing as a substitute for correcting waste. Track unaudited paths and unverified live usage explicitly.

## Completion Rules

- Do not call work complete from source inspection, compilation, or a mocked test when the acceptance contract requires runtime behavior.
- Do not retry a failed step until its cause is understood and a focused guard has been added.
- Do not weaken, skip, or delete an existing guard to make a change pass.
- Prefer focused evidence over repeated full-suite, build, or packaging runs.
- Before committing, run `npm run change:verify` from `aether-link-app`.

Every commit after the development-policy baseline must include these trailers:

```text
Intent: concise user-visible objective
Change-Type: feature | fix | refactor | test | build | docs | chore
Risk: low | medium | high
Acceptance: observable user-visible result
Contract: repository-relative path to a test changed in this commit
Proof-Level: automated-runtime | deployment-required | physical-completed | physical-required | not-applicable
Verification: exact command and result
Release-Impact: none | build | deploy | build-and-deploy
Rollback: concrete rollback action
Request-Review: none - why requests cannot change | changed - budget and request-boundary test evidence
Incident: INC-YYYYMMDD-NNN  # required for fixes
```
