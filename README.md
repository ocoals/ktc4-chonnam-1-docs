# 화기니 개발 문서 포털

카카오테크캠퍼스 4기 전남대 1팀 최종 산출물 제출용 문서 사이트입니다. 팀 저장소(`kakaotechcampus-4/ktc4-chonnam-1`)와 따로 둡니다.

- `/tech-spec/`: 테크스펙 (제출 항목 5)
- `/collab/`: 협업문서 (제출 항목 6)

## 구조

| 경로 | 내용 |
| --- | --- |
| `content/<portal>/nav.json` | 왼쪽 목차 |
| `content/<portal>/*.md` | 본문. 이 파일만 고치면 화면에 반영됩니다 |
| `source/` | 팀원이 넘겨준 원본 스펙 |
| `assets/repo-meta.json` | 본문의 코드 경로, 커밋 번호를 GitHub 링크로 바꿀 때 쓰는 목록 |
| `tools/build_meta.py` | 위 목록을 다시 만듭니다 |

빌드 단계가 없는 정적 사이트입니다. Markdown은 브라우저에서 marked로 그리고, 그림은 mermaid로 그립니다.

## 로컬에서 보기

```bash
python3 -m http.server 4173
```

## 근거 링크 목록 다시 만들기

본문에 커밋 번호를 새로 적었으면 다시 만듭니다.

```bash
python3 tools/build_meta.py ../ktc4-chonnam-1
```

문서의 코드 경로와 커밋은 팀 저장소의 기준 커밋 `45871b8` 시점으로 열립니다.
