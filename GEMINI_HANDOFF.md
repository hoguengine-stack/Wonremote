# Gemini Handoff Commands

이 파일은 Gemini에게 맡길 작업을 줄 때 그대로 붙여 넣기 위한 명령서다. Gemini는 구현을 독단으로 크게 바꾸지 말고, 검증 자료 정리와 누락 체크에 집중한다.

## 공통 규칙

1. 먼저 `C:\Users\qpalz\Documents\remote\GEMINI_QUALITY_GUARDRAILS.md`를 읽고 따른다.
2. 파일 전체를 새로 만들거나 덮어쓰지 말고, 필요한 부분만 최소 수정한다.
3. 실제 확인하지 않은 내용은 "검증 필요"로 표시한다.
4. `TODO`, `TBD`, `미정`, "완벽", "확실", "입증" 같은 표현을 근거 없이 쓰지 않는다.
5. 수치가 있으면 반드시 출처 파일과 실행 명령을 같이 적는다.
6. `J1800/J1900 + RAM 2GB`에서 직접 측정하지 않은 결과를 타겟 성능으로 단정하지 않는다.
7. 차수별 기록이 있으면 가장 높은 차수를 기준으로 판단하고, 낮은 차수는 이력으로만 본다.
8. 9차 기준으로 실장비 성능 검증은 후순위이며, 먼저 사용 가능한 프로그램 흐름 구현을 우선한다.
9. 18차 기준으로 `aether-link-app`은 로컬 API 서버, 파일 기반 장비 저장소, Agent heartbeat/offline 판정, 메모리 기반 Agent command queue, `/?mode=agent` Agent 최초 실행 화면, `npm run agent`/`npm run agent:watch` 로컬 Agent CLI, Rust PoC 기반 32x32 JPEG 타일 stream, API `/api/sessions/:id/tiles`, Viewer Canvas 부분 렌더링을 사용한다. 설치형 Agent EXE/Windows 서비스, 상용 DB, Visual Ping `T_presented` 정밀 계측, 물리 입력 위치 정합성은 아직 검증 필요 상태다.

## 이번에 맡길 작업

아래 파일들을 읽고, 계획서와 감사 문서 사이의 충돌, 과장, 누락을 찾아 최소 수정 제안만 작성해라.

- `C:\Users\qpalz\Documents\remote\ZOOK_REPLACEMENT_PLAN.md`
- `C:\Users\qpalz\Documents\remote\aether-link-poc\WEEK2_AUDIT_REPORT.md`
- `C:\Users\qpalz\Documents\remote\aether-link-poc\benchmark_results.json`
- `C:\Users\qpalz\Documents\remote\aether-link-app`

특히 다음을 확인해라.

1. `60fps 안정 구동`, `47.79fps`, `15.77fps`처럼 서로 충돌하는 벤치마크 수치를 구분해라.
2. `benchmark_results.json`의 최신 실행 결과를 기준으로 문서의 과장 표현을 낮춰라.
3. schema v2의 프로세스 CPU/메모리/thread, user/kernel CPU split, 캡처 루프 통계가 문서에 정확히 반영되었는지 확인해라.
4. `J1800/J1900 + RAM 2GB`에서 아직 검증되지 않은 주장을 모두 표시해라.
5. Visual Ping, `T_presented`, ZOOK baseline, 네트워크 왕복, TURN relay가 빠진 상태에서 PoC 합격으로 읽히는 문장을 찾아라.
6. 수정이 필요하면 unified diff 형식으로 필요한 줄만 제안해라. 파일 전체 재작성은 금지한다.
7. 차수별 기록에서는 가장 높은 차수를 우선 기준으로 삼고, 낮은 차수 내용과 충돌하면 높은 차수 기준으로 정리해라.
8. 현재 우선순위는 실장비 성능 측정 패키지가 아니라 관리자 로그인, Agent 계정 기반 접속, 장비 자동 등록, 기본 원격 세션 골격 구현이다.
9. 18차 기준으로 Viewer 세션 입력은 Agent command queue에 적재되고, Agent CLI는 `/api/agent/commands` polling으로 pending 명령을 가져간 뒤 큐를 비워야 한다. 세션 시작 시 `start-stream`, 세션 종료 시 `stop-stream` 명령이 적재되어 Agent가 필요한 동안만 Rust stream을 구동해야 한다.

## Gemini에게 줄 최종 프롬프트

