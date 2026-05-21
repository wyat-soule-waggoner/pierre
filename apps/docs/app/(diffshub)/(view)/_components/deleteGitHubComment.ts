'use client';

import type { GitHubPullIdentity } from './submitDraftCommentToGitHub';

// DELETEs a PR review comment via the local /api/comment/[id] proxy. Throws
// with a user-facing message so the caller can surface it via a toast.
export async function deleteGitHubComment(
  commentId: number,
  pull: Pick<GitHubPullIdentity, 'owner' | 'repo'>
): Promise<void> {
  let response: Response;
  try {
    response = await fetch(`/api/comment/${commentId}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ owner: pull.owner, repo: pull.repo }),
    });
  } catch {
    throw new Error('Could not reach the comment server.');
  }

  if (response.status === 204) {
    return;
  }

  try {
    const json = (await response.json()) as { error?: unknown };
    if (typeof json.error === 'string' && json.error.length > 0) {
      throw new Error(json.error);
    }
  } catch (error) {
    if (error instanceof Error && error.message.length > 0) {
      throw error;
    }
  }
  throw new Error(`Comment delete failed (HTTP ${response.status}).`);
}
