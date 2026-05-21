import { type NextRequest } from 'next/server';

const CACHE_CONTROL = 'no-store';
const EMPTY_PATCH_MESSAGE = 'GitHub returned an empty diff.';
const GITHUB_API_HOST = 'api.github.com';
const GITHUB_HOST = 'github.com';
const GITHUB_RAW_DIFF_HOST = 'patch-diff.githubusercontent.com';
const GITHUB_DIFF_ACCEPT = 'application/vnd.github.v3.diff';
const NON_DIFF_RESPONSE_MESSAGE = 'GitHub did not return a diff for this URL.';
const NON_WHITESPACE_PATTERN = /\S/;
const RAW_GITHUB_DIFF_PATH_PATTERN =
  /^\/raw\/[^/]+\/[^/]+\/pull\/[^/]+\.(?:diff|patch)$/;
const GITHUB_PULL_TAB_PATH_PATTERN =
  /^\/([^/]+)\/([^/]+)\/pull\/(\d+)\/(?:changes|files)$/;
// Recognized GitHub path shapes for authenticated requests. The api.github.com
// REST endpoints want the resource id (pull number, commit sha, compare range)
// without any `.diff` / `.patch` suffix.
const GITHUB_PULL_NUMBER_PATTERN = /^\/([^/]+)\/([^/]+)\/pull\/(\d+)$/;
const GITHUB_COMMIT_SHA_PATTERN =
  /^\/([^/]+)\/([^/]+)\/commit\/([0-9a-f]{4,40})$/i;
const GITHUB_COMPARE_PATTERN = /^\/([^/]+)\/([^/]+)\/compare\/(.+)$/;

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;

const CACHED_BLOBS = new Map<string, string>([
  [
    '/nodejs/oven-sh/bun/pull/30412',
    'https://diffshub.pierrecdn.com/patches/30412.diff',
  ],
  [
    '/nodejs/node/pull/59805',
    'https://diffshub.pierrecdn.com/patches/59805.diff',
  ],
  [
    '/ghostty-org/ghostty/pull/12291',
    'https://diffshub.pierrecdn.com/patches/12291.diff',
  ],
  [
    '/pierrecomputer/pierre/commit/0800fb',
    'https://diffshub.pierrecdn.com/patches/0800fb.diff',
  ],
  [
    '/torvalds/linux/compare/v6.0...v7.0',
    'https://diffshub.pierrecdn.com/patches/v6.0-v7.0.diff',
  ],
]);

const HIDDEN_PATCH_DOMAIN_RULES = [
  { domainRoot: 'tangled.org', defaultExtension: '.patch' },
] as const;

interface ResolvedPatchRequest {
  patchURL: string;
  sourceURL?: string;
  requestHeaders?: Record<string, string>;
}

// Validates the accepted path or URL, normalizes it to a raw diff URL, and
// returns a streaming proxy response so the client can render files as they
// arrive instead of waiting for the full patch text.
export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams;
  const path = searchParams.get('path');
  const domain = searchParams.get('domain');
  const url = searchParams.get('url');

  if (path == null && url == null) {
    return createTextResponse('Path or URL parameter is required', {
      status: 400,
    });
  }

  try {
    // The client normally sends only the GitHub-relative path, but GitHub also
    // exposes raw PR diffs through patch-diff.githubusercontent.com. Tangled
    // paths use an explicit domain query parameter and are normalized to their
    // patch endpoint.
    const patchRequest = resolvePatchRequest(path, domain, url);
    if (patchRequest == null) {
      return createTextResponse('Invalid GitHub patch URL format', {
        status: 400,
      });
    }

    return await createPatchStreamResponse(
      patchRequest.patchURL,
      request.signal,
      {
        sourceURL: patchRequest.sourceURL ?? patchRequest.patchURL,
        requestHeaders: patchRequest.requestHeaders,
      }
    );
  } catch (error) {
    return createTextResponse(
      error instanceof Error ? error.message : 'Unknown error',
      { status: 500 }
    );
  }
}

// Resolves the accepted URL shapes to the exact upstream URL to fetch. Most
// callers send a GitHub-relative path, but this also permits GitHub's raw PR
// diff host and Tangled patch URLs without becoming a general URL fetcher.
function resolvePatchRequest(
  path: string | null,
  domain: string | null,
  url: string | null
): ResolvedPatchRequest | undefined {
  if (url != null) {
    return resolvePatchURLInput(url);
  }

  if (path == null) {
    return undefined;
  }

  if (domain != null) {
    const patchURL = resolveDomainPatchURL(domain, path);
    return patchURL == null ? undefined : { patchURL };
  }

  return resolvePatchURLInput(path);
}

