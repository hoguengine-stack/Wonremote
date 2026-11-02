# AnySupport 분석 및 WonRemote 개선 목록

조사일: 2026-10-30. 기존 REA를 재사용했다. 설치·업그레이드·제공 EXE/DLL 실행·운영 변경·빌드·배포는 하지 않았다. 기초 조사에 더해 메뉴·다이얼로그·문자열 리소스, 공식 기능표 전체, 우리 대응 소스 33개를 대조했다. 아래 52개 검토 항목과 공식 기능표 57항목의 대응표가 이번 통합 결과다. 외부 구현 코드·UI 자산·비공개 통신 복제 및 보안 우회는 하지 않았다.

## 결론

1. 제공 파일은 완성된 Viewer/Agent 한 쌍이라고 단정할 수 없다. ManualLauncher의 설명은 **AnySupport Host용 Launcher**이고, 다른 설치본에는 Viewer·Host·파일 전송·녹화·모바일 구성요소가 함께 있다.
2. 명확한 차이는 **유효한 실행 파일 서명**, **역할별 네이티브 실행 파일**, **별도 전송·업데이트 모듈**이다. WonRemote에도 이미 네이티브 캡처·입력, 독립 업데이트 인계, 분리된 전송 채널이 있다. 없는 기능으로 오인해 전면 재작성하지 않는다.
3. 먼저 **파일 교체 실패 시 기존 파일 보호, 네이티브 파일 선택창, 업데이트 복귀, 실제 커서, 연결 시작 지연**을 다룬다. 다음은 화면/파일의 Base64 복사 비용, 파일 ACK 창·디스크 작업, 장시간 녹화 개선이다. 코덱·통신 전면 교체는 실측 후 판단한다.
4. 접속 100ms, 설치 10배 단축, 보안 창 제어, 저사양 성능, 서버 비용 우위는 입증하지 못했다. 파일 크기·함수 이름은 실측을 대신하지 않는다.

## 원본 식별

| 파일 | bytes | 버전·설명 | 확인 결과 |
| --- | ---: | --- | --- |
| ManualLauncher.exe | 4,344,496 | 2025.9.30.0, ManualLauncher for AnySupport Host | PE32 x86, CLR 디렉터리 없음, KOINO 서명 Valid |
| AnySupport_Setup_10.exe | 20,001,408 | 10.0, AnySupport Agent 10.0 | PE32 x86, CLR 디렉터리 없음, NSIS, KOINO 서명 Valid |

```text
ManualLauncher.exe SHA256
13b0294cd2b9a15f51212e631f35ef3225f5808db11b5fd19ef1e243f8759935
AnySupport_Setup_10.exe SHA256
f3e4c55706aa8927cae4b56705a30c1ebbbc9725c6bd80c7528c80b746fccbbe
```

원본 경로는 각각 `C:\Users\qpalz\Downloads\ManualLauncher.exe`, `C:\Users\qpalz\Downloads\AnySupport_Setup_10.exe`다. 원본을 수정하지 않고 이 폴더에 분석 결과를 분리했다.

## 재사용 도구와 조사 한계

- REA 6.5.0: `C:\Users\qpalz\AppData\Local\npm-cache\_npx\bf1b6d99bcf7a660\node_modules\rea-agents\scripts\rea.mjs`. 같은 캐시의 `node_modules\node\bin\node.exe` 사용.
- 기존 Bandizip 7.40 Beta CLI: `C:\Program Files\Bandizip\bz.exe`.
- 기존 MSVC dumpbin: `C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Tools\MSVC\14.44.35207\bin\Hostx64\x64\dumpbin.exe`.
- 기존 Windows SDK mt: `C:\Program Files (x86)\Windows Kits\10\bin\10.0.26100.0\x64\mt.exe`.
- Windows 파일 버전·Authenticode, PowerShell/.NET 파일 읽기·XML 파서 사용. 새 패키지 설치 없음.

재현 명령: REA `inspect-artifact <file> --format json`, `inspect-managed-artifact <file> --format json`; Bandizip `l <installer>`, `x -y -o:<owned-directory> <installer>`; dumpbin `/headers /imports /exports <file>`; mt `-inputresource:<file>;#1 -out:<manifest.xml>`; `Get-FileHash -Algorithm SHA256`, `Get-AuthenticodeSignature`.

REA 범용 PE 조사에서는 원본이 단일 노드로 나왔다. **내부 파일이 없다는 뜻이 아니므로** NSIS 컨테이너는 별도로 조사했다. ManualLauncher는 Bandizip 아카이브로 인식되지 않아 추출하지 않았다. 두 원본의 REA 관리 코드 결과는 `not-managed`다.

Ghidra 네이티브 제공자는 현재 구성되어 있지 않다. Toss Electron/ASAR처럼 로직을 복구했다고 보고하지 않는다. 프로젝트의 디컴파일 금지 조건도 유지했다. 실행하지 않았으므로 실제 동작·성능은 미확인이다.

## 추출 구성

NSIS에서 28개 파일을 실행 없이 추출했다. 전체 73,385,259 bytes에는 재구성된 uninstall과 설치 플러그인도 포함한다. 원본 두 개+주요 페이로드 EXE/DLL 19개, 총 21개 파일의 버전·해시를 기록했다. 설치 플러그인 전체의 기능·보안 검수는 하지 않았다.

