"""팀 저장소 기준 커밋의 파일 목록과, 본문에 나온 커밋 번호 중 실제로 있는 것을 assets/repo-meta.json 에 적는다.

본문의 코드 경로와 커밋 번호를 GitHub 링크로 바꾸는 데 쓴다(assets/app.js).

    python3 tools/build_meta.py <팀 저장소 경로>
"""
import json
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TEAM_REPO = Path(sys.argv[1])
BASE = "45871b8"
REPO_URL = "https://github.com/kakaotechcampus-4/ktc4-chonnam-1"


def git(*args: str) -> str:
    return subprocess.run(["git", "-C", str(TEAM_REPO), *args],
                          capture_output=True, text=True, check=True).stdout


files = [f for f in git("ls-tree", "-r", "--name-only", BASE).splitlines()
         if not f.startswith("docs/archive/")]
dirs = sorted({str(Path(f).parent) for f in files if "/" in f})
# 상위 폴더까지 모두 넣는다 (infra/ 같은 것).
all_dirs = set()
for d in dirs:
    parts = d.split("/")
    for i in range(1, len(parts) + 1):
        all_dirs.add("/".join(parts[:i]))

text = "\n".join(p.read_text(encoding="utf-8") for p in (ROOT / "content").rglob("*.md"))
candidates = set(re.findall(r"`([0-9a-f]{7})`", text))
commits = []
for sha in sorted(candidates):
    ok = subprocess.run(["git", "-C", str(TEAM_REPO), "cat-file", "-e", f"{sha}^{{commit}}"],
                        capture_output=True).returncode == 0
    if ok:
        commits.append(sha)

meta = {"repo": REPO_URL, "base": BASE, "files": files, "dirs": sorted(all_dirs), "commits": commits}
(ROOT / "assets" / "repo-meta.json").write_text(json.dumps(meta, ensure_ascii=False), encoding="utf-8")
print(f"files={len(files)} dirs={len(all_dirs)} commits={commits} missing={sorted(candidates - set(commits))}")
