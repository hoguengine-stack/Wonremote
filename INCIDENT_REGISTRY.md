# WonRemote Incident Registry

Every production defect, installer failure, update failure, crash, or repeated user-visible malfunction must receive an entry before its fix is declared complete. Entries are append-only. A future change may add evidence or close a verification gap, but must not erase the original failure record.

## Required Entry Format

```text
## INC-YYYYMMDD-NNN: Short title
- Detected: UTC timestamp
- Severity: P0 | P1 | P2 | P3
- Affected: component, version(s), architecture, environment
- Status: open | fixed-not-released | released-verified | physical-verification-required
- User-visible symptom:
- Minimal trigger:
- Root cause and contributors:
- Fix commit(s):
- Permanent guard: code or process rule that prevents recurrence
- Regression proof: exact focused test or reproducible command and result
- Release proof: tag, manifest/assets/redirects, or explicitly `not released`
- Remaining blocker: explicit gap or `none`
```

## Current Release Contract

- Effective from commit `6f82268`, the user-approved public contract is two x86 installers (Viewer and Agent) plus one signed manifest. The same x86 payloads support both 32-bit and 64-bit Windows.
- The four Firebase routes are aliases (`viewer`, `agent`, `viewer-x86`, `agent-x86`) for those two installers. Separate x64 and portable artifacts are not current release requirements.
- Earlier entries describing four native x64/x86 payloads remain as historical evidence, but their architecture-count guards are superseded by this section.

## INC-20260816-005: x86 Agent published an incomplete WebRTC Answer

- Detected: 2026-08-16T22:49:00Z.
- Severity: P1.
- Affected: Viewer and x86 Agent `0.1.64`; Firebase WebRTC signaling.
- Status: physical-verification-required.
- User-visible symptom: Viewer opened a remote session but displayed no remote screen.
- Minimal trigger: Connect a Viewer to an online x86 Agent and wait for the realtime tile channel.
- Root cause and contributors: Agent persisted the pre-gather `createAnswer()` SDP instead of the final `localDescription` produced after `setLocalDescription()`. Candidate trickling made the defect intermittent, and the existing werift-to-werift smoke did not exercise the Firebase signaling write boundary.
- Fix commit(s): `c0c4ace`.
- Permanent guard: Viewer Offer and Agent Answer signaling persist final local descriptions; `agentWebRtcSignaling.test.ts` crosses the Agent-to-Firebase boundary and requires an ICE candidate in the stored Answer.
- Regression proof: `npm test -- src/firebase/agentPeerConnection.test.ts src/firebase/agentPeerConnectionWeriftSmoke.test.ts src/firebase/viewerWebRtcTransport.test.ts src/firebase/agentWebRtcSignaling.test.ts`.
- Release proof: `v0.1.65` published with Viewer and Agent installers plus signed manifest.
- Remaining blocker: Confirm a remote Viewer receives and renders the x86 Agent screen on physical devices.

## INC-20260816-006: Release packaging remained above twenty minutes

- Detected: 2026-08-16T23:15:35Z.
- Severity: P2.
- Affected: GitHub Actions `v0.1.65` x86 Viewer and Agent release workflow.
- Status: fixed-not-measured-in-ci.
- User-visible symptom: Building two installers took about 22 minutes despite the first optimization attempt.
- Minimal trigger: Push release tag `v0.1.65` and run `Publish WonRemote release`.
- Root cause and contributors: GitHub Actions run `31981757862` proved that tag-scoped cache lookup returned `Cache not found`, forcing a cold x86 build. The package script then called `tauri build` again for Agent; `WONREMOTE_BUILD_STAGE=reuse` skipped frontend/backend generation but still repeated Cargo linking and Tauri packaging for 2 minutes 15 seconds.
- Fix commit(s): `0b83867` and `d7c9ba2` were incomplete mitigations; `676abda` implements the shared-binary and main-cache fix, and `c35af78` restricts release execution to `main`.
- Permanent guard: Release builds run only from an explicit `Prepare WonRemote v...` commit on `main`, allowing later releases to restore the default-branch cache. Viewer performs the single `tauri build`; Agent uses `tauri bundle` against that already-built x86 binary. Manual pre-build release tags are prohibited.
- Regression proof: `npm test -- src/desktopPackaging.test.ts scripts/package-release-exes.test.js` -> 2 files and 58 tests passed. A local `npx tauri bundle --bundles nsis --target i686-pc-windows-msvc --config src-tauri/tauri.agent.x86.conf.json` generated the Agent installer in about 30 seconds without a Cargo compile step.
- Release proof: `v0.1.67` measured the old path at 18 minutes 15 seconds for installer generation and showed a cache miss; the optimized path is not released yet.
- Remaining blocker: Measure the next main-triggered release and one subsequent cached release; retain installed Viewer/Agent smoke verification for the shared binary.

## INC-20260812-001: Viewer update check failed in installed Viewer

- Detected: 2026-08-12.
- Severity: P1.
- Affected: installed Viewer `0.1.59` on Windows x64; manual and automatic update checks.
- Status: released-physical-verification-required.
- User-visible symptom: Manual update check displayed `Update check failed` because the installed WebView directly fetched the GitHub release manifest.
- Minimal trigger: Open an installed `0.1.59` Viewer and use its update-check control.
- Root cause: GitHub release-asset redirects do not provide a stable browser CORS contract. Separately, Tauri passed Windows verbatim (`\\?\\`) resource paths to bundled Node.js, which failed with `EISDIR`.
- Fix commit(s): `96ddc14`; `9e5a0b7`.
- Permanent guard: Installed Viewer checks use the native signed updater only; all Node-facing resource paths derive from `node_resource_paths`.
- Regression proof: `npm test -- src/desktopPackaging.test.ts src/agent/productionUpdateCheck.test.ts` and `cargo test --manifest-path src-tauri/Cargo.toml test_node_resource_paths`.
- Release proof: `v0.1.60` GitHub Actions release workflow started; final published-asset verification remains required.
- Remaining blocker: Same-tag published assets and installed-runtime update verification are not yet confirmed.

## INC-20260816-001: Single-architecture release could regress x64 runtime and block cross-architecture reinstall

- Detected: 2026-08-16T08:05:42Z.
- Severity: P1.
- Affected: Viewer and Agent `0.1.60` release lane; Windows x64 and x86 installation/update paths.
- Status: fixed-not-released.
- User-visible symptom: A consolidated x86-only release would move x64 clients from native WebRTC to the x86 fallback, while a manual x64/x86 replacement could leave the previous process holding installer files.
- Minimal trigger: Publish one x86 payload for both architectures or install a different architecture over a running WonRemote product.
- Root cause and contributors: Public asset count was reduced by deleting the native x64 payload instead of wrapping both architectures; installer process cleanup also filtered targets by PE architecture.
- Fix commit(s): `5ab222d`.
- Permanent guard: Viewer and Agent each use a product-isolated universal NSIS wrapper with native x64/x86 payload selection; x86 packaging executes the bundled ia32 Node and `werift` smoke; installer cleanup stops every process under the exact product root regardless of architecture.
- Regression proof: `npm test -- src/desktopPackaging.test.ts src/domain/updateManifest.test.ts src/domain/updateManifestScript.test.ts src/domain/installerHookIsolation.test.ts src/agent/agentWebRtcRuntimeSmoke.test.ts src/agent/productionUpdateMetadata.test.ts src/agent/agentUpdateOnce.test.ts src/agent/productionInstallerUpdate.test.ts src/api/viewerUpdate.test.ts src/domain/versioning.test.ts scripts/build-backend.test.js scripts/package-release-exes.test.js` -> 12 files and 101 tests passed; four release scripts passed `node --check`; `git diff --check` passed. `0.1.61` built both architecture payloads and two universal wrappers; the signed manifest verified both universal assets, and x64 Viewer/Agent physical replacement preserved the Agent identity and runtime.
- Release proof: not released.
- Remaining blocker: Physical install/update verification on Windows x86 remains required before publishing.

