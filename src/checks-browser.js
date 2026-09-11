/**
 * Ensure / src/checks-browser.js
 *
 * Injected into the live page (via Playwright's addInitScript/addScriptTag/
 * evaluate) rather than imported as a module — this needs to run *inside*
 * the page under test, with no bundler and no assumptions about what that
 * page supports. Plain vanilla JS only, no imports, no module syntax: the
 * same source text has to be valid as an init script, as the body of an
 * injected <script>, and as a string handed to page.evaluate().
 *
 * This is the one place "how do we read a signal off a live page" lives.
 * The CI runner calls into these functions rather than re-deriving the
 * same DOM/window logic itself.
 */
(function () {
  function getText(selector) {
    const el = document.querySelector(selector);
    return el ? el.textContent.trim() : null;
  }

  function getAttr(selector, attr) {
    const el = document.querySelector(selector);
    return el ? el.getAttribute(attr) : null;
  }

  // Pulls a query-string parameter's value out of a URL-ish string, e.g.
  // extractParam('app.js?v=inside3&cb=2', 'v') -> 'inside3'
  function extractParam(urlLike, param) {
    if (!urlLike) return null;
    const qIndex = urlLike.indexOf('?');
    if (qIndex === -1) return null;
    // Drop any fragment first: 'app.js?v=1#frag' must not yield '1#frag'.
    const query = urlLike.slice(qIndex + 1).split('#')[0];
    const params = new URLSearchParams(query);
    return params.get(param);
  }

  // Finds the first <script src="..."> whose src contains `match`, without
  // needing to know an id ahead of time — useful when you don't control the
  // target page's markup and can't assume selectors exist.
  function getScriptSrcContaining(match) {
    const scripts = Array.from(document.querySelectorAll('script[src]'));
    const found = scripts.find((s) => s.getAttribute('src').indexOf(match) !== -1);
    return found ? found.getAttribute('src') : null;
  }

  // How many script srcs match — the runner reports this so a matcher that
  // silently picked the wrong one of several candidates is visible rather
  // than mistaken for a real regression.
  function countScriptSrcContaining(match) {
    const scripts = Array.from(document.querySelectorAll('script[src]'));
    return scripts.filter((s) => s.getAttribute('src').indexOf(match) !== -1).length;
  }

  function getGlobalInfo(path) {
    const parts = path.split('.');
    let cur = window;
    for (const p of parts) {
      if (cur == null) { cur = undefined; break; }
      cur = cur[p];
    }
    // `typeof null` is 'object', so a global that exists but is null would
    // otherwise satisfy expectType: 'object'. Report it separately.
    return { path, typeofValue: typeof cur, isNull: cur === null };
  }

  // Returns the *bytes* the browser received, base64-encoded, not a decoded
  // string: fetch().text() silently strips a UTF-8 BOM and replaces invalid
  // UTF-8 sequences, either of which makes a byte-for-byte hash comparison
  // against the committed file report a mismatch that isn't real.
  async function fetchBytes(url) {
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) throw new Error('fetch ' + url + ' failed: ' + res.status);
    const bytes = new Uint8Array(await res.arrayBuffer());
    let binary = '';
    const CHUNK = 0x8000; // avoid blowing the argument limit on big files
    for (let i = 0; i < bytes.length; i += CHUNK) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
    }
    return btoa(binary);
  }

  window.__ENSURE_READ__ = {
    getText,
    getAttr,
    extractParam,
    getGlobalInfo,
    fetchBytes,
    getScriptSrcContaining,
    countScriptSrcContaining,
  };
})();
