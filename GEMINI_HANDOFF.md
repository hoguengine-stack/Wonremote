# Gemini Handoff Commands

이 파일은 Gemini에게 맡길 작업을 줄 때 그대로 붙여 넣기 위한 명령서다. Gemini는 구현을 독단으로 크게 바꾸지 말고, 검증 자료 정리와 누락 체크에 집중한다.

## 현재 활성 지시 우선 규칙

이 문서의 아래쪽에 남아 있는 과거 작업 지시, 벤치마크 검토 문구, 차수별 기록은 모두 `기록 전용`이다. Gemini가 실제로 수행할 작업은 CodeX가 대화창에 방금 붙여 넣은 `현재 요청` 하나뿐이다.

Gemini는 다음 규칙을 먼저 적용한다.

1. CodeX가 명시한 단일 명령, 단일 파일, 단일 검색어만 수행한다.
2. CodeX가 명시하지 않은 `npm test`, benchmark 읽기, 계획서/감사 보고서 판단, git 상태 판단은 수행하지 않는다.
3. 과거 섹션에 적힌 benchmark 수치, 테스트 개수, 커밋 해시는 최신 사실로 재사용하지 않는다.
4. 보고서에 수치를 쓰려면 그 수치를 만든 최신 명령 출력 또는 파일 경로를 같은 줄에 적는다.
5. 이 규칙을 어기면 해당 결과는 `무효`이고, Gemini는 Quarantine Mode로 강등된다.

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
10. 버전 bump, tag, push, GitHub Release, 자동 업데이트 manifest 갱신은 `J1800/J1900 실장비 물리 검증`을 제외한 P0/P1 미완성 항목이 모두 해소된 뒤에만 허용한다. 테스트 일부 통과만으로 릴리스하지 않는다.
11. 이미 게시된 `v0.1.23`은 최종 완성 릴리스로 주장하지 말고 검증 빌드/RC 성격으로만 취급한다. latest download/auto-update 링크를 깨뜨릴 수 있는 삭제나 prerelease 전환은 사용자 승인 없이 하지 않는다.
12. 프로젝트 전체 진척도 보고에서 "100% 완료", "Feature-Complete", "소프트웨어 구현 100% 완료", "실장비 검증만 남음"이라고 쓰지 않는다. Firebase Cloud Functions/Rules, TURN 운영 경로, DXGI/GDI/UAC/재접속 안정성, 파일 전송 운영화, 최신 테스트와 git status가 모두 확인되지 않았으면 반드시 `부분 구현` 또는 `미완성/P0`로 분류한다.
13. 완료율은 단일 숫자로 단정하지 말고 `기능 골격`, `실사용 MVP`, `상용 원격제어 안정성` 기준을 분리해 보수적으로 보고한다. 사용자가 "얼마나 남았는지"를 물으면 먼저 남은 P0/P1을 나열하고, 그 다음에 보수적 퍼센트를 제시한다.

## Gemini Simple Worker Mode

Gemini는 앞으로 간단하고 독립적인 작업의 작업자로 활용한다. 단, 아래 조건을 지키지 못하면 즉시 검토자 모드로만 동작한다.

직접 수정 허용 작업:

- 지정된 파일 안의 명칭 교체, 오탈자 수정, stale 문구 제거
- 지정된 테스트 파일에 작은 회귀 테스트 추가
- 지정된 문서 섹션의 짧은 보수적 문구 보강
- `rg`, `git diff`, `git status`, `npm test -- <file>` 같은 제한된 검증 명령 실행
- CodeX가 명시한 파일 목록과 범위 안에서만 최소 수정

직접 수정 금지 작업:

- 버전 bump, tag, push, GitHub Release, manifest 변경
- installer, update, Firebase rules, Cloud Functions, TURN, UAC/서비스 권한 경계의 독단 설계 변경
- benchmark 수치 교체 또는 성능 결론 변경
- 사용자가 요청하지 않은 계획서, 감사 보고서, benchmark 문서 수정
- 전체 파일 재작성, 광범위 리팩터링, 여러 기능을 한 번에 바꾸는 작업

작업자 모드 보고 형식:

1. `수정한 파일`: 실제 변경한 파일만 나열한다.
2. `검증`: 직접 실행한 명령과 결과만 쓴다.
3. `범위 밖 변경`: 있으면 즉시 보고하고 되돌릴지 묻는다.
4. `다음 CodeX 확인 필요`: CodeX가 이어서 검토해야 할 항목만 쓴다.

