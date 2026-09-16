# WonRemote Incident Registry

## INC-20260917-101: Broker probe filename triggered Windows installer detection

- Detected: 2026-09-17 during the local pre-release Job-boundary proof.
- Severity: Low; no release was published and the installed Agent remained running.
- Affected: The first non-UI updater probe executable name.
- Status: Source repaired and locally verified.
- User-visible symptom: Starting the test probe fails with `The requested operation requires elevation` instead of exercising the Job boundary.
- Minimal trigger: Compile a manifest-free probe whose executable filename contains `update`, then start it from a non-elevated test launcher.
- Root cause and contributors: Windows installer detection heuristics treated `update-handoff-job-probe.exe` as an installer and requested elevation. Direct `rustc` compilation reproduced the same behavior, disproving the initial Tauri-manifest hypothesis.
- Fix commit(s): Pending v0.1.99 preparation follow-up commit.
- Permanent guard: Move process creation into a dependency-free shared Rust module used by production and a non-shipped probe, compile it directly with `rustc`, and give the output a neutral filename that the packaging test rejects if installer-detection keywords return.
- Regression proof: The neutral-name x86 probe compiled directly with `rustc`, started without elevation while the installed Agent remained active, called the shared production process function and survived probe/Job-owner exit. The packaging test rejects installer-detection keywords in the probe filename.
- Release proof: Not applicable until the fresh normal v0.1.99 workflow passes.
- Remaining blocker: Pass the same direct probe in the fresh normal release workflow.

## INC-20260917-100: Job-boundary release proof depended on interactive Tauri startup

- Detected: 2026-09-17 in GitHub Actions run 35125329394 after the x86 v0.1.99 installers built.
- Severity: Medium; publication was safely blocked, but the process-boundary proof could not reach the broker on the headless release runner.
- Affected: `tests/e2e/test_update_handoff_broker.ts` fixture entrypoint.
- Status: Source repaired and locally verified; no v0.1.99 asset was published by the failed run.
- User-visible symptom: The release test records only the Tauri Agent startup line and times out before the handoff proof, despite the same test passing on an interactive local desktop.
- Minimal trigger: Start the complete shipped Tauri Agent host in a GitHub Windows runner Job and wait for its WebView-driven setup to spawn the fixture Agent child.
- Root cause and contributors: The test used the full GUI application as an indirect route to one process-creation function. A headless CI runner can stall before Tauri setup reaches that function, so desktop availability became an unrelated prerequisite for the critical updater boundary.
- Fix commit(s): Pending v0.1.99 preparation follow-up commit.
- Permanent guard: Keep process creation in one dependency-free Rust module shared by production and a non-shipped direct-rustc probe. Run the probe inside the kill-on-close Job and require its PowerShell child to survive after the probe and Job owner exit without initializing Tauri or WebView.
- Regression proof: The shared-function x86 probe passed the real Job boundary while the full installed Agent remained running; 47 product Rust tests, 83 focused packaging/recurrence tests and TypeScript passed.
- Release proof: Pending; do not publish or bypass the failed run.
- Remaining blocker: Pass the shared-function probe in a fresh normal release workflow.

## INC-20260917-099: Updater Job regression test depended on stale local release resources

- Detected: 2026-09-17 in GitHub Actions run 35123739450 after both v0.1.99 installers built.
- Severity: Medium; publication was safely blocked, but the release spent a full build before the required runtime fixture failed to start.
- Affected: `tests/e2e/test_update_handoff_broker.ts` x86 fixture resource selection.
- Status: Resolved by removing runtime-resource fixtures from the Job proof; no v0.1.99 asset was published by the failed run.
- User-visible symptom: Release stops at `Required broker E2E artifact is missing: release-exe\\x86\\runtime\\node.exe`.
- Minimal trigger: Run `npm run release:exes` in a clean checkout, which intentionally leaves only the two stable installers in `release-exe`, then execute the x86 broker E2E.
- Root cause and contributors: The E2E copied Node and PoC from a historical expanded `release-exe/x86` layout that existed only as stale local output. The current packager resets that directory and writes exactly two installers. The locally executed test therefore passed against an artifact the clean release workflow never creates.
- Fix commit(s): Pending v0.1.99 preparation follow-up commit.
- Permanent guard: The Job proof now compiles the exact production process module into a standalone probe and has no Node, PoC, expanded installer or stale release-directory dependency.
- Regression proof: The shared-function probe passed with only its generated executable and handoff script; the packaging contract asserts that no full Agent executable is used by this proof.
- Release proof: Pending; do not publish or bypass the failed run.
- Remaining blocker: Pass the x86 Job-boundary test and complete publication in a fresh normal release workflow.

## INC-20260917-098: Release gate rejected the executable E2E contract path

- Detected: 2026-09-17 in GitHub Actions run 35123341054 before v0.1.99 build started.
- Severity: Medium; the release is safely blocked, but a verified repair cannot enter the build job until the gate recognizes its real contract test.
- Affected: `verify-recurrence-coverage.js` functional-change `Contract` path classification for `tests/e2e/test_*.ts` programs.
- Status: Source repaired; no v0.1.99 asset was built or published by the failed run.
- User-visible symptom: Deployment stops at change-guard with `functional change Contract must name a test file` even though the named changed file executes the Windows Job boundary.
- Minimal trigger: Commit a functional change whose `Contract` trailer names `aether-link-app/tests/e2e/test_update_handoff_broker.ts`.
- Root cause and contributors: The gate recognized Vitest/Jest/spec, Java `Test` and Rust `_test` names, but omitted the repository's executable TypeScript E2E `test_*.ts` convention. The local worktree check used the top-level contract's additional changed Vitest file, so it did not expose the commit-trailer mismatch before push.
- Fix commit(s): Pending v0.1.99 preparation follow-up commit.
- Permanent guard: Recognize only `tests/e2e/test_*.ts`-style executable paths in addition to existing test conventions, and add a gate self-test using the exact failed path and changed-file set.
- Regression proof: The exact `aether-link-app/tests/e2e/test_update_handoff_broker.ts` trailer path is accepted only when that same executable E2E file is in the commit. The focused recurrence gate passed 16 tests; predeploy rerun remains before commit.
- Release proof: Pending a fresh normal v0.1.99 workflow; do not rerun or bypass the failed workflow.
- Remaining blocker: Commit the gate correction with its changed self-test, pass predeploy locally and let a new main push run the complete release workflow.

## INC-20260917-097: Update handoff died with the scheduled-task Job after installer launch

- Detected: 2026-09-17 during the selected `AGENT-82220F6D` public v0.1.97-to-v0.1.98 update.
- Severity: Critical; the installer can replace files successfully while the updater loses result recording, restart, rollback ownership and legacy cleanup, leaving the Agent offline until manually started.
- Affected: Tauri `launch_brokered_update_handoff`, installed Agent and Viewer updater handoff launched from a Windows scheduled-task Job.
- Status: Source repaired for v0.1.99; public v0.1.98 files installed on the test PC but that handoff did not complete.
- User-visible symptom: Update reaches 100% and appears to stop. The new executable is present, but the Agent does not reopen, the legacy install remains, and no healthy/rollback result is written.
- Minimal trigger: Launch the installed Agent through its scheduled task, request an installer update, let the old Agent exit after the `.accepted` marker, then inspect the handoff log and running processes.
- Root cause and contributors: The TypeScript handoff descriptor declared `CREATE_BREAKAWAY_FROM_JOB`, but the actual Tauri broker ignored those flags and launched PowerShell with only `CREATE_NO_WINDOW`. When the scheduled-task process tree ended, Windows terminated the handoff immediately after it launched the installer. The existing broker E2E launched the shell outside an enclosing kill-on-close Job, so it could pass while the deployed path still failed.
- Fix commit(s): Pending v0.1.99 preparation commit.
- Permanent guard: Launch the verified broker PowerShell with both `CREATE_NO_WINDOW` and `CREATE_BREAKAWAY_FROM_JOB`. Run the real x86/x64 Tauri broker under an enclosing Windows Job configured for kill-on-close and breakaway, then require the handoff proof to be written after the parent shell and Job owner exit.
- Regression proof: RED: the v0.1.98 x86 host timed out in the enclosing kill-on-close Job. GREEN: the same compiled x86 host with explicit breakaway survives shell/Job-owner exit and writes proof; 47 x86 Rust tests, 98 focused updater/packaging tests and TypeScript pass. The release workflow now reruns this boundary after building both shipped x86 installers.
- Release proof: Pending v0.1.99 build, publication and selected-device installed update.
- Remaining blocker: Prove one selected public update completes its handoff log, healthy result, restart and allowlisted legacy cleanup without manually starting the Agent.

## INC-20260916-096: Agent migration returned success while the legacy installation remained

- Detected: 2026-09-16 from the installed v0.1.97 Program Files and v0.1.88 LocalAppData Agent state.
- Severity: High; two installed runtimes and a stale uninstall entry can survive a reported successful update.
- Affected: `manage-agent-login-task.ps1` update-handoff migration bridge and monitor.
- Status: Source repaired and v0.1.98 package verified; installed migration pending.
- User-visible symptom: `%LOCALAPPDATA%\WonRemote\Agent` and its v0.1.88 uninstall entry remain after v0.1.97 is installed under Program Files.
- Minimal trigger: Upgrade a LocalAppData Agent to the protected Program Files installer when the handoff lock or replacement-health evidence is missing or late.
- Root cause and contributors: The migration bridge removes its temporary runtime only when fresh health evidence is present, but returns success without an error when lock release or health proof fails. The monitor then stops tasks without surfacing cleanup failure to installation results.
- Fix commit(s): Current v0.1.98 preparation commit.
- Permanent guard: Require an explicit successful lock release and fresh healthy replacement result before final deletion; otherwise return nonzero and retain evidence. Delete only the two allowlisted legacy roots and a matching uninstall registration.
- Regression proof: The Windows migration probes now require nonzero exit and named-task shutdown when fresh health proof is absent, while the healthy path completes without shutdown. The release-boundary set passed 129 tests, including the updated migration monitor and host-only legacy detection.
- Release proof: Fresh local v0.1.98 Agent and Viewer installers passed payload verification; public publication and installed migration have not yet run.
- Remaining blocker: Confirm that the signed v0.1.98 update removes only `%LOCALAPPDATA%\WonRemote\Agent` and its matching uninstall registration after the protected Agent reports healthy.

## INC-20260916-095: Startup privilege handoff discarded an already-visible Agent update action

- Detected: 2026-09-16 from the v0.1.95-to-v0.1.97 Tauri runtime log.
- Severity: High; a user can confirm an update in a window that is immediately terminated by the required scheduled-task handoff.
- Affected: installed Agent startup ordering around `manage-agent-login-task.ps1 -Mode Ensure`.
- Status: Source repaired and v0.1.98 package verified; installed update transition pending.
- User-visible symptom: repeated Update clicks appear to do nothing until the Agent/PoC is stopped, restarted and the update is requested again.
- Minimal trigger: Launch a non-elevated installed Agent that needs scheduled-task handoff, then press Update before `manage-agent-login-task.ps1 -Mode Ensure` returns exit code 10.
- Root cause and contributors: The Agent spawned its runtime and showed the interactive window before the asynchronous Ensure helper returned exit code 10. The shell then exited and launched the approved scheduled Agent, losing modal and button state from the first process.
- Fix commit(s): Current v0.1.98 preparation commit.
- Permanent guard: Defer an ordinary installed Agent window until Ensure completes. On handoff, write the existing show-window request before exiting; on success/failure, show the surviving process without requiring another click.
- Regression proof: x86 Rust tests prove installed release Agents defer runtime until the helper settles while debug, Viewer and helper-missing paths do not. The release-boundary set passed 129 tests and x86 Rust passed 46 tests.
- Release proof: Fresh local v0.1.98 installers passed payload and Agent product-identity checks; public publication and installed handoff have not yet run.
- Remaining blocker: Confirm the existing approved v0.1.97 Agent reaches v0.1.98 through one update action and restarts exactly once.

## INC-20260916-094: Shipped x86 Agent tray omitted Exit and explicit shutdown ownership

- Detected: 2026-09-16 by source inspection and the installed v0.1.97 tray behavior.
- Severity: High; operators cannot deliberately terminate the shipped Agent, and the independent SYSTEM capture broker remains after the shell closes.
- Affected: x86 Win32 fallback tray and explicit Agent shutdown.
- Status: Source repaired and v0.1.98 package verified; installed tray/process proof pending.
- User-visible symptom: right-clicking the tray icon opens no menu, window close only hides the shell, and `wonremote-poc.exe` remains running.
- Minimal trigger: Right-click the x86 Agent fallback tray icon or close its window, then inspect the elevated shell, Node child and `WonRemote Secure Capture` task.
- Root cause and contributors: Tauri tray menus are disabled for x86. The custom Win32 fallback maps both mouse buttons to Open and implements no context menu or Exit action. The secure broker is a separately scheduled SYSTEM process outside the shell job object.
- Fix commit(s): Current v0.1.98 preparation commit.
- Permanent guard: Add a native right-click menu with Open and Exit. Route Exit to the Tauri owner, stop the named secure-broker task, then terminate the existing child job and shell. Keep normal window close as hide-to-tray.
- Regression proof: x86 Rust tests cover left-click Open, right-click Menu and the explicit Exit command. Packaging coverage requires the native menu, exit request, secure-task stop and Agent title. The release-boundary set passed 129 tests and x86 Rust passed 46 tests.
- Release proof: Fresh local v0.1.98 Agent installer passed payload verification; installed right-click and process-tree proof has not yet run.
- Remaining blocker: On the installed v0.1.98 Agent, verify window close still hides, tray Exit removes shell/Node/broker, and scheduled start restores normal operation.

## INC-20260916-093: Agent installer reused a Viewer-compiled desktop host

- Detected: 2026-09-16 from packaging source, installed file metadata and WebView2 command line.
- Severity: Critical; Agent identity, window title and WebView profile are wrong, allowing Viewer/Agent state and process ownership to collide.
- Affected: `package-release-exes.js` Agent installer build.
- Status: Source repaired and v0.1.98 package identity verified; installed profile proof pending.
- User-visible symptom: the Agent window title and executable ProductName say `WonRemote Viewer`; its WebView uses `com.wonremote.viewer\EBWebView`.
- Minimal trigger: Build the Viewer host, then package the Agent with `tauri bundle` only and inspect the Agent executable ProductName or WebView command line.
- Root cause and contributors: Release packaging built the Viewer Rust host, then invoked only `tauri bundle` with Agent configuration. Bundling did not recompile product identity, so the Agent installer contained the previous Viewer binary. A test explicitly required this invalid reuse.
- Fix commit(s): Current v0.1.98 preparation commit.
- Permanent guard: Perform a fresh Agent `tauri build` with the Agent x86 configuration after preserving the Viewer installer, and make the release test reject bundle-only Agent packaging. Inspect the built Agent executable identity before publication.
- Regression proof: RED packaging coverage required the invalid bundle-only command. GREEN now requires a separate full Agent build, invalidates the Viewer reuse stamp, and rejects a mismatched compiled ProductName. The release-boundary set passed 129 tests. The fresh x86 host reports ProductName `WonRemote Agent`, ProductVersion `0.1.98`.
- Release proof: Local v0.1.98 installers are 20,325,401-byte Viewer SHA-256 `98bab32f9846bc7a148005b8a0b29fa59de2f81506e27aaecd0e3d5c3855aa0c` and 20,335,381-byte Agent SHA-256 `174f60b70739ab1cc51d2dfffe385a3a2f3689ff16a7684cfe72e7fb00b0612f`; both payload checks passed. Public publication has not yet run.
- Remaining blocker: After signed update, verify the installed Agent reports Agent title/ProductName and uses `com.wonremote.agent\EBWebView` while the Viewer remains on its own profile.

## INC-20260916-092: Viewer process cleanup followed a reused parent PID into an unrelated process

- Detected: 2026-09-16 during the local v0.1.97 packaged-installer cleanup proof.
- Severity: High; update cleanup could terminate an unrelated process whose recorded parent PID had been reused by a newer Viewer/WebView process.
- Affected: `stop-wonremote-processes.ps1` descendant traversal for Viewer and Agent installation/uninstallation.
- Status: Published in v0.1.97 and live verified.
- User-visible symptom: The cleanup correctly stopped Viewer and its product WebView2 tree but also stopped Visual Studio `VCTIP.exe`, which was outside every WonRemote path and profile.
- Minimal trigger: A long-lived unrelated process retains a parent PID equal to a newer targeted process ID; ID-only traversal treats it as a current child.
- Root cause and contributors: Descendant ownership used only `ParentProcessId` and did not compare process creation times, so Windows PID reuse could create a false parent-child relationship.
- Fix commit(s): 9309968.
- Permanent guard: Follow a target parent only when the child creation time is not earlier than the current parent creation time. Keep direct install-root and product-`EBWebView` ownership checks, and test an older unrelated process with a reused parent PID.
- Regression proof: RED local cleanup output included `VCTIP.exe`, and the focused PowerShell simulation reproduced `STOPPED_PID=205` for an older unrelated process whose recorded parent PID had been reused. GREEN compares child and parent creation times: it still stops the genuine newer Viewer WebView child and excludes the older unrelated process.
- Release proof: Local rebuilt v0.1.97 Viewer installer exited 0 after stopping the active Viewer and six product WebViews; zero product processes remained and unrelated Visual Studio `VCTIP.exe` retained PID 7904. GitHub Actions run 35082450043 then published v0.1.97 from 9309968, and independent public asset/hash/manifest-signature/latest-alias checks passed.
- Remaining blocker: None for this process-isolation defect; field update confirmation remains operational monitoring.

## INC-20260916-091: Installed Viewer device editor ignores ordinary left-click input

- Detected: 2026-09-16 from the user's installed v0.1.96 screenshots and direct report immediately after publication.
- Severity: High; operators cannot edit registered-device metadata through the normal pointer and keyboard path.
- Affected: Windows installed Viewer device-edit modal, ordinary left-click focus, text entry and the device-type select picker.
- Status: Published in v0.1.97 and live verified.
- User-visible symptom: Text fields do not accept editing. Left-clicking `장비 종류` does not open its list, while right-clicking shows the list together with the WebView context menu.
- Minimal trigger: Open `등록 장비 수정`, left-click an editable field or `장비 종류`, then type or attempt to choose an option.
- Root cause and contributors: The Viewer installer stopped only processes whose executable lived under the Viewer install root. An orphaned `msedgewebview2.exe` tree using `com.wonremote.viewer\EBWebView` survived host replacement and was reused after updates; on this PC its browser root still reported `webview-exe-version=0.1.88` while the installed host was v0.1.97. The prior regression also used programmatic fill instead of the installed ordinary-pointer boundary, and the modal relied on default focus/picker behavior without making the background inert.
- Fix commit(s): 9309968.
- Permanent guard: Exercise real coordinates for left-pointer focus/type/select, contain focus in the modal, keep the background inert, and make the installer stop only WebView2 processes whose command line owns the product-specific `EBWebView` directory. A passing programmatic fill or host-only process stop is not accepted as proof.
- Regression proof: RED evidence includes the supplied installed screenshots, the local v0.1.96 pointer failure and a live orphan browser root reporting v0.1.88. GREEN source includes the real-coordinate Viewer regression and process-isolation coverage for product ownership and reused-PID creation times. In the rebuilt installed v0.1.97 Viewer, one ordinary left click opened all four device-type options with no context menu; a physical click and OS keyboard entered `VERIFY197`, Save persisted it, reopening retained it, and a second Save/reopen restored and confirmed the original blank value. The five affected suites passed 140 tests and TypeScript passed.
- Release proof: GitHub Actions run 35082450043 published public latest v0.1.97 from commit 9309968. Viewer, Agent and signed manifest public hashes match; all canonical assets return HTTP 200, latest/Firebase aliases point to v0.1.97, 0.1.96 detects the update, 0.1.97 does not, and the installed v0.1.97 Viewer reports 최신 버전입니다. Authenticode remains unconfigured and is not claimed.
- Remaining blocker: None for this device-editor defect; existing v0.1.96 clients must install the offered v0.1.97 update.

## INC-20260916-090: Late remote connection steals focus from device editor

- Detected: 2026-09-16 during focused reproduction of the installed v0.1.95 right-click editor report.
- Severity: High; local metadata could not be typed reliably and unintended remote keyboard ownership remained possible behind the editor.
- Affected: Windows Viewer device editor when a requested session or WebRTC transport becomes ready after the editor opens; save-error visibility in the same dialog.
- Status: Source repaired, automated runtime verified and published in v0.1.96; installed confirmation pending.
- User-visible symptom: Right-clicking a registered device opens the editor, but text input itself can stop working; save failure was also hidden behind the dialog.
- Minimal trigger: Request a connection, right-click a device before the request completes, focus a metadata input, then allow session and transport readiness to complete.
- Root cause and contributors: Session activation and transport-ready effects focused the remote panel and hidden IME without checking the open editor. Keyboard recovery remained enabled behind the dialog. The metadata handler also swallowed save rejection and closed before rollout persistence finished.
- Fix commit(s): 3733b90, e495359 and c52009a.
- Permanent guard: Explicitly suspend remote input, keyboard recovery and automatic panel focus while the device editor is open; resume after close. Propagate save failure into the dialog, preserve input and close only after both save stages succeed.
- Regression proof: Real App Chromium RED lost editor focus after delayed readiness. GREEN retains typing/deletion with zero remote sends, restores remote ArrowRight after close, preserves text on save failure and retries successfully. Related six files passed 150 tests, TypeScript passed and x86 handoff exit test passed.
- Release proof: GitHub Actions run 35074655547 built both x86 installers, generated the signed update manifest and published public latest v0.1.96. Public asset hashes match the manifest and all three latest URLs resolve to v0.1.96. Authenticode remains unconfigured and is not claimed.
- Remaining blocker: INC-20260916-091 is published and live verified in v0.1.97. Agent update/restart and cross-PC remote input remain separate checks.

## INC-20260916-089: Device editor hides save failures and closes before all saves finish

- Cause: Parent metadata handler swallowed errors into a notice behind the dialog and closed the dialog before rollout persistence completed. The dialog continued rollout writes after metadata failure and did not catch rollout rejection.
- Guard: Propagate metadata failure to the dialog, preserve entered values, display an inline alert, and close only after both existing save stages succeed. No automatic retry added.
- Proof: Two actual-App Chromium tests failed before the change (missing in-dialog error) and passed afterwards. They verify typing, preserved text, no rollout call after metadata failure, rollout failure, explicit retry, and updated list display. TypeScript passed.
- Boundary: Persistence is mocked; this does not prove live Firestore authorization or installed 0.1.95 keyboard behavior. User clarification of input-versus-save symptom remains pending. No build or deployment.

## INC-20260916-088: Failed installer launch unnecessarily stops the existing runtime during rollback

- Detected: 2026-09-16 while tracing field update handoff and release-gate failure behavior.
- Severity: Critical; an unaccepted update handoff could stop or replace the existing Agent before a replacement was proven available.
- Affected: Windows installed Agent installer handoff, portable update handoff, Tauri watchdog restart suppression and missing-rollout-policy eligibility.
- Status: Source repaired, focused runtime and Windows E2E verified, and published in v0.1.96. Installed update confirmation remains pending.
- User-visible symptom: A failed or unaccepted update could leave the Agent unavailable, causing offline status and loss of remote screen/input.
- Minimal trigger: Prepare an update with a backup, fail before installer process start, or let the broker spawn PowerShell without the installer producing the readiness acknowledgement.
- Root cause and contributors: The broker acknowledged after spawning PowerShell instead of after installer acceptance; the watchdog suppressed restart from request state alone; pre-launch catch invoked restore and stopped the still-working runtime. Missing rollout policy also previously allowed update progression.
- Fix commit(s): 3733b90, e495359 and c52009a.
- Permanent guard: Installer/portable scripts write readiness only after replacement ownership is established; Agent waits for that marker and exits with dedicated code 42; watchdog suppresses restart only for that code; pre-launch failure preserves runtime and fail-closed policy rejects missing rollout configuration.
- Regression proof: Six focused files passed 150 tests, TypeScript passed, and x86 release-profile exit-code test passed. Corrected Windows E2E proves successful upgrade, two post-launch rollback paths, and backup-unavailable refusal with no installer-start log or accepted marker.
- Release proof: First v0.1.96 CI run 35073780671 stopped before build/publication because the E2E still expected the obsolete message; second run 35074287567 exposed a bounded CI timeout. Both recurrence gaps were corrected. Run 35074655547 then passed the release contract, four Windows installer-update E2E scenarios, fresh x86 builds, updater acknowledgement checks, signed-manifest publication and live latest-alias verification. Public v0.1.96 hashes match its manifest. Authenticode remains unconfigured and is not claimed.
- Remaining blocker: Verify installed update/restart, settings retention and remote input on designated test devices.