```text
너는 WonRemote 원격 제어 PoC의 보수적 감사 담당이다.

다음 규칙을 반드시 지켜라.
- C:\Users\qpalz\Documents\remote\GEMINI_QUALITY_GUARDRAILS.md를 먼저 읽고 따른다.
- 파일 전체를 재작성하지 말고 필요한 부분만 최소 수정 제안한다.
- 실제 실행/측정하지 않은 내용은 단정하지 않는다.
- 특히 J1800/J1900 + RAM 2GB 성능, 기존 ZOOK 대비 개선, Visual Ping E2E 지연은 직접 측정 전까지 검증 필요로 둔다.
- 차수별 기록에서는 가장 높은 차수를 최신 기준으로 본다.
- 9차 기준으로 실장비 성능 검증은 프로그램 구현 후 필요 시 수행하는 후순위 게이트다.
- 18차 기준으로 `aether-link-app`은 로컬 API 서버, 파일 기반 장비 저장소, Agent heartbeat/offline 판정, 메모리 기반 Agent command queue, `/?mode=agent` Agent 최초 실행 화면, `npm run agent`/`npm run agent:watch` 로컬 Agent CLI, Rust PoC 기반 32x32 JPEG 타일 stream, API `/api/sessions/:id/tiles`, Viewer Canvas 부분 렌더링을 사용한다. Viewer 세션 입력은 Agent command queue에 적재되고, Agent CLI는 `/api/agent/commands` polling으로 pending 명령을 가져간 뒤 큐를 비워야 한다. 실제 Win32 `SendInput` 호출 경로와 반환값 검사는 있으나, 물리 입력 위치 정합성/권한 경계/Visual Ping `T_presented` 정밀 계측/큐 영구 저장은 아직 검증 필요 상태다.

검토 대상:
- C:\Users\qpalz\Documents\remote\ZOOK_REPLACEMENT_PLAN.md
- C:\Users\qpalz\Documents\remote\aether-link-poc\WEEK2_AUDIT_REPORT.md
- C:\Users\qpalz\Documents\remote\aether-link-poc\benchmark_results.json
- C:\Users\qpalz\Documents\remote\aether-link-app

해야 할 일:
1. 문서와 앱 구현 사이의 수치 충돌, 과장 표현, 미검증 주장을 찾아라.
2. benchmark_results.json의 최신 결과와 충돌하는 문장을 표시해라.
3. schema v2의 프로세스 CPU/메모리/thread, user/kernel CPU split, 캡처 루프 통계가 누락된 문장을 찾아라.
4. Viewer 입력 이벤트의 command queue 적재, Agent CLI command polling, polling 후 큐 비움, `start-stream`/`stop-stream` 기반 stream 제어, `/api/sessions/:id/tiles` POST/GET/clear, Viewer Canvas 렌더링, 기존 heartbeat/파일 저장소 흐름과의 충돌 여부가 문서와 테스트에 누락되지 않았는지 확인해라.
5. 수정이 필요한 경우 unified diff로 필요한 줄만 제안해라.
6. 직접 검증하지 않은 코드를 실행했다고 말하지 마라.
```

## 19차 기준 추가 지시
- `aether-link-app/src/domain/visualPing.ts`가 Visual Ping의 마젠타 마커 판정, `T_presented - T_start` 계산, rAF 이후 픽셀 샘플링, 지연 기반 `set-sleep` 명령 선택을 담당한다.
- `aether-link-app/src/domain/visualPing.test.ts`의 5개 테스트가 이 기준을 고정하므로, Visual Ping 관련 변경 시 이 테스트를 먼저 갱신하고 실패를 확인한 뒤 구현한다.
- Viewer App은 Rust stream이 보낸 좌상단 32x32 마젠타 타일을 Canvas에 그린 뒤 `requestAnimationFrame` 콜백에서 `(5,5)` 픽셀을 읽어 측정한다.
- 이 구현은 브라우저 Canvas 표시 시점 기반 PoC이며, 실제 모니터 물리 표시/GPU fence, ZOOK baseline, J1800/J1900 실장비 성능을 통과한 것으로 쓰면 안 된다.

## Current Baseline Handoff Rule

Before doing any work or writing any report, run this preflight from `C:\Users\qpalz\Documents\remote`:

```powershell
git fetch origin
git rev-parse --short HEAD
git rev-parse --short origin/main
git status --short --untracked-files=all
git log --oneline -5
```

Use the command output as the only source of truth.

Do not report:

- baseline `e68e256` unless `git rev-parse --short HEAD` prints `e68e256`
- `check-registry-status.bat` as untracked unless `git status` prints it
- `npm test: 53 passed` unless the latest test output prints 53
- old bundle byte counts copied from a previous report

The pushed baseline changes after every commit. Never copy a hard-coded commit hash from this document; report only the command output. The working tree should be clean before the next physical Windows install/reboot validation.
