import type { AnnotationSide, SelectedLineRange } from '@pierre/diffs';

// Identifies a PR-shaped GitHub path so the client only enables comment
// posting on pulls. Commits and compares have no equivalent line-comment API
// surface and stay client-only drafts.
const GITHUB_PULL_PATH_PATTERN = /^\/([^/]+)\/([^/]+)\/pull\/(\d+)$/;

export interface GitHubPullIdentity {
  owner: string;
  repo: string;
  pullNumber: number;
}

export function parsePullIdentityFromPath(
  path: string
): GitHubPullIdentity | undefined {
  const match = GITHUB_PULL_PATH_PATTERN.exec(path);
  if (match == null) {
    return undefined;
  }
  return {
    owner: match[1] ?? '',
    repo: match[2] ?? '',
    pullNumber: Number.parseInt(match[3] ?? '0', 10),
  };
}

export interface SubmitDraftCommentParams {
  pull: GitHubPullIdentity;
  filePath: string;
  body: string;
  lineNumber: number;
  side: AnnotationSide;
  range: SelectedLineRange;
}

export interface SubmitDraftCommentResult {
  id: number;
  htmlUrl: string;
  author: string;
  avatarUrl: string;
}

// POSTs a draft annotation to the local /api/comment route, which forwards to
// the GitHub PR review comments endpoint. Throws with a user-facing message on
// any failure so the caller can surface it via a toast.
export async function submitDraftCommentToGitHub(
  params: SubmitDraftCommentParams
): Promise<SubmitDraftCommentResult> {
  const side: 'RIGHT' | 'LEFT' = params.side === 'additions' ? 'RIGHT' : 'LEFT';
  const requestBody: Record<string, unknown> = {
    owner: params.pull.owner,
    repo: params.pull.repo,
    pullNumber: params.pull.pullNumber,
    body: params.body,
    path: params.filePath,
    line: params.lineNumber,
    side,
  };

  // GitHub rejects start_line equal to line. Only forward a multi-line range
  // when start and end are actually distinct lines.
  const rangeStart = Math.min(params.range.start, params.range.end);
  const rangeEnd = Math.max(params.range.start, params.range.end);
  if (rangeStart !== rangeEnd && rangeStart !== params.lineNumber) {
    requestBody.startLine = rangeStart;
    requestBody.startSide = side;
  }

  let response: Response;
  try {
    response = await fetch('/api/comment', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody),
    });
  } catch {
    throw new Error('Could not reach the comment server.');
  }

  if (!response.ok) {
    const message = await extractErrorMessage(response);
    throw new Error(
      message ?? `Comment submit failed (HTTP ${response.status}).`
    );
  }

  const json = (await response.json()) as Partial<SubmitDraftCommentResult>;
  if (
    typeof json.id !== 'number' ||
    typeof json.htmlUrl !== 'string' ||
    typeof json.author !== 'string' ||
    typeof json.avatarUrl !== 'string'
  ) {
    throw new Error('Unexpected response from comment server.');
  }
  return {
    id: json.id,
    htmlUrl: json.htmlUrl,
    author: json.author,
    avatarUrl: json.avatarUrl,
  };
}

async function extractErrorMessage(
  response: Response
): Promise<string | undefined> {
  try {
    const json = (await response.json()) as { error?: unknown };
    if (typeof json.error === 'string' && json.error.length > 0) {
      return json.error;
    }
  } catch {
    // Fall through.
  }
  return undefined;
}
