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
