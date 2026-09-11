#!/usr/bin/env node
/**
 * Ensure / replay / ensure-run.js
 *
 * Unlike click-test, there's no "record a human session" phase here —
 * every check's expected value is either a fixed literal, a cross-check
 * against another live-read value, or a hash computed from a real file on
 * disk (usually a sibling repo checked out alongside this one in CI). So
 * the whole tool is just: read live signals, grade them, report.
 *
 * Usage:
 *   APP_URL=https://nolongerzzz.github.io/nest-optimizer/?cth=1 \
 *   node replay/ensure-run.js checks/nest-optimizer.json
 *
 * Env vars:
 *   APP_URL              - the live page to check
 *   REPO_CHECKOUT_DIR    - local path to the source repo, for assetHash checks
 *                          that hash a committed file (default: cwd). Paths
 *                          in `repoFile` resolve against it.
 *   ENSURE_CHROMIUM_PATH - optional; launch this Chromium binary instead of
 *                          Playwright's own download (self-hosted runners,
 *                          sandboxes, distro-packaged Chromium)
 *   ENSURE_NAV_TIMEOUT_MS - navigation timeout, default 30000
 *   ENSURE_SETTLE_MS      - how long to wait for network idle *after* load
 *                           before reading signals, default 5000. Not
 *                           reaching idle is not an error: plenty of real
 *                           apps poll forever and would never be checkable.
 *   GITHUB_TOKEN / GITHUB_REPOSITORY - only needed to auto-file issues
 */

import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { gradeCheck, matchesExpectedDetail, sha256 } from '../src/ensure-grade.js';
import { fileIssuesForFailures } from './github-issues.js';

const APP_URL = process.env.APP_URL;
const REPO_DIR = process.env.REPO_CHECKOUT_DIR || '.';
const NAV_TIMEOUT_MS = Number(process.env.ENSURE_NAV_TIMEOUT_MS || 30000);
const SETTLE_MS = Number(process.env.ENSURE_SETTLE_MS || 5000);
const configPath = process.argv[2];

if (!APP_URL || !configPath) {
  console.error('Usage: APP_URL=<url> node ensure-run.js <checks.json>');
  process.exit(2);
}

const checksBrowserSrc = readFileSync(new URL('../src/checks-browser.js', import.meta.url), 'utf-8');

let config;
try {
  config = JSON.parse(readFileSync(configPath, 'utf-8'));
} catch (err) {
  console.error(`Could not read checks file ${path.resolve(configPath)}: ${err.message}`);
  process.exit(2);
}
if (!config || !Array.isArray(config.checks) || config.checks.length === 0) {
  console.error(`${path.resolve(configPath)} has no "checks" array.`);
  process.exit(2);
}

async function readSignal(page, read) {
  if (read.type === 'text') {
    return page.evaluate((sel) => window.__ENSURE_READ__.getText(sel), read.selector);
  }
  if (read.type === 'scriptSrcContaining') {
    const raw = await page.evaluate((m) => window.__ENSURE_READ__.getScriptSrcContaining(m), read.match);
    // Picking the first of several matches silently is how a checks file ends
    // up grading the wrong script — 'app' matches both app.js and app-cth.js.
    const matchCount = await page.evaluate((m) => window.__ENSURE_READ__.countScriptSrcContaining(m), read.match);
    if (matchCount > 1) {
      console.log(`     note: ${matchCount} script srcs contain "${read.match}"; using the first (${raw}). Narrow the matcher if that's not the one you meant.`);
    }
    if (read.extractParam) {
      return page.evaluate(
        ({ raw, param }) => window.__ENSURE_READ__.extractParam(raw, param),
        { raw, param: read.extractParam }
      );
    }
    return raw;
  }
  if (read.type === 'attr') {
    const raw = await page.evaluate(
      ({ sel, attr }) => window.__ENSURE_READ__.getAttr(sel, attr),
      { sel: read.selector, attr: read.attr }
    );
    if (read.extractParam) {
      return page.evaluate(
        ({ raw, param }) => window.__ENSURE_READ__.extractParam(raw, param),
        { raw, param: read.extractParam }
      );
    }
    return raw;
  }
  throw new Error(`Unknown read type: ${read.type}`);
}

// Fetches through the page's own fetch(), so the bytes are whatever the
// browser is served from that origin right now — the whole point of the
// assetHash kind. Node fetching the URL itself would prove nothing about
// what the browser sees. Base64 in, raw bytes out: see fetchBytes().
async function fetchLiveBytes(page, url) {
  const b64 = await page.evaluate((u) => window.__ENSURE_READ__.fetchBytes(u), url);
  return Buffer.from(b64, 'base64');
}