## 2026-09-16 correction to INC-20260916-087

- Stale Firestore presence and unanswered requests establish lack of response, not a terminated target process. Neither target's process state was inspected. Matching protocol numbers do not exclude Viewer discovery/session regressions across versions.
- The user requested an original v0.1.88 Viewer comparison build with optional updates. Keep both target process state and version-specific connectivity unconfirmed until that comparison or target inspection supplies evidence.
- Prior timestamps labelled KST were UTC: 8E97376F last seen 2026-09-09 09:42 KST; A8BCF987 2026-09-15 10:12 KST. ZOOK log proximity alone does not identify either target.
- The source handoff flaw remains a confirmed code defect, while its causal role in each field outage remains subject to target logs.

## INC-20260916-087: Unattended update handoff stopped field Agent before installer acceptance

- Detected: 2026-09-16 from the user's report that deployed devices `AGENT-8E97376F` and `AGENT-A8BCF987` were offline, inaccessible and not updating.
- Severity: P0 field remote-management outage.
- Affected: Legacy per-user Windows Agents offered a newer per-machine installer that requires Windows elevation; confirmed interrupted handoff on `AGENT-A8BCF987`. `AGENT-8E97376F` is also unreachable but has a separate, still-unconfirmed cause.
- Status: Fleet rollout contained and permanent source repair verified; field recovery pending.
- Direct evidence: Both devices advertise remote protocol version 2, so Viewer/Agent version skew is not the connection blocker. Both last reported High integrity. `AGENT-A8BCF987` last reported version 0.1.90 at 2026-09-15 01:12 KST with update state `restarting`, target 0.1.94 and progress 100, then stopped answering commands. `AGENT-8E97376F` last reported healthy version 0.1.88 at 2026-09-09 00:42 KST and has no matching update-handoff evidence. A UAC wait is therefore not claimed as A8BCF987's exact post-launch failure.
- Root cause and contributors: When rollout configuration was absent, the Agent treated the update as eligible for every device. The legacy handoff stopped the running Agent before launching the installer, while the Tauri broker's readiness file proved only that PowerShell had spawned, not that the installer or replacement Agent had started. Any handoff-script, installer or migration failure after that premature acknowledgement could remove the only cloud control path. The unavailable target-local handoff log prevents assigning A8BCF987's exact later failing instruction.
- Immediate containment: Created and read back production `configuration/updateRollout` with target 0.1.95, paused true and percentage 0. Existing compatible Agents will defer further automatic installation attempts.
- Permanent guard: Fail closed when rollout configuration is absent or mismatched. The handoff script, rather than the broker, acknowledges readiness only after the installer process starts; the Agent then exits with dedicated code 42, and the Tauri watchdog suppresses restart only for that requested code. The installer owns process shutdown and allows the acknowledgement to be observed first. Seven related suites passed 114 tests, including an executable generated-script order probe; the focused Tauri Rust test and TypeScript passed.
- Recovery boundary: A stopped Agent cannot receive a Firebase command, and neither affected business has another registered Agent available as a wake relay. Recover `A8BCF987` by rebooting/logging on or starting its existing Agent through an authorized alternate path; then verify a fresh heartbeat and real session before any migration. Investigate `8E97376F` independently instead of attributing it to this handoff without evidence. Keep rollout paused because deployed 0.1.88/0.1.90 do not yet contain the repaired handoff.

## INC-20260915-086: Refresh regression initially used an unavailable assertion matcher

- Detected: 2026-09-15 during the focused Viewer refresh regression run.
- Severity: P3 test-authoring failure; no product impact.
- Affected: New Chromium refresh regression only.
- Status: Repaired and verified in the same change.
- Root cause and contributors: The test imported Vitest assertions but initially used Playwright Test's `toBeEnabled` matcher, which is not installed in this harness.
- Permanent guard: Use the repository's established `expect.poll(() => locator.isEnabled())` form and include TypeScript in focused verification.
- Regression proof: The corrected focused browser test passed, TypeScript passed, and the complete Viewer browser file passed 46 tests.
- Remaining physical verification: None for the test harness; installed product confirmation remains under INC-20260915-085.

## INC-20260915-085: Device refresh temporarily displayed every device as online

- Detected: 2026-09-15 from the user's Viewer device-list report.
- Severity: P1 operational status accuracy.
- Affected: Shared PC and Android Viewer device-list refresh rendering for manual-presence Agents.
- Status: Source repaired and focused browser regression verified; installed Viewer confirmation pending.
- User-visible symptom: Pressing device-list refresh changes every row to online before the actual presence refresh finishes.
- Minimal trigger: Begin a manual presence refresh while the visible list contains both online and offline devices and the server snapshot still stores online for manual-presence records.
- Root cause and contributors: The Viewer publishes the fetched Firestore snapshot as progress before matching heartbeat replies arrive. Manual-presence records intentionally bypass timestamp aging, so their persisted online field is not a fresh presence confirmation.
- Permanent guard: In the real Viewer browser path, hold a refresh after publishing an all-online intermediate snapshot and assert that the pre-click mixed statuses remain visible until the confirmed final result is applied.
- Regression proof: Chromium reproduced 1 online/9 offline changing incorrectly to 10 online during a held refresh. After repair, the same mixed statuses remain visible until completion. The complete Viewer browser file passed 46 tests, the presence-domain suite passed 6 tests, and TypeScript passed.
- Remaining physical verification: Refresh a mixed online/offline installed Viewer list and observe the full five-second confirmation window.

## INC-20260915-084: Viewer command header overlapped update status and search controls

- Detected: 2026-09-15 from the user's cropped PC Viewer screenshot.
- Severity: P2 dashboard readability and operation feedback.
- Affected: PC Viewer device dashboard at constrained workspace widths and after an Agent update request.
- Status: Source repaired and focused browser regression verified; installed Viewer confirmation pending.
- User-visible symptom: The selected store heading, online badge, search field and long update-result text occupy the same pixels; the notice also runs into the following dashboard content.
- Minimal trigger: Constrain the Viewer workspace, then request an Agent update so the long result text is rendered inside the title block.
- Root cause and contributors: The PC Viewer keeps a fixed device-group sidebar, leaving a constrained command workspace. The long operation result was also nested inside the title/tool header instead of owning a separate layout row, while the full management tool set could consume the remaining width.
- Permanent guard: Render the real Viewer dashboard at constrained and desktop widths, trigger the production update-result path, and assert nonintersection plus readable wrapping for the heading, tools, notice and following content.
- Regression proof: The production Viewer path first failed the structural browser guard. After repair, Chromium passed at 1024px, 1366px and 1920px with a long Korean store name, the full account-management tool set and a long Agent-update result. Geometry checks prove no heading/tool/notice/dashboard intersection and no notice overflow. The complete Viewer browser file passed 45 tests and TypeScript passed.
- Remaining physical verification: Resize the installed Viewer and repeat the update request against an actual device after the next build.

## INC-20260915-082: Viewer retained remote input ownership after transport loss

- Detected: 2026-09-15 during the local0.1.95 Agent replacement while a PC Viewer session was open.
- Severity: P1 local-control interruption and release blocker.
- Affected: Windows Viewer input ownership when an active Firebase remote transport disconnects while the database session still says connected.
- Status: Source repaired, full automated regression and final local x86 build passed; public and cross-PC verification remain.
- User-visible symptom: Local keyboard and pointer control appeared unavailable until the Viewer was closed after the Agent restart and Windows approval prompt.
- Minimal trigger: Keep a Viewer remote tab active, hold a remote key or pointer, then terminate the WebRTC transport without first changing the persisted session state.
- Root cause and contributors: Keyboard recovery, hidden IME focus and canvas interception used selected-session state, while the disconnect UI used live transport state. The two readiness conditions diverged during Agent restart.
- Fix commit(s): Current v0.1.95 release commit.
- Permanent guard: One shared remote-input-availability predicate requires active, visible and connected ownership plus an open Firebase transport and no manual-reconnect state. Actual Chromium covers disconnect while Ctrl and pointer capture are held.
- Regression proof: Predicate/static suites passed 27 tests; the real Viewer Chromium file passed 42 tests including transport-error input release; repository suite passed 1,036 tests; desktop keyboard and clipboard executable checks passed.
- Release proof: Fresh local x86 Viewer and Agent installers passed payload verification. Signed CI publication and public download verification are not yet claimed.
- Remaining blocker: Complete the normal signed v0.1.95 workflow, verify public assets, then confirm remote control and protected UAC/PIN behavior from the other PC.
- Repair: On lost transport, release tracked keys and buttons, pointer capture and queued pointer moves, blur and lock the hidden IME, and stop canceling local key, pointer and wheel events. Re-enable input only for a live replacement transport; explicit reconnect UI is retained.

## INC-20260915-083: Rollback command bypassed Firestore write wrappers

- Detected: 2026-09-15 in the full pre-release test run.
- Severity: P2 release-quality boundary; no observed production failure.
- Affected: Viewer selected rollback command transaction in `requestFirebaseAgentRollback`.
- Status: Repaired and covered before v0.1.95 publication.
- User-visible symptom: None observed; the repository architecture test stopped the release because the new transaction used direct batch writes.
- Minimal trigger: Run `src/firebase/firestoreWriteArchitecture.test.ts` against the rollback implementation containing `batch.update` and `batch.set`.
- Root cause and contributors: The rollback path did not follow the existing undefined-field sanitizing batch helpers used by other Viewer writes.
- Fix commit(s): Current v0.1.95 release commit.
- Permanent guard: The architecture test now rejects both direct `batch.update` and direct `batch.set` in Agent and Viewer Firebase sources.
- Regression proof: The six initially failing suites passed 98 tests after correction; the full repository suite then passed 1,036 tests.
- Release proof: Included in the fresh locally verified x86 installers; no public v0.1.95 claim before CI succeeds.
- Remaining blocker: Normal signed CI publication and live asset verification.

## INC-20260915-081: Ordinary input unnecessarily required the secure broker and release reused installed version

- Detected: 2026-09-15 user reports visible screen without input and no update from0.1.94.
- Status: Source repaired and focused local tests passed; physical verification pending.
- Evidence: Installed log contains repeated input-server exit code1. Medium-integrity input-server exits before reading stdin with protected-elevated-Agent error. Published0.1.94 correctly does not update installed0.1.94.
- Cause: Ordinary input shares the mandatory secure-broker entry, unlike ordinary capture; release validation covered0.1.90/0.1.93 but not a newer offer for the user's existing0.1.94.
- Guard: Native normal-desktop input boundary test; preserve protected desktop authentication. Prepare a strictly greater version without forceUpdate.
- Repair: Agent input JSONL dispatches ordinary actions under its own Windows identity; secure desktop requests retain authenticated broker/worker routing, with desktop race rejection and no automatic action replay. Versions aligned to0.1.95 in source only.
- Proof: Native x86 process test1, existing secure tests15 (live-input test intentionally not run), new actual pipe acknowledgement test1 and production update checks3 pass. No keys or mouse movements injected during tests. Current user session root cause and end-to-end behavior are not claimed verified from historical logs.
- Remaining: Verify real remote keyboard/mouse on designated devices and subsequent signed release/installation separately.


## INC-20260915-080: Signing job used a tag lookup for an unpublished draft

- Detected: 2026-09-15, CI run34870543317.
- Severity: P2 publication blocker.
- Affected: Isolated approved-artifact signing job only.
- Status: Source corrected; CI retry pending.
- User-visible symptom: Signed manifest is not available for the requested update publication.
- Minimal trigger: GET releases/tags/v0.1.94 while release388555161 remains a draft.
- Root cause and contributors: Tag endpoint returns404 for the unpublished draft; immutable release ID is available. Local tag query reproduced404 and ID query returned the expected draft.
- Fix commit(s): Current signing-branch correction.
- Permanent guard: Read the pinned immutable release ID, then still require exact tag, draft status and approved assets before and after signing.
- Regression proof: Node tests3 passed, including mocked unavailable tag endpoint, one ID lookup, published-release rejection and exact-byte/x86 guards.
- Release proof: No latest-channel change at failure. CI signing retry required.
- Remaining blocker: Successful CI signing and live signed metadata/download verification; original physical tests remain separate.
- Final result: CI34870755224 succeeded after pinned-ID correction. v0.1.94 latest published under explicit combined-product authorization. Live signatures, both installer downloads/hashes and real backed-up0.1.93 updater checks passed. Remote recipient installation remains pending; private signing key stayed in GitHub.


## INC-20260915-079: Publication contract omitted test links and misclassified documentation

- Detected: 2026-09-15 during requested Viewer test publication.
- Severity: P2 delivery blocker; no artifact published by this repair.
- Affected: CHANGE_CONTRACT.json and local recurrence validator.
- Status: Reference and documentation classification repaired; release readiness remains pending.
- User-visible symptom: Built Viewer cannot pass the predeploy gate.
- Minimal trigger: Validate a documentation-only fixed-test-device outcome and new untracked tests alongside functional outcomes.
- Root cause and contributors: Missing contractTests, new tests outside tracked diff, stale local installation evidence, and functional-only validation applied to documentation records.
- Fix commit(s): Current uncommitted correction; no commit or release asserted.
- Permanent guard: Explicit docs/not-applicable records require changed Markdown evidence and completed review. Functional outcomes still require changed test evidence. No product security or release status checks removed.
- Regression proof: Documentation false rejection reproduced RED; validator suite15 passed GREEN, including missing/invalid evidence, pending review and functional rejection cases. Related package/startup/update/adaptation suites93 passed.
- Release proof: None. Existing installer unchanged and no remote publication performed.
- Remaining blocker: Contract cannot truthfully be ready-to-deploy under existing all-outcomes policy while remote physical acceptance remains pending. Test publication needs an explicit scoped sequencing exception or the remaining physical proof; do not relabel it as completed.
- Subsequent authorized trial: User explicitly reaffirmed Viewer-only publication after the trial-sequencing exception question. Published viewer-test-0.1.94-20260915 as prerelease, not latest. Anonymous downloadHTTP200/full SHA256 matches F70F20E5D40C40910B724E6B3595BE58A31C9ED0B4F61ACACA68AC07EA35761D. Stable latest/Agent/manifest asset IDs and digests unchanged. Original physical gaps remain pending; overall release gate is not claimed passed.

## INC-20260914-078: Test Agent startup waits before showing its window

- Observation: On approved local test install82220F6D, installer0.1.93 exited0 and preserved registration. Unelevated --agent --show-window stayed in synchronous manage-agent-login-task.ps1 Ensure with no visible Agent window; Agent task was Ready. Cause not yet confirmed; a running process is not healthy Agent proof.
- Containment: Retained full pre-install backup and configuration. Stop only the exact newly launched test process/helper and invoke the existing installer-registered Agent task; do not bypass OS permissions or change task security.
- Verification: Pending installed startup/UI; do not expand this test build to other devices or public release based on installer exit alone.
- Follow-up: Existing Agent task launch succeeded; installed UI0.1.93 inspected, compact single-line layout confirmed and heartbeat accepted. This contains the local startup interruption, but does not repair the unelevated Ensure wait; retain as unresolved for normal launch.
- Source correction 2026-09-15: Moved Ensure subprocess from before Builder creation into a cancellable background operation after Tauri Ready. The UI loop no longer waits for Windows approval. Approved handoff exits the UI, invalidates the current watchdog generation, terminates this instance's job children and releases the single-instance guard before starting the existing protected Agent task. Viewer runtime path and task permission validation remain unchanged.
- Source proof 2026-09-15: x86 native tests2 passed for a real sleeping PowerShell child, cancellation without completion, and exit0/1/10 propagation. Installed WebView responsiveness, UAC interaction and scheduled handoff remain pending; do not infer runtime success from these tests.
- Installed follow-up 2026-09-15: New0.1.94 UI displays while setup waits; payload and registration verified. schtasks /Query of secure broker explicitly returned Access is denied. Earlier non-admin Get-ScheduledTask not-found did NOT establish task absence. Ensure incorrectly required non-admin visibility of the SYSTEM broker before handing off to the already-authorized protected Agent task, causing repeated setup. Reordered validation: valid Agent task hands off first; elevated Agent still validates/repairs broker. Regression with broker-query denial failed exit1 versus required10 before repair. No task permissions or OS approval checks weakened.
- Handoff correction 2026-09-15: Installed r2 exited after ordinary launch without starting task. Current tauri-runtime-wry2.11.2 RequestExit(code) emits code in ExitRequested but sets ControlFlow::Exit without that code, so run_return was0. Remember explicit ExitRequested(Some10) independently, release instance guard after UI/child cleanup, then start the approved task. Existing task was manually started to restore online Agent during repair. Structural regression protects event-code storage; final new-installer handoff remains required before success claim.
- Final installed result 2026-09-15: r3 installer SHA2567546DD3620FCAA9C7685EFDDD238EF6C6039811D194C0D497460558C2A013478 exit0 on82220F6D. Ordinary launch10384 logged handoff followed by scheduled Agent start01:09:52,Online and accepted heartbeat; no setup dialog. Subsequent ordinary show-window request exited as duplicate and displayed existing0.1.94 UI. Original registration preserved. Normal-launch handoff now physically verified on this PC only; first-ever setup cancellation and cross-PC remote input remain separate checks.

## INC-20260914-076: A new incoming file could replace a completed spool before UI restoration

- Cause: Receiver allowed a new transfer ID to clear completed state automatically; the UI ready-file guard can still be unset during asynchronous restoration.
- Correction: Require explicit discard before replacing any stored transfer, enforced transactionally in the receiver rather than only in React.
- Proof: Added completed-spool replacement rejection followed by successful original restoration/duplicate proof. No installed release affected.

## INC-20260914-075: Restore handler referenced an effect-local Firebase flag

- Cause: New tools-toggle callback reused firebaseEnabled, which exists only inside a separate effect.
- Correction: Use the existing synchronous isViewerFirebaseEnabled helper at the UI boundary.
- Proof: TypeScript found the out-of-scope reference; corrected compile and actual App restore check passed. No release occurred.

## INC-20260914-074: Reverse command test assumed a plain fixture function was mocked

- Cause: getActiveSessionId in createRuntime is a plain function; vi.mocked does not convert it to a mock at runtime.
- Correction: Assign explicit session getter functions in the scoped test without changing other fixtures.
- Proof: Initial focused suite failed on fixture setup,61 other tests passed; corrected focused test and TypeScript passed. No runtime product behavior affected by this test mistake.

## INC-20260914-073: Picker cancellation could throw during child termination

- Cause: Initial helper used kill in a try/finally, allowing a synchronous termination exception to escape the cancellation callback.
- Correction: Settle and clean the operation first, then attempt termination without replacing the original cancellation/timeout result.
- Proof: Added process-boundary kill-throws regression; interactive process termination remains unverified.

## INC-20260914-072: Reverse transfer test used Array.at outside configured TypeScript library

- Cause: Test runner accepted Array.at but the repository TypeScript target does not expose it.
- Correction: Use indexed last-call access; do not raise the platform/library target for a test.
- Proof: Focused runtime passed before correction; TypeScript rerun passed with indexed access. No production behavior changed.

## INC-20260914-071: PowerShell rg wildcard path repeated during reverse-transfer investigation

