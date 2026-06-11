# Week 2 PoC Audit

## 결론

Week 2 PoC는 `32x32` dirty-tile 검출, TurboJPEG 타일 압축/복원, JSON 계측 출력까지는 동작한다. 하지만 아직 `J1800/J1900 + RAM 2GB` 타겟, 기존 ZOOK 대비 지연 개선, 네트워크 왕복, `T_presented` 기준 E2E 지연은 증명되지 않았다.

따라서 이 결과는 "로컬 고사양 PC에서 타일 차분 경로가 실행된다"는 중간 증거로만 사용하고, PoC 합격 근거로 쓰면 안 된다.

## 기준 위치

- 작업본: `C:\Users\qpalz\Documents\remote\aether-link-poc`
- scratch 원본: `C:\Users\qpalz\.gemini\antigravity\scratch\aether-link-poc`
- 벤치마크 JSON: `C:\Users\qpalz\Documents\remote\aether-link-poc\benchmark_results.json`
- 복원 이미지: `C:\Users\qpalz\Documents\remote\aether-link-poc\screenshot_poc_tiles.png`

scratch 경로는 참고용이다. 이후 검증과 수정은 workspace 작업본을 기준으로 한다.

## 확인된 사실

- `cargo test --quiet` 통과: 6개 테스트 통과.
- `cargo run --release --quiet --bin aether-link-poc` 실행 완료.
- 실행 결과 `benchmark_results.json`과 `screenshot_poc_tiles.png`가 생성됨.
- JSON에 CPU, RAM, OS, video controller, DXGI adapter/output, p50/p95/p99/max 지연 통계가 기록됨.
- JSON schema v2부터 실행 옵션, 프로세스 CPU/메모리/thread, user/kernel CPU split, 캡처 루프 timeout/access lost/error/dirty frame 통계가 기록됨.
- 실행 시 DXGI 선택 adapter는 `Intel(R) UHD Graphics 730`, output은 `\\.\DISPLAY1`.
- Mirage Driver가 함께 감지되므로 DXGI 경로 해석에는 주의가 필요함.

## 실행 방법

기본 실행:

```powershell
cargo run --release --quiet --bin aether-link-poc
```

30초 반복 측정:

```powershell
cargo run --release --quiet --bin aether-link-poc -- --duration 30
```

사용 가능한 옵션:

- `--duration <seconds>`: 측정 시간. 기본값 `5`.
- `--output <file.json>`: 결과 JSON 파일명. 생략 시 `benchmark_<unix_ms>_<width>x<height>.json` 자동 생성.
- `--snapshot <file.png>`: 복원 이미지 파일명. 기본값 `screenshot_poc_tiles.png`.
- `--loop-sleep-ms <ms>`: 캡처 루프 sleep. 기본값 `1`, `0`이면 sleep 없음.
- `--capture-timeout-ms <ms>`: DXGI `AcquireNextFrame` timeout. 기본값 `16`.

항상 실행별 JSON 파일과 최신 alias인 `benchmark_results.json`을 함께 보존한다.

## 2026-06-09 재측정 결과

환경:

- CPU: `11th Gen Intel(R) Core(TM) i5-11400 @ 2.60GHz`
- RAM: `16980238336` bytes
- OS: `Microsoft Windows 11 Pro`, build `26100`
- Video controllers: `Mirage Driver`, `Intel(R) UHD Graphics 730`
- 해상도: `1920x1200`
- 총 타일: `2280`

계측:

| 항목 | 값 |
| --- | ---: |
| frame_count | 79 |
| avg_fps | 15.77 |
| avg_dirty_tiles | 86.44 |
| dirty_ratio | 3.79% |
| avg_actual_jpeg | 59.32KB/frame |
| avg_actual_bandwidth | 935.56KB/s |
| internal avg | 17.35ms |
| internal p95 | 40.97ms |
| internal p99/max | 111.88ms |
| capture avg / p95 / max | 10.49ms / 32.97ms / 38.17ms |
| RGB565 avg / p95 / max | 3.08ms / 6.39ms / 8.12ms |
| tile diff avg / p95 / max | 1.13ms / 3.58ms / 7.79ms |
| dirty-tile JPEG avg / p95 / max | 2.65ms / 15.09ms / 86.42ms |

## 비관적 해석

- 최신 재측정 FPS는 `15.77fps`로, 이전에 보고된 `47.79fps` 또는 `60.56fps`와 충돌한다. 원인 분석 전까지 "안정적 60fps" 주장은 금지한다.
- `actual_internal_pipeline p99/max = 111.88ms`가 이미 고사양 PC에서 튄다. J1800/J1900에서는 full-screen 변화, 스크롤, 가상 드라이버, 백신, 메모리 압박 상황에서 더 악화될 가능성이 크다.
- 현재 내부 지연은 캡처, RGB565 변환, diff, JPEG까지만 포함한다. 입력 주입, 네트워크, 디코드, 렌더 present, TURN relay는 빠져 있다.
- CPU 사용률, user/kernel CPU split, working set, thread count는 schema v2에서 기록된다. 다만 context switching, 시스템 전체 CPU 경쟁, 2GB RAM 압박은 아직 기록되지 않는다.
- ZOOK baseline이 없으므로 "기존보다 빠르다"는 판단은 아직 불가능하다.

## Gemini 보고서 검토 결과

`WEEK2_AUDIT_REPORT.md`의 보수적 지적 중 즉시 반영 가능한 항목은 schema v2에 반영했다.

- 반영됨: working set, private memory, thread count, 전체 CPU 사용률, user/kernel CPU split.
- 이미 반영됨: FPS 충돌을 `60.56fps`, `47.79fps`, `15.77fps`로 분리하고 "안정적 60fps" 결론 금지.
- 남은 항목: context switching/sec 계측, `--mode capture-only|encode-only|loopback-full` 파이프라인 격리 측정, 정적/동적 화면 자극 표준화.
- 남은 핵심 검증: J1800/J1900 실장비, 기존 ZOOK baseline, Visual Ping `T_presented - T_start`, 네트워크 왕복.

## 다음 필수 게이트

1. 같은 바이너리를 `J1800/J1900 + RAM 2GB`에서 `1024x768`, `1600x900`, `1080x1920`로 각각 30초 이상 반복 측정한다.
2. `benchmark_results.json`을 각 환경별로 보존하고, 평균이 아니라 p95/p99/max를 합격 기준으로 본다.
3. FPS 충돌 원인을 먼저 조사한다. `AcquireNextFrame` timeout, `tokio::sleep(1ms)`, 화면 변화량, Mirage Driver, release 실행 조건을 분리한다.
4. 기존 ZOOK의 Visual Ping `T_presented - T_start` baseline을 먼저 측정한다.
5. 네트워크 전송을 붙이기 전까지 Week 2 결과를 PoC 합격 증거로 사용하지 않는다.
