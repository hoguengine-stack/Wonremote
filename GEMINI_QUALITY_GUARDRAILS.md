# Gemini 작업 품질 가드레일

이 문서는 `aether-link` / `aether-link-poc` / `ZOOK_REPLACEMENT_PLAN.md` 작업에서 Gemini가 반드시 지켜야 할 운영 규칙이다.

목표는 다음 문제를 줄이는 것이다.

- 규칙 미준수
- 할루시네이션
- 실제 파일 상태와 다른 완료 보고
- 검증 없는 성공 선언
- 전체 파일 재작성으로 인한 기존 작업 훼손
- 저사양 PC 조건을 무시한 낙관적 설계

## 1. 최상위 원칙

1. 파일, 빌드, 테스트, 실행 결과는 직접 확인한 것만 사실로 말한다.
2. 확인하지 않은 내용은 반드시 `추정`, `가정`, `미확인`으로 표시한다.
3. 완료라고 말하기 전에 검증 명령을 실행하고 결과를 확인한다.
4. 사용자가 만든 변경사항은 절대 되돌리지 않는다.
5. 기존 문서는 전체 재작성하지 말고 필요한 부분만 교체한다.
6. 외부 제품의 코드, UI 자산, 비공개 프로토콜을 복제하지 않는다.
7. 저사양 타겟은 항상 `J1800/J1900 + RAM 2GB` 기준으로 판단한다.

## 2. 작업 시작 전 확인

작업을 시작할 때는 먼저 다음을 확인한다.

```powershell
Get-ChildItem -Force
git status --short
```

다른 경로에서 작업 중이면 정확한 경로를 확인한다.

```powershell
Test-Path -LiteralPath "<path>"
Get-ChildItem -LiteralPath "<path>" -Force
git -C "<path>" status --short
```

파일이 없으면 있다고 말하지 않는다. 예를 들어 `implementation_plan.md`가 없으면 "정비 완료"라고 말하면 안 된다.

## 3. 사실 보고 규칙

보고는 다음 네 가지로 구분한다.

- `확인됨`: 파일 또는 명령 출력으로 직접 확인한 사실
- `추정`: 현재 정보로 볼 때 가능성이 높은 해석
- `미확인`: 아직 명령, 파일, 실행 결과로 검증하지 않은 내용
- `결정 필요`: 사용자의 선택이나 외부 조건이 필요한 내용

금지 표현:

- "완벽히 완료"
- "완전히 검증됨"
- "문제 없음"
- "당연히 동작함"
- "파일이 있음"이라고 말하면서 `Test-Path`나 `Get-ChildItem` 확인이 없는 경우

허용 표현:

- "`cargo check --quiet` 결과 exit code 0"
- "`implementation_plan.md`는 현재 경로에 없음"
- "`screenshot_poc.png`와 `screenshot_poc_565.png`는 존재하지만 OCR/SSIM 검증은 미수행"

## 4. 파일 수정 규칙

기존 파일은 전체 삭제 후 재생성하지 않는다.

허용:

- 필요한 섹션만 교체
- 필요한 항목만 삽입
- 오탈자, 충돌 문구, 중복 문구만 부분 수정

금지:

- 전체 파일 삭제 후 새로 작성
- 사용자가 추가한 섹션을 임의 삭제
- 확인하지 않은 내용을 완료된 결과처럼 추가
- 다른 도구가 만든 변경사항을 되돌림

수정 전에는 어떤 부분을 바꿀지 짧게 말한다.

## 5. 검증 없는 완료 선언 금지

다음 말을 하기 전에 반드시 검증 명령을 실행한다.

- 완료
- 반영됨
- 통과
- 경고 없음
- 파일 존재
- 테스트 성공
- 빌드 성공

예시:

```powershell
Select-String -LiteralPath "ZOOK_REPLACEMENT_PLAN.md" -Encoding UTF8 -Pattern "T_presented|Worst-01|PLACEHOLDER"
& "C:\Users\qpalz\.cargo\bin\cargo.exe" check --quiet
git status --short
```

검증 결과가 실패하면 실패했다고 말한다.

## 6. 개발계획서 전용 규칙

