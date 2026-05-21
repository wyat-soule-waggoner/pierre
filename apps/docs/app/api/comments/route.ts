import { type NextRequest } from 'next/server';

const GITHUB_API_HOST = 'api.github.com';
const GITHUB_API_VERSION = '2022-11-28';
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const MAX_PAGES = 10;
const PER_PAGE = 100;

interface LoadedComment {
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

// Lists existing PR review comments so the client can render them inline
// alongside any new drafts. Skips outdated comments (where GitHub's `line` is
// null) since we have no good anchor for them in the current diff.
export async function GET(request: NextRequest): Promise<Response> {
  if (GITHUB_TOKEN == null || GITHUB_TOKEN === '') {
    return jsonError(
      'GITHUB_TOKEN is not set. Add it to apps/docs/.env.local to load PR comments.',
      503
    );
  }

  const searchParams = request.nextUrl.searchParams;
  const owner = searchParams.get('owner');
  const repo = searchParams.get('repo');
  const pullNumberRaw = searchParams.get('pullNumber');
  if (owner == null || repo == null || pullNumberRaw == null) {
    return jsonError('owner, repo, and pullNumber are required.', 400);
  }
  const pullNumber = Number.parseInt(pullNumberRaw, 10);
  if (!Number.isInteger(pullNumber) || pullNumber <= 0) {
    return jsonError('pullNumber must be a positive integer.', 400);
  }

  try {
    const comments = await fetchAllComments(
      owner,
      repo,
      pullNumber,
      request.signal
    );
    return Response.json({ comments });
  } catch (error) {
    return jsonError(
      error instanceof Error ? error.message : 'Failed to load comments.',
      502
    );
  }
}

async function fetchAllComments(
  owner: string,
  repo: string,
  pullNumber: number,
  signal: AbortSignal
): Promise<LoadedComment[]> {
  const out: LoadedComment[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const response = await fetch(
      `https://${GITHUB_API_HOST}/repos/${owner}/${repo}/pulls/${pullNumber}/comments?per_page=${PER_PAGE}&page=${page}`,
      {
        cache: 'no-store',
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${GITHUB_TOKEN}`,
          'User-Agent': 'pierre-diffshub',
          'X-GitHub-Api-Version': GITHUB_API_VERSION,
        },
        signal,
      }
    );
    if (!response.ok) {
      throw new Error(
        `GitHub returned ${response.status} ${response.statusText}.`
      );
    }
    const json = (await response.json()) as unknown;
    if (!Array.isArray(json)) {
      throw new Error('GitHub returned an unexpected response shape.');
    }
    for (const raw of json) {
      const parsed = parseComment(raw);
      if (parsed != null) {
        out.push(parsed);
      }
    }
    if (json.length < PER_PAGE) {
      break;
    }
  }
  return out;
}

function parseComment(raw: unknown): LoadedComment | undefined {
  if (typeof raw !== 'object' || raw === null) {
    return undefined;
  }
  const data = raw as Record<string, unknown>;
  const id = data.id;
  const htmlUrl = data.html_url;
  const body = data.body;
  const path = data.path;
  const side = data.side;
  const line = data.line;
  const startLine = data.start_line;
  const startSide = data.start_side;
  const user = data.user;
  if (
    typeof id !== 'number' ||
    typeof htmlUrl !== 'string' ||
    typeof body !== 'string' ||
    typeof path !== 'string' ||
    (side !== 'RIGHT' && side !== 'LEFT') ||
    typeof line !== 'number'
  ) {
    return undefined;
  }
  if (typeof user !== 'object' || user === null) {
    return undefined;
  }
  const userData = user as Record<string, unknown>;
  const author = userData.login;
  const avatarUrl = userData.avatar_url;
  if (typeof author !== 'string' || typeof avatarUrl !== 'string') {
    return undefined;
  }

  const result: LoadedComment = {
    id,
    htmlUrl,
    author,
    avatarUrl,
    body,
    path,
    side,
    line,
  };
  if (
    typeof startLine === 'number' &&
    Number.isInteger(startLine) &&
    startLine > 0 &&
    startLine !== line
  ) {
    result.startLine = startLine;
    if (startSide === 'RIGHT' || startSide === 'LEFT') {
      result.startSide = startSide;
    }
  }
  return result;
}

function jsonError(message: string, status: number): Response {
  return Response.json({ error: message }, { status });
}