## INC-20260816-002: x86 release build crashed before runtime smoke execution

- Detected: 2026-08-16T08:33:37Z.
- Severity: P1.
- Affected: `0.1.61` x86 release build; `scripts/build-backend.js` runtime smoke stage.
- Status: fixed-not-released.
- User-visible symptom: `npm run release:exes` stopped at the x86 Viewer build with `ReferenceError: ensureExists is not defined` after completing both x64 installers.
- Minimal trigger: Run an ia32 backend build without injecting a test-only `ensureFile` function.
- Root cause and contributors: The production default parameter referenced a nonexistent helper, while the original tests always injected a mock and never exercised the default path.
- Fix commit(s): `07a51e6`.
- Permanent guard: The smoke check now defaults to the real `ensureBuildArtifact` helper, and a temporary-files regression test invokes the production default without dependency injection.
- Regression proof: `npm test -- scripts/build-backend.test.js src/agent/agentWebRtcRuntimeSmoke.test.ts` -> 2 files and 5 tests passed; `node --check scripts/build-backend.js` and `git diff --check` passed. A clean `npm run release:exes` then completed x64 and x86 packaging in 512.96 seconds, including the bundled ia32 Node and `werift` runtime smoke.
- Release proof: not released.
- Remaining blocker: Windows x86 physical installation remains required before release publication.

## INC-20260816-003: Viewer replacement stopped the background Agent

- Detected: 2026-08-16T08:48:49Z.
- Severity: P1.
- Affected: `0.1.61` Viewer upgrade from an older installed Viewer while the Windows Agent is running.
- Status: fixed-not-released.
- User-visible symptom: A silent Viewer reinstall completed successfully but the Agent process disappeared and did not return.
- Minimal trigger: Start the installed Agent, then run the universal Viewer installer with `/S` over the existing Viewer.
- Root cause and contributors: The previously installed Viewer uninstaller still contained legacy cross-product process cleanup and could terminate the Agent during replacement. Product isolation in the new inner installer cannot change that already-installed uninstaller.
- Fix commit(s): `bce5194`.
- Permanent guard: The universal Viewer wrapper restarts an installed Agent after successful Viewer replacement without embedding or reinstalling the Agent payload; focused wrapper tests enforce both restart and product isolation. Wrapper-only assembly reuses already-built inner installers for fast validation.
- Regression proof: `npm test -- scripts/package-release-exes.test.js src/desktopPackaging.test.ts` -> 2 files and 56 tests passed. On Windows x64, silent Viewer replacement changed the running Agent PID from `3056` to `19296`, then kept exactly one Agent process running; Viewer and Agent both reported `0.1.61`, and device identity remained `123-45-67890:AGENT-82220F6D`.
- Release proof: not released.
- Remaining blocker: Windows x86 physical installation remains required before release publication.

## INC-20260816-004: Installer update could leave a partially replaced product without file rollback

- Detected: 2026-08-16T09:15:46Z.
- Severity: P1.
- Affected: installed Viewer and Agent updater handoff on Windows x64 and x86.
- Status: fixed-not-released.
- User-visible symptom: An installer failure or post-install runtime health failure could restart a partially replaced product instead of restoring the previous installation files.
- Minimal trigger: Start a verified installer update that either exits nonzero after changing files or exits zero while the replacement runtime cannot remain healthy.
- Root cause and contributors: The handoff treated process restart as rollback, had no pre-install product-root backup, and had no end-to-end fixture covering real file replacement and recovery.
- Fix commit(s): `3c055a2`.
- Permanent guard: The handoff completes a transactional product-root backup before stopping the old runtime, restores files on installer or health failure, retains backup files if restoration itself fails, and refuses to start installation without a complete backup. Local and CI publication also require the installer-update E2E and direct extraction of all four x64/x86 inner payload hosts.
- Regression proof: `npm test -- scripts/verify-universal-installer-payloads.test.js scripts/package-release-exes.test.js src/agent/productionInstallerUpdate.test.ts` -> 3 files and 14 tests passed. `npm run test:update-e2e` proved successful old-to-new replacement, nonzero installer rollback, post-install health rollback, and backup-unavailable refusal. `npm run release:verify-payloads` reproduced both universal wrappers and directly extracted all four inner installers to verify x64/x86 host PE machines.
- Release proof: not released; source build and version were intentionally unchanged.
- Remaining blocker: Build a new version and complete Windows x86 physical installation before publication.

## INC-20260816-007: Korean IME input did not reach the remote session

- Detected: 2026-08-16.
- Severity: P1.
- Affected: Viewer remote-session keyboard path before `0.1.64`.
- Status: physical-verification-required.
- User-visible symptom: The Korean/English toggle and composed Korean text worked locally or not at all instead of reaching the remote PC.
- Minimal trigger: Focus an active remote canvas, toggle Korean input, and compose Korean text.
- Root cause and contributors: The canvas-only key path could not receive browser IME composition reliably, and `Process`/key code `229` could be duplicated as ordinary key events.
- Fix commit(s): `49e513e`.
- Permanent guard: A focused invisible IME sink owns the Viewer-local Hangul state, sends completed text through the Unicode text command, and never forwards the Hangul toggle to the remote PC.
- Regression proof: `npm test -- src/remoteSessionLayout.test.ts` covers the IME sink, composition handlers, Unicode command, duplicate suppression, and three Hangul-toggle entry points.
- Release proof: `v0.1.64` and later include the source fix.
- Remaining blocker: Confirm Korean composition and Hangul toggle on a physical Viewer-to-Agent session.

## INC-20260816-008: Release CI ran Rust resource tests before generated resources existed

- Detected: 2026-08-16.
- Severity: P2.
- Affected: GitHub Actions release runs `31959115773`, `31959487166`, and `31959834682`.
- Status: released-verified.
- User-visible symptom: Release jobs failed before publication; splitting the combined test step exposed repeated failure at `Verify Tauri resource paths`.
- Minimal trigger: Run Tauri library tests in a clean runner before release resource generation.
- Root cause and contributors: The Rust test target still compiled code requiring generated release resources. Adding `--lib` reduced unrelated targets but did not create those resources; the original combined step also obscured which boundary failed.
- Fix commit(s): `97248cf`, `5b6ef5d`, `9997ff1`.
- Permanent guard: Release diagnostics use separate named steps, and x86 release resources are generated before architecture-specific Tauri resource tests.
- Regression proof: The next workflow advanced beyond both Tauri resource steps to `Publish GitHub release`; current workflow preserves build-before-Rust-gates ordering.
- Release proof: `v0.1.63`, `v0.1.64`, and `v0.1.65` completed the ordered workflow.
- Remaining blocker: none.

