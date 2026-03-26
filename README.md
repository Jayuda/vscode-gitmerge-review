# GitMerge Review

A VS Code extension to review GitHub Pull Requests and GitLab Merge Requests directly inside the editor — with side-by-side diffs and AI-powered code analysis.

---

## Features

| Feature | Description |
|---|---|
| **Sidebar Explorer** | Lists open PRs/MRs for every GitHub/GitLab repo detected in your workspace |
| **Side-by-side Diff** | Full two-column diff viewer with added/removed line highlights and line numbers |
| **AI Analysis** | Uses GitHub Copilot (VS Code LM API) to review the entire changeset and give a structured recommendation |
| **Merge / Reject** | Merge or close/reject the MR with a single click — confirmation dialog included |
| **Multi-provider** | Supports GitHub.com, GitLab.com, and self-hosted GitLab instances |
| **Auto-refresh** | Configurable poll interval to keep the list up to date |

---

## Setup

### 1. Install the extension
Press **F5** in the project folder to open an Extension Development Host.

### 2. Set your tokens
Open the Command Palette (`⌘⇧P`) and run:

- **GitMerge: Set GitHub Token** — enter a GitHub PAT with `repo` scope
- **GitMerge: Set GitLab Token** — enter a GitLab PAT with `api` scope

Tokens are stored securely via VS Code's built-in Secret Storage (never in plaintext settings).

### 3. Self-hosted GitLab
In Settings → GitMerge Review, change **Gitlab Url** to your instance, e.g. `https://gitlab.mycompany.com`.

### 4. AI Analysis
Requires the **GitHub Copilot** extension to be installed and authenticated. Click the **"Analyze with AI"** button in the right-side AI panel.

---

## Extension Settings

| Setting | Default | Description |
|---|---|---|
| `gitmerge.gitlabUrl` | `https://gitlab.com` | GitLab instance URL |
| `gitmerge.autoRefresh` | `true` | Periodically refresh the MR list |
| `gitmerge.refreshInterval` | `5` | Refresh interval in minutes |
| `gitmerge.showMergedRequests` | `false` | Also show merged/closed MRs |
| `gitmerge.aiModel` | `gpt-4o` | Copilot model family for analysis |

---

## Required Token Scopes

**GitHub PAT:**  `repo` (read/write pull requests)

**GitLab PAT:**  `api` (full API access)

---

## Architecture

```
src/
├── extension.ts                  # Activation, command registration
├── models/types.ts               # Shared TypeScript interfaces
├── utils/httpClient.ts           # Minimal Node.js HTTPS wrapper
├── services/
│   ├── githubService.ts          # GitHub REST API v3
│   ├── gitlabService.ts          # GitLab REST API v4
│   └── aiService.ts              # VS Code Language Model API (Copilot)
├── providers/
│   └── mergeRequestProvider.ts   # TreeView data provider + repo detection
└── panels/
    └── mergeRequestPanel.ts      # Webview panel (diff UI + AI panel)
```