`ZOOK_REPLACEMENT_PLAN.md`를 수정할 때는 다음을 지킨다.

1. `J1800/J1900 + RAM 2GB` 조건을 항상 유지한다.
2. `1080p 30fps`를 기본 목표로 쓰지 않는다.
3. `1920x1200` 벤치마크를 J1800/J1900 성능 입증으로 과장하지 않는다.
4. RGB565는 전체 프레임 direct streaming 방식으로 쓰지 않는다.
5. RGB565는 dirty tile 버퍼링과 타일 압축 전처리용 픽셀 포맷으로만 다룬다.
6. WebRTC는 기본 정답이 아니다. 자체 QUIC/UDP 경량 전송과 동등 후보로 비교한다.
7. PoC 성공 조건은 기존 ZOOK 대비 p95/p99 E2E 지연 개선을 필수로 둔다.
8. `T_decode_detect`와 `T_presented`를 구분한다.
9. 최종 E2E 지연은 `T_presented - T_start`로 정의한다.
10. `Worst-01`은 PoC 필수 통과 게이트다.

## 7. PoC 코드 전용 규칙

`aether-link-poc`는 현재 DXGI 캡처 + RGB565 변환 벤치마크다.

현재 범위에 포함된 것:

- DXGI Desktop Duplication 캡처
- GPU texture -> staging texture -> CPU memory 복사
- BGRA 32bit -> RGB565 16bit 변환
- 원본 PNG 저장
- RGB565 복원 PNG 저장
- 캡처/변환 시간 측정

현재 범위에 포함되지 않은 것:

- 네트워크 전송
- WebRTC
- QUIC/UDP 자체 전송
- 입력 주입
- Visual Ping
- 타일 diff
- dirty rect 압축
- Viewer 렌더링
- `T_presented` 측정

따라서 이 PoC 결과를 원격접속 전체 성능으로 말하면 안 된다.

## 8. 벤치마크 해석 규칙

로컬 벤치마크 결과는 다음 수준까지만 해석한다.

허용:

- "캡처 + RGB565 변환 경로가 유망하다"
- "현재 테스트 장비에서는 평균 내부 처리 지연이 낮다"
- "J1800/J1900 실장비 재측정이 필요하다"

금지:

- "J1800에서도 10ms 이하가 입증됨"
- "원격접속 지연 문제가 해결됨"
- "60fps 원격 전송 가능"
- "RGB565만으로 네트워크 문제 해결"

벤치마크 보고에는 항상 다음을 포함한다.

- CPU
- RAM
- GPU
- OS와 build
- 드라이버
- 실행 파일 경로
- debug/release 여부
- 측정 시간
- p50/p95/p99/max 여부

## 9. 코드 품질 규칙

Rust 프로젝트에서는 최소한 다음을 통과해야 한다.

```powershell
& "C:\Users\qpalz\.cargo\bin\cargo.exe" check --quiet
```

경고가 있으면 "경고 없음"이라고 말하지 않는다.

unused import, dead code, 미사용 변수는 가능한 한 바로 제거한다.

단, 성능 벤치마크 결과 파일이나 사용자가 만든 산출물을 임의 삭제하지 않는다.

## 10. 보안 및 법적 규칙

허용:

- 기존 ZOOK을 실행해 사용자 관점 기능 관찰
- 공개 API 기반 재구현
- 성능 비교
- 기능 매트릭스 작성

금지:

- ZOOK 실행 파일 디컴파일
- 바이너리 패치
- UI 이미지, 아이콘, 문구 복사
- 비공개 프로토콜 복제
- 라이선스 검토 없는 오픈소스 포함

## 11. 보고 형식

작업 결과는 다음 형식을 따른다.

```markdown
## 확인됨
- 직접 확인한 파일/명령 결과

## 변경함
- 실제 수정한 파일과 섹션

## 검증
- 실행한 명령
- 결과

## 남은 리스크
- 아직 검증되지 않은 부분
- 다음 작업에서 확인해야 할 부분
```

짧게 보고할 때도 최소한 `확인됨`, `검증`, `남은 리스크`는 구분한다.

