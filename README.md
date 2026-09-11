# Ensure

Catches the class of bug where the code is right but the browser isn't
running it — stale caches serving old bytes after a real deploy, a version
tag that drifted out of sync with the DOM text that's supposed to match it,
a module script that can't see a global the classic scripts set up, a file
write that got truncated mid-token. Built after tracing that exact pattern
across a project's memory log: a `mask6 cache-bust` PR, a locked rule that
three specific things must agree "or Grok will not merge," and a `cth5`
bug that was a module-vs-classic-scope mismatch in disguise.

## How this differs from click-test

click-test needed `app-cth.js` on the host app because it had to reach into
private internals (the camera, the raycaster) that only the app itself has
access to. **Ensure needs nothing from the host app.** Everything it checks
— rendered DOM text, `<script src>` tags, the actual bytes a browser
receives, whether a `window` property exists — is visible to Playwright on
any page, with zero cooperation required. No host hook, no `?gate=1` query
param, no wiring PR.

## The four check kinds

| kind | catches | example |
|---|---|---|
| `agree` | version-tag / HUD-text drift | script's `?v=` tag vs `#adjust-status` text must match |
| `globalExists` | module/classic scope mismatches | `window.state` must exist as an `object` |
| `assetHash` | stale cache serving old bytes | live-fetched `app-cth.js` must hash-match the committed file |
| `parses` | truncated/corrupted writes | a live-fetched script must be valid JS, not cut off mid-token |

All four are graded by exactly one function each, in `src/ensure-grade.js`
— nowhere else. If grading logic needs to change, change it there.

## Check spec shape

```json
{ "id": "hud-version-tag-agree", "kind": "agree",
  "sources": [
    { "label": "a", "read": { "type": "scriptSrcContaining", "match": "app", "extractParam": "v" } },
    { "label": "b", "read": { "type": "text", "selector": "#adjust-status" } }
  ] }

{ "id": "window-state-exists", "kind": "globalExists", "path": "state", "expectType": "object" }

{ "id": "app-cth-hash-matches-repo", "kind": "assetHash", "liveUrl": "app-cth.js", "repoFile": "app-cth.js" }

{ "id": "app-cth-parses", "kind": "parses", "liveUrl": "app-cth.js", "scriptType": "module" }
```

Every check accepts an optional `"expect": "fail"` (default `"pass"`) —
that's what lets `checks/negative-controls.json` deliberately produce
failures on every run without spamming issues: a check only counts as
*surprising* (and gets filed) when its actual result differs from what it
declared it should be.

It also accepts an optional `"expectDetail"`, a subset of the grader's
`detail` object that must also match — e.g. `{"reason": "wrong-type"}`.
A check that produces the expected `fail` for an *unexpected reason* is
surprising too. Without this, a grader that started reporting every failure
as (say) "missing" would keep the negative controls green while having lost
the ability to tell the failure modes apart.

`read.type` options: `text` (selector's textContent), `attr` (an attribute,
optionally extracting a `?param=` from it), `scriptSrcContaining` (find the
first `<script src>` containing a substring — for when you don't control the
target's markup and can't assume an id exists).

`parses` accepts `"scriptType"`: `"auto"` (default — accepts classic *or*
ES module syntax), `"classic"`, or `"module"`. Pin it when a file's kind is
known: under `auto`, an `export` in a file that's loaded as a classic script
is accepted, and that's itself a bug worth catching.

Grading refuses to call a check `pass` when its inputs could not be read at
all: an `agree` whose sources both read as `null` is `fail` (reason
`unreadable`), not agreement, and a `globalExists` for a global that exists
but is `null` is `fail` (reason `null`) even when `expectType` is `object`,
because `typeof null === 'object'`.

## Running it

```
npm install
npm run self-test        # proves Ensure's own logic against its own demo
```

`npm run self-test` starts the demo server in-process on an ephemeral port,
runs both checks files as real subprocesses, and shuts the server down
again — nothing to background, nothing to leak, no fixed port to collide on.

Against a real app:
```
APP_URL=https://example.com REPO_CHECKOUT_DIR=../that-repo \
  node replay/ensure-run.js checks/your-checks.json
```

