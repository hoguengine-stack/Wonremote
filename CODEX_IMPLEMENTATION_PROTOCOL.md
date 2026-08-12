# WonRemote Codex Implementation Protocol

This is mandatory before Codex edits WonRemote code. An unchecked, skipped, stale, or unknown item blocks progression. Do not substitute a source-level fact for a build, release, or installed-runtime fact.

## Before Edit

- Record branch, HEAD, worktree status, requested scope, and prohibited actions.
- Define the defect as: actor, state, trigger, expected behavior, observed behavior.
- Complete the impact matrix: Viewer/Agent x x64/x86 x Firebase/local x dev/packaged/installed x install/update/restart. Mark each cell `TEST`, `INSPECT`, or `N/A` with a reason.
- Trace the real execution path through UI, backend, Tauri/Rust, packaging, installer, and installed runtime.
- Identify the focused regression test or reproducible failing command before editing. If the original failure path cannot be exercised locally, state that explicitly and do not claim runtime verification.

## Before Commit

- Review the complete diff and `git diff --check`.
- Run focused GREEN proof for the original failure boundary. Record command, exit code, and result.
- Revisit every affected impact-matrix cell, including Firebase/local fallbacks.
- For packaging or updater changes, inspect Viewer and Agent on both x64 and x86 paths.
- Verify configuration preservation, rollback/recovery behavior, lock cleanup, and durable failure logging where relevant.
- Report this state only as `SOURCE VERIFIED`. A commit does not prove a build, release, or installation.

## Before Release

- Start from a clean worktree at the exact tagged commit and create fresh artifacts only.
- Record role, architecture, filename, size, and SHA-256 for all four installers.
- Verify manifest version, tag, URLs, checksums, signatures, and public key.
- Verify the release contains exactly the four installers and one manifest, then verify every Firebase download redirect.
- Upgrade a prior installed Viewer and Agent; verify install, restart, retained configuration, target version, and recovery logs.
- Report evidence separately as `SOURCE`, `BUILD`, `RELEASE`, and `INSTALLED`.
- On any failure: stop, append `INCIDENT_REGISTRY.md`, find the root cause, add a regression guard, and only then retry. Never overwrite exposed release assets without explicit user approval.

## Non-Negotiable Rules

- A build does not install itself.
- A Git commit does not publish a release.
- A GitHub source push does not create update assets unless the release workflow completed successfully.
- A passing helper unit test does not prove its integration boundary.
- A repeated issue is not closed until its original trigger has a permanent regression guard.