중요: CodeX가 `직접 수정 허용`이라고 명시하지 않은 요청은 수정하지 말고 diff 제안 또는 감사 결과만 보고한다.

### Gemini Worker Failure Gate

다음 중 하나라도 발생하면 해당 Gemini 보고서는 `무효`로 처리하고, 다음 작업에서 Gemini는 직접 수정 작업자가 아니라 읽기 전용 감사자 또는 단일 명령 실행자로 강등한다.

- 최신 명령 출력과 다른 테스트 개수, 통과 수, 커밋 해시, 파일 상태를 보고함
- CodeX가 요청하지 않은 benchmark, 계획서, 감사 보고서 상태를 단정함
- `완벽히`, `100%`, `완전히`, `입증`, `문제 없음` 같은 금지 표현을 검증 범위 없이 사용함
- 직접 수정 금지 요청에서 파일을 수정하거나, 허용 범위 밖 파일을 언급 없이 변경함
- `git status --short --untracked-files=all` 없이 "수정 없음", "깨끗함", "변경 없음"을 보고함
- 실행하지 않은 명령을 실행한 것처럼 쓰거나, 과거 출력값을 최신 결과로 재사용함

실패 이후 복구 절차:

1. Gemini는 잘못 보고한 문장과 근거 없는 수치를 먼저 인정한다.
2. 최신 preflight와 요청받은 단일 검증 명령만 다시 실행한다.
3. 보고는 `직접 확인한 출력`, `확인하지 못한 항목`, `수정 없음/있음` 세 줄로 제한한다.
4. CodeX가 신뢰 회복을 확인하기 전까지 Gemini는 파일 수정 금지 상태로 둔다.

### Gemini Quarantine Mode

Failure Gate 이후에도 잘못된 수치, 과장 표현, 범위 밖 문서 단정, 임의 명령 실행이 반복되면 Gemini는 `Quarantine Mode`로 강등한다.

Quarantine Mode에서 Gemini에게 허용되는 작업:

- CodeX가 지정한 단일 명령 하나만 실행
- CodeX가 지정한 파일 하나만 읽기
- 명령 출력 또는 파일 내용에서 CodeX가 지정한 문자열만 찾기
- 결과를 해석하지 않고 원문 출력 일부와 exit code만 보고

Quarantine Mode에서 금지되는 작업:

- `npm test`, `npm run build`, `git status` 등 CodeX가 명시하지 않은 명령 실행
- "완료", "통과", "문제 없음", "입증", "정합성" 같은 판단 표현 사용
- benchmark, 계획서, 감사 보고서, 릴리스 상태에 대한 자체 판단
- 파일 수정, diff 제안, 새 아티팩트 생성
- 과거 대화나 이전 출력값을 최신 결과처럼 재사용

Quarantine Mode 보고 형식은 아래 3줄을 벗어나면 안 된다.

```text
직접 실행/확인: <명령 또는 파일 경로>
원문 결과: <exit code 또는 지정 문자열 주변 원문>
수정 여부: 수정 없음
```

CodeX는 Quarantine Mode Gemini 보고를 채택하기 전에 반드시 로컬 명령으로 재검증한다. 재검증 전까지 Gemini 결과는 참고자료가 아니라 `미검증 입력`으로만 취급한다.

### Mandatory Wait Gate

CodeX가 Gemini 검증 요청을 보냈으면 Gemini 응답을 확인하기 전에는 작업 완료 보고를 하지 않는다. `tools/send-antigravity-handoff.ps1`를 사용할 때 검증 요청에는 `-WaitForResponse`를 붙이고, Quarantine Mode 요청에는 `-StrictQuarantineResponse`를 같이 붙인다. 타임아웃 또는 형식 위반 응답은 채택하지 않는다.

### Antigravity Worker Disable Gate

새 대화에서도 Gemini가 단일 파일/단일 문자열 작업 대신 임의 도구 실행, 장문 보고, 대기 문구를 반환하면 Gemini/Antigravity에는 추가 토큰을 쓰지 않는다. 이후 병렬 보조 작업은 Codex 내부 `multi_agent` worker를 사용한다.

## 기록 전용: 과거에 맡겼던 작업

이 섹션 아래 내용은 과거 작업 기록이다. CodeX가 현재 대화창에서 이 섹션을 다시 인용하지 않는 한 실행하지 않는다.

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

## 기록 전용: Gemini에게 줬던 과거 프롬프트

이 섹션 아래 내용은 과거 프롬프트 기록이다. CodeX가 현재 대화창에서 다시 붙여 넣지 않는 한 실행하지 않는다.

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
