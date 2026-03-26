import * as vscode from 'vscode';
import * as path from 'path';
import { MergeRequest, ChangedFile } from '../models/types';
import { getGithubPRFiles, getGithubPRDetails, mergeGithubPR, closeGithubPR } from '../services/githubService';
import { getGitlabMRChanges, mergeGitlabMR, closeGitlabMR } from '../services/gitlabService';
import { analyzeChanges } from '../services/aiService';

export class MergeRequestPanel {
  public static currentPanel: MergeRequestPanel | undefined;
  private static readonly viewType = 'gitmergeReview';

  private readonly _panel: vscode.WebviewPanel;
  private readonly _context: vscode.ExtensionContext;
  private _mr: MergeRequest;
  private _files: ChangedFile[] = [];
  private _disposables: vscode.Disposable[] = [];
  private _cancelSource?: vscode.CancellationTokenSource;

  public static createOrShow(context: vscode.ExtensionContext, mr: MergeRequest): void {
    const column = vscode.ViewColumn.One;

    if (MergeRequestPanel.currentPanel) {
      MergeRequestPanel.currentPanel._panel.reveal(column);
      MergeRequestPanel.currentPanel._update(mr);
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      MergeRequestPanel.viewType,
      `MR: ${mr.title}`,
      column,
      {
        enableScripts: true,
        localResourceRoots: [
          vscode.Uri.file(path.join(context.extensionPath, 'resources')),
        ],
        retainContextWhenHidden: true,
      }
    );

    MergeRequestPanel.currentPanel = new MergeRequestPanel(panel, context, mr);
  }

  private constructor(
    panel: vscode.WebviewPanel,
    context: vscode.ExtensionContext,
    mr: MergeRequest
  ) {
    this._panel = panel;
    this._context = context;
    this._mr = mr;

    this._panel.onDidDispose(() => this.dispose(), null, this._disposables);
    this._panel.webview.onDidReceiveMessage(
      (msg) => this._handleMessage(msg),
      null,
      this._disposables
    );

    this._update(mr);
  }

  private async _update(mr: MergeRequest): Promise<void> {
    this._mr = mr;
    this._panel.title = `MR: ${mr.title.slice(0, 50)}`;
    this._panel.webview.html = this._getLoadingHtml();

    try {
      this._files = await this._fetchFiles(mr);
      // Enrich aggregate stats for GitLab (not provided by list endpoint)
      if (mr.provider === 'gitlab') {
        mr.additions = this._files.reduce((s, f) => s + f.additions, 0);
        mr.deletions = this._files.reduce((s, f) => s + f.deletions, 0);
        mr.changedFilesCount = this._files.length;
      }
    } catch (err) {
      this._panel.webview.html = this._getErrorHtml(String(err));
      return;
    }

    this._panel.webview.html = this._getWebviewContent();
    // Send data to webview once DOM is ready
    this._panel.webview.postMessage({ type: 'init', mr: this._mr, files: this._files });
  }

  private async _fetchFiles(mr: MergeRequest): Promise<ChangedFile[]> {
    const config = vscode.workspace.getConfiguration('gitmerge');
    if (mr.provider === 'github') {
      const token = await this._context.secrets.get('gitmerge.githubToken');
      if (!token) { throw new Error('GitHub token not configured. Run "GitMerge: Set GitHub Token".'); }

      // Fetch full PR details and files in parallel; enrich mr with branch info
      const [details, files] = await Promise.all([
        getGithubPRDetails(mr.repoOwner, mr.repoName, mr.number, token),
        getGithubPRFiles(mr.repoOwner, mr.repoName, mr.number, token),
      ]);
      Object.assign(mr, details);
      return files;
    } else {
      const token = await this._context.secrets.get('gitmerge.gitlabToken');
      if (!token) { throw new Error('GitLab token not configured. Run "GitMerge: Set GitLab Token".'); }
      const gitlabUrl: string = config.get('gitlabUrl') ?? 'https://gitlab.com';
      const projectId = (mr as MergeRequest & { gitlabProjectId?: string | number }).gitlabProjectId ?? `${mr.repoOwner}/${mr.repoName}`;
      return getGitlabMRChanges(projectId, mr.iid, token, gitlabUrl);
    }
  }

  private async _handleMessage(message: { type: string; [key: string]: unknown }): Promise<void> {
    switch (message.type) {
      case 'analyze':
        await this._runAIAnalysis();
        break;
      case 'cancelAnalysis':
        this._cancelSource?.cancel();
        break;
      case 'merge':
        await this._mergeMR(message.commitMessage as string | undefined);
        break;
      case 'reject':
        await this._rejectMR();
        break;
      case 'openUrl':
        vscode.env.openExternal(vscode.Uri.parse(this._mr.url));
        break;
    }
  }

  private async _runAIAnalysis(): Promise<void> {
    this._cancelSource?.cancel();
    this._cancelSource = new vscode.CancellationTokenSource();
    const token = this._cancelSource.token;

    this._panel.webview.postMessage({ type: 'analysisStart' });

    try {
      await analyzeChanges(
        this._mr,
        this._files,
        (chunk) => {
          this._panel.webview.postMessage({ type: 'analysisChunk', chunk });
        },
        () => {
          this._panel.webview.postMessage({ type: 'analysisDone' });
        },
        token
      );
    } catch (err) {
      this._panel.webview.postMessage({ type: 'analysisError', error: String(err) });
    }
  }