## 12. 즉시 중단하고 사용자에게 물어야 하는 경우

다음 상황에서는 임의로 진행하지 않는다.

- 파일을 전체 재작성해야 할 것처럼 보이는 경우
- 사용자가 만든 변경사항과 충돌하는 경우
- 실제 파일에는 없는 문서를 있다고 보고해야 하는 경우
- J1800/J1900 실장비 결과가 없는데 성능 결론을 내려야 하는 경우
- ZOOK의 내부 구현을 복제해야만 가능해 보이는 경우
- 보안상 악용될 수 있는 기능을 우회 구현해야 하는 경우

## 13. Definition of Done

작업 완료 조건:

- 요청된 파일 또는 섹션이 실제로 수정됨
- 관련 검색으로 충돌 문구와 미완성 표식 확인
- 필요한 경우 빌드/체크 명령 실행
- 실패나 경고가 있으면 보고
- git status로 변경 범위 확인
- 남은 리스크를 명시

완료 조건을 만족하지 못하면 "완료"라고 말하지 않는다.

## 14. Gemini Simple Worker Mode

Gemini는 간단하고 독립적인 작업의 작업자로 사용할 수 있다. 단, 직접 수정은 CodeX가 명시한 파일과 범위 안에서만 허용한다.

직접 수정 가능한 작업:

- 지정된 파일의 명칭 교체, 오탈자 수정, stale 문구 제거
- 지정된 테스트 파일의 작은 회귀 테스트 추가
- 지정된 문서 섹션의 짧은 문구 보강
- 제한된 검증 명령 실행과 결과 보고

직접 수정하면 안 되는 작업:

- 버전 bump, tag, push, GitHub Release, manifest 변경
- installer/update/Firebase rules/Cloud Functions/TURN/UAC/Windows service 권한 경계의 독단 변경
- benchmark 수치 교체 또는 성능 결론 변경
- 사용자가 요청하지 않은 계획서, 감사 보고서, benchmark 문서 수정
- 전체 파일 재작성 또는 광범위 리팩터링

작업 중 범위 밖 파일이 바뀌면 즉시 중단하고 보고한다. 범위 밖 변경을 숨기거나 다음 작업에 묻어 가지 않는다.

### Worker Failure Gate

다음 보고는 실패 보고로 간주한다.

- 최신 명령 출력과 다른 테스트 개수, 통과 수, 커밋 해시, 파일 상태를 보고
- 요청받지 않은 benchmark, 계획서, 감사 보고서 상태를 단정
- 검증 범위 없이 "완벽히", "100%", "완전히", "입증", "문제 없음" 사용
- 직접 수정 금지 상태에서 파일 수정
- 허용 범위 밖 파일 변경을 숨김
- `git status --short --untracked-files=all` 없이 작업 트리가 깨끗하다고 보고
- 과거 출력값을 최신 결과처럼 재사용

실패 보고를 한 뒤에는 다음 작업에서 직접 수정 권한을 잃고, 읽기 전용 감사 또는 단일 명령 실행만 수행한다. 신뢰 회복 보고는 다음 세 줄만 허용한다.

- `직접 확인한 출력`: 실행한 명령과 실제 결과
- `확인하지 못한 항목`: 실행하지 않았거나 판단하지 못한 항목
- `수정 여부`: 수정 없음 또는 수정 파일 목록

### Quarantine Mode

Failure Gate 이후에도 잘못된 보고가 반복되면 Gemini는 Quarantine Mode로 강등된다.

Quarantine Mode 허용 범위:

- CodeX가 지정한 단일 명령 하나만 실행
- CodeX가 지정한 파일 하나만 읽기
- CodeX가 지정한 문자열만 검색
- 원문 출력 일부와 exit code만 보고

Quarantine Mode 금지 범위:

- CodeX가 명시하지 않은 검증 명령 실행
- 자체 해석, 완료 판정, 성능 판정, 릴리스 판정
- 파일 수정, diff 제안, 아티팩트 생성
- 이전 대화/이전 출력값을 최신 결과처럼 재사용

보고 형식:

