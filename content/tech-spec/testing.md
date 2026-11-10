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
