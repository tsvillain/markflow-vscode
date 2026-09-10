import * as path from 'path';
import * as vscode from 'vscode';

const MARKDOWN_EXTENSIONS = ['.md', '.markdown', '.mdown', '.mkd'];

interface ReaderSettings {
  contentMaxWidth: number;
  fontSize: number;
  tocOpenByDefault: boolean;
}

/** Reader theme to start from: the `markflow.theme` setting, or VS Code's own. */
function themeKind(): 'dark' | 'light' {
  const configured = vscode.workspace.getConfiguration('markflow').get<string>('theme', 'auto');
  if (configured === 'dark' || configured === 'light') {
    return configured;
  }
  const kind = vscode.window.activeColorTheme.kind;
  return kind === vscode.ColorThemeKind.Light || kind === vscode.ColorThemeKind.HighContrastLight ? 'light' : 'dark';
}

function readerSettings(): ReaderSettings {
  const cfg = vscode.workspace.getConfiguration('markflow');
  return {
    contentMaxWidth: cfg.get<number>('contentMaxWidth', 1000),
    fontSize: cfg.get<number>('fontSize', 16),
    tocOpenByDefault: cfg.get<boolean>('tocOpenByDefault', true),
  };
}

function nonce(): string {
  let text = '';
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) {
    text += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return text;
}

function isMarkdownPath(p: string): boolean {
  return MARKDOWN_EXTENSIONS.includes(path.extname(p).toLowerCase());
}

/**
 * One reader panel per view column. Opening another document into the same
 * column retargets the existing panel rather than piling up tabs.
 */
export class ReaderPanel {
  private static readonly byColumn = new Map<vscode.ViewColumn, ReaderPanel>();

