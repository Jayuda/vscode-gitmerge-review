import { MergeRequest, ChangedFile } from '../models/types';
import { httpRequest, basicHeaders } from '../utils/httpClient';

const BASE = 'https://api.github.com';

interface GHPullRequest {
  id: number;
  number: number;
  title: string;
  body: string | null;
  user: { login: string; avatar_url: string };
  head: { ref: string };
  base: { ref: string };
  state: string;
  html_url: string;
  created_at: string;
  updated_at: string;
  labels: Array<{ name: string }>;
  requested_reviewers: Array<{ login: string }>;
  comments: number;
  additions?: number;
  deletions?: number;
  changed_files?: number;
  draft: boolean;
}

// Issue shape returned by /issues?filter=assigned (PRs show pull_request field)
interface GHIssue {
  id: number;
  number: number;
  title: string;
  body: string | null;
  state: string;
  draft?: boolean;
  pull_request?: { url: string };
  repository_url: string; // e.g. https://api.github.com/repos/owner/name
  html_url: string;
  created_at: string;
  updated_at: string;
  labels: Array<{ name: string }>;
  user: { login: string; avatar_url: string };
  assignees: Array<{ login: string }>;
}

interface GHFile {
  filename: string;
  previous_filename?: string;
  status: string;
  additions: number;
  deletions: number;
  patch?: string;
  blob_url: string;
}

/**
 * Fetch all open PRs relevant to the authenticated user across ALL repositories.
 * Includes PRs that are assigned to the user, created by the user, or where
 * the user's review was requested. Branch info is omitted here; use
 * getGithubPRDetails() to enrich.
 */