  private async _mergeMR(commitMessage?: string): Promise<void> {
    const confirm = await vscode.window.showWarningMessage(
      `Merge "${this._mr.title}"?`,
      { modal: true },
      'Merge'
    );
    if (confirm !== 'Merge') { return; }

    this._panel.webview.postMessage({ type: 'actionStart', action: 'merge' });

    try {
      const config = vscode.workspace.getConfiguration('gitmerge');
      if (this._mr.provider === 'github') {
        const token = await this._context.secrets.get('gitmerge.githubToken');
        if (!token) { throw new Error('GitHub token not configured.'); }
        await mergeGithubPR(this._mr.repoOwner, this._mr.repoName, this._mr.number, token, commitMessage);
      } else {
        const token = await this._context.secrets.get('gitmerge.gitlabToken');
        if (!token) { throw new Error('GitLab token not configured.'); }
        const gitlabUrl: string = config.get('gitlabUrl') ?? 'https://gitlab.com';
        const projectId = (this._mr as MergeRequest & { gitlabProjectId?: string | number }).gitlabProjectId ?? `${this._mr.repoOwner}/${this._mr.repoName}`;
        await mergeGitlabMR(projectId, this._mr.iid, token, gitlabUrl);
      }
      this._panel.webview.postMessage({ type: 'actionDone', action: 'merge', success: true });
      vscode.window.showInformationMessage(`Merged: ${this._mr.title}`);
    } catch (err) {
      this._panel.webview.postMessage({ type: 'actionDone', action: 'merge', success: false, error: String(err) });
      vscode.window.showErrorMessage(`Merge failed: ${String(err)}`);
    }
  }

  private async _rejectMR(): Promise<void> {
    const confirm = await vscode.window.showWarningMessage(
      `Close/Reject "${this._mr.title}"?`,
      { modal: true },
      'Close MR'
    );
    if (confirm !== 'Close MR') { return; }

    this._panel.webview.postMessage({ type: 'actionStart', action: 'reject' });

    try {
      const config = vscode.workspace.getConfiguration('gitmerge');
      if (this._mr.provider === 'github') {
        const token = await this._context.secrets.get('gitmerge.githubToken');
        if (!token) { throw new Error('GitHub token not configured.'); }
        await closeGithubPR(this._mr.repoOwner, this._mr.repoName, this._mr.number, token);
      } else {
        const token = await this._context.secrets.get('gitmerge.gitlabToken');
        if (!token) { throw new Error('GitLab token not configured.'); }
        const gitlabUrl: string = config.get('gitlabUrl') ?? 'https://gitlab.com';
        const projectId = (this._mr as MergeRequest & { gitlabProjectId?: string | number }).gitlabProjectId ?? `${this._mr.repoOwner}/${this._mr.repoName}`;
        await closeGitlabMR(projectId, this._mr.iid, token, gitlabUrl);
      }
      this._panel.webview.postMessage({ type: 'actionDone', action: 'reject', success: true });
      vscode.window.showInformationMessage(`Closed: ${this._mr.title}`);
    } catch (err) {
      this._panel.webview.postMessage({ type: 'actionDone', action: 'reject', success: false, error: String(err) });
      vscode.window.showErrorMessage(`Close failed: ${String(err)}`);
    }
  }

  dispose(): void {
    this._cancelSource?.cancel();
    MergeRequestPanel.currentPanel = undefined;
    this._panel.dispose();
    for (const d of this._disposables) { d.dispose(); }
    this._disposables = [];
  }

  // ─── HTML generation ─────────────────────────────────────────────────────

  private _getLoadingHtml(): string {
    return `<!DOCTYPE html><html><body style="display:flex;align-items:center;justify-content:center;height:100vh;font-family:var(--vscode-font-family);color:var(--vscode-foreground);background:var(--vscode-editor-background)"><div>Loading merge request data...</div></body></html>`;
  }

  private _getErrorHtml(error: string): string {
    return `<!DOCTYPE html><html><body style="padding:24px;font-family:var(--vscode-font-family);color:var(--vscode-foreground);background:var(--vscode-editor-background)"><h2>Error loading merge request</h2><p style="color:#f85149">${error}</p></body></html>`;
  }

