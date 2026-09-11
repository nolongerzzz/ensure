/**
 * Ensure / replay / github-issues.js
 *
 * Same dedupe approach proven in click-test: search is index-lagged (by
 * roughly a minute) so we look up existing open issues by listing and
 * matching a hidden tag exactly, rather than relying on GitHub's search
 * API being immediately consistent.
 */

// GITHUB_API_URL is set by GitHub Actions itself (https://api.github.com on
// github.com, the appliance's own URL on Enterprise), so honouring it is both
// what makes this correct on GHES and what makes it testable against a mock.
const API = (process.env.GITHUB_API_URL || 'https://api.github.com').replace(/\/+$/, '');

function issueTag(prefix, id) {
  return `<!-- ${prefix}:${id} -->`;
}

async function githubFetch(path, token, options = {}) {
  const res = await fetch(`${API}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(options.headers || {}),
    },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GitHub API ${options.method || 'GET'} ${path} failed: ${res.status} ${text}`);
  }
  return res.json();
}

async function findExistingIssue({ owner, repo, token, tagPrefix, id }) {
  const tag = issueTag(tagPrefix, id);
  let page = 1;
  while (page <= 5) { // cap pagination; a repo with 500+ open issues needs a different approach anyway
    const issues = await githubFetch(`/repos/${owner}/${repo}/issues?state=open&per_page=100&page=${page}`, token);
    if (!issues.length) break;
    const match = issues.find((i) => (i.body || '').includes(tag));
    if (match) return match;
    page++;
  }
  return null;
}

function buildBody(entry, tagPrefix) {
  return [
    issueTag(tagPrefix, entry.testId),
    '',
    `**Check:** ${entry.testId}`,
    `**Result:** ${entry.result}`,
    `**Expected:** \`${entry.expected || 'n/a'}\``,
    `**Detail:** \`${entry.hit ? JSON.stringify(entry.hit) : 'none'}\``,
    '',
    'Filed automatically by Ensure CI.',
  ].join('\n');
}

export async function fileIssuesForFailures({ entries, owner, repo, token, tagPrefix = 'ensure' }) {
  let created = 0, commented = 0;

  for (const entry of entries) {
    const existing = await findExistingIssue({ owner, repo, token, tagPrefix, id: entry.testId });
    if (existing) {
      await githubFetch(`/repos/${owner}/${repo}/issues/${existing.number}/comments`, token, {
        method: 'POST',
        body: JSON.stringify({ body: `Still surprising as of this run.\n\n${buildBody(entry, tagPrefix)}` }),
      });
      commented++;
    } else {
      await githubFetch(`/repos/${owner}/${repo}/issues`, token, {
        method: 'POST',
        body: JSON.stringify({
          title: `[${tagPrefix}] ${entry.title}`,
          body: buildBody(entry, tagPrefix),
          labels: [tagPrefix, 'bug'],
        }),
      });
      created++;
    }
  }

  return { created, commented };
}
