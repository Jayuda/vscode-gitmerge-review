import { MergeRequest, ChangedFile } from '../models/types';
import { httpRequest, bearerHeaders } from '../utils/httpClient';
import type * as vscode from 'vscode';

interface GLMergeRequest {
  id: number;
  iid: number;
  project_id: number;
  title: string;
  description: string | null;
  author: { username: string; avatar_url: string };
  source_branch: string;
  target_branch: string;
  state: string;
  web_url: string;
  created_at: string;
  updated_at: string;
  labels: string[];
  reviewers: Array<{ username: string }>;
  user_notes_count: number;
  draft: boolean;
}

interface GLChanges {
  changes: Array<{
    old_path: string;
    new_path: string;
    new_file: boolean;
    deleted_file: boolean;
    renamed_file: boolean;
    diff: string;
  }>;
  changes_count?: string;
  additions?: number;
  deletions?: number;
}

/**
 * Fetch all open MRs assigned to (or review-requested from) the authenticated user across ALL projects.
 */
export async function getAssignedGitlabMRs(
  token: string,
  gitlabUrl: string,
  log?: vscode.OutputChannel
): Promise<MergeRequest[]> {
  const base = normalizeUrl(gitlabUrl);
  const headers = bearerHeaders(token);

  // Fetch current user info and assigned MRs in parallel
  log?.appendLine(`[GitLab] GET /api/v4/user + /api/v4/merge_requests?scope=assigned_to_me`);
  const [userResult, assignedResult] = await Promise.allSettled([
    httpRequest(`${base}/api/v4/user`, { headers }) as Promise<{ username: string }>,
    httpRequest(`${base}/api/v4/merge_requests?scope=assigned_to_me&state=opened&per_page=100`, { headers }) as Promise<GLMergeRequest[]>,
  ]);

  if (userResult.status === 'rejected') {
    log?.appendLine(`[GitLab] /api/v4/user FAILED: ${userResult.reason}`);
  } else {
    log?.appendLine(`[GitLab] Logged in as: ${userResult.value.username}`);
  }

  if (assignedResult.status === 'rejected') {
    log?.appendLine(`[GitLab] assigned_to_me FAILED: ${assignedResult.reason}`);
  } else {
    log?.appendLine(`[GitLab] assigned_to_me returned ${assignedResult.value.length} MR(s)`);
  }

  const assignedRaw: GLMergeRequest[] = assignedResult.status === 'fulfilled' ? assignedResult.value : [];

  // Only attempt reviewer-scoped fetch if we got the current username
  let reviewerRaw: GLMergeRequest[] = [];
  if (userResult.status === 'fulfilled' && userResult.value.username) {
    const username = userResult.value.username;
    log?.appendLine(`[GitLab] GET /api/v4/merge_requests?reviewer_username=${username}`);
    try {
      reviewerRaw = await httpRequest(
        `${base}/api/v4/merge_requests?reviewer_username=${encodeURIComponent(username)}&state=opened&per_page=100`,
        { headers }
      ) as GLMergeRequest[];
      log?.appendLine(`[GitLab] reviewer_username returned ${reviewerRaw.length} MR(s)`);
    } catch (err) {
      log?.appendLine(`[GitLab] reviewer_username FAILED: ${err}`);
    }
  }

  // Deduplicate by MR id (an MR could appear in both lists)
  const seen = new Set<number>();
  const combined: MergeRequest[] = [];
  for (const mr of [...assignedRaw, ...reviewerRaw]) {
    if (!seen.has(mr.id)) {
      seen.add(mr.id);
      combined.push(mapMR(mr, mr.project_id, gitlabUrl));
    }
  }
  log?.appendLine(`[GitLab] Total after dedup: ${combined.length} MR(s)`);
  return combined;
}

export async function getGitlabMergeRequests(
  projectId: string | number,
  token: string,
  gitlabUrl: string,
  includeAll = false
): Promise<MergeRequest[]> {
  const base = normalizeUrl(gitlabUrl);
  const state = includeAll ? '' : '&state=opened';
  const url = `${base}/api/v4/projects/${encodeURIComponent(String(projectId))}/merge_requests?per_page=50${state}`;
  const raw = await httpRequest(url, { headers: bearerHeaders(token) }) as GLMergeRequest[];

  return raw.map((mr) => mapMR(mr, projectId, gitlabUrl));
}

