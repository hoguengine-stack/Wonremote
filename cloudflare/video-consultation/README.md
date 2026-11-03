# 영상상담 전용 Cloudflare 서버

기존 Firebase Spark의 장비·매장·잠금·원격접속·자동업데이트는 이전하지 않는다.
이 Worker는 영상상담만 처리한다. 기존 Firebase 로그인 토큰의 서명·프로젝트·Viewer 역할과 현재 계정의 사용중지/토큰 폐기 상태를 확인한다. Firebase 관리자 키는 필요하지 않다.

## 구성

- Workers: `/videoConsultation` HTTP API, 기존 상담원/고객 프로토콜 유지.
- SQLite-backed Durable Object: 초대·상담 상태·Viewer별 제한, 단일 고객 점유, 상태 스트림 및 만료 삭제. Firestore를 읽거나 쓰지 않는다.
- Cloudflare TURN: 승인된 상담 생성/참여에만 65분 임시 자격을 발급. 영구 키는 서버에만 보관하며 직접 연결이 가능하면 이를 먼저 사용한다.
- 문자 발송은 연결하지 않는다. 초대 응답은 `smsAvailable:false`; Viewer는 전화번호/문자 버튼 없이 링크 복사를 제공한다.

현재 동시 Viewer3대의 소규모 운영 경계에 맞춰 한 coordinator를 사용한다. 향후 대규모 영상상담 확장에는 부하 실측 후 분할이 필요하다. 기존 원격 기능의 규모 제한은 아니다.

## 계정 연결과 운영 반영

2026-11-03 현재: 사용자 승인 후 전용 TURN 앱을 만들고 Windows 자격 증명 저장소와 Worker의 암호화 비밀 설정에 보관했다. Workers는 Free, Firebase는 기존 Spark를 유지한다. 필수 배포 전 검사 통과 후 서버 버전 `99e66976-12e8-4847-bcb5-40de0c64fdc2`를 게시했다. 실제 임시 TURN 자격 발급201, 운영 출처 사전요청204, 외부 출처403, 미로그인/잘못된 토큰401을 확인했다. 실제 휴대폰·영상 중계·음질·종료는 아직 검증하지 않았다.

서버 주소: `https://wonremote-video-consultation.qpalzm8178.workers.dev/videoConsultation`. 공개118클라이언트에는 아직 새 주소가 들어가지 않았다. 별도로 승인된 Viewer/초대 페이지 빌드가 필요하며, 이번에는 제품 빌드·버전 증가·설치를 하지 않았다. 아래는 최초 설정/재현 절차다. 계정 가입·이메일 인증·로그인·결제수단 입력은 사용자가 직접 한다. Workers Paid 전환을 무단 진행하지 않는다.

