# MarkFlow for VS Code

A distraction-free Markdown **reading view** for Visual Studio Code, porting the reader mode of
[MarkFlow](https://markdown.tsvillain.com/) ([source](https://github.com/tsvillain/markdown))
into the editor.

The reader's CSS and rendering logic are lifted from MarkFlow's `index.html`, so the typography,
colours, callouts, code blocks and diagrams look the same as they do on the web. What is *not*
ported is MarkFlow's editor pane, tab bar and file toolbar — VS Code already provides all three.

## Features

- **Reader-mode rendering** with [marked](https://github.com/markedjs/marked) 9, sanitized with
  [DOMPurify](https://github.com/cure53/DOMPurify) 3, highlighted with
  [highlight.js](https://highlightjs.org/) 11 and diagrammed with
  [Mermaid](https://mermaid.js.org/) 10.
- **Live updates while you type**, debounced to ~150 ms, preserving your scroll position across
  re-renders.
- **Table-of-contents sidebar** with scroll-spy, click-to-scroll and a collapse toggle.
- **In-document search** (<kbd>Ctrl</kbd>/<kbd>Cmd</kbd>+<kbd>F</kbd>) with match highlighting and
  next/previous navigation.
- **Dark and light themes** that follow your VS Code colour theme, with a manual toggle that sticks.
- **Frontmatter card and document meta strip** — reading time, word count, headings, code blocks.
- **GitHub-style callouts** (`> [!NOTE]`, `> [!WARNING]`, …), task lists and scrollable tables.
- **Everything is local.** Fonts (Inter, Lora, JetBrains Mono) and all JavaScript are vendored into
  the extension, so nothing is fetched from a CDN.

## Usage

Open a Markdown file, then either:

- click the **book icon** in the editor title bar, or
- run **MarkFlow: Open Reader** / **MarkFlow: Open Reader to the Side** from the Command Palette.

Inside the reader:

| Action | How |
| --- | --- |
| Search the document | <kbd>Ctrl</kbd>/<kbd>Cmd</kbd>+<kbd>F</kbd>, or the magnifier button |
| Next / previous match | <kbd>Enter</kbd> / <kbd>Shift</kbd>+<kbd>Enter</kbd>, or the arrow buttons |
| Close search / diagram zoom | <kbd>Esc</kbd> |
| Toggle the table of contents | the ☰ button |
| Toggle dark / light | the moon / sun button |
| Copy a code block | the **Copy** button in its header |
| Enlarge a diagram | hover it, then **Zoom** |

Links behave the way you would expect: in-document anchors scroll within the reader, relative links
to other Markdown files open that file's reader, and everything else opens in your browser. Relative
image paths are resolved against the document's folder.

## Settings

| Setting | Default | What it does |
| --- | --- | --- |
| `markflow.contentMaxWidth` | `1000` | Maximum width, in pixels, of the rendered column. |
| `markflow.fontSize` | `16` | Base font size, in pixels. |
| `markflow.tocOpenByDefault` | `true` | Whether the TOC sidebar starts open. |
| `markflow.theme` | `auto` | `auto` follows VS Code's theme; `dark` / `light` pin one. |

## Development

```sh
npm install
npm run build     # vendors the browser bundles into media/vendor, then compiles with tsc
npm test          # node --test over the heading-extraction / slug module
```

Then press <kbd>F5</kbd> (or run `code --extensionDevelopmentPath=.`) to launch the Extension
Development Host and open a Markdown file.

`media/vendor/` is generated, not committed: `npm run vendor` copies the pinned `marked`,
`highlight.js`, `dompurify`, `mermaid` and `@fontsource` files out of `node_modules`, so the
vendored copies are reproducible rather than hand-pasted. Run `npm run build` after a fresh clone.

### Layout

```
src/extension.ts   activate(): registers the two commands
src/preview.ts     panel lifecycle, HTML shell, CSP + nonce, message passing, link routing
media/reader.css   MarkFlow's reader CSS, ported
media/reader.js    render + TOC + scroll-spy + search + mermaid, ported
media/toc.js       heading extraction and slug generation, shared with the tests
media/vendor/      generated: marked, highlight.js, dompurify, mermaid, fonts
```

`media/toc.js` is loaded both by the webview (as `window.MarkFlowToc`) and by `node --test` (via
`require`), so the slugs stamped onto headings and the slugs the TOC links to cannot drift apart.

## License

[MIT](LICENSE)
