'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { slugify, headingText, extractHeadings } = require('../media/toc.js');

test('slugify lowercases, drops punctuation and joins words with dashes', () => {
  assert.equal(slugify('Getting Started'), 'getting-started');
  assert.equal(slugify('What is MarkFlow?'), 'what-is-markflow');
  assert.equal(slugify('  Spaced   Out  '), 'spaced-out');
  assert.equal(slugify('API: `render()` & friends'), 'api-render-friends');
  assert.equal(slugify('<em>Emphasised</em> heading'), 'emphasised-heading');
  assert.equal(slugify('Keep-The-Dashes'), 'keep-the-dashes');
  assert.equal(slugify('🎉'), '');
});

test('headingText strips markdown emphasis and code markers', () => {
  assert.equal(headingText('**Bold** and _italic_ and `code`'), 'Bold and italic and code');
});

test('extractHeadings reads levels, text and slugs in document order', () => {
  const h = extractHeadings('# Title\n\ntext\n\n## First Section\n\n### Nested\n');
  assert.deepEqual(h.map((x) => [x.level, x.text, x.slug]), [
    [1, 'Title', 'title'],
    [2, 'First Section', 'first-section'],
    [3, 'Nested', 'nested'],
  ]);
});

test('the leading level-1 heading is the document title and stays out of the TOC', () => {
  const h = extractHeadings('# Title\n\n## Section\n\n# Second Top Level\n');
  assert.deepEqual(h.map((x) => [x.text, x.inToc]), [
    ['Title', false],
    ['Section', true],
    ['Second Top Level', true],
  ]);
});

test('headings deeper than level 3 are extracted but excluded from the TOC', () => {
  const h = extractHeadings('## Two\n\n#### Four\n\n###### Six\n');
  assert.deepEqual(h.map((x) => [x.level, x.inToc]), [[2, true], [4, false], [6, false]]);
  // still extracted, so slug numbering stays aligned with what the renderer emits
  assert.deepEqual(h.map((x) => x.slug), ['two', 'four', 'six']);
});

test('repeated heading names get distinct slugs', () => {
  const h = extractHeadings('## Usage\n\n## Usage\n\n## Usage\n');
  assert.deepEqual(h.map((x) => x.slug), ['usage', 'usage-2', 'usage-3']);
});

test('headings that slugify to nothing fall back to a stable slug', () => {
  const h = extractHeadings('## 🎉\n\n## ***\n');
  assert.deepEqual(h.map((x) => x.slug), ['section', 'section-2']);
});

test('hashes inside fenced code blocks are not headings', () => {
  const md = ['## Real', '', '```sh', '# not a heading', '```', '', '~~~', '## also not', '~~~', '', '## Also Real'].join('\n');
  assert.deepEqual(extractHeadings(md).map((x) => x.text), ['Real', 'Also Real']);
});

test('a tilde fence does not close a backtick fence', () => {
  const md = ['```', '~~~', '# still in code', '```', '', '## After'].join('\n');
  assert.deepEqual(extractHeadings(md).map((x) => x.text), ['After']);
});

test('closing hashes and missing space are handled the way ATX requires', () => {
  assert.deepEqual(extractHeadings('## Closed ##\n').map((x) => [x.text, x.slug]), [['Closed', 'closed']]);
  assert.deepEqual(extractHeadings('##NoSpace\n'), []);
  assert.deepEqual(extractHeadings('####### Seven\n'), []);
});

test('an empty document yields no headings', () => {
  assert.deepEqual(extractHeadings(''), []);
});