1. 기존 앱 의존성을 설치한 작업 폴더에서, 이 디렉터리의 `npm ci` 후 `npx wrangler login`으로 본인의 Cloudflare 계정을 연결한다. `wrangler whoami`로 확인한다. 임시 미소유 preview 계정에 게시하지 않는다.
2. 계정이 Workers Free인지 확인한다. SQLite-backed Durable Objects를 사용하며 기존 KV-backed 유료 namespace는 만들지 않는다.
3. Cloudflare Realtime TURN에서 사용자의 key를 준비한다. 2026-11-03 이 계정의 실제 신청 화면은 카드/PayPal 등록과 구독 활성화를 요구했다. 월정액/현재 청구0달러, 월1,000GB 무료여도 초과분은0.05달러/GB 및 적용 세금/수수료의 자동 청구에 동의하는 구독이다. 현재 등록·활성화하지 않았다. 사용자가 이 조건을 별도로 승인하고 결제수단 입력/활성화를 직접 하기 전에는 진행하지 않는다. Workers Free와 TURN 구독은 별개이며, 무료1,000GB는 무결제 가입·강제 지출상한을 뜻하지 않는다.
4. `wrangler secret put`으로 `VIDEO_INVITE_SECRET`(암호학적 난수32바이트 이상), `CLOUDFLARE_TURN_KEY_ID`, `CLOUDFLARE_TURN_API_TOKEN`을 서버에 설정한다. 실제 값은 채팅·Git·프런트 환경변수·로그에 넣지 않는다. 로컬 `.dev.vars`는 제외돼 있다.
5. `wrangler.jsonc`의 프로젝트·기존 bootstrap Viewer·공개 Firebase API 키·초대 페이지 origin을 확인한다. 여기의 Firebase API 키는 기존 공개 웹 설정이며 관리자 권한 키가 아니다.
6. 계약의 관련 필수 검사·보안 검토·서버 배포 조건을 만족한 뒤 이 디렉터리의 Worker만 배포한다. Firebase 배포, Firestore 규칙, 장비 소유권, 업데이트 정책/자산은 변경하지 않는다. 현재 남은 물리/운영 조건을 문서 변경만으로 완료 처리하지 않는다.
7. 배포 URL을 `VITE_WONREMOTE_VIDEO_API_URL=https://<worker주소>/videoConsultation`으로 Viewer와 휴대폰 초대 페이지에 함께 적용한다. 이는 다음 명시적으로 승인된 프런트/제품 빌드에 포함한다. 기존118설치본에는 코드가 자동으로 들어가지 않는다. URL만 설정하고 구버전도 바뀌었다고 보고하지 않는다.
8. 실제 기존 Viewer 로그인, 링크 복사, 다른 네트워크의 Android/iPhone 동의, 새 영상/음성, TURN relay 경유, 종료/만료를 확인한다. 원격장비·업데이트 호환은 변경되지 않은 경계와 구분한다.

## 검사

`npm test`는 기존 앱의 Vitest 실행기를 재사용한다. JWT 서명과 HTTP API를 거쳐 실제 workerd/SQLite를 실행한다. Google 계정 응답과 TURN 발급은 시험 대역이며, 브라우저 카메라는 시험 영상이다. 브라우저 연결 시험은 실제 클라이언트 API→Worker→Durable Object→WebRTC 경로를 통과하지만 외부 TURN 트래픽을 보내지 않는다. 실제 휴대폰/외부 중계/실음질 검증을 대신하지 않는다.

`npm run typecheck`는 소스 확인이며 제품 빌드가 아니다.

## 문자 발송폰 선택 (미배포 소스)

새 소스는 `sms-route`, `sms-phones`, `sms-save`, `sms-remove`를 인증된 Viewer에만 제공한다. 영상상담 시작 응답의 `smsRoutingAvailable`이 있어야 새 설정 UI가 나타나므로 기존 배포 서버/구 클라이언트의 링크 복사를 깨지 않는다. 이번에는 Worker나 앱을 새로 배포하지 않았다.

- PC 지정폰: 이 PC 저장소의 무작위 capability로 선택한다. 같은 PC에서 로그인 계정이 바뀌어도 이 PC의 폰을 사용할 수 있다. 다른 PC에는 capability를 자동 공유하지 않는다. 로컬 저장소를 지우거나 다른 Windows 사용자/WebView 프로필을 쓰면 새 PC 설정이 된다.
- 상담사 지정폰: 검증된 Firebase UID로 선택하므로 같은 계정이면 다른 PC에서도 불러온다. 여러 상담사가 로그인 계정을 공유하면 상담사 지정폰도 공유된다. 각자 구분하려면 계정이 달라야 한다.
- Textbee 휴대폰 등록/QR 연결은 공식 앱/대시보드에서 먼저 한다. WonRemote에는 API 키로 조회한 휴대폰과 특정 SIM, 사용자가 휴대폰에서 확인한 번호를 지정한다. 등록번호를 통신사가 검증한 발신번호라고 표시하지 않는다.
- API 키는 전송 중 메모리에만 두고 저장/닫기 후 입력을 지운다. 서버에는 초대 비밀값에서 용도를 분리해 도출한 키로 AES-GCM 암호화하고, PC/상담사 scope에 결합한다. 초대 비밀값 교체 시 발송폰 재등록이 필요하다. 평문 키를 응답·브라우저 저장소·로그에 넣지 않는다. 저장한 profile은 연결 해제 때 제거한다.
- 발송은 현재 지정폰을 다시 조회한 뒤 `deviceId`와 `simSubscriptionId`를 반드시 보낸다. 최근 heartbeat, 사용 허용, 네트워크와 SIM을 확인하지 못하면 차단하며, 다른 폰/기본 SIM으로 대체하지 않는다. 마지막 heartbeat 직후 전원이 꺼진 상황까지 탐지하는 실시간 보장은 아니다.
- 기존 방별 발송 예약을 유지한다. 접수 결과가 불명확하면 자동 재전송하지 않는다. UI의 접수 완료는 고객 수신 완료가 아니다. 발송·설정의 외부 응답 대기는 영상 신호 처리 queue를 점유하지 않는다.
- 자동 폴링/재시도는 없다. 상담 시작 시 지정폰 조회1회, 설정 열기/상태 갱신은 누를 때만 요청한다. 미등록 route는 저장소 get1/provider0; 등록 route는 get1/provider GET1. 목록 조회는 provider GET1, 저장은 provider GET1+put1, 해제는 delete1. 명시적 SMS1회는 provider GET1+POST1이며 기존 상담 문서 예약/결과 저장이 추가된다. 실패/중복/수동 재조회 및 기존 영상상담 트래픽은 별도다. 상담 관련 Firestore 사용은 그대로0이다.