## INC-20260816-009: GitHub release publication misclassified uploaded assets

- Detected: 2026-08-16.
- Severity: P1.
- Affected: GitHub Actions release runs `31960134684` and `31961341996` at `Publish GitHub release`.
- Status: released-verified.
- User-visible symptom: Valid installer uploads remained in a draft/failed release because immediate asset-list reads did not prove the exact uploaded set.
- Minimal trigger: Upload the three release assets and immediately validate them through a separate GitHub asset-list request.
- Root cause and contributors: GitHub list visibility can lag upload completion. A timed retry still depended on eventual list consistency instead of the metadata returned by each successful upload.
- Fix commit(s): `3bfd159`, `acd9580`.
- Permanent guard: Publication collects each upload response directly and verifies the returned name and size before making the release public; partial or mismatched uploads remain draft.
- Regression proof: `npm test -- src/desktopPackaging.test.ts` asserts the three returned upload records and exact asset validation contract; GitHub Actions run `31977574777` crossed the real upload/list/publish boundary successfully.
- Release proof: Later `v0.1.63`, `v0.1.64`, and `v0.1.65` publication runs succeeded.
- Remaining blocker: none.

## INC-20260816-010: Release hardening changed code without updating its contract test

- Detected: 2026-08-16.
- Severity: P2.
- Affected: GitHub Actions run `31962506495`, step `Verify release contract tests`.
- Status: released-verified.
- User-visible symptom: Release CI stopped before packaging because static contract expectations still described the previous cache and publication implementation.
- Minimal trigger: Run focused release-contract tests after changing cache restore/save and direct upload-response verification.
- Root cause and contributors: Implementation and its source-contract assertions were committed separately, so the first CI run necessarily failed.
- Fix commit(s): `b83d48e` aligns the tests with `acd9580`.
- Permanent guard: Changes to release workflow or publication script must update and run `desktopPackaging.test.ts` in the same commit before a tag is pushed.
- Regression proof: `npm test -- src/desktopPackaging.test.ts` passed in subsequent release workflows.
- Release proof: Subsequent releases completed the contract-test gate.
- Remaining blocker: none.

## INC-20260816-011: PowerShell variable interpolation corrupted the draft release URI

- Detected: 2026-08-16.
- Severity: P1.
- Affected: GitHub Actions run `31963315096`, step `Publish GitHub release`.
- Status: released-verified.
- User-visible symptom: Publication could not locate or create the expected release after the tag endpoint fallback.
- Minimal trigger: Evaluate `"$ReleaseApi?per_page=100"` in PowerShell when querying draft releases.
- Root cause and contributors: PowerShell parsed the question mark as part of the variable token instead of appending it to the URI.
- Fix commit(s): `33358a4`.
- Permanent guard: Braced interpolation (`${ReleaseApi}`) is mandatory when punctuation immediately follows a PowerShell variable; the exact URI source is asserted by the release contract test.
- Regression proof: `npm test -- src/desktopPackaging.test.ts` checks `${ReleaseApi}?per_page=100`; GitHub Actions run `31977574777` crossed the PowerShell/GitHub release lookup and publication boundary successfully.
- Release proof: `v0.1.63` and later were published successfully.
- Remaining blocker: none.

## INC-20260816-012: Publication failure forced expensive release builds to repeat

- Detected: 2026-08-16.
- Severity: P2.
- Affected: GitHub Actions release workflow before commit `1d2dcaf`.
- Status: released-verified.
- User-visible symptom: A publication-only failure required rerunning the long x86 packaging job, wasting user time and CI resources.
- Minimal trigger: Let the publish step fail after verified installers have already been built.
- Root cause and contributors: Build, verification, and GitHub publication were one job with no durable handoff artifact.
- Fix commit(s): `1d2dcaf`.
- Permanent guard: `build-release` uploads a short-lived verified artifact and `publish-release` downloads it in a separate write-permission job; publication retries cannot rebuild installers.
- Regression proof: `npm test -- src/desktopPackaging.test.ts` asserts the two-job dependency and upload/download artifact handoff.
- Release proof: Current release workflow and `v0.1.65` use the split job contract.
- Remaining blocker: Build duration itself remains open under `INC-20260816-006`.

## INC-20260817-001: Hangul input mixed local IME composition with remote key injection

- Detected: 2026-08-17.
- Severity: P1.
- Affected: Viewer remote-session keyboard and pointer lifecycle after `0.1.65`.
- Status: physical-verification-required.
- User-visible symptom: Pressing the Korean/English key and typing caused abnormal repeated input and lag; a single mouse click could appear held.
- Minimal trigger: Enter a remote session, press the Korean/English key, type immediately, then click and leave or blur the remote canvas.
- Root cause and contributors: The hidden IME sink swallowed the Hangul key without preventing local composition, while printable keys could travel through composition/input and key handlers. Pointer down had no duplicate guard, and delayed movement was not cancelled on every input-release boundary.
- Fix commit(s): `51be375` with `Incident: INC-20260817-001` trailer.
- Permanent guard: Superseded by `INC-20260818-002` for Hangul and Agent down-event handling. Viewer owns local IME composition and deduplicates physical transitions; Agent state is retained only for recovery and must not discard explicit down/up commands.
- Regression proof: `npm test -- src/remoteSessionLayout.test.ts src/domain/remoteControlCommands.test.ts src/agent/agentCommandActions.test.ts src/agent/agentCommandExecution.test.ts src/agent/persistentInputShutdown.test.ts src/agent/agentPointerState.test.ts` -> 6 files and 82 tests passed; `npx tsc --noEmit` passed.
- Release proof: `v0.1.67` published the x86 Viewer and Agent installers through successful GitHub Actions run `31981757862`.
- Remaining blocker: Confirm Hangul typing, pointer release, Fit height, and fullscreen/window transitions on physical Viewer and Agent devices.

## INC-20260817-002: Release contract test retained the previous Fit width rule

- Detected: 2026-08-17.
- Severity: P2.
- Affected: GitHub Actions release run `31981596648`, step `Verify release contract tests`.
- Status: released-verified.
- User-visible symptom: `v0.1.66` stopped before installer packaging even though the Fit implementation intentionally removed the canvas width cap.
- Minimal trigger: Run `desktopPackaging.test.ts` after changing focused-session Fit from `max-width: 100%` to height-filling `max-width: none`.
- Root cause and contributors: The implementation and focused layout tests changed together, but the release contract test still asserted the previous CSS token and was not included in pre-tag validation.
- Fix commit(s): `1986838`.
- Permanent guard: Every remote-session CSS contract change must update and run both `remoteSessionLayout.test.ts` and `desktopPackaging.test.ts` before a release tag is created.
- Regression proof: `npm test -- src/desktopPackaging.test.ts src/remoteSessionLayout.test.ts src/domain/versioning.test.ts` -> 3 files and 72 tests passed; the release contract now asserts height-filling Fit with `max-width: none`.
- Release proof: GitHub Actions run `31981757862` passed the corrected release-contract gate and published `v0.1.67` with exactly the Viewer installer, Agent installer, and signed update manifest.
- Remaining blocker: none.

## INC-20260818-001: Remote input release could be discarded or reordered

