import { type NextRequest } from 'next/server';

const GITHUB_API_HOST = 'api.github.com';
const GITHUB_API_VERSION = '2022-11-28';
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;

interface SubmitCommentRequest {
  owner: string;
  repo: string;
  pullNumber: number;
  body: string;
  path: string;
  line: number;
  side: 'RIGHT' | 'LEFT';
  startLine?: number;
  startSide?: 'RIGHT' | 'LEFT';
}

interface SubmitCommentResponse {
  id: number;
  htmlUrl: string;
  author: string;
  avatarUrl: string;
}

// Posts a draft annotation to GitHub as a real PR review comment. Fetches the
// PR's head SHA server-side (GitHub requires `commit_id` to be a SHA from the
// PR's commit history), then forwards the comment payload. Both calls use the
// PAT in GITHUB_TOKEN; the route is only meant for local self-hosted use.
export async function POST(request: NextRequest): Promise<Response> {
  if (GITHUB_TOKEN == null || GITHUB_TOKEN === '') {
    return jsonError(
      'GITHUB_TOKEN is not set. Add it to apps/docs/.env.local to enable comment posting.',
      503
    );
  }

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return jsonError('Invalid JSON body.', 400);
  }

  const parsed = parseSubmitCommentRequest(payload);
  if (parsed == null) {
    return jsonError('Invalid comment payload.', 400);
  }

  const headSha = await fetchPullRequestHeadSha(
    parsed.owner,
    parsed.repo,
    parsed.pullNumber,
    request.signal
  );
  if (headSha == null) {
    return jsonError('Could not fetch PR head SHA from GitHub.', 502);
  }

  const githubBody: Record<string, unknown> = {
    body: parsed.body,
    commit_id: headSha,
    path: parsed.path,
    line: parsed.line,
    side: parsed.side,
  };
  if (parsed.startLine != null && parsed.startLine !== parsed.line) {
    githubBody.start_line = parsed.startLine;
    githubBody.start_side = parsed.startSide ?? parsed.side;
  }

  let githubResponse: Response;
  try {
    githubResponse = await fetch(
      `https://${GITHUB_API_HOST}/repos/${parsed.owner}/${parsed.repo}/pulls/${parsed.pullNumber}/comments`,
      {
        method: 'POST',
        headers: getGitHubRequestHeaders(),
        body: JSON.stringify(githubBody),
        signal: request.signal,
      }
    );
  } catch {
    return jsonError('Failed to reach GitHub.', 502);
  }

  if (!githubResponse.ok) {
    const detail = await extractGitHubErrorMessage(githubResponse);
    return jsonError(
      detail ?? `GitHub rejected comment (${githubResponse.status}).`,
      githubResponse.status >= 400 && githubResponse.status < 600
        ? githubResponse.status
        : 502
    );
  }

  let githubJSON: unknown;
  try {
    githubJSON = await githubResponse.json();
  } catch {
    return jsonError('GitHub returned an unparseable response.', 502);
  }

  const result = parseGitHubCommentResponse(githubJSON);
  if (result == null) {
    return jsonError('GitHub returned an unexpected response shape.', 502);
  }

  return Response.json(result satisfies SubmitCommentResponse);
}

async function fetchPullRequestHeadSha(
  owner: string,
  repo: string,
  pullNumber: number,
  signal: AbortSignal
): Promise<string | undefined> {
  let response: Response;
  try {
    response = await fetch(
      `https://${GITHUB_API_HOST}/repos/${owner}/${repo}/pulls/${pullNumber}`,
      {
        cache: 'no-store',
        headers: getGitHubRequestHeaders(),
        signal,
      }
    );
  } catch {
    return undefined;
  }

  if (!response.ok) {
    return undefined;
  }

  let json: unknown;
  try {
    json = await response.json();
  } catch {
    return undefined;
  }

  if (
    typeof json === 'object' &&
    json !== null &&
    'head' in json &&
    typeof (json as { head: unknown }).head === 'object' &&
    (json as { head: unknown }).head !== null &&
    'sha' in (json as { head: { sha: unknown } }).head &&
    typeof (json as { head: { sha: unknown } }).head.sha === 'string'
  ) {
    return (json as { head: { sha: string } }).head.sha;
  }
  return undefined;
}

function getGitHubRequestHeaders(): Record<string, string> {
  return {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${GITHUB_TOKEN}`,
    'User-Agent': 'pierre-diffshub',
    'X-GitHub-Api-Version': GITHUB_API_VERSION,
  };
}

function parseSubmitCommentRequest(
  payload: unknown
): SubmitCommentRequest | undefined {
  if (typeof payload !== 'object' || payload === null) {
    return undefined;
  }
  const data = payload as Record<string, unknown>;
  const owner = data.owner;
  const repo = data.repo;
  const pullNumber = data.pullNumber;
  const body = data.body;
  const path = data.path;
  const line = data.line;
  const side = data.side;
  const startLine = data.startLine;
  const startSide = data.startSide;

  if (
    typeof owner !== 'string' ||
    typeof repo !== 'string' ||
    typeof pullNumber !== 'number' ||
    !Number.isInteger(pullNumber) ||
    pullNumber <= 0 ||
    typeof body !== 'string' ||
    body.trim().length === 0 ||
    typeof path !== 'string' ||
    typeof line !== 'number' ||
    !Number.isInteger(line) ||
    line <= 0 ||
    (side !== 'RIGHT' && side !== 'LEFT')
  ) {
    return undefined;
  }

  const result: SubmitCommentRequest = {
    owner,
    repo,
    pullNumber,
    body,
    path,
    line,
    side,
  };
  if (
    typeof startLine === 'number' &&
    Number.isInteger(startLine) &&
    startLine > 0
  ) {
    result.startLine = startLine;
  }
  if (startSide === 'RIGHT' || startSide === 'LEFT') {
    result.startSide = startSide;
  }
  return result;
}

function parseGitHubCommentResponse(
  json: unknown
): SubmitCommentResponse | undefined {
  if (typeof json !== 'object' || json === null) {
    return undefined;
  }
  const data = json as Record<string, unknown>;
  const user = data.user;
  if (typeof user !== 'object' || user === null) {
    return undefined;
  }
  const userData = user as Record<string, unknown>;
  const author = userData.login;
  const avatarUrl = userData.avatar_url;
  if (typeof author !== 'string' || typeof avatarUrl !== 'string') {
    return undefined;
  }
  const id = data.id;
  const htmlUrl = data.html_url;
  if (typeof id !== 'number' || typeof htmlUrl !== 'string') {
    return undefined;
  }
  return { id, htmlUrl, author, avatarUrl };
}

async function extractGitHubErrorMessage(
  response: Response
): Promise<string | undefined> {
  try {
    const json = (await response.json()) as { message?: unknown };
    if (typeof json.message === 'string' && json.message.length > 0) {
      return `GitHub: ${json.message}`;
    }
  } catch {
    // Fall through to undefined.
  }
  return undefined;
}

function jsonError(message: string, status: number): Response {
  return Response.json({ error: message }, { status });
}