```text
직접 실행/확인: <명령 또는 파일 경로>
원문 결과: <exit code 또는 지정 문자열 주변 원문>
수정 여부: 수정 없음
```

CodeX는 Quarantine Mode 보고를 로컬에서 재검증하기 전까지 채택하지 않는다.

### Useful Recovery Procedure

Gemini가 잘못된 테스트 수치, benchmark 수치, 커밋 해시, 작업트리 상태를 보고하면 단순 재교정 지시만 보내지 않는다. 다음 절차로 다시 쓸모 있는 작업 단위로 축소한다.

1. 실패한 보고 전체는 채택하지 않는다.
2. Gemini에게 실패 원인 설명이나 장문 사과를 요구하지 않는다.
3. 다음 요청은 반드시 `단일 명령 하나` 또는 `단일 파일 하나`로 제한한다.
4. Gemini의 응답은 Quarantine Mode 3줄 형식만 허용한다.
5. CodeX가 같은 명령을 로컬에서 재실행해 일치할 때만 그 결과를 사용한다.
6. Gemini가 연속 2회 Quarantine Mode 형식을 지키면 읽기 전용 감사자로만 복귀시킨다.
7. Gemini가 연속 3회 읽기 전용 감사에서 범위 밖 판단 없이 정확히 보고하면 작은 수정 작업자로만 복귀시킨다.

Gemini에게 맡기기 좋은 복구 작업:

- 특정 파일 하나에서 특정 문자열 존재 여부 확인
- 특정 테스트 파일 하나만 실행하고 exit code와 마지막 20줄 보고
- `git diff -- <file>` 한 파일 출력 확인
- CodeX가 지정한 문구가 문서에 남아 있는지 `rg`로 확인

Gemini에게 맡기면 안 되는 복구 작업:

- 전체 테스트 개수 최종 보고
- benchmark 문서 해석
- 릴리스 가능 여부 판단
- 전체 프로젝트 완료율 산정
- 여러 파일을 읽고 종합 결론 작성

### Mandatory Wait Gate

CodeX가 Gemini 또는 Antigravity에 검증 요청을 보낸 경우, Gemini 응답을 확인하기 전에는 작업 완료 보고를 하지 않는다.

필수 절차:

1. `tools/send-antigravity-handoff.ps1`를 사용할 때는 검증 요청에 `-WaitForResponse`를 붙인다.
2. Quarantine Mode 요청에는 `-StrictQuarantineResponse`를 같이 붙인다.
3. 응답이 타임아웃되면 Gemini 결과는 `미응답`으로 기록하고 채택하지 않는다.
4. 응답이 Quarantine Mode 형식을 어기면 Gemini 결과는 `무효`로 기록하고 채택하지 않는다.
5. Gemini 응답을 채택하려면 CodeX가 같은 사실을 로컬 명령으로 재검증한다.

### Antigravity Worker Disable Gate

기존 대화가 오염되었거나 새 대화에서도 Gemini가 지정된 파일/문자열 작업 대신 임의 도구 실행, 장문 보고, 대기 문구를 반환하면 Gemini를 보조 작업자로 쓰지 않는다.

비활성화 조건:

- `tools/send-gemini-worker-task.ps1`로 보낸 단일 파일/단일 문자열 작업에서 형식 위반
- 기대 문자열 누락
- Gemini가 요청하지 않은 `list_dir`, `git`, 테스트, 문서 작성, 분석 도구 실행
- "기다리겠다", "준비되어 있다"처럼 산출물이 아닌 대기 응답 반환

비활성화 이후:

- Gemini/Antigravity에는 추가 토큰을 쓰지 않는다.
- 필요한 병렬 보조 작업은 Codex 내부 `multi_agent` worker에 맡긴다.
- Gemini를 다시 쓰려면 사용자가 새 모델/새 대화에서 간단한 단일 작업 성공을 먼저 확인해야 한다.

## 15. Completion Scope Reporting Gate

프로젝트 전체 진척도, 개발 완료 여부, 잔여 범위를 보고할 때는 릴리스보다 더 보수적으로 말한다.

금지 표현:

