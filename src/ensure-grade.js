/**
 * Ensure / src/ensure-grade.js
 *
 * Single source of truth for pass/fail/mismatch grading. Both the CI
 * runner and any future interactive tool must call into this file rather
 * than reimplementing comparison logic — that duplication is exactly what
 * caused a real bug in click-test's sibling project (grade.js there was
 * copy-pasted into two places and only one copy got a fix). Not repeating
 * that here.
 *
 * Four check kinds, one grading function each:
 *   agree        - a set of values read from different places must be identical
 *   globalExists - a window property must exist with an expected typeof
 *   assetHash    - a live-served file's bytes must hash-match a reference copy
 *   parses       - a live-served script's source must be syntactically valid JS
 *
 * Grading is deliberately strict about *unreadable* signals: a check whose
 * inputs could not be read at all must never be graded 'pass', or the tool
 * reports green on a page it never actually managed to inspect.
 */

import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import vm from 'node:vm';

export function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

export function gradeAgree(values) {
  // values: [{ label, value }, ...]
  if (!Array.isArray(values) || values.length < 2) {
    // One source always "agrees" with itself — that's a spec bug, not a pass.
    return {
      result: 'fail',
      detail: { reason: 'not-enough-sources', count: Array.isArray(values) ? values.length : 0 },
    };
  }

  const readable = values.map((v) => ({ label: v.label, value: v.value }));
  const unreadable = readable.filter((v) => v.value === null || v.value === undefined);
  if (unreadable.length) {
    // Two selectors that both read as null are not "in agreement" — that's
    // two dead reads, and grading them 'pass' is how a tool reports green
    // on a page whose markup moved out from under its checks file.
    return {
      result: 'fail',
      detail: {
        reason: 'unreadable',
        unreadable: unreadable.map((v) => v.label),
        values: readable,
      },
    };
  }

  const distinct = [...new Set(readable.map((v) => v.value))];
  if (distinct.length === 1) {
    return { result: 'pass', detail: { reason: 'agree', value: distinct[0] } };
  }
  return { result: 'fail', detail: { reason: 'mismatch', mismatch: readable } };
}

export function gradeGlobalExists(actual, expectType) {
  if (!actual || typeof actual.typeofValue !== 'string') {
    return { result: 'fail', detail: { reason: 'unreadable' } };
  }
  if (actual.typeofValue === 'undefined') {
    return { result: 'fail', detail: { reason: 'missing', path: actual.path } };
  }
  if (actual.isNull) {
    // typeof null === 'object', so without this an explicitly-null global
    // satisfies expectType: 'object' — the exact false pass this kind exists
    // to catch (the global is there in name only).
    return { result: 'fail', detail: { reason: 'null', path: actual.path, expectType: expectType ?? null } };
  }
  if (expectType && actual.typeofValue !== expectType) {
    return {
      result: 'fail',
      detail: { reason: 'wrong-type', path: actual.path, expectType, actualType: actual.typeofValue },
    };
  }
  return { result: 'pass', detail: { reason: 'exists', path: actual.path, type: actual.typeofValue } };
}

export function gradeAssetHash(liveHash, expectedHash) {
  if (!liveHash || !expectedHash) {
    return { result: 'fail', detail: { reason: 'unreadable', liveHash: liveHash ?? null, expectedHash: expectedHash ?? null } };
  }
  if (liveHash === expectedHash) return { result: 'pass', detail: { reason: 'hash-match', hash: liveHash } };
  return { result: 'fail', detail: { reason: 'hash-mismatch', liveHash, expectedHash } };
}

// Compiles (never executes) the source as a classic script. vm.Script has
// real top-level script semantics, unlike `new Function`, which wraps the
// source in a function body and so happily accepts a bare top-level
// `return` that no browser would.
function parsesAsClassic(source) {
  try {
    new vm.Script(source, { filename: 'ensure-parses-check.js' });
    return { ok: true };
  } catch (err) {
    return { ok: false, message: err.message };
  }
}

// `import`/`export` are SyntaxErrors in a classic script, so module sources
// have to be parsed as modules or every ES module asset reports a bogus
// truncation failure. node --check parses without executing; there is no
// flag-free in-process equivalent for module syntax.
function parsesAsModule(source) {
  const res = spawnSync(process.execPath, ['--input-type=module', '--check'], {
    input: source,
    encoding: 'utf-8',
  });
  if (res.error) return { ok: false, message: `module syntax check failed to run: ${res.error.message}` };
  if (res.status === 0) return { ok: true };
  const stderr = (res.stderr || '').trim();
  const line = stderr.split('\n').find((l) => /Error/.test(l));
  return { ok: false, message: (line || stderr || 'module parse failed').trim() };
}

/**
 * scriptType: 'auto' (default) accepts either classic or module syntax —
 * this kind exists to catch truncation and corruption, not to police which
 * one a file is. Pin it with "scriptType": "classic" | "module" in the
 * check spec when the file's kind is known and a mismatch is itself a bug.
 */
export function gradeParses(source, scriptType = 'auto') {
  if (typeof source !== 'string') {
    return { result: 'fail', detail: { reason: 'unreadable' } };
  }

  if (scriptType === 'module') {
    const mod = parsesAsModule(source);
    return mod.ok
      ? { result: 'pass', detail: { reason: 'parses', as: 'module' } }
      : { result: 'fail', detail: { reason: 'syntax-error', as: 'module', message: mod.message } };
  }

  const classic = parsesAsClassic(source);
  if (classic.ok) return { result: 'pass', detail: { reason: 'parses', as: 'classic' } };
  if (scriptType === 'classic') {
    return { result: 'fail', detail: { reason: 'syntax-error', as: 'classic', message: classic.message } };
  }

  const mod = parsesAsModule(source);
  if (mod.ok) return { result: 'pass', detail: { reason: 'parses', as: 'module' } };
  return {
    result: 'fail',
    detail: { reason: 'syntax-error', as: 'neither', message: classic.message, moduleMessage: mod.message },
  };
}

/**
 * Compares a graded check's detail against an optional `expectDetail` in the
 * spec. Subset match: only the keys named in expectDetail are compared, so a
 * negative control can pin *why* it failed ("reason": "wrong-type") without
 * having to restate hashes or messages that legitimately vary.
 *
 * This is what turns negative-controls.json from "five things went red" into
 * "five things went red for the five stated reasons" — a grader that started
 * failing for a different reason than documented is itself a regression.
 */
export function matchesExpectedDetail(detail, expectDetail) {
  if (!expectDetail) return { ok: true };
  const actual = detail || {};
  const mismatched = [];
  for (const [key, want] of Object.entries(expectDetail)) {
    const got = actual[key];
    if (JSON.stringify(got) !== JSON.stringify(want)) {
      mismatched.push({ key, expected: want, actual: got ?? null });
    }
  }
  return mismatched.length ? { ok: false, mismatched } : { ok: true };
}

/**
 * Dispatches a single check spec + its live-read data to the right grader.
 * `live` shape depends on `check.kind` — see replay/ensure-run.js for how
 * each kind's live data is gathered.
 */
export function gradeCheck(check, live) {
  switch (check.kind) {
    case 'agree':
      return gradeAgree(live.values);
    case 'globalExists':
      return gradeGlobalExists(live.actual, check.expectType);
    case 'assetHash':
      return gradeAssetHash(live.liveHash, live.expectedHash);
    case 'parses':
      return gradeParses(live.source, check.scriptType || 'auto');
    default:
      throw new Error(`Unknown check kind: ${check.kind}`);
  }
}
