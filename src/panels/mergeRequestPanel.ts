import * as vscode from 'vscode';
import * as path from 'path';
import { MergeRequest, ChangedFile } from '../models/types';
import { getGithubPRFiles, getGithubPRDetails, mergeGithubPR, closeGithubPR, postGithubPRComment } from '../services/githubService';
import { getGitlabMRChanges, mergeGitlabMR, closeGitlabMR, postGitlabMRNote } from '../services/gitlabService';
import { analyzeChanges } from '../services/aiService';
import { outputChannel } from '../providers/mergeRequestProvider';

export class MergeRequestPanel {
  public static currentPanel: MergeRequestPanel | undefined;
  private static readonly viewType = 'gitmergeReview';

  private readonly _panel: vscode.WebviewPanel;
  private readonly _context: vscode.ExtensionContext;
  private _mr: MergeRequest;
  private _files: ChangedFile[] = [];
  private _disposables: vscode.Disposable[] = [];
  private _cancelSource?: vscode.CancellationTokenSource;
  private _updateSeq = 0;

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
    const seq = ++this._updateSeq;
    this._mr = mr;
    this._panel.title = `MR: ${mr.title.slice(0, 50)}`;
    this._panel.webview.html = this._getLoadingHtml();

    outputChannel.appendLine(`[Panel] Opening MR #${mr.number} "${mr.title}" (${mr.provider})`);

    let files: ChangedFile[];
    try {
      files = await this._fetchFiles(mr);
      outputChannel.appendLine(`[Panel] Fetched ${files.length} file(s) for MR #${mr.number}`);
    } catch (err) {
      outputChannel.appendLine(`[Panel] ERROR fetching files for MR #${mr.number}: ${String(err)}`);
      if (seq !== this._updateSeq) { return; }
      this._panel.webview.html = this._getErrorHtml(String(err));
      return;
    }

    if (seq !== this._updateSeq) {
      outputChannel.appendLine(`[Panel] Stale update (seq ${seq}), discarding`);
      return;
    }

    this._files = files;
    // Enrich aggregate stats for GitLab (not provided by list endpoint)
    if (mr.provider === 'gitlab') {
      mr.additions = this._files.reduce((s, f) => s + f.additions, 0);
      mr.deletions = this._files.reduce((s, f) => s + f.deletions, 0);
      mr.changedFilesCount = this._files.length;
    }

