import * as vscode from 'vscode';
import { MergeRequest, Provider } from '../models/types';
import { getAssignedGithubPRs } from '../services/githubService';
import { getAssignedGitlabMRs } from '../services/gitlabService';

// ─── TreeItem types ───────────────────────────────────────────────────────────

export class ProviderNode extends vscode.TreeItem {
  constructor(
    public readonly provider: Provider,
    public readonly hasToken: boolean,
    public readonly loading: boolean,
    public readonly mrCount: number
  ) {
    const label = provider === 'github' ? 'GitHub' : 'GitLab';
    const expandable = hasToken && !loading && mrCount > 0;
    super(
      label,
      expandable
        ? vscode.TreeItemCollapsibleState.Expanded
        : vscode.TreeItemCollapsibleState.Collapsed
    );
    this.contextValue = `provider-${provider}`;
    this.iconPath = new vscode.ThemeIcon(
      provider === 'github' ? 'github' : 'git-branch'
    );
    if (loading) {
      this.description = 'Loading...';
    } else if (!hasToken) {
      this.description = 'Token not configured — click to set';
      this.command = {
        command: provider === 'github' ? 'gitmerge.setGithubToken' : 'gitmerge.setGitlabToken',
        title: `Set ${label} Token`,
      };
    } else {
      this.description = mrCount === 0 ? 'No assigned MRs' : `${mrCount} assigned`;
    }
  }
}

export class RepoGroupNode extends vscode.TreeItem {
  constructor(
    public readonly repoFullName: string,
    public readonly provider: Provider,
    public readonly mrs: MergeRequest[]
  ) {
    super(repoFullName, vscode.TreeItemCollapsibleState.Expanded);
    this.contextValue = 'repoGroup';
    this.iconPath = new vscode.ThemeIcon('repo');
    this.description = mrs.length === 1 ? '1 open' : `${mrs.length} open`;
    this.tooltip = repoFullName;
  }
}

// Kept for backwards compat with panel commands
export class RepoNode extends vscode.TreeItem {
  constructor(public readonly repoName: string) {
    super(repoName, vscode.TreeItemCollapsibleState.None);
    this.contextValue = 'repo';
  }
}

export class MergeRequestNode extends vscode.TreeItem {
  constructor(public readonly mr: MergeRequest) {
    super(mr.title, vscode.TreeItemCollapsibleState.None);
    this.contextValue = 'mergeRequest';
    const num = mr.provider === 'gitlab' ? `!${mr.number}` : `#${mr.number}`;
    this.description = num;
    this.tooltip = new vscode.MarkdownString(
      `**${mr.title}**\n\n` +
      `By **${mr.author}** · ${formatDate(mr.updatedAt)}\n\n` +
      (mr.sourceBranch ? `\`${mr.sourceBranch}\` → \`${mr.targetBranch}\`\n\n` : '') +
      `${mr.repoFullName}`
    );
    this.iconPath = new vscode.ThemeIcon(
      mr.isDraft ? 'git-pull-request-draft' : 'git-pull-request',
      new vscode.ThemeColor(mr.isDraft ? 'charts.gray' : 'charts.green')
    );
    this.command = {
      command: 'gitmerge.openMR',
      title: 'Open Merge Request',
      arguments: [mr],
    };
  }
}

export class StatusNode extends vscode.TreeItem {
  constructor(label: string, icon = 'info', command?: vscode.Command) {
    super(label, vscode.TreeItemCollapsibleState.None);
    this.iconPath = new vscode.ThemeIcon(icon);
    this.contextValue = 'status';
    if (command) { this.command = command; }
  }
}

// MessageNode alias kept for compatibility
export class MessageNode extends StatusNode {}

type TreeNode = ProviderNode | RepoGroupNode | RepoNode | MergeRequestNode | StatusNode;

// ─── Data Provider ────────────────────────────────────────────────────────────