| 구성 | bytes | 직접 확인한 근거와 한계 |
| --- | ---: | --- |
| AutoPatcher.exe | 4,310,096 | 별도 업데이트 이름·버전, 복사/이동·서비스 관리자 API. 롤백·복귀 성공 미확인 |
| KoinoASServer.exe | 3,859,024 | 제품명 KoinoHost. SendInput, OpenInputDesktop, SetThreadDesktop, GetCursorInfo, 서비스·사용자 프로세스 생성 API |
| KoinoViewerNew.exe | 5,915,856 | 제품명 AnySupport, 소켓·WinHTTP 프록시 API. 실제 접속 방식·시간 미확인 |
| KoinoSupporter.exe | 4,183,248 | 제품명 AnySupport. 이름만으로 UI 역할을 확정하지 않음 |
| KoinoFTClient.exe / KoinoFTServer.exe | 2,406,400 / 3,245,568 | 별도 파일 전송 실행 파일과 대응 DLL |
| KoinoFTClientDLL.dll | 5,139,968 | export: RunFTClient, AddFile, ClearList, SelectAndGetFileList, SelectFileListWithDefaultFolder |
| KoinoFTServerDLL.dll | 2,629,120 | export: RunFTServer |
| KoinoAVC.dll / JPEGLib.dll | 671,744 / 86,016 | JPEG 관련 export·의존성. AVC라는 이름으로 H.264를 단정하지 않음 |
| KRecorder.exe / KRecorderWMV.exe | 386,672 / 1,590,784 | 별도 녹화 관련 이름·제품 설명. 녹화 동작·성능 미확인 |
| StreamPlayer.dll | 14,278,144 | GetCurrentFrame, GetFrameSize, SetRotation, StartPlay 등 export. FFmpeg·H.264 문자열은 있으나 PC 화면 경로에서 사용되는지 미확인 |
| MobileViewer.exe / MobileViewerIOS.exe | 6,450,896 / 7,993,552 | 모바일 관련 구성. Android/iOS 동작·기능 동등성 미확인 |
| ClipHelper.dll / hook.dll | 131,072 / 49,152 | 구성 존재. 클립보드·키보드 정확성을 입증하지 않음 |

파일 존재는 기능의 단서다. import는 정적 의존성, export는 노출 심볼이며 실제 호출 분기·활성 기능을 입증하지 않는다.

## 실행 권한과 서명

| 파일 | 요청 실행 수준 | uiAccess | 서명 |
| --- | --- | --- | --- |
| ManualLauncher.exe | requireAdministrator | false | Valid KOINO |
| AnySupport_Setup_10.exe | requireAdministrator | false | Valid KOINO |
| KoinoViewerNew.exe | requireAdministrator | false | Valid KOINO |
| AutoPatcher.exe | requireAdministrator | false | Valid KOINO |
| KoinoASServer.exe | highestAvailable | false | Valid KOINO |

KoinoSupporter.exe도 서명 Valid였다. 서명 검증은 OS 인증서 조회를 일으킬 수 있으며, 애플리케이션 실행·서버 접속과 구분한다.

- 제공 파일이 일반 권한으로 모든 창을 제어하거나 Windows 승인을 우회한다는 근거는 없다.
- supportedOS 선언·오래된 빌드 날짜만으로 실제 Windows 7 32비트 지원을 판정하지 않는다.
- 서명은 게시자·무결성 근거이며 보안 프로그램 미차단, SmartScreen 무경고, UAC 생략, nProtect 제어 성공을 보장하지 않는다.
- 현재 작업 폴더 WonRemote 시험 Viewer/Agent 설치본은 모두 NotSigned다. 서명 스크립트는 있지만 필수 여부가 환경 설정에 달려 있다. 공개 최신 자산의 현재 서명 상태까지 조회한 결과는 아니다.

## 독립 구현 후보와 WonRemote 대조

비교 대상은 이 작업 폴더 소스다. 공개 0.1.113 기준 `c33518275ca57a86b4216f233ddb484fb2d047fc`에 미커밋 0.1.114 접속 시험 변경이 있다. 공개 설치본과 같다고 간주하지 않는다.

| 순위 | 비교 근거 | 우리에게 이미 있는 것 | 개선 후보와 합격 증거 |
| --- | --- | --- | --- |
| 1 | 유효한 서명, 별도 AutoPatcher | 보호 경로 독립 업데이트 인계·건강 확인·선택적 서명 | 인증서 확보 후 신뢰 경계 실행 파일의 서명 범위 검토. 기존 PowerShell 의존 구간의 좁은 네이티브 대체 가치 평가. 최초 설치/구버전 업데이트/복귀/실패 복구와 ID·설정 유지 확인. 탐지 회피 목적 아님 |
| 2 | 별도 네이티브 Host·Viewer | Rust DXGI/GDI 캡처·입력·보안 브로커와 RTC/캡처 시작 겹치기 시험 | startStreaming의 새 캡처 프로세스 생성·초기화 비용 측정 후 작업자 재사용 검토. 승인 전 캡처·상시 사전 연결 금지. 클릭→새 화면 실측과 잠금/취소/재접속 회귀 필요 |
| 3 | 별도 파일 전송 실행 파일·목록 export | ordered file 채널, 청크 ACK·해시·부분 파일·재개 상태·취소 경로 | 큰 파일 저장·해시가 입력/화면에 영향을 주는지 측정 후 필요한 파일 작업만 분리. 양방향 저장 일치, 취소/재개, 디스크 오류, 세션 권한·종료 검증 |
| 4 | Host의 입력·데스크톱·서비스 API | 같은 OS 경계와 네이티브 입력 처리 | 새 엔진 복사보다 사용자 세션·데스크톱 전환·권한 실패 진단/회복 보완. 일반/잠금/자격 증명/SYSTEM 화면·입력 실측. 보안 보호 우회 금지 |
| 5 | WinHTTP 프록시 조회 API | STUN/TURN·relay-only·동적 TURN 자격 지원 | 프록시/PAC·TURN/TLS 제한망 진단. 기존 브라우저 스택 처리 범위 확인 후 보완. 실제 망 접속·오류 안내·비용 검증. 비공개 프로토콜 복제 없음 |
| 6 | JPEG 모듈, 재생 DLL 코덱 문자열 | turbojpeg, 변경 영역 처리, 적응형 캡처, 분리된 채널 | POS 텍스트/정지 화면/동영상별 JPEG 대 표준 영상 코덱 실험. 저사양 x86 CPU·화질·대역폭·첫 화면·혼잡 비교. 라이선스 확인 후 판단 |
| 7 | 작은 Launcher·역할별 파일 | 역할별 설치본·네이티브 호스트와 Node/WebView | 불필요 리소스·기동 의존성 측정 후 축소. 다운로드+추출+종료 대기+등록+새 Agent 복귀 전체 시간 비교. 작은 EXE를 빠른 설치 증거로 사용하지 않음 |

우리 코드 확인 위치:

