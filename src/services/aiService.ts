import * as vscode from 'vscode';
import { ChangedFile, MergeRequest } from '../models/types';

export type AnalysisChunkCallback = (chunk: string) => void;
export type AnalysisDoneCallback = () => void;

/**
 * Streams an AI analysis of the changed files in the given merge request.
 * Uses VS Code's built-in Language Model API (requires GitHub Copilot).
 * Calls onChunk for each streamed token, then onDone when finished.
 */
export async function analyzeChanges(
  mr: MergeRequest,
  files: ChangedFile[],
  onChunk: AnalysisChunkCallback,
  onDone: AnalysisDoneCallback,
  token: vscode.CancellationToken
): Promise<void> {
  const config = vscode.workspace.getConfiguration('gitmerge');
  const modelFamily: string = config.get('aiModel') ?? 'gpt-4o';

  // Pick the best available model
  const models = await vscode.lm.selectChatModels({ vendor: 'copilot', family: modelFamily });
  const model = models[0] ?? (await vscode.lm.selectChatModels({ vendor: 'copilot' }))[0];

  if (!model) {
    throw new Error(
      'No AI model available. Please install the GitHub Copilot extension and sign in.'
    );
  }

  const diffContent = buildDiffContent(files);

  const systemPrompt = `You are a senior software engineer performing a code review.
Analyze the provided code diff and give a structured review with these sections:

## Summary
A brief description of what this merge request does.

## Issues Found
List any bugs, logic errors, or problems. Use bullet points. Say "None found" if clean.

## Code Quality
Comment on readability, naming, complexity, and adherence to best practices.

## Security Concerns
Identify any security vulnerabilities (injection, auth issues, data exposure, etc.). Say "None found" if clean.

## Recommendation
End with one of:
✅ **APPROVE** — changes look good
⚠️ **APPROVE WITH SUGGESTIONS** — minor issues but can be merged
❌ **REQUEST CHANGES** — significant issues that should be fixed first

Be concise, specific, and constructive.`;

  const userPrompt = `Please review the following merge request:

**Title:** ${mr.title}
**Branch:** \`${mr.sourceBranch}\` → \`${mr.targetBranch}\`
**Author:** ${mr.author}
**Description:** ${mr.description || 'No description provided'}
**Stats:** +${mr.additions} additions, -${mr.deletions} deletions across ${files.length} files

---

${diffContent}`;

  const messages = [
    vscode.LanguageModelChatMessage.User(systemPrompt + '\n\n' + userPrompt),
  ];

  const response = await model.sendRequest(messages, {}, token);

  for await (const chunk of response.text) {
    if (token.isCancellationRequested) {
      break;
    }
    onChunk(chunk);
  }

  onDone();
}

function buildDiffContent(files: ChangedFile[]): string {
  const MAX_TOTAL_CHARS = 40_000; // stay within context window
  let total = 0;
  const parts: string[] = [];

  for (const file of files) {
    const header = `### ${file.filename} (${file.status}, +${file.additions} -${file.deletions})`;
    let body: string;

    if (!file.patch) {
      body = '_Binary file or no diff available_';
    } else {
      body = '```diff\n' + file.patch + '\n```';
    }

    const piece = header + '\n' + body + '\n\n';

    if (total + piece.length > MAX_TOTAL_CHARS) {
      parts.push(`### ${file.filename} _(diff truncated — file too large)_\n`);
      break;
    }

    parts.push(piece);
    total += piece.length;
  }

  return parts.join('');
}
