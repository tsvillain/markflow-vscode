/**
 * Heading extraction and TOC slug generation.
 *
 * Shared verbatim between the webview (loaded as a classic script, exposed as
 * `window.MarkFlowToc`) and `node --test` (loaded with `require`), so the slugs
 * the renderer stamps onto headings and the slugs the TOC links to cannot drift.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.MarkFlowToc = api;
})(typeof self !== 'undefined' ? self : globalThis, function () {
  'use strict';

  /** MarkFlow's slug rule: strip tags, lowercase, drop punctuation, spaces to dashes. */
  function slugify(text) {
    return String(text)
      .replace(/<[^>]*>/g, '')
      .toLowerCase()
      .replace(/[^\w\s-]/g, '')
      .trim()
      .replace(/\s+/g, '-');
  }

  /** Display text for the TOC: markdown emphasis/code markers removed. */
  function headingText(raw) {
    return raw.replace(/<[^>]*>/g, '').replace(/[*_`]/g, '').trim();
  }

  /**
   * Extract every ATX heading from a Markdown body, in document order.
   *
   * Returns `[{ level, text, slug, inToc }]`. Slugs are de-duplicated with a
   * `-2`, `-3`, ... suffix so repeated heading names still scroll to the right
   * section. `inToc` is false for headings deeper than level 3 and for the
   * leading level-1 heading, which MarkFlow treats as the document title.
   */
  function extractHeadings(markdown) {
    const out = [];
    const seen = new Map();
    let fence = null;
    let titleSkipped = false;

    for (const line of String(markdown).split('\n')) {
      const fenceMatch = line.match(/^\s{0,3}(```+|~~~+)/);
      if (fenceMatch) {
        const marker = fenceMatch[1][0];
        if (fence === null) fence = marker;
        else if (fence === marker) fence = null;
        continue;
      }
      if (fence !== null) continue;

      // ATX heading, with any closing run of #s trimmed off.
      const m = line.match(/^(#{1,6})\s+(.*?)\s*#*\s*$/);
      if (!m) continue;

      const level = m[1].length;
      const raw = m[2];
      let slug = slugify(raw) || 'section';
      const n = (seen.get(slug) || 0) + 1;
      seen.set(slug, n);
      if (n > 1) slug = `${slug}-${n}`;

      let inToc = level <= 3;
      if (level === 1 && !titleSkipped) {
        titleSkipped = true;
        inToc = false;
      }

      out.push({ level, text: headingText(raw), slug, inToc });
    }
    return out;
  }

  return { slugify, headingText, extractHeadings };
});
