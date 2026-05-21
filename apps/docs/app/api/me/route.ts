const GITHUB_API_HOST = 'api.github.com';
const GITHUB_API_VERSION = '2022-11-28';
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;

interface GitHubViewer {
  login: string;
  avatarUrl: string;
}

// Module-level cache. The dev server runs as a long-lived process and the
// authenticated user does not change while it is running, so the very first
// /api/me call kicks off the upstream fetch and every subsequent request
// shares the resolved promise. A rejected fetch is not cached; the next
// request retries.
let viewerCachePromise: Promise<GitHubViewer> | undefined;

// Returns the authenticated GitHub user (login + avatar URL) so the client
// can attribute draft comments to the real viewer instead of a random local
// persona. Local-only by intent; gated on GITHUB_TOKEN being set.
export async function GET(): Promise<Response> {
  if (GITHUB_TOKEN == null || GITHUB_TOKEN === '') {
    return Response.json(
      {
        error:
          'GITHUB_TOKEN is not set. Add it to apps/docs/.env.local to identify the viewer.',
      },
      { status: 503 }
    );
  }

  try {
    const viewer = await getCachedViewer();
    return Response.json(viewer);
  } catch (error) {
    return Response.json(
      {
        error:
          error instanceof Error ? error.message : 'Failed to load viewer.',
      },
      { status: 502 }
    );
  }
}

function getCachedViewer(): Promise<GitHubViewer> {
  viewerCachePromise ??= fetchViewer().catch((error) => {
    viewerCachePromise = undefined;
    throw error;
  });
  return viewerCachePromise;
}

async function fetchViewer(): Promise<GitHubViewer> {
  const response = await fetch(`https://${GITHUB_API_HOST}/user`, {
    cache: 'no-store',
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${GITHUB_TOKEN}`,
      'User-Agent': 'pierre-diffshub',
      'X-GitHub-Api-Version': GITHUB_API_VERSION,
    },
  });
  if (!response.ok) {
    throw new Error(
      `GitHub /user returned ${response.status} ${response.statusText}.`
    );
  }
  const data = (await response.json()) as {
    login?: unknown;
    avatar_url?: unknown;
  };
  if (typeof data.login !== 'string' || typeof data.avatar_url !== 'string') {
    throw new Error('GitHub /user returned an unexpected shape.');
  }
  return { login: data.login, avatarUrl: data.avatar_url };
}
