'use client';

import { type DiffIndicators } from '@pierre/diffs';
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
import { useGitHubViewer } from './githubViewer';
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
