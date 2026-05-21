'use client';

import type { AnnotationSide, SelectedLineRange } from '@pierre/diffs';

import type { GitHubPullIdentity } from './submitDraftCommentToGitHub';

export interface LoadedPullComment {
  id: number;
  htmlUrl: string;
  author: string;
  avatarUrl: string;
  body: string;
  path: string;
  side: AnnotationSide;
  lineNumber: number;
  range: SelectedLineRange;
}

interface ServerCommentPayload {
  id: number;
  htmlUrl: string;
  author: string;
  avatarUrl: string;
  body: string;
  path: string;
  side: 'RIGHT' | 'LEFT';
  line: number;
  startLine?: number;
  startSide?: 'RIGHT' | 'LEFT';
}

// Fetches existing PR review comments via the local /api/comments proxy and
// reshapes them into the viewer's coordinate system (AnnotationSide,
// SelectedLineRange). Skips entries the server already filtered (outdated,
// missing line, unknown side) so callers can iterate without revalidating.
export async function loadGitHubPullComments(
  pull: GitHubPullIdentity,
  signal?: AbortSignal
): Promise<LoadedPullComment[]> {
  const searchParams = new URLSearchParams({
    owner: pull.owner,
    repo: pull.repo,
    pullNumber: String(pull.pullNumber),
  });
  const response = await fetch(`/api/comments?${searchParams}`, {
    cache: 'no-store',
    signal,
  });
  if (!response.ok) {
    const message = await extractErrorMessage(response);
    throw new Error(
      message ?? `Loading PR comments failed (HTTP ${response.status}).`
    );
  }
  const json = (await response.json()) as {
    comments?: ServerCommentPayload[];
  };
  if (!Array.isArray(json.comments)) {
    throw new Error('Unexpected response from comments server.');
  }
  return json.comments.map(toLoadedComment);
}

function toLoadedComment(payload: ServerCommentPayload): LoadedPullComment {
  const side: AnnotationSide =
    payload.side === 'RIGHT' ? 'additions' : 'deletions';
  const range: SelectedLineRange = {
    start: payload.startLine ?? payload.line,
    end: payload.line,
    side:
      payload.startSide != null
        ? payload.startSide === 'RIGHT'
          ? 'additions'
          : 'deletions'
        : side,
    endSide: side,
  };
  return {
    id: payload.id,
    htmlUrl: payload.htmlUrl,
    author: payload.author,
    avatarUrl: payload.avatarUrl,
    body: payload.body,
    path: payload.path,
    side,
    lineNumber: payload.line,
    range,
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
