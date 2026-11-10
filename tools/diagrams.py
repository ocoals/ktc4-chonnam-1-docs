"""포털 그림(SVG)을 만든다. 로고는 tools/icons/ 의 simple-icons 경로를 그대로 넣는다.

    python3 tools/diagrams.py

결과는 assets/diagrams/*.svg 이고, 본문에서 <img> 로 불러온다.
그림 하나가 파일 하나라 외부 요청 없이 그대로 보인다.
"""
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
ICONS = ROOT / "tools" / "icons"
OUT = ROOT / "assets" / "diagrams"

FONT = "Pretendard, 'Apple SD Gothic Neo', 'Noto Sans KR', 'Malgun Gothic', sans-serif"
INK = "#1d2330"
MUTED = "#5d6677"
LINE = "#d5dae3"
ACCENT = "#1f4fd8"

BRAND = {
    "kakaotalk": "#3C1E1E",
    "fastapi": "#009688",
    "python": "#3776AB",
    "docker": "#2496ED",
    "amazonec2": "#FF9900",
    "render": "#000000",
    "googlechrome": "#4285F4",
    "claude": "#D97757",
    "github": "#181717",
    "githubactions": "#2088FF",
    "git": "#F05032",
    "pydantic": "#E92063",
}


def icon_path(name: str) -> str:
    text = (ICONS / f"{name}.svg").read_text(encoding="utf-8")
    return re.search(r'<path d="([^"]+)"', text).group(1)


def icon(name: str, x: float, y: float, size: float, color: str | None = None) -> str:
    s = size / 24
    return (f'<path d="{icon_path(name)}" fill="{color or BRAND[name]}" '
            f'transform="translate({x} {y}) scale({s})"/>')


def text(x, y, s, size=15, weight=500, color=INK, anchor="middle"):
    return (f'<text x="{x}" y="{y}" font-size="{size}" font-weight="{weight}" fill="{color}" '
            f'text-anchor="{anchor}" font-family="{FONT}">{s}</text>')


