'use client';

import { useEffect, useState } from 'react';

export interface GitHubViewer {
  login: string;
  avatarUrl: string;
}

// Module-level cache shared across every component that calls useGitHubViewer.
// The first call triggers the /api/me fetch; the resolved value is then read
// synchronously by future mounts. A failed fetch is not cached so transient
// errors (network blip, server restarted with a new token) retry on next use.
let viewerPromise: Promise<GitHubViewer | null> | undefined;
let viewerValue: GitHubViewer | null | undefined;

function loadViewer(): Promise<GitHubViewer | null> {
  if (viewerPromise != null) {
    return viewerPromise;
  }
  viewerPromise = (async () => {
    try {
      const response = await fetch('/api/me', { cache: 'no-store' });
      if (!response.ok) {
        viewerValue = null;
        return null;
      }
      const json = (await response.json()) as Partial<GitHubViewer>;
      if (
        typeof json.login !== 'string' ||
        typeof json.avatarUrl !== 'string'
      ) {
        viewerValue = null;
        return null;
      }
      const viewer: GitHubViewer = {
        login: json.login,
        avatarUrl: json.avatarUrl,
      };
      viewerValue = viewer;
      return viewer;
    } catch {
      viewerPromise = undefined;
      viewerValue = undefined;
      return null;
    }
  })();
  return viewerPromise;
}

// Returns the authenticated GitHub viewer once /api/me resolves, or null when
// no token is configured / the call failed. Returns undefined during the
// initial fetch so callers can distinguish "still loading" from "unauthed".
export function useGitHubViewer(): GitHubViewer | null | undefined {
  const [viewer, setViewer] = useState<GitHubViewer | null | undefined>(
    viewerValue
  );
  useEffect(() => {
    if (viewerValue !== undefined) {
      return;
    }
    let cancelled = false;
    void loadViewer().then((result) => {
      if (!cancelled) {
        setViewer(result);
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);
  return viewer;
}