- "100% 완료"
- "Feature-Complete"
- "소프트웨어 구현 100% 완료"
- "실장비 검증만 남음"
- "로컬 테스트가 모두 통과했으므로 개발 완료"

위 표현은 다음 조건을 모두 직접 확인한 경우에만 예외적으로 쓸 수 있다.

- `J1800/J1900 실장비 물리 검증`을 제외한 P0/P1 잔여 항목이 없음
- Firebase 보안 규칙 또는 Cloud Functions 서버 측 검증이 운영 기준으로 적용됨
- NAT/P2P/TURN 운영 경로가 실제 외부망 조건에서 검증됨
- DXGI/GDI fallback, SendInput/UAC/UIPI 경계, stream 재시작, session recovery가 테스트 또는 E2E로 확인됨
- 파일 전송, 클립보드, 전체화면, 다중 모니터, 자동 업데이트/롤백이 최신 HEAD 기준으로 검증됨
- `git status --short --untracked-files=all` 기준 미정리 변경이 없고, 최신 테스트 수치를 직접 실행해 확인함

위 조건 중 하나라도 빠지면 다음 형식으로만 보고한다.

- `구현됨`: 코드와 테스트로 확인된 항목
- `부분 구현`: 경로는 있으나 운영 검증, 보안 검증, 외부망 검증, 권한 경계 검증이 빠진 항목
- `미완성/P0`: 릴리스 전 반드시 끝내야 하는 항목
- `실장비 검증`: 물리 장비에서만 확인 가능한 항목

진척도는 낙관 수치 하나로 쓰지 말고, 최소한 `기능 골격`, `실사용 MVP`, `상용 원격제어 안정성` 기준을 분리해 보수적으로 산정한다.

## 16. Release Gate

버전 bump, tag, push, GitHub Release, 자동 업데이트 manifest 갱신은 일반 작업 완료보다 더 엄격하게 판단한다.

릴리스 진행 전 필수 조건:

- 사용자가 요청한 기능 중 `J1800/J1900 실장비 물리 검증`만 제외하고 P0/P1 미완성 항목이 남아 있지 않음
- 원격 화면, 입력, 파일/클립보드, 전체화면/다중 모니터, 재접속/업데이트, Viewer/Agent 설치 모드 분리, Firebase 운영 경로가 코드와 테스트로 확인됨
- `npm test`, `npm run build`, 관련 Rust `cargo test`, 필요한 E2E 검증이 최신 HEAD에서 통과함
- `git status --short --untracked-files=all` 기준 의도하지 않은 변경이나 생성물이 없음
- Gemini 또는 별도 검토자에게 미완성 항목 감사를 요청했고, 답변의 P0/P1 항목을 반영하거나 명시적으로 보류 근거를 기록함

금지:

- 일부 테스트가 통과했다는 이유만으로 새 버전 번호를 올리거나 push/release 하지 않는다.
- PoC, placeholder, fallback, 검증 필요 상태가 남은 기능을 완성 기능처럼 릴리스 노트에 쓰지 않는다.
- 사용자가 명시적으로 요청하지 않는 한 미완성 빌드를 final release로 게시하지 않는다.
- 이미 게시한 검증용 릴리스는 final로 주장하지 말고, 필요한 경우 `RC`, `검증 빌드`, `미완성 기능 있음`으로 구분한다.

## 17. Failure And Recurrence Prevention Gate

These rules apply to every production defect, test failure, installer failure, update failure, crash, timeout, or unexpected runtime behavior.

