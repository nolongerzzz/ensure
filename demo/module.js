// demo/module.js — valid ES module syntax, never loaded by index.html.
// Exists so the `parses` check is exercised against module source: a
// classic-script-only parser reports "Unexpected token 'export'" here,
// which looks exactly like the truncation this check is meant to catch.
export const DEMO_MODULE_VERSION = 'demo1';
export function stamp(el) {
  el.textContent = DEMO_MODULE_VERSION;
}
