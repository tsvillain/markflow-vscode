/* ═══════════════════════════════════════════════════════════════
   MarkFlow reader — ported from https://github.com/tsvillain/markdown
   (index.html <script> block). The Reader, Search, mermaid and theme
   logic is MarkFlow's; the editor, tabs and file handling are gone,
   replaced by message passing with the VS Code extension host.

   Inline event handlers are not usable under the webview CSP, so the
   original's `onclick="..."` attributes became delegated listeners.
   ═══════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  const vscode = acquireVsCodeApi();
  const BOOT = window.MARKFLOW_BOOT;
  const { slugify, extractHeadings } = window.MarkFlowToc;

  // ── CONFIG ────────────────────────────────────────────
  const CFG = { WPM: 200 };

  // ── STATE ─────────────────────────────────────────────
  const State = {
    theme: 'dark',
    themeOverride: null, // 'dark' | 'light' when the user used the toggle
    hostThemeKind: BOOT.themeKind, // what VS Code's active color theme is
    tocOpen: true,
    rawContent: '',
    baseUri: BOOT.baseUri,
    fileName: '',
  };

  const $ = (id) => document.getElementById(id);

  // ── MERMAID CONFIG ────────────────────────────────────
  const mermaidLightVars = {
    primaryColor: '#c9c4e8',
    primaryTextColor: '#1a1a2e',
    primaryBorderColor: '#9b95c9',
    lineColor: '#444444',
    secondaryColor: '#c9c4e8',
    tertiaryColor: '#ffffcc',
    tertiaryBorderColor: '#cccc88',
    background: '#ffffff',
    mainBkg: '#c9c4e8',
    nodeBorder: '#9b95c9',
    clusterBkg: '#ffffcc',
    clusterBorder: '#d4d48a',
    titleColor: '#333333',
    edgeLabelBackground: '#f8f8f8',
  };
  const mermaidDarkVars = {
    primaryColor: '#3d3568',
    primaryTextColor: '#e2e8f0',
    primaryBorderColor: '#6b63a8',
    lineColor: '#94a3b8',
    secondaryColor: '#3d3568',
    tertiaryColor: '#2a2a1a',
    tertiaryBorderColor: '#555533',
    background: '#0d1117',
    mainBkg: '#3d3568',
    nodeBorder: '#6b63a8',
    clusterBkg: '#2a2a1a',
    clusterBorder: '#555533',
    titleColor: '#e2e8f0',
    edgeLabelBackground: '#1c2230',
  };

  function initMermaid(isDark) {
    if (typeof mermaid === 'undefined') return;
    mermaid.initialize({
      startOnLoad: false,
      theme: 'base',
      themeVariables: isDark ? mermaidDarkVars : mermaidLightVars,
      securityLevel: 'loose',
      flowchart: { curve: 'linear', padding: 20 },
    });
  }

  // ── MARKED CONFIG ─────────────────────────────────────
  marked.setOptions({ gfm: true, breaks: true, headerIds: false });

  // Slugs come from the shared TOC module, consumed in document order so that
  // heading ids and TOC entries cannot drift apart.
  let slugQueue = [];
  let slugCursor = 0;

  marked.use({
    renderer: {
      // Headings with anchor links (marked v9 passes positional args: text, depth)
      heading(text, depth) {
        const safeText = text || '';
        const slug = slugQueue[slugCursor++] || slugify(safeText) || 'section';
        // The slug is repeated as a data attribute because DOMPurify's DOM-clobbering
        // guard drops `id`s that collide with document properties ("images", "forms", ...),
        // which would silently break those TOC entries.
        return `<h${depth} id="${slug}" data-slug="${slug}"><span>${safeText}</span><a class="heading-anchor" href="#${slug}">#</a></h${depth}>`;
      },

      // Code blocks with copy button and header
      code(text, lang) {
        // Mermaid diagrams: store code in a data attribute so DOMPurify can't strip it
        if (lang === 'mermaid') {
          return `<div class="mermaid-wrapper" data-mermaid="${encodeURIComponent(text)}"></div>`;
        }

        const language = lang || 'text';
        let highlighted;
        try {
          if (lang && hljs.getLanguage(lang)) {
            highlighted = hljs.highlight(text, { language: lang, ignoreIllegals: true }).value;
          } else {
            highlighted = hljs.highlightAuto(text).value;
          }
        } catch (e) {
          highlighted = escapeHtml(text);
        }
        return `<div class="code-block-wrapper">
  <pre><div class="code-block-header">
    <span class="code-lang">${escapeHtml(language)}</span>
    <button class="copy-btn" type="button">Copy</button>
  </div><code class="hljs language-${escapeHtml(language)}">${highlighted}</code></pre>
</div>`;
      },
    },
  });

  /** Look up a rendered heading by slug (see the note in the heading renderer). */
  function headingEl(slug) {
    return $('reader-body').querySelector(`[data-slug="${CSS.escape(slug)}"]`);
  }

  function escapeHtml(str) {
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // ── FRONTMATTER PARSER ────────────────────────────────
  function parseFrontmatter(content) {
    const fm = {};
    let body = content;

    const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)/);
    if (match) {
      match[1].split('\n').forEach((line) => {
        const m = line.match(/^(\w[\w\s-]*?):\s*(.+)/);
        if (m) fm[m[1].trim()] = m[2].trim();
      });
      body = match[2];
    }
    return { fm, body };
  }

  // ── CALLOUT PROCESSOR ─────────────────────────────────
  function processCallouts(html) {
    // GitHub-style callouts: > [!NOTE], > [!WARNING], > [!TIP], > [!IMPORTANT], > [!CAUTION]
    const map = {
      NOTE: { cls: 'callout-note', icon: 'ℹ', label: 'Note' },
      TIP: { cls: 'callout-tip', icon: '💡', label: 'Tip' },
      IMPORTANT: { cls: 'callout-info', icon: '📌', label: 'Important' },
      WARNING: { cls: 'callout-warn', icon: '⚠', label: 'Warning' },
      CAUTION: { cls: 'callout-danger', icon: '🔴', label: 'Caution' },
    };

    return html.replace(
      /<blockquote>\s*<p>\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]([\s\S]*?)<\/p>\s*<\/blockquote>/gi,
      (_, type, content) => {
        const m = map[type.toUpperCase()] || map.NOTE;
        return `<div class="callout ${m.cls}">
      <div class="callout-header">${m.icon} ${m.label}</div>
      <p>${content.trim()}</p>
    </div>`;
      }
    );
  }

  // ── MARKDOWN RENDER ───────────────────────────────────
  function renderMarkdown(content, headings) {
    slugQueue = headings.map((h) => h.slug);
    slugCursor = 0;
    let html = marked.parse(content);
    html = processCallouts(html);
    // Wrap tables for horizontal scrolling
    html = html.replace(/<table>/g, '<div class="table-wrap"><table>').replace(/<\/table>/g, '</table></div>');
    return DOMPurify.sanitize(html, {
      ADD_TAGS: ['div', 'span', 'details', 'summary'],
      ADD_ATTR: ['class', 'id', 'style', 'data-mermaid', 'target'],
      ALLOW_DATA_ATTR: true,
    });
  }

  /**
   * Relative image sources are meaningless inside the webview's own origin, so
   * resolve them against the document's folder as a webview URI.
   */
  function rewriteImages(container) {
    if (!State.baseUri) return;
    container.querySelectorAll('img[src]').forEach((img) => {
      const src = img.getAttribute('src') || '';
      if (!src || /^(https?:|data:|blob:|vscode-|file:|\/\/)/i.test(src)) return;
      try {
        img.src = new URL(src, State.baseUri).toString();
      } catch (e) {
        /* leave the original src in place */
      }
    });
  }

  function expandMermaidNodes(svgEl) {
    // Wait one frame so foreignObject content has been laid out by the browser
    requestAnimationFrame(() => {
      svgEl.querySelectorAll('foreignObject').forEach((fo) => {
        const inner = fo.firstElementChild;
        if (!inner) return;

        const needed = inner.scrollHeight;
        const given = parseFloat(fo.getAttribute('height') || 0);
        if (needed <= given) return;

        const diff = needed - given + 8; // 8px padding buffer
        fo.setAttribute('height', needed + 8);

        const parentG = fo.parentElement;
        if (!parentG) return;

        // Edge labels wrap the fo in an extra <g>, so check one level up as well
        const searchScope = parentG.tagName === 'g' ? parentG.parentElement : parentG;
        const rect = parentG.querySelector('rect') || (searchScope && searchScope.querySelector('rect'));
        if (rect) {
          const rh = parseFloat(rect.getAttribute('height') || 0);
          rect.setAttribute('height', rh + diff);
          const ry = parseFloat(rect.getAttribute('y') || 0);
          rect.setAttribute('y', ry - diff / 2);
        }
      });
    });
  }

  const MERMAID_TOOLBAR = `
    <button type="button" data-action="zoom" title="Zoom">
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/><line x1="11" y1="8" x2="11" y2="14"/><line x1="8" y1="11" x2="14" y2="11"/></svg>
      Zoom
    </button>`;

  async function renderMermaid(container) {
    if (typeof mermaid === 'undefined') return;
    const wrappers = container.querySelectorAll('.mermaid-wrapper[data-mermaid]');
    for (const wrapper of wrappers) {
      const code = decodeURIComponent(wrapper.dataset.mermaid);
      const id = 'mermaid-' + Math.random().toString(36).slice(2);
      try {
        const { svg } = await mermaid.render(id, code);
        wrapper.innerHTML = svg;
        const svgEl = wrapper.querySelector('svg');
        if (svgEl) {
          svgEl.removeAttribute('width');
          svgEl.removeAttribute('height');
          svgEl.style.removeProperty('max-width');
          svgEl.style.width = '100%';
          svgEl.style.height = 'auto';
          expandMermaidNodes(svgEl);

          const toolbar = document.createElement('div');
          toolbar.className = 'mermaid-toolbar';
          toolbar.innerHTML = MERMAID_TOOLBAR;
          wrapper.appendChild(toolbar);
        }
      } catch (e) {
        wrapper.innerHTML = `<pre style="color:var(--red);font-size:0.8em">${escapeHtml(String(e))}</pre>`;
      }
    }
  }

  // ── STATS ─────────────────────────────────────────────
  function calcStats(text) {
    const words = text.trim() ? text.trim().split(/\s+/).length : 0;
    const minutes = Math.max(1, Math.ceil(words / CFG.WPM));
    const headings = (text.match(/^#{1,6}\s/gm) || []).length;
    const codeBlocks = Math.floor((text.match(/^```/gm) || []).length / 2);
    return { words, minutes, headings, codeBlocks };
  }

  const ICON = {
    file: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>',
    clock: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>',
    words: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="4" y1="7" x2="20" y2="7"/><line x1="4" y1="12" x2="20" y2="12"/><line x1="4" y1="17" x2="14" y2="17"/></svg>',
    hash: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="4" y1="9" x2="20" y2="9"/><line x1="4" y1="15" x2="20" y2="15"/><line x1="10" y1="3" x2="8" y2="21"/><line x1="16" y1="3" x2="14" y2="21"/></svg>',
    code: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>',
  };

  function renderMeta(fileName, stats) {
    const items = [];
    if (fileName) items.push([ICON.file, escapeHtml(fileName)]);
    items.push([ICON.clock, `<strong>${stats.minutes}</strong> min read`]);
    items.push([ICON.words, `<strong>${stats.words.toLocaleString()}</strong> words`]);
    if (stats.headings) items.push([ICON.hash, `<strong>${stats.headings}</strong> headings`]);
    if (stats.codeBlocks) items.push([ICON.code, `<strong>${stats.codeBlocks}</strong> code blocks`]);
    $('doc-meta').innerHTML = items.map(([icon, label]) => `<span class="meta-item">${icon}${label}</span>`).join('');
  }

  // ── READER ────────────────────────────────────────────
  const Reader = {
    load(rawContent, fileName, keepScroll) {
      const scroll = $('reader-scroll');
      const prevTop = keepScroll ? scroll.scrollTop : 0;

      State.rawContent = rawContent;
      State.fileName = fileName || State.fileName;

      const { fm, body } = parseFrontmatter(rawContent);

      // Frontmatter card
      const card = $('frontmatter-card');
      const grid = $('fm-grid');
      if (Object.keys(fm).length) {
        grid.innerHTML = '';
        Object.entries(fm).forEach(([k, v]) => {
          const kEl = document.createElement('div');
          kEl.className = 'fm-key';
          kEl.textContent = k;
          const vEl = document.createElement('div');
          vEl.className = 'fm-val';
          // Handle arrays (tags, categories)
          if (v.startsWith('[') && v.endsWith(']')) {
            v.slice(1, -1).split(',').forEach((t) => {
              const tag = document.createElement('span');
              tag.className = 'fm-tag';
              tag.textContent = t.trim().replace(/['"]/g, '');
              vEl.appendChild(tag);
            });
          } else {
            vEl.textContent = v.replace(/['"]/g, '');
          }
          grid.appendChild(kEl);
          grid.appendChild(vEl);
        });
        card.classList.add('visible');
      } else {
        card.classList.remove('visible');
      }

      renderMeta(State.fileName, calcStats(body));

      // Render body
      const headings = extractHeadings(body);
      const readerBody = $('reader-body');
      readerBody.innerHTML = renderMarkdown(body, headings);
      rewriteImages(readerBody);

      // TOC
      this.renderToc(headings.filter((h) => h.inToc));

      scroll.scrollTop = prevTop;
      // Diagrams change the document height, so pin the scroll offset again once
      // they have laid out.
      renderMermaid(readerBody).then(() => {
        if (keepScroll) scroll.scrollTop = prevTop;
        Search.rerun();
      });

      this.updateProgress();
    },

    renderToc(headings) {
      const el = $('toc-content');
      if (!headings.length) {
        el.innerHTML = '<div class="toc-empty">No headings found</div>';
        return;
      }
      el.innerHTML = headings
        .map(
          (h) =>
            `<div class="toc-item" data-level="${h.level}" data-slug="${escapeHtml(h.slug)}">${escapeHtml(h.text)}</div>`
        )
        .join('');
    },

    scrollTo(slug) {
      const el = headingEl(slug);
      if (!el) return;
      el.scrollIntoView({ behavior: 'smooth', block: 'start' });
      document.querySelectorAll('.toc-item').forEach((i) => i.classList.remove('active'));
      const item = document.querySelector(`.toc-item[data-slug="${CSS.escape(slug)}"]`);
      if (item) item.classList.add('active');
    },

    updateProgress() {
      const scroll = $('reader-scroll');
      const { scrollTop, scrollHeight, clientHeight } = scroll;
      const pct = scrollHeight > clientHeight ? (scrollTop / (scrollHeight - clientHeight)) * 100 : 0;
      $('progress-fill').style.width = pct + '%';
    },

    initScrollSpy() {
      const scroll = $('reader-scroll');
      scroll.addEventListener(
        'scroll',
        () => {
          this.updateProgress();

          // TOC active
          const items = document.querySelectorAll('.toc-item[data-slug]');
          let active = null;
          items.forEach((item) => {
            const target = headingEl(item.dataset.slug);
            if (target && target.getBoundingClientRect().top <= 120) active = item;
          });
          if (active && !active.classList.contains('active')) {
            items.forEach((i) => i.classList.remove('active'));
            active.classList.add('active');
            active.scrollIntoView({ block: 'nearest' });
          }
        },
        { passive: true }
      );
    },
  };

  // ── SEARCH ────────────────────────────────────────────
  const Search = {
    matches: [],
    current: 0,
    query: '',

    toggle() {
      const ov = $('search-overlay');
      if (ov.classList.contains('visible')) {
        this.close();
      } else {
        ov.classList.add('visible');
        const input = $('search-input');
        input.focus();
        input.select();
      }
    },

    close() {
      $('search-overlay').classList.remove('visible');
      $('search-input').value = '';
      this.query = '';
      this.clear();
    },

    clear() {
      const body = $('reader-body');
      body.querySelectorAll('mark').forEach((m) => {
        m.replaceWith(document.createTextNode(m.textContent));
      });
      body.normalize();
      this.matches = [];
      $('search-count').textContent = '';
    },

    /** Re-apply the live query after the document was re-rendered. */
    rerun() {
      if (this.query && $('search-overlay').classList.contains('visible')) this.run(this.query, true);
    },

    run(query, keepPosition) {
      const prev = this.current;
      this.query = query;
      this.clear();
      if (!query.trim()) return;

      const body = $('reader-body');
      const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
      const nodes = [];
      let node;
      while ((node = walker.nextNode())) nodes.push(node);

      const re = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
      nodes.forEach((n) => {
        if (!n.textContent.match(re)) return;
        const frag = document.createDocumentFragment();
        let last = 0;
        let m;
        re.lastIndex = 0;
        while ((m = re.exec(n.textContent)) !== null) {
          frag.appendChild(document.createTextNode(n.textContent.slice(last, m.index)));
          const mark = document.createElement('mark');
          mark.textContent = m[0];
          frag.appendChild(mark);
          last = m.index + m[0].length;
        }
        frag.appendChild(document.createTextNode(n.textContent.slice(last)));
        n.parentNode.replaceChild(frag, n);
      });

      this.matches = Array.from(body.querySelectorAll('mark'));
      this.current = keepPosition ? Math.min(prev, Math.max(0, this.matches.length - 1)) : 0;
      this.updateCount();
      if (this.matches.length) this.scrollTo(this.current, !keepPosition);
    },

    scrollTo(idx, doScroll) {
      this.matches.forEach((m, i) => m.classList.toggle('search-current', i === idx));
      if (doScroll !== false) this.matches[idx]?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    },

    next() {
      if (!this.matches.length) return;
      this.current = (this.current + 1) % this.matches.length;
      this.scrollTo(this.current);
      this.updateCount();
    },

    prev() {
      if (!this.matches.length) return;
      this.current = (this.current - 1 + this.matches.length) % this.matches.length;
      this.scrollTo(this.current);
      this.updateCount();
    },

    updateCount() {
      $('search-count').textContent = this.matches.length ? `${this.current + 1} / ${this.matches.length}` : 'No results';
    },
  };

  // ── DIAGRAM MODAL ─────────────────────────────────────
  const DiagramModal = {
    open(svgEl) {
      const modal = $('diagram-modal');
      const inner = $('diagram-modal-inner');
      const clone = svgEl.cloneNode(true);
      clone.removeAttribute('width');
      clone.removeAttribute('height');
      clone.style.width = '';
      clone.style.height = '';
      inner.innerHTML = '';
      const close = document.createElement('button');
      close.id = 'diagram-modal-close';
      close.type = 'button';
      close.title = 'Close';
      close.textContent = '✕';
      close.addEventListener('click', () => DiagramModal.close());
      inner.appendChild(close);
      inner.appendChild(clone);
      modal.classList.add('open');
    },
    close() {
      $('diagram-modal').classList.remove('open');
    },
    isOpen() {
      return $('diagram-modal').classList.contains('open');
    },
  };

  // ── THEME ─────────────────────────────────────────────
  function effectiveTheme() {
    return State.themeOverride || (State.hostThemeKind === 'light' ? 'light' : 'dark');
  }

  function applyTheme() {
    State.theme = effectiveTheme();
    const isDark = State.theme === 'dark';
    document.documentElement.setAttribute('data-theme', State.theme);
    $('hljs-theme').href = isDark ? BOOT.hljsDark : BOOT.hljsLight;
    $('theme-icon-dark').style.display = isDark ? 'block' : 'none';
    $('theme-icon-light').style.display = isDark ? 'none' : 'block';

    // Re-initialize mermaid with updated theme and re-render diagrams
    initMermaid(isDark);
    const readerBody = $('reader-body');
    if (readerBody && State.rawContent) {
      const scroll = $('reader-scroll');
      const top = scroll.scrollTop;
      renderMermaid(readerBody).then(() => {
        scroll.scrollTop = top;
      });
    }
  }

  function toggleTheme() {
    State.themeOverride = effectiveTheme() === 'dark' ? 'light' : 'dark';
    applyTheme();
    persist();
  }

  // ── TOC TOGGLE ────────────────────────────────────────
  function applyToc() {
    $('toc-sidebar').classList.toggle('collapsed', !State.tocOpen);
    $('read-progress').classList.toggle('full', !State.tocOpen);
    $('btn-toc').classList.toggle('active', State.tocOpen);
  }

  function toggleToc() {
    State.tocOpen = !State.tocOpen;
    applyToc();
    persist();
  }

  // ── SETTINGS ──────────────────────────────────────────
  function applySettings(s) {
    const root = document.documentElement.style;
    if (s.contentMaxWidth) root.setProperty('--content-max', s.contentMaxWidth + 'px');
    if (s.fontSize) root.setProperty('font-size', s.fontSize + 'px');
  }

  // ── PERSISTED WEBVIEW STATE ───────────────────────────
  function persist() {
    vscode.setState({
      themeOverride: State.themeOverride,
      tocOpen: State.tocOpen,
      scrollTop: $('reader-scroll').scrollTop,
    });
  }

  // ── LINKS ─────────────────────────────────────────────
  function onBodyClick(e) {
    const copy = e.target.closest('.copy-btn');
    if (copy) {
      const code = copy.closest('pre')?.querySelector('code');
      if (code) {
        vscode.postMessage({ type: 'copy', text: code.innerText });
        copy.textContent = 'Copied!';
        copy.classList.add('copied');
        setTimeout(() => {
          copy.textContent = 'Copy';
          copy.classList.remove('copied');
        }, 2000);
      }
      return;
    }

    const zoom = e.target.closest('.mermaid-toolbar button[data-action="zoom"]');
    if (zoom) {
      const svg = zoom.closest('.mermaid-wrapper')?.querySelector('svg');
      if (svg) DiagramModal.open(svg);
      return;
    }

    const link = e.target.closest('a[href]');
    if (!link) return;
    const href = link.getAttribute('href') || '';
    e.preventDefault();
    if (href.startsWith('#')) {
      Reader.scrollTo(decodeURIComponent(href.slice(1)));
    } else if (href) {
      // The extension host decides: a relative .md path opens its own reader,
      // anything else goes through vscode.env.openExternal.
      vscode.postMessage({ type: 'openLink', href });
    }
  }

  // ── BOOT ──────────────────────────────────────────────
  function init() {
    const saved = vscode.getState() || {};
    State.themeOverride = saved.themeOverride || null;
    State.tocOpen = typeof saved.tocOpen === 'boolean' ? saved.tocOpen : BOOT.settings.tocOpenByDefault;

    applySettings(BOOT.settings);
    applyToc();
    initMermaid(effectiveTheme() === 'dark');
    applyTheme();
    Reader.initScrollSpy();

    $('reader-body').addEventListener('click', onBodyClick);
    $('toc-content').addEventListener('click', (e) => {
      const item = e.target.closest('.toc-item[data-slug]');
      if (item) Reader.scrollTo(item.dataset.slug);
    });
    $('btn-toc').addEventListener('click', toggleToc);
    $('btn-theme').addEventListener('click', toggleTheme);
    $('btn-search').addEventListener('click', () => Search.toggle());
    $('search-input').addEventListener('input', (e) => Search.run(e.target.value));
    $('search-input').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        e.shiftKey ? Search.prev() : Search.next();
      }
    });
    $('search-prev').addEventListener('click', () => Search.prev());
    $('search-next').addEventListener('click', () => Search.next());
    $('search-close').addEventListener('click', () => Search.close());
    $('diagram-modal').addEventListener('click', function (e) {
      if (e.target === this) DiagramModal.close();
    });

    document.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
        e.preventDefault();
        Search.toggle();
      }
      if (e.key === 'Escape') {
        if (DiagramModal.isOpen()) DiagramModal.close();
        else Search.close();
      }
    });

    $('reader-scroll').addEventListener('scroll', debounce(persist, 250), { passive: true });

    window.addEventListener('message', (event) => {
      const msg = event.data;
      switch (msg.type) {
        case 'render':
          State.baseUri = msg.baseUri || State.baseUri;
          $('file-name').textContent = msg.fileName || '';
          Reader.load(msg.text, msg.fileName, msg.keepScroll !== false);
          break;
        case 'hostTheme':
          State.hostThemeKind = msg.kind;
          applyTheme();
          break;
        case 'settings':
          applySettings(msg.settings);
          break;
        case 'find':
          Search.toggle();
          break;
      }
    });

    // Restore scroll for a panel VS Code brought back from a serialized state.
    if (typeof saved.scrollTop === 'number') {
      requestAnimationFrame(() => {
        $('reader-scroll').scrollTop = saved.scrollTop;
      });
    }

    vscode.postMessage({ type: 'ready' });
  }

  function debounce(fn, ms) {
    let t;
    return (...args) => {
      clearTimeout(t);
      t = setTimeout(() => fn(...args), ms);
    };
  }

  init();
})();
