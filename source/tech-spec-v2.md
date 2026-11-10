# 스미싱 확인 챗봇 「화기니」 — 기술 스펙 v2 (실제 서비스 기준)

| | |
| --- | --- |
| 기준 | 2026-11-10 코드 `origin/test/render` `45871b8` |
| 서비스 | 카카오톡 채널 챗봇. 의심 문자(링크 있음·없음)와 통화 녹음을 받아 근거와 함께 결과를 카드로 보낸다. 위험하면 KISA·1394·112 상담으로 잇는다 |
| 원칙 | 판정은 코드가 한다. LLM은 읽기와 근거 있는 신호 제안만 한다. 의심 링크에는 격리 서버만 접속한다 |
| 운영 상태 | 시험 운영. 사용자 테스트는 아직 하지 않았다 |
| 상태 표기 | **구현** / **부분** / **미구현**(아직 원하는 것) / **제약**(플랫폼이 정한 것) |
| v1.0과의 차이 | `tech-spec-v1-to-v2-changes.md` (무엇이 왜 바뀌었는지, 근거 ADR·커밋) |

목차: 1. 아키텍처 설계 · 2. 시나리오 · 3. 요구사항 · 리스크 · 4. 테스트 전략 · 5. 추가 지표 · 6. 인터페이스 명세

---

# 1. 아키텍처 설계

> 💡 전체 구조·흐름, 에이전트 설계(단계·도구·상태·예외), 기술 스택·배포 구성

## 1.1 전체 구조

```
[카카오톡 채널] ── 스킬 요청(5초) / 콜백(1회) ──▶ [카카오 오픈빌더]
                                                     │ POST /kakao/skill (X-Skill-Secret)
                                                     ▼
┌──────────────── 메인 서버: Render · FastAPI main.py ─────────────────┐
│ 입력 분기 → 작업 저장(프로세스 메모리) → 분석 실행 → 카드 조립 → 콜백     │
│ ai/ 패키지 (같은 프로세스, 함수 호출)                                     │
│   읽기 · 근거 검증 · 결론 관문 · 사례 검색 · 공식 확인 방법 고르기          │
│   KB: ai/src/ai/kb/ 파일 → 기동 때 메모리 색인                            │
└──────┬──────────────────────────────────┬──────────────────────────┘
       │ HTTPS + Bearer, 17초, 응답 1 MiB   │ OpenAI 호환 API, 재시도 없음
       ▼                                  ▼
[격리 서버: EC2 · Docker]               [LLM · STT(whisper) · 임베딩]
 POST /collect: httpx(2단계) → 필요하면 Chromium(3단계)
       │ HTTPS/443만
       ▼
[의심 링크의 대상 사이트]
```

| 구성 요소 | 하는 일 | 위치 | 담당 |
| --- | --- | --- | --- |
| 카카오 오픈빌더 | 블록·버튼·콜백. 폴백 블록이 모든 입력을 스킬로 보낸다 | 관리자센터 | FE·BE |
| 메인 서버 | 입력 분기, 작업 저장, 격리 수집 호출, 공식 도메인 대조, 카드 선택·조립, 콜백 | `main.py`, `services/`, `backend/`, `scanner/` | BE |
| 카드 템플릿 | 문구·버튼·이미지(41개). 렌더러가 빈칸을 채운다 | `frontend/kakao-templates/` | FE |
| AI 패키지 | 읽기, 근거 검증, 결론 관문, 사례 검색, 공식 확인 방법 고르기 | `ai/` | AI |
| 결과 스키마 | BE↔AI 계약(pydantic 원본 + JSON 스키마 사본) | `contracts/schemas/`, `docs/scheme.md` | AI |
| 격리 서버 | 의심 링크 접속과 수집만 한다. 판정하지 않는다 | `infra/isolation/` | BE |
| 외부 AI API | LLM, STT, 임베딩 | 환경변수로 지정 | AI |

의존 방향은 `backend` → `ai` 한 방향이다. `ai/`는 카카오 형식, 격리 서버, 화이트리스트 파일을 모른다(ADR 0001·0002).

## 1.2 흐름

**입력 분기** (`main.py` `kakao_skill`, 위에서부터 먼저 맞는 것)

1. `callbackUrl`이 허용 호스트가 아니다 → R4
2. `action.clientExtra.job_id`가 있다(`자세히 보기`) → 저장한 결과로 캐러셀
3. `clientExtra`에 `case_id`·`question_id`·`option_id`가 있다(Q1·Q2 항목) → 답 처리
4. `intent.name == "결과 확인"` → 사용자의 최근 작업 결과
5. 녹음이다(`params.media.type == "audio"` 또는 허용 CDN의 오디오 주소) → 녹음 흐름
6. 빈 입력 → R6
7. 같은 사용자의 분석이 진행 중이다 → K5
8. 그 밖 → 문자 흐름. `callbackUrl`이 없으면(개발·테스트) 그 자리에서 동기로 처리한다

**문자 흐름**

```
문자 ─▶ R5 대기 글(useCallback) 반환, 백그라운드 시작 (전체 45초)
          │
          ▼
  read_message ─ LLM ①, 15초
   ├ 읽기 실패 → R4 · 너무 긴 문자 → 안내 글 · 주소를 못 읽음 → 안내 글
   ├ 링크 없음 → analyze_message_case (주장 읽기 LLM) → R6b(+Q1·Q2) / R6 / R4
   └ 링크 N개
       ├ analyze_message_part: 사례 검색(2.5초) → 신호 제안 LLM ②   ┐ 함께 시작
       └ 링크마다 차례로:                                            ┘
           collect_url_isolated (17초)
           → build_ai_url_analysis (공식 대조·강등)
           → finalize_analysis: inspect_html(1초) → 페이지 LLM ③(5초)
           → AnalysisResponse → select_result_card → R1 / R2 / R8 / R9 (예외는 R4)
          │
          ▼
  카드를 합쳐 작업에 저장 → callbackUrl로 POST(10초)
  콜백이 안 오면: 사용자가 「결과 확인」 → K1 / K2 + 결과 / R4 / K4
```

**녹음 흐름**

```
녹음(음성 메시지 또는 파일 첨부) ─▶ R5
  → 다운로드: 허용 CDN, 공인 IP, 25 MB, 15초
  → 형식 검사
  → transcribe_call: whisper-large-v3, 30초
  → analyze_call: 예산 = 40 − 경과 초 (5초 미만이면 0)
  → V1(+Q1) / VE1~VE4 / R4 → 저장 → 콜백
```

**버튼·답 흐름:** `자세히 보기`와 Q1·Q2 답은 저장한 결과만으로 바로 답한다. 다시 분석하지 않고 LLM과 네트워크를 쓰지 않으며 콜백도 쓰지 않는다.

## 1.3 에이전트 설계

### 설계 원칙

