# 개발 지침 모음

현재 구조는 **짧은 진입점 → 작업 선택표 → 해당 작업 문서**다. 공통 지침의 각 본문은 한 작업 문서에서만 관리한다.

## 시작점과 역할

| 문서 | 역할 |
| --- | --- |
| [AGENTS.md](../AGENTS.md) | 현재 저장소의 짧은 진입점과 필수 정책 적용 시점 |
| [작업 선택표](DEVELOPMENT_GUIDE.md) | 6개 작업 문서의 선택 기준과 읽기 범위 |
| [개인 맞춤 지침](CODEX_PERSONAL_INSTRUCTIONS.md) | 개인 맞춤설정용 한국어 문안. 2026-09-12 이 PC의 `C:/Users/qpalz/.codex/AGENTS.md`에 적용 및 내용 일치 확인. 다른 PC·클라우드 동기화는 확인하지 않음 |
| [PROJECT_POLICY.md](PROJECT_POLICY.md) | 이 저장소의 계약 스키마·요청 예산·커밋·배포 게이트 원본 |
| [PROJECT_RULES.md](PROJECT_RULES.md) | 이 제품의 설치·업데이트·권한·성능 조건 |
| [CHANGE_CONTRACT.json](../CHANGE_CONTRACT.json) | 작업별 요구·증거·미완료 상태. 현재 항목만 조회 |
| [INCIDENT_REGISTRY.md](../INCIDENT_REGISTRY.md) | 사고와 정정 이력. 증상·경로에 해당하는 항목만 검색 |
| [제품 계획](../ZOOK_REPLACEMENT_PLAN.md) | 제품 요구·성능 기준과 당시 이력 |
| [과거 인수인계](history/GEMINI_HANDOFF.md) | 보존 자료. 현재 실행 지침이 아님 |

## 다른 프로젝트에 적용

- 범용 묶음은 `DEVELOPMENT_GUIDE.md`와 `tasks/`의 6개 Markdown이다. 기존 프로젝트의 AGENTS.md에 이 선택표 경로와 “해당 작업 문서를 읽고 적용한다”는 연결 규칙을 추가하면 된다. AGENTS.md가 있으면 덮어쓰지 않는다.
- 이 저장소의 PROJECT_POLICY, PROJECT_RULES, 계약, 사고 이력, 제품 계획은 다른 프로젝트에 자동 적용하지 않는다.
- 개인 맞춤 지침은 위의 별도 문안이다. 프로젝트별 명령·경로·버전·전체 규칙을 개인 설정에 복사하지 않는다.
- Codex는 AGENTS.md를 지침 진입점으로 읽는다. 일반 Markdown 링크는 별도의 읽기 지시와 실제 파일 조회가 필요하므로 작업 선택 절차를 진입점에 명시했다. [공식 AGENTS.md 안내](https://learn.chatgpt.com/docs/agent-configuration/agents-md)
- 현재 대화에 이미 들어온 긴 지침이 파일 변경만으로 없어지는 것은 아니다. 다음 실행의 짧은 진입점과 필요한 파일 조회를 위한 정리다. 모델별 토큰 절감률이나 완벽한 준수를 보장하지 않는다.

## 보존 및 정리 범위

- 이전 15개 절은 6개 작업 문서로 나눴다. 구현 프로토콜·품질·작업자 파일은 새 원본으로 안내하는 짧은 호환 진입점으로 남긴다.
- 고정 분담률, 강제 병렬화, 작업자를 계속 바쁘게 만드는 의무, 모델별 벌점, 매 보고마다 원격 조회, 동일 검사 재실행은 현재 공통 지침이 아니다.
- 제품 보안·릴리스 조건, 사고 본문과 미완료 상태는 유지한다. 새 자동검사 계층·앱 빌드·배포를 추가하지 않는다.
- 기존 `.lnk`는 원본을 여는 Windows 바로가기다. 원본 위치와 파일명을 유지한다.
