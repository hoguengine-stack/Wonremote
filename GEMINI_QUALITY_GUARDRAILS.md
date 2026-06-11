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
- As of 2026-06-12, the known pushed baseline is `f1686e6`; if the command output differs, report the command output, not this sentence.
- Do not report `aether-link-app/scripts/check-registry-status.bat` as untracked unless `git status --short --untracked-files=all` prints it.
- Do not report `npm test: 53 passed` unless the latest `npm test` output says 53. The current suite has 55 tests after the Agent 404 recovery tests.
- Bundle file sizes must be measured fresh with `Get-Item ... | Select-Object FullName,Length`. Do not copy old byte counts.
- If `HEAD` and `origin/main` differ, say exactly which side is ahead/behind before making any implementation claim.