- Detected: 2026-08-18.
- Severity: P1.
- Affected: Viewer pointer/keyboard generation, Firebase input fallback, Agent input acknowledgement tracking, and session shutdown.
- Status: source-fixed-physical-verification-required.
- User-visible symptom: A single click or held key could remain active, mouse down/up could arrive out of order, and keyboard release could disappear after focus moved inside the Viewer.
- Minimal trigger: Press or click in a remote session while the WebRTC control channel falls back to Firebase, move focus to a Viewer control, or lose the input-pipe acknowledgement after Win32 accepted the down event.
- Root cause and contributors: Viewer tracked keys by the mutable logical key instead of physical code, unsupported mouse buttons fell through as left click, fallback requests ran concurrently, session close could overtake release commands, and Agent state was updated only after acknowledgement so a lost acknowledgement caused the later release to be suppressed.
- Fix commit(s): `901b205`.
- Permanent guard: Track physical keys and exact mouse buttons, release at the last pointer coordinate, serialize reliable fallback transitions per session, drop lossy move fallback, order Firestore commands by creation time, enqueue releases before session close, record down intent before acknowledgement, and never suppress an explicit up transition.
- Regression proof: `npm test -- src/api/viewerApi.test.ts src/domain/viewerInputState.test.ts src/remoteSessionLayout.test.ts src/domain/agentCommandOrdering.test.ts src/agent/agentCommandActions.test.ts src/agent/agentPointerState.test.ts src/agent/agentCommandExecution.test.ts src/agent/persistentInputShutdown.test.ts src/agent/persistentInputInjector.test.ts` -> 9 files and 105 tests passed.
- Release proof: none; no version bump, installer build, or publication was requested for this source-only fix.
- Remaining blocker: Verify left/right/middle click hold and release, modifier chords, focus loss, and session close on two physical PCs after the next requested build.

## INC-20260818-002: Local IME, modifier shortcuts, and first click were filtered incorrectly

- Detected: 2026-08-18.
- Severity: P1.
- Affected: Viewer Korean text composition, Ctrl shortcuts, Agent keyboard/button recovery state, and remote taskbar clicks.
- Status: source-fixed-physical-verification-required.
- User-visible symptom: The Viewer Hangul key did not switch the local IME, Ctrl+C/Ctrl+V failed, and a remote taskbar click could be ignored.
- Minimal trigger: Toggle Hangul while the remote canvas owns focus, or send a new key/button down after the persistent input pipe accepted the previous down but its acknowledgement was lost.
- Root cause and contributors: Viewer toggled the remote IME instead of composing in a local hidden input; Agent treated recovery state as an input deduplication filter, so stale pressed state discarded the next explicit key/button down.
- Fix commit(s): `5357953`.
- Permanent guard: Compose text only through the focused local IME sink, keep modifier shortcuts on raw down/up events, compare the actual event target before suppressing text input, and use Agent pressed state only for shutdown recovery while forwarding every explicit down/up transition.
- Regression proof: `npm test -- src/domain/viewerInputState.test.ts src/domain/remoteControlCommands.test.ts src/remoteSessionLayout.test.ts src/agent/agentCommandActions.test.ts src/agent/agentPointerState.test.ts src/agent/agentCommandExecution.test.ts` -> 6 files and 95 tests passed.
- Release proof: none; no build, version bump, or publication was requested.
- Remaining blocker: Verify Korean composition, Ctrl+C/Ctrl+V, and remote taskbar click on two physical PCs after the next requested build.

## INC-20260819-001: Fullscreen Fit cropped the horizontal edges

- Detected: 2026-08-19T05:15:30Z.
- Severity: P1.
- Affected: Viewer focused-session and fullscreen canvas sizing.
- Status: physical-verification-required.
- User-visible symptom: The remote desktop filled the available height but its left and right edges were outside the visible fullscreen viewport.
- Minimal trigger: Open a remote session whose aspect ratio differs from the Viewer viewport and enter fullscreen Fit mode.
- Root cause and contributors: The canvas was forced to `height: 100%` with no width limit while its parent hid overflow, so height-based scaling expanded the canvas beyond the viewport width.
- Fix commit(s): `9b9409b`.
- Permanent guard: Fit sizes the canvas element itself with automatic width and height plus 100% maximum bounds. `object-fit` is prohibited on the remote canvas because internal letterboxing would make pointer coordinates disagree with the visible image.
- Regression proof: `npm test -- src/remoteSessionLayout.test.ts src/desktopPackaging.test.ts` passed 69 tests; the final combined focused gate passed 92 tests across five files.
- Release proof: `v0.1.71` published Viewer and Agent x86 installers plus the signed update manifest through successful GitHub Actions run `32218801753`.
- Remaining blocker: Confirm no horizontal crop and correct edge clicks on a physical Viewer at mismatched aspect ratios.

## INC-20260819-002: A completed click could remain as a remote drag

- Detected: 2026-08-19T05:15:30Z.
- Severity: P1.
- Affected: Viewer pointer capture, movement batching, and global pointer-release recovery.
- Status: physical-verification-required.
- User-visible symptom: Moving the mouse after one left click could be interpreted as dragging on the remote PC.
- Minimal trigger: Complete a click while the canvas loses or misses its pointer-up event, then move the pointer over the remote canvas.
- Root cause and contributors: Release recovery listened for legacy `mouseup` only, did not reconcile the browser `buttons` mask during movement, and could leave a scheduled move alive across the release boundary.
- Fix commit(s): `b56423b`.
- Permanent guard: Global `pointerup` and `pointercancel` release tracked buttons, every release cancels pending movement, and a move whose physical `buttons` mask no longer contains a tracked button emits the missing `mouse-up` before that move. Only the pointer ID that owns the active press may reconcile or release it; session, visibility, blur, and lost-capture release paths remain mandatory.
- Regression proof: Focused RED runs failed before the missing-release and pointer-ownership guards; `npm test -- src/domain/viewerInputState.test.ts src/viewerPointerLifecycle.test.ts` passed 17 tests, and the final combined focused gate passed 92 tests across five files.
- Release proof: `v0.1.71` published Viewer and Agent x86 installers plus the signed update manifest through successful GitHub Actions run `32218801753`.
- Remaining blocker: Confirm click, intentional drag, capture loss, and session-close release on two physical PCs.

## INC-20260819-003: Session startup serialized signaling and dropped early key repeats

- Detected: 2026-08-19T11:31:14Z.
- Severity: P1.
- Affected: Firebase direct session creation, Viewer WebRTC control startup, and remote keyboard repeat handling.
- Status: physical-verification-required.
- User-visible symptom: Entering a remote session was slow, early keyboard input was delayed or missing, and holding Backspace deleted only one character.
- Minimal trigger: Connect through Firebase, type before the WebRTC control channel opens, then hold Backspace.
- Root cause and contributors: Session creation and `start-stream` used two sequential Firestore writes, the Viewer did not expose the transport until its offer write completed, the connection watchdog started after that write and treated the tile channel alone as ready, a saturated pre-open queue could mix WebRTC with Firestore fallback ordering, and every repeated browser keydown was discarded.
- Fix commit(s): `936a6c4`.
- Permanent guard: Commit the connected session and `start-stream` command in one Firestore batch, return the Viewer transport while signaling continues, start the watchdog independently of Firestore, require both tile and control channels before readiness, close a saturated queue before allowing fallback, reconnect when the control channel fails, and forward repeat keydown only for an already tracked physical key.
- Regression proof: Focused Viewer input, WebRTC transport, atomic session start, Firestore write, remote layout, and packaging tests passed 92 tests across six files; three focused Native policy tests and the frontend production build passed.
- Release proof: `v0.1.72` published the x86 Viewer and Agent installers plus the signed update manifest through successful GitHub Actions run `32249082554`.
- Remaining blocker: Confirm first-frame time and held Backspace behavior on two physical PCs.