    outputChannel.appendLine(`[Panel] Rendering webview for MR #${mr.number}`);
    this._panel.webview.html = this._getWebviewContent();
  }

  private async _fetchFiles(mr: MergeRequest): Promise<ChangedFile[]> {
    const config = vscode.workspace.getConfiguration('gitmerge');
    if (mr.provider === 'github') {
      const token = await this._context.secrets.get('gitmerge.githubToken');
      if (!token) { throw new Error('GitHub token not configured. Run "GitMerge: Set GitHub Token".'); }

      outputChannel.appendLine(`[GitHub] Fetching PR details + files for ${mr.repoOwner}/${mr.repoName}#${mr.number}`);
      // Fetch full PR details and files in parallel; enrich mr with branch info
      const [details, files] = await Promise.all([
        getGithubPRDetails(mr.repoOwner, mr.repoName, mr.number, token),
        getGithubPRFiles(mr.repoOwner, mr.repoName, mr.number, token),
      ]);
      outputChannel.appendLine(`[GitHub] Got ${files.length} file(s) for PR #${mr.number}`);
      Object.assign(mr, details);
      return files;
    } else {
      const token = await this._context.secrets.get('gitmerge.gitlabToken');
      if (!token) { throw new Error('GitLab token not configured. Run "GitMerge: Set GitLab Token".'); }
      const gitlabUrl: string = config.get('gitlabUrl') ?? 'https://gitlab.com';
      const projectId = (mr as MergeRequest & { gitlabProjectId?: string | number }).gitlabProjectId ?? `${mr.repoOwner}/${mr.repoName}`;
      outputChannel.appendLine(`[GitLab] Fetching changes for project ${projectId} MR !${mr.iid}`);
      const files = await getGitlabMRChanges(projectId, mr.iid, token, gitlabUrl);
      outputChannel.appendLine(`[GitLab] Got ${files.length} file(s) for MR !${mr.iid}`);
      return files;
    }
  }

  private async _handleMessage(message: { type: string; [key: string]: unknown }): Promise<void> {
    switch (message.type) {
      case 'ready':
        outputChannel.appendLine(`[Panel] Webview ready — sending init data for MR #${this._mr.number} (${this._files.length} files)`);
        this._panel.webview.postMessage({ type: 'init', mr: this._mr, files: this._files });
        break;
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
      case 'postComment':
        await this._postComment(message.body as string);
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

  private async _postComment(body: string): Promise<void> {
    if (!body || !body.trim()) { return; }

    this._panel.webview.postMessage({ type: 'commentStart' });

    try {
      const config = vscode.workspace.getConfiguration('gitmerge');
      if (this._mr.provider === 'github') {
        const token = await this._context.secrets.get('gitmerge.githubToken');
        if (!token) { throw new Error('GitHub token not configured.'); }
        await postGithubPRComment(this._mr.repoOwner, this._mr.repoName, this._mr.number, body, token);
      } else {
        const token = await this._context.secrets.get('gitmerge.gitlabToken');
        if (!token) { throw new Error('GitLab token not configured.'); }
        const gitlabUrl: string = config.get('gitlabUrl') ?? 'https://gitlab.com';
        const projectId = (this._mr as MergeRequest & { gitlabProjectId?: string | number }).gitlabProjectId ?? `${this._mr.repoOwner}/${this._mr.repoName}`;
        await postGitlabMRNote(projectId, this._mr.iid, body, token, gitlabUrl);
      }
      this._panel.webview.postMessage({ type: 'commentDone' });
      vscode.window.showInformationMessage('Comment posted successfully.');
    } catch (err) {
      this._panel.webview.postMessage({ type: 'commentError', error: String(err) });
      vscode.window.showErrorMessage(`Comment failed: ${String(err)}`);
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

    return String.raw`<!DOCTYPE html>
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
    #header{padding:10px 16px;background:var(--vscode-sideBar-background);border-bottom:1px solid var(--vscode-panel-border);flex-shrink:0;display:flex;align-items:center;justify-content:space-between;gap:12px}
    #header-left{flex:1;min-width:0}
    #mr-title{font-size:15px;font-weight:700;margin-bottom:4px;display:flex;align-items:center;gap:8px;flex-wrap:wrap}
    .badge{padding:2px 8px;border-radius:10px;font-size:11px;font-weight:600}
    .badge-open{background:#238636;color:#fff}
    .badge-merged{background:#8957e5;color:#fff}
    .badge-closed{background:#da3633;color:#fff}
    .badge-draft{background:#6e7681;color:#fff}
    .badge-github{background:#161b22;color:#fff;border:1px solid #30363d}
    .badge-gitlab{background:#fc6d26;color:#fff}
    #mr-meta{display:flex;align-items:center;gap:16px;font-size:12px;color:var(--vscode-descriptionForeground);flex-wrap:wrap}
    #header-actions{display:flex;align-items:center;gap:8px;flex-shrink:0}
    .branch-arrow{color:var(--vscode-foreground);font-weight:bold;margin:0 4px}
    .meta-icon{margin-right:3px}
    .stat-add{color:#3fb950}
    .stat-del{color:#f85149}
    /* ── Body layout ── */
    #body{flex:1;display:flex;flex-direction:column;overflow:hidden;min-height:0}
    #diff-wrapper{flex:1;display:flex;overflow:hidden;min-height:0}
    /* ── File sidebar ── */
    #file-sidebar{width:240px;flex-shrink:0;background:var(--vscode-sideBar-background);display:flex;flex-direction:column;overflow:hidden}
    #sidebar-resize{width:5px;flex-shrink:0;cursor:ew-resize;background:transparent;border-right:1px solid var(--vscode-panel-border);transition:background .15s}
    #sidebar-resize:hover,#sidebar-resize.dragging{background:var(--vscode-focusBorder)}
    #sidebar-header{padding:8px 12px;font-size:11px;font-weight:700;text-transform:uppercase;color:var(--vscode-descriptionForeground);border-bottom:1px solid var(--vscode-panel-border);letter-spacing:.05em}
    #file-search-wrap{padding:5px 8px;border-bottom:1px solid var(--vscode-panel-border);flex-shrink:0}
    #file-search{width:100%;background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border,var(--vscode-panel-border));border-radius:var(--radius);padding:3px 7px;font-size:12px;outline:none;font-family:var(--vscode-font-family);box-sizing:border-box}
    #file-search:focus{border-color:var(--vscode-focusBorder)}
    #file-search::placeholder{color:var(--vscode-input-placeholderForeground)}
    #no-search-results{padding:8px 12px;font-size:11px;color:var(--vscode-descriptionForeground);display:none}
    .file-item.search-hidden{display:none}
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
    /* ── Split panes ── */
    #diff-panes{flex:1;display:flex;overflow:hidden;min-height:0}
    .diff-pane{flex:0 0 50%;display:flex;flex-direction:column;overflow:hidden;min-width:0}
    #before-pane{border-right:none}
    .diff-pane-header{padding:5px 10px;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.07em;flex-shrink:0;border-bottom:1px solid var(--vscode-panel-border)}
    #before-pane .diff-pane-header{color:#f85149;background:rgba(218,54,51,.12)}
    #after-pane  .diff-pane-header{color:#3fb950;background:rgba(40,167,69,.12)}
    .diff-pane-scroll{flex:1;overflow:auto}
    /* ── Split resize handle ── */
    #diff-vsplit{width:5px;flex-shrink:0;cursor:ew-resize;background:transparent;border-left:1px solid var(--vscode-panel-border);border-right:1px solid var(--vscode-panel-border);transition:background .15s}
    #diff-vsplit:hover,#diff-vsplit.dragging{background:var(--vscode-focusBorder)}
    /* ── Diff table ── */
    .diff-table{width:100%;border-collapse:collapse;font-family:var(--vscode-editor-font-family,'Menlo','Consolas',monospace);font-size:var(--vscode-editor-font-size,12px);table-layout:fixed}
    .diff-table col.ln{width:44px}
    .diff-table col.code{width:calc(100% - 44px)}
    .diff-table td{padding:0 6px;white-space:pre;line-height:20px;height:20px;overflow:hidden;text-overflow:ellipsis;vertical-align:top}
    .ln{text-align:right;padding-right:8px!important;color:var(--vscode-editorLineNumber-foreground);user-select:none;font-size:11px;border-right:1px solid rgba(128,128,128,.25)}
    .code{padding-left:10px!important}
    /* Row colors */
    .row-del td{background:rgba(218,54,51,.08)}
    .row-del .code{background:rgba(218,54,51,.22)!important}
    .row-del .ln{color:#f85149}
    .row-add td{background:rgba(40,167,69,.08)}
    .row-add .code{background:rgba(40,167,69,.22)!important}
    .row-empty td{background:rgba(100,100,100,.05)}
    .row-hunk td{background:rgba(128,128,128,.08)!important;color:var(--vscode-descriptionForeground);font-style:italic;padding:3px 10px!important;height:auto!important;border:none;letter-spacing:.03em}
    .diff-table .ln-add{color:#3fb950}
    .diff-table .ln-del{color:#f85149}
    /* ── Syntax highlight tokens (VSCode dark/light adaptive) ── */
    .tok-kw   {color:var(--vscode-symbolIcon-keywordForeground,#569cd6)}
    .tok-str  {color:var(--vscode-symbolIcon-stringForeground,#ce9178)}
    .tok-cmt  {color:var(--vscode-symbolIcon-colorForeground,#6a9955);font-style:italic}
    .tok-num  {color:var(--vscode-symbolIcon-numberForeground,#b5cea8)}
    .tok-fn   {color:var(--vscode-symbolIcon-functionForeground,#dcdcaa)}
    .tok-cls  {color:var(--vscode-symbolIcon-classForeground,#4ec9b0)}
    .tok-op   {color:var(--vscode-symbolIcon-operatorForeground,#d4d4d4)}
    .tok-tag  {color:var(--vscode-symbolIcon-keywordForeground,#569cd6)}
    .tok-attr {color:var(--vscode-symbolIcon-fieldForeground,#9cdcfe)}
    .tok-val  {color:var(--vscode-symbolIcon-stringForeground,#ce9178)}
    .tok-sel  {color:var(--vscode-symbolIcon-classForeground,#d7ba7d)}
    .tok-pp   {color:var(--vscode-symbolIcon-colorForeground,#c586c0)}
    .tok-dec  {color:var(--vscode-symbolIcon-colorForeground,#c586c0)}
    .tok-re   {color:var(--vscode-symbolIcon-stringForeground,#d16969)}
    /* ── AI panel ── */
    #ai-panel{height:260px;flex-shrink:0;background:var(--vscode-sideBar-background);border-top:1px solid var(--vscode-panel-border);display:flex;flex-direction:column;overflow:hidden}
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
    /* ── AI resize handle ── */
    #ai-resize{height:5px;flex-shrink:0;cursor:ns-resize;background:transparent;border-top:1px solid var(--vscode-panel-border);transition:background .15s}
    #ai-resize:hover,#ai-resize.dragging{background:var(--vscode-focusBorder)}
    /* ── Spinner ── */
    .spinner{display:inline-block;width:14px;height:14px;border:2px solid currentColor;border-top-color:transparent;border-radius:50%;animation:spin .7s linear infinite;vertical-align:middle}
    @keyframes spin{to{transform:rotate(360deg)}}
    /* ── Action bar ── */
    .btn-action{padding:6px 14px;border:none;border-radius:var(--radius);cursor:pointer;font-size:12px;font-weight:600;transition:background .15s;display:flex;align-items:center;gap:5px;white-space:nowrap}
    .btn-action:disabled{opacity:.5;cursor:not-allowed}
    #btn-merge{background:#238636;color:#fff}
    #btn-merge:hover:not(:disabled){background:#2ea043}
    #btn-reject{background:transparent;color:var(--vscode-foreground);border:1px solid #da3633}
    #btn-reject:hover:not(:disabled){background:rgba(218,54,51,.12);color:#f85149}
    #btn-open{background:transparent;color:var(--vscode-textLink-foreground);border:1px solid var(--vscode-panel-border)}
    #btn-open:hover{background:var(--vscode-list-hoverBackground)}
    #action-status{font-size:11px;color:var(--vscode-descriptionForeground);flex-shrink:0}
    /* ── Empty diff ── */
    .empty-diff{display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;color:var(--vscode-descriptionForeground);gap:8px}
    /* ── Comment panel ── */
    #comment-panel{flex-shrink:0;background:var(--vscode-sideBar-background);border-top:1px solid var(--vscode-panel-border);padding:8px 14px 10px;display:flex;flex-direction:column;gap:6px}
    #comment-panel-header{display:flex;align-items:center;justify-content:space-between;font-size:12px;font-weight:700}
    #comment-textarea{width:100%;resize:vertical;min-height:52px;max-height:160px;background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border,var(--vscode-panel-border));border-radius:var(--radius);padding:6px 8px;font-family:var(--vscode-font-family);font-size:12px;outline:none}
    #comment-textarea:focus{border-color:var(--vscode-focusBorder)}
    #comment-footer{display:flex;align-items:center;justify-content:flex-end;gap:8px}
    #comment-status{font-size:11px;color:var(--vscode-descriptionForeground)}
    #btn-post-comment{background:var(--vscode-button-background);color:var(--vscode-button-foreground);border:none;padding:5px 14px;border-radius:var(--radius);cursor:pointer;font-size:12px;font-weight:600;display:flex;align-items:center;gap:5px}
    #btn-post-comment:hover:not(:disabled){background:var(--vscode-button-hoverBackground)}
    #btn-post-comment:disabled{opacity:.55;cursor:not-allowed}
    /* ── Scrollbar ── */
    ::-webkit-scrollbar{width:8px;height:8px}
    ::-webkit-scrollbar-track{background:transparent}
    ::-webkit-scrollbar-thumb{background:var(--vscode-scrollbarSlider-background)}
    ::-webkit-scrollbar-thumb:hover{background:var(--vscode-scrollbarSlider-hoverBackground)}
  </style>
</head>
<body>
  <div id="header">
    <div id="header-left">
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
    <div id="header-actions">
      <span id="action-status"></span>
      <button class="btn-action" id="btn-merge">
        <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M5.45 5.154A4.25 4.25 0 0 0 9.25 7.5h1.378a2.251 2.251 0 1 1 0 1.5H9.25A5.734 5.734 0 0 1 5 7.123v3.505a2.25 2.25 0 1 1-1.5 0V5.372a2.25 2.25 0 1 1 1.95-.218z"/></svg>
        Merge
      </button>
      <button class="btn-action" id="btn-reject">
        <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M3.72 3.72a.75.75 0 0 1 1.06 0L8 6.94l3.22-3.22a.749.749 0 0 1 1.275.326.749.749 0 0 1-.215.734L9.06 8l3.22 3.22a.749.749 0 0 1-.326 1.275.749.749 0 0 1-.734-.215L8 9.06l-3.22 3.22a.751.751 0 0 1-1.042-.018.751.751 0 0 1-.018-1.042L6.94 8 3.72 4.78a.75.75 0 0 1 0-1.06z"/></svg>
        Close / Reject
      </button>
      <button class="btn-action" id="btn-open">&#x2197; Open in Browser</button>
    </div>
  </div>

  <div id="body">
    <div id="diff-wrapper">
    <!-- File sidebar -->
    <div id="file-sidebar">
      <div id="sidebar-header">Files Changed (<span id="file-count">0</span>)</div>
      <div id="file-search-wrap">
        <input id="file-search" type="text" placeholder="Filter files..." autocomplete="off" spellcheck="false">
      </div>
      <div id="no-search-results">No matching files</div>
      <div id="file-list"></div>
    </div>
    <!-- Sidebar resize handle -->
    <div id="sidebar-resize"></div>

    <!-- Diff viewer -->
    <div id="diff-area">
      <div id="diff-file-header">
        <span id="diff-file-name" style="font-weight:600">Select a file</span>
        <span id="diff-file-stats"></span>
      </div>
      <div id="diff-panes">
        <!-- Before pane -->
        <div class="diff-pane" id="before-pane">
          <div class="diff-pane-header">&#x2190; Before</div>
          <div class="diff-pane-scroll" id="before-scroll">
            <div class="empty-diff" id="diff-empty">Select a file from the sidebar to view changes</div>
            <table class="diff-table" id="before-table" style="display:none">
              <colgroup><col class="ln"><col class="code"></colgroup>
              <tbody id="before-body"></tbody>
            </table>
          </div>
        </div>
        <!-- Split resize handle -->
        <div id="diff-vsplit"></div>
        <!-- After pane -->
        <div class="diff-pane" id="after-pane">
          <div class="diff-pane-header">After &#x2192;</div>
          <div class="diff-pane-scroll" id="after-scroll">
            <table class="diff-table" id="after-table" style="display:none">
              <colgroup><col class="ln"><col class="code"></colgroup>
              <tbody id="after-body"></tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
    </div>

    <!-- AI resize handle -->
    <div id="ai-resize"></div>

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

    <!-- Comment panel -->
    <div id="comment-panel">
      <div id="comment-panel-header">
        <span>💬 Post Comment</span>
        <span id="comment-status"></span>
      </div>
      <textarea id="comment-textarea" rows="2" placeholder="Leave a comment on this merge request..."></textarea>
      <div id="comment-footer">
        <button id="btn-post-comment">
          <svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor"><path d="M1.5 2.75a.25.25 0 0 1 .25-.25h12.5a.25.25 0 0 1 .25.25v8.5a.25.25 0 0 1-.25.25h-6.5a.75.75 0 0 0-.53.22L4.5 14.44v-2.19a.75.75 0 0 0-.75-.75H1.75a.25.25 0 0 1-.25-.25Zm.25-1.75C.784 1 0 1.784 0 2.75v8.5C0 12.216.784 13 1.75 13H3v2.25a.75.75 0 0 0 1.28.53l2.69-2.78H14.25c.966 0 1.75-.784 1.75-1.75v-8.5C16 1.784 15.216 1 14.25 1Z"/></svg>
          Post Comment
        </button>
      </div>
    </div>
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

  // ─── Message handler ─────────────────────────────────────────────────────
  // Listener and 'ready' handshake are intentionally first so UI binding bugs
  // can't block initial data delivery.
  window.addEventListener('message', function(event) {
    const msg = event.data;
    switch (msg.type) {
      case 'init':
        try {
          console.log('[GitMerge] init received — mr#' + msg.mr.number + ' files:' + (msg.files || []).length);
          onInit(msg.mr, msg.files);
        } catch (e) {
          showInitError(String(e));
        }
        break;
      case 'analysisStart': onAnalysisStart();                break;
      case 'analysisChunk': onAnalysisChunk(msg.chunk);       break;
      case 'analysisDone':  onAnalysisDone();                 break;
      case 'analysisError': onAnalysisError(msg.error);       break;
      case 'actionStart':   onActionStart(msg.action);        break;
      case 'actionDone':    onActionDone(msg.action, msg.success, msg.error); break;
      case 'commentStart':  onCommentStart();                 break;
      case 'commentDone':   onCommentDone();                  break;
      case 'commentError':  onCommentError(msg.error);        break;
    }
  });

  // Notify extension that the webview is ready to receive init payload.
  vscode.postMessage({ type: 'ready' });

  // ─── Elements ────────────────────────────────────────────────────────────
  const fileSearch       = document.getElementById('file-search');
  const noSearchResults  = document.getElementById('no-search-results');
  const btnAnalyze       = document.getElementById('btn-analyze');
  const btnCancel        = document.getElementById('btn-cancel');
  const btnMerge         = document.getElementById('btn-merge');
  const btnReject        = document.getElementById('btn-reject');
  const btnOpen          = document.getElementById('btn-open');
  const actStatus        = document.getElementById('action-status');
  const btnPostComment   = document.getElementById('btn-post-comment');
  const commentTextarea  = document.getElementById('comment-textarea');
  const commentStatus    = document.getElementById('comment-status');

  // ─── Sidebar resize ───────────────────────────────────────────────────────
  (function() {
    const handle  = document.getElementById('sidebar-resize');
    const sidebar = document.getElementById('file-sidebar');
    const minW = 120, maxW = 500;
    let dragging = false, startX = 0, startW = 0;
    handle?.addEventListener('mousedown', function(e) {
      dragging = true; startX = e.clientX;
      startW = sidebar.getBoundingClientRect().width;
      handle.classList.add('dragging');
      document.body.style.userSelect = 'none';
      document.body.style.cursor = 'ew-resize';
      e.preventDefault();
    });
    document.addEventListener('mousemove', function(e) {
      if (!dragging) { return; }
      const newW = Math.min(maxW, Math.max(minW, startW + (e.clientX - startX)));
      sidebar.style.width = newW + 'px';
    });
    document.addEventListener('mouseup', function() {
      if (!dragging) { return; }
      dragging = false;
      handle.classList.remove('dragging');
      document.body.style.userSelect = '';
      document.body.style.cursor = '';
    });
  })();

  // ─── Before/After split resize ────────────────────────────────────────────
  (function() {
    const handle      = document.getElementById('diff-vsplit');
    const beforePane  = document.getElementById('before-pane');
    const afterPane   = document.getElementById('after-pane');
    const beforeScroll = document.getElementById('before-scroll');
    const afterScroll  = document.getElementById('after-scroll');
    let splitPct = 50;
    let dragging = false, startX = 0, startPct = 0;
    let syncingScroll = false;

    // Sync vertical scroll between panes
    beforeScroll?.addEventListener('scroll', function() {
      if (syncingScroll) { return; }
      syncingScroll = true;
      afterScroll.scrollTop = beforeScroll.scrollTop;
      syncingScroll = false;
    });
    afterScroll?.addEventListener('scroll', function() {
      if (syncingScroll) { return; }
      syncingScroll = true;
      beforeScroll.scrollTop = afterScroll.scrollTop;
      syncingScroll = false;
    });

    function applySplit(pct) {
      splitPct = Math.min(80, Math.max(20, pct));
      // flex-basis on each pane — this is instant and reliable
      beforePane.style.flex = '0 0 ' + splitPct + '%';
      afterPane.style.flex  = '0 0 ' + (100 - splitPct) + '%';
    }
    applySplit(50);

    handle?.addEventListener('mousedown', function(e) {
      dragging = true; startX = e.clientX; startPct = splitPct;
      handle.classList.add('dragging');
      document.body.style.userSelect = 'none';
      document.body.style.cursor = 'ew-resize';
      e.preventDefault();
    });
    document.addEventListener('mousemove', function(e) {
      if (!dragging) { return; }
      const panesW = (beforePane.parentElement || document.body).getBoundingClientRect().width;
      if (panesW === 0) { return; }
      applySplit(startPct + (e.clientX - startX) / panesW * 100);
    });
    document.addEventListener('mouseup', function() {
      if (!dragging) { return; }
      dragging = false;
      handle.classList.remove('dragging');
      document.body.style.userSelect = '';
      document.body.style.cursor = '';
    });
  })();

  // ─── AI panel resize ─────────────────────────────────────────────────────
  (function() {
    const handle   = document.getElementById('ai-resize');
    const aiPanel  = document.getElementById('ai-panel');
    const minH = 80;
    const maxH = 600;
    let dragging = false;
    let startY = 0;
    let startH = 0;
    handle?.addEventListener('mousedown', function(e) {
      dragging = true;
      startY = e.clientY;
      startH = aiPanel.getBoundingClientRect().height;
      handle.classList.add('dragging');
      document.body.style.userSelect = 'none';
      document.body.style.cursor = 'ns-resize';
    });
    document.addEventListener('mousemove', function(e) {
      if (!dragging) { return; }
      const delta = startY - e.clientY; // drag up = bigger
      const newH = Math.min(maxH, Math.max(minH, startH + delta));
      aiPanel.style.height = newH + 'px';
    });
    document.addEventListener('mouseup', function() {
      if (!dragging) { return; }
      dragging = false;
      handle.classList.remove('dragging');
      document.body.style.userSelect = '';
      document.body.style.cursor = '';
    });
  })();

  // ─── Button events ────────────────────────────────────────────────────────
  btnAnalyze?.addEventListener('click', () => {
    vscode.postMessage({ type: 'analyze' });
  });
  btnCancel?.addEventListener('click', () => {
    vscode.postMessage({ type: 'cancelAnalysis' });
  });
  btnMerge?.addEventListener('click', () => {
    vscode.postMessage({ type: 'merge' });
  });
  btnReject?.addEventListener('click', () => {
    vscode.postMessage({ type: 'reject' });
  });
  btnOpen?.addEventListener('click', () => {
    vscode.postMessage({ type: 'openUrl' });
  });
  btnPostComment?.addEventListener('click', () => {
    const body = commentTextarea.value.trim();
    if (!body) { return; }
    vscode.postMessage({ type: 'postComment', body });
  });
  commentTextarea?.addEventListener('keydown', function(e) {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      const body = commentTextarea.value.trim();
      if (!body) { return; }
      vscode.postMessage({ type: 'postComment', body });
    }
  });

  function showInitError(msg) {
    document.body.innerHTML =
      '<div style="padding:24px;font-family:var(--vscode-font-family);color:var(--vscode-foreground)">' +
      '<h2 style="color:#f85149">Webview init error</h2>' +
      '<pre style="white-space:pre-wrap;color:#f85149;font-size:12px">' + msg + '</pre>' +
      '<p style="margin-top:12px;font-size:12px;color:var(--vscode-descriptionForeground)">Check Output panel → GitMerge for extension-side logs.</p>' +
      '</div>';
  }

  function onInit(mr, files) {
    currentFiles = Array.isArray(files) ? files : [];
    renderHeader(mr);
    renderFileList(currentFiles, mr);
    if (currentFiles.length > 0) {
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

  function filterFileList() {
    var q = (fileSearch ? fileSearch.value : '').toLowerCase().trim();
    var visible = 0;
    document.querySelectorAll('.file-item').forEach(function(el) {
      var fnameEl = el.querySelector('.fname');
      var fname = fnameEl ? fnameEl.textContent.toLowerCase() : '';
      var match = !q || fname.indexOf(q) !== -1;
      el.classList.toggle('search-hidden', !match);
      if (match) { visible++; }
    });
    if (noSearchResults) {
      noSearchResults.style.display = (visible === 0 && q) ? '' : 'none';
    }
  }

  fileSearch && fileSearch.addEventListener('input', filterFileList);

  function renderFileList(files, mr) {
    document.getElementById('file-count').textContent = String(files.length);
    if (fileSearch) { fileSearch.value = ''; }
    if (noSearchResults) { noSearchResults.style.display = 'none'; }
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

  // ─── Syntax highlighting ─────────────────────────────────────────────────
  // Lightweight tokeniser — covers JS/TS/JSX/TSX, Python, CSS/SCSS/LESS,
  // HTML/XML, JSON, Go, Rust, Java, C/C++/C#, PHP, Ruby, Shell, YAML,
  // Kotlin, Swift, Dart, SQL.  Falls back to plain-escaped text for unknown.

  var _hlCache = {};

  function langFromFilename(fname) {
    var ext = (fname || '').replace(/.*\./, '').toLowerCase();
    var map = {
      'js':'js','jsx':'js','mjs':'js','cjs':'js',
      'ts':'ts','tsx':'ts','mts':'ts',
      'vue':'html','svelte':'html','html':'html','htm':'html','xml':'html','svg':'html','jsx':'jsx',
      'css':'css','scss':'css','sass':'css','less':'css',
      'json':'json','jsonc':'json','json5':'json',
      'py':'py','pyw':'py',
      'rb':'rb','erb':'rb',
      'go':'go',
      'rs':'rs',
      'java':'java',
      'kt':'kt','kts':'kt',
      'swift':'swift',
      'dart':'dart',
      'c':'c','cc':'c','cpp':'c','cxx':'c','h':'c','hpp':'c',
      'cs':'cs',
      'php':'php',
      'sh':'sh','bash':'sh','zsh':'sh',
      'yaml':'yaml','yml':'yaml',
      'sql':'sql',
      'md':'md','markdown':'md',
      'graphql':'graphql','gql':'graphql',
      'tf':'hcl','hcl':'hcl'
    };
    return map[ext] || 'plain';
  }

  // Tokenise a single line into safe HTML with span wrappers.
  // Uses a simple greedy scanner: tries each pattern in order, emits spans.
  function highlight(rawLine, lang) {
    if (!rawLine) { return ''; }
    if (lang === 'plain' || !lang) { return esc(rawLine); }

    // Cache key
    var ck = lang + '\x00' + rawLine;
    if (_hlCache[ck]) { return _hlCache[ck]; }

    var rules = getRules(lang);
    var out = tokenise(rawLine, rules);
    _hlCache[ck] = out;
    return out;
  }

  // Build token rules for each language family
  function getRules(lang) {
    // shared building blocks
    var STR_DQ  = { re: /"(?:[^"\\]|\\.)*"/, cls: 'tok-str' };
    var STR_SQ  = { re: /'(?:[^'\\]|\\.)*'/, cls: 'tok-str' };
    var STR_BT  = { re: /\x60(?:[^\x60\\]|\\.)*\x60/, cls: 'tok-str' };
    var NUM     = { re: /\b0x[\da-fA-F]+\b|\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b/, cls: 'tok-num' };
    var CMT_SL  = { re: /\/\/.*/, cls: 'tok-cmt' };
    var CMT_ML  = { re: /\/\*[\s\S]*?\*\//, cls: 'tok-cmt' };
    var CMT_HASH= { re: /#.*/, cls: 'tok-cmt' };

    if (lang === 'js' || lang === 'ts') {
      var KW = /\b(?:abstract|as|async|await|break|case|catch|class|const|constructor|continue|debugger|declare|default|delete|do|else|enum|export|extends|false|finally|for|from|function|get|if|implements|import|in|instanceof|interface|is|keyof|let|module|namespace|new|null|of|override|package|private|protected|public|readonly|return|set|static|super|switch|this|throw|true|try|type|typeof|undefined|var|void|while|with|yield)\b/;
      var FN  = { re: /\b([A-Za-z_$][\w$]*)\s*(?=\()/, cls: 'tok-fn', group: 1 };
      var CLS = { re: /\b([A-Z][A-Za-z0-9_$]*)/, cls: 'tok-cls', group: 1 };
      var DEC = { re: /@\w[\w.]*/, cls: 'tok-dec' };
      var RE_LIT = { re: /\/(?!\/)(?:[^/\\\n]|\\.)+\/[gimsuy]*/, cls: 'tok-re' };
      return [CMT_SL, CMT_ML, STR_BT, STR_DQ, STR_SQ, RE_LIT, DEC,
              {re: KW, cls:'tok-kw'}, NUM, FN, CLS];
    }
    if (lang === 'py') {
      var KW_PY = /\b(?:False|None|True|and|as|assert|async|await|break|class|continue|def|del|elif|else|except|finally|for|from|global|if|import|in|is|lambda|nonlocal|not|or|pass|raise|return|try|while|with|yield)\b/;
      var STR_TR3D = { re: /"""[\s\S]*?"""/, cls: 'tok-str' };
      var STR_TR3S = { re: /'''[\s\S]*?'''/, cls: 'tok-str' };
      var DEC_PY   = { re: /@\w[\w.]*/, cls: 'tok-dec' };
      var FN_PY    = { re: /\bdef\s+([A-Za-z_]\w*)/, cls: 'tok-fn', group: 1, after: 'tok-kw' };
      var CLS_PY   = { re: /\bclass\s+([A-Za-z_]\w*)/, cls: 'tok-cls', group: 1, after: 'tok-kw' };
      return [CMT_HASH, STR_TR3D, STR_TR3S, STR_DQ, STR_SQ, DEC_PY,
              {re: KW_PY, cls:'tok-kw'}, NUM, FN_PY, CLS_PY];
    }
    if (lang === 'css') {
      var CMT_CSS = CMT_ML;
      var AT_RULE = { re: /@[\w-]+/, cls: 'tok-pp' };
      var CSS_SEL = { re: /[.#]?[A-Za-z_][\w-]*(?:\s*[,{>+~])/, cls: 'tok-sel' };
      var CSS_PROP= { re: /[\w-]+\s*(?=:)/, cls: 'tok-attr' };
      var CSS_VAL = { re: /:\s*[^;{}"'\n]+/, cls: 'tok-val' };
      var CSS_STR = { re: /"[^"]*"|'[^']*'/, cls: 'tok-str' };
      return [CMT_CSS, CSS_STR, AT_RULE, CSS_SEL, CSS_PROP, CSS_VAL, NUM];
    }
    if (lang === 'html') {
      var CMT_HTML = { re: /<!--[\s\S]*?-->/, cls: 'tok-cmt' };
      var TAG_OPEN = { re: /<\/?[A-Za-z][A-Za-z0-9:-]*/, cls: 'tok-tag' };
      var TAG_END  = { re: /\/?>/, cls: 'tok-tag' };
      var ATTR_NM  = { re: /\b[A-Za-z_:][A-Za-z0-9_:.-]*(?=\s*=)/, cls: 'tok-attr' };
      var ATTR_VAL = { re: /"[^"]*"|'[^']*'/, cls: 'tok-val' };
      var ENTITY   = { re: /&[A-Za-z0-9#]+;/, cls: 'tok-str' };
      return [CMT_HTML, TAG_OPEN, TAG_END, ATTR_NM, ATTR_VAL, ENTITY];
    }
    if (lang === 'json') {
      var KEY = { re: /"(?:[^"\\]|\\.)*"\s*:/, cls: 'tok-attr' };
      var JBOOL = { re: /\b(?:true|false|null)\b/, cls: 'tok-kw' };
      return [KEY, STR_DQ, JBOOL, NUM];
    }
    if (lang === 'go') {
      var KW_GO = /\b(?:break|case|chan|const|continue|default|defer|else|fallthrough|for|func|go|goto|if|import|interface|map|package|range|return|select|struct|switch|type|var)\b/;
      var FN_GO = { re: /\bfunc\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/, cls: 'tok-fn', group: 1 };
      var TY_GO = { re: /\b(?:bool|byte|complex64|complex128|error|float32|float64|int|int8|int16|int32|int64|rune|string|uint|uint8|uint16|uint32|uint64|uintptr)\b/, cls: 'tok-cls' };
      var STR_RAW = { re: /\x60[^\x60]*\x60/, cls: 'tok-str' };
      return [CMT_SL, CMT_ML, STR_RAW, STR_DQ, STR_SQ, {re: KW_GO, cls:'tok-kw'}, TY_GO, NUM, FN_GO];
    }
    if (lang === 'rs') {
      var KW_RS = /\b(?:as|async|await|break|const|continue|crate|dyn|else|enum|extern|false|fn|for|if|impl|in|let|loop|match|mod|move|mut|pub|ref|return|self|Self|static|struct|super|trait|true|type|union|unsafe|use|where|while|yield)\b/;
      var MAC_RS = { re: /\b\w+!(?=\s*[\[({"'])/, cls: 'tok-fn' };
      var LT_RS  = { re: /'[A-Za-z_]\w*/, cls: 'tok-dec' };
      var STR_RS = { re: /r#*"[\s\S]*?"#*/, cls: 'tok-str' };
      var ATT_RS = { re: /#!?\[.*?\]/, cls: 'tok-dec' };
      return [CMT_SL, CMT_ML, ATT_RS, STR_RS, STR_DQ, STR_SQ, LT_RS,
              {re: KW_RS, cls:'tok-kw'}, NUM, MAC_RS,
              { re: /\b([A-Z][A-Za-z0-9_]*)/, cls: 'tok-cls', group: 1 }];
    }
    if (lang === 'java' || lang === 'kotlin' || lang === 'kt') {
      var KW_J = /\b(?:abstract|assert|boolean|break|byte|case|catch|char|class|const|continue|default|do|double|else|enum|extends|final|finally|float|for|goto|if|implements|import|instanceof|int|interface|long|native|new|null|package|private|protected|public|return|short|static|strictfp|super|switch|synchronized|this|throw|throws|transient|true|try|void|volatile|while|fun|val|var|when|is|in|object|data|sealed|companion|inline|override|open|suspend|reified|crossinline|noinline|out|internal)\b/;
      var ANN_J = { re: /@[A-Za-z_]\w*/, cls: 'tok-dec' };
      return [CMT_SL, CMT_ML, STR_DQ, STR_SQ, ANN_J, {re: KW_J, cls:'tok-kw'}, NUM,
              { re: /\b([A-Z][A-Za-z0-9_]*)/, cls: 'tok-cls', group: 1 }];
    }
    if (lang === 'c' || lang === 'cs') {
      var KW_C = /\b(?:alignas|alignof|and|and_eq|asm|atomic_cancel|atomic_commit|atomic_noexcept|auto|bitand|bitor|bool|break|case|catch|char|char8_t|char16_t|char32_t|class|compl|concept|const|consteval|constexpr|constinit|const_cast|continue|co_await|co_return|co_yield|decltype|default|delete|do|double|dynamic_cast|else|enum|explicit|export|extern|false|float|for|friend|goto|if|inline|int|long|mutable|namespace|new|noexcept|not|not_eq|nullptr|operator|or|or_eq|private|protected|public|reflexpr|register|reinterpret_cast|requires|return|short|signed|sizeof|static|static_assert|static_cast|struct|switch|synchronized|template|this|thread_local|throw|true|try|typedef|typeid|typename|union|unsigned|using|virtual|void|volatile|wchar_t|while|xor|xor_eq|abstract|as|base|byte|checked|decimal|delegate|event|fixed|foreach|implicit|interface|internal|is|lock|object|out|override|params|readonly|ref|sbyte|sealed|stackalloc|string|typeof|uint|ulong|unchecked|unsafe|ushort|var|nameof|async|await|partial|yield)\b/;
      var PP_C = { re: /^\s*#\s*(?:include|define|undef|ifdef|ifndef|if|elif|else|endif|pragma|error|warning|line)\b.*/, cls: 'tok-pp' };
      return [CMT_SL, CMT_ML, PP_C, STR_DQ, STR_SQ, {re: KW_C, cls:'tok-kw'}, NUM,
              { re: /\b([A-Z][A-Za-z0-9_]*)/, cls: 'tok-cls', group: 1 }];
    }
    if (lang === 'php') {
      var KW_PHP = /\b(?:abstract|and|array|as|break|callable|case|catch|class|clone|const|continue|declare|default|die|do|echo|else|elseif|empty|enddeclare|endfor|endforeach|endif|endswitch|endwhile|eval|exit|extends|final|finally|fn|for|foreach|function|global|goto|if|implements|include|include_once|instanceof|insteadof|interface|isset|list|match|namespace|new|or|print|private|protected|public|readonly|require|require_once|return|static|switch|throw|trait|try|unset|use|var|while|xor|yield|null|true|false)\b/i;
      var PHP_VAR = { re: /\$[A-Za-z_]\w*/, cls: 'tok-attr' };
      return [CMT_SL, CMT_ML, {re:/\/\/.*|#.*/, cls:'tok-cmt'}, STR_DQ, STR_SQ,
              {re: KW_PHP, cls:'tok-kw'}, PHP_VAR, NUM];
    }
    if (lang === 'rb') {
      var KW_RB = /\b(?:__ENCODING__|__LINE__|__FILE__|BEGIN|END|alias|and|begin|break|case|class|def|defined\?|do|else|elsif|end|ensure|false|for|if|in|module|next|nil|not|or|redo|rescue|retry|return|self|super|then|true|undef|unless|until|when|while|yield)\b/;
      var SYM_RB = { re: /:\w+/, cls: 'tok-dec' };
      var STR_H  = { re: /<<[-~]?['"]?(\w+)['"]?.*/, cls: 'tok-str' };
      return [CMT_HASH, STR_DQ, STR_SQ, STR_BT, SYM_RB, {re: KW_RB, cls:'tok-kw'}, NUM,
              { re: /\bdef\s+([A-Za-z_]\w*[!?]?)/, cls: 'tok-fn', group: 1 }];
    }
    if (lang === 'sh') {
      var KW_SH = /\b(?:if|then|else|elif|fi|case|esac|while|until|for|do|done|in|function|return|exit|local|export|readonly|declare|typeset|unset|shift|exec|eval|trap|break|continue|select|time|coproc)\b/;
      var VAR_SH = { re: /\$\{?[\w#?@*!-]+\}?/, cls: 'tok-attr' };
      return [CMT_HASH, STR_DQ, STR_SQ, STR_BT, {re: KW_SH, cls:'tok-kw'}, VAR_SH, NUM];
    }
    if (lang === 'yaml') {
      var KEY_Y  = { re: /^(\s*[\w.-]+)\s*(?=:)/, cls: 'tok-attr', group: 1 };
      var ANC_Y  = { re: /[&*][A-Za-z_][\w-]*/, cls: 'tok-dec' };
      var BOOL_Y = { re: /\b(?:true|false|yes|no|null|~)\b/, cls: 'tok-kw' };
      return [{re: /^\s*#.*/, cls:'tok-cmt'}, STR_DQ, STR_SQ, ANC_Y, KEY_Y, BOOL_Y, NUM];
    }
    if (lang === 'sql') {
      var KW_SQL = /\b(?:ADD|ALL|ALTER|AND|AS|ASC|BETWEEN|BY|CASE|CHECK|COLUMN|CONSTRAINT|CREATE|CROSS|DATABASE|DEFAULT|DELETE|DESC|DISTINCT|DROP|ELSE|END|EXISTS|FOREIGN|FROM|FULL|GROUP|HAVING|IN|INDEX|INNER|INSERT|INTO|IS|JOIN|KEY|LEFT|LIKE|LIMIT|NOT|NULL|ON|OR|ORDER|OUTER|PRIMARY|REFERENCES|RIGHT|SELECT|SET|TABLE|THEN|TOP|TRUNCATE|UNION|UNIQUE|UPDATE|VALUES|VIEW|WHERE|WITH)\b/i;
      return [CMT_SL, CMT_ML, STR_DQ, STR_SQ, {re: KW_SQL, cls:'tok-kw'}, NUM];
    }
    if (lang === 'hcl') {
      var KW_HCL = /\b(?:resource|data|variable|output|locals|module|provider|terraform|for_each|count|lifecycle|depends_on|provisioner|connection|for|in|if|else|true|false|null)\b/;
      return [CMT_HASH, CMT_SL, CMT_ML, STR_DQ, {re: KW_HCL, cls:'tok-kw'}, NUM,
              { re: /\b([A-Za-z_]\w*)\s*(?=\s*{)/, cls: 'tok-fn', group: 1 }];
    }
    if (lang === 'graphql') {
      var KW_GQL = /\b(?:query|mutation|subscription|fragment|on|directive|schema|scalar|type|interface|union|enum|input|extend|implements|true|false|null)\b/;
      return [CMT_HASH, STR_DQ, {re: KW_GQL, cls:'tok-kw'}, NUM,
              { re: /\b([A-Z][A-Za-z0-9_]*)/, cls: 'tok-cls', group: 1 }];
    }
    if (lang === 'swift') {
      var KW_SW = /\b(?:actor|associatedtype|async|await|break|case|catch|class|continue|default|defer|deinit|do|else|enum|extension|fallthrough|false|fileprivate|final|for|func|get|guard|if|import|in|init|inout|internal|is|lazy|let|mutating|nil|nonmutating|open|operator|override|precedencegroup|private|protocol|public|repeat|required|rethrows|return|set|some|static|struct|subscript|super|switch|throw|throws|true|try|type|typealias|unowned|var|weak|where|while)\b/;
      var ATT_SW = { re: /@\w+/, cls: 'tok-dec' };
      return [CMT_SL, CMT_ML, STR_DQ, STR_SQ, ATT_SW, {re: KW_SW, cls:'tok-kw'}, NUM,
              { re: /\b([A-Z][A-Za-z0-9_]*)/, cls: 'tok-cls', group: 1 }];
    }
    if (lang === 'dart') {
      var KW_DT = /\b(?:abstract|as|assert|async|await|break|case|catch|class|const|continue|covariant|default|deferred|do|dynamic|else|enum|export|extends|extension|external|factory|false|final|finally|for|Function|get|hide|if|implements|import|in|interface|is|late|library|mixin|new|null|on|operator|part|required|rethrow|return|set|show|static|super|switch|sync|this|throw|true|try|typedef|var|void|while|with|yield)\b/;
      return [CMT_SL, CMT_ML, STR_DQ, STR_SQ, STR_BT, {re: KW_DT, cls:'tok-kw'}, NUM,
              { re: /\b([A-Z][A-Za-z0-9_]*)/, cls: 'tok-cls', group: 1 }];
    }
    // markdown: just bold, inline code, headers
    if (lang === 'md') {
      return [
        { re: /^#{1,6}\s.*/, cls: 'tok-kw' },
        { re: /\*\*[^*]+\*\*|__[^_]+__/, cls: 'tok-fn' },
        { re: /\x60[^\x60]+\x60/, cls: 'tok-str' }
      ];
    }
    return [];
  }

  // Greedy scanner: scan rawLine left to right, apply first matching rule at each pos
  function tokenise(rawLine, rules) {
    if (!rules || !rules.length) { return esc(rawLine); }
    var out = '';
    var pos = 0;
    var safety = 0;
    while (pos < rawLine.length) {
      if (++safety > 5000) { out += esc(rawLine.slice(pos)); break; }
      var best = null, bestIdx = rawLine.length, bestRule = null;
      for (var r = 0; r < rules.length; r++) {
        var rule = rules[r];
        var re = new RegExp(rule.re.source, rule.re.flags ? rule.re.flags.replace('g','') : '');
        re.lastIndex = 0;
        var src = rawLine.slice(pos);
        var m = re.exec(src);
        if (m && (pos + m.index) < bestIdx) {
          bestIdx   = pos + m.index;
          best = m;
          bestRule  = rule;
        }
      }
      if (!bestRule || bestIdx >= rawLine.length) {
        out += esc(rawLine.slice(pos));
        break;
      }
      // Emit plain text before match
      if (bestIdx > pos) { out += esc(rawLine.slice(pos, bestIdx)); }
      // Emit token
      var matchText = best[0];
      var tokenText = (bestRule.group != null) ? best[bestRule.group] : matchText;
      var beforeToken = (bestRule.group != null) ? matchText.slice(0, best.index + (best.indices ? 0 : matchText.indexOf(tokenText))) : '';
      if (bestRule.group != null) {
        // Highlight only the captured group, plain-output the rest of the match
        var fullMatch = matchText;
        var captured  = tokenText;
        var capStart  = fullMatch.indexOf(captured);
        out += esc(fullMatch.slice(0, capStart));
        out += '<span class="' + bestRule.cls + '">' + esc(captured) + '</span>';
        out += esc(fullMatch.slice(capStart + captured.length));
      } else {
        out += '<span class="' + bestRule.cls + '">' + esc(tokenText) + '</span>';
      }
      pos = bestIdx + matchText.length;
    }
    return out;
  }

  // ─── Diff rendering ───────────────────────────────────────────────────────
  function renderDiff(file) {
    const empty       = document.getElementById('diff-empty');
    const beforeTable = document.getElementById('before-table');
    const afterTable  = document.getElementById('after-table');
    const beforeBody  = document.getElementById('before-body');
    const afterBody   = document.getElementById('after-body');

    if (!file.patch) {
      empty.style.display = '';
      empty.textContent = file.status === 'added'
        ? 'New file — no diff available'
        : file.status === 'deleted'
          ? 'File deleted'
          : 'Binary file or no diff available';
      beforeTable.style.display = 'none';
      afterTable.style.display  = 'none';
      return;
    }

    const rows = parsePatch(file.patch);
    if (rows.length === 0) {
      empty.style.display = '';
      empty.textContent = 'No changes';
      beforeTable.style.display = 'none';
      afterTable.style.display  = 'none';
      return;
    }

    empty.style.display = 'none';
    beforeTable.style.display = '';
    afterTable.style.display  = '';
    beforeBody.innerHTML = '';
    afterBody.innerHTML  = '';

    var lang = langFromFilename(file.filename);
    const bFrag = document.createDocumentFragment();
    const aFrag = document.createDocumentFragment();
    rows.forEach(function(row) {
      const pair = buildRowEls(row, lang);
      bFrag.appendChild(pair.before);
      aFrag.appendChild(pair.after);
    });
    beforeBody.appendChild(bFrag);
    afterBody.appendChild(aFrag);
  }

  function buildRowEls(row, lang) {
    const trB = document.createElement('tr');
    const trA = document.createElement('tr');

    if (row.type === 'hunk') {
      trB.className = 'row-hunk';
      trA.className = 'row-hunk';
      trB.innerHTML = '<td colspan="2">' + esc(row.hunkHeader || '') + '</td>';
      trA.innerHTML = '<td colspan="2">' + esc(row.hunkHeader || '') + '</td>';
      return { before: trB, after: trA };
    }

    const lnB   = document.createElement('td');
    const codeB = document.createElement('td');
    lnB.className   = 'ln';
    codeB.className = 'code';

    const lnA   = document.createElement('td');
    const codeA = document.createElement('td');
    lnA.className   = 'ln';
    codeA.className = 'code';

    if (row.leftType === 'remove') {
      trB.className = 'row-del';
      trA.className = 'row-empty';
      lnB.className += ' ln-del';
      lnB.textContent  = String(row.leftLineNum || '');
      codeB.innerHTML  = highlight(row.leftContent || '', lang);
      lnA.textContent  = '';
      codeA.textContent = '';
    } else if (row.rightType === 'add') {
      trB.className = 'row-empty';
      trA.className = 'row-add';
      lnA.className += ' ln-add';
      lnB.textContent  = '';
      codeB.textContent = '';
      lnA.textContent  = String(row.rightLineNum || '');
      codeA.innerHTML  = highlight(row.rightContent || '', lang);
    } else {
      // context
      lnB.textContent  = row.leftLineNum  ? String(row.leftLineNum)  : '';
      codeB.innerHTML  = highlight(row.leftContent  || '', lang);
      lnA.textContent  = row.rightLineNum ? String(row.rightLineNum) : '';
      codeA.innerHTML  = highlight(row.rightContent || '', lang);
    }

    trB.appendChild(lnB);
    trB.appendChild(codeB);
    trA.appendChild(lnA);
    trA.appendChild(codeA);
    return { before: trB, after: trA };
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
    document.getElementById('ai-streaming').style.display = 'block';
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
    contentEl.style.display = 'block';
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
    contentEl.style.display = 'block';
    contentEl.innerHTML = '<p style="color:#f85149"><strong>Analysis failed:</strong> ' + esc(error) + '</p>';
    btnAnalyze.disabled = false;
    btnAnalyze.innerHTML = '<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M8 .25a.75.75 0 0 1 .673.418l1.882 3.815 4.21.612a.75.75 0 0 1 .416 1.279l-3.046 2.97.719 4.192a.751.751 0 0 1-1.088.791L8 12.347l-3.766 1.98a.75.75 0 0 1-1.088-.79l.72-4.194L.818 6.374a.75.75 0 0 1 .416-1.28l4.21-.611L7.327.668A.75.75 0 0 1 8 .25z"/></svg> Retry';
    btnCancel.style.display = 'none';
  }

  // ─── Comment ──────────────────────────────────────────────────────────────
  function onCommentStart() {
    btnPostComment.disabled = true;
    btnPostComment.innerHTML = '<span class="spinner"></span> Posting...';
    commentStatus.textContent = '';
  }

  function onCommentDone() {
    btnPostComment.disabled = false;
    btnPostComment.innerHTML =
      '<svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor"><path d="M1.5 2.75a.25.25 0 0 1 .25-.25h12.5a.25.25 0 0 1 .25.25v8.5a.25.25 0 0 1-.25.25h-6.5a.75.75 0 0 0-.53.22L4.5 14.44v-2.19a.75.75 0 0 0-.75-.75H1.75a.25.25 0 0 1-.25-.25Zm.25-1.75C.784 1 0 1.784 0 2.75v8.5C0 12.216.784 13 1.75 13H3v2.25a.75.75 0 0 0 1.28.53l2.69-2.78H14.25c.966 0 1.75-.784 1.75-1.75v-8.5C16 1.784 15.216 1 14.25 1Z"/></svg>' +
      ' Post Comment';
    commentStatus.innerHTML = '<span style="color:#3fb950">✓ Comment posted!</span>';
    commentTextarea.value = '';
    setTimeout(function() { commentStatus.textContent = ''; }, 3000);
  }

  function onCommentError(error) {
    btnPostComment.disabled = false;
    btnPostComment.innerHTML =
      '<svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor"><path d="M1.5 2.75a.25.25 0 0 1 .25-.25h12.5a.25.25 0 0 1 .25.25v8.5a.25.25 0 0 1-.25.25h-6.5a.75.75 0 0 0-.53.22L4.5 14.44v-2.19a.75.75 0 0 0-.75-.75H1.75a.25.25 0 0 1-.25-.25Zm.25-1.75C.784 1 0 1.784 0 2.75v8.5C0 12.216.784 13 1.75 13H3v2.25a.75.75 0 0 0 1.28.53l2.69-2.78H14.25c.966 0 1.75-.784 1.75-1.75v-8.5C16 1.784 15.216 1 14.25 1Z"/></svg>' +
      ' Post Comment';
    commentStatus.innerHTML = '<span style="color:#f85149">✗ ' + esc(error) + '</span>';
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
      return '__CB_' + idx + '__';
    });

    // Save inline code
    var inlineCodes = [];
    processed = processed.replace(/\x60([^\x60\n]+)\x60/g, function(_, code) {
      var idx = inlineCodes.length;
      inlineCodes.push('<code>' + esc(code) + '</code>');
      return '__IC_' + idx + '__';
    });

    // Escape remaining HTML entities
    processed = esc(processed);

    // Restore placeholders that were escaped
    processed = processed.replace(/__CB_(\d+)__/g, function(_, i) { return codeBlocks[parseInt(i)]; });
    processed = processed.replace(/__IC_(\d+)__/g, function(_, i) { return inlineCodes[parseInt(i)]; });

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
