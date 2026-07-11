# WonRemote App

WonRemote는 Firebase 기반 장비 관리와 WebRTC P2P 화면·입력·파일 채널을 사용하는 Windows 원격 제어 프로그램이다. Viewer와 Agent를 x64/x86 설치본으로 각각 배포하며, 로컬 API는 개발 및 격리형 회귀 테스트에만 사용한다.

## 실행

```powershell
npm install
npm run api
```

다른 터미널:

```powershell
npm run dev -- --port 5173
```

로컬 개발 서버:

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
$env:WONREMOTE_AGENT_ID="1234567890"
$env:WONREMOTE_AGENT_PASSWORD="1234"
npm run agent
```

API 장비 저장 파일 경로 지정:

```powershell
$env:WONREMOTE_API_STORE="C:\Users\qpalz\Documents\remote\aether-link-app\.local-devices.json"
$env:WONREMOTE_AGENT_OFFLINE_MS="30000"
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

- Firebase Authentication 및 Firestore 기반 Viewer 로그인, Agent 등록, heartbeat, 장비 상태, 세션·명령 관리
- Agent 최초 로그인 후 Windows 자동 실행, 백그라운드 트레이, 설정 복구 및 서버 등록 유실 시 재등록 화면 표시
- 온라인 장비 즉시 접속과 Agent 화면에 표시되는 6자리 코드 기반 보안 접속
- 접속 즉시 원격 전용 화면 전환, Fit/100%/확대·축소, 다중 모니터 목록 조회·전환
- WebRTC P2P 화면 타일, 키보드·마우스 제어, 파일 전송 데이터 채널 분리
- 전체 키 down/up, 조합키 유지, 포커스 이탈·세션 종료 시 키와 포인터 버튼 일괄 해제
- DXGI 캡처와 GDI fallback, 캡처 재시작, 동일 세션 재연결 시 WebRTC 전송 유지
- 500MB 파일 청크 전송, SHA-256 검증, 진행률·전송률·남은 시간, 실패 수신증과 이어받기
- 채팅, 양방향 클립보드, 오디오 알림, 화면 녹화
- 작업 관리자, CMD, 탐색기, 서비스, 장치 관리자, 잠금·로그오프·재시작·종료 제어와 위험 명령 재확인
- Wake-on-LAN 매직 패킷 및 Firebase relay 요청
- 서명된 업데이트 매니페스트, 체크섬 검증, 실패 롤백, Agent·Viewer 자동 업데이트
- x64 네이티브 WebRTC와 x86 `werift` 런타임을 분리한 Viewer·Agent 설치본 및 포터블 패키지
- 개발·회귀 테스트용 로컬 API와 격리형 파일 저장소

## 외부 인프라 및 물리 검증

- 대칭 NAT나 UDP 차단망까지 연결을 보장하려면 운영 TURN 서버 자격 증명을 배포 환경에 설정해야 한다.
- Windows SmartScreen 경고를 줄이고 업데이트 게시자를 검증하려면 Authenticode 코드 서명 인증서가 필요하다.
- UAC 보안 데스크톱은 일반 사용자 세션의 `SendInput`으로 제어할 수 없으므로 별도 고권한 서비스 설계가 필요하다.
- J1800/J1900 실제 성능과 재부팅 후 동작은 대상 장비에서 별도로 확인한다. `1024x768` 화면 검증은 현재 완료 조건에서 제외한다.

## 검증

```powershell
npm test
npm run build
npm audit --audit-level=moderate
```

## 화면 전송 지연 계측

- Viewer Canvas는 Rust stream의 마젠타 ping marker 타일을 렌더링한 뒤 `requestAnimationFrame` 이후 픽셀을 샘플링해 `T_presented - T_start` 화면 전송 지연을 계산한다.
- 지연이 150ms를 초과하면 Viewer가 Agent command queue로 `set-sleep 100`을 보내 스트림 주기를 보수적으로 낮춘다.
- 이 값은 Viewer Canvas 표시 시점 기준이며 실제 모니터 광자 출력 시점을 측정하는 고속 카메라 계측과는 구분한다.