## INC-20260819-004: Native Viewer updater installed without WebView confirmation

- Detected: 2026-08-19T11:31:14Z.
- Severity: P1.
- Affected: Viewer startup update watcher, tray restart, and update dialog.
- Status: physical-verification-required.
- User-visible symptom: A detected Viewer update could start without the requested confirmation modal.
- Minimal trigger: Launch an outdated installed Viewer and wait for the Native startup watcher.
- Root cause and contributors: The Native shell called the installer updater automatically after startup, while the existing dialog guarded only the manual update button.
- Fix commit(s): `936a6c4`.
- Permanent guard: Native startup performs no installation, automatic and manual checks only populate the WebView modal, an available update modal has one explicit confirmation button, and tray restart schedules a plain restart so the reopened Viewer performs the same consent flow.
- Regression proof: Focused desktop packaging contract passed 56 tests; Native policy tests and frontend production build passed.
- Release proof: `v0.1.72` published the x86 Viewer and Agent installers plus the signed update manifest through successful GitHub Actions run `32249082554`.
- Remaining blocker: Confirm startup detection, modal confirmation, installer handoff, and tray restart on an installed Viewer.

## INC-20260819-005: Agent status window ignored its compact operating role

- Detected: 2026-08-19T11:31:14Z.
- Severity: P2.
- Affected: Agent first-run, registered status, tray reopen, and self-healing window display.
- Status: physical-verification-required.
- User-visible symptom: Opening the Agent displayed an oversized Viewer-like window around a small status card.
- Minimal trigger: Start or reopen the installed executable in `--agent` mode.
- Root cause and contributors: Viewer and Agent shared one default Tauri window size and every show path reused it without an Agent-specific policy.
- Fix commit(s): `936a6c4`.
- Permanent guard: Every Agent show path reapplies a non-resizable `400x520` logical window policy; Viewer mode has no compact policy and remains unchanged.
- Regression proof: Focused Native Agent window policy test passed and `git diff --check` passed.
- Release proof: `v0.1.72` published the x86 Viewer and Agent installers plus the signed update manifest through successful GitHub Actions run `32249082554`.
- Remaining blocker: Confirm no scrolling at 100%, 125%, and 150% Windows DPI on an installed Agent.

## INC-20260820-001: Remote session still restarted capture and discarded the first keyframe

- Detected: 2026-08-19T16:03:29Z.
- Severity: P1.
- Affected: Viewer Firebase direct session startup, Agent WebRTC offer handling, duplicate `start-stream` recovery, and initial capture delivery.
- Status: fixed-not-released.
- User-visible symptom: An online Agent still took too long to show its first usable remote frame after the Viewer pressed connect.
- Minimal trigger: Open a Firebase remote session while the Agent recovery query, command listener, WebRTC negotiation, and capture startup overlap.
- Root cause and contributors: The Viewer added a redundant device read before its atomic session commit; the Agent polled the offer at 250ms intervals, could restart an already active capture when recovery and command delivery overlapped, and discarded a keyframe produced before the data channel opened. The selected stream mode could also race startup, entering a session forced a fullscreen transition and canvas reflow, and an older in-flight connection could replace a newer or closed session.
- Fix commit(s): `02e1531`.
- Permanent guard: Remove the duplicate device read but expose the Viewer session only after the atomic commit, reject devices without a server-generated heartbeat from the last 60 seconds in both direct-rule and callable paths, track normal and secure connection attempts through cleanup before logout or close, listen for the offer with a one-shot realtime subscription, ignore duplicate active `start-stream` commands, retain one session-scoped initial keyframe until WebRTC opens and request one fresh keyframe after every negotiation, defer the selected stream-mode command until the realtime control channel is ready, keep the established per-profile JPEG merge width so a tile does not exceed the WebRTC message limit, and enter sessions in windowed mode unless the user explicitly requests fullscreen.
- Regression proof: Focused RED reproduced the realtime offer delay contract, duplicate start guard, missing initial-keyframe buffer, premature stream-mode dispatch, stale normal/secure connection-attempt guards, stale or future-dated online-device rules, renegotiation first-frame loss, and forced-fullscreen contract. Focused GREEN passes 104 Node tests across eight files; application and Cloud Functions `npx tsc --noEmit`, `npm run recurrence:verify`, and `git diff --check` pass. The Firestore emulator command is blocked because Java is not installed on this PC; the source-level Firebase security policy tests pass.
- Release proof: `v0.1.73` published the two x86 installers and signed manifest through successful GitHub Actions run `32604699424`.
- Remaining blocker: Measure click-to-first-presented-frame on the Viewer and Agent physical PCs after the next explicitly requested release build.

## INC-20260823-001: A healthy WebRTC session was closed by a stale reconnect timer

- Detected: 2026-08-23.
- Severity: P1.
- Affected: Viewer WebRTC error classification/reconnect lifecycle, Agent ICE signaling, packaged RTC configuration, runtime loading, and first-keyframe synchronization.
- Status: released-physical-verification-required.
- User-visible symptom: The first WebRTC channels opened about one second after `start-stream`, closed again within roughly half a second, and repeated negotiation until the remote screen appeared about 30 seconds later.
- Minimal trigger: Let a trickle-ICE candidate write/add/listener operation report an error while the tile and control channels are opening or already healthy.
- Root cause and contributors: Candidate-level diagnostics were treated as fatal transport failures; Viewer reconnect timers scheduled before `webrtc-open` were not cancelled after the channels became healthy; Agent and Viewer repeated the same fatal candidate policy; the x86 Agent loaded its WebRTC runtime only on demand; channel-open synchronization could send both a buffered keyframe and an unnecessary fresh keyframe; and the first `set-stream-mode fast` command restarted the capture process during initial connection. Release builds also had no enforced path for passing the same optional TURN configuration to the packaged Agent.
- Fix commit(s): `02e1531`.
- Permanent guard: Classify candidate-level failures as diagnostics while retaining timeout, SDP, and confirmed channel failures as fatal; do not tear down on the transient WebRTC `disconnected` state; resubscribe failed Agent signaling/candidate listeners without closing a healthy peer; cancel pending Viewer reconnect work immediately on `webrtc-open`; never schedule reconnect while the current channel is open; prewarm the architecture-specific Agent WebRTC runtime; send either the buffered initial keyframe or request one fresh keyframe, never both; update capture sleep/quality/merge settings through the running process instead of restarting capture; remove inherited runtime ICE variables before launching the packaged Agent; map one release ICE configuration into both Viewer and packaged Agent; and reject partial TURN or relay-only-without-TURN release configuration.
- Regression proof: `npx vitest run src/domain/webrtcStability.test.ts src/firebase/agentWebRtcSignaling.test.ts src/firebase/agentPeerConnection.test.ts src/firebase/viewerWebRtcTransport.test.ts src/remoteSessionLayout.test.ts src/agent/agentCommandExecution.test.ts` passed 98 tests across six files; the release ICE packaging contract, packaged-Agent build-only RTC configuration test, and runtime stream-profile parser test passed; `npx tsc --noEmit`, `npm run recurrence:verify`, and `git diff --check` passed.
- Release proof: `v0.1.73` published the two x86 installers and signed manifest through successful GitHub Actions run `32604699424`.
- Remaining blocker: Configure and physically verify an operating TURN service for symmetric-NAT/UDP-blocked sites, then measure click-to-first-presented-frame on LAN and relay paths after the next explicitly requested build.