function resolvePatchURLInput(input: string): ResolvedPatchRequest | undefined {
  if (input.startsWith('/')) {
    return resolveGitHubPatchRequest(input);
  }

  let parsedURL: URL;
  try {
    parsedURL = new URL(input);
  } catch {
    return undefined;
  }

  if (!isAllowedHTTPSURL(parsedURL)) {
    return undefined;
  }

  if (parsedURL.hostname === GITHUB_HOST) {
    return resolveGitHubPatchRequest(parsedURL.pathname);
  }

  if (
    parsedURL.hostname === GITHUB_RAW_DIFF_HOST &&
    RAW_GITHUB_DIFF_PATH_PATTERN.test(parsedURL.pathname)
  ) {
    return { patchURL: parsedURL.href };
  }

  const domainPatchURL = resolveDomainPatchURL(
    parsedURL.hostname,
    parsedURL.pathname
  );
  return domainPatchURL == null ? undefined : { patchURL: domainPatchURL };
}

function resolveGitHubPatchRequest(
  path: string
): ResolvedPatchRequest | undefined {
  if (path === '/') {
    return undefined;
  }

  const normalizedPath = normalizeGitHubPath(path);
  if (normalizedPath === '') {
    return undefined;
  }

  const blobPatchURL = CACHED_BLOBS.get(removeDiffExtension(normalizedPath));
  if (blobPatchURL != null) {
    return { patchURL: blobPatchURL };
  }

  if (GITHUB_TOKEN != null && GITHUB_TOKEN !== '') {
    const apiURL = resolveGitHubApiURL(normalizedPath);
    if (apiURL != null) {
      return {
        patchURL: apiURL,
        sourceURL: `https://${GITHUB_HOST}${normalizedPath}`,
        requestHeaders: {
          Accept: GITHUB_DIFF_ACCEPT,
          Authorization: `Bearer ${GITHUB_TOKEN}`,
        },
      };
    }
  }

  const anonymousPath =
    normalizedPath.endsWith('.diff') || normalizedPath.endsWith('.patch')
      ? normalizedPath
      : `${normalizedPath}.diff`;
  return { patchURL: `https://${GITHUB_HOST}${anonymousPath}` };
}

// Maps GitHub web paths onto the api.github.com REST endpoints whose `Accept:
// application/vnd.github.v3.diff` representation returns the same plaintext
// diff as the unauthenticated `.diff` URL. Only the three shapes we render are
// translated; everything else falls back to the anonymous path.
function resolveGitHubApiURL(normalizedPath: string): string | undefined {
  const pullMatch = GITHUB_PULL_NUMBER_PATTERN.exec(normalizedPath);
  if (pullMatch != null) {
    return `https://${GITHUB_API_HOST}/repos/${pullMatch[1]}/${pullMatch[2]}/pulls/${pullMatch[3]}`;
  }

  const commitMatch = GITHUB_COMMIT_SHA_PATTERN.exec(normalizedPath);
  if (commitMatch != null) {
    return `https://${GITHUB_API_HOST}/repos/${commitMatch[1]}/${commitMatch[2]}/commits/${commitMatch[3]}`;
  }

  const compareMatch = GITHUB_COMPARE_PATTERN.exec(normalizedPath);
  if (compareMatch != null) {
    return `https://${GITHUB_API_HOST}/repos/${compareMatch[1]}/${compareMatch[2]}/compare/${compareMatch[3]}`;
  }

  return undefined;
}

function resolveDomainPatchURL(
  domain: string,
  path: string
): string | undefined {
  const domainRule = getHiddenPatchDomainRule(domain);
  if (domainRule == null) {
    return undefined;
  }

  const pathWithLeadingSlash = path.startsWith('/') ? path : `/${path}`;
  const url = new URL(`https://${domainRule.hostname}`);
  const normalizedPath = pathWithLeadingSlash.replace(/\/+$/, '');
  url.pathname = normalizedPath === '' ? '/' : normalizedPath;
  if (!url.pathname.endsWith(domainRule.defaultExtension)) {
    url.pathname += domainRule.defaultExtension;
  }

  return url.href;
}

function getHiddenPatchDomainRule(
  domain: string
): { defaultExtension: string; hostname: string } | undefined {
  let hostname: string;
  try {
    hostname = new URL(`https://${domain}`).hostname;
  } catch {
    return undefined;
  }

  for (const domainRule of HIDDEN_PATCH_DOMAIN_RULES) {
    if (
      hostname === domainRule.domainRoot ||
      hostname.endsWith(`.${domainRule.domainRoot}`)
    ) {
      return { defaultExtension: domainRule.defaultExtension, hostname };
    }
  }

  return undefined;
}

function removeDiffExtension(path: string): string {
  if (path.endsWith('.patch')) {
    return path.slice(0, -'.patch'.length);
  }

  if (path.endsWith('.diff')) {
    return path.slice(0, -'.diff'.length);
  }

  return path;
}

function normalizeGitHubPath(path: string): string {
  const trimmedPath = path.replace(/\/+$/, '');
  const pullTabMatch = GITHUB_PULL_TAB_PATH_PATTERN.exec(trimmedPath);
  if (pullTabMatch == null) {
    return trimmedPath;
  }

  return `/${pullTabMatch[1]}/${pullTabMatch[2]}/pull/${pullTabMatch[3]}`;
}

