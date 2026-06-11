# AetherLink App

17차 기준에 따라 실장비 성능 검증보다 먼저 만든 Viewer 관리 UI, Agent 최초 실행 등록 화면, 로컬 Agent 부트스트랩 CLI, 파일 기반 장비 저장 로컬 API 서버, Agent heartbeat/offline 판정, Viewer 입력 명령 큐, 원격 세션 골격이다.

## 실행

```powershell
npm install
npm run api
```

다른 터미널:

```powershell
npm run dev -- --port 5173
```

개발 서버:

```text
API:    http://127.0.0.1:8787/
Viewer: http://127.0.0.1:5173/
Agent:  http://127.0.0.1:5173/?mode=agent
```

Agent CLI:

```powershell
npm run agent
npm run agent:watch
```

무인 등록 테스트:

```powershell
$env:AETHER_LINK_AGENT_ID="1234567890"
$env:AETHER_LINK_AGENT_PASSWORD="1234"
npm run agent
```

API 장비 저장 파일 경로 지정:

```powershell
$env:AETHER_LINK_API_STORE="C:\Users\qpalz\Documents\remote\aether-link-app\.local-devices.json"
$env:AETHER_LINK_AGENT_OFFLINE_MS="30000"
npm run api
```

## 개발용 로그인

```text
ID: admin
PW: admin1234
```

## 개발용 Agent 접속 규칙

```text
ID: 사업자번호 10자리 또는 000-00-00000 형식
PW: 1234
```

## 현재 구현 범위

- Viewer 관리자 로그인 화면
- Agent 사업자번호/비밀번호 입력
- Agent 비밀번호 `1234` 검증
- 업장명, 장비 번호, 장비명 입력
- 접속 시 장비 리스트 자동 등록
- 업장별 장비 그룹핑
- Agent 데스크탑 이름 자동 생성 placeholder
- 기본 원격 세션 패널과 입력 이벤트 로그
- Node 로컬 API 서버 기반 장비 목록 JSON 파일 저장
- 관리자 로그인, Agent 연결, 세션 생성, 입력 이벤트 기록 API 연동
- Agent 최초 실행 화면에서 아이디/비밀번호 입력 후 Viewer 장비 목록 자동 등록
- Agent 웹 프로토타입의 설치 식별자 브라우저 localStorage 보관
- Agent CLI 최초 실행 시 아이디/비밀번호 입력 후 Viewer 장비 목록 자동 등록
- Agent CLI 로컬 config 파일 기반 설치 식별자 및 등록 장비 ID 보관
- Agent CLI heartbeat 전송 및 `npm run agent:watch` 주기 전송
- heartbeat가 오래 끊긴 장비의 Viewer offline 표시
- Viewer 세션 입력 이벤트의 Agent 명령 큐 적재
- Agent CLI 실행 시 pending 명령 polling 및 처리 로그 출력
- Rust PoC `--mode stream` 기반 32x32 JPEG 타일 JSON line 송출
- Agent CLI `start-stream` 명령 수신 시 Rust stream 시작 및 `/api/sessions/:id/tiles` 전송
- API `/api/sessions/:id/tiles` POST/GET 기반 최신 타일 버퍼 중계
- Viewer Canvas의 JPEG 타일 부분 렌더링
- Rust PoC `--mode inject-input`의 `SendInput` 반환값 검사
- Viewer 로그인 상태에서 장비 목록 주기 갱신

## 아직 구현하지 않은 범위

- 실제 Agent 프로세스 인증
- 설치형 Agent EXE/Windows 서비스 등록
- 서버/상용 영구 DB 저장
- 상용 전송망 기반 화면 스트리밍
- 실제 마우스/키보드 물리 입력 위치 정합성 검증
- Agent 명령 큐 영구 저장
- Visual Ping E2E 계측
- J1800/J1900 실장비 성능 판정

## 검증

```powershell
npm test
npm run build
npm audit --audit-level=moderate
```

## 19차 기준 Visual Ping 상태

- Viewer Canvas는 Rust stream의 마젠타 ping marker 타일을 렌더링한 뒤 `requestAnimationFrame` 이후 픽셀을 샘플링해 PoC 수준 `T_presented - T_start` 지연을 계산한다.
- 지연이 150ms를 초과하면 Viewer가 Agent command queue로 `set-sleep 100`을 보내 스트림 주기를 보수적으로 낮춘다.
- 이 값은 브라우저 Canvas 표시 시점 기준의 PoC 계측이며, 실제 모니터 물리 표시/GPU fence, 기존 ZOOK baseline, J1800/J1900 실장비 성능은 별도 검증이 필요하다.