## INC-20260823-002: Live Firebase x86 download aliases targeted removed release assets

- Detected: 2026-08-23.
- Severity: P1.
- Affected: Firebase Hosting download aliases and the post-release delivery gate.
- Status: fixed-deployed.
- User-visible symptom: `/download/viewer-x86` and `/download/agent-x86` redirected to removed `*-Setup-x86.exe` asset names even though the release contained only the approved stable Viewer and Agent installers.
- Minimal trigger: Publish the two-installer x86 release contract while Firebase Hosting still serves an older redirect configuration.
- Root cause and contributors: Source configuration and tests were correct, but Hosting had not been redeployed and the release workflow validated repository configuration rather than the four live download aliases.
- Fix commit(s): `1c9b8d2`.
- Permanent guard: After every GitHub release publish, issue a live no-follow HEAD request for `viewer`, `agent`, `viewer-x86`, and `agent-x86`; require HTTP 302 and exact stable Viewer or Agent asset destinations before declaring delivery successful.
- Regression proof: `npx vitest run src/desktopPackaging.test.ts` passed 57 tests; after Hosting deployment at `2026-08-22T23:27:59Z`, live no-follow HEAD checks returned HTTP 302 with exact stable Viewer/Agent destinations and followed requests returned HTTP 200 for all four aliases.
- Release proof: GitHub release `v0.1.73` contains exactly the two x86 installers and signed manifest; Firebase Hosting and Firestore rules deployment completed successfully against project `wonremote-a7fd3`.
- Remaining blocker: none for the download-alias path.

## INC-20260824-001: Elevated Windows tools blocked subsequent remote input

- Detected: 2026-08-24.
- Severity: P1.
- Affected: Agent system-tool launch and persistent Win32 input injection.
- Status: released-physical-verification-required.
- User-visible symptom: After opening Task Manager or Device Manager from the Viewer tools menu, mouse and keyboard input no longer controlled that foreground window.
- Minimal trigger: Run `system taskmgr` or `system devmgmt.msc` from a medium-integrity Agent and then send a normal mouse or keyboard action.
- Root cause and contributors: Windows can auto-elevate these management tools above the Agent input process; UIPI then rejects medium-integrity `SendInput` events directed at the elevated foreground window.
- Fix commit(s): `5ec6e01`.
- Permanent guard: Launch Task Manager, Device Manager, and Services directly with a scoped `RunAsInvoker` environment instead of a shell command so their viewing UI stays at the Agent integrity level; keep privileged mutations outside this path; expose Win+R through the same Viewer/Agent/Rust whitelist.
- Regression proof: Six focused Node files passed 108 tests, the focused Rust system-command policy test passed, and `git diff --check` passed.
- Release proof: `v0.1.74` published through successful GitHub Actions run `32663031781`; physical UIPI behavior remains to be checked on an installed Agent.
- Remaining blocker: Physical verification on the installed Agent is required because process integrity and UIPI behavior cannot be proven by source tests alone.

## INC-20260824-002: Korean IME composition was emitted only after syllable commit

- Detected: 2026-08-24.
- Severity: P1.
- Affected: Viewer local IME sink, WebRTC control commands, and Rust Unicode input injection.
- Status: released-physical-verification-required.
- User-visible symptom: A composing Korean syllable became visible remotely only when the next syllable started.
- Minimal trigger: Focus the remote canvas, switch the Viewer PC to Korean, and compose a multi-jamo syllable.
- Root cause and contributors: Composition input was intentionally suppressed until `compositionend`; no protocol existed to atomically replace the previously displayed preedit text during `compositionupdate`.
- Fix commit(s): `5ec6e01`.
- Permanent guard: Send every changed preedit value as one bounded atomic replace-text command, suppress the duplicate trailing input event, and validate the command across Viewer state, WebRTC Agent control, and Rust Unicode input construction.
- Regression proof: Six focused Node files passed 108 tests, the focused Rust IME replacement test passed, and `git diff --check` passed.
- Release proof: `v0.1.74` published through successful GitHub Actions run `32663031781`; physical Korean IME behavior remains to be checked on an installed Viewer and Agent.
- Remaining blocker: Physical verification with the Windows Korean IME after the next requested build.

## INC-20260824-003: File transfer exposed numbers but no progress bar

- Detected: 2026-08-24.
- Severity: P2.
- Affected: Viewer WebRTC, Firebase Storage, Firestore fallback transfer feedback, and remote-session toolbar.
- Status: released-physical-verification-required.
- User-visible symptom: File transfer progress was not visible as a real-time loading bar.
- Minimal trigger: Send a sufficiently large file while a remote session is active.
- Root cause and contributors: All three transfer paths already reported real byte progress, but the toolbar rendered that state as transient text only.
- Fix commit(s): `5ec6e01`.
- Permanent guard: Bind existing WebRTC acknowledgement, Firebase Storage upload, and Firestore chunk byte percentages to an always-visible accessible overlay progress bar; show an immediate preparation state and prevent an older multi-file clear timer from hiding the active transfer.
- Regression proof: Focused WebRTC transport, Firebase Storage, remote layout, command, and input tests were included in the six Node files and all 108 tests passed; `git diff --check` passed.
- Release proof: `v0.1.74` published through successful GitHub Actions run `32663031781`; physical transfer feedback remains to be checked with a real file.
- Remaining blocker: Physical transfer verification after the next requested build.

## INC-20260824-004: Release contract test rejected valid guarded checksum code

- Detected: 2026-08-24.
- Severity: P1.
- Affected: GitHub Actions `Verify release contract tests` and the `v0.1.74` publication path.
- Status: fixed-deployed.
- User-visible symptom: The requested release stopped before packaging even though file uploads still calculated SHA-256 before creating metadata.
- Minimal trigger: Add checksum error cleanup by declaring `fileSha256` before a `try` block, then run `src/desktopPackaging.test.ts`.
- Root cause and contributors: The static release guard asserted one exact JavaScript declaration string instead of the required checksum assignment behavior, so an equivalent guarded implementation produced a false failure.
- Fix commit(s): `277838d`.
- Permanent guard: Match the checksum assignment semantically enough to allow `const`, `let`, and a type annotation while still requiring `await sha256BlobHex(file)` and the `fileSha256` metadata field.
- Regression proof: `src/desktopPackaging.test.ts` passed 57 tests locally; the complete release-contract test step passed in GitHub Actions run `32663031781`.
- Release proof: GitHub Actions run `32663031781` published `v0.1.74` with exactly the x86-compatible Viewer installer, Agent installer, and signed manifest; all four live Firebase aliases passed exact no-follow redirect checks.
- Remaining blocker: none for this release-test path.

