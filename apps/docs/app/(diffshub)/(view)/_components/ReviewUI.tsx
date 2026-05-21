'use client';

import { type DiffIndicators, type DiffLineAnnotation } from '@pierre/diffs';
import { type CodeViewHandle, useWorkerPool } from '@pierre/diffs/react';
import {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { toast } from 'sonner';

import { preloadAvatars } from './annotation-shared';
import { CodeViewHeader } from './CodeViewHeader';
import { CodeViewSidebar } from './CodeViewSidebar';
import { CodeViewStatusPanel } from './CodeViewStatusPanel';
import {
  type CodeViewSubmitDraftEvent,
  type CodeViewSubmitDraftResult,
  CodeViewWrapper,
} from './CodeViewWrapper';
import { deleteGitHubComment } from './deleteGitHubComment';
import { useGitHubViewer } from './githubViewer';
import { loadGitHubPullComments } from './loadGitHubPullComments';
import {
  parsePullIdentityFromPath,
  submitDraftCommentToGitHub,
} from './submitDraftCommentToGitHub';
import type {
  CodeViewDeletedCommentEvent,
  CodeViewSavedCommentEntry,
  CodeViewSavedCommentEvent,
  CommentMetadata,
} from './types';
import { usePatchLoader } from './usePatchLoader';
import {
  classifyCommentLineType,
  isDiffItem,
  removeSavedCommentSidebarEntry,
  upsertSavedCommentSidebarEntry,
} from './utils';

interface ReviewUIProps {
  domain?: string;
  initialUrl: string;
  path: string;
}

export function ReviewUI({ domain, initialUrl, path }: ReviewUIProps) {
  useEffect(preloadAvatars, []);

  const isWorkerPoolReadyOrDisable = useIsWorkerPoolReadyOrDisabled();
  const [diffStyle, setDiffStyle] = useState<'split' | 'unified'>('split');
  const [collapseMode, setCollapseMode] = useState<'expanded' | 'collapsed'>(
    'expanded'
  );
  const [fileTreeOverlayOpen, setFileTreeOverlayOpen] = useState(false);
  const [overflow, setOverflow] = useState<'wrap' | 'scroll'>('scroll');
  const [showBackgrounds, setShowBackgrounds] = useState(true);
  const [diffIndicators, setDiffIndicators] = useState<DiffIndicators>('bars');
  const [lineNumbers, setLineNumbers] = useState(true);
  const scrollRef = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<CodeViewHandle<CommentMetadata> | null>(null);
  const handlePatchLoadStart = useCallback(() => {
    setFileTreeOverlayOpen(false);
  }, []);
  const {
    applyCollapseModeToLoaded,
    commentFileByItemId,
    commentSections,
    diffStats,
    errorMessage,
    initialItems,
    loadState,
    onLineLinkChange,
    onViewerReady,
    retryLoad,
    setCommentSections,
    treeSource,
    viewerKey,
  } = usePatchLoader({
    collapseMode,
    domain,
    onLoadStart: handlePatchLoadStart,
    path,
    viewerRef,
  });

  useEffect(() => {
    const mediaQuery = window.matchMedia('(max-width: 767px)');
    const updateMobileState = (matches: boolean) => {
      setDiffStyle(matches ? 'unified' : 'split');
      if (!matches) setFileTreeOverlayOpen(false);
    };
    const handleChange = (event: MediaQueryListEvent) => {
      updateMobileState(event.matches);
    };

    updateMobileState(mediaQuery.matches);
    mediaQuery.addEventListener('change', handleChange);
    return () => mediaQuery.removeEventListener('change', handleChange);
  }, []);
  const handleSelectTreeItem = useCallback((itemId: string) => {
    setFileTreeOverlayOpen(false);
    const viewer = viewerRef.current;
    if (viewer == null) {
      return;
    }
    const item = viewer.getItem(itemId);
    if (item != null && item.collapsed === true) {
      item.collapsed = false;
      item.version = typeof item.version === 'number' ? item.version + 1 : 1;
      viewer.updateItem(item);
    }
    viewer.scrollTo({
      type: 'item',
      id: itemId,
      align: 'start',
      behavior: 'smooth',
    });
  }, []);
  const handleToggleCollapseMode = useCallback(() => {
    const next = collapseMode === 'expanded' ? 'collapsed' : 'expanded';
    setCollapseMode(next);
    applyCollapseModeToLoaded(next);
  }, [applyCollapseModeToLoaded, collapseMode]);
  const handleCommentSaved = useCallback(
    (comment: CodeViewSavedCommentEvent) => {
      setCommentSections((prev) =>
        upsertSavedCommentSidebarEntry(prev, commentFileByItemId, comment)
      );
    },
    [commentFileByItemId, setCommentSections]
  );
  const pullIdentity = useMemo(() => parsePullIdentityFromPath(path), [path]);
  const viewer = useGitHubViewer();
  const handleSubmitDraft = useCallback(
    async (
      event: CodeViewSubmitDraftEvent
    ): Promise<CodeViewSubmitDraftResult> => {
      if (pullIdentity == null) {
        // Commits and compares can't be posted to GitHub, but if we know the
        // viewer we still attribute the local-only save to them so the saved
        // card matches the draft preview.
        if (viewer != null) {
          return {
            accepted: true,
            author: viewer.login,
            avatarUrl: viewer.avatarUrl,
          };
        }
        return { accepted: true };
      }
      const file = commentFileByItemId?.get(event.itemId);
      if (file == null) {
        toast.error('Could not resolve the file for this comment.');
        return { accepted: false };
      }
      try {
        const result = await submitDraftCommentToGitHub({
          pull: pullIdentity,
          filePath: file.path,
          body: event.message,
          lineNumber: event.lineNumber,
          side: event.side,
          range: event.range,
        });
        toast.success('Comment posted to GitHub.', {
          action: {
            label: 'View',
            onClick: () => window.open(result.htmlUrl, '_blank', 'noopener'),
          },
        });
        return {
          accepted: true,
          author: result.author,
          avatarUrl: result.avatarUrl,
          githubCommentId: result.id,
        };
      } catch (error) {
        const message =
          error instanceof Error ? error.message : 'Failed to post comment.';
        toast.error(message);
        return { accepted: false };
      }
    },
    [commentFileByItemId, pullIdentity, viewer]
  );
  const handleCommentDeleted = useCallback(
    (comment: CodeViewDeletedCommentEvent) => {
      setCommentSections((prev) =>
        removeSavedCommentSidebarEntry(prev, comment)
      );
    },
    [setCommentSections]
  );
  const handleRequestRemoveComment = useCallback(
    async (event: {
      itemId: string;
      key: string;
      githubCommentId: number;
    }): Promise<boolean> => {
      if (pullIdentity == null) {
        return true;
      }
      if (
        !window.confirm(
          'Delete this comment from GitHub? This cannot be undone.'
        )
      ) {
        return false;
      }
      try {
        await deleteGitHubComment(event.githubCommentId, pullIdentity);
        toast.success('Comment deleted on GitHub.');
        return true;
      } catch (error) {
        const message =
          error instanceof Error ? error.message : 'Failed to delete comment.';
        toast.error(message);
        return false;
      }
    },
    [pullIdentity]
  );

  // Once the diff has finished streaming and we know the PR + file map, fetch
  // existing review comments and inject them as saved annotations on the
  // matching diff items. The effect is keyed on the resource (pullIdentity +
  // commentFileByItemId) so re-renders within the same view don't refetch,
  // and the abort signal cancels in-flight loads on navigation.
  useEffect(() => {
    if (
      pullIdentity == null ||
      commentFileByItemId == null ||
      loadState !== 'ready'
    ) {
      return;
    }

    const controller = new AbortController();
    void (async () => {
      let loaded: Awaited<ReturnType<typeof loadGitHubPullComments>>;
      try {
        loaded = await loadGitHubPullComments(pullIdentity, controller.signal);
      } catch (error) {
        if (controller.signal.aborted) {
          return;
        }
        const message =
          error instanceof Error
            ? error.message
            : 'Could not load PR comments.';
        toast.error(message);
        return;
      }

      const viewer = viewerRef.current;
      if (viewer == null || controller.signal.aborted) {
        return;
      }

      const pathToItemId = new Map<string, string>();
      for (const [id, file] of commentFileByItemId) {
        pathToItemId.set(file.path, id);
      }

      const sidebarEvents: CodeViewSavedCommentEvent[] = [];
      for (const comment of loaded) {
        const itemId = pathToItemId.get(comment.path);
        if (itemId == null) {
          continue;
        }
        const item = viewer.getItem(itemId);
        if (item == null || !isDiffItem(item)) {
          continue;
        }
        const key = `gh-${comment.id}`;
        const alreadyInjected =
          item.annotations?.some((a) => a.metadata.key === key) ?? false;
        if (alreadyInjected) {
          continue;
        }
        const annotation: DiffLineAnnotation<CommentMetadata> = {
          side: comment.side,
          lineNumber: comment.lineNumber,
          metadata: {
            kind: 'saved',
            key,
            author: comment.author,
            avatarUrl: comment.avatarUrl,
            githubCommentId: comment.id,
            message: comment.body,
            range: comment.range,
          },
        };
        item.annotations = [...(item.annotations ?? []), annotation];
        item.version = typeof item.version === 'number' ? item.version + 1 : 1;
        viewer.updateItem(item);
        sidebarEvents.push({
          author: comment.author,
          avatarUrl: comment.avatarUrl,
          githubCommentId: comment.id,
          itemId,
          key,
          lineNumber: comment.lineNumber,
          lineType: classifyCommentLineType(
            item.fileDiff,
            comment.side,
            comment.lineNumber
          ),
          message: comment.body,
          range: comment.range,
          side: comment.side,
        });
      }

      if (sidebarEvents.length === 0 || controller.signal.aborted) {
        return;
      }
      setCommentSections((prev) => {
        let next = prev;
        for (const event of sidebarEvents) {
          next = upsertSavedCommentSidebarEntry(
            next,
            commentFileByItemId,
            event
          );
        }
        return next;
      });
    })();

    return () => {
      controller.abort();
    };
  }, [commentFileByItemId, loadState, pullIdentity, setCommentSections]);

  const handleToggleFileTreeOverlay = useCallback(() => {
    setFileTreeOverlayOpen((open) => !open);
  }, []);
  const handleCloseFileTreeOverlay = useCallback(() => {
    setFileTreeOverlayOpen(false);
  }, []);
  const handleSelectComment = useCallback(
    (comment: CodeViewSavedCommentEntry) => {
      setFileTreeOverlayOpen(false);
      viewerRef.current?.setSelectedLines({
        id: comment.itemId,
        range: comment.range,
      });
      viewerRef.current?.scrollTo({
        type: 'line',
        id: comment.itemId,
        lineNumber: comment.range.end,
        side: comment.range.endSide ?? comment.range.side,
        align: 'center',
        behavior: 'smooth-auto',
      });
    },
    []
  );
  const viewerAvailable =
    isWorkerPoolReadyOrDisable &&
    (loadState === 'ready' ||
      (loadState === 'streaming' && initialItems.length > 0));

  return (
    <ReviewGrid>
      <CodeViewHeader
        className="[grid-area:header]"
        collapseMode={collapseMode}
        diffIndicators={diffIndicators}
        diffStyle={diffStyle}
        initialUrl={initialUrl}
        lineNumbers={lineNumbers}
        overflow={overflow}
        fileTreeOverlayOpen={fileTreeOverlayOpen}
        fileTreeAvailable={treeSource != null}
        onToggleCollapseMode={handleToggleCollapseMode}
        onToggleFileTreeOverlay={handleToggleFileTreeOverlay}
        setDiffIndicators={setDiffIndicators}
        setDiffStyle={setDiffStyle}
        setLineNumbers={setLineNumbers}
        setOverflow={setOverflow}
        setShowBackgrounds={setShowBackgrounds}
        showBackgrounds={showBackgrounds}
      />
      {viewerAvailable && treeSource != null ? (
        <>
          <CodeViewSidebar
            className="[grid-area:viewer] md:[grid-area:tree]"
            commentSections={commentSections}
            diffStats={diffStats}
            mobileOverlayOpen={fileTreeOverlayOpen}
            onMobileClose={handleCloseFileTreeOverlay}
            onSelectComment={handleSelectComment}
            scrollRef={scrollRef}
            source={treeSource}
            streaming={loadState === 'streaming'}
            onSelectItem={handleSelectTreeItem}
          />
          <CodeViewWrapper
            key={viewerKey}
            className="[grid-area:viewer]"
            diffStyle={diffStyle}
            overflow={overflow}
            showBackgrounds={showBackgrounds}
            diffIndicators={diffIndicators}
            lineNumbers={lineNumbers}
            scrollRef={scrollRef}
            viewerRef={viewerRef}
            initialItems={initialItems}
            onCommentDeleted={handleCommentDeleted}
            onCommentSaved={handleCommentSaved}
            onLineLinkChange={onLineLinkChange}
            onRequestRemoveComment={handleRequestRemoveComment}
            onSubmitDraft={handleSubmitDraft}
            onViewerReady={onViewerReady}
          />
        </>
      ) : (
        <CodeViewStatusPanel
          state={loadState}
          errorMessage={errorMessage}
          onRetry={retryLoad}
        />
      )}
    </ReviewGrid>
  );
}

function useIsWorkerPoolReadyOrDisabled() {
  const workerPool = useWorkerPool();
  const [isReady, setIsReady] = useState(
    () => workerPool?.isInitialized() ?? true
  );
  const isReadyRef = useRef(isReady);
  useEffect(() => {
    // The callback will always be fired immediately with the new state, so we
    // don't need to check for it in the effect
    return workerPool?.subscribeToStatChanges((stats) => {
      const isReady = stats.managerState === 'initialized';
      if (isReady !== isReadyRef.current) {
        setIsReady(isReady);
        isReadyRef.current = isReady;
      }
    });
  }, [workerPool]);
  return isReady;
}

interface ReviewGridProps {
  children: ReactNode;
}

function ReviewGrid({ children }: ReviewGridProps) {
  return (
    <div className="grid min-h-0 flex-1 grid-cols-1 grid-rows-[auto_minmax(0,1fr)] overflow-hidden overscroll-contain contain-strict [grid-template-areas:'header''viewer'] md:grid-cols-[320px_minmax(0,1fr)] md:[grid-template-areas:'header_header''tree_viewer']">
      {children}
    </div>
  );
}
