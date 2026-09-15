# 개발 작업 진입점

- 한국어로 간결하게 답한다. 최신 요청과 사용자 관찰을 먼저 확인하고, 사실·추정·미확인을 구분한다.
- 사용자에게 보이는 결과까지 가장 작은 변경으로 연결한다. 기존 사용자 변경과 데이터를 보존한다.
- [작업 선택표](work-guides/DEVELOPMENT_GUIDE.md)에서 해당 문서를 읽고, 영향 경계가 늘면 추가한다. 전체 지침·계약·사고 기록을 매번 출력하지 않는다.
- 수정·검증·빌드·배포·설치 확인을 구분한다. 미검증 결과를 완료로 보고하거나 통과를 위해 안전 조건을 낮추지 않는다.
- 중단·압축 후에는 최신 요청, 이 진입점, 관련 지침·작업 기록·diff로 마지막 검증 지점부터 재개한다.

## 이 저장소의 추가 필수 조건

[프로젝트 정책](work-guides/PROJECT_POLICY.md)은 이 진입점의 일부이며 아래 시점에 반드시 적용한다.

- 편집 전: Omission Prevention Gate, Mandatory Workflow, Verification Scope And Resume, Completion Rules를 읽고 `CHANGE_CONTRACT.json`을 active로 갱신한다. 요구마다 outcomes와 검증 경계를 기록한다.
- 모든 계약: requestReview의 impact와 구체적 reason이 필요하다. 요청 경로가 바뀌면 편집 전에 Request Waste Prevention의 예산·증거 스키마도 읽고 적용한다.
- 커밋 전: Commit Requirements와 `aether-link-app`의 `npm run change:verify`를 적용한다.
- 배포 전후: Omission Prevention Gate의 상태·predeploy·live 검증 조건과 [제품 전용 조건](work-guides/PROJECT_RULES.md)의 릴리스 절을 적용한다. 빌드·배포는 명시적 요청 범위에서만 수행한다.
- 제품 실행·설치·권한·성능을 바꿀 때는 PROJECT_RULES의 해당 절을 추가한다. 개발 실수는 `INCIDENT_REGISTRY.md`에 기록하며, 기존 미완료 항목을 문서 변경으로 종료하지 않는다.