## INC-20260831-001: Viewer discarded Agent ICE candidates received before the Answer

- Detected: 2026-08-31T09:05:06Z.
- Severity: P1.
- Affected: Viewer Firebase WebRTC signaling in `v0.1.75`; the shared x86 payload on 32-bit and 64-bit Windows, packaged and installed modes.
- Status: fixed-not-released.
- User-visible symptom: An online Agent accepts Firestore-backed system-tool commands, but the Viewer remote session remains blank.
- Minimal trigger: Deliver an Agent trickle-ICE candidate snapshot before the Viewer finishes applying the matching WebRTC Answer.
- Root cause and contributors: The Viewer subscribed to Agent candidates independently from the Answer, called `addIceCandidate` before `setRemoteDescription` could finish, and marked the candidate ID as applied before that call succeeded. A candidate rejected in this ordering was therefore never retried.
- Fix commit(s): `b6555b2`.
- Permanent guard: Queue matching Agent candidates until the Answer remote description resolves, mark IDs applied only after successful native application, retain rejected candidates, automatically retry each candidate once, allow later snapshots to retry again, and clear every pending candidate/timer during transport shutdown.
- Regression proof: Focused RED produced one new failure because `addIceCandidate` ran before the Answer and was not replayed. After the fix, `npx vitest run src/firebase/viewerWebRtcTransport.test.ts` exited `0` with 1 file and 8 tests passed, including candidate-before-Answer ordering, automatic retry, and duplicate suppression.
- Release proof: GitHub Actions replacement run `33454006453` published `v0.1.76` from `adca588`; both public installers downloaded successfully, the signed manifest verified both x86 payloads and x64 compatibility aliases, and all four Firebase download aliases resolved with HTTP `200`.
- Remaining blocker: Verify `AGENT-E0D50FD0` physically. If that site still times out, confirm and configure a production TURN relay because the current release contract permits STUN-only builds.

## INC-20260901-001: WebRTC regression mock failed the release TypeScript build

- Detected: 2026-09-01T00:13:25Z.
- Severity: P1.
- Affected: GitHub Actions release run `33453692045`, step `Build two x86 installers and signed compatibility manifest`; `v0.1.76` test source typing.
- Status: released-verified.
- User-visible symptom: The requested `v0.1.76` release stopped before installer artifacts were produced.
- Minimal trigger: Compile `src/firebase/viewerWebRtcTransport.test.ts` after assigning a `Promise<void>` implementation to a mock inferred as returning `Promise<undefined>`.
- Root cause and contributors: Focused Vitest transpilation passed without a full TypeScript check, while the FakePeerConnection mock inferred an unnecessarily narrow `Promise<undefined>` return type that rejected the test's valid `Promise<void>` implementation during the production TypeScript build.
- Fix commit(s): `adca588`.
- Permanent guard: Explicitly type WebRTC mock promises as `Promise<void>` and run the application TypeScript build before pushing a release preparation commit.
- Regression proof: After explicitly typing both WebRTC mock methods as `Promise<void>`, `npm run build` exited `0` through Vite, backend bundling, Rust PoC, and Agent packaging; `npx vitest run src/firebase/viewerWebRtcTransport.test.ts` exited `0` with 1 file and 8 tests passed; `npm run recurrence:verify` exited `0`.
- Release proof: GitHub Actions run `33453692045` failed at the build step with `Type 'Promise<void>' is not assignable to type 'Promise<undefined>'` and published no assets. Replacement run `33454006453` published `v0.1.76` from `adca588`; both installer hashes matched the signed manifest and the manifest verifier exited `0`.
- Remaining blocker: none for this release-build failure path.

## INC-20260902-001: Viewer startup restored the last remote session automatically

- Detected: 2026-09-02.
- Severity: P1.
- Affected: Firebase Viewer startup after an authenticated account previously had a pending or connected remote session.
- Status: source-verified-not-released.
- User-visible symptom: Launching the Viewer automatically reopened the last remote device without the user pressing Connect.
- Minimal trigger: Leave a serialized active session in `wonremote-viewer-active-session`, close the Viewer, and launch it while Firebase authentication is restored.
- Root cause and contributors: The startup authentication effect treated the persisted session as a reconnect contract, fetched its status, and called `setSession` for pending or connected state.
- Fix commit(s): `395ac4f`.
- Permanent guard: Consume persisted session metadata only for orphan-session cleanup, remove it before the cleanup request, restore it only when that request fails so a later startup can retry, and forbid startup code from assigning it to Viewer session state; preserve user-triggered Connect and in-session WebRTC reconnect paths.
- Regression proof: `npx vitest run src/domain/sessionPersistence.test.ts src/viewerStartupSession.test.ts` exited `0` with 2 files and 6 tests passed. The startup-policy guard requires persisted metadata consumption and orphan cleanup without `setSession` or `fetchSessionStatus`, while retaining `openSession(device.id)` only in the direct Connect handler.
- Release proof: not released.
- Remaining blocker: Package and release only when explicitly requested, then verify an installed Viewer opens the device list without entering the previous remote session.

## INC-20260902-002: Viewer waited for remote cleanup before leaving the session screen

- Detected: 2026-09-02.
- Severity: P1.
- Affected: Viewer remote-session exit while Firebase/API close or an in-flight connection attempt is slow.
- Status: source-verified-not-released.
- User-visible symptom: Pressing End Session left the remote screen visible until network cleanup completed.
- Minimal trigger: End a connected session while `closeSession` or a pending `openSession` request has measurable latency.
- Root cause and contributors: `handleCloseSession` awaited every pending connection and the remote close request before clearing Viewer session state; fullscreen exit was also awaited before invoking the parent close handler.
- Fix commit(s): `51ae9ca`.
- Permanent guard: Clear Viewer session state and disable remote input synchronously, invalidate late connection attempts, finish input-release ordering and remote cleanup in the background, and persist failed cleanup separately from the active-session record.
- Regression proof: `npx vitest run src/domain/sessionPersistence.test.ts src/viewerStartupSession.test.ts src/remoteSessionLayout.test.ts src/agent/agentSessionLifecycle.test.ts` exited `0` with 4 files and 33 tests passed; `npx tsc --noEmit` exited `0`. Guards require local `setSession(null)` before remote close, an input-release barrier before `closeSession`, durable late-open cleanup, and stale targeted `stop-stream` rejection.
- Release proof: not released.
- Remaining blocker: Package and release only when explicitly requested, then verify installed Viewer teardown latency and Agent stream/input release on two physical PCs.

## INC-20260902-003: Viewer allowed a new connection before prior session cleanup completed

- Detected: 2026-09-02.
- Severity: P1.
- Affected: Viewer session shutdown, immediate reconnect, and Agent stream ownership.
- Status: source-verified-not-released.
- User-visible symptom: Ending one remote session and immediately connecting again could overlap the old close request with the new session and leave stale Agent stream or input ownership.
- Minimal trigger: Delay `closeSession`, press End Session, and press Connect on a device before the delayed close resolves.
- Root cause and contributors: The Viewer set the shutdown gate to false immediately after clearing local UI state instead of retaining it through the input-release barrier and remote close promise.
- Fix commit(s): pending.
- Permanent guard: Clear the local remote view immediately, but retain the shutdown gate until input release and remote cleanup settle; invalidate late open attempts and persist failed cleanup for the next startup.
- Regression proof: The focused Viewer startup/session source test requires local tab removal before remote close and forbids releasing the gate before the close promise finalizer; TypeScript compilation passes.
- Release proof: not released.
- Remaining blocker: Package only when explicitly requested and physically verify immediate close followed by reconnect.