- **고정 단계 파이프라인이다.** 조사 순서, 결론, 붙일 질문은 코드가 정한다. LLM은 정해진 단계에서 읽기만 하고 도구를 부르지 않는다. 2026-10-27 설계 v3에서 v1.0의 자율 보강 루프(⑤)와 조회 한도를 없앴다(PR #86 멘토 리뷰 "LLM과 코드의 역할", 커밋 `fa4d414`).
- **LLM 출력은 후보다.** 근거가 실제 입력에 있는 것만 결론의 입력이 된다.
- **어느 단계가 실패해도 결과는 나간다.** 실패 사유는 `failures`에 남기고 확인하지 못한 범위로 보여 준다. 실패를 정상이나 악성의 근거로 쓰지 않는다.

### 단계

**링크가 있는 문자**

| # | 단계 | 주체 | 입력 → 출력 | 상한 | 실패하면 |
| --- | --- | --- | --- | --- | --- |
| 1 | 문자 읽기 `read_message` | LLM ① + 코드 검증 | 원문 → 브랜드·주제·요구 행동·링크, `unverified_links` | 15초 | R4. 너무 긴 문자·못 읽은 주소는 안내 글 |
| 2 | 사례 검색 `search_cases` | 코드 + 임베딩 | 링크를 뗀 본문 → 유사 사례 | 2.5초 | 미확인. 임베딩만 실패하면 TF-IDF로 검색 |
| 3 | 문자 신호 제안 `analyze_signals` | LLM ② + 코드 검증 | 본문·추출 결과·사례 → 검증된 신호 | 30초 (전체 45초 안) | 확보한 문자 근거를 유지하고 사유를 남긴다 |
| 4 | 격리 수집 `collect_url_isolated` | 격리 서버 | URL → `CollectResult` | 17초 | `collection_failed`로 채우고 계속한다 |
| 5 | 공식 대조·강등 `build_ai_url_analysis` | 코드(BE) | 브랜드·수집 결과 → `url.official` | | 확인하지 못하면 `unresolved` |
| 6 | 페이지 검사 `inspect_html` | 코드(별도 스레드) | HTML → 텍스트·요소(ID) | 1초 | 읽은 데까지 유지하고 LLM을 부르지 않는다 |
| 7 | 페이지 신호 제안 `analyze_page` | LLM ③ + 코드 검증 | 텍스트·요소 → 브랜드·주제·검증된 신호 | 5초 | `env`를 `partial`이나 `failed`로 둔다 |
| 8 | 결과 조립 `assemble_analysis` | 코드 | 1~7의 결과 → `AnalysisResponse` | | |
| 9 | 카드 선택 `select_result_card` | 코드(BE) | `AnalysisResponse` → R1·R2·R8·R9 | | 그 링크의 분석이 예외로 끝나면 R4 |

2·3은 첫 링크의 수집(4)과 함께 시작한다. 4~9는 링크마다 차례로 돈다.

**링크가 없는 문자** (1단계 `read_message`가 링크가 없다고 확인한 뒤. 전체 예산 `40 − 경과 초`)

| # | 단계 | 주체 | 상한 | 실패하면 |
| --- | --- | --- | --- | --- |
| 1 | 개인정보 가리기 `mask_pii` | 코드 | | |
| 2 | 주장 읽기 `read_claims` | LLM | 12초 | 어휘표로 읽는다(`reading_status=fallback`) |
| 3 | 사례 검색 | 코드 + 임베딩 | 2.5초 (2와 함께) | 미확인 |
| 4 | 인용 검증 `verify` | 코드 | | 버린 주장은 사유와 함께 `rejected`에 남긴다 |
| 5 | 공식 대표번호 대조 | 코드(KB) | | |
| 6 | 결론 관문 `decide_message` | 코드 | | 읽지 못했으면 `not_analyzable` |
| 7 | 카드 R6b·R6·R4와 Q1·Q2 | 코드(BE) | | |

**통화 녹음** (`analyze_call` 예산 `40 − 경과 초`. 5초 미만이면 0을 넘겨 LLM 단계를 건너뛴다)

| # | 단계 | 주체 | 상한 | 실패하면 |
| --- | --- | --- | --- | --- |
| 1 | 녹음 받기 `download_voice_media` | BE | 15초, 25 MB | 허용되지 않은 주소·내려받기 실패는 R4, 25 MB 초과·빈 파일은 VE2 |
| 2 | 형식 검사 `inspect_voice_audio` | BE | | 오디오가 아니면 VE1, 읽을 수 없으면 VE2 |
| 3 | 받아쓰기 `transcribe_call` | STT + 코드(문장 분할·개인정보 가림) | 30초 | 대본이 없으면 VE3, 호출 예외는 R4 |
| 4 | 주장 읽기 `read_claims` | LLM | 12초 | 어휘표로 읽는다 |
| 5 | 받는 사람 쪽 말 거르기·인용 검증 | 코드(`forms`, `verify`) | | 버린 주장은 `rejected` |
| 6 | 번호 대조 | 코드(KB) | | |
| 7 | 사례 검색 + 사례 첨부 관문 | 코드 + 임베딩 | 2.5초 (4와 함께) | 미확인 |
| 8 | 결론 관문 `gate` | 코드 | | |
| 9 | 카드 V1·VE4와 Q1 | 코드(BE) | | |

### 도구

| 도구 | 부르는 쪽 | 입력 → 출력 | 하지 않는 일 |
| --- | --- | --- | --- |
| 격리 수집 API `POST /collect` | BE | URL → 이동 경로, 상태 코드, HTML, 브라우저 기록 | 판정. 파일 저장·실행. 폼 입력·클릭·제출 |
| 공식 도메인 화이트리스트 | BE | 브랜드·호스트 → `official` / `brand_mismatch` / `not_registered` | 목록에 없는 브랜드를 추측하기 |
| 단축 주소 해석 | BE | 입력 주소와 리다이렉트 경로 → 첫 실제 호스트 | 직접 접속. 수집 결과만 읽는다 |
| 페이지 검사 `inspect_html` | AI | HTML → 텍스트·요소(ID) | 스크립트 실행, 외부 요청 |
| 사례 KB 검색 | AI | 본문·대본 → 유사 사례와 점수 | 판정에 쓰이기 |
| 규범 KB `find_guidance` | BE 카드 렌더러 | 결과의 brand·category·doubts·official → 공식 확인 방법 최대 3개 | LLM·자유 텍스트 사용 |
| 공식 대표번호 KB | AI | 기관 → 대표번호 | |
| LLM | AI | 시스템 프롬프트 + 데이터 구획 → 구조화 출력 | 도구 호출, 판정, 자유 텍스트 응답 |
| STT | AI | 녹음 → 대본 | 화자 분리 |
| 임베딩 | AI | 문장 → 벡터 | |

LLM에는 도구 호출 권한이 없다. 어떤 도구를 어떤 순서로 몇 번 부를지는 코드에 고정돼 있고, 페이지나 문자 내용으로 바꿀 수 없다.

### 상태

**작업 상태**

```
입력 ──▶ running ──┬──▶ completed   결과 저장 → 콜백
                   ├──▶ timeout     45초 초과
                   └──▶ failed      예외

callback_status : pending ──▶ success | failed
RUNNING_USERS   : 시작할 때 user_id 추가, 끝나면 제거 (그동안 새 입력은 K5)
```

작업은 프로세스 메모리 `ANALYSIS_JOBS[job_id]`에 있다(`main.py`).

| 필드 | 값 | 쓰임 |
| --- | --- | --- |
| `job_id` | UUID4 | 결과 카드 `자세히 보기` 버튼의 `extra.job_id` |
| `user_id` | 카카오 `userRequest.user.id` 원문 | 「결과 확인」에서 사용자의 가장 최근 작업을 찾는다 |
| `status` | `running` / `completed` / `failed` / `timeout` | K1·K2·R4 분기 |
| `created_at`, `completed_at` | ISO 8601 (UTC) | 최근 작업 선택, K2 확인 시각(KST HH:MM) |
| `result` | 렌더링한 카카오 응답 | 콜백 본문, 「결과 확인」 응답 |
| `final_payload` | `AnalysisResponse` / `MessageCaseResult` / `VoiceCaseResult`의 JSON | 캐러셀 재생성, Q1·Q2 답 처리. 링크가 여럿이면 마지막 링크 결과만 남는다 |
| `analysis_kind` | 없음(링크 문자) / `message_case` / `voice` | 렌더러·답 처리 선택 |
| `link_count` | 정수 | 2 이상이면 상세를 주지 않는다 |
| `qa_answers` | 통화 Q1 답 목록 | 통화 답 누적. 문자 답은 `final_payload.answers`에 쌓인다 |
| `error` | `analysis_timeout` 또는 예외 이름 | 진단 |
| `callback_status`, `callback_error` | `pending` → `success` / `failed`, 토큰을 뺀 요약 | 진단 |

**분석 값**

| 값 | 쓰는 곳 | 값의 종류 |
| --- | --- | --- |
| `url.official` | 링크 | `official`, `brand_mismatch`, `not_registered`, `unresolved` |
| `message.answer`, `env.answer` | 링크 | `no_risk_found`, `risk_found`, `partial`, `failed`, `not_run` |
| `conclusion` + `caution` | 링크 없는 문자·통화 | `suspected`, `official_domain`, `inconclusive`, `not_analyzable`, `input_required` + 주의 여부 |

**대화 상태:** 세션이 없다. 「결과 확인」은 그 사용자의 가장 최근 작업을 본다. Q1·Q2 답은 작업에 쌓이고, 답할 때마다 결론과 대응을 다시 정한다.

### 결론 규칙

**링크: 공식 도메인 대조** (`build_ai_url_analysis`, `services/official_domain_service.py`)

1. 단축 주소(9개 서비스)를 건너뛴 첫 실제 호스트를 대조 대상으로 삼는다.
2. 문자의 브랜드가 화이트리스트에 있고 도메인이 그 브랜드의 공식 도메인(또는 그 하위 도메인)이면 `official`, 아니면 `brand_mismatch`다. 브랜드가 목록에 없으면 `not_registered`, 호스트를 확인하지 못하면 `unresolved`다.
3. `official`이어도 아래 중 하나에 해당하면 `unresolved`로 내린다.
    - 최종 주소나 HTML이 없거나, 수집이 실패했다.
    - 리다이렉트 경로에 비공식 호스트가 있다.
    - 브라우저 수집이 실패했거나 내려받기가 일어났거나 이동 기록이 없다.
    - 브라우저의 이동 기록·이동 요청·최종 주소에 비공식 호스트가 있다(ADR 0009).

**링크: 카드 선택** (`select_result_card`, 위에서부터 먼저 맞는 것)

| 조건 | 카드 |
| --- | --- |
| 문자나 페이지에 검증된 신호가 하나라도 있다 | R1 `스미싱이 의심돼요` |
| `official`이고 문자·페이지가 모두 `no_risk_found` | R2 `○○ 공식 주소와 같아요` |
| `official`인데 위 조건을 못 채운다 | R9 `판단하기 어려워요` |
| `brand_mismatch`이고 브랜드를 안다 | R8 `공식 주소가 아니에요` |
| 그 밖(`not_registered`, `unresolved`, 브랜드 모름) | R9 |
| 그 링크의 분석이 예외로 끝났다 | R4 |

**링크 없는 문자·통화**

| 결론 | 링크 없는 문자 (`message_gate.py`) | 통화 (`gate.py`) |
| --- | --- | --- |
| `suspected` | 가족·지인 주장 + 돈·상품권·인증번호 요구 + Q2 답 "본인이 아니래요"(L-4) | 꼴이 맞은 기관 주장 + 꼴이 맞은 요구(송금·앱 설치·원격 제어·정보·인증번호·현금 전달), 또는 꼴이 맞은 지인 주장 + 꼴이 맞은 송금 요구(L-3) |
| `inconclusive` + 주의 | 위험 요구나 기관·지인 주장이 있지만 `suspected` 조건을 못 채웠다. 기관 사칭 문자는 주의까지만 쓴다 | 같다. 자주 사칭되는 공공기관 8곳은 주의까지만 쓴다(ADR 0010) |
| `input_required` | 신분 주장도 요구도 없다 → R6 | 사칭·요구가 없다 → VE4 |
| `not_analyzable` | 읽지 못했다 → R4 | 받아쓰지 못했다 → VE3 |

- Q2 답 "본인이 맞대요"는 주의만 끈다. 결론을 안전 쪽으로 옮기지 않는다.
- 통화에서 받는 사람 쪽 말(옮긴 말, 되묻기, 부탁 없는 물음, 1인칭 약속)은 근거에서 뺀다(ADR 0008).

### 예외

1. AI 함수는 취소(`CancelledError`) 말고는 예외를 올리지 않는다. 실패는 `failures`(FailureCode)와 `unchecked`에 남긴 결과로 돌려준다.
2. 메인 서버는 링크 하나의 분석 실패를 그 링크의 R4로 가둔다. 다른 링크의 결과는 그대로 보낸다.
3. 실패는 결론을 올리지도 내리지도 않는다. 수집 실패는 `unresolved`(판단 보류)가 되고, 읽기 실패는 분석 불가가 된다.
4. LLM 호출은 재시도하지 않는다. 격리 HTTP 수집만 시간 초과일 때 5초 상한으로 한 번 더 받는다.
5. 전체가 45초를 넘으면 작업을 취소하고 `timeout`으로 저장한다.

사용자에게 보이는 예외 응답은 3.3, 외부 의존 장애 대응은 3.4에 있다.

## 1.4 기술 스택

| 영역 | 기술 | 비고 |
| --- | --- | --- |
| 챗봇 채널 | 카카오 i 오픈빌더 스킬 + AI 챗봇 콜백 | 스킬 응답 5초, 콜백 1회 |
| 메인 서버 | Python 3.11 이상, FastAPI, uvicorn, httpx, idna | `requirements.txt` |
| AI 패키지 | pydantic 2, openai SDK 2, PyYAML, httpx | `ai/pyproject.toml`. 메인 서버에 editable로 설치한다 |
| LLM | OpenAI 호환 API(`LLM_MODEL`, 주장 읽기는 `CLAIMS_MODEL`) | 구조화 출력 `chat.completions.parse`, `temperature=0`, 재시도 0. 2026-10-31 실측 모델 `claude-haiku-5-5` |
| STT | whisper-large-v3, OpenAI 호환 `/v1/audio/transcriptions` | `language=korean` |
| 임베딩 | text-embedding-3-large, 엘리스 ML API의 OpenAI 호환 `/v1/embeddings` | |
| 사례 검색 | 문자 n-gram TF-IDF와 임베딩 코사인을 섞은 점수, 프로세스 메모리 색인 | 판정에 쓰지 않는다 |
| 사례 첨부 관문 | 순수 Python 선형 모델(`voice_gate.json`) | 학습은 오프라인 sklearn |
| 격리 서버 | Docker(읽기 전용 FS, `cap_drop: ALL`, seccomp, 메모리 1.5 GiB, CPU 1.5, PID 256, 비루트 사용자), Starlette + uvicorn(TLS 8443), httpx 0.28.1, Playwright 1.63.0 + Chromium, iptables 호스트 방화벽, systemd | `infra/isolation/` |
| 카드 | 카카오 스킬 응답 JSON 템플릿 41개, 이미지는 GitHub `develop` 브랜치 raw 주소 | `frontend/kakao-templates/` |
| 저장소 | 없음. 작업은 프로세스 메모리, KB는 Markdown·YAML·JSON 파일 | |
| 테스트 | pytest, pytest-asyncio | |

**기술 선택 이유**

| 선택 | 이유 | 대가 | 근거 |
| --- | --- | --- | --- |
| AI를 같은 프로세스의 패키지로 | 5초 예산에서 네트워크 왕복과 콜드 스타트를 없앤다 | AI만 따로 늘리지 못한다 | ADR 0001 |
| 자체 격리 수집기 | urlscan은 약 30초가 걸리고 통제할 수 없었다. 링크를 외부 스캐너에 제출하지 않는다 | EC2·방화벽·재배포를 직접 운영한다 | ADR 0002·0003 |
| 콜백 + 「결과 확인」 | 느린 경로에서도 결과가 나간다 | 콜백이 실패하면 사용자가 「결과 확인」을 보내야 한다 | ADR 0003 |
| 카드와 캐러셀만 | 챗봇 밖으로 나가지 않고, 토큰·조회 API·배포 대상이 늘지 않는다 | 글자 수 제약, 관측 원자료·시각을 못 보여 준다 | ADR 0005·0006 |
| 링크 추출을 LLM으로 | 정규식은 바꿔 적은 주소, 조사 붙은 주소, `@` 위장 주소를 놓친다 | LLM이 실패하면 링크를 모른다 | ADR 0007 |
| 결론을 코드 규칙으로 | 재현성과 설명 가능성 | 링크마다 다른 조사 경로를 고르지 못한다 | `fa4d414` |
| 통화 화자 분리 대신 문장 꼴 | 녹음 1건당 평균 4.9초를 줄이고 정상 통화 오탐을 줄였다 | 납치 유형 등 일부를 놓친다 | ADR 0008 |
| 브라우저 이동 요청까지 대조 | 스크립트로 이동하는 공식 사이트에도 결론을 준다 | 스냅샷 뒤의 이동은 보지 못한다 | ADR 0009 |
| 공공기관은 주의까지만 | 근거가 없어 "확인할 주소가 없어요"로 끝나던 문자를 막는다 | 정상 안내에도 주의가 나간다 | ADR 0010 |
| 프로세스 메모리 저장 | 프로토타입 검증 속도 | 재시작하면 사라지고 인스턴스를 늘릴 수 없다 | `main.py` TODO |

## 1.5 배포 구성

```
카카오 ──HTTPS──▶ Render: 메인 서버 (단일 프로세스 전제)
Render ──HTTPS :8443 · Bearer 토큰 · 인증서 고정──▶ EC2: 격리 서버   인바운드는 Render CIDR만
EC2    ──HTTPS :443만──▶ 인터넷                                   사설·예약·보호 IP와 IPv6 차단, fail-closed
Render ──HTTPS──▶ LLM · STT · 임베딩 API
카드 이미지 ◀── GitHub raw (develop 브랜치)
```

| 대상 | 배포 | 확인 |
| --- | --- | --- |
| 메인 서버 | Render. `uvicorn main:app`. 배포용 브랜치 `test/render`(브랜치 이름과 병합 이력 기준. Render 설정은 저장소에 없다) | 기동 로그 `[KB WARMUP]`·`[VOICE KB WARMUP]`. 적재가 끝난 뒤 요청을 받는다 |
| 격리 서버 | EC2. `infra/isolation/build.sh`로 이미지를 만들고 `install-units.sh`로 systemd 유닛을 깐다: 방화벽, 컨테이너(`Restart=always`), 하루 한 번 재생성, 5분마다 상태 확인 후 이상하면 재시작. 마지막 배포 2026-11-06 `d3fad6c` | `verify.py`. 순서와 되돌리기는 `docs/isolation-collector-api.md` |
| 카카오 챗봇 | 관리자센터: 폴백 블록 → 스킬 `/kakao/skill`, 헤더 `X-Skill-Secret`, 콜백 사용, `결과 확인` 블록, 봇 리스트 메뉴 3개. 블록 구성은 `docs/designs/chatbot-flow.md` 3절 | 개발 채널에서 카드 확인(`docs/designs/kakao-chatbot-build-guide.md`) |

**환경변수 (메인 서버)**

| 이름 | 쓰는 곳 | 비고 |
| --- | --- | --- |
| `APP_ENV` | 스킬 인증 | 기본 `production`. `local`·`test`만 비밀값 검사를 건너뛴다 (`.env.example`에 없음) |
| `KAKAO_SKILL_SECRET`, `KAKAO_SKILL_SECRET_PREVIOUS` | 스킬 인증 | 비면 모두 401. `_PREVIOUS`는 키 교체 기간에만 |
| `KAKAO_CALLBACK_HOSTS` | 콜백 허용 호스트 | 비면 `kakao.com`과 하위 도메인 |
| `KAKAO_MEDIA_HOSTS` | 녹음 다운로드 허용 호스트 | 비면 녹음 다운로드를 모두 거부한다 |
| `LLM_API_KEY`, `LLM_BASE_URL`, `LLM_MODEL` | 문자·페이지 LLM. 키는 STT·임베딩과 같이 쓴다 | 주소는 `/v1`까지 |
| `CLAIMS_MODEL` | 주장 읽기 | 비면 `LLM_MODEL` |
| `STT_BASE_URL`, `STT_MODEL` | 받아쓰기 | 주소에 `/v1`을 붙이지 않는다. 기본 `whisper-large-v3` |
| `EMBEDDING_BASE_URL`, `EMBEDDING_MODEL` | 사례 검색 임베딩 | 주소에 `/v1`을 붙이지 않는다. 기본 `text-embedding-3-large`. 비면 TF-IDF만 쓴다 (`.env.example`에 없음) |
| `ISOLATION_API_URL`, `ISOLATION_API_TOKEN`, `ISOLATION_API_CA_CERT` | 격리 수집 API | URL을 비우면 수집을 끈다(모든 링크가 수집 실패로 처리된다) |
| `LOG_LEVEL` | 로그 | |

격리 서버 설정(`collector.env`, `egress-hosts`, Render CIDR, 보호 호스트)은 `docs/isolation-collector-api.md` 6절에 있다. 비밀값은 팀 시크릿 저장소에서 받는다(`docs/runbook/secrets.md`).

---

# 2. 시나리오

> 💡 사용자 관점의 흐름·주요 동작

## 2.1 주요 동작 한눈에

| 사용자가 하는 일 | 서버가 하는 일 | 받는 카드 |
| --- | --- | --- |
| 채널에 처음 들어온다 | 관리자센터 웰컴 블록 | W1 |
| 문자를 붙여넣는다 | 작업을 만들고 백그라운드에서 분석한다 | R5 → 콜백으로 결과 |
| 녹음을 보낸다 | 내려받기, 받아쓰기, 분석 | R5 → 콜백으로 V1·VE |
| `자세히 보기`를 누른다 | 저장한 결과로 캐러셀을 만든다 | 캐러셀 |
| Q1·Q2 항목을 고른다 | 답을 쌓고 결론·대응을 다시 고른다 | K6·A2·새 R6b |
| 「결과 확인」을 보낸다 | 가장 최근 작업을 찾는다 | K1·K2·R4·K4 |
| 분석 중에 또 보낸다 | 새로 분석하지 않는다 | K5 |
| 하단 메뉴 `신고 상담`을 누른다 | 블록 이동 | B2 → B2a~B2d |

## 2.2 처음 들어왔을 때

> 🛡️ **의심되는 문자·전화, 먼저 확인해요**
> 반가워요, 피싱 확인을 도와주는 화기니예요. 의심스러운 문자나 통화 녹음을 보내주시면 확인 결과와 이유를 알려드려요.
> `[피싱 확인하기]` `[개인정보 처리 안내]`

- `개인정보 처리 안내`(W2): "문자 내용·링크와 통화 녹음을 확인에 사용해요. 이때 일부 정보를 외부 분석 서비스로 보내요." 상세(W2a)에 링크·문자·녹음을 각각 어디서 처리하는지 적는다.
- 하단 메뉴: `피싱 확인`(B1) / `신고 상담`(B2) / `개인정보 처리 안내`(W2)
- `피싱 확인하기`(B1)는 문자 복사하는 법(B1a), 아이폰·갤럭시에서 녹음 보내는 법(V0a)으로 잇는다.

## 2.3 링크가 있는 문자를 확인한다

1. 받은 문자를 복사해 채팅창에 붙여넣는다.
    > [택배 안내] 배송지 정보가 일치하지 않습니다. 아래에서 주소를 확인해 주세요. https://delivery-check.example
2. 5초 안에 R5가 온다.
    > ⏳ 보내 주신 내용을 확인하고 있어요. … 그동안 링크·송금·앱 설치는 하지 마세요. 결과가 안 오면 「결과 확인」을 보내 주세요.
3. 뒤에서는 링크를 읽고, 격리 서버가 링크를 열어 이동 경로와 페이지를 모으고, 공식 주소와 대조하고, 페이지를 검사한다. 사용자 기기는 링크에 닿지 않는다.
4. 결과 카드가 콜백으로 온다.

| 카드 | 언제 | 버튼 |
| --- | --- | --- |
| R1 ⚠️ 스미싱이 의심돼요 | 검증된 위험 신호가 있다. 예: 페이지가 앱 설치 파일 링크를 띄운다 | `자세히 보기` |
| R2 🔗 ○○ 공식 주소와 같아요 | 공식 주소이고 문자·페이지 모두 위험 신호를 찾지 못했다 | `공식 홈페이지 열기` `다른 문자 확인하기` |
| R8 🔎 공식 주소가 아니에요 | 등재된 브랜드를 내세웠는데 그 브랜드의 공식 주소가 아니다 | `다른 문자 확인하기` |
| R9 🤔 판단하기 어려워요 | 그 밖. 예: 택배사를 특정할 수 없거나 페이지에 접근하지 못했다 | `자세히 보기` `다른 문자 확인하기` |
| R4 🙏 이번에는 확인하지 못했어요 | 그 링크의 분석이 실패했다 | 없음 |

5. R1·R9에서 `자세히 보기`를 누르면 캐러셀이 온다: 의심 근거(문자 신호마다 한 장) → 📋 확인 범위 → 📵 문자 속 링크에 접속하지 마세요(`KISA 상담하기`) → 🏛️ 공식 확인 방법(0~3장).

- R2 본문은 "이번 결과는 주소 일치 여부에 대한 확인이에요. 보낸 사람과 문자 내용의 진위는 확인하지 못했어요."로 끝난다. 안전하다고 말하지 않는다.
- R9 본문에는 `✅ 확인한 것`, `❌ 확인하지 못한 것`, `📩 문자에 적힌 내용`이 있다.

## 2.4 링크가 없는 사칭 문자를 확인한다

1. 가족·지인·기관을 내세우는 문자를 붙여넣는다.
    > 엄마 나 폰 고장 나서 이 번호로 연락해. 급하게 상품권 좀 사 줄 수 있어?
2. R5를 거쳐 R6b가 온다. 이 예처럼 가족 주장과 상품권 요구가 함께 있으면 `주의가 필요한 문자예요`다. 멈출 행동, 확인 방법, 확인한 것·확인하지 못한 것이 함께 온다.
3. 아래에 Q1 `이미 하신 게 있나요?`와, 가족·지인이라고 한 문자에는 Q2 `원래 알던 번호로 통화해 보셨나요?`가 붙는다.
4. Q2에서 `본인이 아니래요`를 고르면 새 R6b `사칭 문자로 의심돼요`가 온다. Q1에서 `돈이나 상품권을 보냈어요`를 고르면 K6 `지금 먼저 하세요`(112 신고)가, `아무것도 안 했어요`면 A2(KISA 상담)가 온다.

- 사칭이나 요구하는 말이 없으면 R6 `사칭이나 요구하는 말을 찾지 못했어요`(`신고·상담하기` `다시 확인하기`)가 온다.
- 링크 없는 문자에는 "스미싱"이라는 말을 쓰지 않고 "사칭"으로 쓴다.

## 2.5 통화 녹음을 확인한다

1. 통화 녹음을 음성 메시지나 파일(m4a·mp3·wav·webm)로 보낸다. 보내는 법은 V0a가 안내한다.
2. R5를 거쳐 V1이 온다(`보이스피싱이 의심돼요` / `주의가 필요한 통화예요` / `판단하기 어려워요`). 예를 들어 "○○지검 수사관입니다 … 안전계좌로 옮기셔야 합니다"처럼 기관 자기소개와 송금 요구가 함께 있으면 `보이스피싱이 의심돼요`가 된다.
3. 아래에 Q1이 붙는다. `자세히 보기`는 녹음 캐러셀이다: 의심되는 말 → 비슷한 사례(있을 때) → 확인 범위 → 요구에 응하지 마세요(`1394 상담`) → 공식 확인 방법.

- 오류 카드: VE1 이 파일은 확인할 수 없어요(오디오가 아님) / VE2 이 녹음은 확인할 수 없어요(읽을 수 없음, 비었음, 25 MB 초과) / VE3 녹음 내용을 알아듣지 못했어요 / VE4 녹음에 사칭·요구하는 말이 없어요.

## 2.6 결과가 오지 않을 때

- 「결과 확인」을 보낸다 → K1 `아직 확인하고 있어요`(바로연결 `결과 확인`) / K2 "HH:MM에 확인한 결과예요." + 저장한 결과 / R4 / K4 `확인 결과를 찾지 못했어요`
- 분석 중에 다른 내용을 또 보내면 K5 `앞서 보내 주신 내용을 확인하고 있어요`가 오고, 새로 분석하지 않는다.

## 2.7 이미 링크를 눌렀거나 돈을 보냈을 때

하단 메뉴 `신고 상담`(B2)에서 상황을 고른다.

| 고른 상황 | 카드 | 연결 |
| --- | --- | --- |
| 문자만 받았어요 | B2a | 보내는 법 보기, KISA 상담(kisa.or.kr/118) |
| 링크를 눌렀어요 | B2b | KISA 전화 상담(118), KISA 채팅 상담 |
| 전화만 받았어요 | B2c | 녹음 보내는 법, 1394 상담 |
| 통화 중 돈·정보를 줬어요 | B2d | 112 신고, 1394 상담 |

## 2.8 예외 입력

| 입력 | 응답 |
| --- | --- |
| 빈 입력 | R6 |
| 8,192자를 넘는 문자 | "문자가 너무 길어서 확인하지 못했어요. 확인하고 싶은 부분만 복사해 다시 보내 주세요." |
| 주소처럼 보이는데 읽지 못했다 | "정확히 읽지 못해 검사하지 못했어요. 확인하고 싶은 주소를 그대로 복사해 다시 보내 주세요." 일부만 못 읽었으면 이 안내를 맨 앞에 두고 읽은 링크의 결과를 붙인다 |
| 링크가 여러 개 | 링크마다 결과 카드. `자세히 보기`는 주지 않는다 |
| 관련 없는 말(예: "배고파") | 따로 가리지 않고 분석한다. 사칭·요구가 없으면 R6 |

---

# 3. 요구사항 · 리스크

> 💡 가드레일·예외 처리·장애 대응 등 안정성

## 3.1 기능 요구사항

v1.0 ID와의 대응과 바뀐 이유는 `tech-spec-v1-to-v2-changes.md` 3~5절에 있다.

| ID | 요구사항 | 상태 |
| --- | --- | --- |
| FR-01 | 문자는 붙여넣기로, 녹음은 음성 메시지·파일 첨부(m4a·mp3·wav·webm)로 받는다 | 구현 |
| FR-02 | 링크가 여럿이면 모두 검사해 링크마다 결과 카드를 보낸다. 링크가 없으면 링크 없는 사칭 문자로 분석한다 | 구현 |
| FR-03 | 결과는 링크 R1·R2·R8·R9·R4, 링크 없는 문자 R6b·R6, 녹음 V1·VE1~VE4로 보낸다 | 구현 |
| FR-04 | 결과마다 확인한 것과 확인하지 못한 것을 보여 준다(본문, 캐러셀 확인 범위) | 구현 |
| FR-05 | `자세히 보기` 캐러셀로 의심 근거, 확인 범위, 접속 금지 안내, 공식 확인 방법을 보여 준다. 링크가 여럿이면 주지 않는다 | 구현 |
| FR-06 | 공식 확인 경로는 검토된 것만 쓴다(화이트리스트, `curated` 규범, 공식 대표번호) | 구현 |
| FR-07 | Q1·Q2로 이미 한 행동과 원래 번호 통화 여부를 묻고 답에 맞는 대응(K6·A2·새 R6b)을 보낸다 | 구현 |
| FR-08 | 링크 결과(R1·R9) 아래 Q1, A3 `링크만 눌렀어요` | 미구현 |
| FR-09 | 신고 상담 B2: 상황 4개로 KISA 118, 1394, 112에 잇는다 | 구현 |
| FR-10 | 첫 응답은 5초 안에 R5, 결과는 콜백으로 보낸다 | 구현 |
| FR-11 | 「결과 확인」으로 최근 결과를 다시 받는다 | 구현 |
| FR-12 | 분석 중 재입력은 K5로 답하고 다시 분석하지 않는다 | 구현 |
| FR-13 | 외부 처리 고지(W2·W2a) | 구현 |
| FR-14 | 외부 전송 직전 동의(W3·W3v)와 사용자별 동의 기록 | 미구현 (카드만 있음) |
| FR-15 | 근거마다 관측 시각·출처 표시 | 미구현 (K2 확인 시각만) |
| FR-16 | 재조회, 전송 결과 삭제 요청 | 미구현 |
| FR-17 | 다중 링크 요약 말풍선·캐러셀 | 미구현 (`chatbot-copy.md` 3절 초안) |
| FR-18 | 공식 도메인 즉답(R5 없이 R2) | 미구현 (D2) |

## 3.2 가드레일

| ID | 가드레일 | 강제 방법 | 상태 |
| --- | --- | --- | --- |
| GR-01 | 안전을 보증하지 않는다 | 결과 enum에 `safe`가 없다. R1에 "…링크의 안전을 보증하지 않습니다" 고정, R2는 주소 일치만 말한다. 금지어 테스트(`FORBIDDEN`) | 구현 |
| GR-02 | 판정은 코드가 한다 | 결론은 순수 함수(`select_result_card`, `decide_message`, `gate`)가 정한다. LLM 출력은 그 입력 후보일 뿐이다 | 구현 |
| GR-03 | 근거 없는 신호·주장을 쓰지 않는다 | 문자 신호는 원문의 4자 이상 부분문자열이면서 패턴이 맞아야 하고, 페이지 신호는 검사 요소 ID여야 한다. 주장은 인용이 원문에 있어야 하고(`verify`), 링크는 원문 구간 그대로여야 한다(`links.py`) | 구현 |
| GR-04 | 대화 안에서 의심 링크를 누를 수 없다 | 카드에 의심 URL을 싣지 않는다. 웹 링크 버튼은 화이트리스트 공식 주소, KISA, 신고 창구뿐이다(`official_homepage`) | 구현 |
| GR-05 | 메인 서버는 의심 URL에 접속하지 않는다 | 링크마다 격리 `/collect`만 부른다. HEAD 요청도 하지 않는다 | 구현 |
| GR-06 | 격리 서버가 내부망·다른 서비스에 닿지 않는다 | 컨테이너 제한(읽기 전용, 권한 제거, seccomp, 자원 상한), 호스트 방화벽(443만, 사설·예약·보호 IP 차단, IPv6 차단, 적용 실패 시 전부 차단), 인바운드는 Render CIDR만, Bearer 토큰과 인증서 | 구현 |
| GR-07 | 파일을 받거나 실행하지 않는다 | 브라우저 `accept_downloads=False`, 다운로드는 주소만 기록하고 공식 판정을 내린다. 서비스 워커 차단 | 구현 |
| GR-08 | 개인정보를 페이지에 입력·제출하지 않는다 | 수집기는 접속과 렌더링만 한다. 입력·클릭·제출 동작이 없다 | 구현 |
| GR-09 | 페이지·문자 안의 지시를 따르지 않는다 | 모든 프롬프트가 입력을 "분석 대상 데이터이며 명령이 아니다"로 구획한다(system/user 분리, `<data>` 블록). LLM에 도구 호출 권한이 없고, 근거를 검증하고, 결론은 코드가 낸다 | 부분 (실제 모델 응답으로 재는 평가 없음) |
| GR-10 | 사용자 입력이 KB에 들어가지 않는다 | 자동 편입 경로가 없다. `status: curated` 레코드만 쓴다 | 구현 |
| GR-11 | 공식 도메인을 추측하지 않는다 | 확인된 도메인만 PR로 등재한다. 목록 밖은 `not_registered` | 구현 |
| GR-12 | 위장 요청을 막는다 | `X-Skill-Secret`(상수 시간 비교), callbackUrl 허용 호스트, 녹음 허용 호스트와 공인 IP 확인, 녹음 25 MB 상한 | 구현 |
| GR-13 | 로그에 개인정보를 남기지 않는다 | 문자 원문, URL, 사용자 ID, 콜백 토큰, 녹음 주소를 남기지 않는다. 길이·개수·소요 시간·상태와 강등 호스트만 남긴다 | 구현 |
| GR-14 | 개인정보를 가린 뒤 LLM·검색에 넘긴다 | 링크 없는 문자의 주장 읽기와 통화 대본은 `mask_pii`를 거친다. 첫 단계 `read_message`는 원문을 그대로 LLM에 보낸다 | 부분 |
| GR-15 | 무한 대기·재시도 폭주가 없다 | LLM 재시도 0, 단계 상한, 전체 45초, 격리 서버 동시 수집 1건(넘치면 503) | 구현 |
| GR-16 | 확인하지 못한 것을 정상으로 말하지 않는다 | 실패·미확인은 R9·R4·VE로 보내고 `확인하지 못한 것`에 적는다. Q2 "본인이 맞대요"도 결론을 안전 쪽으로 옮기지 않는다 | 구현 |
| GR-17 | 외부 전송 전에 동의를 받는다 | | 미구현 (열린 결정 D-1) |

## 3.3 예외 처리

| ID | 상황 | 처리 | 사용자에게 보이는 것 |
| --- | --- | --- | --- |
| EX-01 | 스킬 비밀값이 없거나 다르다 | 401. 원인 코드만 로그(`[SKILL AUTH REJECTED] reason=`) | 카카오 쪽 오류 |
| EX-02 | 허용되지 않은 callbackUrl | 분석하지 않는다 | R4 |
| EX-03 | 빈 입력 | LLM을 부르지 않는다 | R6 |
| EX-04 | 8,192자 초과 | 읽지 않는다 | 너무 길다는 안내 글 |
| EX-05 | 문자 읽기 실패(LLM 오류·시간 초과·거부) | "링크 없음"으로 읽지 않는다 | R4 |
| EX-06 | 주소처럼 보이는데 못 읽었다 | 조사 대상을 만들지 않는다 | 안내 글(일부면 안내 글 + 읽은 링크 결과) |
| EX-07 | 격리 수집 실패·시간 초과·503 | `collection_failed`로 채워 문자 근거를 지킨다 | 대개 R9 (문자 신호가 있으면 R1) |
| EX-08 | 페이지 검사가 1초 상한이나 글자 상한에 걸렸다 | 읽은 데까지 유지하고 `partial` | R9 등 |
| EX-09 | 페이지 LLM 실패 | `env`를 `failed`·`partial`로 | R9 등 |
| EX-10 | 브라우저 실패, 다운로드, 이동 기록 없음, 비공식 경유 | 공식 판정을 `unresolved`로 내린다 | R9 |
| EX-11 | 링크 하나의 분석 예외 | 그 링크만 R4, 다른 링크 결과는 유지한다 | R4 |
| EX-12 | 전체 45초 초과 | 작업을 취소하고 `timeout`으로 저장한다 | 문자는 "분석이 예상보다 오래 걸리고 있어요…", 녹음은 R4. 이후 「결과 확인」은 R4 |
| EX-13 | 분석 중 예외 | `failed`로 저장한다 | "분석 중 문제가 발생했습니다. 잠시 후 다시 시도해주세요." |
| EX-14 | 콜백 전송 실패 | 결과는 이미 저장돼 있다 | 「결과 확인」으로 받는다 |
| EX-15 | 분석 중 재입력 | 새로 분석하지 않는다 | K5 |
| EX-16 | 작업이 없다(재시작 등) | | K4. `자세히 보기`는 "분석 결과를 찾을 수 없어요…" |
| EX-17 | 링크가 여럿인 결과의 상세 요청 | 상세를 주지 않는다 | "주소를 하나씩 다시 보내 주세요" 안내 글 |
| EX-18 | 녹음: 허용되지 않은 주소, 내려받기 실패 | | R4 |
| EX-19 | 녹음: 오디오가 아님 / 읽을 수 없음·비었음·25 MB 초과 | | VE1 / VE2 |
| EX-20 | 녹음: 받아쓰기 결과가 없다 | | VE3 |
| EX-21 | 주장 읽기 LLM 실패(링크 없는 문자·통화) | 어휘표로 읽는다 | 결과는 그대로 나간다 |
| EX-22 | 사례 검색·임베딩 실패 | 미확인으로 두거나 TF-IDF만 쓴다 | `비슷한 사례` 장이 빠진다 |

## 3.4 장애 대응

| ID | 장애 | 서비스 동작 | 알아채는 곳 | 대응·복구 |
| --- | --- | --- | --- | --- |
| OP-01 | LLM API 장애·지연 | 문자 읽기가 실패하면 R4. 신호·페이지 LLM이 실패하면 확보한 근거로 결과를 낸다. 주장 읽기는 어휘표로 폴백한다 | `message read elapsed … status=fallback failure=…`, `page llm elapsed … status=` | 공급자 상태 확인. 모델을 바꾸면 `docs/latency-budget.md` 상한을 다시 잰다 |
| OP-02 | STT 장애 | 녹음은 R4 또는 VE3 | `[VOICE STAGE] stage=stt status=failed` | |
| OP-03 | 임베딩 장애 | TF-IDF만으로 검색한다. KB 임베딩이 실패하면 5분 동안 다시 시도하지 않는다 | `query embedding elapsed`, `case embedding build failed` | |
| OP-04 | 격리 서버 장애·과부하 | 링크는 수집 실패로 판단 보류가 되고 문자 분석 결과는 나간다 | `[COLLECTION FAILED]`, `[OFFICIAL_CHECK] collect_failures=` | systemd가 컨테이너를 자동 재시작하고, 5분마다 상태를 보고 이상하면 재시작하며, 하루 한 번 새로 만든다 |
| OP-05 | 격리 서버 침해 의심 | | 방화벽 차단 패킷 수, VPC Flow Logs, 메인 서버의 수신 검증 실패, 401 횟수, `OOMKilled` | 고치지 말고 버린다: `ISOLATION_API_URL`을 비워 수집을 끈다 → 디스크 스냅샷 → 인스턴스 폐기·재생성 → 토큰·인증서 교체 → `docs/experiments/`에 기록(`docs/isolation-security.md` 5.12) |
| OP-06 | 메인 서버 재시작·슬립 | 작업, Q1 답, 분석 중 표시가 사라진다 | 기동 로그 `[KB WARMUP]` | 기동 때 KB를 적재한 뒤 요청을 받는다. 영속 저장소는 미구현(D-2) |
| OP-07 | 카카오 콜백 거절·만료 | 결과는 저장돼 있다 | `[CALLBACK STATUS]`, `[CALLBACK ERROR]`, `[CALLBACK SEND FAILED]` | 사용자가 「결과 확인」으로 받는다 |
| OP-08 | 스킬 비밀값 교체 | 교체 기간에는 두 값을 모두 받는다 | `[SKILL AUTH REJECTED] reason=secret_mismatch` | 옛 값을 `KAKAO_SKILL_SECRET_PREVIOUS`에 두고 관리자센터 헤더를 바꾼 뒤 지운다 |
| OP-09 | 격리 서버 재배포 실패 | | `verify.py` 실패 | `docs/isolation-collector-api.md`의 되돌리기 순서를 따른다 |

## 3.5 성능·한도

| 항목 | 상한 |
| --- | --- |
| 첫 응답 | 5초 (카카오 제약) |
| 전체 분석 | 45초 (`CALLBACK_DEADLINE_SECONDS`) |
| 문자 읽기 | 15초 (2026-10-31 실측 p50 1.7초, 최대 3.2초) |
| 격리 수집 API | 17초. HTTP 2초(시간 초과일 때만 5초로 1회 재시도), 브라우저 6초, 정리 여유 3초 |
| 페이지 검사 / 페이지 LLM | 1초 / 5초 |
| 사례 검색 / 질의 임베딩 | 2.5초 / 2초 |
| 콜백 전송 | 10초 |
| 녹음 다운로드 / STT / 주장 읽기 | 15초·25 MB / 30초 / 12초 |
| 링크 없는 문자·통화 분석 | `40 − 경과 초` |
| 입력·자료 크기 | 문자 8,192자, HTML 256 KiB, 격리 응답 1 MiB, URL 2,048자 |
| 이동 | 리다이렉트 5홉, 브라우저 이동 기록 10개, 이동 요청 20개, 다운로드 기록 5개 |
| 카카오 | 한 응답 말풍선 3개, 버튼 14자(가로 2개면 8자), 카드 본문 230자, 캐러셀 이미지 카드 본문 2줄, C4 128자 |

기준 문서는 `docs/latency-budget.md`다. 상한을 바꿀 때는 그 문서를 먼저 고친다(ADR 0004).

## 3.6 리스크

| ID | 리스크 | 영향 | 지금 대응 | 남은 일 |
| --- | --- | --- | --- | --- |
| RS-01 | 서버를 다시 띄우면 작업이 사라진다 | 「결과 확인」이 K4, Q1 답 처리 불가 | 안내 문구 | 영속 저장소(D-2) |
| RS-02 | 동의 게이트가 없다 | 사용자가 모르는 채 문자 원문·페이지 내용이 LLM API로, 녹음이 STT API로 나간다 | W2·W2a 고지 | D-1 |
| RS-03 | 문자 원문이 가림 없이 LLM API로 나간다 | 문자에 든 이름·전화번호·주소가 외부 API에 전달된다 | W2a 고지 | `read_message` 앞 마스킹 여부 결정(D-11) |
| RS-04 | 링크 방문 자체가 공격자에게 신호가 된다 | 수신자별 토큰 링크를 열면 "번호가 살아 있다"가 알려지고 1회용 링크가 소모된다 | 감수하고 검토 중(`docs/isolation-security.md` 5.8) | D-1 |
| RS-05 | 추출 LLM이 실패하면 링크를 모른다 | 그 요청의 링크 조사가 빠진다 | "링크 없음"으로 읽지 않고 R4로 안내 | 링크 추출 평가셋 |
| RS-06 | 스킴도 `www.`도 없는 링크를 LLM이 통째로 빠뜨린다 | 같은 문자에 공식 링크만 남으면 공식 결과가 나간다 | 없음 | 누락률 측정(ADR 0007) |
| RS-07 | 클로킹, 스냅샷 뒤 이동 | 격리 서버가 본 페이지가 사용자가 볼 페이지와 다르다 | 모바일 UA·화면 크기로 수집, 이동 요청 대조(ADR 0009), `확인하지 못한 것` 유지. 클로킹 판정은 운영 경로에 없다 | |
| RS-08 | 프롬프트 인젝션 | 신호 제안이 흔들린다 | 데이터 구획, 근거 검증, 결론은 코드 | 실제 모델 응답 평가(TC-03 자동화) |
| RS-09 | 화이트리스트가 좁다(11개 브랜드) | 목록 밖 브랜드는 늘 R9 | 추측으로 등재하지 않는다 | 등재 책임자와 절차(D-4) |
| RS-10 | 공공기관 주의 오탐 | 정상 우체국·국세청 안내에도 주의가 나간다 | 주의까지만 쓴다(ADR 0010) | 오탐이 문제가 되면 우체국부터 뺀다 |
| RS-11 | 통화의 받는 사람 쪽 말 거르기가 정규식이다 | 구어를 다 덮지 못해 놓치거나 잘못 거른다 | 꼴 규칙과 대리 평가(ADR 0008) | 운영 수치 확인 |
| RS-12 | 링크가 여럿일 때 시간·말풍선 상한 | 최악에는 링크 2개로도 45초에 걸려 끝낸 결과까지 시간 초과로 바뀐다. 링크가 4개 이상이고 모두 읽히면 말풍선이 3개를 넘는다(실기기 미확인) | 못 읽은 링크가 있을 때만 3개로 자른다 | 링크 수 상한 또는 요약 카드(FR-17) |
| RS-13 | CI가 테스트를 돌리지 않는다 | 회귀가 머지 뒤에 드러난다 | 로컬 pytest | CI 추가 |
| RS-14 | 카드 이미지가 `develop` 브랜치 GitHub 주소에 묶여 있다 | 이름을 바꾸면 운영 카드가 깨진다 | 이름을 바꾸거나 지우지 않는 운영 규칙 | |
| RS-15 | LLM 공급자·모델을 바꾸면 지연이 달라진다 | 단계 상한에 걸려 폴백이 늘어난다 | 실측으로 정한 상한 | 바꿀 때 다시 잰다 |

## 3.7 열린 결정

| ID | 대상 | 결정할 것 | 지금 상태 |
| --- | --- | --- | --- |
| D-1 | PM · BE · FE | 외부 전송 동의를 받을지, 받는다면 어디서 받을지. 격리 서버의 링크 방문(RS-04)을 감수할지 | 게이트 0곳으로 시험 운영 중 |
| D-2 | BE | 작업 영속 저장소와 보관 기간 | 메모리 |
| D-3 | PM · BE | 삭제 요청 절차, W2a 처리 방침의 정식 문구 | 시험 운영 문구 |
| D-4 | PM · BE | 공식 도메인과 규범의 검토·등재·갱신 책임자 | 코드 PR, 규범은 `curated`만 사용 |
| D-5 | FE · BE | 링크 결과 아래 Q1과 A3(D16) | 결정했고 구현하지 않았다 |
| D-6 | FE · BE | 다중 링크: 링크 수 상한, 요약 카드 | 링크마다 카드를 이어 붙인다 |
| D-7 | FE · BE | 공식 도메인 즉답(D2) | 공식 주소도 R5와 콜백을 거친다 |
| D-8 | BE · AI | 정적 검사(KISA 악성 도메인 목록, Punycode 혼동)와 도메인 등록일을 결과에 연결할지 | 정적 검사 코드만 있다 |
| D-9 | 전체 | 사용자 테스트 일정과 탈락 기준(안전하다고 오해한 횟수 0) | 미실행 |
| D-10 | AI · PM | KISA 결과 회수 루프로 운영 라벨을 모을지 | 미구현 |
| D-11 | AI · BE | `read_message` 전에 개인정보를 가릴지. 가리면 링크 추출·근거 인용과 충돌하지 않는지 확인 | 원문을 그대로 보낸다 |

---

# 4. 테스트 전략

> 💡 코드 테스트(유닛·통합)와 AI 응답 품질 점검

## 4.1 코드 테스트

| 수준 | 위치 | 범위 | 방식 |
| --- | --- | --- | --- |
| 유닛 | `ai/tests/` (테스트 파일 47개) | 추출·링크 검증(`test_read_message`, `test_links`), 신호 검증(`test_signals`, `test_signal_analysis`), 페이지 검사·분석(`test_page`, `test_page_analysis`), 결과 조립(`test_revision_*`, `test_pipeline_finalize`), 결론 관문·문장 꼴(`test_case_gate`, `test_case_forms`, `test_case_message`, `test_case_voice`), 검색(`test_search`, `test_semantic`, `test_voice_search`), KB 데이터(`test_kb_data`), 예산 전달(`test_client`) | 가짜 LLM 클라이언트. 네트워크를 쓰지 않는다 |
| 통합 | `tests/` (테스트 파일 41개) | 스킬 흐름(`test_read_message_flow`, `test_smishing_card_flow`, `test_link_reading_service_flow`, `test_message_case_flow`, `test_voice_message_flow`), 결과 확인·상세(`test_check_result`, `test_detail_carousel`, `test_voice_detail_routing`), 보안(`test_skill_auth`, `test_callback_security`, `test_media_guard`), 공식 대조(`test_official_domain_service`, `test_internal_url_analysis`, `test_official_check_diagnostics`), 격리 수집기(`test_isolation_*`, `test_collector_*`, `test_scanner_*`), 카드 계약(`test_c4_guidance_contract`, `test_text_detail_contract`, `test_result_card_*`) | FastAPI 테스트 클라이언트. AI·수집기는 스텁 |
| 계약 | `ai/tests/test_message_schema_contract.py`, `test_voice_schema_contract.py`, `tests/test_isolation_ai_contract.py` | 커밋한 JSON 스키마가 pydantic 모델과 같은지, 격리 수집 결과가 AI 입력으로 바뀌는지 | |
| 배포 검증 | `infra/isolation/verify.py`, `infra/isolation/checks/` | 격리 컨테이너 안의 방화벽·브라우저 런타임 | 배포 뒤 EC2에서 실행 |
| 실기기 | 카카오 개발 채널 | 카드 렌더링, 버튼 연결, 글자 잘림 | 수동 |

실행 (저장소 루트, `docs/runbook/local-setup.md`):

```bash
python -m pip install -r requirements-dev.txt
python -m pytest tests -q
python -X utf8 -m pytest ai/tests -q
```

- 테스트는 실제 LLM API를 부르지 않는다. 실제 스미싱 문자·URL로 테스트하지 않는다.
- 스키마를 바꾸면 `docs/contracts.md` 절차대로 JSON 스키마를 다시 만들고 같은 PR에 올린다.

## 4.2 AI 응답 품질 점검

| 점검 항목 | 방법 | 자료 | 상태 |
| --- | --- | --- | --- |
| 근거 충실성 | 인용이 원문에 있는지, 신호 근거가 요소 ID인지 코드가 검사하고 유닛 테스트가 지킨다 | `test_revision_results`, `test_case_verify` | 자동 |
| 금지 출력 | 결과 문구에 안전·정상 보증 표현이 없는지 | `FORBIDDEN` (`test_case_gate`, `test_case_message`) | 자동 |
| 인젝션 경계 | 페이지 LLM에 정제된 자료만 들어가는지(스크립트·속성·URL 비밀값 제거) | `test_prompt_uses_only_sanitized_page_data` | 자동. 실제 모델 응답 평가는 없다 |
| 폴백 | LLM 실패·거부·시간 초과에도 같은 모양의 결과가 나오는지 | `test_analyze`, `test_claims`, `test_read_message` | 자동 |
| 결론 재현성 | 같은 입력이면 같은 결론인지(순수 함수) | `test_case_gate`, `test_result_card_selector` | 자동 |
| 문자 사례 검색 | dev/test 분할로 검색 품질을 잰다 | `ai/eval/rag_eval.py`, `rag_testset.jsonl` 681건 | 수동, `ai/eval/reports/` |
| 통화 사례 검색·첨부 | hit@3, 정상 통화 부착률 5% 이하 | `voice_rag_eval.py`, `voice_gate_eval.py`, `voice_rag.jsonl` 326건 + 저장소 밖 실제 정상 | 수동 |
| 공식 확인 방법 고르기 | 규범 매칭 결과 | `ai/eval/guidance_eval.py` | 수동 |
| 결론 비율(대리 평가) | 어휘표 읽기 → 인용 검증 → 결론 관문(LLM 없음)으로 정상·사기 집합의 `suspected`·주의 비율 | `ai/eval/datasets`, 저장소 밖 FSS·KorCCVi·AI Hub | 수동 (ADR 0008·0010) |
| 링크 추출 | 기대 링크와 같은지, 소요 시간 | 문자 12건 × 2회 | 1회 실측 (2026-10-31) |
| 필수 회귀 케이스 | 주장·관측 구분, 접근 실패, 인젝션, 시간 한도, 근거 충실성, 안전 보증 금지, 설치·입력 요구, 공식 도메인 확인 | `ai/eval/cases/` TC-01~13 | 케이스 문서만. 자동화되지 않았고, 기준이 운영 경로에서 쓰지 않는 `ai/verdict.py`라 다시 써야 한다 |

**최근 측정**

| 항목 | 결과 | 출처 |
| --- | --- | --- |
| 링크 추출 | 24회 모두 기대와 같음. `read_message` p50 1.7초, 최대 3.2초 (`claude-haiku-5-5`) | `docs/latency-budget.md` |
| 통화 사례 검색 | 기준값 0.0807에서 hit@3 63.0%, 유형 평균 46.7%, 정상 부착 4.9~5.0% | `ai/eval/README.md` |
| 통화 결론(대리 평가) | 실제 정상 통화 4,500건 중 `suspected` 5건(0.1%). FSS 실제 보이스피싱 225건 중 27건(12.0%) | ADR 0008 |

대리 평가는 LLM 읽기 대신 어휘표를 쓰므로 운영 수치가 아니다. 합성 데이터 결과를 실제 탐지 성능으로 쓰지 않는다.

**비어 있는 곳:** CI 실행, 실제 모델 응답 기준 인젝션 평가, 링크 추출 누락률 평가셋, 링크 4개 이상이 모두 읽힌 경우, 사용자 테스트(PRD 2-3의 10건 `[미실행]`), 운영 로그로 재는 품질 지표(5절).

---

# 5. 추가 지표

> 💡 AI 품질 평가에 쓸 수집 값

## 5.1 지표 정의

| 지표 | 정의 | 수집 위치 | 지금 |
| --- | --- | --- | --- |
| **결과 분포** | | | |
| 결과 카드 분포 | 카드별 건수 ÷ 전체 결과 (R1·R2·R8·R9·R4, R6b·R6, V1·VE) | 통화는 `[VOICE STAGE] stage=card card=`, 링크 없는 문자는 `[MESSAGE CASE] conclusion=` | 부분. 링크 결과 카드 이름은 로그에 없다 |
| 판단 보류율 | R9 ÷ 링크 결과 | 위와 같음 | 추가 필요 |
| **판정 품질** (라벨 필요) | | | |
| 오탐률 | 정상 라벨인데 R1·`suspected` ÷ 정상 라벨 | 평가셋. 운영은 라벨 회수(D-10) 필요 | 평가셋만 |
| 누락률 | 사기 라벨인데 R2·R6·VE4 ÷ 사기 라벨 | 위와 같음 | 평가셋만 |
| 과잉 보류율 | 공식·정상 링크인데 R9 ÷ 공식·정상 링크 | 평가셋 + `[OFFICIAL_CHECK]` 강등 사유로 원인 분리 | 부분 |
| **LLM 단계 품질** | | | |
| 문자 읽기 폴백률 | `status=fallback` ÷ 읽기 호출, `failure` 코드별 | `message read elapsed` 로그 | 수집 |
| 페이지 LLM 폴백률 | 폴백 ÷ 페이지 LLM 호출, 코드별 | `page llm elapsed` 로그 | 수집 |
| 주장 읽기 폴백률 | `reading_status=fallback` ÷ 주장 읽기 | 통화는 `voice reading status=` 로그 | 통화만. 링크 없는 문자는 추가 필요 |
| 거부율 | `failure=refused` ÷ 호출 | 위 로그들 | 수집 |
| **근거 검증** | | | |
| 신호 채택률 | 검증 통과 신호 ÷ LLM이 제안한 신호 (문자·페이지 따로) | 없음 | 추가 필요 |
| 주장 탈락 사유 분포 | 버린 주장의 사유별 건수(`self_side` 등) | `voice reading … rejected=` | 통화만 |
| 못 읽은 링크 비율 | `unverified=True` ÷ 문자 | `[LINK COUNT]` | 수집 |
| **링크 추출** | | | |
| 링크 추출 누락률 | 기대 링크 중 못 뽑은 비율 | 평가셋 필요(ADR 0007 후속) | 미수집 |
| 원문 대조 탈락률 | LLM이 짚었지만 원문 대조에서 버린 구간 ÷ 짚은 구간 | 위와 같음 | 미수집 |
| **검색** | | | |
| 임베딩 질의 지연·실패율 | 소요 시간 분포, TF-IDF 폴백 비율 | `query embedding elapsed` | 지연만 |
| hit@3, 정상 부착률 | 통화 사례 검색 품질 | 평가 리포트 | 평가 때 |
| **공식 판정** | | | |
| 강등 사유 분포 | 사유별 건수 ÷ 최초 `official` | `[OFFICIAL_CHECK] demotion_reasons=` | 수집 |
| 강등 호스트 | 화이트리스트 검토 후보 | `[OFFICIAL_HOP] demotion_host=` | 수집 |
| **지연·안정성** | | | |
| 단계별 p50·p95 | 읽기, 수집, 페이지 검사·LLM, 임베딩, STT | 각 `elapsed` 로그, `[VOICE STAGE] elapsed_s=` | 수집 |
| 45초 초과율 | `[JOB TIMEOUT]` ÷ `[JOB CREATED]` | 작업 로그 | 수집 |
| 콜백 실패율 | 콜백 실패 ÷ 콜백 시도 | `[CALLBACK STATUS]`, `[CALLBACK SEND FAILED]` | 수집 |
| 「결과 확인」 사용률 | 「결과 확인」 요청 ÷ 작업 | 없음 | 추가 필요 |
| **사용자 반응** | | | |
| `자세히 보기` 클릭률 | 클릭 ÷ R1·R9·V1 | 없음 | 추가 필요 |
| Q1 답 분포 | 정보 입력·앱 설치·송금·아무것도 안 함 | 작업 메모리에만 있다 | 추가 필요 |
| 공식 홈페이지·상담 버튼 클릭 | R2 `공식 홈페이지 열기`, KISA·1394·112 | 카카오 관리자센터 통계(확인 필요) | 미확인 |
| 근거 이해도, 공식 경로 선택률 | 결과를 보고 근거를 설명하는지, 공식 경로를 고르는지 | 사용자 테스트 | 미수집 |

## 5.2 수집 원칙

- 문자 원문, URL, 사용자 ID, 전화번호를 남기지 않는다. 카드 이름, 코드, 개수, 소요 시간만 남긴다.
- 지표마다 분자·분모와 버전(코드 커밋, `prompts/v1`, KB 커밋, `LLM_MODEL`)을 함께 적는다.
- 합성 데이터의 결과를 실제 탐지 성능으로 쓰지 않는다. 운영 라벨은 KISA 결과 회수 같은 별도 경로가 필요하다(D-10).
- "추가 필요"로 표시한 값은 원문 없이 남길 수 있다. 예: 링크 결과 카드 이름, 신호 제안 수와 채택 수, 「결과 확인」·`자세히 보기` 요청 수.

---

# 6. 인터페이스 명세

> 💡 API 요청/응답 스펙

## 6.1 카카오 스킬 `POST /kakao/skill`

**요청 헤더:** `X-Skill-Secret: <KAKAO_SKILL_SECRET>` (`APP_ENV=local`·`test`에서는 생략)

**요청 본문** (서버가 읽는 필드)

```json
{
  "userRequest": {
    "utterance": "[택배 안내] 배송지 정보가 일치하지 않습니다. https://delivery-check.example",
    "user": { "id": "abcd1234..." },
    "callbackUrl": "https://<카카오 콜백 호스트>/...",
    "params": { "media": { "type": "audio", "url": "https://talk.kakaocdn.net/..." } }
  },
  "intent": { "name": "결과 확인" },
  "action": { "clientExtra": { "job_id": "6f1c..." } }
}
```

| 입력 | 서버가 보는 값 | 처리 |
| --- | --- | --- |
| `자세히 보기` 버튼 | `action.clientExtra.job_id` | 저장한 결과로 캐러셀 |
| Q1·Q2 항목 | `action.clientExtra.case_id`·`question_id`·`option_id`(문자는 `kind: "message"`) | 답 처리 |
| 「결과 확인」 | `intent.name == "결과 확인"` | K1·K2·R4·K4 |
| 녹음 | `userRequest.params.media.type == "audio"`, 또는 허용 CDN의 오디오 확장자 주소 하나뿐인 `utterance` | 녹음 흐름 |
| 그 밖 | `userRequest.utterance` | 문자 흐름 |

**응답**

| 경우 | 응답 |
| --- | --- |
| 분석을 시작한다(문자·녹음, `callbackUrl` 있음) | 콜백 사용 응답(R5) |
| 바로 답할 수 있다(빈 입력, K5, 결과 확인, 캐러셀, Q 답, 허용되지 않은 callbackUrl) | 스킬 응답(`template.outputs`) |
| `callbackUrl` 없음(개발·테스트) | 분석을 마친 스킬 응답 |
| 스킬 비밀값 불일치 | `401` |

콜백 사용 응답(R5):

```json
{
  "version": "2.0",
  "useCallback": true,
  "data": {
    "text": "⏳ 보내 주신 내용을 확인하고 있어요.\n\n결과는 이 채팅창으로 보내드릴게요.\n그동안 링크·송금·앱 설치는 하지 마세요.\n결과가 안 오면 「결과 확인」을 보내 주세요."
  }
}
```

결과 카드 예시(R1, 렌더러가 버튼에 `extra.job_id`를 넣는다):

```json
{
  "version": "2.0",
  "template": {
    "outputs": [
      {
        "basicCard": {
          "title": "⚠️ 스미싱이 의심돼요",
          "description": "문자 속 링크를 누르거나 앱을 설치하지 마세요.\n추가 확인이 필요하면 한국인터넷진흥원의 스미싱 확인 서비스를 이용해 주세요.\n화기니는 URL 분석 결과의 정확성과 링크의 안전을 보증하지 않습니다.",
          "thumbnail": { "imageUrl": "https://raw.githubusercontent.com/kakaotechcampus-4/ktc4-chonnam-1/develop/frontend/kakao-templates/assets/cards/r1-danger.png" },
          "buttons": [
            { "label": "자세히 보기", "action": "block", "blockId": "<자세히 보기 블록>", "extra": { "job_id": "6f1c..." } }
          ]
        }
      }
    ]
  }
}
```

Q1 리스트 카드 항목:

```json
{
  "listCard": {
    "header": { "title": "📌 이미 하신 게 있나요?" },
    "items": [
      {
        "title": "돈이나 상품권을 보냈어요",
        "action": "block",
        "blockId": "<답 블록>",
        "extra": { "case_id": "6f1c...", "question_id": "already_acted", "option_id": "sent_money", "kind": "message" }
      }
    ]
  }
}
```

- `outputs`는 3개까지다. 카드 종류는 `basicCard`, `textCard`, `listCard`, `carousel`, `simpleText`를 쓴다.
- 버튼 동작은 `block`(블록 이동, `extra` 전달), `webLink`(공식 주소·KISA만), `phone`(118·1394·112)이다.
- 답 선택지: `already_acted` = `entered_info`·`installed_app`·`sent_money`·`not_yet`·`unknown`, `called_known_number` = `not_person`·`is_person`·`no_answer`·`not_yet`·`unknown`.

## 6.2 콜백 `POST {callbackUrl}` (메인 서버 → 카카오)

- 본문은 6.1과 같은 스킬 응답(`version: "2.0"`, `template.outputs` 3개까지)이다. 전송 상한은 10초다.
- 보내기 전에 결과를 작업에 저장한다. 실패해도 「결과 확인」으로 같은 결과를 받는다.

| 상황 | 문자 | 녹음 | 작업 상태 |
| --- | --- | --- | --- |
| 완료 | 결과 카드 | 결과 카드 | `completed` |
| 45초 초과 | "분석이 예상보다 오래 걸리고 있어요. 잠시 후 다시 확인해주세요." | R4 | `timeout` |
| 예외 | "분석 중 문제가 발생했습니다. 잠시 후 다시 시도해주세요." | 같음 | `failed` |

## 6.3 작업 조회 `GET /api/analyses/{job_id}` (개발·테스트용)

- 요청 헤더: `X-Skill-Secret`
- `200`: `{ "success": true, "job": { "job_id": "…", "status": "completed", "created_at": "…", "completed_at": "…", "result": { … }, "final_payload": { … }, "callback_status": "success", … } }` (필드는 1.3 「상태」)
- `401`: 비밀값 불일치, `404`: `{"detail": "Analysis job not found"}`
- 사용자 브라우저에서 부르는 API가 아니다. 웹 결과 조회 API는 없다(ADR 0005).
- 테스트용으로 `POST /test/kakao/r1-lookalike`(카드 렌더링 확인)가 있다.

## 6.4 격리 수집 `POST /collect` (메인 서버 → 격리 서버)

전체 계약은 `docs/isolation-collector-api.md`에 있다.

```http
POST /collect HTTP/1.1
Authorization: Bearer <ISOLATION_API_TOKEN>
Content-Type: application/json

{"url": "https://fake.example-test.kr/track?id=1"}
```

| 상태 | 뜻 |
| --- | --- |
| 200 | 수집 결과. 수집에 실패해도 200이고 `failures`에 이유를 남긴다 |
| 400 | JSON이 아니거나 필드가 맞지 않음(본문은 `url` 하나, 2,048자까지) |
| 401 | 토큰 없음·불일치 |
| 413 | 요청 본문 4 KiB 초과 |
| 503 | 다른 수집이 진행 중. 기다리지 않고 거절한다(`Retry-After: 1`) |

200 응답(`CollectResult`, 960 KiB 이하로 줄여 보낸다. 메인 서버는 1 MiB를 넘으면 버린다):

```json
{
  "input_url": "https://fake.example-test.kr/track?id=1",
  "final_url": "https://fake.example-test.kr/track?id=1",
  "redirect_chain": [],
  "status_code": 200,
  "content_type": "text/html; charset=utf-8",
  "html": "<html>…</html>",
  "title": "배송 조회",
  "elapsed_ms": 140,
  "failures": [],
  "browser": null
}
```

`browser`는 3단계를 돌렸을 때만 있다: `trigger`(`script_only_page` / `script_redirect` / `status_403_404` / `always`), `final_url`, `navigation_chain`(최대 10), `navigation_requests`(최대 20), `html`(256 KiB), `title`, `downloads`(주소만, 최대 5), `blocked_requests`, `elapsed_ms`, `failures`.

## 6.5 AI 패키지 (메인 서버 안의 함수 호출)

| 함수 | 하는 일 | 출력 | LLM | 상한 |
| --- | --- | --- | --- | --- |
| `ai.pipeline.read_message(text, timeout_s)` | 요구·브랜드·주제·링크 추출, 링크 원문 대조 | `MessageReading`(`links`, `message`, `extracted`, `unverified_links`) | 1회 | BE 15초 |
| `ai.pipeline.analyze_message_part(text, extracted=)` | 사례 검색 + 문자 신호 제안·검증(읽기 재사용) | `MessagePart` | 1회 + 임베딩 | 검색 2.5초 |
| `ai.pipeline.finalize_analysis(url, message, page, failure=)` | 페이지 검사 + 페이지 신호 제안 + 조립 | `AnalysisResponse` | 자료가 있으면 1회 | 검사 1초, LLM 5초 |
| `ai.case.analyze_message_case(text, time_budget_s)` | 링크 없는 문자 분석 | `MessageCaseResult` | 1회 + 임베딩 | `40 − 경과 초` |
| `ai.case.transcribe_call(audio, filename)` | 받아쓰기, 문장 분할, 개인정보 가림 | `TranscriptResult` | STT 1회 | 30초 |
| `ai.case.analyze_call(transcript, time_budget_s)` | 통화 분석 | `VoiceCaseResult` | 1회 + 임베딩 | `40 − 경과 초` |
| `ai.case.apply_message_answer`, `apply_call_answers` | 답 반영 | 갱신한 결과 | 0 | |
| `ai.pipeline.warm_up_case_search`, `ai.case.warm_up_voice_case_search` | 기동 때 KB·색인·관문 모델 적재 | | 0 | |

연동 방법은 `docs/ai-be-python-integration.md`에 있다.

**`AnalysisResponse` (링크 문자, 전체 정의 `docs/scheme.md`)**

```jsonc
{
  "url": {
    "final_url": "https://delivery-example.com/login",   // 실제 방문한 최종 주소, 모르면 null
    "domain": "delivery-example.com",                     // 대조한 도메인
    "official": "not_registered",                         // official | brand_mismatch | not_registered | unresolved
    "scan": { "score": null, "scanned_at": null }         // 자리만 있다. 판정에 쓰지 않는다
  },
  "message": {
    "brand": "CJ대한통운", "category": "택배",
    "answer": "risk_found",                               // no_risk_found | risk_found | partial | failed | not_run
    "details": {
      "doubts":  [{ "value": "정보 입력", "evidence": "비밀번호를 입력해주세요" }],
      "signals": [{ "code": "credential_request", "evidence": "비밀번호를 입력해주세요" }],
      "reason":  { "text": "문자에서 '비밀번호를 입력해주세요'라고 안내했습니다.", "failures": [] }
    }
  },
  "env": {
    "brand": "CJ대한통운", "category": "택배", "answer": "partial",
    "collected_at": "2026-09-29T10:00:25Z",
    "details": {
      "doubts":  [{ "value": "로그인·인증 입력폼", "evidence": "비밀번호 입력 필드" }],
      "signals": [{ "code": "credential_request", "evidence": "비밀번호 입력 필드" }],
      "reason":  { "text": "…자료 크기 제한으로 전체를 확인하지 못했습니다.", "failures": ["input_too_large"] }
    }
  },
  "result": false                                         // official ∧ message no_risk_found ∧ env no_risk_found
}
```

- `RiskSignalCode`: `install_prompt`, `credential_request`, `dangerous_permission`, `remote_control`, `oversized_payload`, `packer_detected`, `brand_mismatch`
- `FailureCode`: `empty_input`, `missing_result`, `collection_failed`, `timeout`, `input_too_large`, `partial_content`, `llm_error`, `refused`, `invalid_output`
- `answer`는 완료 여부를 먼저 본다(`not_run` → `failed` → `partial` → `risk_found` → `no_risk_found`). `partial`이어도 `signals`가 있으면 검증된 위험 근거가 있다는 뜻이다.

**`MessageCaseResult` / `VoiceCaseResult` (링크 없는 문자·통화, JSON 스키마 `contracts/schemas/`)**

| 필드 | 문자 | 통화 | 내용 |
| --- | --- | --- | --- |
| `scenario` | ○ | ○ | `impersonation_no_link` / `voice_phishing` |
| `conclusion`, `caution` | ○ | ○ | 결론(5값)과 주의 여부 |
| `evidence`, `claims`, `rejected` | ○ | ○ | 검증된 근거, 신분·요구 주장, 버린 주장과 사유 |
| `stop_actions`, `response_actions` | ○ | ○ | 멈출 행동, 이미 했을 때의 대응 |
| `verify_actions` | ○ | | 원래 번호로 확인하기 등 |
| `questions` | ○ | ○ | 붙일 질문(Q1·Q2) |
| `checked`, `unchecked` | ○ | ○ | 확인한 것, 확인하지 못한 것 |
| `number_checks`, `links` | | ○ | 번호 대조, 말로 부른 주소(`origin="spoken"`) |
| `official_contact`, `similar_cases` | ○ | ○ | 공식 대표번호, 사례 검색 결과 |
| `answers`, `basis_from_answer` | ○ | | 쌓인 답, 답이 근거가 됐는지 |
| `reading_status`, `failures`, `explanation` | ○ | ○ | 읽기 폴백 여부, 실패 원인, 템플릿 설명 |

## 6.6 외부 AI API 호출

| 대상 | 요청 | 응답 처리 |
| --- | --- | --- |
| LLM | `chat.completions.parse(model, messages=[system: 단계 프롬프트(prompts/v1), user: 데이터], response_format=<pydantic 모델>, temperature=0)`, 클라이언트 `max_retries=0`, 단계별 `timeout` | `refusal`이면 `refused`, 파싱 실패면 `invalid_output`, 시간 초과면 `timeout`으로 폴백 |
| STT | `POST {STT_BASE_URL}/v1/audio/transcriptions`, `Authorization: Bearer <LLM_API_KEY>`, multipart `file`, `model`, `language=korean` | 본문의 `text`(또는 `transcript.text`)를 쓴다 |
| 임베딩 | `POST {EMBEDDING_BASE_URL}/v1/embeddings`, `{"model": …, "input": [문장…]}` (KB를 만들 때만 64개씩 묶음) | 단위 벡터로 정규화한다. 실패하면 TF-IDF만 쓴다 |
