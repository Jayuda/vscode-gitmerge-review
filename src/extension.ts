import * as vscode from 'vscode';
import { MergeRequestProvider, MergeRequestNode } from './providers/mergeRequestProvider';
import { MergeRequestPanel } from './panels/mergeRequestPanel';
import { MergeRequest } from './models/types';

export function activate(context: vscode.ExtensionContext): void {
  const provider = new MergeRequestProvider(context);

  // ─── TreeView ─────────────────────────────────────────────────────────────
  const treeView = vscode.window.createTreeView('mergeRequestExplorer', {
    treeDataProvider: provider,
    showCollapseAll: true,
  });
  context.subscriptions.push(treeView);

  // ─── Commands ─────────────────────────────────────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand('gitmerge.refresh', async () => {
      await provider.load();
    }),

    vscode.commands.registerCommand('gitmerge.openMR', (mr: MergeRequest) => {
      MergeRequestPanel.createOrShow(context, mr);
    }),

    vscode.commands.registerCommand('gitmerge.configure', () => {
      vscode.commands.executeCommand('workbench.action.openSettings', 'gitmerge');
    }),

    vscode.commands.registerCommand('gitmerge.setGithubToken', async () => {
      const token = await vscode.window.showInputBox({
        prompt: 'Enter your GitHub Personal Access Token (needs "repo" scope)',
        placeHolder: 'ghp_xxxxxxxxxxxx',
        password: true,
        ignoreFocusOut: true,
        validateInput: (v) => v.trim().length === 0 ? 'Token cannot be empty' : undefined,
      });
      if (token) {
        await context.secrets.store('gitmerge.githubToken', token.trim());
        vscode.window.showInformationMessage('GitHub token saved. Loading assigned PRs...');
        await provider.load();
      }
    }),

    vscode.commands.registerCommand('gitmerge.setGitlabToken', async () => {
      const token = await vscode.window.showInputBox({
        prompt: 'Enter your GitLab Personal Access Token (needs "api" scope)',
        placeHolder: 'glpat-xxxxxxxxxxxx',
        password: true,
        ignoreFocusOut: true,
        validateInput: (v) => v.trim().length === 0 ? 'Token cannot be empty' : undefined,
      });
      if (token) {
        await context.secrets.store('gitmerge.gitlabToken', token.trim());
        vscode.window.showInformationMessage('GitLab token saved. Loading assigned MRs...');
        await provider.load();
      }
    })
  );

  // ─── On tree-item click, open the MR panel ───────────────────────────────
  treeView.onDidChangeSelection((e) => {
    const [selected] = e.selection;
    if (selected instanceof MergeRequestNode) {
      MergeRequestPanel.createOrShow(context, selected.mr);
    }
  }, null, context.subscriptions);

  // ─── Auto-refresh ─────────────────────────────────────────────────────────
  setupAutoRefresh(context, provider);

  // ─── Initial load ─────────────────────────────────────────────────────────
  provider.load().then(() => {
    promptForTokensIfNeeded(context);
  });
}

function setupAutoRefresh(context: vscode.ExtensionContext, provider: MergeRequestProvider): void {
  let timer: NodeJS.Timeout | undefined;

  function scheduleRefresh() {
    if (timer) { clearInterval(timer); }
    const config = vscode.workspace.getConfiguration('gitmerge');
    const enabled: boolean = config.get('autoRefresh') ?? true;
    const minutes: number = Math.max(1, config.get('refreshInterval') ?? 5);
    if (enabled) {
      timer = setInterval(() => provider.load(), minutes * 60 * 1000);
    }
  }

  scheduleRefresh();

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('gitmerge.autoRefresh') ||
          e.affectsConfiguration('gitmerge.refreshInterval')) {
        scheduleRefresh();
      }
    }),
    { dispose: () => { if (timer) { clearInterval(timer); } } }
  );
}

async function promptForTokensIfNeeded(context: vscode.ExtensionContext): Promise<void> {
  const hasGithub = !!(await context.secrets.get('gitmerge.githubToken'));
  const hasGitlab = !!(await context.secrets.get('gitmerge.gitlabToken'));

  if (!hasGithub && !hasGitlab) {
    const choice = await vscode.window.showInformationMessage(
      'GitMerge Review: Add a GitHub or GitLab token to see merge requests assigned to you.',
      'Set GitHub Token',
      'Set GitLab Token',
      'Later'
    );
    if (choice === 'Set GitHub Token') {
      vscode.commands.executeCommand('gitmerge.setGithubToken');
    } else if (choice === 'Set GitLab Token') {
      vscode.commands.executeCommand('gitmerge.setGitlabToken');
    }
  }
}

export function deactivate(): void {
  // Cleanup handled by disposables
}