## INC-20260902-004: Agent permanently suppressed retry of a failed target version

- Detected: 2026-09-02.
- Severity: P1.
- Affected: Installed Agent automatic updates after a transient download, verification, or installer failure.
- Status: source-verified-not-released.
- User-visible symptom: After one update attempt failed, the Agent could keep reporting the same target version without ever trying that version again.
- Minimal trigger: Retain failed update telemetry for the current latest version and run the periodic update check again.
- Root cause and contributors: The retained-failure guard treated a matching target version as a permanent block and did not distinguish a short retry cooldown from permanent suppression.
- Fix commit(s): pending.
- Permanent guard: Enforce a bounded failure cooldown, schedule the short retry timer, and permit the same target version after the cooldown expires.
- Regression proof: Focused Agent update policy tests cover invalid timestamps, cooldown blocking, and retry after expiry; the Agent policy suite passes.
- Release proof: not released.
- Remaining blocker: Package only when explicitly requested and physically induce one failed Agent update before confirming automatic recovery.

## INC-20260902-005: Adding a file batch could hide transfers that were still queued

- Detected: 2026-09-02.
- Severity: P1.
- Affected: Viewer remote-session file transfer queue when another file batch is selected before the current batch finishes.
- Status: source-verified-not-released.
- User-visible symptom: Previously queued files could disappear from the transfer list even though their transfer loop was still pending.
- Minimal trigger: Queue multiple files, then select another batch while at least one original file is queued but not yet transferring.
- Root cause and contributors: The queue append state update retained only entries already marked `transferring`, so valid `queued` entries and terminal history were discarded before the new batch was appended.
- Fix commit(s): pending.
- Permanent guard: Preserve every non-terminal transfer across batch appends and apply the display limit only to terminal history; never truncate queued or transferring entries.
- Regression proof: The focused queue test covers a completed item, an active transfer, an existing queued item, and a new item at the display limit; the queue, cancellation, WebRTC, and session tests pass with TypeScript compilation.
- Release proof: not released.
- Remaining blocker: Package only when explicitly requested and physically enqueue a second file batch while the first batch is active.

## INC-20260902-006: Multi-session asynchronous work was not isolated per device

- Detected: 2026-09-02.
- Severity: P1.
- Affected: Viewer multi-session tab close, concurrent device connection, logout, and asynchronous clipboard paste.
- Status: source-verified-not-released.
- User-visible symptom: Closing one tab could cancel another device connection, a late clipboard read could target an inactive tab, and logout could race a tab cleanup request.
- Minimal trigger: Open or connect two device tabs, close one while the other connects, initiate Ctrl+V before switching tabs, or log out while tab cleanup is pending.
- Root cause and contributors: Connection invalidation and shutdown used one global attempt counter, each panel treated its own ID as the active ID, and background close promises were not tracked for logout.
- Fix commit(s): pending.
- Permanent guard: Use the global epoch only for logout, isolate close state by device, deduplicate only same-device connection attempts, verify the active tab before and after asynchronous clipboard reads, and await tracked close tasks before logout.
- Regression proof: Focused Viewer startup/session tests assert per-device connection deduplication, unrelated connection preservation, active-tab clipboard guards, and logout close-task waiting; TypeScript compilation passes.
- Release proof: not released.
- Remaining blocker: Package only when explicitly requested and physically exercise two simultaneous device tabs, tab switching during Ctrl+V, rapid close/reconnect, and logout during cleanup.

## INC-20260902-007: Cancelled file attempts could affect a retry or publish Storage metadata

- Detected: 2026-09-02.
- Severity: P1.
- Affected: Viewer file retry state and Firebase Storage transfer metadata.
- Status: source-verified-not-released.
- User-visible symptom: A quick retry could be overwritten by the previous attempt's late cancellation, or a file cancelled at upload completion could still be announced to the Agent.
- Minimal trigger: Cancel a transfer and immediately press Retry, or cancel after Storage bytes finish but before the Firestore file document is created.
- Root cause and contributors: Retries reused the original transfer ID, and the Storage path checked cancellation only before upload rather than again at the upload-to-metadata boundary.
- Fix commit(s): pending.
- Permanent guard: Allocate a fresh transfer ID for every retry, isolate cancellation controllers per attempt, recheck the abort signal after Storage completion, delete the uploaded object on late cancellation, and never create its metadata document.
- Regression proof: Focused Viewer source tests require a fresh retry ID; Firebase Storage tests verify both in-flight cancellation and completion-boundary cleanup without metadata creation.
- Release proof: not released.
- Remaining blocker: Package only when explicitly requested and physically cancel/retry a large file near upload completion.

## INC-20260902-008: Direct and secure session paths bypassed protocol compatibility checks

- Detected: 2026-09-02.
- Severity: P1.
- Affected: Firebase direct session creation and secure-code session completion in both Viewer fallback and Cloud Functions paths.
- Status: source-verified-not-released.
- User-visible symptom: A future incompatible Agent protocol could receive a start-stream command through a fallback or secure connection path even though normal connection was blocked.
- Minimal trigger: Advertise a protocol version newer than the Viewer, then use Firestore direct mode or complete an already-issued secure challenge.
- Root cause and contributors: Compatibility validation was initially added to the visible normal-connect handler and callable normal session function but not repeated at every authoritative session-creation boundary.
- Fix commit(s): pending.
- Permanent guard: Validate online state and protocol immediately before every direct or callable session creation, including secure challenge completion; treat missing protocol as legacy v1 and reject versions outside the supported range.
- Regression proof: Direct-session tests reject future protocol before committing a session batch, the security-policy test requires secure callable revalidation, and focused protocol, Viewer, Functions, and TypeScript checks pass.
- Release proof: not released.
- Remaining blocker: Package only when explicitly requested and physically verify one mixed-version compatible connection plus one deliberately incompatible fixture.

## INC-20260902-009: Release CI required an unprovisioned Authenticode certificate

- Detected: 2026-09-02.
- Severity: P1.
- Affected: GitHub Actions release packaging after both x86 installers were built.
- Status: source-verified-retry-pending.
- User-visible symptom: The `v0.1.77` release workflow stopped before manifest creation and published no update assets.
- Minimal trigger: Run a release preparation commit without the Authenticode PFX secrets while `WONREMOTE_REQUIRE_AUTHENTICODE` is hard-coded to `YES`.
- Root cause and contributors: The workflow made optional code signing mandatory before a trusted code-signing certificate had been provisioned in repository secrets.
- Fix commit(s): pending.
- Permanent guard: Keep signing in the build-before-manifest sequence, but require it only through the repository variable after its matching PFX secrets are provisioned; a packaging test forbids hard-coding the requirement.
- Regression proof: Pending focused desktop packaging test and replacement CI run.
- Release proof: Initial GitHub Actions run `33607882492` failed at `Apply and verify Authenticode signatures` and skipped publication; replacement run pending.
- Remaining blocker: Retry the release workflow and verify exactly two installers plus the signed update manifest.
