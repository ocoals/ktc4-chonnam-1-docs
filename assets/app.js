// 문서 포털: content/<portal>/nav.json 과 Markdown 을 읽어 그린다.
// 주소 형식: /<portal>/#<page> 또는 /<portal>/#<page>/<heading-id>
(function () {
  const portal = document.body.dataset.portal;
  const base = `/content/${portal}`;
  const els = {
    sidebar: document.getElementById("sidebar"),
    doc: document.getElementById("doc"),
    toc: document.getElementById("toc"),
    pager: document.getElementById("pager"),
    base: document.getElementById("base-link"),
  };

  let nav = null;
  let pages = [];
  let meta = { files: [], dirs: [], commits: [], repo: "", base: "" };
  let currentPage = null;
  const cache = new Map();

  if (window.mermaid) {
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      theme: "neutral",
      flowchart: { htmlLabels: true, curve: "basis" },
      fontFamily: getComputedStyle(document.body).fontFamily,
    });
  }
  marked.use({ gfm: true });

  function parseHash() {
    const raw = decodeURIComponent(location.hash.replace(/^#/, ""));
    const [page, ...rest] = raw.split("/");
    return { page: page || pages[0].id, heading: rest.join("/") || null };
  }

  function slugify(text, used) {
    let s = text.trim().toLowerCase()
      .replace(/[`'"“”‘’()\[\]{}<>,.:;!?@#$%^&*+=|\\~]/g, "")
      .replace(/[·—–]/g, "")
      .replace(/\s+/g, "-")
      .replace(/\//g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "");
    if (!s) s = "section";
    let out = s, n = 2;
    while (used.has(out)) out = `${s}-${n++}`;
    used.add(out);
    return out;
  }

  function renderSidebar() {
    const frag = document.createDocumentFragment();
    for (const group of nav.groups) {
      const g = document.createElement("div");
      g.className = "group";
      const name = document.createElement("div");
      name.className = "group-name";
      name.textContent = group.name;
      g.appendChild(name);
      for (const item of group.items) {
        // hidden 페이지는 목차에 보이지 않고 본문 링크로만 연다.
        if (item.hidden) continue;
        const a = document.createElement("a");
        a.className = "item";
        a.href = `#${item.id}`;
        a.dataset.id = item.id;
        a.textContent = item.title;
        g.appendChild(a);
      }
      frag.appendChild(g);
    }
    els.sidebar.replaceChildren(frag);
  }

  function markActive(id) {
    const item = pages.find((p) => p.id === id);
    const target = item && item.hidden && item.parent ? item.parent : id;
    for (const a of els.sidebar.querySelectorAll("a.item")) {
      a.classList.toggle("active", a.dataset.id === target);
    }
    const active = els.sidebar.querySelector("a.item.active");
    if (active) active.scrollIntoView({ block: "nearest" });
  }

  async function fetchText(url) {
    if (cache.has(url)) return cache.get(url);
    const res = await fetch(url, { cache: "no-cache" });
    if (!res.ok) throw new Error(`${res.status} ${url}`);
    const text = await res.text();
    cache.set(url, text);
    return text;
  }

  // ---------- 근거 링크 ----------
  function githubLink(path, isDir) {
    return `${meta.repo}/${isDir ? "tree" : "blob"}/${meta.base}/${path}`;
  }

  function resolvePath(text) {
    const t = text.trim().replace(/\/$/, "");
    if (!/[./]/.test(text) || /\s/.test(t) || t.length < 3) return null;
    if (meta.fileSet.has(t)) return { path: t, dir: false };
    if (meta.dirSet.has(t)) return { path: t, dir: true };
    const hits = meta.files.filter((f) => f.endsWith("/" + t));
    if (hits.length === 1) return { path: hits[0], dir: false };
    const dirHits = meta.dirs.filter((d) => d.endsWith("/" + t));
    if (dirHits.length === 1) return { path: dirHits[0], dir: true };
    return null;
  }

  function wrapLink(node, href, title) {
    const a = document.createElement("a");
    a.href = href;
    a.className = "evidence";
    if (/^https?:/.test(href)) { a.target = "_blank"; a.rel = "noopener"; }
    if (title) a.title = title;
    node.replaceWith(a);
    a.appendChild(node);
  }

  function linkifyCode(root) {
    for (const code of root.querySelectorAll("code")) {
      if (code.closest("pre, a")) continue;
      const text = code.textContent;
      if (/^[0-9a-f]{7}$/.test(text) && meta.commitSet.has(text)) {
        wrapLink(code, `${meta.repo}/commit/${text}`, "커밋 보기");
        continue;
      }
      const hit = resolvePath(text);
      if (hit) wrapLink(code, githubLink(hit.path, hit.dir), hit.path);
    }
  }

  const adrIds = new Set();
  function linkifyText(root) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(n) {
        if (n.parentElement.closest("a, code, pre, .mermaid-wrap, h1, h2, h3")) return NodeFilter.FILTER_REJECT;
        return /#\d{1,3}|ADR \d{4}/.test(n.nodeValue) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
      },
    });
    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    const re = /(#(\d{1,3})\b)|(ADR (\d{4}(?:\s?[·,–-]\s?\d{4})*))/g;
    for (const node of nodes) {
      const text = node.nodeValue;
      const frag = document.createDocumentFragment();
      let last = 0;
      let m;
      re.lastIndex = 0;
      while ((m = re.exec(text))) {
        frag.appendChild(document.createTextNode(text.slice(last, m.index)));
        if (m[1]) {
          const a = document.createElement("a");
          a.href = `${meta.repo}/issues/${m[2]}`;
          a.target = "_blank";
          a.rel = "noopener";
          a.className = "evidence";
          a.textContent = m[1];
          frag.appendChild(a);
        } else {
          frag.appendChild(document.createTextNode("ADR "));
          const run = m[4];
          let p = 0;
          for (const nm of run.matchAll(/\d{4}/g)) {
            frag.appendChild(document.createTextNode(run.slice(p, nm.index)));
            const id = `adr-${nm[0]}`;
            // 이 포털에 ADR 페이지가 없으면 테크스펙의 ADR 페이지로 보낸다.
            const href = adrIds.has(id) ? `#${id}` : meta.adrSet.has(nm[0]) ? `/tech-spec/#${id}` : null;
            if (href) {
              const a = document.createElement("a");
              a.href = href;
              a.textContent = nm[0];
              frag.appendChild(a);
            } else {
              frag.appendChild(document.createTextNode(nm[0]));
            }
            p = nm.index + nm[0].length;
          }
          frag.appendChild(document.createTextNode(run.slice(p)));
        }
        last = m.index + m[0].length;
      }
      frag.appendChild(document.createTextNode(text.slice(last)));
      node.replaceWith(frag);
    }
  }

  // ---------- 상태 표기 ----------
  function badgeStatus(root) {
    const kinds = [["구현 예정", "plan"], ["미구현", "todo"], ["구현", "ok"], ["부분", "part"], ["제약", "limit"], ["자동", "ok"], ["수동", "part"], ["수집", "ok"], ["추가 필요", "todo"], ["미수집", "todo"]];
    for (const td of root.querySelectorAll("td:last-child")) {
      const text = td.textContent.trim();
      for (const [word, cls] of kinds) {
        if (text === word || text.startsWith(word + " ") || text.startsWith(word + ".") || text.startsWith(word + "(")) {
          const span = document.createElement("span");
          span.className = `status ${cls}`;
          span.textContent = word;
          const first = td.firstChild;
          if (first && first.nodeType === Node.TEXT_NODE && first.nodeValue.trimStart().startsWith(word)) {
            first.nodeValue = first.nodeValue.trimStart().slice(word.length);
            td.insertBefore(span, first);
          }
          break;
        }
      }
    }
  }

  // ---------- 페이지 ----------
  async function renderPage(id, headingId) {
    const item = pages.find((p) => p.id === id);
    if (!item) {
      els.doc.innerHTML = `<p class="error">문서를 찾지 못했어요: ${id}</p>`;
      return;
    }
    if (currentPage !== id) {
      els.doc.innerHTML = '<p class="loading">불러오는 중…</p>';
      let md;
      try {
        md = await fetchText(`${base}/${item.file || item.id + ".md"}`);
      } catch (e) {
        els.doc.innerHTML = `<p class="error">문서를 불러오지 못했어요.</p>`;
        return;
      }
      els.doc.innerHTML = marked.parse(md);
      await decorate(els.doc);
      currentPage = id;
      document.title = `${item.title} | ${nav.title} | 화기니 개발 문서`;
      renderToc();
      renderPager(item);
      markActive(id);
    }
    if (headingId) {
      const target = document.getElementById(headingId);
      if (target) target.scrollIntoView();
    } else {
      window.scrollTo(0, 0);
    }
    updateToc();
    closeNavIfNarrow();
  }

  async function decorate(root) {
    // 표는 가로 스크롤 상자로 감싼다.
    for (const table of root.querySelectorAll("table")) {
      const wrap = document.createElement("div");
      wrap.className = "table-wrap";
      table.replaceWith(wrap);
      wrap.appendChild(table);
    }
    // 제목에 id 를 붙인다.
    const used = new Set();
    for (const h of root.querySelectorAll("h1, h2, h3, h4")) h.id = slugify(h.textContent, used);
    // 문서 안의 #page 링크는 그대로 두고, #heading 만 있는 링크는 현재 페이지 기준으로 바꾼다.
    for (const a of root.querySelectorAll('a[href^="#"]')) {
      const target = a.getAttribute("href").slice(1);
      if (!pages.some((p) => p.id === target.split("/")[0]) && used.has(target)) {
        a.setAttribute("href", `#${currentPageIdFor(root)}/${target}`);
      }
    }
    // 바깥 링크는 새 탭으로 연다.
    for (const a of root.querySelectorAll('a[href^="http"]')) { a.target = "_blank"; a.rel = "noopener"; }

    linkifyCode(root);
    linkifyText(root);
    badgeStatus(root);

    // 코드 강조와 mermaid
    const diagrams = [];
    for (const code of root.querySelectorAll("pre > code")) {
      const pre = code.parentElement;
      if (code.classList.contains("language-mermaid")) {
        const wrap = document.createElement("div");
        wrap.className = "mermaid-wrap";
        const div = document.createElement("div");
        div.className = "mermaid";
        div.textContent = code.textContent;
        wrap.appendChild(div);
        pre.replaceWith(wrap);
        diagrams.push(div);
      } else if (window.hljs) {
        hljs.highlightElement(code);
      }
    }
    if (diagrams.length && window.mermaid) {
      try {
        await mermaid.run({ nodes: diagrams });
      } catch (e) {
        console.error("mermaid", e);
      }
    }
  }

  function currentPageIdFor() {
    return parseHash().page;
  }

  function renderToc() {
    const heads = [...els.doc.querySelectorAll("h2, h3")];
    if (!heads.length) { els.toc.replaceChildren(); return; }
    const frag = document.createDocumentFragment();
    const title = document.createElement("div");
    title.className = "toc-title";
    title.textContent = "이 페이지";
    frag.appendChild(title);
    // 목록 왼쪽 선 위를 파란 막대(toc-marker)가 지금 읽는 절로 미끄러지듯 옮겨 간다.
    const list = document.createElement("div");
    list.className = "toc-list";
    const marker = document.createElement("span");
    marker.className = "toc-marker";
    list.appendChild(marker);
    for (const h of heads) {
      const a = document.createElement("a");
      a.href = `#${currentPage}/${h.id}`;
      a.className = h.tagName.toLowerCase();
      a.dataset.target = h.id;
      a.textContent = h.textContent;
      list.appendChild(a);
    }
    frag.appendChild(list);
    els.toc.replaceChildren(frag);
  }

  function moveTocMarker(current) {
    const marker = els.toc.querySelector(".toc-marker");
    if (!marker || !current) return;
    marker.style.transform = `translateY(${current.offsetTop}px)`;
    marker.style.height = `${current.offsetHeight}px`;
    marker.style.opacity = "1";
    // 목차가 길면 지금 절이 목차 안에서 보이도록 함께 스크롤한다.
    const top = current.offsetTop + current.parentElement.offsetTop;
    const bottom = top + current.offsetHeight;
    if (top < els.toc.scrollTop + 40) els.toc.scrollTop = Math.max(0, top - 40);
    else if (bottom > els.toc.scrollTop + els.toc.clientHeight - 40) els.toc.scrollTop = bottom - els.toc.clientHeight + 40;
  }

  function renderPager(item) {
    const visible = pages.filter((p) => !p.hidden);
    const i = visible.indexOf(item);
    const prev = i >= 0 ? visible[i - 1] : null;
    const next = i >= 0 ? visible[i + 1] : null;
    els.pager.innerHTML = "";
    const add = (p, cls, text) => {
      const a = document.createElement("a");
      a.className = cls;
      a.href = `#${p.id}`;
      a.textContent = text;
      els.pager.appendChild(a);
    };
    if (prev) add(prev, "prev", `← ${prev.title}`);
    if (next) add(next, "next", `${next.title} →`);
  }

  // 스크롤 위치에 맞춰 오른쪽 목차를 표시한다.
  // 마지막 절들은 화면 위쪽까지 올라오지 못하므로, 바닥에 닿으면 마지막 절을 고른다.
  // 목차를 눌러 이동했으면 사용자가 다시 스크롤하기 전까지 누른 절을 유지한다.
  let pinned = null;
  function updateToc() {
    const links = [...els.toc.querySelectorAll("a")];
    if (!links.length) return;
    let current = links[0];
    if (pinned && links.some((a) => a.dataset.target === pinned)) {
      current = links.find((a) => a.dataset.target === pinned);
    } else {
      // 기준선은 보통 화면 위쪽이지만, 페이지 끝에 가까워지면 화면 아래로 천천히 내린다.
      // 그래야 위로 올라오지 못하는 끝부분 절들도 차례로 표시된다.
      const base = Math.min(160, window.innerHeight * 0.3);
      const maxScroll = document.documentElement.scrollHeight - window.innerHeight;
      const zone = window.innerHeight * 0.6;
      const remaining = maxScroll - window.scrollY;
      let line = base;
      if (maxScroll > 0 && remaining < zone) {
        const t = 1 - Math.max(0, remaining) / zone;
        line = base + (window.innerHeight - 60 - base) * t;
      }
      for (const a of links) {
        const h = document.getElementById(a.dataset.target);
        if (h && h.getBoundingClientRect().top <= line) current = a;
      }
    }
    for (const a of links) a.classList.toggle("active", a === current);
    moveTocMarker(current);
  }
  // 제목이 열 개 남짓이라 스크롤마다 바로 계산해도 가볍다.
  window.addEventListener("scroll", updateToc, { passive: true });
  for (const ev of ["wheel", "touchmove", "keydown"]) {
    window.addEventListener(ev, () => { pinned = null; }, { passive: true });
  }
  els.toc.addEventListener("click", (e) => {
    const a = e.target.closest("a");
    if (a) pinned = a.dataset.target;
  });

  // 목차 열기, 닫기. 본문을 가리지 않을 만큼 넓은 화면에서는 처음에 열어 두고, 사용자가 고른 상태를 기억한다.
  const WIDE = "(min-width: 1440px)";
  const NAV_KEY = "docs-nav-open";
  function readNavPref() {
    try { return localStorage.getItem(NAV_KEY); } catch { return null; }
  }
  function saveNavPref(open) {
    try { localStorage.setItem(NAV_KEY, open ? "1" : "0"); } catch { /* 저장 못 해도 동작에는 지장 없다 */ }
  }
  const pref = readNavPref();
  if (window.matchMedia(WIDE).matches && pref !== "0") document.body.classList.add("nav-open");

  document.getElementById("menu-btn").addEventListener("click", () => {
    const open = document.body.classList.toggle("nav-open");
    if (window.matchMedia(WIDE).matches) saveNavPref(open);
  });
  // 좁은 화면에서는 목차가 본문을 가리므로 페이지를 고르면 닫는다.
  function closeNavIfNarrow() {
    if (!window.matchMedia(WIDE).matches) document.body.classList.remove("nav-open");
  }

  window.addEventListener("hashchange", () => {
    const { page, heading } = parseHash();
    renderPage(page, heading);
  });

  async function init() {
    const [navText, metaText] = await Promise.all([
      fetchText(`${base}/nav.json`),
      fetchText("/assets/repo-meta.json").catch(() => null),
    ]);
    nav = JSON.parse(navText);
    pages = nav.groups.flatMap((g) => g.items);
    for (const p of pages) if (p.id.startsWith("adr-")) adrIds.add(p.id);
    if (metaText) meta = JSON.parse(metaText);
    meta.fileSet = new Set(meta.files);
    meta.dirSet = new Set(meta.dirs);
    meta.commitSet = new Set(meta.commits);
    meta.adrSet = new Set(meta.files.map((f) => f.match(/^docs\/adr\/(\d{4})-/)?.[1]).filter(Boolean));
    if (els.base && meta.repo) {
      els.base.href = `${meta.repo}/tree/${meta.base}`;
      els.base.textContent = `기준 커밋 ${meta.base}`;
    }
    renderSidebar();
    const { page, heading } = parseHash();
    await renderPage(page, heading);
  }

  init();
})();
