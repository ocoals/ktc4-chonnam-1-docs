# 6. 인터페이스 명세

| 인터페이스 | 방향 | 인증 | 상한 |
| --- | --- | --- | --- |
| `POST /kakao/skill` | 카카오 → 메인 서버 | `X-Skill-Secret` 헤더 | 첫 응답 5초 |
| `POST {callbackUrl}` | 메인 서버 → 카카오 | 허용 호스트만 | 10초, 1회 |
| `POST /collect` | 메인 서버 → 격리 서버 | Bearer 토큰, 인증서 | 17초, 응답 1 MiB |
| `ai` 패키지 함수 | 메인 서버 안 함수 호출 | 없음 | 단계마다 다름 |

## 카카오 스킬 `POST /kakao/skill`

하나의 주소가 문자, 녹음, 버튼, 「결과 확인」을 모두 받고 아래 순서로 나눕니다.

| 받은 것 | 서버가 보는 값 | 처리 |
| --- | --- | --- |
| `자세히 보기` 버튼 | `action.clientExtra.job_id` | 저장한 결과로 캐러셀 |
| 질문 답 | `clientExtra.question_id`, `option_id` | 답을 쌓고 결론을 다시 정함 |
| 「결과 확인」 | `intent.name` | 가장 최근 작업 결과 |
| 녹음 | `params.media.type == "audio"` | 녹음 흐름 |
| 그 밖 | `userRequest.utterance` | 문자 흐름 |

분석을 시작할 때는 콜백 응답으로 바로 답합니다.

```json
{
  "version": "2.0",
  "useCallback": true,
  "data": { "text": "⏳ 보내 주신 내용을 확인하고 있어요. …" }
}
```

## 격리 수집 `POST /collect`

```http
POST /collect HTTP/1.1
Authorization: Bearer <ISOLATION_API_TOKEN>

{"url": "https://fake.example-test.kr/track?id=1"}
```

수집에 실패해도 `200` 으로 답하고 `failures` 에 이유를 남깁니다. 다른 수집이 진행 중이면 기다리지 않고 `503` 으로 거절합니다.

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
- 신호의 `evidence` 는 원문에 실제로 있는 문장이어야 채택됩니다.

전체 필드와 링크 없는 문자, 통화 결과 형식은 [원문 6장](#spec-detail/6-인터페이스-명세)에 있습니다.
