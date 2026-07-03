import * as vscode from 'vscode';
import { MergeRequestProvider, MergeRequestNode, outputChannel } from './providers/mergeRequestProvider';
import { MergeRequestPanel } from './panels/mergeRequestPanel';
import { MergeRequest } from './models/types';
import { mergeMergeRequest, closeMergeRequest } from './services/mrActions';

export function activate(context: vscode.ExtensionContext): void {
  const ext = vscode.extensions.getExtension('gitmerge.gitmerge-review');
  const version = ext?.packageJSON?.version ?? context.extension?.packageJSON?.version ?? 'unknown';
  outputChannel.appendLine(`[GitMerge] Extension activated — v${version}`);

  const provider = new MergeRequestProvider(context);

  // ─── TreeView ─────────────────────────────────────────────────────────────
  const treeView = vscode.window.createTreeView('mergeRequestExplorer', {
    treeDataProvider: provider,
    showCollapseAll: true,
    canSelectMany: true,
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

    vscode.commands.registerCommand(
      'gitmerge.mergeSelected',
      (node: MergeRequestNode, selected?: MergeRequestNode[]) =>
        runBulkAction(context, provider, node, selected, {
          confirmVerb: 'Merge',
          progressLabel: 'Merging',
          pastLabel: 'Merged',
          run: (mr) => mergeMergeRequest(context, mr),
        })
    ),

    vscode.commands.registerCommand(
      'gitmerge.closeSelected',
      (node: MergeRequestNode, selected?: MergeRequestNode[]) =>
        runBulkAction(context, provider, node, selected, {
          confirmVerb: 'Close/Reject',
          progressLabel: 'Closing',
          pastLabel: 'Closed',
          run: (mr) => closeMergeRequest(context, mr),
        })
    ),

    vscode.commands.registerCommand('gitmerge.configure', () => {
      vscode.commands.executeCommand('workbench.action.openSettings', 'gitmerge');
    }),

    vscode.commands.registerCommand('gitmerge.showLog', () => {
      outputChannel.show();
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

  // ─── Auto-refresh ─────────────────────────────────────────────────────────
  setupAutoRefresh(context, provider);

  // ─── Initial load ─────────────────────────────────────────────────────────
  provider.load().then(() => {
    promptForTokensIfNeeded(context);
  });
}

interface BulkActionOptions {
  confirmVerb: string; // e.g. 'Merge', 'Close/Reject' — used in the confirmation modal
  progressLabel: string; // e.g. 'Merging', 'Closing' — used in the progress notification title
  pastLabel: string; // e.g. 'Merged', 'Closed' — used in the summary message
  run: (mr: MergeRequest) => Promise<void>;
}

async function runBulkAction(
  context: vscode.ExtensionContext,
  provider: MergeRequestProvider,
  node: MergeRequestNode,
  selected: MergeRequestNode[] | undefined,
  options: BulkActionOptions
): Promise<void> {
  const nodes = (selected && selected.length > 0 ? selected : [node])
    .filter((n): n is MergeRequestNode => n instanceof MergeRequestNode);

  // De-dupe by MR id in case the same node appears more than once in the selection.
  const seen = new Set<number>();
  const mrs = nodes
    .map((n) => n.mr)
    .filter((mr) => {
      if (seen.has(mr.id)) { return false; }
      seen.add(mr.id);
      return true;
    });

  if (mrs.length === 0) { return; }

  const confirmMessage = mrs.length === 1
    ? `${options.confirmVerb} "${mrs[0].title}"?`
    : `${options.confirmVerb} ${mrs.length} merge requests?`;
  const confirm = await vscode.window.showWarningMessage(
    confirmMessage,
    { modal: true },
    options.confirmVerb
  );
  if (confirm !== options.confirmVerb) { return; }

  const failures: { mr: MergeRequest; error: string }[] = [];
  let succeeded = 0;

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `${options.progressLabel} ${mrs.length} merge request${mrs.length === 1 ? '' : 's'}...`,
      cancellable: true,
    },
    async (progress, token) => {
      for (let i = 0; i < mrs.length; i++) {
        if (token.isCancellationRequested) { break; }
        const mr = mrs[i];
        progress.report({ message: mr.title, increment: 100 / mrs.length });
        try {
          await options.run(mr);
          succeeded++;
        } catch (err) {
          const message = String(err);
          failures.push({ mr, error: message });
          outputChannel.appendLine(`[GitMerge] ${options.confirmVerb} failed for "${mr.title}": ${message}`);
        }
      }
    }
  );

  if (failures.length === 0) {
    vscode.window.showInformationMessage(`${options.pastLabel} ${succeeded}/${mrs.length} merge requests.`);
  } else {
    const detail = failures.map((f) => `${f.mr.title}: ${f.error}`).join('; ');
    vscode.window.showErrorMessage(
      `${options.pastLabel} ${succeeded}/${mrs.length} — ${failures.length} failed. ${detail}`
    );
  }

  await provider.load();
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