공식 API/제약: [휴대폰 등록](https://textbee.dev/docs/getting-started/registering-a-device), [휴대폰 상태](https://textbee.dev/docs/devices), [지정폰 SMS](https://textbee.dev/docs/sending-sms/sending-sms). 실제 휴대폰 권한·통신사 요금제·계정 활성 기기 수와 수신은 미검증이다. 호스팅형 Textbee는 고객 번호/초대 링크를 처리하므로 이용 전 개인정보 처리 범위를 확인해야 한다.

## 영상 서버 요청·보관 비용 경계

- 무사용: 상담을 열기 전 신규 폴링·리스너·Firestore 접근0. 만료 보관 중인 상담의 삭제 alarm은 별도다.
- 정상1상담: 양측 ICE32개, SDP각1개, 각 상태 구독/종료1회면 HTTP/DO72회, 상담원 계정 확인36회, TURN 자격발급2회. Google 공개 서명키는 isolate별 캐시하며 계정 확인과 별개의 요청이다.
- 같은 시험의 저장 API: get76, put71, alarm조회1, 기존 더 빠른 삭제 alarm이 있으면 alarm쓰기0. 이것은 논리 API 횟수이고 실제 Cloudflare 청구 계측이 아니다. cold 시작에는 alarm쓰기1회 추가 가능하다.
- 3Viewer가 각10회/일이면 기본 HTTP/DO2,160회, Auth1,080회, TURN발급60회/일. 상담 문서는 만료 후24시간까지 보관하며 index와 함께 삭제한다. 정리 alarm은 만료 index를32개씩 읽고 시간에 따라 재예약한다. 영상은 저장하지 않는다. Viewer별 쿼터는 계정당1문서를 유지한다.
- 상태 스트림25초 keepalive는 DB를 읽지 않는다. SSE 연결은 DO가 깨어 있는 시간을 사용하므로 무료 한도를 무조건 보장하지 않는다. 재시도·실패·공개 엔드포인트 공격·다른 Cloudflare 앱의 사용량도 별도다. Workers Free 한도 도달은 기능 실패로 나타날 수 있다.
- TURN 트래픽은 Workers/DO 무료량과 별도다. Cloudflare 무료량 초과시 과금 가능성을 숨기지 않고, 기존 Firebase를 Blaze로 자동 전환하지 않는다.

공식 기준: [Workers 가격](https://developers.cloudflare.com/workers/platform/pricing/), [SQLite DO 무료량](https://developers.cloudflare.com/durable-objects/platform/pricing/), [TURN 임시 자격](https://developers.cloudflare.com/realtime/turn/generate-credentials/), [TURN 요금](https://developers.cloudflare.com/realtime/turn/faq/).
