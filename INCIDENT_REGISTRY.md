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