  private readonly disposables: vscode.Disposable[] = [];
  private renderTimer: NodeJS.Timeout | undefined;
  private ready = false;

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly extensionUri: vscode.Uri,
    private readonly column: vscode.ViewColumn,
    private readonly roots: vscode.Uri[],
    private doc: vscode.TextDocument
  ) {
    this.panel.webview.html = this.html();
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
    this.panel.webview.onDidReceiveMessage((msg) => this.onMessage(msg), null, this.disposables);

    this.disposables.push(
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (e.document.uri.toString() === this.doc.uri.toString()) {
          this.scheduleRender();
        }
      }),
      vscode.workspace.onDidCloseTextDocument((closed) => {
        // Keep showing the last known text; only drop the live-update wiring.
        if (closed.uri.toString() === this.doc.uri.toString() && this.renderTimer) {
          clearTimeout(this.renderTimer);
        }
      }),
      vscode.window.onDidChangeActiveColorTheme(() => {
        this.post({ type: 'hostTheme', kind: themeKind() });
      }),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (!e.affectsConfiguration('markflow')) {
          return;
        }
        this.post({ type: 'settings', settings: readerSettings() });
        this.post({ type: 'hostTheme', kind: themeKind() });
      })
    );

    this.setTitle();
  }

  static show(extensionUri: vscode.Uri, doc: vscode.TextDocument, column: vscode.ViewColumn): ReaderPanel {
    const roots = ReaderPanel.resourceRoots(extensionUri, doc);
    const existing = ReaderPanel.byColumn.get(column);
    if (existing) {
      // localResourceRoots are fixed at creation, so a document outside the
      // current roots needs a fresh panel.
      if (existing.covers(roots)) {
        existing.setDocument(doc);
        existing.panel.reveal(column, true);
        return existing;
      }
      existing.panel.dispose();
    }

    const panel = vscode.window.createWebviewPanel('markflow.reader', 'MarkFlow', { viewColumn: column, preserveFocus: true }, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: roots,
    });

    const created = new ReaderPanel(panel, extensionUri, column, roots, doc);
    ReaderPanel.byColumn.set(column, created);
    return created;
  }

  private static resourceRoots(extensionUri: vscode.Uri, doc: vscode.TextDocument): vscode.Uri[] {
    const roots = [vscode.Uri.joinPath(extensionUri, 'media')];
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      roots.push(folder.uri);
    }
    if (doc.uri.scheme === 'file') {
      roots.push(vscode.Uri.file(path.dirname(doc.uri.fsPath)));
    }
    return roots;
  }

  private covers(wanted: vscode.Uri[]): boolean {
    const within = (child: string, parent: string) => child === parent || child.startsWith(parent.replace(/\/$/, '') + '/');
    return wanted.every((w) => this.roots.some((r) => within(w.toString(), r.toString())));
  }

  private setDocument(doc: vscode.TextDocument): void {
    this.doc = doc;
    this.setTitle();
    this.render(false);
  }

  private setTitle(): void {
    this.panel.title = `MarkFlow: ${path.basename(this.doc.uri.fsPath)}`;
  }

  private scheduleRender(): void {
    if (this.renderTimer) {
      clearTimeout(this.renderTimer);
    }
    this.renderTimer = setTimeout(() => this.render(true), 150);
  }

  private render(keepScroll: boolean): void {
    if (!this.ready) {
      return;
    }
    const dir = this.doc.uri.scheme === 'file' ? vscode.Uri.file(path.dirname(this.doc.uri.fsPath)) : this.doc.uri;
    this.post({
      type: 'render',
      text: this.doc.getText(),
      fileName: path.basename(this.doc.uri.fsPath),
      // Trailing slash so `new URL(relative, baseUri)` resolves inside the folder.
      baseUri: this.panel.webview.asWebviewUri(dir).toString() + '/',
      keepScroll,
    });
  }

  find(): void {
    this.post({ type: 'find' });
  }

  private post(message: unknown): void {
    void this.panel.webview.postMessage(message);
  }

  private async onMessage(msg: { type: string; href?: string; text?: string }): Promise<void> {
    switch (msg.type) {
      case 'ready':
        this.ready = true;
        this.render(false);
        return;
      case 'copy':
        if (msg.text !== undefined) {
          await vscode.env.clipboard.writeText(msg.text);
        }
        return;
      case 'openLink':
        if (msg.href) {
          await this.openLink(msg.href);
        }
        return;
    }
  }

  private async openLink(href: string): Promise<void> {
    // Anything with its own scheme (http, https, mailto, vscode, ...) is external.
    if (/^[a-z][a-z0-9+.-]*:/i.test(href)) {
      await vscode.env.openExternal(vscode.Uri.parse(href));
      return;
    }

    const [targetPath] = href.split('#');
    if (!targetPath) {
      return;
    }
    const base = path.dirname(this.doc.uri.fsPath);
    const resolved = vscode.Uri.file(path.resolve(base, decodeURIComponent(targetPath)));

    if (isMarkdownPath(resolved.fsPath)) {
      try {
        const doc = await vscode.workspace.openTextDocument(resolved);
        ReaderPanel.show(this.extensionUri, doc, this.column);
        return;
      } catch {
        vscode.window.showWarningMessage(`MarkFlow: cannot open ${href}`);
        return;
      }
    }
    await vscode.env.openExternal(resolved);
  }

  private html(): string {
    const webview = this.panel.webview;
    const media = (...p: string[]) => webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', ...p));
    const n = nonce();

    const csp = [
      `default-src 'none'`,
      `img-src ${webview.cspSource} https: data:`,
      `font-src ${webview.cspSource}`,
      // Mermaid injects <style> elements for each diagram, and the sanitized
      // markdown can carry style attributes.
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `script-src 'nonce-${n}'`,
    ].join('; ');

    const boot = JSON.stringify({
      themeKind: themeKind(),
      settings: readerSettings(),
      hljsDark: media('vendor', 'github-dark.min.css').toString(),
      hljsLight: media('vendor', 'github.min.css').toString(),
      baseUri: '',
    });

    return `<!DOCTYPE html>
<html lang="en" data-theme="dark">

<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>MarkFlow</title>
  <link id="hljs-theme" rel="stylesheet" href="${media('vendor', 'github-dark.min.css')}" />
  <link rel="stylesheet" href="${media('reader.css')}" />
</head>

<body>
  <header id="header">
    <div class="logo">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
        stroke-linecap="round" stroke-linejoin="round">
        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
        <polyline points="14 2 14 8 20 8" />
        <line x1="16" y1="13" x2="8" y2="13" />
        <line x1="16" y1="17" x2="8" y2="17" />
        <polyline points="10 9 9 9 8 9" />
      </svg>
      MarkFlow
    </div>

    <div class="header-sep"></div>
    <div class="file-name" id="file-name"></div>
    <div class="spacer"></div>

    <button class="icon-btn" id="btn-search" title="Search (Ctrl+F)" type="button">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <circle cx="11" cy="11" r="8" />
        <line x1="21" y1="21" x2="16.65" y2="16.65" />
      </svg>
    </button>

    <button class="icon-btn" id="btn-toc" title="Toggle contents" type="button">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <line x1="3" y1="6" x2="21" y2="6" />
        <line x1="3" y1="12" x2="21" y2="12" />
        <line x1="3" y1="18" x2="21" y2="18" />
      </svg>
    </button>

    <button class="icon-btn" id="btn-theme" title="Toggle theme" type="button">
      <svg id="theme-icon-dark" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
        stroke-width="2">
        <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
      </svg>
      <svg id="theme-icon-light" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
        stroke-width="2" style="display:none">
        <circle cx="12" cy="12" r="5" />
        <line x1="12" y1="1" x2="12" y2="3" />
        <line x1="12" y1="21" x2="12" y2="23" />
        <line x1="4.22" y1="4.22" x2="5.64" y2="5.64" />
        <line x1="18.36" y1="18.36" x2="19.78" y2="19.78" />
        <line x1="1" y1="12" x2="3" y2="12" />
        <line x1="21" y1="12" x2="23" y2="12" />
        <line x1="4.22" y1="19.78" x2="5.64" y2="18.36" />
        <line x1="18.36" y1="5.64" x2="19.78" y2="4.22" />
      </svg>
    </button>
  </header>

  <div id="app">
    <div id="reader">
      <div id="toc-sidebar">
        <div class="toc-title">Contents</div>
        <div id="toc-content"></div>
      </div>

      <div id="read-progress">
        <div id="progress-fill"></div>
      </div>

      <div id="reader-scroll">
        <div id="search-overlay">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
            style="color:var(--text3)">
            <circle cx="11" cy="11" r="8" />
            <line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
          <input type="text" id="search-input" placeholder="Search…" />
          <span class="search-count" id="search-count"></span>
          <button class="icon-btn" id="search-prev" type="button" title="Previous match"
            style="width:24px;height:24px;border:none;background:none;">↑</button>
          <button class="icon-btn" id="search-next" type="button" title="Next match"
            style="width:24px;height:24px;border:none;background:none;">↓</button>
          <button class="icon-btn" id="search-close" type="button" title="Close"
            style="width:24px;height:24px;border:none;background:none;">✕</button>
        </div>

        <div id="reader-content">
          <div id="frontmatter-card">
            <div class="fm-heading">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
                <line x1="3" y1="9" x2="21" y2="9" />
                <line x1="9" y1="21" x2="9" y2="9" />
              </svg>
              Frontmatter
            </div>
            <div class="fm-grid" id="fm-grid"></div>
          </div>

          <div id="doc-meta"></div>

          <div class="md-body" id="reader-body"></div>
        </div>
      </div>
    </div>
  </div>

  <div id="diagram-modal">
    <div id="diagram-modal-inner"></div>
  </div>

  <script nonce="${n}">window.MARKFLOW_BOOT = ${boot};</script>
  <script nonce="${n}" src="${media('vendor', 'marked.min.js')}"></script>
  <script nonce="${n}" src="${media('vendor', 'highlight.min.js')}"></script>
  <script nonce="${n}" src="${media('vendor', 'purify.min.js')}"></script>
  <script nonce="${n}" src="${media('vendor', 'mermaid.min.js')}"></script>
  <script nonce="${n}" src="${media('toc.js')}"></script>
  <script nonce="${n}" src="${media('reader.js')}"></script>
</body>

</html>`;
  }

  private dispose(): void {
    if (ReaderPanel.byColumn.get(this.column) === this) {
      ReaderPanel.byColumn.delete(this.column);
    }
    if (this.renderTimer) {
      clearTimeout(this.renderTimer);
    }
    for (const d of this.disposables) {
      d.dispose();
    }
    this.disposables.length = 0;
  }
}
