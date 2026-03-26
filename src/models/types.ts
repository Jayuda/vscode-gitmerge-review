export type Provider = 'github' | 'gitlab';

export type MRState = 'open' | 'merged' | 'closed';

export interface Repository {
  provider: Provider;
  owner: string;
  name: string;
  fullName: string;
  remoteUrl: string;
  gitlabProjectId?: string | number;
}

export interface MergeRequest {
  id: number;
  iid: number; // internal id used by GitLab; equals number for GitHub PRs
  number: number; // PR/MR number used in API calls
  title: string;
  description: string;
  author: string;
  authorAvatarUrl?: string;
  sourceBranch: string;
  targetBranch: string;
  state: MRState;
  url: string;
  createdAt: string;
  updatedAt: string;
  provider: Provider;
  repoOwner: string;
  repoName: string;
  repoFullName: string;
  labels: string[];
  reviewers: string[];
  commentCount: number;
  additions: number;
  deletions: number;
  changedFilesCount: number;
  isDraft: boolean;
  gitlabProjectId?: string | number;
  changedFiles?: ChangedFile[];
}

export interface ChangedFile {
  filename: string;
  oldFilename?: string; // for renames
  status: 'added' | 'modified' | 'deleted' | 'renamed' | 'copied' | 'unchanged';
  additions: number;
  deletions: number;
  patch?: string; // unified diff patch string
  blobUrl?: string;
}

export interface DiffRow {
  type: 'hunk' | 'change' | 'context';
  hunkHeader?: string;
  leftLineNum?: number;
  leftContent?: string;
  leftType?: 'remove' | 'empty' | 'context';
  rightLineNum?: number;
  rightContent?: string;
  rightType?: 'add' | 'empty' | 'context';
}

export interface AIAnalysisResult {
  summary: string;
  issues: string[];
  quality: string;
  security: string;
  recommendation: 'APPROVE' | 'REQUEST_CHANGES' | 'NEUTRAL';
  raw: string;
}
