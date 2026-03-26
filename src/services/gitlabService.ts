import { MergeRequest, ChangedFile } from '../models/types';
import { httpRequest, bearerHeaders } from '../utils/httpClient';

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
 * Fetch all open MRs assigned to the authenticated user across ALL projects.
 */
export async function getAssignedGitlabMRs(
  token: string,
  gitlabUrl: string
): Promise<MergeRequest[]> {
  const base = normalizeUrl(gitlabUrl);
  const url = `${base}/api/v4/merge_requests?scope=assigned_to_me&state=opened&per_page=100`;
  const raw = await httpRequest(url, { headers: bearerHeaders(token) }) as GLMergeRequest[];
  return raw.map((mr) => mapMR(mr, mr.project_id, gitlabUrl));
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