async function gatherLive(page, check) {
  if (check.kind === 'agree') {
    const values = [];
    for (const s of check.sources || []) {
      values.push({ label: s.label, value: await readSignal(page, s.read) });
    }
    return { values };
  }
  if (check.kind === 'globalExists') {
    const actual = await page.evaluate((p) => window.__ENSURE_READ__.getGlobalInfo(p), check.path);
    return { actual };
  }
  if (check.kind === 'assetHash' || check.kind === 'parses') {
    const url = new URL(check.liveUrl, APP_URL).toString();
    const liveBytes = await fetchLiveBytes(page, url);
    if (check.kind === 'parses') return { source: liveBytes.toString('utf-8') };

    const repoFilePath = path.resolve(REPO_DIR, check.repoFile);
    let expectedBytes;
    try {
      expectedBytes = readFileSync(repoFilePath);
    } catch (err) {
      throw new Error(
        `assetHash repoFile unreadable: ${repoFilePath} (${err.code}). ` +
          `repoFile="${check.repoFile}" resolved against REPO_CHECKOUT_DIR="${REPO_DIR}" (cwd ${process.cwd()}).`
      );
    }
    return { liveHash: sha256(liveBytes), expectedHash: sha256(expectedBytes), liveUrl: url, repoFilePath };
  }
  throw new Error(`Unknown check kind: ${check.kind}`);
}

// checks-browser.js has to be present in the page before any signal is read.
// addInitScript runs it at document start on every document (so it survives
// same-page navigations); addScriptTag and evaluate are fallbacks. The
// evaluate path matters: a page with a Content-Security-Policy that has no
// 'unsafe-inline' *rejects* addScriptTag outright, and without a fallback
// every single check on such a site errors out.
async function ensureReaderInjected(page) {
  if (await page.evaluate(() => typeof window.__ENSURE_READ__ !== 'undefined')) return 'init-script';
  try {
    await page.addScriptTag({ content: checksBrowserSrc });
    if (await page.evaluate(() => typeof window.__ENSURE_READ__ !== 'undefined')) return 'script-tag';
  } catch {
    // CSP-blocked; fall through to evaluate, which CSP does not apply to.
  }
  await page.evaluate(checksBrowserSrc);
  if (await page.evaluate(() => typeof window.__ENSURE_READ__ !== 'undefined')) return 'evaluate';
  throw new Error('could not inject src/checks-browser.js into the page');
}

async function main() {
  const browser = await chromium.launch(
    process.env.ENSURE_CHROMIUM_PATH ? { executablePath: process.env.ENSURE_CHROMIUM_PATH } : {}
  );
  const page = await browser.newPage();
  await page.addInitScript({ content: checksBrowserSrc });

  try {
    await page.goto(APP_URL, { waitUntil: 'load', timeout: NAV_TIMEOUT_MS });
  } catch (err) {
    await browser.close();
    console.error(`Could not load APP_URL=${APP_URL}: ${err.message.split('\n')[0]}`);
    process.exit(2);
  }
  // Best-effort settle. A page that never goes idle is still checkable.
  await page.waitForLoadState('networkidle', { timeout: SETTLE_MS }).catch(() => {});
  const injectedVia = await ensureReaderInjected(page);

  const outcomes = [];
  for (const check of config.checks) {
    const expectOutcome = check.expect || 'pass';
    let graded;
    try {
      const live = await gatherLive(page, check);
      graded = gradeCheck(check, live);
    } catch (err) {
      graded = { result: 'error', detail: { reason: 'error', message: err.message } };
    }

    const detailMatch = matchesExpectedDetail(graded.detail, check.expectDetail);
    const surprising = graded.result !== expectOutcome || !detailMatch.ok;
    outcomes.push({ id: check.id, kind: check.kind, expectOutcome, ...graded, surprising });

    const flag = surprising ? '!!' : '  ';
    console.log(`${flag} ${graded.result.padEnd(6)} (expected ${expectOutcome.padEnd(6)}) ${check.id}`);
    // Print detail for anything that isn't a plain pass, even when it's the
    // expected outcome: the negative controls' whole value is in *why* they
    // failed, and a run that hides that can't be read after the fact.
    if (surprising || graded.result !== 'pass') {
      console.log(`     ${JSON.stringify(graded.detail)}`);
    }
    if (!detailMatch.ok) {
      console.log(`     expectDetail mismatch: ${JSON.stringify(detailMatch.mismatched)}`);
    }
  }

  await browser.close();

  const surprises = outcomes.filter((o) => o.surprising);
  console.log(`\n${outcomes.length - surprises.length}/${outcomes.length} as expected (reader injected via ${injectedVia})`);

  if (surprises.length && process.env.GITHUB_TOKEN && process.env.GITHUB_REPOSITORY) {
    const [owner, repo] = process.env.GITHUB_REPOSITORY.split('/');
    const { created, commented } = await fileIssuesForFailures({
      entries: surprises.map((s) => ({
        testId: s.id,
        title: `${s.kind}: ${s.id}`,
        result: s.result,
        expected: s.expectOutcome,
        hit: s.detail,
      })),
      owner,
      repo,
      token: process.env.GITHUB_TOKEN,
      tagPrefix: 'ensure',
    });
    console.log(`Filed ${created} new issue(s), updated ${commented} existing.`);
  }

  process.exit(surprises.length ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
