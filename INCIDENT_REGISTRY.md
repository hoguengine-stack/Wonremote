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
- Status: fixed-not-released.
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