export async function getAssignedGithubPRs(token: string): Promise<MergeRequest[]> {
  const filters = ['assigned', 'created', 'review_requested'];
  const headers = basicHeaders(token);

  const results = await Promise.allSettled(
    filters.map((filter) =>
      httpRequest(`${BASE}/issues?filter=${filter}&state=open&per_page=100`, { headers }) as Promise<GHIssue[]>
    )
  );

  const seen = new Set<number>();
  const merged: MergeRequest[] = [];

  for (const result of results) {
    if (result.status !== 'fulfilled') { continue; }
    for (const issue of result.value) {
      if (!issue.pull_request || seen.has(issue.id)) { continue; }
      seen.add(issue.id);
      // repository_url: "https://api.github.com/repos/owner/name"
      const repoParts = issue.repository_url.replace(/.*\/repos\//, '').split('/');
      const owner = repoParts[0] ?? '';
      const repo  = repoParts[1] ?? '';
      merged.push({
        id: issue.id,
        iid: issue.number,
        number: issue.number,
        title: issue.title,
        description: issue.body ?? '',
        author: issue.user.login,
        authorAvatarUrl: issue.user.avatar_url,
        sourceBranch: '',   // filled in by getGithubPRDetails
        targetBranch: '',
        state: 'open' as const,
        url: issue.html_url,
        createdAt: issue.created_at,
        updatedAt: issue.updated_at,
        provider: 'github' as const,
        repoOwner: owner,
        repoName: repo,
        repoFullName: `${owner}/${repo}`,
        labels: issue.labels.map((l) => l.name),
        reviewers: [],
        commentCount: 0,
        additions: 0,
        deletions: 0,
        changedFilesCount: 0,
        isDraft: issue.draft ?? false,
      });
    }
  }

  return merged;
}

/**
 * Fetch full PR details (branches, stats, reviewers) for a single PR.
 * Useful to enrich a partial MergeRequest created by getAssignedGithubPRs.
 */
export async function getGithubPRDetails(
  owner: string,
  repo: string,
  prNumber: number,
  token: string
): Promise<Partial<MergeRequest>> {
  const url = `${BASE}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${prNumber}`;
  const pr = await httpRequest(url, { headers: basicHeaders(token) }) as GHPullRequest;
  return {
    sourceBranch: pr.head.ref,
    targetBranch: pr.base.ref,
    additions: pr.additions ?? 0,
    deletions: pr.deletions ?? 0,
    changedFilesCount: pr.changed_files ?? 0,
    isDraft: pr.draft ?? false,
    reviewers: pr.requested_reviewers.map((r) => r.login),
    commentCount: pr.comments,
  };
}

export async function getGithubPullRequests(
  owner: string,
  repo: string,
  token: string,
  includeAll = false
): Promise<MergeRequest[]> {
  const state = includeAll ? 'all' : 'open';
  const url = `${BASE}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls?state=${state}&per_page=50`;
  const raw = await httpRequest(url, { headers: basicHeaders(token) }) as GHPullRequest[];

  return raw.map((pr) => mapPR(pr, owner, repo));
}

export async function getGithubPRFiles(
  owner: string,
  repo: string,
  prNumber: number,
  token: string
): Promise<ChangedFile[]> {
  const url = `${BASE}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${prNumber}/files?per_page=100`;
  const raw = await httpRequest(url, { headers: basicHeaders(token) }) as GHFile[];

  return raw.map((f) => ({
    filename: f.filename,
    oldFilename: f.previous_filename,
    status: mapFileStatus(f.status),
    additions: f.additions,
    deletions: f.deletions,
    patch: f.patch,
    blobUrl: f.blob_url,
  }));
}

export async function mergeGithubPR(
  owner: string,
  repo: string,
  prNumber: number,
  token: string,
  message?: string
): Promise<void> {
  const url = `${BASE}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${prNumber}/merge`;
  await httpRequest(url, {
    method: 'PUT',
    headers: basicHeaders(token),
    body: JSON.stringify({
      merge_method: 'merge',
      commit_message: message ?? '',
    }),
  });
}

export async function closeGithubPR(
  owner: string,
  repo: string,
  prNumber: number,
  token: string
): Promise<void> {
  const url = `${BASE}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${prNumber}`;
  await httpRequest(url, {
    method: 'PATCH',
    headers: basicHeaders(token),
    body: JSON.stringify({ state: 'closed' }),
  });
}

export async function postGithubPRComment(
  owner: string,
  repo: string,
  prNumber: number,
  body: string,
  token: string
): Promise<void> {
  const url = `${BASE}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${prNumber}/comments`;
  await httpRequest(url, {
    method: 'POST',
    headers: basicHeaders(token),
    body: JSON.stringify({ body }),
  });
}

// ─── helpers ─────────────────────────────────────────────────────────────────

function mapPR(pr: GHPullRequest, owner: string, repo: string): MergeRequest {
  return {
    id: pr.id,
    iid: pr.number,
    number: pr.number,
    title: pr.title,
    description: pr.body ?? '',
    author: pr.user.login,
    authorAvatarUrl: pr.user.avatar_url,
    sourceBranch: pr.head.ref,
    targetBranch: pr.base.ref,
    state: pr.state === 'open' ? 'open' : pr.state === 'merged' ? 'merged' : 'closed',
    url: pr.html_url,
    createdAt: pr.created_at,
    updatedAt: pr.updated_at,
    provider: 'github',
    repoOwner: owner,
    repoName: repo,
    repoFullName: `${owner}/${repo}`,
    labels: pr.labels.map((l) => l.name),
    reviewers: pr.requested_reviewers.map((r) => r.login),
    commentCount: pr.comments,
    additions: pr.additions ?? 0,
    deletions: pr.deletions ?? 0,
    changedFilesCount: pr.changed_files ?? 0,
    isDraft: pr.draft ?? false,
  };
}

function mapFileStatus(s: string): ChangedFile['status'] {
  switch (s) {
    case 'added': return 'added';
    case 'removed': return 'deleted';
    case 'renamed': return 'renamed';
    case 'copied': return 'copied';
    default: return 'modified';
  }
}
