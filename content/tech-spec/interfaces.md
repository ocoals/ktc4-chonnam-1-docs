# 6. 인터페이스 명세

| 인터페이스 | 방향 | 인증 | 상한 |
| --- | --- | --- | --- |
| `POST /kakao/skill` | 카카오 → 메인 서버 | `X-Skill-Secret` 헤더 | 첫 응답 5초 |
| `POST {callbackUrl}` | 메인 서버 → 카카오 | 허용 호스트만 | 10초, 1회 |
| `POST /collect` | 메인 서버 → 격리 서버 | Bearer 토큰, 인증서 | 17초, 응답 1 MiB |
| `ai` 패키지 함수 | 메인 서버 안 함수 호출 | 없음 | 단계마다 다름 |
| 외부 AI API | 메인 서버 → LLM, STT, 임베딩 | API 키 | 단계마다 다름, 재시도 없음 |

## 카카오 스킬 `POST /kakao/skill`

하나의 주소가 문자, 녹음, 버튼, 「결과 확인」을 모두 받고 아래 순서로 나눕니다.

| 받은 것 | 서버가 보는 값 | 처리 |
| --- | --- | --- |
| `자세히 보기` 버튼 | `action.clientExtra.job_id` | 저장한 결과로 캐러셀 |
| 질문 답 | `clientExtra.question_id`, `option_id` | 답을 쌓고 결론을 다시 정함 |
| 「결과 확인」 | `intent.name` | 가장 최근 작업 결과 |
| 녹음 | `params.media.type == "audio"` | 녹음 흐름 |
| 그 밖 | `userRequest.utterance` | 문자 흐름 |

**요청 본문** (서버가 읽는 필드)

```json
{
  "userRequest": {
    "utterance": "고객님 명의로 결제가 요청되었습니다. https://pay-cancel.example",
    "user": { "id": "abcd1234..." },
    "callbackUrl": "https://<카카오 콜백 호스트>/...",
    "params": { "media": { "type": "audio", "url": "https://talk.kakaocdn.net/..." } }
  },
  "intent": { "name": "결과 확인" },
  "action": { "clientExtra": { "job_id": "6f1c..." } }
}
```

**응답**

| 경우 | 응답 |
| --- | --- |
| 분석을 시작한다(문자, 녹음) | 콜백 사용 응답. 결과는 콜백으로 보냅니다 |
| 바로 답할 수 있다(빈 입력, 분석 중, 결과 확인, 캐러셀, 질문 답) | 스킬 응답(`template.outputs`) |
| 스킬 비밀값 불일치 | `401` |

```json
{
  "version": "2.0",
  "useCallback": true,
  "data": { "text": "⏳ 보내 주신 내용을 확인하고 있어요. …" }
}
```

## 콜백 `POST {callbackUrl}`

본문은 스킬 응답과 같은 형식(`template.outputs` 3개까지)입니다. 보내기 전에 결과를 저장하므로, 실패해도 「결과 확인」으로 같은 결과를 받습니다.

| 상황 | 보내는 것 | 작업 상태 |
| --- | --- | --- |
| 완료 | 결과 카드 | `completed` |
| 45초 초과 | 오래 걸리고 있다는 안내 | `timeout` |
| 예외 | 잠시 후 다시 시도해 달라는 안내 | `failed` |

## 격리 수집 `POST /collect`

```http
POST /collect HTTP/1.1
Authorization: Bearer <ISOLATION_API_TOKEN>

{"url": "https://fake.example-test.kr/track?id=1"}
```

| 상태 | 뜻 |
| --- | --- |
| 200 | 결과를 돌려줍니다. 수집에 실패해도 200이고 `failures` 에 이유를 남깁니다 |
| 400 | 본문 형식이 맞지 않음(`url` 하나, 2,048자까지) |
| 401 | 토큰 없음, 불일치 |
| 503 | 다른 수집이 진행 중. 기다리지 않고 거절합니다 |

```json
{
  "final_url": "https://fake.example-test.kr/track?id=1",
  "redirect_chain": [],
  "status_code": 200,
  "html": "<html>…</html>",
  "failures": [],
  "browser": null
}
```

`browser` 는 스크립트로 이동하는 페이지처럼 브라우저가 필요할 때만 채워지며, 브라우저 이동 기록과 내려받기 시도 주소가 들어갑니다.

## AI 패키지 함수

| 함수 | 하는 일 | 출력 | 상한 |
| --- | --- | --- | --- |
| `read_message` | 업체, 요구, 링크 추출과 원문 대조 | `MessageReading` | 15초 |
| `analyze_message_part` | 사례 검색과 문자 위험 신호 제안 | `MessagePart` | 검색 2.5초 |
| `finalize_analysis` | 페이지 검사와 페이지 신호 제안, 결과 조립 | `AnalysisResponse` | 검사 1초, LLM 5초 |
| `analyze_message_case` | 링크 없는 문자 분석. 판단을 보류한 링크 문자의 주의 판단에도 씁니다(`has_link=True`) | `MessageCaseResult` | 남은 시간 |
| `transcribe_call` | 받아쓰기, 문장 나누기, 개인정보 가리기 | `TranscriptResult` | 30초 |
| `analyze_call` | 통화 분석 | `VoiceCaseResult` | 남은 시간 |

## AI 결과 `AnalysisResponse` (링크 문자)

```jsonc
{
  "url":     { "domain": "delivery-example.com", "official": "not_registered" },
  "message": { "brand": "CJ대한통운", "answer": "risk_found",
               "details": { "signals": [{ "code": "credential_request", "evidence": "비밀번호를 입력해주세요" }] } },
  "env":     { "answer": "partial", "details": { "signals": [ … ] } },
  "result":  false
}
```

- `official`: `official`, `brand_mismatch`, `not_registered`, `unresolved`
- `answer`: `no_risk_found`, `risk_found`, `partial`, `failed`, `not_run`
- 신호 `code`: `install_prompt`, `credential_request`, `dangerous_permission`, `remote_control` 등
- 신호의 `evidence` 는 원문에 실제로 있는 문장이어야 채택됩니다.

## AI 결과 `MessageCaseResult`, `VoiceCaseResult` (링크 없는 문자, 통화)

| 필드 | 내용 |
| --- | --- |
| `conclusion`, `caution` | 결론(의심, 판단 보류, 분석 불가 등)과 주의 여부 |
| `claims`, `evidence`, `rejected` | 신분과 요구 주장, 검증된 근거, 버린 주장과 이유 |
| `stop_actions`, `response_actions` | 멈춰야 할 행동, 이미 했을 때의 대응 |
| `questions` | 붙일 질문 카드 |
| `checked`, `unchecked` | 확인한 것, 확인하지 못한 것 |
| `similar_cases`, `official_contact` | 비슷한 사례(사례마다 수법 유형 `type`), 공식 대표번호 |

근거 코드에는 링크가 있는 문자에서만 쓰는 미끼 두 가지(`account_lock_lure` 계정 정지 해제, `lottery_lure` 로또 당첨)가 있습니다. 둘 다 결론은 판단 보류(`inconclusive`)로 두고 주의(`caution`)만 켭니다.