- 캡처 프로세스: `aether-link-app/src/agent/index.ts`의 startStreaming.
- 세 개 채널·첫 키프레임: `aether-link-app/src/firebase/viewerFirebase.ts`.
- ICE/TURN: `aether-link-app/src/domain/rtcTransport.ts`.
- 파일 저장·해시·재개: `aether-link-app/src/agent/fileTransferReceiver.ts`, `webrtcFileReceiver.ts`.
- 업데이트: `aether-link-app/src-tauri/windows/update-handoff-broker.ps1`, `agent-update-health.ps1`, `src-tauri/src/lib.rs`.
- 서명: `aether-link-app/scripts/sign-release-artifacts.ps1`.
- 네이티브 캡처·입력: `aether-link-poc/src/main.rs`, `capturer.rs`, `secure_capture.rs`.
- 표시 지연: `aether-link-app/src/domain/connectionTiming.ts`.

우리 시험 설치본은 Viewer 20,482,666 bytes, Agent 29,804,076 bytes다. AnySupport 20,001,408 bytes에는 모바일·녹화 구성도 있다. Launcher의 추가 다운로드는 미확인이다. 구성·기능·캐시가 같지 않아 크기로 속도나 우열을 계산하지 않았다.

## 증거 파일

- `*.rea.json`: REA 원본 artifact/managed-static 결과. 전체 JSON 출력 대신 필요한 키만 읽는다.
- `binary-inventory.json`: 원본 2개+주요 추출 EXE/DLL 19개, 경로·크기·해시·버전.
- `manifest-summary.json`, `*.manifest.xml`: 실행 수준·uiAccess·OS 선언.
- `signature-summary.json`: 원본 2개+주요 추출 EXE 4개 서명.
- `api-evidence.json`: 선택 import/export. 원시 dumpbin 출력은 로컬 `*.imports.txt`에 보존.
- `keyword-evidence.json`: ASCII/짝수 정렬 UTF-16LE 키워드 첫 바이트 위치. 짧은 AMF/QSV/P2P는 우연 일치 가능성으로 기능 근거에서 제외. 홀수 정렬·압축/암호화·동적 호출 부재 판정 불가.
- `selected-literals.json`: Host의 D3D11CreateDevice와 재생 DLL FFmpeg 관련 문자열 단서. 실행 경로나 PC 화면 코덱 확정 아님.
- `payload/`: 실행하지 않은 추출 파일. 상용 페이로드·아이콘·원시 심볼 덤프는 Git 배포에서 제외했다. 분석 결과도 외부 게시하지 않았다.
- `verification.json`: 마지막 원본 해시·JSON·로컬 증거 참조 검사 결과. 실제 실행 시 생성하며 제품 기능 검증은 아니다.

과도한 REA JSON 검색 출력은 `INCIDENT_REGISTRY.md`의 INC-20261030-163에 기록한다. 재발 방지는 경로 제한·구조화된 키 선택·출력 행 제한이며 자동 전역 차단이라고 주장하지 않는다.

## 남은 검증

실제 설치·첫 연결·재연결 시간, 입력 반영, CPU·메모리·네트워크, 코덱 선택, 프록시 통과율, 전송 재개 UI, 보안 창 제어, 인증·암호화·업데이트 복구는 미확인이다. 동일 PC/망에서 승인된 제품 사용 관찰로 비교해야 한다. 현재 요청에서는 비교 제품 실행·설치를 하지 않았다.

**범위:** 위 내용은 기초 조사이며, 아래에서 리소스·공식 기능표·우리 소스까지 확장한 통합 목록을 제시한다. 경쟁 제품의 실행 성능·비공개 내부 로직·개선 구현은 검증하지 않았다. 이전 100ms 목표와 기존 미완료 계약은 유지한다.

## 확장 조사에서 새로 확인한 것

