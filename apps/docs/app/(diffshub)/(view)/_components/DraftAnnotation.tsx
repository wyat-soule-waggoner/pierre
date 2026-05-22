import type { DiffLineAnnotation } from '@pierre/diffs';
import { IconArrowRight } from '@pierre/icons';
import { useEffect, useRef, useState } from 'react';

import {
  annotationCardBase,
  CommentAuthorAvatar,
  getRandomPersona,
} from './annotation-shared';
import { useGitHubViewer } from './githubViewer';
import type { DraftCommentMetadata } from './types';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

interface DraftAnnotationProps {
  annotation: DiffLineAnnotation<DraftCommentMetadata>;
  itemId: string;
  onCancel(itemId: string, key: string): void;
  // `author` is widened from AvatarName to string because, when GITHUB_TOKEN
  // is set, the draft preview attributes itself to the GitHub viewer's login
  // (not a Pierre persona). The wrapper still overrides this for PR-route
  // posts with whatever GitHub attributes the comment to server-side.
  // `avatarUrl` is forwarded too so the optimistic saved-state render uses
  // the same image the draft preview was already showing.
  onSave(
    itemId: string,
    key: string,
    message: string,
    author: string,
    avatarUrl: string | undefined
  ): void;
}

export function DraftAnnotation({
  annotation,
  itemId,
  onCancel,
  onSave,
}: DraftAnnotationProps) {
  const [message, setMessage] = useState(annotation.metadata.message);
  const [persona] = useState(getRandomPersona);
  const viewer = useGitHubViewer();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const trimmedMessage = message.trim();

  const displayAuthor = viewer?.login ?? persona.name;
  const displayAvatarUrl = viewer?.avatarUrl;

  function handleSave() {
    if (trimmedMessage.length === 0) {
      return;
    }
    onSave(
      itemId,
      annotation.metadata.key,
      trimmedMessage,
      displayAuthor,
      displayAvatarUrl
    );
  }

  function tryCancel() {
    if (trimmedMessage.length > 0 && !window.confirm('Discard this comment?')) {
      return;
    }
    onCancel(itemId, annotation.metadata.key);
  }

  useEffect(() => {
    const textarea = textareaRef.current;
    if (textarea == null) {
      return;
    }

    textarea.focus({ preventScroll: true });
    const cursorIndex = textarea.value.length;
    textarea.setSelectionRange(cursorIndex, cursorIndex);
  }, []);

  return (
    <form
      className={cn(annotationCardBase, 'flex-col md:flex-row')}
      onSubmit={(event) => {
        event.preventDefault();
        handleSave();
      }}
    >
      <div className="flex w-full gap-2.5">
        <CommentAuthorAvatar
          seed={displayAuthor}
          avatarUrl={displayAvatarUrl}
        />
        <textarea
          ref={textareaRef}
          value={message}
          onChange={({ currentTarget }) => setMessage(currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.preventDefault();
              tryCancel();
              return;
            }

            if ((!event.shiftKey && !event.metaKey) || event.key !== 'Enter') {
              return;
            }

            event.preventDefault();
            handleSave();
          }}
          placeholder="Add a comment…"
          rows={2}
          className="field-sizing-content w-full resize-none rounded-sm py-1.5 text-[14px] focus:outline-none"
        />
      </div>
      <div className="flex w-full justify-between gap-3 pl-10.5 md:w-auto md:justify-end md:pl-0">
        <Button
          type="button"
          variant="muted"
          onClick={tryCancel}
          className="text-muted-foreground hover:text-foreground gap-1 font-normal hover:no-underline md:hidden"
        >
          Cancel
        </Button>
        <Button
          type="submit"
          variant="default"
          size="icon-md"
          disabled={trimmedMessage.length === 0}
          className="hidden rounded-full bg-blue-500 hover:bg-blue-600 md:flex"
        >
          <IconArrowRight className="size-4 rotate-[-90deg]" />
        </Button>
        <Button
          type="submit"
          variant="default"
          disabled={trimmedMessage.length === 0}
          className="gap-1.5 bg-blue-500 hover:bg-blue-600 md:hidden"
        >
          Submit
          <IconArrowRight className="-mr-0.5 size-3" />
        </Button>
      </div>
    </form>
  );
}