Exit codes: `0` = no surprises, `1` = at least one surprise, `2` = usage or
setup problem (no `APP_URL`, unreadable checks file, page wouldn't load).

`REPO_CHECKOUT_DIR` only matters for `assetHash` checks — it's the local
path `repoFile` is resolved against (relative paths resolve from the current
working directory), normally a sibling checkout of the app's own repo in CI
(see `.github/workflows/ensure-checks.yml`). A `repoFile` that can't be read
is reported as `error`, never as a `fail`: a broken checkout and a real byte
mismatch are different problems and shouldn't look alike.

Other env vars:

| var | default | purpose |
|---|---|---|
| `ENSURE_CHROMIUM_PATH` | Playwright's own download | launch a specific Chromium binary (self-hosted runners, sandboxes, distro packages) |
| `ENSURE_NAV_TIMEOUT_MS` | `30000` | navigation timeout |
| `ENSURE_SETTLE_MS` | `5000` | how long to wait for network idle after `load`. Never reaching idle is not an error — plenty of real apps poll forever |
| `GITHUB_API_URL` | `https://api.github.com` | set automatically by GitHub Actions; also what makes GHES work |
| `GITHUB_TOKEN` / `GITHUB_REPOSITORY` | unset | only needed to auto-file issues |

## How the live page is read

`src/checks-browser.js` is injected into the page and everything is read
from inside it — there is no second copy of the DOM logic in the runner.
It goes in three ways, in order: `addInitScript` (runs at document start, so
it survives the page's own navigations), `addScriptTag`, then
`page.evaluate`. The last one matters: a page whose Content-Security-Policy
lacks `unsafe-inline` **refuses** an injected inline `<script>`, and without
that fallback every check on such a site errors out.

`assetHash` and `parses` fetch through the page's own `fetch()`, so the
bytes graded are the bytes that origin serves to a browser, not what Node
gets from the same URL. The reader hands back raw bytes (base64), not text:
`Response.text()` silently strips a UTF-8 BOM and substitutes replacement
characters for invalid UTF-8, either of which turns a byte-exact hash
comparison into a permanent false mismatch.

## Negative controls — do not "fix" these

`checks/negative-controls.json` is deliberately wrong on every entry, on
purpose, so a regression in `ensure-grade.js` that made grading too
permissive would be caught (mirrors the same pattern in click-test, which
found a real drift bug this way once). Each entry has a `note` explaining
exactly why it's supposed to fail, and an `expectDetail` pinning the reason
so "failed, but for the wrong reason" is caught too. If one starts passing
instead, that's the thing to investigate — not something to delete.

## `checks/nest-optimizer.json` is a draft, not verified

It's built from facts confirmed in the project memory log (`#adjust-status`
is named explicitly in a locked rule; the `cth5` bug is exactly the
`window.state` scope mismatch this tool is designed to catch), but the
script-tag matcher and `app-cth.js`'s exact path are best guesses, not
confirmed against the real `index.html`. Verify selectors before trusting
a red result from this file — a wrong guess reports the same "fail" a real
regression would. `.github/workflows/ensure-checks.yml` is `workflow_dispatch`
only for that reason: its schedule stays commented out until the selectors
are confirmed, because that job files issues.

## Known limitations

- **Only catches drift Ensure knows to look for.** It's not a general
  linter or a full DOM diff — it checks exactly the signals declared in a
  checks file. New failure patterns need new check specs, same as
  click-test needs new fixtures for new geometry.
- **`assetHash` needs a source-of-truth checkout.** If the "expected" file
  in `REPO_CHECKOUT_DIR` is itself stale (e.g., CI checked out the wrong
  ref), this reports a false mismatch. Worth double-checking `git log -1`
  in that checkout if a hash check ever looks wrong.
- **`assetHash` fetches with `cache: 'no-store'`,** so it grades what the
  origin serves *now*, not what this particular browser had cached. That's
  the right question for a CDN/Pages stale-deploy check and it's
  deterministic in CI (a fresh browser has an empty cache anyway), but it
  does mean a stale copy sitting in one end user's browser cache is out of
  scope. Cross-origin `liveUrl`s need CORS, or the fetch fails.
- **The `parses` check only proves syntactic validity, not correctness.**
  A file that parses fine can still be logically broken. This catches
  truncation and gross corruption, not subtle bugs — and not every
  truncation: a file cut at `window.sta` is still valid JavaScript. Pair it
  with `assetHash`, which catches truncation at any offset.