  private _getWebviewContent(): string {
    const nonce = getNonce();
    const webview = this._panel.webview;

    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline' ${webview.cspSource}; script-src 'nonce-${nonce}';">
  <title>Merge Request Review</title>
  <style>
    *,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
    :root{--radius:4px;--gap:8px}
    body{font-family:var(--vscode-font-family);font-size:var(--vscode-font-size,13px);color:var(--vscode-foreground);background:var(--vscode-editor-background);height:100vh;display:flex;flex-direction:column;overflow:hidden}
    /* ── Header ── */
    #header{padding:12px 16px;background:var(--vscode-sideBar-background);border-bottom:1px solid var(--vscode-panel-border);flex-shrink:0}
    #mr-title{font-size:15px;font-weight:700;margin-bottom:6px;display:flex;align-items:center;gap:8px;flex-wrap:wrap}
    .badge{padding:2px 8px;border-radius:10px;font-size:11px;font-weight:600}
    .badge-open{background:#238636;color:#fff}
    .badge-merged{background:#8957e5;color:#fff}
    .badge-closed{background:#da3633;color:#fff}
    .badge-draft{background:#6e7681;color:#fff}
    .badge-github{background:#161b22;color:#fff;border:1px solid #30363d}
    .badge-gitlab{background:#fc6d26;color:#fff}
    #mr-meta{display:flex;align-items:center;gap:16px;font-size:12px;color:var(--vscode-descriptionForeground);flex-wrap:wrap}
    .branch-arrow{color:var(--vscode-foreground);font-weight:bold;margin:0 4px}
    .meta-icon{margin-right:3px}
    .stat-add{color:#3fb950}
    .stat-del{color:#f85149}
    /* ── Body layout ── */
    #body{flex:1;display:flex;overflow:hidden;min-height:0}
    /* ── File sidebar ── */
    #file-sidebar{width:240px;flex-shrink:0;background:var(--vscode-sideBar-background);border-right:1px solid var(--vscode-panel-border);display:flex;flex-direction:column;overflow:hidden}
    #sidebar-header{padding:8px 12px;font-size:11px;font-weight:700;text-transform:uppercase;color:var(--vscode-descriptionForeground);border-bottom:1px solid var(--vscode-panel-border);letter-spacing:.05em}
    #file-list{flex:1;overflow-y:auto}
    .file-item{padding:5px 10px;cursor:pointer;display:flex;align-items:center;gap:6px;font-size:12px;border-left:2px solid transparent;user-select:none}
    .file-item:hover{background:var(--vscode-list-hoverBackground)}
    .file-item.active{background:var(--vscode-list-activeSelectionBackground);color:var(--vscode-list-activeSelectionForeground);border-left-color:var(--vscode-focusBorder)}
    .file-item .fname{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;direction:rtl;text-align:left}
    .fstatus{font-size:10px;font-weight:700;padding:1px 4px;border-radius:3px;flex-shrink:0}
    .fs-added{background:#238636;color:#fff}
    .fs-modified{background:#9e6a03;color:#fff}
    .fs-deleted{background:#da3633;color:#fff}
    .fs-renamed{background:#8957e5;color:#fff}
    .fstats{font-size:10px;flex-shrink:0;color:var(--vscode-descriptionForeground)}
    /* ── Diff area ── */
    #diff-area{flex:1;display:flex;flex-direction:column;overflow:hidden;min-width:0}
    #diff-file-header{padding:8px 14px;background:var(--vscode-editorGroupHeader-tabsBackground,var(--vscode-sideBar-background));border-bottom:1px solid var(--vscode-panel-border);font-size:12px;font-family:var(--vscode-editor-font-family,monospace);display:flex;align-items:center;gap:8px;flex-shrink:0;min-height:35px}
    #diff-file-header span{color:var(--vscode-descriptionForeground)}
    #diff-scroll{flex:1;overflow:auto}
    /* ── Diff table ── */
    .diff-table{width:100%;border-collapse:collapse;font-family:var(--vscode-editor-font-family,'Menlo','Consolas',monospace);font-size:var(--vscode-editor-font-size,12px);table-layout:fixed}
    .diff-table col.ln{width:48px}
    .diff-table col.code{width:calc(50% - 48px)}
    .diff-divider{width:1px;background:var(--vscode-panel-border);padding:0!important}
    .diff-table td{padding:0 6px;white-space:pre;line-height:20px;height:20px;overflow:hidden;text-overflow:ellipsis;vertical-align:top}
    .ln{text-align:right;padding-right:10px!important;color:var(--vscode-editorLineNumber-foreground);user-select:none;font-size:11px;border-right:1px solid var(--vscode-editorLineNumber-activeForeground,#444)}
    .code{padding-left:10px!important}
    .row-add{background:rgba(40,167,69,.13)}
    .row-add .code{background:rgba(40,167,69,.13)}
    .row-del{background:rgba(218,54,51,.13)}
    .row-del .code{background:rgba(218,54,51,.13)}
    .row-empty{background:rgba(100,100,100,.05)}
    .row-hunk td{background:var(--vscode-diffEditor-diagonalFill,rgba(128,128,128,.1))!important;color:var(--vscode-descriptionForeground);font-style:italic;padding:3px 10px!important;height:auto!important}
    .diff-table .ln-add{color:var(--vscode-diffEditorInserted-foreground,#3fb950)}
    .diff-table .ln-del{color:var(--vscode-diffEditorRemoved-foreground,#f85149)}
    /* ── AI panel ── */
    #ai-panel{width:310px;flex-shrink:0;background:var(--vscode-sideBar-background);border-left:1px solid var(--vscode-panel-border);display:flex;flex-direction:column;overflow:hidden}
    #ai-panel-header{padding:10px 14px;font-weight:700;border-bottom:1px solid var(--vscode-panel-border);display:flex;align-items:center;justify-content:space-between;flex-shrink:0}
    #ai-panel-title{display:flex;align-items:center;gap:6px;font-size:13px}
    #btn-analyze{background:var(--vscode-button-background);color:var(--vscode-button-foreground);border:none;padding:5px 12px;border-radius:var(--radius);cursor:pointer;font-size:12px;display:flex;align-items:center;gap:5px;white-space:nowrap}
    #btn-analyze:hover:not(:disabled){background:var(--vscode-button-hoverBackground)}
    #btn-analyze:disabled{opacity:.55;cursor:not-allowed}
    #btn-cancel{background:transparent;color:var(--vscode-descriptionForeground);border:1px solid var(--vscode-panel-border);padding:5px 10px;border-radius:var(--radius);cursor:pointer;font-size:11px;display:none}
    #btn-cancel:hover{background:var(--vscode-list-hoverBackground)}
    #ai-body{flex:1;overflow-y:auto;padding:14px}
    #ai-placeholder{display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;gap:10px;color:var(--vscode-descriptionForeground);text-align:center;padding:16px}
    #ai-placeholder svg{opacity:.4}
    #ai-content{display:none;font-size:12.5px;line-height:1.7}
    #ai-streaming{display:none;font-size:12.5px;line-height:1.7;white-space:pre-wrap;word-break:break-word}
    .ai-content h1,.ai-content h2,.ai-content h3{margin:10px 0 5px;font-size:13px;font-weight:700}
    .ai-content p{margin-bottom:8px}
    .ai-content ul,.ai-content ol{padding-left:16px;margin-bottom:8px}
    .ai-content li{margin-bottom:3px}
    .ai-content code{background:var(--vscode-textCodeBlock-background);padding:1px 4px;border-radius:3px;font-family:var(--vscode-editor-font-family,monospace);font-size:.9em}
    .ai-content pre{background:var(--vscode-textCodeBlock-background);padding:8px;border-radius:4px;overflow-x:auto;margin-bottom:8px}
    .ai-content pre code{background:none;padding:0}
    .recommend-box{margin:12px 0;padding:10px 12px;border-radius:6px;font-weight:600;display:flex;align-items:center;gap:8px;font-size:13px}
    .rec-approve{background:rgba(40,167,69,.12);border:1px solid #238636;color:#3fb950}
    .rec-suggest{background:rgba(255,193,7,.12);border:1px solid #e3b341;color:#e3b341}
    .rec-changes{background:rgba(218,54,51,.12);border:1px solid #da3633;color:#f85149}
    /* ── Spinner ── */
    .spinner{display:inline-block;width:14px;height:14px;border:2px solid currentColor;border-top-color:transparent;border-radius:50%;animation:spin .7s linear infinite;vertical-align:middle}
    @keyframes spin{to{transform:rotate(360deg)}}
    /* ── Action bar ── */
    #action-bar{padding:10px 14px;background:var(--vscode-sideBar-background);border-top:1px solid var(--vscode-panel-border);display:flex;align-items:center;gap:10px;flex-shrink:0}
    .btn-action{padding:7px 18px;border:none;border-radius:var(--radius);cursor:pointer;font-size:13px;font-weight:600;transition:background .15s;display:flex;align-items:center;gap:6px}
    .btn-action:disabled{opacity:.5;cursor:not-allowed}
    #btn-merge{background:#238636;color:#fff;flex:1}
    #btn-merge:hover:not(:disabled){background:#2ea043}
    #btn-reject{background:transparent;color:var(--vscode-foreground);border:1px solid #da3633;flex:1}
    #btn-reject:hover:not(:disabled){background:rgba(218,54,51,.12);color:#f85149}
    #btn-open{background:transparent;color:var(--vscode-textLink-foreground);border:1px solid var(--vscode-panel-border);padding:7px 14px}
    #btn-open:hover{background:var(--vscode-list-hoverBackground)}
    #action-status{font-size:11px;color:var(--vscode-descriptionForeground);flex-shrink:0;min-width:80px}
    /* ── Empty diff ── */
    .empty-diff{display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;color:var(--vscode-descriptionForeground);gap:8px}
    /* ── Scrollbar ── */
    ::-webkit-scrollbar{width:8px;height:8px}
    ::-webkit-scrollbar-track{background:transparent}
    ::-webkit-scrollbar-thumb{background:var(--vscode-scrollbarSlider-background)}
    ::-webkit-scrollbar-thumb:hover{background:var(--vscode-scrollbarSlider-hoverBackground)}
  </style>
</head>
<body>
  <div id="header">
    <div id="mr-title">
      <span id="h-title">Loading...</span>
      <span id="h-state" class="badge"></span>
      <span id="h-draft" class="badge badge-draft" style="display:none">Draft</span>
      <span id="h-provider" class="badge"></span>
    </div>
    <div id="mr-meta">
      <span id="h-author"></span>
      <span id="h-branches"></span>
      <span id="h-stats"></span>
      <span id="h-date"></span>
    </div>
  </div>

  <div id="body">
    <!-- File sidebar -->
    <div id="file-sidebar">
      <div id="sidebar-header">Files Changed (<span id="file-count">0</span>)</div>
      <div id="file-list"></div>
    </div>

    <!-- Diff viewer -->
    <div id="diff-area">
      <div id="diff-file-header">
        <span id="diff-file-name" style="font-weight:600">Select a file</span>
        <span id="diff-file-stats"></span>
      </div>
      <div id="diff-scroll">
        <div class="empty-diff" id="diff-empty">Select a file from the sidebar to view changes</div>
        <table class="diff-table" id="diff-table" style="display:none">
          <colgroup>
            <col class="ln"><col class="code">
            <col class="ln"><col class="code">
          </colgroup>
          <tbody id="diff-body"></tbody>
        </table>
      </div>
    </div>

    <!-- AI Analysis panel -->
    <div id="ai-panel">
      <div id="ai-panel-header">
        <div id="ai-panel-title">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" style="flex-shrink:0">
            <path d="M8 1a.75.75 0 0 1 .75.75V3h.5A2.75 2.75 0 0 1 12 5.75v.5h.25a.75.75 0 0 1 0 1.5H12v.5A2.75 2.75 0 0 1 9.25 11H9v.5a.75.75 0 0 1-1.5 0V11h-.25A2.75 2.75 0 0 1 4 8.25v-.5h-.25a.75.75 0 0 1 0-1.5H4v-.5A2.75 2.75 0 0 1 6.75 3h.5V1.75A.75.75 0 0 1 8 1zM5.5 5.75A1.25 1.25 0 0 0 6.75 7h2.5A1.25 1.25 0 0 0 10.5 5.75v-0A1.25 1.25 0 0 0 9.25 4.5h-2.5A1.25 1.25 0 0 0 5.5 5.75zm0 2.5A1.25 1.25 0 0 0 6.75 9.5h2.5a1.25 1.25 0 0 0 1.25-1.25v0a1.25 1.25 0 0 0-1.25-1.25h-2.5A1.25 1.25 0 0 0 5.5 8.25z"/>
          </svg>
          AI Analysis
        </div>
        <div style="display:flex;gap:6px;align-items:center">
          <button id="btn-cancel">Cancel</button>
          <button id="btn-analyze">
            <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M8 .25a.75.75 0 0 1 .673.418l1.882 3.815 4.21.612a.75.75 0 0 1 .416 1.279l-3.046 2.97.719 4.192a.751.751 0 0 1-1.088.791L8 12.347l-3.766 1.98a.75.75 0 0 1-1.088-.79l.72-4.194L.818 6.374a.75.75 0 0 1 .416-1.28l4.21-.611L7.327.668A.75.75 0 0 1 8 .25z"/></svg>
            Analyze with AI
          </button>
        </div>
      </div>
      <div id="ai-body">
        <div id="ai-placeholder">
          <svg width="48" height="48" viewBox="0 0 16 16" fill="currentColor"><path d="M8 .25a.75.75 0 0 1 .673.418l1.882 3.815 4.21.612a.75.75 0 0 1 .416 1.279l-3.046 2.97.719 4.192a.751.751 0 0 1-1.088.791L8 12.347l-3.766 1.98a.75.75 0 0 1-1.088-.79l.72-4.194L.818 6.374a.75.75 0 0 1 .416-1.28l4.21-.611L7.327.668A.75.75 0 0 1 8 .25z"/></svg>
          <div style="font-weight:600">AI Code Review</div>
          <div style="font-size:12px">Click "Analyze with AI" to get an automated review of all changes in this merge request using GitHub Copilot.</div>
        </div>
        <div id="ai-streaming" class="ai-content"></div>
        <div id="ai-content" class="ai-content"></div>
      </div>
    </div>
  </div>

  <!-- Action bar -->
  <div id="action-bar">
    <button class="btn-action" id="btn-merge">
      <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M5.45 5.154A4.25 4.25 0 0 0 9.25 7.5h1.378a2.251 2.251 0 1 1 0 1.5H9.25A5.734 5.734 0 0 1 5 7.123v3.505a2.25 2.25 0 1 1-1.5 0V5.372a2.25 2.25 0 1 1 1.95-.218z"/></svg>
      Merge
    </button>
    <button class="btn-action" id="btn-reject">
      <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M3.72 3.72a.75.75 0 0 1 1.06 0L8 6.94l3.22-3.22a.749.749 0 0 1 1.275.326.749.749 0 0 1-.215.734L9.06 8l3.22 3.22a.749.749 0 0 1-.326 1.275.749.749 0 0 1-.734-.215L8 9.06l-3.22 3.22a.751.751 0 0 1-1.042-.018.751.751 0 0 1-.018-1.042L6.94 8 3.72 4.78a.75.75 0 0 1 0-1.06z"/></svg>
      Close / Reject
    </button>
    <button class="btn-action" id="btn-open">&#x2197; Open in Browser</button>
    <span id="action-status"></span>
  </div>

<script nonce="${nonce}">
(function() {
  'use strict';
  const vscode = acquireVsCodeApi();

  // ─── State ───────────────────────────────────────────────────────────────
  let currentFiles = [];
  let currentFileIdx = 0;
  let aiBuffer = '';
  let isAnalyzing = false;

  // ─── Elements ────────────────────────────────────────────────────────────
  const btnAnalyze = document.getElementById('btn-analyze');
  const btnCancel  = document.getElementById('btn-cancel');
  const btnMerge   = document.getElementById('btn-merge');
  const btnReject  = document.getElementById('btn-reject');
  const btnOpen    = document.getElementById('btn-open');
  const actStatus  = document.getElementById('action-status');

  // ─── Button events ────────────────────────────────────────────────────────
  btnAnalyze.addEventListener('click', () => {
    vscode.postMessage({ type: 'analyze' });
  });
  btnCancel.addEventListener('click', () => {
    vscode.postMessage({ type: 'cancelAnalysis' });
  });
  btnMerge.addEventListener('click', () => {
    vscode.postMessage({ type: 'merge' });
  });
  btnReject.addEventListener('click', () => {
    vscode.postMessage({ type: 'reject' });
  });
  btnOpen.addEventListener('click', () => {
    vscode.postMessage({ type: 'openUrl' });
  });

  // ─── Message handler ─────────────────────────────────────────────────────
  window.addEventListener('message', function(event) {
    const msg = event.data;
    switch (msg.type) {
      case 'init':       onInit(msg.mr, msg.files);           break;
      case 'analysisStart': onAnalysisStart();                break;
      case 'analysisChunk': onAnalysisChunk(msg.chunk);       break;
      case 'analysisDone':  onAnalysisDone();                 break;
      case 'analysisError': onAnalysisError(msg.error);       break;
      case 'actionStart':   onActionStart(msg.action);        break;
      case 'actionDone':    onActionDone(msg.action, msg.success, msg.error); break;
    }
  });

  // ─── Init ────────────────────────────────────────────────────────────────
  function onInit(mr, files) {
    currentFiles = files || [];
    renderHeader(mr);
    renderFileList(files, mr);
    if (files.length > 0) {
      selectFile(0);
    }
  }

  function renderHeader(mr) {
    document.getElementById('h-title').textContent = mr.title;

    const stateEl = document.getElementById('h-state');
    stateEl.textContent = mr.state.toUpperCase();
    stateEl.className = 'badge badge-' + mr.state;

    const draftEl = document.getElementById('h-draft');
    draftEl.style.display = mr.isDraft ? '' : 'none';

    const provEl = document.getElementById('h-provider');
    provEl.textContent = mr.provider === 'github' ? 'GitHub' : 'GitLab';
    provEl.className = 'badge badge-' + mr.provider;

    document.getElementById('h-author').innerHTML =
      '<span class="meta-icon">👤</span>' + esc(mr.author);

    document.getElementById('h-branches').innerHTML =
      '<span class="meta-icon">⎇</span><code>' + esc(mr.sourceBranch) +
      '</code><span class="branch-arrow">→</span><code>' + esc(mr.targetBranch) + '</code>';

    const statsHtml = '<span class="stat-add">+' + mr.additions + '</span>' +
      ' <span class="stat-del">-' + mr.deletions + '</span>' +
      ' · ' + mr.changedFilesCount + ' files';
    document.getElementById('h-stats').innerHTML = statsHtml;

    if (mr.updatedAt) {
      document.getElementById('h-date').innerHTML =
        '<span class="meta-icon">🕒</span>' + formatDate(mr.updatedAt);
    }
  }

  function renderFileList(files, mr) {
    document.getElementById('file-count').textContent = String(files.length);
    const list = document.getElementById('file-list');
    list.innerHTML = '';
    files.forEach(function(f, i) {
      const item = document.createElement('div');
      item.className = 'file-item';
      item.dataset.index = String(i);

      const statusCode = (f.status || 'modified')[0].toUpperCase();
      const statusClass = 'fs-' + (f.status || 'modified');
      const statsHtml = '<span class="stat-add">+' + f.additions + '</span>' +
        '<span class="stat-del">-' + f.deletions + '</span>';

      item.innerHTML =
        '<span class="fstatus ' + statusClass + '">' + statusCode + '</span>' +
        '<span class="fname" title="' + esc(f.filename) + '">' + esc(f.filename) + '</span>' +
        '<span class="fstats">' + statsHtml + '</span>';

      item.addEventListener('click', function() { selectFile(i); });
      list.appendChild(item);
    });
  }

  function selectFile(idx) {
    currentFileIdx = idx;
    // Update sidebar active state
    document.querySelectorAll('.file-item').forEach(function(el, i) {
      el.classList.toggle('active', i === idx);
    });

    const file = currentFiles[idx];
    if (!file) { return; }

    // Update diff header
    document.getElementById('diff-file-name').textContent = file.filename;
    document.getElementById('diff-file-stats').innerHTML =
      '<span class="stat-add">+' + file.additions + '</span>' +
      ' <span class="stat-del">-' + file.deletions + '</span>';

    // Render diff
    renderDiff(file);

    // Scroll sidebar item into view
    const items = document.querySelectorAll('.file-item');
    if (items[idx]) { items[idx].scrollIntoView({ block: 'nearest' }); }
  }

  // ─── Diff rendering ───────────────────────────────────────────────────────
  function renderDiff(file) {
    const empty = document.getElementById('diff-empty');
    const table = document.getElementById('diff-table');
    const tbody = document.getElementById('diff-body');

    if (!file.patch) {
      empty.style.display = '';
      empty.textContent = file.status === 'added'
        ? 'New file — no diff available'
        : file.status === 'deleted'
          ? 'File deleted'
          : 'Binary file or no diff available';
      table.style.display = 'none';
      return;
    }

    const rows = parsePatch(file.patch);
    if (rows.length === 0) {
      empty.style.display = '';
      empty.textContent = 'No changes';
      table.style.display = 'none';
      return;
    }

    empty.style.display = 'none';
    table.style.display = '';
    tbody.innerHTML = '';

    const fragment = document.createDocumentFragment();
    rows.forEach(function(row) {
      fragment.appendChild(buildRowEl(row));
    });
    tbody.appendChild(fragment);
  }

  function buildRowEl(row) {
    const tr = document.createElement('tr');

    if (row.type === 'hunk') {
      tr.className = 'row-hunk';
      tr.innerHTML = '<td colspan="4">' + esc(row.hunkHeader || '') + '</td>';
      return tr;
    }

    // Left side
    const lnL  = document.createElement('td');
    const codeL = document.createElement('td');
    lnL.className  = 'ln';
    codeL.className = 'code';

    const lnR  = document.createElement('td');
    const codeR = document.createElement('td');
    lnR.className  = 'ln';
    codeR.className = 'code';

    const div = document.createElement('td');
    div.className = 'diff-divider';

    if (row.leftType === 'remove') {
      tr.className = 'row-del';
      lnL.textContent  = String(row.leftLineNum || '');
      lnL.className += ' ln-del';
      codeL.textContent = row.leftContent || '';
      lnR.textContent  = '';
      codeR.textContent = '';
    } else if (row.rightType === 'add') {
      tr.className = 'row-add';
      lnL.textContent  = '';
      codeL.textContent = '';
      lnR.textContent  = String(row.rightLineNum || '');
      lnR.className += ' ln-add';
      codeR.textContent = row.rightContent || '';
    } else {
      // context
      lnL.textContent  = row.leftLineNum  ? String(row.leftLineNum)  : '';
      codeL.textContent = row.leftContent  || '';
      lnR.textContent  = row.rightLineNum ? String(row.rightLineNum) : '';
      codeR.textContent = row.rightContent || '';
    }

    tr.appendChild(lnL);
    tr.appendChild(codeL);
    tr.appendChild(div);
    tr.appendChild(lnR);
    tr.appendChild(codeR);
    return tr;
  }

  // Parse unified diff into display rows
  function parsePatch(patch) {
    const lines  = patch.split('\n');
    const result = [];
    let oldNum = 0, newNum = 0;
    let i = 0;

    while (i < lines.length) {
      const line = lines[i];

      if (line.startsWith('@@')) {
        const m = line.match(/@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
        if (m) {
          oldNum = parseInt(m[1], 10) - 1;
          newNum = parseInt(m[2], 10) - 1;
        }
        result.push({ type: 'hunk', hunkHeader: line });
        i++;
        continue;
      }

      // Collect a block of changed lines
      var removes = [], adds = [];
      while (i < lines.length && (lines[i].startsWith('-') || lines[i].startsWith('+'))) {
        if (lines[i].startsWith('-') && !lines[i].startsWith('---')) {
          oldNum++;
          removes.push({ num: oldNum, content: lines[i].slice(1) });
        } else if (lines[i].startsWith('+') && !lines[i].startsWith('+++')) {
          newNum++;
          adds.push({ num: newNum, content: lines[i].slice(1) });
        }
        i++;
      }

      if (removes.length > 0 || adds.length > 0) {
        var maxLen = Math.max(removes.length, adds.length);
        for (var j = 0; j < maxLen; j++) {
          var rem = removes[j];
          var add = adds[j];
          if (rem && add) {
            result.push({
              type: 'change',
              leftType: 'remove', leftLineNum: rem.num, leftContent: rem.content,
              rightType: 'add',   rightLineNum: add.num, rightContent: add.content
            });
          } else if (rem) {
            result.push({ type: 'change', leftType: 'remove', leftLineNum: rem.num, leftContent: rem.content });
          } else if (add) {
            result.push({ type: 'change', rightType: 'add', rightLineNum: add.num, rightContent: add.content });
          }
        }
        continue;
      }

      if (line.startsWith(' ')) {
        oldNum++; newNum++;
        result.push({
          type: 'context',
          leftType:  'context', leftLineNum:  oldNum, leftContent:  line.slice(1),
          rightType: 'context', rightLineNum: newNum, rightContent: line.slice(1)
        });
      }
      i++;
    }

    return result;
  }

  // ─── AI Analysis ─────────────────────────────────────────────────────────
  function onAnalysisStart() {
    isAnalyzing = true;
    aiBuffer = '';
    document.getElementById('ai-placeholder').style.display = 'none';
    document.getElementById('ai-content').style.display = 'none';
    document.getElementById('ai-streaming').style.display = '';
    document.getElementById('ai-streaming').textContent = '';
    btnAnalyze.disabled = true;
    btnAnalyze.innerHTML = '<span class="spinner"></span> Analyzing...';
    btnCancel.style.display = '';
  }

  function onAnalysisChunk(chunk) {
    aiBuffer += chunk;
    document.getElementById('ai-streaming').textContent = aiBuffer;
    // Auto-scroll
    const body = document.getElementById('ai-body');
    body.scrollTop = body.scrollHeight;
  }

  function onAnalysisDone() {
    isAnalyzing = false;
    document.getElementById('ai-streaming').style.display = 'none';
    const contentEl = document.getElementById('ai-content');
    contentEl.style.display = '';
    contentEl.innerHTML = renderMarkdown(aiBuffer);
    btnAnalyze.disabled = false;
    btnAnalyze.innerHTML =
      '<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M8 .25a.75.75 0 0 1 .673.418l1.882 3.815 4.21.612a.75.75 0 0 1 .416 1.279l-3.046 2.97.719 4.192a.751.751 0 0 1-1.088.791L8 12.347l-3.766 1.98a.75.75 0 0 1-1.088-.79l.72-4.194L.818 6.374a.75.75 0 0 1 .416-1.28l4.21-.611L7.327.668A.75.75 0 0 1 8 .25z"/></svg>' +
      ' Re-analyze';
    btnCancel.style.display = 'none';
  }

  function onAnalysisError(error) {
    isAnalyzing = false;
    document.getElementById('ai-streaming').style.display = 'none';
    const contentEl = document.getElementById('ai-content');
    contentEl.style.display = '';
    contentEl.innerHTML = '<p style="color:#f85149"><strong>Analysis failed:</strong> ' + esc(error) + '</p>';
    btnAnalyze.disabled = false;
    btnAnalyze.innerHTML = '<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M8 .25a.75.75 0 0 1 .673.418l1.882 3.815 4.21.612a.75.75 0 0 1 .416 1.279l-3.046 2.97.719 4.192a.751.751 0 0 1-1.088.791L8 12.347l-3.766 1.98a.75.75 0 0 1-1.088-.79l.72-4.194L.818 6.374a.75.75 0 0 1 .416-1.28l4.21-.611L7.327.668A.75.75 0 0 1 8 .25z"/></svg> Retry';
    btnCancel.style.display = 'none';
  }

  // ─── Actions ─────────────────────────────────────────────────────────────
  function onActionStart(action) {
    btnMerge.disabled = true;
    btnReject.disabled = true;
    actStatus.innerHTML = '<span class="spinner"></span> ' +
      (action === 'merge' ? 'Merging...' : 'Closing...');
  }

  function onActionDone(action, success, error) {
    btnMerge.disabled = false;
    btnReject.disabled = false;
    if (success) {
      actStatus.innerHTML = action === 'merge'
        ? '<span style="color:#3fb950">✓ Merged!</span>'
        : '<span style="color:#f85149">✓ Closed</span>';
      btnMerge.disabled = true;
      btnReject.disabled = true;
    } else {
      actStatus.innerHTML = '<span style="color:#f85149">✗ Failed</span>';
    }
  }

  // ─── Markdown renderer ──────────────────────────────────────────────────
  function renderMarkdown(md) {
    if (!md) { return ''; }

    // Save code blocks (\x60 = backtick)
    var codeBlocks = [];
    var processed = md.replace(/\x60\x60\x60[\w]*\n?([\s\S]*?)\x60\x60\x60/g, function(_, code) {
      var idx = codeBlocks.length;
      codeBlocks.push('<pre><code>' + esc(code.trim()) + '</code></pre>');
      return '\x00CB' + idx + '\x00';
    });

    // Save inline code
    var inlineCodes = [];
    processed = processed.replace(/\x60([^\x60\n]+)\x60/g, function(_, code) {
      var idx = inlineCodes.length;
      inlineCodes.push('<code>' + esc(code) + '</code>');
      return '\x00IC' + idx + '\x00';
    });

    // Escape remaining HTML entities
    processed = esc(processed);

    // Restore placeholders that were escaped
    processed = processed.replace(/\x00CB(\d+)\x00/g, function(_, i) { return codeBlocks[parseInt(i)]; });
    processed = processed.replace(/\x00IC(\d+)\x00/g, function(_, i) { return inlineCodes[parseInt(i)]; });

    // Recommendation boxes
    processed = processed.replace(/✅\s*\*\*APPROVE\*\*([^\n]*)/g,
      '<div class="recommend-box rec-approve">✅ APPROVE $1</div>');
    processed = processed.replace(/⚠️\s*\*\*APPROVE WITH SUGGESTIONS\*\*([^\n]*)/g,
      '<div class="recommend-box rec-suggest">⚠️ APPROVE WITH SUGGESTIONS $1</div>');
    processed = processed.replace(/❌\s*\*\*REQUEST CHANGES\*\*([^\n]*)/g,
      '<div class="recommend-box rec-changes">❌ REQUEST CHANGES $1</div>');

    // Headers
    processed = processed.replace(/^### (.+)$/gm, '<h3>$1</h3>');
    processed = processed.replace(/^## (.+)$/gm,  '<h2>$1</h2>');
    processed = processed.replace(/^# (.+)$/gm,   '<h1>$1</h1>');

    // Bold & italic
    processed = processed.replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>');
    processed = processed.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    processed = processed.replace(/\*(.+?)\*/g, '<em>$1</em>');

    // Lists
    var listLines = processed.split('\n');
    var rebuilt = [];
    var inUL = false;
    listLines.forEach(function(ln) {
      var ulm = ln.match(/^[-*+]\s+(.+)$/);
      var olm = ln.match(/^\d+\.\s+(.+)$/);
      if (ulm) {
        if (!inUL) { rebuilt.push('<ul>'); inUL = true; }
        rebuilt.push('<li>' + ulm[1] + '</li>');
      } else {
        if (inUL) { rebuilt.push('</ul>'); inUL = false; }
        rebuilt.push(ln);
      }
    });
    if (inUL) { rebuilt.push('</ul>'); }
    processed = rebuilt.join('\n');

    // Paragraphs
    processed = processed.split(/\n{2,}/).map(function(block) {
      if (!block.trim()) { return ''; }
      if (/^<[huo1-9]/.test(block.trim())) { return block; }
      return '<p>' + block.replace(/\n/g, '<br>') + '</p>';
    }).join('\n');

    return processed;
  }

  // ─── Utilities ────────────────────────────────────────────────────────────
  function esc(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function formatDate(iso) {
    try {
      return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
    } catch(e) { return iso; }
  }
})();
</script>
</body>
</html>`;
  }
}

// ─── Utility ─────────────────────────────────────────────────────────────────

function getNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  for (let i = 0; i < 32; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}