1. Stop release mutation immediately after a failed command, crash, timeout, skipped test, missing artifact, or partial publish. Do not create or move a tag, upload a manifest, or claim success until the failure has a recorded root cause and a fresh passing proof.
2. A retry is not a fix. Re-running a command until it passes is prohibited unless the root cause, changed files, and the focused regression proof are recorded first.
3. Every fixed production defect requires a focused regression test that exercises the original failure boundary. A unit test for a helper is insufficient when the defect occurred at an integration boundary.
4. Every release proof must state the exact commit, tag, working directory, command, exit code, UTC timestamp, artifact filenames, file sizes, and SHA-256 values. Old reports, screenshots, and remembered test counts are never evidence.
5. A build only proves that an artifact was produced. It does not prove installation, startup, update discovery, download, verification, restart, or runtime behavior.
6. The current approved release contract is exactly two x86 installers (`WonRemote-Viewer-Setup.exe` and `WonRemote-Agent-Setup.exe`) plus one signed manifest on the same GitHub tag. The x86 installers are the supported payloads on both 32-bit and 64-bit Windows. Partial release assets must not be treated as `latest`; deletion or replacement of exposed assets requires explicit user approval.
7. Update failures must fail closed: never run an unsigned, malformed, wrong-architecture, or checksum-mismatched installer. Preserve the active installation and configuration, clear in-flight locks on every terminal path, and write a durable stage-specific log.
8. The installed Tauri Viewer must perform manual update checks through the native signed updater. WebView direct fetch of GitHub release assets is forbidden for installed-app update checks because redirect CORS behavior is not a stable runtime contract.
9. Every path passed to bundled Node.js must be derived from the normalized Node resource root. Windows verbatim paths (`\\?\\`) must never reach Node executable, script, restart, or environment arguments.
10. Before a release is declared usable, verify the published manifest and the four supported Firebase aliases (`viewer`, `agent`, `viewer-x86`, `agent-x86`) against the same tag. The aliases must resolve to the two approved x86 installers; portable and separate x64 artifacts are outside the current release contract.
11. Before declaring any production defect fixed, append an entry to `INCIDENT_REGISTRY.md` using its required format. The entry must name the original symptom, root cause, fix commit, focused regression proof, release evidence, and verification status. This is mandatory for new incidents and must not be replaced by a chat summary.
12. Before Codex edits code, follow `CODEX_IMPLEMENTATION_PROTOCOL.md`. It is mandatory to distinguish source, build, release, and installed-runtime evidence and to complete the affected mode/architecture matrix.
13. Register every newly observed failure in `INCIDENT_REGISTRY.md` as `open` before implementing its fix. The same change set must update that entry with root cause, permanent guard, and focused proof. Deferring registration until the user asks about recurrence prevention is prohibited.
14. A defect at a process, Firebase signaling, installer, update, architecture, or UI-to-native boundary remains open until a test crosses that same boundary. Helper-only unit tests may supplement but never replace the boundary regression test.
15. Every defect-oriented commit, including `Fix`, `Retry`, `Repair`, `Prevent`, `Recover`, and release/update/runtime-related `Harden`, `Align`, `Prepare`, `Split`, `Limit`, `Reduce`, `Speed up`, or `Keep` commits, must contain an `Incident: INC-YYYYMMDD-NNN` trailer. The referenced entry must already exist in `INCIDENT_REGISTRY.md` with every required field. The release workflow must run `npm run recurrence:verify` before expensive tests or packaging.
16. A failed CI run is itself an incident artifact. Record its run ID, failing step, root cause or explicitly `unknown`, and the first passing run. Splitting a diagnostic step or retrying an API is not closure unless the underlying failure is identified and guarded.

## Mandatory Current Baseline Protocol

Before every report, run these commands from `C:\Users\qpalz\Documents\remote` and paste the actual values into the report:

```powershell
git fetch origin
git rev-parse --short HEAD
git rev-parse --short origin/main
git status --short --untracked-files=all
git log --oneline -5
```

Rules:

- Do not reuse an older baseline from memory, notes, previous reports, or screenshots.
- Do not report `e68e256` as the baseline unless `git rev-parse --short HEAD` actually prints `e68e256`.
- The pushed baseline changes after every commit. Never copy a hard-coded commit hash from this document; report only the command output.
- Do not report `aether-link-app/scripts/check-registry-status.bat` as untracked unless `git status --short --untracked-files=all` prints it.
- Do not report `npm test: 53 passed` unless the latest `npm test` output says 53. The current suite has 55 tests after the Agent 404 recovery tests.
- Bundle file sizes must be measured fresh with `Get-Item ... | Select-Object FullName,Length`. Do not copy old byte counts.
- If `HEAD` and `origin/main` differ, say exactly which side is ahead/behind before making any implementation claim.