- Cause: A literal src/domain/*.ts path was passed to rg; PowerShell did not expand it.
- Correction: Use the directory operand with -g '*.ts'; locate files before reading them.
- Proof: Corrected directory search located agentPeerConnection.ts and its tests. No product code or installed behavior affected.

## INC-20260914-070: Selected rollout preview assumed Agent capability

- Cause: Matching target ID was called eligible although older Agents only see the intentionally closed0% policy.
- Correction: Advertise selected rollout support with current version on existing Agent heartbeat and require matching version in shared eligibility. Missing/stale capability is explicitly unknown; ordinary fleet rollout unchanged.
- Proof: Four suites53 cases passed including Viewer capability display and one-write/no-read heartbeat. Installed older-Agent bootstrap remains pending.

## INC-20260914-069: Native JPEG failure advanced baseline and emitted incomplete frames

- Cause: Compression errors skipped tiles after get_dirty_tiles had committed the new baseline. Missing cells might not be retried for an unchanged screen.
- Correction: Publish only when all expected tiles encoded; invalidate baseline on mismatch so next capture is full, for both keyframe and delta failures.
- Proof: Supported i686 native lifecycle test passed;2 existing merge/edge tests passed. Covers partial initial encode, recovery, failed delta, full retry and clean steady frame; actual compressor fault injection and target hardware remain pending.

## INC-20260914-068: Incomplete keyframes could replace a valid screen

- Cause: JPEG decoding success was checked, but the declared full frame could omit cells or claim tile dimensions different from the decoded image.
- Correction: Validate full32px-cell coverage without overlap before staging, plus actual image dimensions. Keep last good canvas and report display error on failure.
- Proof: Geometry and actual App missing-half-frame retained-canvas tests passed3 selected cases; TypeScript passed. Installed protocol compatibility remains pending.

## INC-20260914-067: Viewer downloaded incoming file fragments separately

- Cause: Session files callback created a Blob/download for every file document, ignoring transfer metadata and hashes.
- Correction: Bounded direct-fallback assembler combines indexed parts, validates sizes/hashes, suppresses recent duplicate completions and clears on session disposal. Corrupt/unsupported delivery reports an error rather than an empty download.
- Proof: Three focused suites8 tests passed including actual App one-download/byte-content over HTTP and streaming hash helper; TypeScript passed. Reverse sender and500MB WebRTC/Android file save remain incomplete.
- Test correction: Selecting latest subscription alone did not fix the failure; error-banner evidence identified missing crypto.subtle on HTTP. Reuse existing sha256BlobHex streaming helper, preserving hash verification on local HTTP instead of skipping it. Earlier subscription-only attribution was insufficient.

## INC-20260914-066: Selected rollout preview omitted unlisted target IDs

- Cause: Preview rendered current devices only, but saving retained other selected IDs. Actual policy scope could exceed visible rows.
- Correction: Display total selected IDs and unlisted IDs with explicit removal; never silently drop them on save.
- Proof: Actual App test preserves an unlisted ID on first save, explicitly removes it on second save, and verifies one device-list read/no new subscription. Installed capability-aware rollout remains pending.

## INC-20260914-065: Android test invocation omitted existing SDK path

- Cause: Direct Gradle invocation did not reuse build-agent-release.ps1's ANDROID_HOME default; SDK was already present under LOCALAPPDATA/Android/Sdk.
- Correction: Verify existing SDK and set ANDROID_HOME only for the test process. No duplicate installation or system environment change.
- Proof: Initial invocation failed before tests. Corrected invocation passed native6 tests using existing SDK; no system setting changed.

## INC-20260914-064: Local tile HTTP failures were represented as empty success

- Cause: fetchTiles returned an empty frame for non-OK HTTP responses; the polling caller swallowed network errors. Status could continue showing the last successfully drawn picture as receiving.
- Correction: Propagate HTTP errors, show receive-error state, clear on successful response, and ignore results older than a newer completed request or from an ended effect. Existing polling frequency unchanged.
- Proof: Actual App routed local HTTP503, delayed old success, and recovery status test passed; three related suites33 cases passed. Installed local server verification pending.

## INC-20260914-063: Corrupt keyframes replaced the last valid picture

- Cause: Failed JPEG decoding returned null but the staging canvas was still published and marked with tile sequence numbers. Delta image errors had no status handler.
- Correction: Reject keyframes with undecodable tiles before publishing, retain last picture, show decode failure until a valid keyframe, and allow existing manual reconnect. Transport failure takes precedence.
- Proof: Actual App red/corrupt/green frame pixel and status regression plus connection status tests passed18 cases; TypeScript passed. Capture-side and installed-device proof still required.

## INC-20260914-062: Completed file ACK totals were not verified

- Cause: Normal WebRTC transfer accepted complete status without matching source byte/chunk totals. Resume completion with partial totals returned false instead of reporting an invalid acknowledgement.
- Correction: Match exact totals before success/progress; reject premature resume completion. No additional requests or timers.
- Proof: Three focused regression cases reproduced false success before repair. Transport suite18 passed after repair, including premature and valid resumed completion; TypeScript passed. Installed remote filesystem proof remains required.

## INC-20260914-061: File cancellation waited for ACK timeout

- Cause: AbortSignal was checked between chunks but not subscribed during ACK waits; cancellation could wait up to20s. Reading/hashing also lacked a final pre-send abort check.
- Correction: AbortSignal terminates the existing waiter immediately; all terminal paths remove timer/listener, and read/hash completion checks abort before sending.
- Proof: Transport suite passed13 tests including cancellation, late ACK isolation and next transfer; TypeScript passed. Receiver partials intentionally remain resumable. Installed device verification pending.

## INC-20260914-060: Upload completion concealed remote file-save failures

- Scope: Viewer cloud/fallback file-transfer queue; existing source, not a new production deployment.
- Cause: Queue entered terminal completed state when upload returned. Agent receipts only changed a separate single-active progress display, so failures could not correct the terminal queue item.
- Correction: Await remote receipt for cloud paths and update all matching queue entries for received/failed receipts. Preserve cancelled terminals and direct WebRTC final-ACK completion.
- Proof: Actual App delayed two-file receipts and queue transition tests passed20 cases; TypeScript passed. Awaiting receipts survive terminal cleanup. Installed bidirectional transfer/resume remains pending.

## INC-20260914-059: Native test invocation omitted repository portable toolchain

- Scope: Local verification only, no release or installed application changed.
- Cause: Direct cargo invocation used default x64 and could not find CMake; existing backend tooling keeps portable CMake/NASM under aether-link-app/.local-run.
- Correction: Reuse those tool directories on process PATH and explicitly test supported i686-pc-windows-msvc. Do not change system PATH or install duplicate tools.
- Proof: Native compilation succeeded and two stream profile tests passed. Processing-cost source runtime and low-spec physical performance remain unverified.

## INC-20260914-058: Extracted toolbar browser harness missed new status dependencies

- Scope: Development browser harness only; no release affected.
- Cause: The extracted App toolbar gained connection-status helper/state dependencies in an earlier stage, but its isolated fixture was not updated. Toolbar visibility timed out.
- Correction: Import the real status helper and supply fixture connection state; surface page errors immediately. Retain full-App connection tests as the behavioral evidence, not this extracted layout fixture.
- Verification: Corrected fixture passed five portrait/landscape/keyboard sizes; actual App browser suite passed 14 tests. Installed Android proof remains pending.

## INC-20260914-057: Diagnostic export initially omitted version helper argument

- Scope: Source-only feature development; no installed or public artifact affected.
- Cause: New export caller omitted the existing required environment argument; TypeScript rejected it before execution. A transport source lookup also assumed an incorrect filename.
- Correction: Reused `getViewerVersion(import.meta.env)` and located transport code in `viewerFirebase.ts`.
- Follow-up investigation correction: Windows `rg` wildcard path arguments failed again while locating rollout and workspace helpers; successful searches used directory roots with `-g` filters. No product file was changed by these failed searches.
- Proof: TypeScript passes; actual App preview/download and connection status plus domain tests pass 15 cases. Check existing call sites before adding helper calls or guessing module paths.
- Remaining: Feature-level Android delivery and other improvement outcomes remain pending in the active contract.

이 파일은 사고 발생 당시의 관찰·원인·조치·정정을 보존하는 기록이다. 과거 항목의 정책·버전·검증 수치가 현재 상태를 뜻하지는 않는다. 현재 공통 절차는 [범용 개발 지침서](work-guides/DEVELOPMENT_GUIDE.md), 저장소 필수 조건은 [AGENTS.md](AGENTS.md), 진행 상태는 [CHANGE_CONTRACT.json](CHANGE_CONTRACT.json)을 확인한다. 문서 통합 과정에서 기존 사고 본문과 미검증 항목을 삭제하거나 종결 처리하지 않았다.

## INC-20260914-056: Windows search commands used invalid shell-style path globs

- Detected: 2026-09-14 during the resumed whole-product audit.
- Severity: P3 development inefficiency; no product or user data impact.
- Affected: Repository search output only.
- Status: Corrected investigation method; product files were not changed by the failed commands.
- User-visible symptom: None. Several targeted searches returned Windows path/regex errors or produced truncated combined output; one browser verifier was first called with the wrong filename and then without its required local server.
- Root cause and contributors: Shell-style wildcard paths and one incorrectly escaped regular expression were passed directly to `rg` on Windows; one combined search also requested too much unrelated context. A JavaScript orchestration snippet and the first PowerShell-to-npm argument pass-through were malformed. A non-ASCII paste typo briefly changed the local API constant during the first patch and was corrected before compilation or execution.
- Fix commit(s): Current audit workflow correction only.
- Permanent guard: Use repository roots plus `rg -g` filters, list an uncertain script path before execution, use `cmd /c` for npm argument pass-through on Windows, verify prerequisites such as a local server, and request small line slices instead of broad combined context.
- Regression proof: Subsequent searches used exact paths or `-g` filters and returned the intended Agent command, session event and keyboard ownership code. The correctly named device-organization verifier passed against a bounded local server with all external traffic blocked, and that server was then stopped.
- Release proof: Not applicable.
- Remaining blocker: None.

## INC-20260914-055: Remote clipboard receive depended on a fixed 600ms delay

- Detected: 2026-09-14 while tracing PC Viewer input and collaboration functions.
- Severity: P1 conditional clipboard failure on delayed links.
- Affected: Explicit `원격 PC -> 내 PC` text clipboard action in PC and Android Viewer sessions.
- Status: Source repair and focused regressions verified; not built, installed or released.
- User-visible symptom: The button can report no clipboard or copy an older queued value when the Agent response takes longer than 600ms.
- Minimal trigger: Delay Agent clipboard acquisition or response delivery beyond 600ms, then press the explicit receive button.
- Root cause and contributors: Viewer sent `clipboard-request`, slept for a fixed 600ms, then drained the queue once without waiting for the response lifecycle or distinguishing pre-existing queue data.
- Fix commit(s): Current scoped working-tree repair; no build, install or deployment.
- Permanent guard: Use one user-triggered clipboard-only event subscription, establish and drain its initial state before sending the command, accept one subsequent Agent response, and close on every terminal path. Keep automatic synchronization and idle clipboard listeners absent.
- Regression proof: Domain orchestration, Firebase subscription and real local-HTTP routing passed 13/13. The actual App handler execution passed stale-initial-data rejection, explicit request, one local clipboard write, queue isolation and cleanup. TypeScript passed.
- Verification correction: The first handler assertion compared an object created inside a VM context with a host-realm object using prototype-sensitive deep equality. Field-level assertions retain the intended queue-selection proof without changing product code.
- Release proof: Not released.
- Remaining blocker: Installed cross-PC delayed response and clipboard permission behavior require physical verification.

## INC-20260914-052: Inactive Android session retained an input-blocking settings backdrop

- Detected: 2026-09-14 during the real-browser multi-session functional audit.
- Severity: P1 Android navigation usability.
- Affected: Android Viewer settings overlay across device-list return and session switching.
- Status: Source repaired and focused browser regression verified; not released.
- User-visible symptom: After returning to the device list and opening another session, visible session-tab controls can stop responding.
- Minimal trigger: Open a remote session, open Android settings, return to the device list, open a second session, select the first session, and press the second session's close button.
- Root cause and contributors: `mobileToolsOpen` belonged to each mounted session panel but was not cleared when that panel became inactive or invisible. Its backdrop remained mounted and intercepted pointer events above the visible session tabs.
- Fix commit(s): Current scoped working-tree repair; no build, install or deployment.
- Permanent guard: Close session-local overlays whenever their session loses active/visible ownership, regardless of whether navigation came from the settings button, session selection, or native Android Back event.
- Regression proof: `viewerDeviceRefresh.test.ts` passed all 9 real-browser cases, including settings -> list -> second session -> tab close. `verify-mobile-session-tools.mjs` passed five portrait, landscape and keyboard-sized viewports after the lifecycle cleanup.
- Release proof: Not released.
- Remaining blocker: Installed Android Back/list/session switching requires physical-device verification.

## INC-20260914-051: Optional dynamic TURN failure blocked non-relay WebRTC startup

- Detected: 2026-09-14 during the whole-product functional audit.
- Severity: P1 conditional connection outage.
- Affected: Shared RTC configuration used by Firebase Viewer and Agent transports when dynamic credentials are enabled.
- Status: Source repaired and automated transport regression verified; not released.
- User-visible symptom: A session can remain connecting with no screen or control channel when the dynamic credential callable is unavailable, even on a network where STUN/direct connectivity could work.
- Minimal trigger: Enable dynamic RTC credentials without static TURN, keep relay-only disabled, and make `getRtcConfiguration` fail.
- Root cause and contributors: The shared resolver returned its static configuration after dynamic failure only when that configuration contained TURN. It discarded a valid STUN-only `iceTransportPolicy: all` fallback and threw before either peer could be created.
- Fix commit(s): Current scoped working-tree repair; no build, install or deployment.
- Permanent guard: A dynamic-load failure may fall back to the already-resolved static configuration whenever relay-only is false; relay-only must continue requiring a usable TURN server. Exercise the same resolver used by Viewer and Agent.
- Regression proof: The added STUN-only optional-dynamic case failed RED with `callable unavailable`, then passed after the one-condition repair. Repository-wide `npm test` passed 139 files and 865 tests, including the shared RTC, Viewer and Agent signaling paths; relay-only without TURN remains fail-closed.
- Release proof: Not released.
- Remaining blocker: External-network P2P and TURN traversal need two-device proof across restrictive NAT/firewall conditions.

## INC-20260914-050: Repository-wide test command mixed stale contracts with standalone scripts

- Detected: 2026-09-14 during the whole-product functional audit.
- Severity: P2 verification reliability.
- Affected: `npm test` file discovery and nine build, session, clipboard, Firebase, mobile, native-input and runtime assertions.
- Status: Test ownership and current-contract assertions corrected and verified.
- User-visible symptom: The main test command exits red even when three standalone browser checks print PASS, while stale assertions obscure which product boundary is actually broken.
- Minimal trigger: Run `npm test` from `aether-link-app` on the current supported x86 source tree.
- Root cause and contributors: Standalone `.test.mjs` scripts were auto-collected as empty Vitest suites; several tests retained obsolete command order, variable names, automatic clipboard state, Firestore mocks, Rust filter names and mobile selectors. The host-architecture smoke also treated a missing unapproved x64 runtime as the supported x86 release result.
- Fix commit(s): Current scoped working-tree test repair; no product build or deployment.
- Permanent guard: Keep standalone browser programs outside Vitest discovery, assert current user-visible contracts, run the approved x86 runtime unconditionally, and report optional x64 availability without claiming it is the shipped artifact.
- Regression proof: `npm test` passed 139 files and 865 tests with the emulator-gated integration and unavailable optional x64 success case intentionally skipped and no standalone empty-suite errors. Explicit clipboard/IME, mobile-controls, mobile-gesture, mobile-session-tools and desktop-keyboard browser programs passed; the separate device-organization browser flow passed. The skipped Firestore integration then passed separately 1/1 under the emulator; approved x86 runtime checks passed.
- Release proof: Not applicable; no runtime artifact changes from this test repair.
- Remaining blocker: None for test-runner ownership. User-visible installed-device and external-network gaps remain tracked by their product outcomes.

## INC-20260914-053: Local Vite audit command forwarded options incorrectly

- Detected: 2026-09-14 while starting the temporary browser-audit server.
- Severity: P3 verification command only; no product or repository state changed.
- Affected: One local attempt to start Vite on port 5175.
- Status: Corrected immediately.
- User-visible symptom: The first start attempt exited with `CACError: Unused args: 5175`; no app server was started by that command.
- Root cause and contributors: The npm-script invocation was parsed by the current PowerShell/npm combination so `--host` and `--port` became positional arguments.
- Fix commit(s): Not applicable; execution correction only.
- Permanent guard: Invoke the local Vite executable directly with `--host=<value>` and `--port=<value>` when a fixed audit port is required.
- Regression proof: Direct Vite startup reported ready on `http://127.0.0.1:5175/`; the device edit/group/duplicate-update browser check passed, and the temporary server was then stopped.
- Release proof: Not applicable.
- Remaining blocker: None.

## INC-20260914-054: Emulator runtime cleanup preceded gated-test inventory

- Detected: 2026-09-14 during whole-product audit cleanup.
- Severity: P3 verification efficiency; no product or repository state changed.
- Affected: Temporary Microsoft OpenJDK 21 download used by local Firestore checks.
- Status: Corrected in the same audit.
- User-visible symptom: The approximately 200MB temporary JDK archive had to be downloaded a second time before the emulator-gated integration test could run.
- Root cause and contributors: Temporary dependency cleanup ran after the rules script but before identifying every test guarded by `FIRESTORE_EMULATOR_HOST`.
- Fix commit(s): Not applicable; audit workflow correction only.
- Permanent guard: Inventory environment-gated tests before acquiring temporary runtimes, run all tests sharing that runtime in one batch, then clean the verified temporary paths once.
- Regression proof: The command deletion recovery integration passed 1/1 under the second and final runtime session; the extracted JDK, ZIP and generated emulator log were then removed and their absence checked.
- Release proof: Not applicable.
- Remaining blocker: None.

## INC-20260914-049: PC Viewer keyboard ownership was lost outside the session panel

- Detected: 2026-09-14, after the user reported that PC Viewer mouse control worked but keyboard input did not.
- Severity: P1 remote input unavailable.
- Affected: PC Viewer WebView keyboard focus and the active remote-session control channel. Android explicit-keyboard behavior is excluded.
- Status: Source repair and focused browser/IME regressions verified; the running PC Viewer v0.1.90 is unchanged.
- User-visible symptom: Remote mouse commands operate the PC, but typing in the PC Viewer produces no remote key or text input.
- Evidence: The installed Agent log records current-session mouse `Inject Success` entries while the last key/text injection predates the current sessions. The control channel is open, so the failure occurs before command transmission. The recently published Android v0.1.93 and Hosting assets did not replace the installed PC Viewer v0.1.90 executable.
- Root cause and contributors: Keyboard handlers existed only on the remote session panel. If WebView DOM focus fell to the document body or another non-panel target after a window/focus transition, no handler owned the event; mouse input remained unaffected because the canvas sends pointer commands directly. Existing tests exercised handler logic but not this lost-focus boundary.
- Fix commit(s): Current scoped source repair in the working tree; no PC build, install or release performed.
- Permanent guard: While one desktop session is active, recover only otherwise-unowned window key events into that session and restore the hidden IME sink. Ignore events already handled inside the panel and preserve local form/button ownership. Disable this recovery for Android.
- Regression proof: `node scripts/verify-desktop-keyboard-recovery.mjs` passed real Chromium focus loss/recovery, local-input exclusion, disabled mobile-equivalent behavior and no duplicate panel events. The existing IME/Enter/Ctrl/clipboard script passed with its actual event-normalization helper, `remoteSessionLayout.test.ts` passed 22/22, and TypeScript passed.
- Verification correction: The first disabled-state browser assertion ran before React completed listener cleanup; waiting for the rendered state removed the false failure. The existing standalone IME script also requires the TypeScript loader rather than plain Node or a Vitest suite wrapper. Neither issue changed product behavior.
- Remaining blocker: Build and install a separately authorized PC Viewer update, then verify English/Korean typing, Enter, modifiers and reconnect from the user's second PC. Source/browser proof cannot change or certify the currently running v0.1.90 binary.

## INC-20260912-048: Android remote viewport omitted native insets and complete touch affordances

- Detected: 2026-09-12, after live video reception was restored.
- Severity: P1 usability; video is visible but system UI overlaps content, no pointer is shown, Windows-key controls can reopen IME, and only part of the black margin accepts local gestures.
- Affected: Android Viewer WebView remote-session viewport and mobile control toolbar in portrait and landscape.
- Status: Focused automated regression verified; signed v0.1.93 build, Hosting publication and installed-device verification pending.
- User-visible symptom: Remote pixels begin under the Android status bar, the remote pointer is invisible, Fn/Ctrl/Alt/Shift can open the software keyboard, and landscape black margins cannot all be used for pan or pinch.
- Minimal trigger: Connect from the Android Viewer, rotate once, tap a Windows modifier, and try to pan or pinch from each black margin around the fitted remote image.
- Root cause and contributors: target-SDK 35 WebView content had no native system-bar/cutout inset handling; mobile input retained no visible normalized pointer; toolbar focus policy did not explicitly revoke IME ownership for non-keyboard controls; the gesture layer existed only as a portrait bottom strip.
- Fix commit(s): Current scoped working-tree repair for Android Viewer v0.1.93; no commit or PC release has been created yet.
- Permanent guard: apply native system-bar and cutout padding without duplicating `adjustResize`; render the Viewer-controlled pointer from normalized remote coordinates; make keyboard ownership explicit; derive transparent gesture hit regions from every margin around the transformed canvas in both orientations.
- Regression proof: TypeScript passed; connected-session layout passed 22/22, including Android Back scope handoff without session close; actual App mobile layout passed five viewport sizes; rendered mobile controls passed three viewport sizes; portrait/landscape gesture geometry and cursor alignment passed; API 35 Robolectric verified status-bar/cutout padding without duplicate IME padding plus 2,000ms same-scope Back behavior, and Android Viewer Java compilation passed.
- Release proof: 2026-09-12 signed Agent/Viewer/Control Add-On v0.1.93 build passed v2 signature and JNI mapping checks. Firebase Hosting publication completed; live update metadata and all three downloaded ZIP SHA-256 values matched, `/viewer` returned 200 with its new bundle, and all v0.1.92 immutable ZIP URLs remained available. No PC installer, GitHub release or Git push was created.
- Remaining blocker: Install the resulting Viewer APK and check status-bar/cutout spacing, IME behavior, pointer alignment, rotation, and margin gestures on the user's Android device. The local pointer does not claim synchronization with an independently moved physical mouse at the remote PC.

## INC-20260912-047: Capture first frame blocked by idle synchronous duplex read

- Detected: 2026-09-12, Android Viewer shows 59F19451 but 82220F6D remains black.
- Severity: P1, authenticated remote session connects without visible desktop.
- Status: Native source repaired, focused regression verified, i686 protected runtime installed, and Android frame reception confirmed by the user on 82220F6D.
- Evidence: Live 82220F6D session mtxdebk8-1x0rt4e opened tile/control/file channels and kept capture client/worker running. Unlike the earlier session, no EPIPE occurred. EPIPE handling alone was not the cause or a sufficient repair.
- Root cause: Capture proxy, broker relay and worker stdio duplicate synchronous duplex pipe handles. Pending control reads serialize writes on the same Windows file object, blocking unsolicited frames. Existing input request/response tests did not exercise idle control plus independently produced frames.
- Permanent guard: Overlapped named-pipe IO with per-clone events and completed operations before buffer release. Bridge worker stdio through separate synchronous anonymous input/output pipes. Preserve all named-pipe ACL, executable identity, session and command allow-list checks; add no polling or network request.
- Regression proof: The real Windows 128KiB unsolicited-first-frame test failed before the repair with a 3-second timeout and passed afterward. Fifteen i686 release-profile secure_capture tests pass (one separate live-input test ignored), including 1MiB worker stdio, controls, peer-close EOF and three fresh connections; existing two-pipe mouse/keyboard exchanges also pass. Warnings-denied i686 Clippy passed.
- Local application proof: 2026-09-12 elevated repair stopped the Agent and SYSTEM broker, verified backup/staged/installed SHA-256, replaced only `Program Files (x86)\\WonRemote Agent\\bin\\wonremote-poc.exe`, then restarted both tasks. Installed hash is `F1DF651A9D9910B832870A2F2FBF7FFB6BFDFEAC0DCBBF8F94ADDD4CCB2DF30A`; the previous `DF46D8856268AED63E653AA82C4D06E12D686348FD0C5E8C6961B4CA25A870C0` is retained as a protected-dir backup. Agent heartbeat and active-session recovery logged after restart.
- Physical frame proof: After reconnecting from Android, the user reported that screen reception works. This confirms the reported 82220F6D first-frame symptom for the current connection, not every reconnect or monitor path.
- Release proof: No new installer or public deployment yet. Local repair is not a signed public release.
- Remaining proof: Repeat reconnect and monitor switching on 82220F6D and confirm 59F19451 remains working; PIN and unrelated older gaps remain open.

## INC-20260909-007: Installer stop left a valid secure-capture task idle

- Detected: 2026-09-09
- Severity: P1 update-time PIN capture outage
- Affected: Agent installer update followed by protected-desktop capture
- Status: Automated regression verified; packaged update pending
- Root cause: installer overwrite correctly stops the SYSTEM broker, but the first Ensure path treated a valid Ready task as complete and did not restart it.
- Permanent guard: a valid broker definition is not runtime health; elevated Agent startup must start the broker whenever its task state is not Running, with an executed PowerShell regression test.
- Regression proof: the focused Windows PowerShell test executes the real Ensure branch with a valid Ready broker task and passed, proving exactly one broker restart without re-registration or UAC.
- Release proof: not applicable; no installer was built or deployed.

## INC-20260909-006: PowerShell fixture asserted after the tested script exited

- Detected: 2026-09-09
- Severity: Low (test-only failure; no product artifact changed)
- Affected: Agent installer process-stop regression test
- Status: Guard added
- Root cause: the fixture placed its summary output after invoking the real script, whose successful exit 0 correctly terminates the PowerShell process.
- Permanent guard: assert events emitted by mocked boundaries during script execution; never put required assertions after a script that owns process exit.
- Regression proof: focused Agent startup test executed the real stop script and passed, proving the broker stops before protected and legacy process trees while an unrelated process is preserved.
- Release proof: not applicable; no installer build or deployment requested.

## INC-20260909-005: Native verification bypassed the repository toolchain environment

- Detected: 2026-09-09
- Severity: Low (verification delay only; no product artifact changed)
- Affected: `aether-link-poc` x86 `cargo check`
- Status: Guard added to this change's verification procedure
- Minimal trigger: run Cargo directly without the CMake/NASM directories prepared by `scripts/build-backend.js`.
- Root cause: the verifier used a generic Cargo command even though `turbojpeg-sys` requires the repository's cached native-tool paths.
- Permanent guard: native checks must prepend `.local-run/cmake/.../bin` and `.local-run/nasm/...`, or run through the repository build helper. Do not retry the unqualified command.
- Regression proof: cargo check --release --target i686-pc-windows-msvc passed in 9.88s with the repository CMake/NASM paths prepended.
- Release proof: not applicable; no installer or installer build was requested.


## INC-20260908-004: Installed Windows behavior omitted from browser and installer checks

- Detected: 2026-09-08.
- Severity: P1 remote availability and input.
- Affected: Agent protected credential-screen capture, first-run UAC, NSIS finish page, Viewer grouping, Korean IME Enter.
- Status: secure-capture implementation automated-verified; packaged physical verification pending.
- User-visible symptom: PIN screen unavailable; installer blocks on unreadable UAC guidance and redundant options; native Viewer group drop fails; Enter during Korean composition is not delivered correctly.
- Minimal trigger: With the Agent still reachable, click the Windows lock screen into the PIN prompt; or install Agent, drag a row in Tauri, or press Enter during Korean IME composition.
- Root cause and contributors: For the reported PIN case the Agent remains reachable, but its ordinary DXGI child loses access when Windows switches to the protected Winlogon desktop. The earlier claim that Agent startup absence caused this reproduction was incorrect. Other contributors remain PowerShell 5.1 BOM handling, Tauri native drop interception, Process/229 Enter handling and NSIS callback ordering.
- Fix commit(s): pending.
- Permanent guard: Treat explicit DXGI access denial as a protected-desktop transition and hand capture only to a LocalSystem worker on the active console Winlogon desktop. Require a Program Files runtime, a SYSTEM/administrator-only native pipe, exact peer executable matching and a broker command schema that cannot request input injection. First-run helper uses UTF-8 BOM and idempotent task setup. Other guards remain native drag/drop disabling, Process/229 Enter normalization and correctly ordered NSIS callbacks.
- Regression proof: x86 release-profile Rust tests passed 38/38; focused secure/protected/capture tests passed 6/6; complete desktop packaging and Agent startup tests passed 72/72; TypeScript passed. The secure request rejects unknown fields, the broker hardcodes capture-only secure-stream mode, both desktop transitions are explicit and installer overwrite stops the broker before its process tree.
- Release proof: No build/deploy requested this turn.
- Remaining blocker: Packaged Windows lock-screen-to-PIN pixels, reboot behavior, UAC, native drag/drop and actual Windows IME require physical verification; do not claim automated proof verifies those boundaries.

## INC-20260908-002: Rules test reused a refreshed heartbeat for its stale case

- Cause: The metadata-preservation scenario refreshed lastSeenAtServer before the stale-presence rejection scenario.
- Guard: Restore the old timestamp through the emulator-only admin endpoint immediately before testing rejection; preserve the denial assertion.
- Proof: Java 21, npm run firebase:rules:test passed with emulator v1.22.0 on 2026-09-08, including unauthorized access and stale-session rejection.
- Remaining verification: Live cross-client metadata after deployment; remote input assigned to user.
- Reporting correction: Prior replies incorrectly made optional Authenticode signing a release blocker. No certificate is configured; issuance needs account identity verification, but existing policy does not require it to deploy.

## INC-20260907-003: Runtime diagnostic storage has no bound
- Detected: 2026-09-07
- Severity: P2
- Affected: Windows Agent and Viewer runtime diagnostics
- Status: fixed-not-released
- User-visible symptom: Runtime logs keep accumulating; local wonremote-tauri.log measured 102.20 MiB.
- Minimal trigger: Keep installed applications running over repeated sessions.
- Root cause and contributors: append_runtime_log_entry always appends without rotation; Agent capture streamStderrText retains all stderr until process close. Screenshot also includes unrelated Windows and third-party files, which must not be attributed to WonRemote.
- Fix commit(s): uncommitted; shared log 5 MiB x 3 rotation, bounded capture stderr, daily startup cache-only maintenance, seven-day expired installer cleanup and healthy-handoff artifact deletion.
- Permanent guard: Filesystem tests cover oversized logs, exclusive log/update locks, live-browser refusal, daily cadence and login/identity preservation. Cache deletion rejects reparse points, and process detection fails closed with a two-second deadline. A threshold recheck cannot turn an unverified browser into permission to delete.
- Regression proof: rustc --test aether-link-app/src-tauri/src/runtime_storage.rs followed by test binary: 5 passed. npx vitest run src/agent/captureDiagnostics.test.ts src/agent/productionInstallerUpdate.test.ts: 11 passed, including generated PowerShell cleanup against real temporary files. cargo check --lib --offline and npx tsc --noEmit passed.
- Remaining physical verification: Packaged x86 startup/process detection, successful and failed actual updates, long-session storage stability; no installed data deleted and no build performed.

## INC-20260907-004: Remote taskbar application launch blocks input
- Detected: 2026-09-07
- Severity: P1
- Affected: Windows remote input, reported by user
- Status: fixed-not-released; remote physical verification required
- User-visible symptom: Mouse and keyboard stop controlling an application launched from the taskbar.
- Minimal trigger: Connect remotely and launch affected taskbar application; application name pending.
- Root cause and contributors: Local Everything installation specifies run_as_admin=1; TokenElevation inspection confirmed its window process elevated=True while this test process is elevated=False. This matches the SendInput integrity restriction; existing selected-tool RunAsInvoker does not cover taskbar launches. Full remote-session reproduction is still pending.
- Fix commit(s): uncommitted; Agent installer now registers and immediately starts one interactive logon task at highest privilege, replaces it on updates, and removes it on uninstall.
- Permanent guard: Both x86 and legacy x64 Agent installer hooks must use the shared scheduled-task helper; the helper verifies its exact executable, `--agent` argument and highest run level. Keep the installer in current-user mode so existing silent updater paths are not moved to an incompatible installation scope.
- Regression proof: `npx vitest run src/desktopPackaging.test.ts -t "installs and removes one highest-privilege Agent login task"` passed 1/1. The actual low-privilege helper displayed the Korean pre-UAC update guidance, accepted UAC, and re-registered the installed v0.1.87 Agent task; Task Scheduler reports Interactive/Highest, AtLogOn, IgnoreNew and the exact Agent path/argument. OpenProcessToken previously confirmed its host PID 30896 elevated=true.
- Remaining physical verification: Build/install boundary, first migration UAC, next-login launch, subsequent updater replacement, uninstall cleanup, and remote input into both normal and elevated taskbar applications. Windows does not allow an already deployed non-elevated Agent to perform its first privilege migration without one UAC approval.

## INC-20260908-001: Agent installer could not resolve a shared NSIS hook

- Detected: 2026-09-08.
- Severity: P2.
- Affected: x86 Agent installer build for v0.1.88.
- Status: build-verified; deployment blocked.
- User-visible symptom: Agent installer build aborts before producing an installable artifact.
- Minimal trigger: Package the Agent NSIS installer after adding a shared hook with a relative `!include`.
- Root cause and contributors: Tauri generates the final NSIS script in its target directory. NSIS resolves both a bare include and a macro-expanded `__FILEDIR__` relative to that generated script rather than the source hook file.
- Fix commit(s): uncommitted.
- Permanent guard: Resolve the shared hook through `${__FILEDIR__}` in both Agent hook variants, capture that directory when the shared file is included, and use the captured value for embedded files. Assert both paths in the packaging contract test.
- Regression proof: `npx vitest run src/desktopPackaging.test.ts -t "installs and removes one highest-privilege Agent login task"` passed 1/1. Direct x86 Agent NSIS packaging completed after the captured-source-directory correction.
- Release proof: x86 Viewer and Agent payload SHA-256 checks passed; signed v0.1.88 update manifest verification passed. Not deployed.
- Remaining blocker: Deployment gate remains blocked by unverified remote input/Firestore boundaries and unsigned installers.

Every production defect, installer failure, update failure, crash, or repeated user-visible malfunction must receive an entry before its fix is declared complete. Entries are append-only. A future change may add evidence or close a verification gap, but must not erase the original failure record.

This also covers development-process escapes: missed requirements, incomplete platform parity, unverified integration boundaries, avoidable build/release failures, and false completion claims. Prevention applies from requirement analysis through post-release verification under `AGENTS.md`; it is not limited to production bug fixes.

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

## INC-20260902-010: Pre-open WebRTC control suppressed reliable remote commands

- Detected: 2026-09-02.
- Severity: P1.
- Affected: Viewer remote input and system tools while the WebRTC control channel is connecting or unavailable.
- Status: source-verified-not-released.
- User-visible symptom: An online Agent could receive start-stream but show no screen, and system tools, keyboard, or mouse commands stopped reaching it.
- Minimal trigger: Open a remote session whose WebRTC control channel never reaches `open`, then invoke Task Manager, Services, or another reliable action.
- Root cause and contributors: `sendControl()` returned success after only adding an action to its pre-open local queue, so the Viewer marked the action local-only and suppressed the Firestore command fallback even when the channel later closed.
- Fix commit(s): pending.
- Permanent guard: The Viewer may suppress reliable fallback only when the transport reports that the ordered control channel is actually open and the send succeeds; lossy pointer movement remains non-backlogged.
- Regression proof: Focused transport tests prove readiness is false before open and after close/watchdog, and the connected-session source test requires the readiness gate before `sendControl()`.
- Release proof: not released.
- Remaining blocker: Package only when explicitly requested, then physically verify system tools and input on a TURN-required remote network.

## INC-20260902-011: Accumulated ICE candidates blocked repeated WebRTC connections

- Detected: 2026-09-02.
- Severity: P1.
- Affected: Viewer and Agent Firestore WebRTC candidate subscriptions after repeated reconnects in one session.
- Status: source-verified-not-released.
- User-visible symptom: The Agent remained online and accepted start-stream commands, but the remote screen never appeared and the realtime channel closed.
- Minimal trigger: Reconnect enough times for a session candidate subcollection to exceed the Firestore authorization read budget, then subscribe to the entire unbounded collection.
- Root cause and contributors: Both peers subscribed to every historical ICE candidate document and the Agent also performed an unbounded refresh; candidate documents intentionally persist across negotiations and accumulated until the live query was denied.
- Fix commit(s): pending.
- Permanent guard: Both peers read only the 20 newest candidate documents ordered by server creation time, while retaining negotiation-ID filtering before applying candidates.
- Regression proof: Focused Viewer and Agent signaling tests require the descending candidate query and its 20-document bound; live REST probing reproduced allowed 20-document reads and denied oversized reads on the affected session.
- Release proof: not released.
- Remaining blocker: Package only when explicitly requested, then reconnect the affected remote PC repeatedly and confirm screen plus command delivery.

## INC-20260902-012: Release packaging time varied unpredictably between builds

- Detected: 2026-09-02.
- Severity: P2.
- Affected: x86 Viewer and Agent installer packaging on the release workstation.
- Status: fixed-not-released.
- User-visible symptom: Equivalent release builds alternated between a few minutes and tens of minutes because the Viewer Rust shell was rebuilt even when no Rust or Tauri input changed.
- Minimal trigger: Run `npm run release:exes` after a web-only or Agent-resource-only change.
- Root cause and contributors: `package-release-exes.js` always invoked `tauri build`, which forces the full Tauri build pipeline before NSIS packaging.
- Fix commit(s): pending.
- Permanent guard: Persist a content hash of the Viewer Rust/Tauri build inputs beside the x86 binary. Reuse that binary only when the hash matches; missing, stale, or explicitly forced builds take the full path.
- Regression proof: `npm test -- --run scripts/package-release-exes.test.js` verifies matching and changed input-stamp behavior.
- Release proof: not released.
- Remaining blocker: The first build after this change needs one full build to create its trusted stamp; later web/resource-only builds use the fast path.

## INC-20260903-001: Modifier shortcuts were routed through text input or Viewer-only handlers

- Detected: 2026-09-03.
- Severity: P1.
- Affected: Viewer-to-Agent keyboard control, especially Shift+Enter, Shift punctuation, Ctrl+Shift+Esc, and Ctrl+Shift+V.
- Status: source-verified-not-released.
- User-visible symptom: Shift+Enter did not create a line break and other Shift-based shortcuts could be delayed, omitted, or interpreted as ordinary text.
- Minimal trigger: Hold Shift and press Enter or a punctuation key, or press Ctrl+Shift+Esc/Ctrl+Shift+V in an active remote session.
- Root cause and contributors: Shift-printable events were classified as local Unicode text, Viewer-specific Ctrl handlers ignored extra modifiers, character tokens lost the physical OEM key, and the native injector lacked those OEM/system VK mappings.
- Fix commit(s): pending.
- Permanent guard: Route modifier combinations through ordered physical key transitions, reserve Viewer-specific handling for exact plain Ctrl shortcuts, normalize modified punctuation from `KeyboardEvent.code`, and keep Viewer and native VK token tables covered together.
- Regression proof: Focused Viewer shortcut and key-normalization tests pass 27/27 with Shift+Enter, Ctrl+Shift+Esc, Ctrl+Shift+V, Alt+Tab, and punctuation cases. Native VK assertions are present; local Rust execution is blocked before tests by missing NASM for `turbojpeg-sys`.
- Release proof: not released.
- Remaining blocker: Build only when explicitly requested, then physically verify the shortcut matrix on a remote Windows PC; Ctrl+Alt+Delete remains a Windows secure-attention boundary and is not provided by `SendInput`.

## INC-20260903-002: Android Agent shipped without an end-to-end screen delivery contract

- Detected: 2026-09-03.
- Severity: P1.
- Affected: Android Agent WebRTC screen delivery, TURN-required networks, capture rotation/resizing, and first-frame startup.
- Status: source-verified-not-released.
- User-visible symptom: The Android Agent could register and start screen sharing while the Viewer received no remote image.
- Minimal trigger: Connect a Viewer to an Android Agent on a network requiring TURN, or open the data channels before a decodable keyframe is available.
- Root cause and contributors: Android support was treated as complete from packaging, registration, and permission checks without proving the full Viewer-to-Agent media path. The Android peer used only a public STUN server, had no post-open first-keyframe handshake, and did not rebuild capture resources after display changes.
- Fix commit(s): pending.
- Permanent guard: `CHANGE_CONTRACT.json` must contain one independently verified outcome for every user-requested result, including the outermost visible result and full vertical path. It cannot become verified when any outcome lacks a changed boundary test, fresh evidence, or an explicit physical gap. `AGENTS.md` forbids completion when a test could pass while the visible feature remains broken. The development gate validates the active worktree as well as every future commit, and CI runs it on every push, pull request, and release. Android screen delivery additionally requires dynamic TURN, post-open keyframe, capture-resize, and Windows compatibility guards.
- Regression proof: `npx vitest run src/desktopPackaging.test.ts -t "keeps Android screen delivery" src/firebase/viewerWebRtcTransport.test.ts -t "opens the transport" src/agent/agentCommandExecution.test.ts -t "buffers the first keyframe"`; Android `:agent:testDebugUnitTest :agent:compileDebugJavaWithJavac :controladdon:compileDebugJavaWithJavac` passed before registration of this incident.
- Release proof: not released.
- Remaining blocker: Build only when explicitly requested, then physically verify Android screen rendering on direct and TURN-required networks, rotation, reconnect, and session restart.

## INC-20260903-003: Android download contract was corrected only after publication work

- Detected: 2026-09-03.
- Severity: P2.
- Affected: Firebase Hosting Android Agent download route and packaged artifact format.
- Status: released-verified.
- User-visible symptom: The Android Agent download path exposed an APK-oriented flow when the approved distribution contract required a ZIP attachment.
- Minimal trigger: Open `/download/agent.apk` after publishing the Android Agent distribution.
- Root cause and contributors: The initial Android distribution was implemented before the required public artifact format and browser download behavior were fixed as an acceptance contract.
- Fix commit(s): `018aeecd`.
- Permanent guard: Android downloads are created by the single release script as ZIP files, Firebase routes the compatibility APK URL to the ZIP, and the desktop packaging contract checks the route, MIME/disposition configuration, generated path, and absence of a public raw APK.
- Regression proof: `npx vitest run src/desktopPackaging.test.ts -t "builds only native x86 payloads behind two stable downloads"` covers the committed ZIP route; current Android packaging changes retain and extend the same contract for Agent, Viewer, and control add-on archives.
- Release proof: Firebase Hosting deployment on 2026-09-03 returned HTTP 302 from `/download/agent.apk`, `/download/viewer.apk`, and `/download/control-addon.apk` to their ZIP files; all downloaded ZIP SHA-256 values matched the local signed artifacts.
- Remaining blocker: none.

## INC-20260903-004: Android Agent had no explicit full-service exit path

- Detected: 2026-09-03.
- Severity: P1.
- Affected: Android Agent foreground service, persistent notification, screen sharing, and unattended heartbeat.
- Status: released-physical-verification-required.
- User-visible symptom: Opening the Agent once left the ongoing `앱이 실행 중` notification indefinitely, with no way to stop the entire Agent from the app or notification.
- Minimal trigger: Register or reopen the Android Agent, close its Activity, and inspect the persistent foreground-service notification.
- Root cause and contributors: The Agent intentionally used a sticky foreground service for unattended access but exposed only `화면 공유 중지`; no action stopped the complete service. Late heartbeat callbacks could also update the notification after shutdown began.
- Fix commit(s): pending.
- Permanent guard: The app and notification share one explicit Agent-stop action. It marks shutdown before cleanup, cancels pending handler work, prevents late notification updates, closes WebRTC/capture through service destruction, marks the device offline, removes the foreground notification, and returns `START_NOT_STICKY` for the explicit stop command. The Android lifecycle contract test requires both entry points and the cleanup guards.
- Regression proof: `npx vitest run src/desktopPackaging.test.ts -t "Android full-display sharing|Firebase deployment"` passed 2 focused contracts; the Android release build compiled the Agent change and all Agent/Viewer/Control Add-On APKs passed v2 signature verification. The predeploy gate and Firebase production build passed.
- Release proof: Firebase Hosting deployment completed on 2026-09-03. Agent ZIP SHA-256 `8a3d1c47af6b20b04cda70cc4a4a5d061be80e58db21ad813c73eca5d30b58c3` matched the bytes downloaded from the live Agent route.
- Remaining blocker: Install the deployed Agent and verify both exit controls remove the process and notification until the user opens the app again.

## INC-20260904-001: Idle Viewer history polling exhausted shared Firestore read capacity

- Detected: 2026-09-04.
- Severity: P1.
- Affected: Shared Firestore project, Android Agent registration, and idle desktop/PWA Viewer history.
- Status: source-verified-not-released; production-quota-blocked.
- User-visible symptom: Reinstalled Android Agent reports RESOURCE_EXHAUSTED: Quota exceeded during registration.
- Minimal trigger: Register while the project's free Firestore read quota is exhausted. Leaving a Viewer open independently repeats history and full-device queries every three seconds, even without new sessions.
- Root cause and contributors: Production billing is disabled and the default database is freeTier. A read-only REST probe returned HTTP 429 RESOURCE_EXHAUSTED on 2026-09-04. Cloud Monitoring for the quota period starting 2026-09-03T07:00Z reported about 431,000 document reads and 13,500 writes (operational metrics, not an exact billing invoice). Viewer history polling is a confirmed unbounded read contributor, not proof of attribution of every measured read. Android surfaced the raw error and retried failed heartbeats every ten seconds. Request budgets and quota recovery were absent from feature acceptance.
- Fix commit(s): pending.
- Permanent guard: Firebase history uses one owner-scoped session subscription and existing device metadata, not repeated complete queries. Local mode retains its local-only polling; manual refresh reconnects a failed Firebase listener. Android identifies wrapped Firestore quota failures, explains registration is blocked without claiming success, and defers heartbeat/command reconnect attempts for five minutes. AGENTS.md now requires idle daily-request budgets and quota-recovery evidence for metered services.
- Regression proof: New history tests failed before implementation and passed after; 32 focused Viewer/API/security tests and TypeScript checks passed. Android quota tests passed 2/2 with real Firebase exceptions, test-only SparseArray/TextUtils JVM fixtures, and Agent Java compilation. Source wiring checks supplement runtime policy/subscription tests; they do not prove Android registration or Viewer behavior on a real device after quota recovery.
- Release proof: Not built or deployed this turn; previous downloads remain unchanged.
- Remaining blocker: External quota reset or user-authorized billing change, future requested release, and actual Android registration/recovery verification. Old installed Viewers must be closed or updated to stop their polling. Aggregate quota metrics do not prove all other fleet traffic fits a free plan.
- Development prevention follow-up: AGENTS.md now requires a necessity review before timers/effects/listeners/retries or writes, one request owner, nonoverlap, cleanup, bounded retries, and offline 24h request/document budgets. Every future commit must include Request-Review; every active change contract must classify request impact with a reason. Request-affecting contracts require declared fleet budgets, idle/rerender/concurrency/failure/cleanup evidence, and a changed boundary test. The gate rejects missing evidence and declared totals over limits, including on clean CI checkouts. Declared assumptions still require review; this does not certify unaudited existing paths.
- Development prevention proof: 2026-09-04 focused gate and history tests passed 16/16 after a RED/GREEN guard check. The history check covers 24h idle, quota failure without an automatic resubscribe loop, explicit retry, and 24h after unsubscribe. No production load test, build, deployment, or billing change was performed.
- Incomplete-budget follow-up (2026-09-04, not fixed): The initial daily estimate omitted security-rule reads and active-session traffic. `App.tsx` still polls chat, clipboard, files and all file receipts every 1.5s during a connected session, including inactive session panels. Four empty queries alone imply 9,600 document reads/hour plus up to 9,600 session-ownership rule reads/hour. Receipt documents are reread every tick, so retained receipts increase this cost further. Android device-dependent command/session/signal/candidate listeners can also trigger rule reevaluation on every heartbeat. Viewer WebRTC retries cap their delay at 15s but have no lifetime attempt limit. These paths are not covered by the history-only fix.
- Corrected planning example (not a measured bill or guaranteed upper bound): One Android Agent and one central Viewer online for 24h, one hour of normal WebRTC remote use, one initial negotiation plus three reconnects, six ICE candidates per side per negotiation, at most 200 history rows, no chat/clipboard changes or cloud-file receipts, diagnostic Firestore video fallback disabled. Without assuming security-rule cache discounts, base reads are 13,160/day, active-session polling adds 19,200/hour, and Android session-listener rule reevaluation allowance adds 900/hour. Reserving a separate 1,800 reads for signaling/reconnect/startup gives about 35,000 reads/day; 4,320 heartbeat writes plus negotiation/control allowances gives about 4,400 writes/day. The 1,800-read reserve is a planning allowance, not measured request evidence. Actual candidate counts, reconnects, file receipts, cache behavior, extra devices/Viewers and failures change the total. Screen/input and WebRTC file bytes are not Firestore document operations, but still consume network/TURN capacity. Full traffic validation and elimination of the remaining polling are outstanding.
- Manual-list follow-up (2026-09-04): User explicitly does not need live online status. Viewer now reads devices only on login and explicit refresh, removing the collection listener, local two-second polling and local five-second status aging. Cached offline/protocol values no longer block ordinary, secure or split requests before the backend checks the current target. Firebase list/target checks require server reads, not cache fallback; local API now rejects incompatible protocols too. Agent heartbeat and session/history traffic are unchanged. One Viewer with ten devices, one login, ten refreshes and ten direct opens has a scoped allowance of 130 reads/20 writes, not total daily fleet usage. Chromium UI and SDK-boundary tests verify explicit counts, 24h idle, rerender, concurrent clicks, quota/manual recovery and late responses after a new login. Focused tests: 56 passed; TypeScript passed. No build/deployment performed.

- Auxiliary-polling follow-up (2026-09-05): Removed connected Viewer's 1.5s chat/clipboard/file/all-receipt reads and the previously omitted Windows Agent's three 1.5s queue reads. Both Firebase paths use one change subscription per necessary queue with serialized acknowledgement; local peers use a held HTTP change request. Receipt listeners exist only for actual transfer IDs and stop at completion, failure or bounded timeout. Disabled Viewer clipboard autosync has no receive subscription. Local history now fetches only on mount/manual refresh. Required heartbeat, update checks, approval/RTC negotiation and legacy local capture/command transport remain; no claim of zero total traffic.
- Permanent auxiliary guard: Browser regression failed with four idle reads, then passed with zero recurring auxiliary reads after 24h. StrictMode exposed duplicate initial subscriptions and is now handled by deferred ownership. Shared SDK/local tests cover empty queues, slow handlers, duplicate events, quota errors without timer retries, terminal receipts and late/session-close cleanup. Essential heartbeat calls cannot overlap; background quota/auth/permission failures wait five minutes rather than looping. The existing 15-second command-retry source assertion was updated alongside runtime retry-policy tests.
- Auxiliary verification: 106 focused tests passed across session queues, Chromium Viewer lifecycle, real local HTTP chat/clipboard/file/receipt delivery, history, Viewer API, Agent command gate and file receiver; TypeScript passed. No build, deployment, production load test or billing change. Auxiliary request allowance includes initial empty queries, three reconnects and device-dependent security-rule reevaluations; it is explicitly scoped, not a whole-fleet daily total. Physical Windows/Android and live billing remain unverified; old installed clients retain the old behavior until updated.

- Refresh-only policy follow-up (2026-09-05): User explicitly removed initial list/history reads, automatic Viewer reconnect (including reboot recovery), and periodic Windows/Android heartbeats. Each list refresh requests one nonce-matched status response per manual-capable Agent, with a five-second listener deadline and abort/error cleanup. Expired commands are discarded; timeout only changes the returned UI snapshot, not persistent device status. Registration/startup/shutdown records, essential command reception and software updates remain event-driven or under their existing independent policies.
- Presence compatibility guard: Manual Agents advertise `presenceMode=manual`; local eligibility, Firestore rules and Functions do not require a periodically refreshed timestamp for that capability. Legacy freshness, ownership, stored offline and protocol checks remain. Matching rules/Functions must deploy before new Agent packages; never disable periodic heartbeats without updating every freshness-dependent connection path. Real emulator checks permit an authorized manual Agent with a years-old heartbeat while rejecting an unauthorized Viewer and a stale legacy Agent.
- Refresh-only proof: 129 focused tests across 11 files passed, including real Chromium login/24h-idle/manual-refresh/manual-reconnect, SDK subscription counts, real local HTTP presence, and AST-executed Windows watch/command paths. StrictMode initially exposed duplicate WebRTC startup; deferred ownership reduced one Connect from two starts to one. A raw-fetch replacement initially broke existing API error/argument contracts; reusing the existing request helper restored both tests. Android Java compilation and five unit tests passed; App/Functions TypeScript passed. Security emulator passed seven outcomes. No installer/APK build, deployment, production load test or billing change. Physical devices and aggregate billing remain unverified.
- Budget correction: Previous daily examples are historical, not current estimates. Current zero-idle regression budget covers only a mounted, already-authenticated Viewer with no refresh/connect actions. Actual manual refresh, Agent startup/listener recovery, rules, sessions and updates remain nonzero traffic. A scoped test count must never be presented as whole-fleet daily usage.

## INC-20260905-001: Read-only server tests packaged shared update fixtures on import

- Detected: 2026-09-05.
- Severity: P2 development reliability.
- Status: source-verified-not-released.
- Minimal trigger: Import the local API server in parallel presence/eligibility tests; module initialization generated ZIP fixtures through PowerShell in a shared temporary directory.
- Cause: Test mode initialized update artifacts eagerly, even for routes unrelated to updates. Parallel workers collided with EEXIST/ENOTEMPTY and did unnecessary packaging work.
- Permanent guard: Prepare fixtures only when an update-test route explicitly needs them; isolate default Vitest fixture paths by process/worker. Presence-boundary tests mock child-process execution to fail if a read/status refresh attempts packaging. Production and explicitly configured artifact paths retain their behavior.
- Proof: The 129-test focused run passed after removing the import side effect; local HTTP presence test asserts no packaging child process was invoked.
- Verification-tool follow-up: Cached Firestore emulator 1.21 requires Java21, not the installed Java17. Official JRE21 archive was hash-verified and unpacked only into workspace tooling. Emulator uses English locale to avoid its missing localized rules-error bundle. The rules verifier has a 30-second deadline to prevent SDK retries hanging verification, and stale-time seeding refuses to run outside an explicit emulator. Test processes were stopped after verification.
- Release proof: Not built or deployed. No user files removed or system Java settings changed.

## INC-20260905-002: Unchanged Agent update checks repeatedly rewrote device telemetry

- Detected: 2026-09-05.
- Severity: P1 quota efficiency.
- Status: source-verified-not-released.
- User-visible impact: Even after list/history polling and periodic heartbeats were removed, an idle Windows Agent still wrote `checking` and `healthy` update telemetry on every successful 15-minute check. Each device write could also trigger dependent security-rule reads for the live command listener.
- Root cause: Update progress persistence treated timestamps and transient checking as meaningful cloud state. The Agent watch scheduler also woke the throttled update function every minute instead of owning the requested interval directly.
- Fix: Default automatic checks are startup plus one hour. The scheduler itself uses that interval. `checking` stays process-local, and telemetry comparison excludes its timestamp; only an actual healthy/failure/progress/target transition writes Firestore. The Agent UI uses the existing signed native checker and installer through one explicit Update check button.
- Permanent guard: Execute the actual watch block for 24h and assert 24 scheduled calls with zero heartbeat calls. Execute the real telemetry setter and require transient plus unchanged success to produce no report while failure produces exactly one. Packaging contract requires the Agent native check command and existing Agent installer handoff.
- Regression proof: Agent policy/presence tests passed 9/9 and focused native-update packaging contract passed 1/1 after intended RED failures. TypeScript passed. No production requests were generated.
- Remaining risk: Installer build/deployment and physical button/hourly/updater verification were not requested. The startup presence write, command listener startup/rule reads, signed HTTP manifest checks, state changes, failures and actual remote actions remain nonzero traffic. Rust formatting remains globally red from pre-existing unrelated formatting differences; no mass formatting churn was applied.
- Release proof: Not built or deployed.

## INC-20260904-002: Adjacent Ctrl-paste source contract fails during device-list validation

- Detected: 2026-09-04.
- Severity: P2 verification gap.
- Affected: `aether-link-app/src/remoteSessionLayout.test.ts`, Ctrl-paste source-pattern assertion.
- Status: open; outside manual device-list change.
- Minimal trigger: Run `npx vitest run src/remoteSessionLayout.test.ts`; 20 pass and `keeps Ctrl shortcuts on the raw key down and key up path` fails at line 73 because its exact `event.ctrlKey && event.key.toLowerCase() === "v"` substring is absent.
- Cause evidence: The assertion depends on a particular handler implementation shape. This turn did not edit the keyboard handler. A failed source match alone does not establish a broken physical shortcut; runtime behavior still needs targeted investigation.
- Permanent guard: Pending a bounded follow-up reproducing paste at the input boundary; do not delete/weaken the assertion merely to make the wider suite green.
- Regression proof: Failure retained and reported, not counted among the 56 passing focused device-list tests.
- Release proof: No build/deployment in this turn.
- Remaining blocker: Determine whether the current handler or its source-based test is wrong, then add runtime keyboard evidence before fixing either.

## INC-20260905-003: Release contract drift blocked the v0.1.78 publication gate

- Detected: 2026-09-05.
- Severity: P1 release reliability.
- Affected: The v0.1.78 local release gate, GitHub release workflow, and post-deployment contract verification.
- Status: released-verified.
- User-visible symptom: PC and Android builds completed, but the CI-equivalent release contract would fail before publication or while recording live deployment proof.
- Minimal trigger: Run the predeploy gate after committing with unrelated untracked files present, or run the complete gate while only `CHANGE_CONTRACT.json` and `INCIDENT_REGISTRY.md` contain post-deployment evidence changes.
- Root cause and contributors: Two source assertions still named removed polling paths after the event-driven/manual-refresh change, the release workflow had lost its explicit `main` branch filter, both CI gates incorrectly required the post-deployment `verified` contract state from a predeployment release commit, and the gate treated unrelated untracked workspace files or proof-only metadata as the implementation boundary.
- Fix commit(s): `2e08a1d`, `c095052`.
- Permanent guard: Run the complete PC/Android packaging contract before every release commit. Anchor lifecycle assertions between current function boundaries, require stream exit to preserve the session-data subscription, reject automatic no-ID Agent ticks, require release builds to originate from gated `main` commits, route release commits through the predeploy contract stage in both CI jobs, validate only tracked or staged worktree files, and use committed boundaries only for a clean tree or exact post-deployment proof files.
- Regression proof: `npx vitest run src/desktopPackaging.test.ts src/mobileViewerPackaging.test.ts` passed 65/65 after failing 3/65 before the correction. `npx vitest run scripts/verify-recurrence-coverage.test.js` passed 14/14 and proves untracked files cannot replace committed boundaries, proof-only updates can complete the deployment contract, and real code changes remain scoped to current files. The signed release manifest and installer update E2E also passed.
- Release proof: Commit `2e08a1d` passed the predeploy gate from a clean tracked worktree, GitHub Actions run `33933165835` completed successfully, Release `v0.1.78` contains exactly the two PC installers and signed update manifest, all four PC aliases resolve to those assets, and the three Firebase Android routes match the locally verified ZIP bytes.
- Remaining blocker: Physical Windows installation/update and Android screen-consent/control checks remain separate device verification; the published PC installers are not Authenticode-signed.

## INC-20260905-004: Firebase deployment wrapper hid firebase-tools failure

- Detected: 2026-09-05.
- Severity: P1 deployment reliability.
- Affected: `aether-link-app/scripts/deploy-firebase.ps1` when firebase-tools rejects any deployment target.
- Status: source-verified-not-released.
- User-visible symptom: The deployment output printed a Firebase error while the wrapper process returned exit code 0, allowing automation to mistake a failed deployment for success.
- Minimal trigger: Run the full deployment against `wonremote-a7fd3` while Firebase Storage is not initialized; firebase-tools exits nonzero but the PowerShell wrapper previously completed normally.
- Root cause and contributors: PowerShell does not throw when an external executable returns nonzero. The wrapper invoked firebase-tools inside `try/finally` but never checked `$LASTEXITCODE`, and the successful `Pop-Location` became the script's final operation.
- Fix commit(s): pending local fix.
- Permanent guard: Check `$LASTEXITCODE` immediately after firebase-tools returns, throw with the original code, and keep a packaging contract assertion on that exact process boundary.
- Regression proof: `npx vitest run src/desktopPackaging.test.ts -t "deploys Firebase functions, rules, and hosting only behind an explicit gate"` passed 1 focused test with 63 unrelated tests skipped. A real `-SparkOnly` call reproduced the Storage setup failure and the corrected wrapper returned exit code 1.
- Release proof: not released.
- Remaining blocker: Firebase Storage still requires console initialization, and Functions deployment requires the Blaze plan; neither external project change is made by this source fix.

## INC-20260905-005: Authenticated Viewer started with an empty device list

- Detected: 2026-09-05.
- Severity: P1 usability.
- Affected: Desktop Viewer and shared mobile Viewer UI after startup or login.
- Status: source-verified-not-released.
- User-visible symptom: A valid authenticated Viewer displays zero registered devices until the user manually presses device refresh.
- Root cause: The prior quota reduction removed the authenticated-session device load together with idle polling, and its Chromium contract explicitly treated zero startup reads as correct. This confused one required first-use read with prohibited recurring reads.
- Permanent guard: Each authenticated Viewer session owns exactly one bounded startup device/status refresh. StrictMode, rerenders, idle time, and repeated auth callbacks cannot duplicate it; history and failed-session reconnect remain manual. Logout cancels stale work and permits one new refresh for the next authenticated session.
- Regression proof: The focused real-Chromium case failed before the source change because `PC-0` never appeared within three seconds. After the fix, `npx vitest run src/viewerDeviceRefresh.test.ts` passed 8/8, covering restored Firebase auth, local login, repeated auth callbacks, StrictMode, 24h idle, manual history/reconnect, slow-click coalescing, quota failure, logout cancellation, and reauthentication.
- Release proof: Not built or deployed; user did not request a build.
- Remaining blocker: Installed desktop/mobile packages and live Firebase document/rule billing require a later requested build/deployment and physical verification.

## INC-20260905-006: Existing Android Viewer shells could retain an old hosted UI

- Detected: 2026-09-05.
- Severity: P1 update reliability.
- Affected: Existing Android Viewer APKs loading the shared `/viewer` route.
- Status: released-physical-verification-required.
- User-visible symptom: Relaunching an already installed Viewer could keep the previous hosted UI for up to one hour after deployment.
- Minimal trigger: Deploy a new shared Viewer UI, then relaunch an already installed Android Viewer within the previous one-hour cache lifetime.
- Root cause and contributors: The Android shell correctly used the shared web Viewer, but Firebase Hosting served its navigation document with `Cache-Control: max-age=3600`; release checks verified asset bytes without checking the launch document's live cache policy.
- Fix commit(s): `e183216`.
- Permanent guard: `/viewer` must use `no-cache, no-store, must-revalidate`. The mobile packaging contract pins that header, and every Android web-UI deployment must verify the live response header and a release-specific UI marker before completion.
- Regression proof: `npx vitest run src/mobileViewerPackaging.test.ts` passed 1/1 and requires the exact `/viewer` no-cache policy. After redeployment, the live route returned HTTP 200 with `Cache-Control: no-store, must-revalidate, no-cache` and the v0.1.79 multi-session UI marker.
- Release proof: Firebase Hosting redeployment completed on 2026-09-05; the live `/viewer` response no longer advertises the previous one-hour freshness lifetime.
- Remaining blocker: Physically relaunch an already installed Android Viewer and confirm the deployed UI appears. Native APK replacement still requires Android installation approval or managed-device privileges.

## INC-20260905-007: Deploy-only commits could not pass the main-branch CI gate

- Detected: 2026-09-05.
- Severity: P1 deployment reliability.
- Affected: Main-branch Hosting, rules, and other deploy-only changes that require live verification before the contract can become verified.
- Status: released-verified.
- User-visible symptom: A correctly predeploy-verified Hosting fix produced a red CI check even though the deployment and live verification succeeded.
- Minimal trigger: Push a non-version commit with `CHANGE_CONTRACT.json` set to `ready-to-deploy` and `releaseImpact` set to `deploy`.
- Root cause and contributors: The workflow selected the predeploy gate only when the commit subject began with `Prepare WonRemote v`; every other push ran the completed-state gate, creating an impossible requirement to record live proof before deployment.
- Fix commit(s): `73e4243`.
- Permanent guard: Main pushes select the predeploy gate from the committed contract's `ready-to-deploy` status and `deploy` or `build-and-deploy` impact. Nondeployment and proof-only pushes continue to require `verified`. The packaging contract pins both branches.
- Regression proof: `npx vitest run src/desktopPackaging.test.ts -t "builds releases from gated main commits so release caches remain reusable"` passed 1/1 and pins the contract-based stage selector separately from the version-release build condition.
- Release proof: GitHub Actions run `33949370940` completed successfully on commit `73e4243`, proving the corrected selector parses and preserves the completed-contract path.
- Remaining blocker: The next real deploy-only push will provide the first live execution of the predeploy branch; its contract selection is covered by the focused workflow test.

## INC-20260906-003: Android APK publication was mistaken for installed-app updates

- Detected: 2026-09-06.
- Severity: P1 update delivery omission.
- Affected: Android Agent, Viewer and Control Add-On 0.1.79 and 0.1.80.
- Status: released-physical-pending.
- User-visible symptom: All three apps stay on 0.1.79 after 0.1.80 publication and show no update prompt on launch.
- Minimal trigger: Launch any installed 0.1.79 APK after publishing the newer ZIP.
- Root cause and contributors: None of the three native apps implemented APK version checking, download or installer invocation. Release verification checked static ZIP availability and confused Viewer web content updates with APK upgrades.
- Fix commit(s): `1a673ca`, `8795256`.
- Permanent guard: Share one APK updater across all three activities; generate version/package/hash metadata from built APKs and validate release bundles. Verify old installed APK to new signed APK installation, not merely HTTP availability. Versions without the updater explicitly require one manual bootstrap.
- Regression proof: :updatecore:testDebugUnitTest passed 6 request/download tests; npx vitest run src/androidUpdateRelease.test.ts passed 8 release metadata/integration tests, including real ZIP extraction matching the APK and stale-archive rejection. All three apps compiled. Actual Android install/permissions/data-retention proof is pending; adb devices listed no device.
- Release proof: GitHub Actions run 33984013681 published v0.1.82 with two signed x86 installers and manifest. Firebase Hosting returned 200 for all three v0.1.82 Android ZIPs, and android-update.json reports versionCode 1082 with the published hashes.
- Remaining blocker: Physical signed upgrade on Android, user installation consent and preservation of registration/accessibility settings.

## INC-20260906-002: Normal Firebase deploy required unavailable Functions infrastructure

- Detected: 2026-09-06.
- Severity: P1 release-blocking.
- Affected: Normal `npm run firebase:deploy` path after Hosting/Firestore preparation.
- Status: released-verified.
- User-visible symptom: A requested static release could not reach Hosting because the command attempted a Functions deploy requiring Cloud Build and Artifact Registry on a Spark project.
- Minimal trigger: Run the normal deploy command on a Spark project where the release contains no Functions changes.
- Root cause and contributors: The script treated Functions as a default deployment target even though Functions need Blaze billing and are unrelated to static Viewer/Android download publication.
- Fix commit(s): `358ad42`.
- Permanent guard: Default to Firestore rules and Hosting only; Functions deployment requires explicit `-IncludeFunctions` after Cloud Build and Artifact Registry are available. The packaging test pins both target selections.
- Regression proof: `npx vitest run src/desktopPackaging.test.ts -t "deploy"` passed 2/2.
- Release proof: `npm run firebase:deploy` completed with Firestore rules and Hosting; Android ZIP routes returned their expected redirects and `agent.zip` returned 200.
- Remaining blocker: Firebase Functions require Blaze/Cloud Build and remain intentionally excluded until explicitly enabled with `-IncludeFunctions`.

## INC-20260906-001: Normal Firebase deploy required an uninitialized Storage service

- Detected: 2026-09-06.
- Severity: P1 release-blocking.
- Affected: Normal `npm run firebase:deploy` path and Hosting deployment of Android ZIP downloads.
- Status: released-verified.
- User-visible symptom: A requested release built successfully but Firebase deployment stopped before Hosting updated because the project has not initialized Firebase Storage.
- Minimal trigger: Run the normal deploy command in a project with `storage.rules` configured but no initialized Firebase Storage bucket.
- Root cause and contributors: The deploy script included `storage` by default even though static APK ZIP delivery uses Hosting and the Storage-backed 500MB transfer feature is not provisioned.
- Fix commit(s): `d873f62`.
- Permanent guard: Default to `firestore:rules,hosting`; Storage rules deploy requires an explicit `-IncludeStorage` after the Storage service is initialized. The packaging test pins both target selections.
- Regression proof: `npx vitest run src/desktopPackaging.test.ts -t "deploy"` passed 2/2.
- Release proof: `npm run firebase:deploy` completed with Firestore rules and Hosting; the public Android ZIP routes returned their expected redirect or 200 responses.
- Remaining blocker: Firebase Storage-backed 500MB transfer remains unavailable until Storage is initialized and deployment is explicitly run with `-IncludeStorage`.

## INC-20260907-002: Device-list display waited for offline presence timeout

- Detected: 2026-09-07.
- Severity: P2 startup latency.
- Affected: Firebase Viewer startup and manual refresh on PC, web and Android Viewer.
- Status: source fixed; authenticated visual verification pending.
- User-visible symptom: Registered devices remain hidden until an offline Agent's five-second response timeout expires.
- Minimal trigger: Refresh a list containing one unavailable manual-presence device.
- Root cause and contributors: App setDevices only ran after the promise joining list fetch and all presence responses resolved.
- Fix commit(s): uncommitted.
- Permanent guard: Publish the loaded list and each validated presence response through the existing request lifecycle; keep cancellation guards and final timeout result.
- Regression proof: devicePresenceRefresh.test.ts passed 6 tests, including initial and incremental callbacks before timeout, late replies, timeout finalization and no repeated requests across 24h.
- Release proof: Not built or deployed in this task.
- Remaining blocker: Authenticated UI rendering and installed startup confirmation. Local HTTP mode is unchanged.

## INC-20260907-001: Android session end left screen sharing active

- Detected: 2026-09-07.
- Severity: P2 remote-session cleanup failure.
- Affected: Android Agent sessions closed from Viewer or by the session state listener.
- Status: fixed-in-source; physical verification pending.
- User-visible symptom: Viewer session ends while Android's screen-sharing indicator and capture remain active.
- Minimal trigger: End the active Viewer session after Android screen sharing is approved.
- Root cause and contributors: finishRemoteSession only released the remote transport and wake lock because prior behavior intentionally preserved projection for reconnect. The requested behavior requires explicit MediaProjection shutdown on both session-end paths.
- Fix commit(s): `1ff6511`.
- Permanent guard: Route both current named stop-stream commands and session-closed callbacks through endProjection; preserve current-session matching and require fresh consent on the next connection.
- Regression proof: AgentProjectionRequestTest covers current, stale, duplicate stop guards and new-consent state. The instrumentation shutdown-delegation source compiles with the Android test source set.
- Release proof: v0.1.87 Android Agent, Viewer and Control Add-On passed signed APK and JNI checks; Firebase Hosting serves versionCode 1087 and all three ZIPs return HTTP 200. GitHub Release v0.1.87 is public with exactly two x86 installers and signed update manifest; uploaded byte sizes match local artifacts.
- Remaining blocker: Verify sharing indicator disappearance, repeated reconnect approval and stale-command isolation on physical Android.

## INC-20260906-007: Session-end instrumentation test lacked its test dependency

- Detected: 2026-09-06.
- Severity: P3 development verification failure.
- Affected: Android Agent instrumentation tests only.
- Status: corrected; device execution pending.
- User-visible symptom: Verification of automatic screen-share shutdown could not compile.
- Minimal trigger: Compile the new Android instrumentation test.
- Root cause and contributors: JVM testImplementation does not supply androidTestImplementation; assumed JUnit was available to both source sets.
- Fix commit(s): uncommitted.
- Permanent guard: Declare the existing JUnit version for androidTest and compile the actual instrumentation source set before reporting test availability.
- Regression proof: Initial compile failed on missing junit.framework; corrected source-set dependency and rerun recorded in CHANGE_CONTRACT.json.
- Release proof: No build or deployment requested for this change.
- Remaining blocker: Execute session closure test and verify sharing indicator on an Android device.

## INC-20260906-006: Android signaling trimmed the SDP line terminator

- Detected: 2026-09-06.
- Severity: P1 remote-access failure.
- Affected: Android Agent on all supported ABIs receiving PC or mobile Viewer offers.
- Status: fixed-in-source; physical verification pending.
- User-visible symptom: Android receives the Viewer request and screen-share approval, but Viewer disconnects before any remote screen appears.
- Minimal trigger: Start an Android remote session where the final SDP line terminator reaches Agent offer extraction.
- Root cause and contributors: The generic string accessor trims offer.sdp, removing its final CRLF. Native libwebrtc GetLine requires a newline and rejects an unterminated SDP line. Physical 0.1.85 log records remote-offer apply failure; its diagnostics omit the native reason, so further device-specific failures remain possible.
- Fix commit(s): `1b79c5d`.
- Permanent guard: Preserve the protocol payload verbatim in a dedicated offer accessor; regression exercises actual offer extraction for CRLF/LF and repeated connections. Do not apply UI whitespace normalization to wire protocols.
- Regression proof: RemoteSessionDiagnosticsTest failed 1/3 before fix at SDP byte comparison; after fix, it and AgentProjectionRequestTest passed 7 tests via gradlew :agent:testDebugUnitTest --tests com.wonremote.agent.RemoteSessionDiagnosticsTest --tests com.wonremote.agent.AgentProjectionRequestTest --build-cache --console=plain (4s). Native parser source https://webrtc.googlesource.com/src/+/4c122cc0b237bf3ed5bd1c423d3c3ca626522bc3/api/webrtc_sdp.cc GetLine corroborates the newline requirement. This is payload-boundary proof, not a device screen-success claim.
- Release proof: v0.1.86 signed Android Agent, Viewer and Control Add-On APKs passed JNI and signature checks; their update metadata is live on Firebase Hosting with all three ZIP routes returning HTTP 200. GitHub Release v0.1.86 is published with exactly two x86 installers and signed update manifest; uploaded sizes match local artifacts.
- Remaining blocker: No ADB device attached. Verify affected Android/PC first frame, reconnect, denial/recovery, and TURN-dependent network before calling the screen issue resolved.

## INC-20260906-005: Android first-frame failure had no negotiation diagnostics

- Detected: 2026-09-06.
- Severity: P1 remote screen unavailable.
- Status: investigating; first-frame delivery not verified.
- Affected: Android Agent arm64/armv7, PC Viewer signaling and relay dependency.
- Evidence: WonRemote-Android-Log-20260906-055742.zip records capture initialization at 05:57:50.998, but no first-frame delivery. getRtcConfiguration returns NOT_FOUND at 05:57:49.524. This proves a failed relay configuration lookup, not the sole cause of disconnect.
- User-visible symptom: PC Viewer remains connecting and disconnects after Android sharing approval without displaying the screen.
- Minimal trigger: Connect from PC Viewer to the reported Android 16 Agent, then approve screen sharing.
- Root cause and contributors: The screen-failure root cause is not yet established. SDP failures and ICE state callbacks were empty; signaling write/listener failures were ignored. Prior checks could pass with no actual PC Viewer frame.
- Fix commit(s): Uncommitted diagnostic changes; screen fix remains incomplete.
- Permanent guard: Record existing negotiation, candidate, channel and signaling outcomes locally without SDP, ICE addresses, credentials or added cloud writes. Exercise SDP failure callbacks in a focused runtime test. Require physical first-frame and reconnect proof before declaring the incident resolved.
- Regression proof: `gradlew :agent:testDebugUnitTest --tests com.wonremote.agent.RemoteSessionDiagnosticsTest --tests com.wonremote.agent.AgentProjectionRequestTest --build-cache --console=plain` passed 6/6 in 5s, including SDP failure stage reporting without private SDP and no false errors on success. This is diagnostic proof, not first-frame proof.
- Release proof: v0.1.85 Android Agent, Viewer and Control Add-On builds passed JNI/signature/manifest verification; Firebase Hosting returns 0.1.85 for every Android product and HTTP 200 for every Android ZIP. GitHub Release v0.1.85 contains the two verified x86 installers and signed update manifest.
- External blocker: No alternate TURN configuration was found in application env or process/user/machine RTC variables. Provisioning and verifying an authenticated relay is separate from adding diagnostic logs; no billing or infrastructure changes authorized or performed.
- Remaining blocker: Approved first frame on the reported Android 16 device, same and separate networks, disconnect and repeat connection. Obtain ICE and SDP diagnostic evidence before attributing the disconnect exclusively to TURN.

## INC-20260906-004: Optimized Android Agent lost WebRTC JNI entry points

- Detected: 2026-09-06.
- Severity: P1 connection-triggered application termination.
- Affected: Android Agent arm64/armv7 release and shared Add-On command validation.
- Status: released; physical device validation pending.
- User-visible symptom: PC Viewer connection request terminates the background Android Agent with the system app-bug/cache-clear dialog.
- Minimal trigger: Connect from PC Viewer to the optimized release Agent while it is waiting in the background; remoteController initializes WebRTC native code.
- Root cause and contributors: Agent release enabled R8 without WebRTC JNI keep rules. Existing release mapping removes ContextUtils and renames IceServer and native callback targets. Debug Java tests do not load the optimized native boundary. String.isBlank calls also exceed the minimum Android API without core library desugaring.
- Fix commit(s): `8b6d234`.
- Permanent guard: Preserve the WebRTC JNI package and reject missing or renamed JNI release mappings before APK copying or publication; use API26-compatible command validation.
- Diagnostic guard: ADB capture script clears prior logs and packages both connection attempts with Agent package state, so a device-specific native crash has a recoverable record before another code change.
- Diagnostic availability guard: When a separate test PC has no ADB, the collector acquires the official Platform-Tools ZIP once and reuses the extracted binary; it does not retry or poll.
- Diagnostic launcher guard: The CMD launcher deletes any temporary collector before every manual run, retrieves the current collector, and stops visibly on download failure instead of running stale diagnostics.
- Diagnostic device guard: Device parsing first checks for an authorized serial and reports unauthorized or absent USB debugging without calling methods on a missing value.
- Physical-log correction: Android 16 arm64 v0.1.83 logcat proved `org.jni_zero.JniInit` was removed despite `org.webrtc` keep rules; preserve `org.jni_zero.**` and require JniInit in release mapping verification.
- Regression proof: 4 native artifact-verifier tests passed; existing broken release mapping is rejected. Focused ControlAddonClient test and Add-On compilation passed. Signed Android release build verified preserved JNI mapping and all three APK signatures.
- Release proof: Android Agent, Viewer and Control Add-On v0.1.83 ZIPs and android-update.json versionCode 1083 deployed to Hosting. GitHub Actions run `33985944437` succeeded and released signed x86 Viewer and Agent installers plus updater manifest.
- Correction release proof: v0.1.84 Android ZIPs and android-update.json versionCode 1084 are live on Firebase Hosting. GitHub Release v0.1.84 contains the two x86 installers and signed manifest; every uploaded byte size matches the local artifact.
- Remaining blocker: Signed optimized APK on the affected physical device: background request, permission denial/approval, first frame, reconnect, and logcat.

## INC-20260905-008: Android remote request failed to preserve or request screen sharing

- Detected: 2026-09-05.
- Severity: P1 remote-access failure.
- Affected: Android Agent Viewer-request consent, prepared MediaProjection, and remote-session replacement or cleanup.
- Status: released-physical-pending.
- User-visible symptom: Viewer Connect did not surface the Android screen-share consent flow; after manual sharing began, Connect turned off Android's red screen-sharing indicator and no remote screen appeared.
- Minimal trigger: Start Android screen sharing manually, then connect from Viewer while a stale stop command or a late closed-session callback can still be delivered.
- Root cause and contributors: Viewer requests created only a notification even when the Agent activity was visible. Android handled every `stop-stream` without validating its session ID, treated remote-session closure as projection closure, and allowed removed listeners to act on a replacement session.
- Fix commit(s): `0172aac`.
- Permanent guard: Separate remote-session teardown from explicit MediaProjection teardown, require stop commands and asynchronous callbacks to match the current session, launch consent through a visible Agent or an enabled accessibility control service, and retain the policy-compliant high-priority notification fallback.
- Regression proof: `gradlew :agent:testDebugUnitTest --tests com.wonremote.agent.AgentProjectionRequestTest :controladdon:compileDebugJavaWithJavac --build-cache` passed 4/4 focused tests and compiled all changed Android modules; `npx vitest run src/desktopPackaging.test.ts -t "requests Android screen-share consent only after an explicit Viewer request"` passed 1/1.
- Release proof: GitHub Actions run `33981740879` completed successfully for `v0.1.80` and published the two signed x86 installers plus update manifest. The Android signed Agent, Viewer, and Control Add-On ZIPs were rebuilt locally and published through Firebase Hosting. Firebase BOM 33.16.0 resolved the Android lint compatibility failure.
- Remaining blocker: Physically verify background consent launch, notification fallback, red-indicator persistence, and first-frame delivery on Android.
## INC-20260907-005: Automatic model names duplicated and custom desktop names lacked ownership

- Cause: Automatically reported manufacturer/model text can repeat the same name; an editable raw desktopName would be overwritten by subsequent Agent reports.
- Permanent guard: Normalize repeated automatic name sequences at the device mapping boundary; keep a separate Viewer-owned desktopNameOverride across first-run merges and heartbeat updates. Never normalize explicit custom names.
- Proof: deviceOrganization, firestoreDevice and viewerDeviceMetadata runtime tests cover automatic duplicates, custom persistence and metadata write counts. verify-device-organization-ui.mjs exercises the actual React edit and drag flow without production traffic.
- Remaining verification: Installed Agent refresh and deployed Firestore override permissions. Emulator could not start with the available Java below 21; do not treat mocked database tests as permission proof.
## INC-20260907-006: Desktop installer embedded Android distribution archives

- Detected: 2026-09-07.
- Severity: P2 installer size and bandwidth waste.
- Affected: PC Viewer and Agent x86 packaging; shared Firebase Hosting build output.
- Status: build-verified-deployment-blocked.
- User-visible symptom: PC installers grew to 99.22 MiB while unrelated Android archives occupied 90.92 MiB in the frontend build.
- Minimal trigger: Build Android Hosting downloads, then build a Tauri desktop installer using the same dist directory.
- Root cause and contributors: Tauri frontendDist included the entire web Hosting output. Binary reuse fingerprint also omitted embedded frontend source changes.
- Fix commit(s): pending.
- Permanent guard: Separate generated dist-desktop excluding download; keep Hosting dist untouched. Fingerprint frontend inputs so stale embedded UI cannot be reused.
- Regression proof: npx vitest run src/desktopAssets.test.js covers Hosting preservation, repeated preparation and changed frontend cache invalidation. Initial TS test imported untyped build scripts and failed tsc; use a JavaScript build-tool test without weakening application type checking, and require tsc before packaging retry.
- Remaining blocker: Deployment withheld because the earlier taskbar-input outcome lacks required proof; live deployment verification pending. Both x86 installers built at 19.30 MiB with verified extracted payload hashes, down from 99.22 MiB; all 25 Hosting download files preserved byte-for-byte.
## INC-20260908-003: Remote paste overwrote the remote clipboard

- Detected: 2026-09-08.
- Severity: P1 functional correctness.
- Affected: Viewer remote keyboard and clipboard transfer.
- Status: automated-verified; deployment pending.
- User-visible symptom: Ctrl+V could overwrite the remote clipboard with the Viewer PC clipboard, and automatic synchronization could move clipboard data without an explicit action.
- Minimal trigger: Connect a Viewer, copy text locally, then press Ctrl+V or leave automatic clipboard synchronization enabled.
- Root cause and contributors: Viewer intercepted Ctrl+V to read and send its local clipboard. The saved automatic-sync preference also started an unbounded 1.5-second clipboard polling loop.
- Fix commit(s): pending.
- Permanent guard: Route Ctrl+C/V as tracked remote keyboard events only. Remove automatic clipboard polling and incoming writes. Explicit directional controls have session lifetime and duplicate-transfer guards.
- Regression proof: npx tsx scripts/verify-session-clipboard.test.mjs executes the actual handlers: it proves Ctrl+C/V never reads/transfers the local clipboard, manual transfer sends once, duplicates are blocked, late reads are discarded and permission failure releases the lock.
- Release proof: Pending x86 build, installer payload verification and published-release byte verification.
- Remaining blocker: Verify installed Viewer-to-Agent text/image copy and paste on two PCs after deployment.

## INC-20260907-007: Remote update integration verification prerequisites

- Detected: 2026-09-07.
- Severity: P2 development validation gap.
- Affected: Viewer remote update action and PC/Android Agent command integration.
- Status: automated-partial-physical-pending.
- User-visible symptom: New remote-update controls could otherwise be reported ready without compiling the platform integrations.
- Minimal trigger: Compile a new icon/import or run Android tests with missing SDK environment and uncached dependencies.
- Root cause and contributors: Initial integration used an unimported icon and an incorrectly typed Firebase environment; Android SDK path was not configured in the shell and offline dependencies were incomplete.
- Fix commit(s): pending.
- Permanent guard: TypeScript check and Android Agent/updatecore compilation before readiness claims; resolve the existing SDK path before running tests. Receiver policies reject duplicate/expired commands, defer active sessions and cancel pending PC work on shutdown. Sending a command is never installation success.
- Regression proof: TypeScript passed; focused Node tests 8 passed, Android RemoteUpdateRequestTest passed, actual Viewer button sent one request for two clicks in Playwright. Existing signed PC installer and Android package signer/version checks remain in the update path.
- Remaining blocker: Installed end-to-end update/consent/restart and combined cloud request accounting; do not deploy based only on request delivery tests.

### 2026-09-09 correction: PIN-screen diagnosis

- User-observed fact: the running Agent remains reachable and mouse input advances the lock screen to the PIN screen; only the resulting PIN desktop is not visible.
- Corrected cause: the ordinary user/elevated capture child loses DXGI access when Windows switches to the protected credential desktop. Agent startup absence was an incorrect diagnosis for this reproduction.
- Permanent guard: secure-screen capture must run as a capture-only SYSTEM worker in the active console session from a machine-protected executable. The network/authenticated Agent remains the only cloud owner, and the privileged broker must not accept input injection.
- Required proof: automated broker mode/argument/installation-path tests plus an installed Windows lock-screen-to-PIN physical test. Source inspection alone cannot close this incident.

## INC-20260909-008: Secure capture state could remain stuck after unlock

- Detected: 2026-09-09.
- Severity: P1 remote-screen continuity.
- Affected: Windows Agent capture while moving from the protected PIN desktop back to the normal user desktop.
- Status: automated regression verified; packaged physical verification pending.
- User-visible symptom: PIN capture can start, but a same-session capture restart can keep selecting the protected worker after Windows returns to the normal desktop.
- Root cause and contributors: The first implementation had only a normal-to-secure marker and retained secure mode until the entire remote session changed. It did not distinguish access loss from a worker already attached to Winlogon.
- Permanent guard: Emit distinct normal-to-secure and secure-to-normal transition events, preserve the state only across matching worker restarts, and test both directions plus new-session reset.
- Regression proof: capture state tests cover normal-to-secure, secure-to-normal, retained state and new-session reset; x86 release-profile Rust tests passed 43/43 and TypeScript passed.
- Required proof: an installed lock-PIN-unlock stream test remains mandatory.

## INC-20260909-009: Protected install-path change would break the deployed updater handoff

- Detected: 2026-09-09.
- Severity: P1 automatic-update continuity.
- Affected: Existing v0.1.88 Agent installations under `%LOCALAPPDATA%\WonRemote\Agent` updating to the secure-capture release.
- Status: automated regression verified; installed migration and rollback verification pending.
- User-visible symptom: A per-machine installer can start the new Agent under Program Files while the deployed handoff checks only the old path, then report failure or restore the old runtime.
- Root cause and contributors: The initial security fix changed the installation root without tracing the already-deployed handoff script that performs path-scoped process health checks.
- Permanent guard: Keep the privileged runtime under Program Files. Do not place a highest-privilege task behind a user-writable parent and do not mask old-updater health with a fake process or path redirect. Block release until a backward-compatible one-time migration has explicit rollback and installed v0.1.88-to-next-version proof.
- Regression proof: The focused Viewer/Agent suite passed 86/86, including actual helper execution for handoff lock ownership, protected runtime and broker health, one-time limited bridge, exact legacy cleanup, fast task completion and rollback-preserving failure.
- Required proof: migration branch tests plus an installed v0.1.88-to-next-version update that proves protected runtime health, old-runtime cleanup and rollback. Source-only PIN tests cannot satisfy this boundary.

## INC-20260909-010: Android notification assertion inspected an unrelated method

- Detected: 2026-09-09.
- Severity: Low (test-only false failure; no product behavior changed).
- Affected: desktop packaging regression suite.
- Status: automated regression verified.
- Root cause and contributors: The screen-share consent test rejected `.setAutoCancel(true)` across the entire Android service, so the separate update notification caused a false failure.
- Permanent guard: Source-contract assertions for one behavior must isolate that method or branch before checking forbidden tokens.
- Regression proof: the complete desktop packaging and Agent startup test files pass after scoping the assertion to `showProjectionRequest`.
- Release proof: not applicable; no product build or deployment requested.

## INC-20260909-011: Secure-capture task resolved a nonexistent packaged resource directory

- Detected: 2026-09-09.
- Severity: P1 protected-screen capture unavailable after install.
- Affected: Windows Agent first launch, scheduled secure-capture broker and PIN-screen streaming.
- Status: automated regression verified; packaged physical verification pending.
- User-visible symptom: The Agent can remain reachable at the PIN screen while the Viewer receives no protected-desktop pixels because the broker task is never validly registered.
- Root cause and contributors: The task helper assumed Tauri resources were under `resources\\bin`, while the generated NSIS installer and the installed v0.1.88 layout place them directly under `bin`, `runtime` and `agent`. Source-only tests repeated the same incorrect path and therefore passed without checking the generated installer layout.
- Permanent guard: Resolve task resources from the actual Tauri resource root next to the installed executable, and make packaging tests compare helper paths with generated NSIS resource destinations. Installed PIN-screen proof remains mandatory.
- Regression proof: The focused packaging and startup suite passed 86/86 using the actual installer-layout resource paths and helper branches.
- Required proof: Execute the real helper against an installer-layout fixture, build only when requested, then verify the installed SYSTEM broker path and a lock-to-PIN-to-unlock stream on Windows.

## INC-20260909-012: Secure capture worker inherited handles across Windows sessions

- Detected: 2026-09-09.
- Severity: P1 PIN-screen stream failure.
- Affected: Windows SYSTEM broker to active-console Winlogon capture worker transport.
- Status: automated regression verified; packaged physical verification pending.
- User-visible symptom: The normal lock screen remains reachable, but entering the protected PIN desktop can leave Viewer without frames even when the secure worker process starts.
- Root cause and contributors: The broker runs in session 0 and launches the Winlogon worker in the active console session while passing anonymous stdin/stdout handles with `bInheritHandles=true`. Windows explicitly forbids handle inheritance across Terminal Services sessions, so the transport was invalid at the exact boundary the feature needed. Earlier tests checked modes, ACLs and process placement but did not verify the operating-system session transport contract.
- Permanent guard: Use a unique local named pipe for each worker, allow only LocalSystem on the worker pipe, verify both peer executable and process identity, set `bInheritHandles=false`, and keep the privileged channel capture-only. Cross-session native designs must be checked against official API restrictions before implementation.
- Regression proof: x86 release-profile Rust tests passed 43/43, including actual duplex named-pipe I/O, strict pipe names and peer rules, bounded capture-only protocol, and a launch contract that forbids inherited handles.
- Required proof: Rust protocol/argument/identity tests, x86 compilation, and an installed lock-screen-to-PIN-to-unlock test after a user-requested build.

## INC-20260909-013: PowerShell fixture could report success after failing to load helper functions

- Detected: 2026-09-09.
- Severity: P2 test reliability.
- Affected: Agent migration task completion and stale uninstall-entry tests.
- Status: corrected; focused regression verified.
- Root cause and contributors: A test dot-sourced the helper prefix without its mandatory `Mode` argument, while non-terminating PowerShell errors left exit code 0. One assertion could therefore pass even though the target function never loaded.
- Permanent guard: PowerShell execution fixtures set `$ErrorActionPreference='Stop'`, pass mandatory parameters, and assert an observable result produced only by the loaded production function.
- Regression proof: `npx vitest run src/agentStartup.test.ts` passed 13/13 after the corrected fixtures executed the real helper functions.

## INC-20260909-014: Protected migration left the obsolete per-user uninstall entry

- Detected: 2026-09-09.
- Severity: P2 update and uninstall consistency.
- Affected: Existing v0.1.88 Agent migration from LocalAppData to Program Files.
- Status: corrected; focused regression verified.
- Root cause and contributors: The migration removed the legacy runtime only. Its exact HKCU uninstall registration could remain and present a second stale Agent entry that pointed at deleted files.
- Permanent guard: Remove only the `WonRemote Agent` HKCU entry whose normalized `InstallLocation` exactly matches one of the validated legacy roots; preserve every ambiguous or unrelated entry.
- Regression proof: The focused Viewer/Agent suite passed 86/86; `src/agentStartup.test.ts` executes the production helper against matching and nonmatching registry fixtures and verifies exact cleanup behavior.
- Required proof: Install v0.1.88, apply the protected-path update, and confirm Windows Installed Apps contains only the protected Agent entry.

## INC-20260909-015: Secure capture transitions depended only on DXGI access errors

- Detected: 2026-09-09.
- Severity: P1 PIN-screen stream continuity.
- Affected: Windows normal-to-PIN and PIN-to-unlocked capture transitions.
- Status: automated regression verified; packaged physical verification pending.
- Root cause and contributors: The first secure worker waited for DXGI access failure to signal a desktop change. A LocalSystem worker can retain broader access after unlock, so the expected failure is not a reliable secure-to-normal transition boundary.
- Permanent guard: Classify the active input desktop locally and compare it with the capture worker's expected `Default` or `Winlogon` class every 100 ms; retain DXGI errors only as a secondary signal.
- Regression proof: x86 release-profile Rust tests passed 43/43, including both transition directions, stable same-desktop states, Winlogon classification and real named-pipe frame/control transport.
- Required proof: x86 native transition tests plus an installed lock-to-PIN-to-unlock stream that proves visible frames before, during and after authentication.

## INC-20260909-016: Native handle conversion patch contained an invalid token

- Detected: 2026-09-09.
- Severity: P3 pre-compile development error; no product artifact affected.
- Affected: New active-input-desktop helper source only.
- Status: corrected before compilation.
- Root cause and contributors: A malformed token was introduced while converting the desktop handle for the Windows binding and was noticed immediately in the patch result review.
- Permanent guard: Format and compile the x86 native target after every native edit before running broader suites or reporting completion.
- Regression proof: `cargo fmt --all -- --check` and x86 release-profile Rust tests passed 43/43 after correction.
- Release proof: Not applicable; no product build or deployment occurred.

## INC-20260909-017: Native security module initially failed warnings-as-errors analysis

- Detected: 2026-09-09.
- Severity: P3 source-quality gate; no product artifact affected.
- Affected: Buffer sizing in the new secure-capture module.
- Status: corrected before build.
- Root cause and contributors: Two ceiling-division expressions manually duplicated a standard integer operation and were accepted by compilation but rejected by the repository's strict Clippy invocation.
- Permanent guard: Run x86 Clippy with `-D warnings` after native secure-capture changes, in addition to formatting and tests.
- Regression proof: `cargo clippy --release --target i686-pc-windows-msvc -- -D warnings` passed after correction; x86 release-profile Rust tests also passed 43/43.
- Release proof: Not applicable; no product build or deployment occurred.

## INC-20260909-018: Packaging test hardcoded a previous release version

- Detected: 2026-09-09.
- Severity: P3 build-gate maintenance.
- Affected: Desktop packaging regression test during a legitimate release version bump.
- Status: corrected before installer packaging completed.
- Root cause and contributors: The packaging scaffold asserted the literal prior version `0.1.88` even though version consistency is already verified across the package, Cargo, Tauri and application version sources.
- Permanent guard: Packaging tests validate semantic-version shape and cross-file equality; release scripts retain the concrete version-consistency check.
- Regression proof: The focused desktop packaging suite is rerun after the `0.1.89` bump, and `release:exes` independently checks all release version sources before packaging.
- Release proof: Pending the requested build; this incident cannot be closed by a source-only assertion.

## INC-20260909-019: Fixed Winlogon worker regressed lock-screen capture and could not control SYSTEM windows

- Detected: 2026-09-09.
- Severity: P1 remote-screen and input regression.
- Affected: Installed v0.1.89 Windows Agent during lock/welcome/PIN transitions and visible SYSTEM-owned windows on the normal desktop.
- Status: source corrected; installed physical verification pending.
- User-visible symptom: A competing remote product continues showing the Windows transition and PIN screen, while WonRemote becomes black where its previous build showed the lock screen. The observed nProtect warning also cannot be closed remotely.
- Root cause and contributors: The v0.1.89 worker is launched on a hardcoded `winsta0\\Winlogon` desktop, and that worker is used only after a user-session probe classifies a secure transition. The installed reproduction contained no transition event, so capture could remain on the obsolete desktop and turn black. The ordinary input worker also runs below SYSTEM integrity. The installed Mastersoft architecture instead keeps a LocalSystem owner, launches a worker in the active console session, and calls `OpenInputDesktop` plus `SetThreadDesktop` to follow the current input desktop. The release was built before this installed lock/PIN boundary was physically proven.
- Permanent guard: Run capture and privileged input on dedicated active-console worker threads that attach to the current input desktop before creating windows or hooks. Keep the broker local-only, validate peer executable, identity, request size and command grammar, and retain the authenticated Agent as the only network owner. A build must not be published until another-PC lock/PIN/unlock continuity and SYSTEM-window input are physically checked.
- Regression proof: i686 release-profile native tests passed 47/47; six focused install, packaging and Agent test files passed 154/154; TypeScript, rustfmt and warnings-denied Clippy passed.
- Required proof: Install over v0.1.89; verify normal desktop, lock, welcome, PIN and unlock without black frames; operate the SYSTEM-owned nProtect window; repeat reconnect and reboot.

## INC-20260909-020: Windows desktop access flags were combined with an unsupported operator

- Detected: 2026-09-09.
- Severity: P3 pre-compile development error; no product artifact affected.
- Affected: New active-input-desktop attachment source only.
- Status: corrected before build.
- Root cause and contributors: The pinned `windows` crate wraps desktop access rights in a type that does not implement Rust's bitwise-or operator, while the initial patch treated it like newer bitflags APIs.
- Permanent guard: Construct `DESKTOP_ACCESS_FLAGS` from the wrapped numeric values and run the focused i686 native compile immediately after every Windows API signature change.
- Regression proof: Corrected i686 release-profile tests passed 47/47 and warnings-denied Clippy passed.
- Release proof: Not applicable; no product build or deployment occurred.

## INC-20260909-021: Broker request serialization test searched for escaped JSON text

- Detected: 2026-09-09.
- Severity: P3 test-only error; no product artifact affected.
- Affected: New secure broker request unit test.
- Status: corrected before build.
- Root cause and contributors: A Rust raw string assertion included literal backslashes even though `serde_json::to_string` returns ordinary JSON text.
- Permanent guard: Assert the exact unescaped JSON token and rerun only the focused native tests before broader validation.
- Regression proof: Corrected native request serialization test passed within the 47/47 i686 suite.
- Release proof: Not applicable; no product build or deployment occurred.

## INC-20260909-022: Secure worker race could leave Agent in privileged capture mode after unlock

- Detected: 2026-09-09.
- Severity: P2 pre-build state-transition error; no product artifact affected.
- Affected: New dynamic desktop attachment when Windows returns to Default before the secure worker finishes starting.
- Status: superseded before build by always using the active-console broker for capture.
- Root cause and contributors: The first dynamic-attachment patch derived the worker's expected state from the desktop it found at startup. In a fast unlock race that would make a secure-requested worker accept Default as its steady state, preventing the Agent from receiving `default-desktop-required`.
- Permanent guard: Every installed capture starts through the active-console broker. The worker derives the desktop class it actually attached to, exits on a class change or capture access loss, and the Agent starts a fresh worker on the current input desktop. Preserve bidirectional transition tests.
- Regression proof: Native desktop-transition and concurrent broker tests passed within 47/47; Agent capture-plan and packaging tests passed within the 154/154 focused app suite.
- Release proof: Not applicable; no product build or deployment occurred.

## INC-20260909-023: Conditional secure-desktop handoff missed the installed black-screen transition

- Detected: 2026-09-09.
- Severity: P1 installed remote-screen regression.
- Affected: v0.1.89 Agent capture before and during Windows lock, welcome and PIN UI.
- Status: source corrected; physical verification pending.
- User-visible symptom: Another installed remote product showed the Windows welcome and PIN screens, while WonRemote showed black; the WonRemote log contained neither a secure transition nor a secure worker start.
- Root cause and contributors: The design left ordinary capture in the user session and started the SYSTEM worker only after a desktop-name or access-denied signal. That conditional boundary could fail before the protected worker was engaged, so improving only the Winlogon worker could not restore a path that never launched.
- Permanent guard: Installed capture uses the protected active-console broker from its first frame. Each short-lived SYSTEM worker attaches to the current input desktop before creating the capturer and restarts on desktop-class change or access loss. Direct capture is only a Default-desktop fallback when the local broker is unavailable.
- Regression proof: i686 native tests passed 47/47; focused install/package/Agent tests passed 154/154; TypeScript, rustfmt and warnings-denied Clippy passed.
- Required proof: Install over v0.1.89 and verify another-PC continuity across normal desktop, lock, welcome, PIN, unlock and reconnect.

## INC-20260909-024: New input-client assertion used an untyped mock call tuple

- Detected: 2026-09-09.
- Severity: P3 test-only type error; runtime tests passed and no product artifact was affected.
- Affected: Persistent input injector regression test.
- Status: corrected before build.
- Root cause and contributors: Vitest inferred the zero-argument implementation signature for a mock, so indexing its recorded second argument failed strict TypeScript even though the runtime mock accepted the call.
- Permanent guard: Type transport mocks with the production SpawnInputServer signature and run tsc --noEmit alongside focused runtime tests.
- Regression proof: Strict TypeScript and the focused 154/154 app test suite passed.
- Release proof: Not applicable; no product build or deployment occurred.

## INC-20260909-025: Installed Agent required a protected broker that was absent

- Detected: 2026-09-09.
- Severity: P1 installed remote-screen regression.
- Affected: The observed v0.1.89 Program Files Agent install and lock/welcome/PIN capture.
- Status: source corrected; installed repair and physical verification pending.
- User-visible symptom: WonRemote becomes black during the Windows lock/PIN interval while the installed Mastersoft remote product continues showing the same active console screen. Remote input also cannot operate the SYSTEM-owned nProtect warning.
- Minimal trigger: Update the affected PC to v0.1.89, connect from another PC, and move from the ordinary desktop through lock or welcome into the PIN screen; the protected broker task is absent and the Viewer receives black frames.
- Confirmed evidence: `WonRemote Agent` is Running as an Interactive/Highest task from `C:\Program Files (x86)\WonRemote Agent`, but `WonRemote Secure Capture` is absent. The installed Agent bundle requests `secure-client`; the packaged native executable still advertises the fixed-Winlogon broker modes and lacks `secure-input-server` and `SetThreadDesktop`.
- Root cause and contributors: Agent install/update stopped the broker before overwriting files but the non-legacy postinstall path did not invoke task registration or restart; it relied on a later first-launch repair. Release validation checked that files existed and were x86, but did not assert that the Agent bundle and native payload implemented the same protected-desktop protocol.
- Fix commit(s): pending; source changes are uncommitted.
- Permanent guard: Register and start both protected tasks during every elevated install/update, retain first-launch repair, use the active-console input desktop rather than a fixed desktop, and reject release resources unless both the Agent bundle and native payload contain the required broker protocol markers.
- Regression proof: Corrected NSIS install/update path compiled; the real PowerShell helper created missing tasks and restarted a stopped broker; package compatibility tests rejected the installed old native payload; focused app tests passed 154/154 and native tests passed 47/47.
- Release proof: Not applicable in this turn; no installer was built, installed or deployed.
- Remaining blocker: Install over the affected v0.1.89 PC and verify broker task creation/running state, continuous normal/lock/welcome/PIN/unlock frames, nProtect input, update restart and reboot recovery.

## INC-20260909-026: Multi-file patch contained malformed native-edit content

- Detected: 2026-09-09.
- Severity: P3 development tooling error; no product artifact was built or released.
- Affected: First attempt to apply the broker-install and release-compatibility correction.
- Status: corrected before build.
- Root cause and contributors: An unrelated token was accidentally inserted into a large multi-file patch. The tool reported a context failure, but inspection showed one intended native hunk had applied while the malformed token had not.
- Permanent guard: Apply the correction in small file-owned patches and inspect the actual diff after any partial or failed multi-file edit before retrying.
- Regression proof: Corrected hunks passed `git diff --check` and all focused tests.
- Release proof: Not applicable; no product build or deployment occurred.

## INC-20260909-027: Active-desktop input edit missed Rust formatting

- Detected: 2026-09-09.
- Severity: P3 source-formatting issue; compiled tests passed and no product artifact was built.
- Affected: One assignment in the new secure input-server loop.
- Status: corrected before build.
- Root cause and contributors: The semantic edit compiled but did not match `rustfmt` line wrapping.
- Permanent guard: Keep `cargo fmt --all -- --check` in the focused native gate and apply formatter output before final verification.
- Regression proof: `cargo fmt --all -- --check` and `git diff --check` passed after formatter application.
- Release proof: Not applicable; no product build or deployment occurred.

## INC-20260909-028: Incident-registry patch used an invalid placeholder context

- Detected: 2026-09-09.
- Severity: P3 documentation tooling error; the patch was rejected and no source or artifact changed.
- Affected: First attempt to record the formatting failure.
- Status: corrected before build.
- Root cause and contributors: A placeholder incident heading was submitted instead of the verified file tail context.
- Permanent guard: Read the target tail first and patch only an exact existing anchor.
- Regression proof: Exact-tail patch applied and `git diff --check` passed.
- Release proof: Not applicable; no product build or deployment occurred.

## INC-20260909-029: Release-order patch used a mistyped contract context

- Detected: 2026-09-09.
- Severity: P3 development tooling error; the patch was rejected and no product artifact was built.
- Affected: First attempt to move the compatibility gate ahead of Agent installer bundling.
- Status: corrected before build.
- Root cause and contributors: The multi-file patch expected a duplicated word that was not present in the inspected contract entry, so context validation failed.
- Permanent guard: Patch source, test and contract as separate exact hunks after reading their current content.
- Regression proof: Packaging tests passed within the 154/154 focused suite and `git diff --check` passed.
- Release proof: Not applicable; no product build or deployment occurred.

## INC-20260909-030: Contract evidence update retried with invalid long-line contexts

- Detected: 2026-09-09.
- Severity: P3 documentation tooling error; rejected patches changed no runtime source or product artifact.
- Affected: Attempts to replace verification text in minified `CHANGE_CONTRACT.json` outcome lines.
- Status: corrected before build.
- Root cause and contributors: Two manually copied long lines contained mistyped path or identifier text, and a later multi-hunk update was rejected at its last long-line context.
- Permanent guard: Read and replace one exact outcome line at a time, generate the patch from the current line, and parse the JSON after all replacements.
- Regression proof: `CHANGE_CONTRACT.json` parsed successfully; final contract gate and diff check are run after this evidence update.
- Release proof: Not applicable; no product build or deployment occurred.

## INC-20260909-031: Final evidence commands contained transcription errors

- Detected: 2026-09-09.
- Severity: P3 documentation and verification-command errors; no runtime source or product artifact was affected.
- Affected: One JSON parse command and one incident proof sentence during final bookkeeping.
- Status: corrected before build.
- Root cause and contributors: The cmdlet name and proof wording were mistyped while batching unrelated final evidence reads.
- Permanent guard: Keep final evidence commands single-purpose, copy executable cmdlet names, and search the resulting diff for malformed words before closing.
- Regression proof: `CHANGE_CONTRACT.json` parsed successfully, the malformed-word scan found no matches, and `git diff --check` passed apart from existing line-ending warnings.
- Release proof: Not applicable; no product build or deployment occurred.

## INC-20260909-032: Final contract lookup used the application directory instead of the repository root

- Detected: 2026-09-09.
- Severity: P3 verification-command error; no runtime source or product artifact was affected.
- Affected: One read-only attempt to inspect `CHANGE_CONTRACT.json` and `INCIDENT_REGISTRY.md`.
- Status: corrected before build.
- User-visible symptom: The first bookkeeping command printed file-not-found and null-index errors; it did not alter the product.
- Minimal trigger: Run the repository-root contract lookup with `aether-link-app` as the working directory while using unqualified root filenames.
- Root cause and contributors: The command reused the application working directory from npm verification even though both governance files live one directory above it.
- Fix commit(s): pending; documentation changes are uncommitted.
- Permanent guard: Use the repository root for governance-file reads and reserve the application directory only for npm commands.
- Regression proof: The corrected repository-root command parsed the contract and listed all requested outcome identifiers.
- Release proof: Not applicable; no product build or deployment occurred.
- Remaining blocker: None for this command error; the separate cumulative contract/test mapping failure remains reported without weakening the gate.

## INC-20260909-033: Published release tag did not identify the built source tree

- Detected: 2026-09-09.
- Severity: P1 release provenance failure.
- Affected: Public `v0.1.90` GitHub release assets and their source-tag relationship.
- Status: corrective `v0.1.91` release in progress; v0.1.90 assets remain byte-verified but its tag is not an adequate source identifier.
- User-visible symptom: Installers download and verify successfully, but a user or maintainer cannot inspect the matching source from the published release tag.
- Minimal trigger: Build installers from a dirty local worktree, then publish with a script that creates a tag from remote `main` rather than the local build commit.
- Root cause and contributors: The publisher validated installer bytes and manifest signatures but did not require a clean source tree or require local HEAD to equal GitHub `main` before creating the release.
- Fix commit(s): pending; source changes are being committed before the corrective release.
- Permanent guard: `publish-github-release.ps1` rejects tracked or relevant untracked release-source changes and rejects a local HEAD that is not already pushed to `origin/main`; its packaging test asserts all three checks.
- Regression proof: Focused release packaging test verifies the committed-and-pushed source guard is present; the existing publisher still verifies remote asset bytes, checksums and manifest signatures.
- Release proof: v0.1.90 uploaded exactly the Viewer installer, Agent installer and signed manifest, then downloaded and verified the stored assets. Its source-tag mismatch requires supersession, not mutation.
- Remaining blocker: Commit and push the exact v0.1.91 source, rebuild, publish a new immutable release and deploy Hosting against that release.

## INC-20260909-034: Native verification was invoked from the application directory

- Detected: 2026-09-09.
- Severity: P3 verification-command error; no runtime source or product artifact was affected.
- Affected: First attempt to rerun the x86 Rust native test and Clippy gate for v0.1.91.
- Status: corrected before build.
- User-visible symptom: The command stopped immediately because `aether-link-app` has no Cargo manifest; no verification result was accepted from that attempt.
- Minimal trigger: Run the native Cargo commands from `aether-link-app` instead of `aether-link-poc`.
- Root cause and contributors: The combined verification command used the application work directory for both JavaScript and Rust checks.
- Fix commit(s): pending; documentation changes are uncommitted.
- Permanent guard: Execute frontend checks from `aether-link-app` and native Cargo checks from `aether-link-poc` as separate commands.
- Regression proof: Corrected i686 release test passed 47/47, warnings-denied Clippy passed and rustfmt check passed from `aether-link-poc`.
- Release proof: Not applicable; no v0.1.91 installer was built or deployed at this point.
- Remaining blocker: None for the command error; the normal v0.1.91 build and release checks continue.

## INC-20260909-035: Final bookkeeping commands mixed repository and PowerShell syntax contexts

- Detected: 2026-09-09.
- Severity: P3 verification-command error; no runtime source or product artifact was affected.
- Affected: One root contract read and one branch-upstream inspection command.
- Status: corrected before build.
- User-visible symptom: The root file lookup reported not found from the application directory, and PowerShell parsed an unquoted Git upstream selector as a hashtable.
- Minimal trigger: Use root-relative governance filenames from `aether-link-app`, or pass `@{upstream}` to PowerShell without quotes.
- Root cause and contributors: Combined inspection commands reused incompatible working-directory and shell syntaxes.
- Fix commit(s): pending; documentation changes are uncommitted.
- Permanent guard: Run repository-governance reads from the repository root and quote Git revision selectors when invoking them through PowerShell.
- Regression proof: Corrected root reads and quoted branch inspection completed; no product file was changed by either failed command.
- Release proof: Not applicable; no v0.1.91 installer was built or deployed at this point.
- Remaining blocker: None for these command errors; the normal v0.1.91 build and release checks continue.

## INC-20260909-036: Isolated release worktree exceeded the native Windows build path limit

- Detected: 2026-09-09.
- Severity: P3 build-environment failure; no release artifact was produced.
- Affected: First v0.1.91 x86 installer build in the isolated release worktree.
- Status: corrected by moving the isolated build to a short absolute path before retry.
- User-visible symptom: The release command stopped while CMake compiled turbojpeg because generated MSBuild paths exceeded the Windows path limit.
- Minimal trigger: Build the x86 native runtime from `C:\Users\qpalz\Documents\wonremote-release-0191`, whose Cargo/CMake output nesting exceeds the compiler path limit.
- Root cause and contributors: The clean-worktree release strategy used a descriptive directory name without accounting for deeply nested CMake and MSBuild temporary paths.
- Fix commit(s): not applicable; execution-path correction only.
- Permanent guard: Use a short drive-root release worktree path for Windows native builds and retain the original dirty worktree untouched.
- Regression proof: The failure identifies the generated path limit; the retry uses `C:\wr91`, reducing the fixed worktree prefix by more than 35 characters.
- Release proof: Not applicable; the failed worktree did not produce or publish v0.1.91 artifacts.
- Remaining blocker: Rebuild and publish from the short clean worktree.

## INC-20260909-037: Shared dependency junction did not contain the local Tauri CLI

- Detected: 2026-09-09.
- Severity: P3 isolated-build setup failure; no release artifact was produced.
- Affected: Second v0.1.91 x86 installer build attempt in the short worktree.
- Status: corrected by installing dependencies inside the isolated worktree instead of sharing an incomplete dependency directory.
- User-visible symptom: `npx tauri` resolved the unrelated public `tauri` package because the shared junction had no local `.bin\\tauri.cmd` or `@tauri-apps/cli` entry.
- Minimal trigger: Reuse the source worktree's empty or incomplete `node_modules` directory through a junction in a clean checkout.
- Root cause and contributors: The original build environment obtains its CLI through a different local dependency state, so checking only that the directory existed was insufficient.
- Fix commit(s): not applicable; isolated build setup correction only.
- Permanent guard: Install the lockfile dependencies in each isolated release worktree and verify the local Tauri CLI path before starting installer packaging.
- Regression proof: The failed worktree lacked both expected CLI paths; the retry removes only its temporary junction and uses `npm ci` from the committed lockfile.
- Release proof: Not applicable; the failed attempt did not produce or publish v0.1.91 artifacts.
- Remaining blocker: Restore isolated dependencies, rebuild and publish from the short clean worktree.

## INC-20260912-046: Mobile settings reuse an unbounded desktop popover

- Detected: 2026-09-12 user Android screenshot.
- Severity: P1 remote-control usability regression.
- Affected: Android Viewer settings and primary input toolbar.
- Status: Source and browser boundary verified; installed Android and release pending.
- User-visible symptom: Desktop toolbar stacks above mobile controls; nested tools extend beyond the left viewport with clipped text.
- Minimal trigger: Portrait remote session, open mobile settings then desktop tools.
- Root cause and contributors: Mobile settings exposed the full desktop bar as another flex row and retained an anchor-relative desktop popover. Earlier isolated control tests did not render the App toolbar/full CSS together. Flex shrinking also collapsed display settings during the first overlay implementation; screenshot review caught it.
- Fix commit(s): uncommitted.
- Permanent guard: Bounded scrollable mobile overlay independent of canvas/toolbar sizing, inline tools, exclusive Fn/settings and minimum touch sizes. Actual App toolbar JSX and full stylesheet exercised together, including noncollapsed display settings and button reachability.
- Regression proof: node scripts/verify-mobile-session-tools.mjs passed five viewports; node scripts/verify-mobile-controls.test.mjs passed three input viewports; tsc --noEmit passed. Screenshots at 360x800/800x360 inspected. Initial panel-toggle test was corrected to await React effect completion rather than inspect before its commit.
- Release proof: None yet. User requests Android build/deploy via GPT-5.6 Terra low.
- Remaining blocker: Installed Android keyboard/transport effects remain unverified; existing release gates and signing must be checked before publication.

## INC-20260912-045: Deleted command acknowledgement blocks current refresh and input reception

### Android follow-up (2026-09-12)

- Affected: Android AgentRepository pending-command listener; Viewer and control-addon do not own this query.
- Cause: Whole-snapshot batches could overlap; IDs were released before dispatch, a deleted document failed the entire acknowledgement, and removing the listener did not cancel pending completion callbacks.
- Permanent guard: AgentService-owned subscription on Android main executor; ADDED-only ID reservation through dispatch; one serialized atomic ACK; NOT_FOUND-only server refresh and one atomic retry restricted to original IDs; terminal error/stop closes queue and ignores late tasks. Distinct IDs remain distinct input events. No persistent cross-process exactly-once claim.
- Regression proof: AgentCommandSubscriptionTest initially hit the JVM's unimplemented Android Looper, not a product failure; Robolectric supplies Android lifecycle behavior instead of silencing exceptions. Final :agent:testDebugUnitTest selection passed 18 tests (15 command, 2 quota, 1 update), including main-looper, 24h idle/remount, quota, expiry and bounded recovery. Actual Task/main-looper with mocked Firestore request boundaries; no real Android server/device proof. Mockito/Robolectric are test-only dependencies and are not included in APK runtime.
- Release proof: No APK packaging, installation or release in this change. ADB device inventory is empty; SDK has no installed emulator/AVD. Installed Android gesture/key effects and reconnect remain unverified.
- Fix commit(s): uncommitted; prior PC work preserved.


- Detected: 2026-09-12 while resuming unfinished input/presence repair.
- Severity: P1 for command reception interrupted by a deleted acknowledgement target.
- Affected: Agent Firebase listener and explicit poll sibling; Viewer manual refresh and reliable input fallback depend on these callbacks.
- Status: Source and local Firebase integration verified; installed cross-PC/APK proof remains open.
- User-visible symptom: Historical installed NOT_FOUND acknowledgement logs precede subscription restarts; manual Viewer refresh can time out without a current response.
- Minimal trigger: Deliver a snapshot of an older command and a fresh refresh request, then delete the older document immediately before its acknowledgement batch commits.
- Root cause and contributors: One missing target rejects the whole batch. Complete snapshots also requeue unchanged pending commands, and queued work continued after terminal callback failure. An intermediate per-document recovery was rejected during review because failure midway could acknowledge only a prefix without delivering it; the final retry is atomic.
- Fix commit(s): Uncommitted working-tree repair; no public release.
- Permanent guard: Normal batch unchanged. Typed not-found alone permits one server pending-query refresh and one atomic retry restricted to original IDs. Never recreate deleted commands. Queue only added documents, deduplicate in-flight IDs and stop callbacks/writes on cancellation or permission/quota failures.
- Regression proof: 25 related request/presence tests passed, plus one added 50-command/remount budget test; TypeScript passed. Real SDK 12.14.0/emulator 1.22.0 under unchanged repository rules passed deletion-before-commit, correlated Viewer-visible heartbeat, subsequent input callback, unauthorized-read rejection and cleanup. New integration test is loopback-only and explicitly enabled by FIRESTORE_EMULATOR_HOST.
- Release proof: None; no build, deployment, installed-agent restart or production load.
- Remaining blocker: Installed cross-PC/APK refresh and actual input, reconnect/reboot/PIN pixels, plus prior release/signing requirements. Local callbacks are not native input proof.
- Test environment: Emulator 1.22.0 requires Java 21; default Java 17 was incompatible. Korean-locale emulator resource failure was fixed only in the test launcher with -Duser.language=en -Duser.country=US, without changing system locale or rules. SHA-256-verified portable JRE resides under ignored .codex-tmp/jre21-command-recovery. Emulator was shut down after the successful run.

## INC-20260912-044: Duplicated instructions retain obsolete worker and verification mandates

- Detected: 2026-09-12 during the user-requested general development guide consolidation.
- Affected: Development guidance, handoff and reporting; no product runtime changed.
- Cause: Several active documents copied the same quality/release rules while retaining conflicting worker scopes, fixed delegation quotas, mandatory idle-worker work, repeated local re-verification and per-report remote fetch. Old version/test counts appeared alongside active instructions.
- Permanent guard: One standalone general guide, short legacy entrypoint links, separate project constraints and clearly historical handoff. Preserve existing commit/security/release gates. Add no new automatic checklist layer.
- Proof: Editorial consolidation completed; 24 local links valid; historical handoff equals its original text after newline normalization; existing policy-wiring assertion passed once. Current contract and incident history stay open where previously unverified.
- Status: Documentation consolidation verified. This does not resolve or certify any previous product defect.
- Remaining physical verification: None for documentation organization; existing product hardware and deployment gaps are unchanged.

## INC-20260912-043: Nested verification repeats eight existing regression suites

- Detected: 2026-09-12, while auditing the user's report of unnecessary automatic verification.
- Cause: src/releaseBoundary.test.ts launches a nested Vitest run of eight suites already discovered by the outer full run; its only assertion checks for a test-runner output heading.
- Permanent guard: Remove only this duplicate wrapper. Keep all eight original suites and select them directly with npm run test:release-boundaries when relevant. AGENTS.md requires scoped checks and recovery of recorded evidence after compaction, without a new automatic checklist layer.
- Proof: Before editing, vitest list --filesOnly discovered both the wrapper and original suites. After editing, discovery returns 142 files, no wrapper and each of the eight originals exactly once. The corrected packaging file passed all 67 tests; combined with the unchanged successful suites from the initial run, all 112 original assertions have passing evidence.
- Initial direct run: Eight files ran once, 111/112 assertions passed. The remaining failure was a source-text packaging assertion matching inject_input inside the trailing Rust cfg(test) live probe added in the earlier input repair, not a production broker call.
- False-positive repair: Restrict that one no-direct-injection assertion to the production portion preceding the trailing cfg(test) module. Keep the prohibition, other identity/ACL/network assertions and real input tests intact. Rerun only the affected assertion; do not repeat the successful seven suites.
- Command note: npm consumed the attempted -t filter during the follow-up, running all 67 tests in the selected file instead of one. All passed; no further run was needed. Use node node_modules/vitest/vitest.mjs run <file> -t <name> for exact test-name filters in this environment.
- Boundaries unchanged: Product runtime, intended regression/security conditions, commit/release gates, cloud traffic and installed applications. No build or deployment.
- Remaining physical verification: None for test orchestration; earlier product hardware/release gaps remain open in CHANGE_CONTRACT.json.

## INC-20260911-042: Protected input relay hangs despite a connected Viewer

- Detected: 2026-09-11 from installed logs and elevated input-server probe.
- Severity: P1 keyboard and mouse unavailable.
- Affected: PC Agent input broker shared by PC and Android Viewers.
- Status: Ordered relay and input desktop access repaired; installed protected native binary updated and real Windows test window received left/right/wheel/F12. Full cross-PC/APK path remains unverified.
- User-visible symptom: Video connects but keyboard and mouse do not operate the remote PC.
- Minimal trigger: Open input-server and send a valid JSONL request through the installed broker.
- Root cause and contributors: Broker/client clone synchronous duplex pipe handles then read and write concurrently; pending synchronous reads can serialize writes on the same pipe file object. Existing tests covered channel creation and callbacks rather than the complete input exchange. Non-elevated task enumeration also hid the SYSTEM task, causing an incorrect initial missing-task diagnosis.
- Fix commit(s): pending.
- Permanent guard: Use ordered request/response input exchanges and test actual named-pipe roundtrips; inspect SYSTEM task state with elevated diagnostics. Input attachment requests DESKTOP_JOURNALPLAYBACK, while capture retains narrower rights. Preserve peer image/LocalSystem checks and restore the existing token privilege used temporarily for broker identity queries.
- Regression proof: All 48 i686 release native tests passed, including keyboard/mouse JSONL roundtrips through two real synchronous pipes. Installed corrected runtime returned a correlated response where the old runtime timed out. F24 was an unsupported diagnostic key; F12 release reached SendInput and returned win32_error=5, elevated=true, integrity=System. No actual keyboard/mouse success claimed.
- Additional root cause and proof (2026-09-12): Live F12 key-up succeeded before OpenInputDesktop attachment but failed afterward with win32_error=5. Input-specific DESKTOP_JOURNALPLAYBACK access changed that live test from failure to success. An elevated client also could not query the SYSTEM broker identity without temporarily enabling its existing SeDebugPrivilege; this is scoped to verification and does not remove identity or pipe ACL checks.
- Release proof: Earlier failed replacements were rolled back; the latest local replacement passed and remains installed. verify-installed-input.ps1 recorded actual left/right/wheel/keyboard events and eight successful replies through the installed broker. No public release. First replacement encountered a file lock; process termination now waits and tolerates already-exited processes before copying.
- Test limitations: Early GUI attempts inherited hidden startup state or lost foreground, so successful responses alone were rejected. The harness now shows the test window explicitly, checks target hit-testing and records actual window messages. A later instrumented run passed all four event categories; this does not prove the remote Viewer transport.
- Remaining blocker: Verify keyboard/mouse from another PC Viewer and installed APK, plus reconnect/reboot. Neither the pipe roundtrip nor the local test window alone proves that complete path.

## INC-20260911-041: Android mouse toolbar verification omitted touch activation

- Detected: 2026-09-11, user reported APK clicks and wheel do not work.
- Severity: P2 remote input usability.
- Affected: Android Viewer toolbar and initial remote image sizing.
- Status: Touch activation hardened; physical remote input remains unverified.
- User-visible symptom: Mouse controls appear unresponsive and connection does not automatically fit image width.
- Minimal trigger: Tap toolbar on Android or reconnect with saved zoom.
- Root cause and contributors: Prior tests used desktop mouse click callbacks only; touch activation relied on compatibility click after cancelled pointerdown. Initial zoom reused desktop preferences and canvas was height-constrained. Actual device failure cause is not yet proven.
- Fix commit(s): pending.
- Permanent guard: Activate touch buttons on pointerup with compatibility-click deduplication, test touch-generated mouse commands, and initialize mobile zoom to width fit.
- Regression proof: verify-mobile-controls.test.mjs passes native emulated taps with exact left/right down/up and wheel commands on three viewports; verify-mobile-gesture.test.mjs passes 1920x1080 width-fit and local gesture checks; tsc passes.
- Release proof: Not deployed in this follow-up yet.
- Remaining blocker: Installed APK to remote PC input, reconnect and rotation verification.

## INC-20260910-040: Android Viewer reused desktop controls and automatic IME focus

- Detected: 2026-09-10, user portrait/landscape and keyboard screenshots.
- Severity: P2 remote control usability.
- Affected: Android Viewer WebView and mobile remote session UI.
- Status: Firebase Android update and web Viewer deployed; physical APK validation pending.
- User-visible symptom: Clipped controls, whole-page zoom, unsolicited keyboard and obscured remote image; mouse and Windows key controls missing.
- Minimal trigger: Open a remote session on a narrow phone, tap remote canvas or open keyboard.
- Root cause and contributors: Desktop-sized toolbar reused on mobile; canvas and session activation focus hidden IME; viewport fixed to 100dvh instead of actual visible area; native WebView page zoom not explicitly disabled.
- Fix commit(s): pending.
- Permanent guard: Dedicated mobile input toolbar outside canvas, explicit IME focus button, portrait visualViewport listener with cleanup, fixed touch target dimensions, Windows key groups and modifier release.
- Regression proof: node scripts/verify-mobile-controls.test.mjs passed real React controls in Edge at 320x640, 360x800 and 800x360: clicks, scroll, explicit focus, stable zoom dimensions, modifier/chord release and simulated 220px/330px keyboard viewport changes. npx tsc --noEmit passed. The local test server initially omitted a UTF-8 Content-Type, so Korean accessible-name lookup failed; explicit HTML charset fixed the harness.
- Release proof: 2026-09-11 Firebase Hosting deployment completed. The public Android manifest returns Agent, Viewer and Control Add-on versionName 0.1.91/versionCode 1091; home and /viewer return HTTP 200.
- Remaining blocker: Full session viewport/IME tests and physical Android keyboard sizing, orientation, multi-touch, remote PC input.

## INC-20260910-039: Capture stdin error terminates Agent after connection

- Detected: 2026-09-10 from installed 0.1.90 log.
- Severity: P1 remote session unavailable.
- Affected: PC Agent capture control for profile, keyframe and diagnostic commands.
- Status: Source fix and regression coverage completed; fresh x86 Agent bundle installed locally on 2026-09-12. Presence recovery and cross-PC video remain unverified.
- User-visible symptom: Viewer connects without frames and refresh later reports offline.
- Minimal trigger: Capture stdin closes while Viewer sends monitor/profile commands after data channels open.
- Root cause and contributors: Capture stdin has no error listener; synchronous try/catch cannot catch asynchronous EPIPE. Every capture command shares this unsafe stream. Separate NOT_FOUND acknowledgement failures also interrupt command reception.
- Fix commit(s): pending.
- Permanent guard: Own stdin error handling per capture child, retain it through closure, route all writes through the guarded writer, and preserve the existing generation-scoped restart path.
- Regression proof: 2026-09-11 captureControl.test.ts uses an actual Writable failing asynchronously with EPIPE and verifies the stdin error listener receives it; Agent command regressions passed 59/59 and the release boundary suite passed.
- Release proof: Android/PWA Firebase deployment completed, but PC installers were not published because the v0.1.90 update-manifest signing private key remains unavailable.
- Local repair (2026-09-12): Fresh x86 bundle installed at protected agent/index.mjs with backup and matching SHA256; exactly one Agent Node process after restart, heartbeat accepted and command listener active. The installed GUI input probe passed again after restart. No claim that a remote monitor/profile change has yet proven video continuity.
- Remaining blocker: Installed cross-PC frames and explicit presence refresh, including deleted command acknowledgement recovery.

## INC-20260909-038: Temporary worktree cleanup removed the local update signing key

- Detected: 2026-09-09.
- Severity: P1 update-signing continuity failure.
- Affected: The private key required to publish any post-v0.1.90 update that existing WonRemote installations can verify.
- Status: v0.1.90 remains deployed and byte/signature verified; later release publication is blocked pending key recovery or an explicit key-rotation decision.
- User-visible symptom: Existing 0.1.89 clients can update to the already published signed v0.1.90 release, but a new signed v0.1.91 manifest cannot be generated with the bundled public key.
- Minimal trigger: Remove a temporary Git worktree that contains a junction to the source `.local-run` directory; the worktree removal follows the junction contents instead of preserving the target cache and key.
- Root cause and contributors: The isolation procedure reused the mutable `.local-run` directory through a junction. Cleanup treated the junction target as worktree content, deleting the local signing key and build cache.
- Fix commit(s): pending; recovery requires either restoring the original private key or intentionally rotating the trust key.
- Permanent guard: Never junction a mutable source cache or secret directory into a disposable worktree. Copy only nonsecret build tooling to an isolated directory, and verify the signing-key path before creating or removing any release worktree.
- Regression proof: The original expected key path and all searched user data locations no longer contain `update-signing-private.pem`; GitHub v0.1.90 still exposes its three uploaded assets and signed manifest.
- Release proof: v0.1.90 Viewer, Agent and manifest were uploaded, downloaded, checksum-verified and remain public; Firebase Viewer/Agent redirects resolve to the latest release and Android update metadata returns HTTP 200.
- Remaining blocker: Recover the original private key from an external backup, or explicitly approve public-key rotation knowing existing installations cannot authenticate the first post-rotation update automatically.

## INC-20260914-077: Native export client integration assumptions
- Agent nowrap fixture: Hidden local-server field in Firebase mode has zero rendered lines. Limit line-count assertions to visible elements; retain checks for the same field in local mode and do not unhide it to satisfy tests.
- Agent compact fixture: App imports a CSS module transitively; esbuild in-memory test bundle lacked outfile, causing import resolution failure. Configure a virtual output name and explicitly select JS output; product code and layout assertions unchanged.
- Mobile status-row integration: Added20px status row with4px bottom margin but tools-overlay offset still assumed old control height. Full Viewer browser sweep37/38 passed; existing popup-bound test failed by16px. Include status height only when status row exists in both orientation calculations; retain overlay assertion and visual check, no blanket extra padding.
- Portrait screenshot interpretation: Width-fit browser fixture resized desktop Chromium without mobile emulation, so screen.orientation remained landscape at a portrait viewport. Centered output was not sufficient proof of Android product defect. Add production viewport meta, opt-in mobile/touch emulation and explicit orientation/top bounds before judging layout; retain real landscape CSS collision evidence separately.
- Mobile width-fit cascade: Actual App landscape test revealed canvas narrower than available width despite mobile width100% rule. Desktop focus/fullscreen canvas width:auto!important took precedence. Scope more-specific important width/height overrides to mobile-width-fit preview only, preserving desktop behavior; actual decoded-pixel and portrait/landscape geometry tests plus visual checks required.
- First-use monitor selection: Effect reused the immutable absence of saved preferences as a reason to reset every selection to Agent active monitor. Browser RED showed selecting0 immediately reverted1. Initialize first monitor once; later effect only replaces an unavailable index. Browser selection/reconnect guard required, existing storage failure and quality isolation retained.
- Preference read preservation: First storage-error repair treated failed read as missing settings and allowed effect to overwrite unread saved values. Browser RED showed saved zoom3/monitor2 replaced by fallback zoom1/monitor0. Retain failed-read marker, suppress writes for that session and show unsaved status; remount retries reading normally. Browser preservation assertions cover both read and write failures, without weakening normal device persistence tests.
- Preference failure fixture typing: Browser storage override initially omitted key/rest parameter types. Typecheck caught implicit-any despite passing runtime tests; add string/string[] annotations without changing exercised behavior.
- Device preference storage follow-up: Unguarded localStorage read during render and write in effect unmounted the remote session when storage threw. Real App browser RED reproduced both getItem/setItem failures with missing session controls. Read once lazily with default fallback; contain write failure and show unsaved-settings status while retaining live state, without automatic retries. Focused browser recovery/per-device persistence tests and typecheck required; installed WebView storage remains unverified.
- Phone resume follow-up: Search placeholder change left the existing 24h idle/refresh test targeting obsolete text. Align that locator only; retain all request-count and idle assertions. Earlier phone-stage zero budget described incremental traffic, not total existing save traffic; resume review explicitly records the unchanged metadata and rollout paths and does not treat that zero as total billing evidence.
- Phone search fixture follow-up: A broad .table-row count included table headers/history rows. Scope the assertion to device-table non-header rows so it tests actual matching devices rather than unrelated layout elements.
- Phone editor fixture follow-up: Test metadata mock copied undefined desktopName over the existing name, unlike the production updater's string checks, making the named row disappear. Preserve omitted properties in the mock; keep real UI save/search/clear assertions intact.
- Device metadata lookup follow-up: Guessed a nonexistent metadata helper path and repeated a literal wildcard path error. Located actual helpers through directory-scoped rg in agentRegistry.ts. No product mutation from lookups; use discovered definitions rather than guessed file names.
- Incoming-progress mobile test follow-up: Desktop status subtitle is intentionally hidden by compact mobile layout; waiting for that text to be visible was an invalid mobile readiness condition. Wait for the active file receiver callback, then require the actual progress control to be visible/in viewport. Do not unhide desktop-only UI to satisfy the test.
- Resume UI follow-up: General input callback can swallow transport failure, leaving a new retry button pending without knowing it was not sent. Resume is capability-bound to the live WebRTC channel; inspect readiness/send result directly and show retryable failure without a Firebase fallback. Actual App browser send-failure/retry/download regression and TypeScript passed; unrelated keyboard path unchanged.
- Resume fixture type follow-up: ACK table always supplied receivedChunks, but its default object also declared the property; TypeScript flagged duplicate overwrite despite runtime pass. Remove only redundant fixture default, keeping every rejection assertion; rerun typecheck.
- Sender resume follow-up: Receiver persisted-prefix recovery was not connected to sender ACK validation; a correct16-chunk receipt during first8-chunk retry was rejected. Real disk roundtrip RED reproduced it. Accept only bounded partial-prefix negotiation on the first window, continue full source hashing, omit stored middle payload and retain strict final completion validation. Expanded sender18tests passed, including changed skipped bytes rejected without final output; channel3tests also passed with same source. Durable source/restart orchestration remains incomplete.
- Large-file lookup follow-up: Repeated an invalid literal PowerShell wildcard path while finding the limit; directory-scoped results still located fileTransferPolicy.ts and its500MiB limit. Subsequent lookups must use directory plus -g only; no product mutation from the lookup.
- Frame baseline follow-up: A non-keyframe partial resize immediately resized/cleared the visible canvas before a complete new picture existed. Actual App browser RED proved width changed32to64 with only one32px tile. Require the existing atomic full-coverage decode path for initial/size-changing frames regardless of keyframe flag; keep prior pixels until commit and invalidate old asynchronous delta draws after baseline replacement. Browser GREEN covers initial/resize completeness, unchanged-size delta, retained pixels, recovery and delayed old delta after replacement; TypeScript passed. Physical peers pending.
- Recent-history test follow-up: The mixed chronology fixture mutated the previously returned array in place, unlike fetchFirebaseConnectionHistory's mapped server response. React correctly retained the memo for identical state identity. Replaced the fixture array on the next response; kept product memoization and timestamp assertions intact. Focused actual App browser test and TypeScript passed; no production writes.
- Lookup follow-up: Searched firestore.rules under app directory before locating the actual repository-root file; corrected using rg --files. No rule modification or production access resulted.
- Rollback UI follow-up: Screenshot exposed global input sizing stretching confirmation checkbox. Fixed explicit18px checkbox dimensions and existing button styles; browser screenshot/interaction rechecked rather than assuming compile proved layout.
- Rollback fixture follow-up: Signed test data initially omitted the existing required V1 signature and contained only V2. Kept production verification unchanged and added both signatures to the fixture before rerunning. Invalid cases now reach the intended version/product/URL checks instead of all failing on missing signatures.
- Follow-up: Actual App browser fixture inferred empty messages as never[] and confirm as null; TypeScript caught it despite esbuild runtime pass. Explicit fixture types added; retain both runtime and type checks for this boundary. Literal wildcard search mistake repeated during rollback inspection; corrected to directory plus -g without changing product state.
- Cause: Initial client matched native postWebMessage sender origin to the destination origin; native messages require separate source handling. A PowerShell search also repeated a literal wildcard path mistake.
- Guard: Native exact HTTPS target origin, client current-page origin and null source/empty sender origin checks; directory plus -g for subsequent wildcard searches.
- Proof: Client chunk/ACK/cancellation tests3 and native export tests10 pass. Actual Chromium native handshake and Android provider remain pending, not proven by fake ports.
- Remaining: Actual App button test and physical native handoff; no release performed.

## INC-20260914-079: Viewer takeover recovery and local receive destination
- User-visible symptom: PC Viewer freezes after another viewer takes over; panel refresh cannot reconnect. Received-folder action opens remote PC instead of Viewer PC and incoming files need another save step.
- Minimal trigger: Take over a live PC session with Android, release it, then reconnect from the stale panel; receive a remote file and open its destination.
- Root cause and contributors: Transport refresh retained obsolete session identity and stale manual presence. Receive completion stopped at browser Blob and folder action reused remote command. Previous browser test incorrectly expected that action.
- Fix commit(s): Uncommitted scoped repair in App.tsx, viewerFirebase.ts, viewer_downloads.rs and selected Viewer updater. Unrelated changes retained.
- Permanent guard: Fresh authenticated session plus targeted presence refresh, loss dialog, native local-save completion and local folder IPC; signed target updater only while idle, no global fallback.
- Regression proof: Six focused suites56 cases pass across53 initial passes and3 corrected expectations; native x86 disk test and TypeScript pass. Service/native browser endpoints are mocked, not installed proof.
- Release proof: None. Predeploy exit1 reports active contract and missing evidence. No guard weakened or update policy/installer published.
- Remaining blocker: Real PC/Android takeover/file transfer, installed folder dialog and filesystem compatibility, target policy publication and59F19451 bootstrap/recovery. INC-20260914-078 remains unresolved.

## INC-20260914-080: IME-masked modifier keys and stale composition after shortcut
- User-visible symptom: During Korean typing Ctrl+A inserts a character instead of selecting all; modifier and Hangul transitions feel delayed.
- Minimal trigger: IME keydown reports key=Process, code=ControlLeft while composition remains active, followed by KeyA.
- Root cause and contributors: Modifier physical codes were absent from normalization; composing modifier events could be classified as text. Only Enter explicitly finalized composition, leaving shortcut and Hangul boundaries without that commit.
- Fix commit(s): Uncommitted scoped changes to App.tsx, viewerInputState.ts and remoteControlCommands.ts; prior changes retained.
- Permanent guard: Normalize both physical modifier sides before Process fallback; exclude modifier keys from text classification; finalize composition before Ctrl/Alt/Meta, Enter and local Hangul toggle without dual local/remote IME toggles.
- Regression proof: Actual App Chromium RED sent Process instead of Ctrl. GREEN checks exact Ctrl+A, delayed preedit suppression, local Hangul commit, Shift+Left and Ctrl+C/V;27 domain tests, focus-recovery script and TypeScript pass.
- Release proof: Not built or deployed for this fix. Earlier0.1.94 installer predates these edits.
- Remaining blocker: Real Windows IME/WebView and remote application verification required; browser composition events are synthetic and transport is mocked.

## INC-20260914-081: Received file publication depended on hard links
- User-visible symptom: Selected download folders on filesystems without hard-link support could reject otherwise valid received files.
- Minimal trigger: Complete native receive into a folder whose filesystem supports rename but not hard links; physical removable/shared-device reproduction not available.
- Root cause and contributors: Native completion used fs::hard_link for no-overwrite publication, unnecessarily requiring filesystem link support.
- Fix commit(s): Uncommitted viewer_downloads.rs and Windows filesystem API feature selection.
- Permanent guard: Same-directory MoveFileExW without replace/copy flags; retain destination collision loop and complete-size checks.
- Regression proof: Real Windows x86 native test passes exact bytes, original-file preservation, staging-source removal and three concurrent same-name completions. Existing invalid-name/offset/incomplete checks retained.
- Release proof: Not built into installer or deployed. Earlier0.1.94 artifact remains pre-repair.
- Remaining blocker: Actual removable/network destination and installed transfer tests; full goal remains incomplete.

## INC-20260914-082: Selected Viewer update stayed submitted after native failure
- User-visible symptom: Automatic Viewer update could stop retrying for the rest of the app lifetime after failed installer handoff, despite the UI leaving updating state.
- Minimal trigger: Start selected update, native process finishes without handoff, emit selected-viewer-update-finished, advance beyond hourly check period.
- Root cause and contributors: Native failure cleared UI state but scheduler submitted remained true; setting submitted after awaited invoke also risked overwriting an early failure notification.
- Fix commit(s): Uncommitted scheduler/controller callback and App listener integration.
- Permanent guard: Mark submitted before invoke, reset only on failure, retain one-hour cooldown, ignore duplicate/disposed notifications and preserve busy/session guards.
- Regression proof: Actual App browser RED observed1 instead of2 install attempts after cooldown; GREEN plus4 scheduler tests cover24h bound, early failure, duplicate events, slow attempts, session deferral and cleanup. TypeScript passed.
- Release proof: Not built, published or installed. New local policy generator validated against actual client with ephemeral keys; no production policy activated.
- Remaining blocker: Installed native update failure/restart/settings preservation and designated rollout tests deferred to final physical phase at user request.

## INC-20260914-083: Selected update policy limit applied after full buffering
- User-visible symptom: An oversized policy response could consume excess Viewer helper memory before rejection.
- Minimal trigger: HTTP response body supplies more than64KiB without a trustworthy size header.
- Root cause and contributors: response.text read the complete response before checking JavaScript string length instead of received byte size.
- Fix commit(s): Uncommitted selectedViewerUpdate.ts bounded stream read.
- Permanent guard: Fixed64KiB buffer, byte-level bound before copying each chunk, reader cancellation on failure and strict UTF-8 decoding; existing timeout and signature checks retained.
- Regression proof: RED consumed5 pulls through EOF; GREEN cancels on third32KiB chunk. Exact64KiB signed response accepted. Policy/generator9 tests and TypeScript passed.
- Release proof: No build or deployment; network response tests use local streams.
- Remaining blocker: Final installed selected-update checks remain deferred, not passed.

## INC-20260914-084: Lost final file acknowledgement prevented completed-prefix retry
- User-visible symptom: Agent-to-Viewer retry could fail even though Viewer already committed and verified the complete file.
- Minimal trigger: Drop final ACK after19 chunks, reopen Viewer IndexedDB receiver, retry same ID/source. First8 probe chunks receive complete19-chunk acknowledgement.
- Root cause and contributors: Sender allowed only strictly partial prefix negotiation and rejected count equal to total. Initial test selected Agent disk receiver, which has different completed-transfer lifetime; corrected to actual Viewer IndexedDB boundary before changing product.
- Fix commit(s): Uncommitted webrtcFileSender.ts and persistentFileReceiver.test.ts.
- Permanent guard: Accept a complete prefix only with exact total/count/status, continue hashing all skipped bytes, resend final chunk and require final acknowledgement. Do not report100 percent from probe alone.
- Regression proof: Production Node sender and real Chromium IndexedDB RED rejected completion; GREEN sends0..7 plus18, completion once, original bytes exact. Changed skipped source is rejected and prior stored file preserved.23 tests and TypeScript pass.
- Release proof: Not built or deployed; bridge uses browser evaluation, not live WAN/installed transport.
- Remaining blocker: Final physical interrupted-transfer/reconnect tests remain deferred under full original goal.