export async function getGitlabMRChanges(
  projectId: string | number,
  mrIid: number,
  token: string,
  gitlabUrl: string
): Promise<ChangedFile[]> {
  const base = normalizeUrl(gitlabUrl);
  const url = `${base}/api/v4/projects/${encodeURIComponent(String(projectId))}/merge_requests/${mrIid}/changes`;
  const data = await httpRequest(url, { headers: bearerHeaders(token) }) as GLChanges;

  return (data.changes ?? []).map((f) => {
    const { added, removed } = countDiffLines(f.diff);
    return {
      filename: f.new_path,
      oldFilename: f.renamed_file ? f.old_path : undefined,
      status: f.new_file
        ? 'added'
        : f.deleted_file
          ? 'deleted'
          : f.renamed_file
            ? 'renamed'
            : 'modified',
      additions: added,
      deletions: removed,
      patch: f.diff,
    };
  });
}

export async function mergeGitlabMR(
  projectId: string | number,
  mrIid: number,
  token: string,
  gitlabUrl: string
): Promise<void> {
  const base = normalizeUrl(gitlabUrl);
  const url = `${base}/api/v4/projects/${encodeURIComponent(String(projectId))}/merge_requests/${mrIid}/merge`;
  await httpRequest(url, {
    method: 'PUT',
    headers: bearerHeaders(token),
    body: JSON.stringify({ should_remove_source_branch: false }),
  });
}

export async function closeGitlabMR(
  projectId: string | number,
  mrIid: number,
  token: string,
  gitlabUrl: string
): Promise<void> {
  const base = normalizeUrl(gitlabUrl);
  const url = `${base}/api/v4/projects/${encodeURIComponent(String(projectId))}/merge_requests/${mrIid}`;
  await httpRequest(url, {
    method: 'PUT',
    headers: bearerHeaders(token),
    body: JSON.stringify({ state_event: 'close' }),
  });
}

export async function postGitlabMRNote(
  projectId: string | number,
  mrIid: number,
  body: string,
  token: string,
  gitlabUrl: string
): Promise<void> {
  const base = normalizeUrl(gitlabUrl);
  const url = `${base}/api/v4/projects/${encodeURIComponent(String(projectId))}/merge_requests/${mrIid}/notes`;
  await httpRequest(url, {
    method: 'POST',
    headers: bearerHeaders(token),
    body: JSON.stringify({ body }),
  });
}

export async function resolveGitlabProjectId(
  owner: string,
  repo: string,
  token: string,
  gitlabUrl: string
): Promise<string | number | undefined> {
  const base = normalizeUrl(gitlabUrl);
  const namespace = `${owner}/${repo}`;
  const url = `${base}/api/v4/projects/${encodeURIComponent(namespace)}`;
  try {
    const data = await httpRequest(url, { headers: bearerHeaders(token) }) as { id: number };
    return data.id;
  } catch {
    return undefined;
  }
}

// ─── helpers ──────────────────────────────────────────────────────────────────

function normalizeUrl(url: string): string {
  return url.replace(/\/+$/, '');
}

function mapMR(mr: GLMergeRequest, projectId: string | number, gitlabUrl: string): MergeRequest {
  // Extract owner/repo from project ID or url context – best effort
  const parts = mr.web_url.replace(/https?:\/\/[^/]+\//, '').split('/');
  const owner = parts[0] ?? '';
  const repo = parts[1] ?? '';

  return {
    id: mr.id,
    iid: mr.iid,
    number: mr.iid,
    title: mr.title,
    description: mr.description ?? '',
    author: mr.author.username,
    authorAvatarUrl: mr.author.avatar_url,
    sourceBranch: mr.source_branch,
    targetBranch: mr.target_branch,
    state: mr.state === 'opened' ? 'open' : mr.state === 'merged' ? 'merged' : 'closed',
    url: mr.web_url,
    createdAt: mr.created_at,
    updatedAt: mr.updated_at,
    provider: 'gitlab',
    repoOwner: owner,
    repoName: repo,
    repoFullName: `${owner}/${repo}`,
    labels: mr.labels ?? [],
    reviewers: mr.reviewers.map((r) => r.username),
    commentCount: mr.user_notes_count,
    additions: 0,
    deletions: 0,
    changedFilesCount: 0,
    isDraft: mr.draft ?? false,
    gitlabProjectId: projectId,
    gitlabUrl,
  } as MergeRequest & { gitlabUrl?: string };
}

function countDiffLines(diff: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const line of diff.split('\n')) {
    if (line.startsWith('+') && !line.startsWith('+++')) { added++; }
    else if (line.startsWith('-') && !line.startsWith('---')) { removed++; }
  }
  return { added, removed };
}