export class MergeRequestProvider implements vscode.TreeDataProvider<TreeNode> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<TreeNode | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private githubMRs: MergeRequest[] = [];
  private gitlabMRs: MergeRequest[] = [];
  private githubLoading = false;
  private gitlabLoading = false;
  private githubHasToken = false;
  private gitlabHasToken = false;

  constructor(private readonly context: vscode.ExtensionContext) {}

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  async load(): Promise<void> {
    this.githubHasToken = !!(await this.context.secrets.get('gitmerge.githubToken'));
    this.gitlabHasToken = !!(await this.context.secrets.get('gitmerge.gitlabToken'));

    this.githubLoading = this.githubHasToken;
    this.gitlabLoading = this.gitlabHasToken;
    this._onDidChangeTreeData.fire();

    await Promise.allSettled([
      this._loadGithub(),
      this._loadGitlab(),
    ]);
  }

  private async _loadGithub(): Promise<void> {
    if (!this.githubHasToken) { return; }
    try {
      const token = await this.context.secrets.get('gitmerge.githubToken') as string;
      this.githubMRs = await getAssignedGithubPRs(token);
    } catch (err) {
      vscode.window.showErrorMessage(`GitMerge GitHub: ${String(err)}`);
      this.githubMRs = [];
    } finally {
      this.githubLoading = false;
      this._onDidChangeTreeData.fire();
    }
  }

  private async _loadGitlab(): Promise<void> {
    if (!this.gitlabHasToken) { return; }
    try {
      const token = await this.context.secrets.get('gitmerge.gitlabToken') as string;
      const config = vscode.workspace.getConfiguration('gitmerge');
      const gitlabUrl: string = config.get('gitlabUrl') ?? 'https://gitlab.com';
      this.gitlabMRs = await getAssignedGitlabMRs(token, gitlabUrl);
    } catch (err) {
      vscode.window.showErrorMessage(`GitMerge GitLab: ${String(err)}`);
      this.gitlabMRs = [];
    } finally {
      this.gitlabLoading = false;
      this._onDidChangeTreeData.fire();
    }
  }

  getTreeItem(element: TreeNode): vscode.TreeItem {
    return element;
  }

  getChildren(element?: TreeNode): TreeNode[] {
    // ── Root ─────────────────────────────────────────────────────────────
    if (!element) {
      if (!this.githubHasToken && !this.gitlabHasToken) {
        return [
          new StatusNode('Set GitHub Token', 'github',
            { command: 'gitmerge.setGithubToken', title: 'Set GitHub Token' }),
          new StatusNode('Set GitLab Token', 'git-branch',
            { command: 'gitmerge.setGitlabToken', title: 'Set GitLab Token' }),
        ];
      }
      const nodes: TreeNode[] = [];
      nodes.push(new ProviderNode('github', this.githubHasToken, this.githubLoading, this.githubMRs.length));
      nodes.push(new ProviderNode('gitlab', this.gitlabHasToken, this.gitlabLoading, this.gitlabMRs.length));
      return nodes;
    }

    // ── Under provider ────────────────────────────────────────────────────
    if (element instanceof ProviderNode) {
      if (!element.hasToken) { return []; }
      if (element.loading) {
        return [new StatusNode('Loading...', 'loading~spin')];
      }
      const mrs = element.provider === 'github' ? this.githubMRs : this.gitlabMRs;
      if (mrs.length === 0) {
        return [new StatusNode('No assigned merge requests', 'check')];
      }
      // Group by repo
      const repoMap = new Map<string, MergeRequest[]>();
      for (const mr of mrs) {
        if (!repoMap.has(mr.repoFullName)) { repoMap.set(mr.repoFullName, []); }
        repoMap.get(mr.repoFullName)!.push(mr);
      }
      return Array.from(repoMap.entries()).map(
        ([name, list]) => new RepoGroupNode(name, element.provider, list)
      );
    }

    // ── Under repo group ─────────────────────────────────────────────────
    if (element instanceof RepoGroupNode) {
      return element.mrs.map((mr) => new MergeRequestNode(mr));
    }

    return [];
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function formatDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

