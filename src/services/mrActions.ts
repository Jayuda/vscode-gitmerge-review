import * as vscode from 'vscode';
import { MergeRequest } from '../models/types';
import { mergeGithubPR, closeGithubPR } from './githubService';
import { mergeGitlabMR, closeGitlabMR } from './gitlabService';

function resolveGitlabProjectId(mr: MergeRequest): string | number {
  return (mr as MergeRequest & { gitlabProjectId?: string | number }).gitlabProjectId
    ?? `${mr.repoOwner}/${mr.repoName}`;
}

export async function mergeMergeRequest(
  context: vscode.ExtensionContext,
  mr: MergeRequest,
  commitMessage?: string
): Promise<void> {
  const config = vscode.workspace.getConfiguration('gitmerge');
  if (mr.provider === 'github') {
    const token = await context.secrets.get('gitmerge.githubToken');
    if (!token) { throw new Error('GitHub token not configured.'); }
    await mergeGithubPR(mr.repoOwner, mr.repoName, mr.number, token, commitMessage);
  } else {
    const token = await context.secrets.get('gitmerge.gitlabToken');
    if (!token) { throw new Error('GitLab token not configured.'); }
    const gitlabUrl: string = config.get('gitlabUrl') ?? 'https://gitlab.com';
    await mergeGitlabMR(resolveGitlabProjectId(mr), mr.iid, token, gitlabUrl);
  }
}

export async function closeMergeRequest(
  context: vscode.ExtensionContext,
  mr: MergeRequest
): Promise<void> {
  const config = vscode.workspace.getConfiguration('gitmerge');
  if (mr.provider === 'github') {
    const token = await context.secrets.get('gitmerge.githubToken');
    if (!token) { throw new Error('GitHub token not configured.'); }
    await closeGithubPR(mr.repoOwner, mr.repoName, mr.number, token);
  } else {
    const token = await context.secrets.get('gitmerge.gitlabToken');
    if (!token) { throw new Error('GitLab token not configured.'); }
    const gitlabUrl: string = config.get('gitlabUrl') ?? 'https://gitlab.com';
    await closeGitlabMR(resolveGitlabProjectId(mr), mr.iid, token, gitlabUrl);
  }
}
