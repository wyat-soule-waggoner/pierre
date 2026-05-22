import { type NextRequest } from 'next/server';

const GITHUB_API_HOST = 'api.github.com';
const GITHUB_API_VERSION = '2022-11-28';
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;

// Deletes a PR review comment from GitHub. The comment id is a URL segment;
// owner/repo come from the JSON body since GitHub's delete endpoint is
// scoped to the repo even though the comment id is globally unique. Returns
// 204 on success, JSON error otherwise.
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  if (GITHUB_TOKEN == null || GITHUB_TOKEN === '') {
    return jsonError(
      'GITHUB_TOKEN is not set. Add it to apps/docs/.env.local to delete PR comments.',
      503
    );
  }

  const { id } = await params;
  const commentId = Number.parseInt(id, 10);
  if (!Number.isInteger(commentId) || commentId <= 0) {
    return jsonError('Invalid comment id.', 400);
  }

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return jsonError('Invalid JSON body.', 400);
  }
  if (typeof payload !== 'object' || payload === null) {
    return jsonError('owner and repo are required.', 400);
  }
  const { owner, repo } = payload as Record<string, unknown>;
  if (typeof owner !== 'string' || typeof repo !== 'string') {
    return jsonError('owner and repo are required.', 400);
  }

  let response: Response;
  try {
    response = await fetch(
      `https://${GITHUB_API_HOST}/repos/${owner}/${repo}/pulls/comments/${commentId}`,
      {
        method: 'DELETE',
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${GITHUB_TOKEN}`,
          'User-Agent': 'pierre-diffshub',
          'X-GitHub-Api-Version': GITHUB_API_VERSION,
        },
        signal: request.signal,
      }
    );
  } catch {
    return jsonError('Failed to reach GitHub.', 502);
  }

  if (!response.ok) {
    let message: string | undefined;
    try {
      const json = (await response.json()) as { message?: unknown };
      if (typeof json.message === 'string') {
        message = `GitHub: ${json.message}`;
      }
    } catch {
      // Fall through.
    }
    return jsonError(
      message ?? `GitHub rejected delete (${response.status}).`,
      response.status >= 400 && response.status < 600 ? response.status : 502
    );
  }

  return new Response(null, { status: 204 });
}

function jsonError(message: string, status: number): Response {
  return Response.json({ error: message }, { status });
}