function isAllowedHTTPSURL(url: URL): boolean {
  return (
    url.protocol === 'https:' &&
    url.port === '' &&
    url.username === '' &&
    url.password === ''
  );
}

// Accepts the plaintext content types diff/patch responses come back as. The
// anonymous github.com `.diff` endpoint returns `text/plain`; the
// api.github.com REST endpoints with `Accept: application/vnd.github.v3.diff`
// return that media type instead. Anything else (HTML error pages, JSON
// payloads from a misrouted call) is treated as a non-diff response.
function isAcceptedPatchContentType(contentType: string): boolean {
  return (
    contentType.startsWith('text/plain') ||
    contentType.startsWith('application/vnd.github')
  );
}

interface TextResponseOptions {
  status?: number;
  sourceURL?: string;
}

interface PatchStreamOptions {
  sourceURL?: string;
  requestHeaders?: Record<string, string>;
}

// Serves local patch fixtures through the same response path as GitHub data,
// while rejecting empty files so the viewer does not enter a silent no-op
// state.
function createPatchTextResponse(
  patchText: string,
  options: Omit<TextResponseOptions, 'status'>
): Response {
  if (!NON_WHITESPACE_PATTERN.test(patchText)) {
    return createTextResponse(EMPTY_PATCH_MESSAGE, { status: 422 });
  }

  return createTextResponse(patchText, options);
}

// Validates the upstream response before opening the client-facing stream so
// GitHub HTML pages and redirects become small text errors instead of Next.js
// error documents.
async function createPatchStreamResponse(
  patchURL: string,
  requestSignal: AbortSignal,
  options: PatchStreamOptions
): Promise<Response> {
  const upstreamController = new AbortController();
  const abortUpstream = () => upstreamController.abort();
  requestSignal.addEventListener('abort', abortUpstream, { once: true });

  let response: Response;
  try {
    response = await fetch(patchURL, {
      cache: 'no-store',
      headers: {
        'User-Agent': 'pierre-diffshub',
        ...options.requestHeaders,
      },
      signal: upstreamController.signal,
    });
  } catch {
    requestSignal.removeEventListener('abort', abortUpstream);
    return createTextResponse('Failed to fetch patch.', { status: 502 });
  }

  if (!response.ok) {
    const status = response.status >= 400 ? response.status : 502;
    requestSignal.removeEventListener('abort', abortUpstream);
    return createTextResponse(
      `Failed to fetch patch: ${response.status} ${response.statusText}`,
      { status }
    );
  }

  const contentType = response.headers.get('Content-Type');
  if (contentType == null || !isAcceptedPatchContentType(contentType)) {
    requestSignal.removeEventListener('abort', abortUpstream);
    return createTextResponse(NON_DIFF_RESPONSE_MESSAGE, { status: 415 });
  }

  if (response.headers.get('Content-Length') === '0') {
    requestSignal.removeEventListener('abort', abortUpstream);
    return createTextResponse(EMPTY_PATCH_MESSAGE, { status: 422 });
  }

  const responseBody = response.body;
  if (responseBody == null) {
    try {
      const patchText = await response.text();
      return createPatchTextResponse(patchText, options);
    } finally {
      requestSignal.removeEventListener('abort', abortUpstream);
    }
  }

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      void pumpPatchBody(responseBody, controller).finally(() => {
        requestSignal.removeEventListener('abort', abortUpstream);
      });
    },
    cancel() {
      abortUpstream();
      requestSignal.removeEventListener('abort', abortUpstream);
    },
  });

  return createTextResponse(stream, options);
}

// Forwards each validated upstream diff chunk into the client stream.
async function pumpPatchBody(
  body: ReadableStream<Uint8Array>,
  controller: ReadableStreamDefaultController<Uint8Array>
): Promise<void> {
  try {
    const reader = body.getReader();
    let sawContent = false;
    try {
      for (;;) {
        const result = await reader.read();
        if (result.done) {
          break;
        }

        if (result.value.byteLength > 0) {
          sawContent = true;
          controller.enqueue(result.value);
        }
      }
    } finally {
      reader.releaseLock();
    }

    if (!sawContent) {
      throw new Error(EMPTY_PATCH_MESSAGE);
    }

    controller.close();
  } catch (error) {
    controller.error(error);
  }
}

// Centralizes text response headers for both stream and error bodies. Diff
// responses are intentionally not cached in the browser because cached 100MB+
// responses can replay poorly and delay the first useful diff bytes.
function createTextResponse(
  body: string | ReadableStream<Uint8Array>,
  { status = 200, sourceURL }: TextResponseOptions = {}
): Response {
  const headers = new Headers({
    'Content-Type': 'text/plain; charset=utf-8',
    'Cache-Control': CACHE_CONTROL,
  });
  if (sourceURL != null) {
    headers.set('X-Patch-Source', sourceURL);
  }
  return new Response(body, {
    status,
    headers,
  });
}