- 기존 Windows 리소스 API로 21개 파일의 메뉴/다이얼로그/문자열 테이블을 **데이터로만** 읽었다. vendor entry point·DLL 함수를 호출하지 않았다. `inspect-ui-resources.ps1`의 고정 로딩 플래그는 0x22이며 실행 매핑이면 실패한다. 문자열 테이블은 ID/바이트 위치를 기록하고 손상 길이는 거부한다. 메뉴/다이얼로그는 텍스트 조각만 읽으며 레이아웃을 복원하지 않는다. 방법 근거: [Microsoft API 설명](https://learn.microsoft.com/en-us/windows/win32/api/libloaderapi/nf-libloaderapi-loadlibraryexw).
- 공통 MFC 메뉴·오류 문자열은 실제 제품 기능으로 세지 않았다. 메뉴 조각의 앞쪽 숫자 필드가 문자처럼 보이는 경우도 제외했다. 중요한 기능은 제품 전용 문자열 ID·설정 대화상자와 대조했다.
- Host의 접속 방식은 새 요청을 기존 세션과 어떻게 조정할지 설정하는 단서가 있다. Viewer의 자원에는 모니터 전환·커서·녹화·채팅·파일·재부팅 항목이 있다. FT DLL에는 충돌 시 이어받기·전체 적용, Launcher에는 버전/크기 검사·파일 목록 다운로드·실패 복원 안내가 있다. **안내문 존재와 실제 성공은 별개다.**
- 공식 명칭에서 AnySupport의 **Agent는 상담원 PC 쪽**, Host/Customer는 원격 대상이다. WonRemote Agent와 역할 이름이 반대다. ManualLauncher는 Host용이며, 제공된 설치 파일명만으로 두 파일이 상시 관리용 한 쌍이라고 단정하지 않는다. [공식 다운로드 역할 설명](https://anysupport.net/download.php).
- 접속 성능·암호화 구현·파일 프로토콜을 복구한 것은 아니다. 공개 자료의 동작 설명과 실제 제공 버전의 동작도 동일하다고 가정하지 않는다.

### 리소스 근거 표기

`R-이름/종류/번호`는 `ui-resource-evidence.json`의 파일·리소스 종류·ID를 뜻한다. 6은 문자열 테이블의 stringId, 5는 설정 대화상자 resource ID다. 언어별 중복은 하나의 기능으로 합쳤다.

| 근거 | 확인된 기능 단서 |
| --- | --- |
| R-Launcher/6/110,111,123,124,125,130 | 파일 버전/크기와 목록 다운로드, 최신 상태, 실패 복원 안내 |
| R-Host/5/120,121 | 기존 세션 유지/교체 선택, 입력·화면 설정, P2P 허용 설정 |
| R-Host/5/131,178 | 접속 동의, 프록시 설정 |
| R-Host/6/4332,4333,4334 | 재부팅/안전모드 재접속, 연결 복구와 취소 안내 |
| R-Viewer/6/1512,1513,1530 | 재부팅·안전모드·화면 새로고침 |
| R-Viewer/5/159,160 | 자동 스크롤, 커스텀 커서 동기화, 소리, 자동 녹화·채팅 저장·파일 폴더 설정 |
| R-Viewer/6/1531..1535,1544,1547,1674 | 양방향 전송·폴더, 캡처, 초대, Viewer 화면 잠금 |
| R-FTClientDLL/6/2064,2067,2068,2071 | 동명 파일 충돌, 이어받기, 전체 적용 |
| R-FTServer/6/2035,2036,2042,2084,2087 | 중복 실행·접근 오류·취소·이어받기·전체 적용 |

Launcher=ManualLauncher.exe, Host=KoinoASServer.exe, Viewer=KoinoViewerNew.exe, FTClientDLL=KoinoFTClientDLL.dll, FTServer=KoinoFTServer.exe. 원시 텍스트는 로컬 증거로만 보존하고 Git 게시에서 제외했다.

## 통합 검토 목록: 52개

**분류:** 유지=관련 소스 구현 존재, 재개발하지 않고 설치된 동작 검증. 보완=기존 구현의 부족/위험/성능 후보. 신규=조사한 운영 경로에서 대응 기능을 찾지 못한 후보이며 전체 제품의 절대 부재 판정은 아님. 보류=POS 관리 효용 대비 비용·권한·호환 위험이 커 기본 도입하지 않음.

**우선순위:** P0=데이터/접속/설치의 기존 위험부터, P1=실사용 품질, P2=편의·상용화 확장, P3=별도 승인/수요 후. 경쟁 우위를 실측한 순위가 아니라 우리에게 필요한 도입 순서다. Wxx는 아래 소스 증거 색인, P1~P3는 공개 출처, R은 위 리소스 근거다.

| ID | 대상 | 분류·순위 | 경쟁 근거 / 우리 현재 | 가져올 개선·완료 조건 |
| --- | --- | --- | --- | --- |
| F01 | 클릭→첫 새 화면 | 보완·P0 | Native Host/Viewer; W01,W02에 캡처 spawn·RTC 병렬 준비 있음 | 단계별 지연을 실측한 뒤 캡처 작업자 수명/초기화만 최적화. 캐시 화면 금지, 승인 후 새 픽셀·첫 입력까지 검증. 100ms 미달을 숨기지 않음 |
| F02 | 네트워크 끊김 복구 | 보완·P1 | R-Host/6/4333; W03 수동 재접속·W30 복구 후보 선택 존재 | 같은 승인 세션의 한정 복구와 취소/최종 오류 표시. 재시도 상한·기한·소유권 유지, Viewer 3대의 상태 충돌 검증 |
| F03 | 재부팅 후 복귀 | 보완·P1 | R-Host/6/4332; W03 재부팅 상태와 W30 복구 존재 | 재부팅 의도·만료를 한 번 기록해 복귀 시 재연결. 부팅 지연/잠금 화면/Viewer 종료/계정 변경 시 다른 세션을 되살리지 않아야 함 |
| F04 | 안전모드 원격 | 보류·P3 | R-Host/6/4334; 현재 검색에서 전용 경로 미발견 | 안전모드 부팅 설정·네트워크·되돌리기까지 별도 제품 과제. 현재 설치/업데이트에 자동 추가하지 않음 |
| F05 | 키·마우스·단축키 | 유지·P1 | P1 M02/03/28; W04,W17,W18 입력·한영/조합/해제 구현 | Ctrl/Shift/Alt/한영, 드래그/휠, 창 이탈 후 키 해제의 기존 정상 기준 유지. taskmgr 실행을 보안 주의 시퀀스 Ctrl+Alt+Del과 혼동하지 않음 |
| F06 | 일회성 지원 접속 | 보완·P2 | Launcher/공식 접속 코드; W33 장비 잠금·승인 구조 있음 | 필요 시 상시 관리와 별도 임시 초대 코드·기한·횟수·장비 범위 제공. 기존 장비 ID/사업자번호/자동 업데이트 체계 유지 |
| F07 | 접속 동의·상태 표시 | 보완·P1 | R-Host/5/131; W01 명령 승인 및 잠금 검사 | 상시 관리/현장 승인 모드를 구분하고 실제 Agent에서 강제. 거부·만료·취소·접속 중 표시 유지. 동의/보안 알림을 숨기지 않음 |
| F08 | 보기 전용 권한 | 신규·P2 | P1 C08; 현재 명령 분기에는 세션/허용 명령 경계 있음 | Viewer 버튼 비활성화뿐 아니라 Agent에서 입력/쓰기 거부. 관찰권과 파일·시스템 실행권을 분리하고 권한 변경 즉시 적용 |
| F09 | 멀티 모니터 | 유지·P1 | R-Viewer 모니터 자원; W04 좌표·W01 전환 구현 | 음수 좌표·세로 회전·DPI·전환 첫 프레임 검증. 전체 모니터 동시 보기 수요는 별도 확인 |
| F10 | 확대·스크롤·전체화면 | 유지·P1 | R-Viewer/5/159; W03 기존 보기 도구·모바일 조작 | 창 크기/비율/입력 좌표 일치와 설정 복원. 모바일 가림·툴바 겹침과 실제 창 조절 회귀 검사 |
| F11 | 원격 커서 위치·모양 | 신규·P1 | R-Viewer/5/159 커스텀 커서; 현재 핵심 소스에서 shape 경로 미발견 | 위치·화살표/I-beam/크기변경·핫스폿을 별도 상태로 전달, 프레임 전체 갱신 불필요. 로컬 예측 커서와 실제 커서 구분, 포인터 이동만으로 클라우드 쓰기 금지 |
| F12 | 화질·혼잡 적응 | 유지·P1 | P1 C06; W11 자동/빠름/보통·혼잡/처리시간 적응 있음 | 기존 모드 유지, POS 작은 글씨 판독·CPU·대역폭을 같은 장비에서 비교. 성능 향상 위해 읽기 어려운 화질로 고정하지 않음 |
| F13 | 부분 영역 공유 | 신규·P2 | P1 M01 및 P2; 기존 타일 처리는 공유 권한 ROI가 아님 | 선택 영역 외 픽셀은 송출 단계에서 제외. DPI/회전/모니터 변경·화면 캡처·녹화에도 같은 범위 적용 |
| F14 | 특정 앱만 공유 | 신규·P3 | P2; 현재 주 경로는 화면 단위 | 별도 수요 시 구현. 숨긴 창 위의 알림·UAC·다른 앱 픽셀이 새지 않는지 먼저 검증. 단순 Viewer 자르기를 보안 경계로 사용하지 않음 |
| F15 | 증빙 화면 저장 | 신규·P2 | R-Viewer/6/1544; W03 녹화와 별도로 운영 캡처 저장 경로 조사 필요 | 현재 승인된 원격 프레임을 로컬 사용자 지정 폴더에 한 번 저장. 프레임 시각·장비 표시 선택, 개인정보 최소화·모바일 저장 확인 |
| F16 | 화면 파이프 복사 비용 | 보완·P1 | Native 분리 구조; W14 JPEG→Base64/JSON, W01 파싱 경로 | 우선 캡처↔Agent IPC만 길이 포함 바이너리로 비교. 초기에는 네트워크 규약 유지. 프레임 순서/키프레임/재접속/오류 제한을 보존하고 CPU/할당/지연 실측 |
| F17 | 제한망·프록시 | 보완·P2 | Host 프록시 자원/WinHTTP API; W13 TURN 설정 있음 | 실제 PAC/인증 프록시/TURN-TLS 진단과 명확한 실패 이유. 인증정보 로그 금지, 무한 직접/중계 재시도 금지. P2P/중계 속도 우위는 미입증 |
| F18 | 잠금·고권한 화면 | 보완·P0 | Host 데스크톱/서비스 API; W14~W17 같은 브로커 있음 | 보안 데스크톱 전환·복귀·자격 증명 화면을 실제 확인. 권한 상승은 Windows 승인 경로, 보호 프로그램 우회/드라이버 무조건 추가 금지 |
| F19 | 파일·폴더·드래그 전송 | 유지·P1 | FT 모듈/P1 M10/24/29; W03 폴더·drop, W06~W10 큐·검증 있음 | 재구현하지 않음. 하위 폴더/한글/빈 파일/취소/용량 초과/실제 저장 위치와 해시를 확인 |
| F20 | 파일 가져오기 선택창 | 보완·P0 | FT 별도 UI와 선택 export; W05 PowerShell STA·owner 없는 dialog | 승인된 사용자 세션의 좁은 네이티브 picker로 대체 검토. 원격 화면 앞·작업표시줄·취소·세션 없는 상태가 정확해야 함. PowerShell 차단을 보안 해제로 해결하지 않음 |
| F21 | 동명 파일 충돌 | 보완·P0 | R-FTClientDLL/6/2064..2071; W06,W26은 동일 목적 경로 | 덮어쓰기/이름 바꾸기/건너뛰기/이어받기·전체 적용 정책. 이어받기는 이름만이 아니라 크기/전송 ID/해시로 검증, 기존 파일을 선택 전 삭제하지 않음 |
| F22 | 일시정지·취소·재개 | 유지·P1 | FT 이어받기 자원; W07~W09 이미 구현 | 양방향 UI와 실제 ACK/Abort 연결 확인. 100% 송신과 저장 완료를 구분하고 세션 종료·재시작 후 재개 가능 범위를 명시 |
| F23 | 파일 처리량·입력 우선 | 보완·P1 | FT 별도 실행 경계; W07,W08 32KiB×8 ACK 창·Base64 | RTT별 ACK 창/채널 버퍼·CPU 측정 후 한정 적응 창 또는 버전 협상 바이너리 청크. ACK·해시를 없애지 않음. 큰 전송 중 키 입력 지연 유지 |
| F24 | 청크 저장·메타데이터 I/O | 보완·P1 | 별도 FT 경계; W06은 매 청크 상태 읽기/쓰기·append | 핸들 재사용과 검증된 체크포인트 검토. ACK가 보장하는 저장 수준·재시작 복구 일치, 중단 시 오염/중복 바이트 금지 |
| F25 | 최종 저장의 실패 안전성 | 보완·P0 | 경쟁은 충돌/실패 UI만 확인; 우리 W06의 rm→rename는 직접 위험 근거 | 기존 파일을 먼저 삭제하지 않는 안전한 교체·롤백·대상별 소유권. rename/권한/공유/디스크 실패·동시 전송에서 기존 파일 보존. 현장 유실 발생을 확인한 것은 아님 |
| F26 | 큰 파일·저장 공간 | 보완·P2 | P1 C24; W10 기본500MiB·Firestore fallback5MiB 제한 | 무제한 복제 대신 필요 용량·디스크 잔량·진행률·취소 지연을 기준으로 한도 검토. 대용량 Cloud fallback 금지, Android 저장 경로까지 검증 |
| F27 | 텍스트·이미지 클립보드 | 보완·P1 | Viewer 자원/ClipHelper; W01,W31 PS 호출·이미지 브리지 있음 | 기존 명시 전송 유지, 가능한 좁은 네이티브 OS API로 프로세스 기동 감소. 활성 탭/세션 소유권, 루프 방지·민감정보 자동 전송 기본 꺼짐 |
| F28 | 복사/붙여넣기 파일 전송 | 신규·P2 | P1 C21/P2; 현재 파일 drop와 텍스트·이미지 전송은 별개 | 파일 복사 형식을 별도로 식별해 사용자 확인 후 기존 파일 큐로 연결. 텍스트·비밀번호와 혼동 금지, 경로 직접 실행·무승인 송신 금지 |
| F29 | 원격 기본 브라우저 열기 | 유지·P1 | P2 URL; W04 고정 Edge/ASP/Toss 명령 있음 | 우리 PC가 아닌 원격 사용자 기본 브라우저에서 열리는 실제 결과 확인. 기본은 고정 HTTPS 목록 유지, 임의 shell 명령으로 확장하지 않음 |
| F30 | 자주 쓰는 작업 묶음 | 신규·P2 | P1 M14/P2; W04는 고정 목록 중심 | 허용된 URL/서비스/도구를 계정·매장별 즐겨찾기로 정리. 실행 대상 미리보기와 권한·배포 버전 확인, 임의 경로 실행 저장 금지 |
| F31 | 장비 상태·진단 | 보완·P1 | Viewer 시스템 정보; W19 CPU/RAM/OS, W21 진단 내보내기 있음 | 디스크 잔량·실제 Agent 경로/권한/업데이트/접속 단계 표시를 수요별 추가. 매초 전체 수집 대신 요청/변경 기반, 비밀정보 제외 |
| F32 | 시스템 바로가기 | 유지·P1 | P1 M06/20/30; W04의 taskmgr/cmd/services 등 | 기존 고정 명령과 이중 확인 유지. 일반 사용자 세션에서 실행되고 실제 앞에 뜨는지 확인. 보안 주의 시퀀스를 taskmgr와 동일 취급하지 않음 |
| F33 | 프로세스 진단·종료 | 신규·P2 | Viewer 프로세스 항목/P2; 현재 taskmgr 실행은 있음 | 필요 시 읽기 전용 목록 먼저. 종료는 개별 확인·PID 재사용 방어·권한 경계. Agent/업데이트/보안 프로세스 자동 종료 금지 |
| F34 | 안내 포인터·그리기 | 신규·P2 | P1 M05/07/19/P2 | 먼저 Viewer 레이저 표시부터. 원격 양방향 그리기는 별도 명령·권한·해제·수명 관리, 입력 좌표와 충돌 금지. 필수 원격제어 성능을 해치면 보류 |
| F35 | 채팅·지원 문구·저장 | 보완·P2 | Viewer 채팅 자원/P1; W03,W29 채팅 있음 | 새 채팅 재개발 아닌 전달 확인·재시도/중복 방지·현장 표시·선택 저장 보완. 실패를 console만으로 숨기지 않고 보존기한/과금 확인 |
| F36 | 장시간 녹화 | 보완·P2 | Recorder·Viewer/5/160; W03 Canvas15fps·WebM 녹화 있음 | 신규 기능 아님. MIME 지원·timeslice·디스크 스트리밍·중지/저장 오류·트랙 종료 보완. 2시간 녹화 메모리 상한, 탭/세션 종료 시 손실 방지. 원격 소리는 별도 기능 |
| F37 | 원격 소리·음성 통화 | 보류·P3 | Viewer 소리/P1 M13,C11; 소리 테스트는 오디오 전송 아님 | POS 장애 진단 수요 확인 후 WASAPI/통화 권한·음소거·에코·대역폭/녹화 동의 설계. 기존 화면 경로에 기본 추가하지 않음 |
| F38 | 상담원 화면 역방향 전송/제어 | 보류·P3 | Viewer/6/1528,1529; 현재 일반 원격제어와 다른 방향 | 별도 도움 시나리오가 있어야 추가. 양측 명시 승인·역할별 권한·중단·정보 노출 검사. 우리 PC 제어권이 자동 넘어가는 구조 금지 |
| F39 | 상담 초대·인계·공동 보기 | 보류·P3 | Viewer/6/1547/P1 M26/27; W28 멀티탭은 같은 세션 공동 제어 아님 | 먼저 읽기 전용 초대와 주 조작자 한 명. 소유권 인계·토큰 만료·고객 승인·파일/잠금 권한을 포함한 별도 설계 필요 |
| F40 | 다른 Viewer와 세션 점유 | 보완·P0 | Host/5/120 기존 유지/교체; W02,W28 세션 경계 있음 | 기본은 현 제어자 유지 또는 명시 인계. 같은 계정 Viewer3대의 오래된 종료/새로고침이 새 세션을 끊지 않아야 함. 자동업데이트와 장비 ID 영향 금지 |
| F41 | 현장 입력 잠금·화면 가림 | 보류·P3 | Host/5/121/P1 C20; 원격 접속 비밀번호와 별개 | 무인 POS에서 특히 신중. 필요 시 현장 표시·즉시 해제·연결 끊김/프로세스 장애 시 자동 복원. 숨김 제어·보안 알림 제거 금지 |
| F42 | 서명·설치 네이티브 경로 | 보완·P0 | 서명6개 Valid·독립 AutoPatcher; W22~W25 자체 인계/검사 있음 | 기존 건강 검사를 삭제하지 않고 인증서/서명 범위·네이티브 호스트 책임 정리. 단계별 설치 시간, 실제 새 Agent·ID·명령 왕복·복구로 완료 판정 |
| F43 | 파일 단위 업데이트·복원 | 보완·P0 | Launcher/6/110..130 안내; 우리 서명 manifest·전체 설치 경로 | 먼저 변경 없는 구성 재사용과 중단 복구. 파일 단위 배포는 서명된 전체 manifest·스테이징·세트 원자 전환·이전 버전 복귀가 전제. Vendor delta 구현을 확인한 것은 아님 |
| F44 | 지원 이력·감사·보존 | 보완·P1 | P1 C18/P2; W21 진단·W29 세션 데이터 있음 | 누가/어느 Viewer/대상/시작·종료/전송·설정 변경을 최소 이벤트로 기록. 개인정보 제외·보존/삭제·권한·요금 한도, 끊김 뒤 종료 상태 확인 |
| F45 | 운영 통계·내보내기 | 신규·P2 | P1 C03/P2; 현 주 실행 경로는 상세 상용 통계 미확인 | 장비별 실패율·첫 화면 p50/p95·업데이트 복귀율을 일/월 집계. 화면 열 때 전 이력 반복 읽기 금지. 별도 CMS의 현 구현은 이 작업 폴더 밖이면 미검수 |
| F46 | 관리자·조직·장비별 권한 | 보완·P1 | P1 C23/P2; W20 계정 관리·W33 잠금 존재 | 기기 보기/접속/파일/관리/업데이트를 단계적으로 분리. 기존 공유 계정·소유권을 즉시 갈아엎지 말고 구 Agent 병행 호환. 서버와 Agent 양쪽 강제 |
| F47 | 고객 전용 접속 페이지·로고 | 보류·P3 | P1 C14/16 | 상용화 고객별 필요 시 브랜드만 독립 제작. 기존 URL/업데이트 경로 보존, 타사 로고·화면 복제 금지 |
| F48 | 종료 후 만족도 조사 | 보류·P3 | P1 C22/P2 | POS 상시 관리에는 기본 불필요. 유인 상담 계약 수요가 있을 때만 선택 제공, 광고성 알림·추가 창을 기본 생성하지 않음 |
| F49 | 모바일 기능·동작 동등성 | 보완·P1 | 별도 MobileViewer/공식 모바일 제품; W32 모바일 도구 있음 | PC 코드 변경마다 실제 Android 호스팅 UI/APK/Agent 호환 경로 구분. 파일·클립보드·고정 URL·뒤로가기·키보드·가로/세로 실기기 확인. Windows exe만으로 Android 구조 판단 금지 |
| F50 | 구버전·능력 협상 | 보완·P0 | 패키지 모듈·버전 분리; W02,W07,W33 버전/잠금 경계 있음 | 신규 바이너리/코덱/권한은 capability+protocol version 협상 후만 사용. 구 Agent 새 Viewer/반대 조합의 기본 접속·자동업데이트 보존. Windows7는 별도 미룸 상태 유지 |
| F51 | 장비 목록 새로고침·표시 | 보완·P1 | 경쟁 접속상태 문구는 속도 근거 아님; W12 확인중/비동기/5초 제한 있음 | 모든 장비 응답을 화면 표시 전 기다리지 않고 개별 갱신 유지. 중복 클릭/화면 이탈/오래된 응답·오프라인 판정·요청량 검사. 가짜 온라인 금지 |
| F52 | 이 PC Viewer 화면 잠금 | 신규·P2 | R-Viewer/6/1674; W33 장비 접속 잠금과 보호 대상이 다름 | 수동/유휴 시 로컬 Viewer 입력과 민감 화면 잠금. 장비 잠금 해제 유지와 별도 정책, 다른 Viewer의 해제 상태와 공유 금지. UI 가림만으로 세션 권한을 대체하지 않음 |

신규 항목의 범위 검색은 `source-gap-search.json`에 보존했다. 같은 파일에서 실제 녹화를 발견했으므로 F36은 **신규가 아니라 보완**으로 분류했다. 검색 결과가 없다는 이유만으로 미설치 버전/다른 저장소의 구현 부재를 주장하지 않는다.

## 공식 기능표 57항목 누락 점검

[공식 2쪽 기능표](https://anysupport.net/download/doc/kr/anySupport_solution.pdf)의 M=주 기능33개, C=설정24개다. 같은 기능은 합쳐 F 항목에 연결했다. 이것은 제공 버전의 기능 성공을 검증한 표가 아니다. M11의 URL 설명은 재부팅 설명과 혼재되어 URL 의미는 실제 Viewer/공식 기능 페이지로 교차 확인했다.

| 원본 항목 | 통합 항목 | 원본 항목 | 통합 항목 | 원본 항목 | 통합 항목 |
| --- | --- | --- | --- | --- | --- |
| M01 | F13 | M12 | F15 | M23 | F10 |
| M02 | F05 | M13 | F37 | M24 | F19 |
| M03 | F05 | M14 | F30 | M25 | F36 |
| M04 | F09 | M15 | F38 | M26 | F39 |
| M05 | F34 | M16 | F02 | M27 | F39 |
| M06 | F32 | M17 | F27 | M28 | F05 |
| M07 | F34 | M18 | F35 | M29 | F19 |
| M08 | F33 | M19 | F34 | M30 | F32 |
| M09 | F31 | M20 | F32 | M31 | F20 |
| M10 | F19 | M21 | F03 | M32 | F38 |
| M11 | F29 | M22 | F35 | M33 | F04 |
| C01 | F11 | C09 | F20 | C17 | F35 |
| C02 | F06 | C10 | F17 | C18 | F44 |
| C03 | F45 | C11 | F37 | C19 | F40 |
| C04 | F07 | C12 | F07 | C20 | F41 |
| C05 | F18 | C13 | F39 | C21 | F28 |
| C06 | F12 | C14 | F47 | C22 | F48 |
| C07 | F10 | C15 | F06 | C23 | F46 |
| C08 | F08 | C16 | F47 | C24 | F26 |

현재 공식 기능 페이지의 영역/앱 공유, 프록시, 원격 인쇄·소리, 표시·동의, 통계/보존/권한은 각각 F13/14/17/37/07/44~46 및 아래 보류 사유에 반영했다. 공식 사이트의 암호화·즉시 연결 등 표현을 실측 사실로 옮기지 않았다. [공식 기능 개요](https://anysupport.net/introduce_function.php).

**추가 제외 후보:** 원격 인쇄는 프린터/스풀러/드라이버 권한·개인정보·POS 영수증 장치 영향이 커 별도 수요 전 보류한다. 원격 문서를 로컬에 인쇄하는 것과 반대 방향의 인쇄도 구분해야 한다. 새 모바일 영상 상담, 전체 디스플레이 해상도 강제 변경, 배경/AERO/화면보호기 자동 변경, 자동 강제 로그인/세션 탈취, 상시 클립보드 동기화는 기본 복제하지 않는다. 사용자 동의 없는 현장 키보드 잠금·화면 은폐·보안 드라이버 추가도 도입 대상이 아니다.

## 성능·안정성에서 실제로 고칠 후보

아래 수치는 코드에서 계산한 크기/상한이며 제품 실측 개선량이 아니다.

1. **파일 ACK 창:** W08은 32KiB×8=256KiB마다 ACK를 기다리고 W07은 다음 창을 그 이후 보낸다. ACK 왕복이100ms라면 파이프라인이 없는 이 창만의 계산상 한계는 약2.5MiB/s다. 디스크/해시/회선 시간은 별도이므로 실제는 다를 수 있다. 무조건 창을 키우지 말고 RTT·버퍼·취소 반응을 측정한다.
2. **Base64:** 32,768byte 청크는 Base6443,692문자다. JSON 부가분 전에도 약33.3%가 늘어난다. 화면도 W14에서 JPEG를 Base64/JSON으로 만든다. IPC 바이너리화부터 비교하고 외부 규약 전환은 F50 협상 후 수행한다.
3. **파일 준비 지연:** W03은 전송 시작 전에 `sha256BlobHex(file)` 전체 해시를 기다린다. W27은 1MiB씩 읽어 전체 파일 한 번에 메모리에 올리는 구현은 아니다. 따라서 '메모리 통째 읽기'로 잘못 진단하지 않는다. 취소 전달·준비 진행률·스트리밍 해시와 최종 검증 설계를 검토한다.
4. **디스크 작업:** W06은 청크마다 상태 JSON을 읽고 쓴다. 파일 핸들/체크포인트 개선 여지는 있으나 재개·ACK 신뢰를 낮추면 안 된다. 마지막 전체 SHA-256 재검증을 안전 검토 없이 제거하지 않는다.
5. **기존 파일 보호:** W06의 두 완료 경로는 `rm(targetPath)` 뒤 `rename(...)`를 한다. 중간 실패 창과 동명 동시 전송을 먼저 해결해야 한다. F25는 경쟁사의 구현이 우월하다는 주장이 아니라 우리 코드에서 직접 찾은 위험이다. INC-20261030-164는 미수정 상태다.
6. **파일 선택/클립보드:** W05/W31/W01의 PowerShell UI·클립보드 호출은 프로세스 시작·권한 세션·보안 정책 의존이 있다. 고정된 네이티브 기능으로 대체할 가치가 높다. 스크립트 난독화·보안 예외·승인 우회는 대안이 아니다.
7. **긴 녹화:** W03은 Canvas15fps를 MediaRecorder로 받아 chunks 배열에 쌓고 stop 때 Blob을 만든다. start에는 timeslice가 없고 원격 소리 트랙은 여기서 확인되지 않는다. 분할 디스크 저장·크기 한도·실패 처리부터 보완하고 녹화를 신규 기능으로 다시 만들지 않는다.
8. **입력/화면/파일 독립성:** 세 DataChannel이 있어도 동일 Peer/SCTP·회선·Agent 프로세스의 자원을 공유한다. 별도 프로세스 생성만으로 대역폭 경쟁이 사라지지는 않는다. 입력 우선·메모리/디스크 부담·과한 전송 버퍼부터 측정한다.
9. **설치 건강 확인:** W22는 Agent 새 PID/버전/기존 ID/서버 승인·명령 왕복과 보호 작업 상태를 확인한다. 이는 단순 sleep을 삭제하면 되는 지연이 아니다. 기동/네트워크/검증 대기 시간을 나눠 표시하고 동일 정상 조건을 만족할 때 즉시 종료한다.
10. **접속 100ms:** 경쟁사의 모듈 분리·서비스 API·문자열은 목표 충족 증거가 아니다. 승인·라우팅/RTT·신호 교환·캡처·decode/paint를 같은 조건에서 각각 기록하고 fresh first-picture를 기준으로 삼는다. 사전 캡처·장기 연결로 비용을 숨기는 방식은 기본 제안에서 제외한다.

## 도입 순서와 공통 유지 조건

1. F25/F21/F20: 파일 보존·충돌·선택창부터. 기존 수신 파일과 현재 원격 세션을 건드리지 않는 실패 재현 후 최소 수정.
2. F42/F43/F50/F40: 설치/복귀/구버전 호환/세션 소유권. 최신 버전 번호가 뜨는 것과 원격 명령·새 픽셀 복귀를 분리해 확인.
3. F01/F11/F16/F23/F24/F27: 측정된 병목과 커서·클립보드 체감 개선. 한 번에 한 경계만 변경, 동일 조건 전후 비교.
4. F31/F33/F35/F36/F44/F52: 진단·작업 편의·장시간 안정성. 그 다음 부분 공유/그리기/파일 붙여넣기 등 수요 확인된 신규 기능.
5. 보류 항목은 '전부 가져오기'의 자동 구현 대상이 아니다. 각각 별도 승인/효용/복구 설계가 필요하다.

모든 후속 변경은 기존 ID·장비 등록·설정·소유권·접속 잠금·구버전 접속·서명 업데이트를 유지한다. 사용 승인된 시험 장비에서만 설치하며 운영 Firebase 규칙·요금/리스너·전체 배포는 이번 분석 범위가 아니다. Windows32/64호스트의 x86 설치 경로, Firebase/로컬, Android 호스팅/APK는 영향 경계를 나눠 검증한다. 테스트·컴파일·문구 존재를 실장비 성공으로 대체하지 않는다.

## 소스 증거·검증 상태

`source-evidence.json`에 W01~W33 각각의 **정확한 절대 경로·현재 SHA-256·확인한 줄/심볼**을 보존했다. 제품 코드는 수정하지 않았다. 검색 범위와 매치 파일은 `source-gap-search.json`, 공개 자료 URL/한계는 `public-sources.json`에 있다.

- W01 Agent/index, W02 Firebase Viewer, W03 App, W04 시스템·키 명령.
- W05 picker, W06 수신 저장, W07 송신, W08 파일 규약, W09 큐, W10 한도.
- W11 화질, W12 상태 갱신, W13 RTC 설정, W14 native main, W15 DXGI, W16 secure desktop.
- W17 입력 종료, W18 Viewer 입력, W19 시스템 정보, W20 계정, W21 진단.
- W22 건강 확인, W23 인계, W24 서명, W25 프로세스 종료, W26 파일 경로, W27 해시.
- W28 탭, W29 세션 데이터, W30 Agent 복구, W31 이미지 클립보드, W32 모바일 제어, W33 장비 잠금.

**끝낸 범위:** 원본·구성·API·권한·서명·읽기 가능한 UI 기능 단서·공개 기능표 전체·우리 대응 경로 및 독립 구현 후보의 통합 정리. helper self-check와 원본/소스 무변경·증거 참조·57항목 대응 검사를 수행한다.

**아직 증명하지 않은 범위:** 경쟁 실행 성능, 보안 창 제어 성공, 비공개 내부 알고리즘·통신 규약, 설치 시간, 서버 운영 비용, 각 기능의 설치본 실제 성공. 제품 구현·회귀 테스트·설치·배포도 이번에 하지 않았다. 이를 남겨둔 것은 기능표 분석의 누락이 아니라 실행 증거의 한계이며, 이 한계를 이유로 경쟁 장점을 없다고 판단하지 않는다.

### Analysis Helper Review

What this change does: The local script reads resource data from the supplied files and writes a bounded evidence report. It does not run vendor code or change WonRemote.

Review scope: one local operator, the two known originals and19extracted binaries, fixed data/resource loader flags, callbacks, string-table parsing, output writing and self-check callers. The output is now restricted to a direct JSON file in this analysis folder; links/directories and executable paths are rejected to avoid accidental input replacement.

No unresolved finding for the scoped run. Parser checks cover ID/offset/text, truncated input and output path rejection. Existing binaries/source hashes are checked independently. Verdict: Ship the analysis report, not a product release.

Not checked: arbitrary malformed PE fuzzing, unknown future resource formats, application runtime or performance. Used skills: Ponytail and scoped Ponytail Review; no product implementation/TDD cycle was needed for this read-only comparison.