def tile(x, y, w, h, name, title, sub=None, bg="#ffffff", icon_bg=None):
    """로고 하나와 이름이 들어간 카드."""
    parts = [f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="14" fill="{bg}" stroke="{LINE}" stroke-width="1.5"/>']
    size = 34
    ix, iy = x + w / 2 - size / 2, y + 16
    if icon_bg:
        parts.append(f'<rect x="{ix - 7}" y="{iy - 7}" width="{size + 14}" height="{size + 14}" rx="10" fill="{icon_bg}"/>')
    if name:
        parts.append(icon(name, ix, iy, size))
    parts.append(text(x + w / 2, y + 76, title, 15, 700))
    if sub:
        parts.append(text(x + w / 2, y + 95, sub, 12, 500, MUTED))
    return "\n".join(parts)


def group(x, y, w, h, title, name=None, sub=None, dashed=False):
    """여러 카드를 묶는 큰 상자. 왼쪽 위에 로고와 이름."""
    dash = ' stroke-dasharray="6 5"' if dashed else ""
    parts = [f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="20" fill="#f8f9fb" stroke="{INK}" stroke-width="2"{dash}/>']
    tx = x + 18
    if name:
        parts.append(icon(name, x + 16, y + 14, 22))
        tx = x + 46
    parts.append(text(tx, y + 32, title, 16, 800, anchor="start"))
    if sub:
        parts.append(text(x + w - 16, y + 32, sub, 12, 600, MUTED, anchor="end"))
    return "\n".join(parts)


def arrow(x1, y1, x2, y2, label=None, lx=None, ly=None, both=False, color=INK, dashed=False):
    dash = ' stroke-dasharray="6 5"' if dashed else ""
    start = ' marker-start="url(#arrow-start)"' if both else ""
    parts = [f'<line x1="{x1}" y1="{y1}" x2="{x2}" y2="{y2}" stroke="{color}" stroke-width="2.2"{dash} marker-end="url(#arrow)"{start}/>']
    if label:
        lines = label.split("\n")
        cx = lx if lx is not None else (x1 + x2) / 2
        cy = ly if ly is not None else (y1 + y2) / 2
        for i, line in enumerate(lines):
            parts.append(text(cx, cy + i * 16, line, 12.5, 600, MUTED))
    return "\n".join(parts)


def person(x, y):
    return (f'<circle cx="{x}" cy="{y}" r="17" fill="none" stroke="{INK}" stroke-width="2.4"/>'
            f'<path d="M{x - 30} {y + 58} q0 -34 30 -34 q30 0 30 34" fill="none" stroke="{INK}" stroke-width="2.4"/>')


def globe(x, y, r=22):
    return (f'<circle cx="{x}" cy="{y}" r="{r}" fill="#fff" stroke="#c2410c" stroke-width="2.2"/>'
            f'<ellipse cx="{x}" cy="{y}" rx="{r * 0.45}" ry="{r}" fill="none" stroke="#c2410c" stroke-width="1.8"/>'
            f'<line x1="{x - r}" y1="{y}" x2="{x + r}" y2="{y}" stroke="#c2410c" stroke-width="1.8"/>')


def svg(w, h, body):
    return f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {w} {h}" width="{w}" height="{h}" role="img">
<defs>
  <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0 L10 5 L0 10 z" fill="{INK}"/></marker>
  <marker id="arrow-start" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0 L10 5 L0 10 z" fill="{INK}"/></marker>
</defs>
<rect width="{w}" height="{h}" fill="#ffffff"/>
{body}
</svg>
'''


def architecture() -> str:
    b = []
    # 사용자와 카카오
    b.append(person(52, 262))
    b.append(text(52, 352, "사용자", 15, 700))
    b.append(arrow(90, 290, 124, 290, both=True))
    b.append(tile(128, 232, 130, 112, "kakaotalk", "카카오톡 채널", "오픈빌더 스킬", icon_bg="#FFCD00"))
    # 메인 서버
    b.append(group(350, 100, 370, 400, "메인 서버", "render", "Render"))
    b.append(arrow(258, 288, 350, 288, both=True))
    b.append(text(304, 268, "스킬 요청", 12.5, 600, MUTED))
    b.append(text(304, 312, "결과는 콜백", 12.5, 600, MUTED))
    b.append(tile(374, 150, 150, 112, "fastapi", "스킬 서버", "main.py, services/"))
    b.append(tile(548, 150, 150, 112, "python", "ai 패키지", "읽기, 근거 검증"))
    b.append(arrow(524, 206, 546, 206))
    b.append(tile(374, 290, 150, 112, None, "작업 저장", "결과 확인 조회"))
    b.append(f'<rect x="425" y="306" width="48" height="36" rx="6" fill="#eaf0ff" stroke="{ACCENT}" stroke-width="1.6"/>')
    b.append(f'<line x1="433" y1="318" x2="465" y2="318" stroke="{ACCENT}" stroke-width="1.6"/><line x1="433" y1="330" x2="458" y2="330" stroke="{ACCENT}" stroke-width="1.6"/>')
    b.append(tile(548, 290, 150, 112, None, "사례 검색 (RAG)", "피해 사례 629건"))
    b.append(f'<ellipse cx="623" cy="309" rx="22" ry="7" fill="#e3f6e8" stroke="#17723a" stroke-width="1.6"/>'
             f'<path d="M601 309 v24 a22 7 0 0 0 44 0 v-24" fill="#e3f6e8" stroke="#17723a" stroke-width="1.6"/>')
    b.append(f'<rect x="374" y="424" width="324" height="52" rx="12" fill="#1d2330"/>')
    b.append(text(536, 448, "판정은 코드가 한다", 15, 800, "#ffffff"))
    b.append(text(536, 466, "LLM은 읽기와 근거 있는 신호 제안만", 12, 500, "#c9d1e0"))
    # 격리 서버
    b.append(group(820, 40, 250, 236, "격리 서버", "amazonec2", "AWS EC2"))
    b.append(tile(838, 90, 104, 112, "docker", "수집기", "httpx"))
    b.append(tile(952, 90, 104, 112, "googlechrome", "Chromium", "필요할 때만"))
    b.append(text(945, 232, "방화벽: 443만, 사설 IP 차단", 12.5, 600, MUTED))
    b.append(text(945, 252, "읽기 전용, 권한 제거 컨테이너", 12.5, 600, MUTED))
    b.append(arrow(720, 165, 818, 165, "HTTPS, Bearer", 769, 150))
    # 의심 링크
    b.append(arrow(945, 276, 945, 322))
    b.append(text(1005, 302, "의심 URL은 여기서만", 12.5, 700, "#c2410c"))
    b.append(globe(945, 352))
    b.append(text(945, 398, "의심 링크 사이트", 14, 700))
    # 외부 AI API
    b.append(group(820, 430, 250, 112, "외부 AI API", "claude", "엘리스 ML API"))
    for i, name in enumerate(["LLM", "STT", "임베딩"]):
        x = 840 + i * 76
        b.append(f'<rect x="{x}" y="482" width="64" height="40" rx="10" fill="#ffffff" stroke="{LINE}" stroke-width="1.5"/>')
        b.append(text(x + 32, 507, name, 14, 700))
    b.append(arrow(720, 470, 818, 496))
    return svg(1100, 570, "\n".join(b))


def branches() -> str:
    lanes = [
        ("main", "멘토 리뷰를 통과한 결과", "#1d2330", 60),
        ("develop", "통합", ACCENT, 130),
        ("feature/주제", "한 주의 주제", "#16a34a", 200),
        ("feature/주제-be, -fe, -ai", "파트별 작업", "#65a30d", 270),
        ("refactor/주제", "멘토 피드백 반영", "#d97706", 340),
    ]
    b = []
    left, right = 250, 1010
    for name, desc, color, y in lanes:
        b.append(text(24, y - 2, name, 14, 800, color, anchor="start"))
        b.append(text(24, y + 16, desc, 12, 500, MUTED, anchor="start"))
        b.append(f'<line x1="{left}" y1="{y}" x2="{right}" y2="{y}" stroke="{color}" stroke-width="3" stroke-opacity="0.18"/>')

    def seg(x1, x2, y, color):
        b.append(f'<line x1="{x1}" y1="{y}" x2="{x2}" y2="{y}" stroke="{color}" stroke-width="4" stroke-linecap="round"/>')

    def curve(x1, y1, x2, y2, color):
        mx = (x1 + x2) / 2
        b.append(f'<path d="M{x1} {y1} C{mx} {y1}, {mx} {y2}, {x2} {y2}" fill="none" stroke="{color}" stroke-width="4" stroke-linecap="round"/>')

    def dot(x, y, color, big=False):
        r = 9 if big else 7
        b.append(f'<circle cx="{x}" cy="{y}" r="{r}" fill="#fff" stroke="{color}" stroke-width="3.5"/>')

    M, D, F, P, R = (l[3] for l in lanes)
    cM, cD, cF, cP, cR = (l[2] for l in lanes)
    seg(left, right, M, cM)
    seg(left, right, D, cD)
    # 주제 브랜치
    curve(290, D, 340, F, cF); seg(340, 560, F, cF); curve(560, F, 610, D, cF)
    # 파트 브랜치
    curve(360, F, 400, P, cP); seg(400, 500, P, cP); curve(500, P, 540, F, cP)
    for x in (420, 450, 480):
        dot(x, P, cP)
    dot(540, F, cF)
    dot(610, D, cD, True)
    b.append(text(450, P + 34, "같은 파트 팀원이 리뷰", 12.5, 600, MUTED))
    b.append(text(450, F - 16, "파트 결과를 여기서 맞춰 봄", 12.5, 600, MUTED))
    # 멘토 리뷰 PR
    b.append(f'<path d="M640 {D} C660 {D}, 660 {M}, 690 {M}" fill="none" stroke="{INK}" stroke-width="2.2" stroke-dasharray="6 5"/>')
    b.append(f'<rect x="672" y="{M - 44}" width="132" height="28" rx="14" fill="#1d2330"/>')
    b.append(text(738, M - 25, "멘토 리뷰 PR", 13, 700, "#fff"))
    # 피드백 반영
    curve(700, D, 750, R, cR); seg(750, 860, R, cR); curve(860, R, 900, D, cR)
    for x in (785, 825):
        dot(x, R, cR)
    b.append(text(805, R + 30, "변경 요청 반영", 12.5, 600, MUTED))
    dot(900, D, cD, True)
    curve(915, D, 960, M, cM)
    dot(960, M, cM, True)
    b.append(text(960, M - 22, "승인 후 merge", 12.5, 700, INK))
    return svg(1040, 400, "\n".join(b))


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    for name, fn in {"architecture": architecture, "branches": branches}.items():
        (OUT / f"{name}.svg").write_text(fn(), encoding="utf-8")
        print("wrote", name)


if __name__ == "__main__":
    main()
