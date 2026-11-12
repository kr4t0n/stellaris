import { ASK_CHANNEL, IMAGE_MEDIA_TYPES, type Message } from "@stellaris/shared";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type DragEvent,
  type KeyboardEvent,
} from "react";
import { Button } from "../components/Button.js";
import { CliIcon } from "../components/CliIcon.js";
import { ApiError } from "../lib/api.js";
import { useMembers, useSession, useUploadedImage } from "../lib/session.js";
import { askTitle } from "./asks.js";
import {
  completeMention,
  type DraftImage,
  draftImages,
  insertAt,
  mentionAt,
  removeDraftImage,
  settleUpload,
  uploadPlaceholder,
} from "./compose.js";
// Loaded with the page, never with the first image: a page open across a deploy finds a chunk it
// hadn't loaded gone, and would post no image at all.
import { imageToPost } from "./post-image.js";

/**
 * Where a post goes: a channel, a thread, or a new ask, which opens a thread on the society's
 * asks channel titled by the post's first line.
 */
export type Target =
  | { readonly channel: string }
  | { readonly threadId: string }
  | { readonly ask: true };

/**
 * A second way to send what the box holds, beside Send, such as finishing a stage with the text as
 * its note: a round button with a check, named by `label`, its tooltip `title`. It may go with the
 * box empty; `blocked` says why it can't go at all, in its tooltip.
 */
export interface ComposerAction {
  readonly label: string;
  readonly title: string;
  readonly blocked: string | null;
  readonly run: (text: string) => Promise<unknown>;
}

const MAX_CANDIDATES = 6;

/** The kinds of image the board keeps, which the file picker offers. */
const IMAGE_TYPES = Object.values(IMAGE_MEDIA_TYPES).join(",");

/** Whether a drag carries files, rather than text or a link. */
function filesDragged(event: DragEvent): boolean {
  return event.dataTransfer.types.includes("Files");
}

/**
 * Posts as the user into a channel or a thread, in one row: a box that is a capsule at one line,
 * then Send, a round button with an arrow, as the iOS app draws it, lit while there is something to
 * send and turning while it posts. An `action`, such as Approve, is a round check after it, at the row's end.
 * Enter sends and Shift+Enter breaks the line; an `@` offers the citizens to mention. An image pasted, dropped,
 * or picked uploads to the board, holding its place in the text with a line of its own that says so
 * until the markdown that shows it, described by its file's name, takes that line's place; Send
 * waits for it.
 */
export function Composer({
  target,
  placeholder,
  initialText = "",
  className = "border-t border-line p-3",
  focusOnOpen = false,
  onPosted,
  onEmptyEscape,
  action,
}: {
  target: Target;
  placeholder: string;
  /** What the box starts with, and returns to after a send, such as a mention. */
  initialText?: string;
  className?: string;
  /** For a composer the user just opened, such as the ask box. */
  focusOnOpen?: boolean;
  onPosted?: (message: Message) => void;
  /** Escape in an empty box, for a composer that closes. */
  onEmptyEscape?: () => void;
  /** A second button beside Send; Enter still sends. */
  action?: ComposerAction | undefined;
}) {
  const { api } = useSession();
  const client = useQueryClient();
  const members = useMembers();
  const [text, setText] = useState(initialText);
  const [caret, setCaret] = useState(0);
  const [pick, setPick] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  const [uploading, setUploading] = useState(0);
  /** Why the last image that failed was not kept, in the board's words when it gave them. */
  const [uploadFailure, setUploadFailure] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const box = useRef<HTMLTextAreaElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  /** The lines of the uploads on their way, each its own, which only its upload fills. */
  const held = useRef<string[]>([]);
  /** Each upload's file as an object URL, by its line, its thumbnail until the board keeps it. */
  const previewUrls = useRef(new Map<string, string>());
  const [previews, setPreviews] = useState<ReadonlyMap<string, string>>(new Map());
  // Where the caret goes once a completed mention has rendered; set in the same frame, before
  // the next keystroke can land.
  const pendingCaret = useRef<number | null>(null);

  const send = useMutation({
    mutationFn: async (body: string) => {
      if ("channel" in target) {
        return api.sendMessage({ channel: target.channel, body });
      }
      if ("threadId" in target) {
        return api.sendMessage({ thread_id: target.threadId, body });
      }
      const thread = await api.openThread({ channel: ASK_CHANNEL, title: askTitle(body) });
      return api.sendMessage({ thread_id: thread.id, body });
    },
    // A refusal of the action says no more once the user posts again.
    onMutate: () => act.reset(),
    onSuccess: (message) => {
      setText(initialText);
      setUploadFailure(null);
      void client.invalidateQueries({
        queryKey:
          message.thread === undefined ? ["channel", message.channel] : ["thread", message.thread],
      });
      if ("ask" in target) {
        void client.invalidateQueries({ queryKey: ["threads"] });
      }
      // A post by the user answers whatever was asked of them where it was posted.
      void client.invalidateQueries({ queryKey: ["requests"] });
      onPosted?.(message);
    },
  });

  const act = useMutation({
    mutationFn: (body: string) => {
      if (action === undefined) {
        return Promise.resolve();
      }
      return action.run(body);
    },
    onSuccess: () => {
      setText(initialText);
      setUploadFailure(null);
      if ("threadId" in target) {
        void client.invalidateQueries({ queryKey: ["thread", target.threadId] });
      }
      void client.invalidateQueries({ queryKey: ["requests"] });
    },
  });

  // The previews of uploads still on their way when the composer goes.
  useEffect(() => {
    const urls = previewUrls.current;
    return () => {
      for (const url of urls.values()) {
        URL.revokeObjectURL(url);
      }
    };
  }, []);

  useEffect(() => {
    if (focusOnOpen) {
      box.current?.focus();
    }
  }, [focusOnOpen]);

  // After every render the box fits its text, up to its maximum height, past which it scrolls.
  useLayoutEffect(() => {
    const element = box.current;
    if (element === null) {
      return;
    }
    element.style.height = "auto";
    element.style.height = `${element.scrollHeight}px`;
    if (pendingCaret.current !== null) {
      element.setSelectionRange(pendingCaret.current, pendingCaret.current);
      pendingCaret.current = null;
    }
  });

  const fragment = dismissed ? null : mentionAt(text, caret);
  const citizens = (members.data ?? []).filter(
    (member) => member.status === "active" && member.cli !== null,
  );
  const candidates =
    fragment === null
      ? []
      : citizens
          .filter((member) => member.name.startsWith(fragment.prefix))
          .slice(0, MAX_CANDIDATES);

  const complete = (name: string): void => {
    if (fragment === null) {
      return;
    }
    const next = completeMention(text, caret, fragment.start, name);
    pendingCaret.current = next.caret;
    setText(next.text);
    setCaret(next.caret);
  };
  const sendable =
    text.trim() !== "" &&
    text.trim() !== initialText.trim() &&
    !send.isPending &&
    !act.isPending &&
    uploading === 0;
  const actionable =
    action !== undefined &&
    action.blocked === null &&
    !send.isPending &&
    !act.isPending &&
    uploading === 0;
  // A button pressed goes busy, or goes, while its request is out, and focus left on it, or on
  // the page once it has gone, would hand the next keys to the board's own: Space opens the ask
  // box and Escape closes the board with the draft. So a press puts the keyboard back in the box
  // first, where those keys are the box's.
  const submit = (): void => {
    if (sendable) {
      box.current?.focus();
      send.mutate(text.trim());
    }
  };
  const runAction = (): void => {
    if (actionable) {
      box.current?.focus();
      act.mutate(text.trim());
    }
  };
  // A refusal of the action goes with the action, as when another's advance ended the stage.
  const hasAction = action !== undefined;
  const { reset: resetAction } = act;
  useEffect(() => {
    if (!hasAction) {
      resetAction();
    }
  }, [hasAction, resetAction]);

  /** Uploads each file, holding its place where the caret is, in place of what is selected. */
  const attach = (files: readonly File[]): void => {
    if (files.length === 0) {
      return;
    }
    const element = box.current;
    const placeholders: string[] = [];
    for (const file of files) {
      placeholders.push(uploadPlaceholder(file.name, text, [...held.current, ...placeholders]));
    }
    held.current.push(...placeholders);
    files.forEach((file, index) => {
      previewUrls.current.set(placeholders[index] ?? "", URL.createObjectURL(file));
    });
    setPreviews(new Map(previewUrls.current));
    const inserted = insertAt(
      text,
      element?.selectionStart ?? text.length,
      element?.selectionEnd ?? text.length,
      placeholders.join("\n"),
    );
    pendingCaret.current = inserted.caret;
    setText(inserted.text);
    setCaret(inserted.caret);
    setUploadFailure(null);
    files.forEach((file, index) => void upload(file, placeholders[index] ?? ""));
  };
  const upload = async (file: File, line: string): Promise<void> => {
    setUploading((count) => count + 1);
    let markdown = "";
    try {
      markdown = (await api.postImage(await imageToPost(file, file.name), file.name)).markdown;
    } catch (error) {
      setUploadFailure(
        error instanceof ApiError && error.status !== 0
          ? error.message
          : `${file.name} was not uploaded.`,
      );
    }
    setText((current) => {
      const element = box.current;
      const settled = settleUpload(
        current,
        element?.selectionStart ?? current.length,
        line,
        markdown,
      );
      if (settled === null) {
        return current;
      }
      // Setting the box's text moves its caret to the end, so it goes back among the same words.
      pendingCaret.current = settled.caret;
      return settled.text;
    });
    held.current = held.current.filter((each) => each !== line);
    const url = previewUrls.current.get(line);
    if (url !== undefined) {
      URL.revokeObjectURL(url);
      previewUrls.current.delete(line);
      setPreviews(new Map(previewUrls.current));
    }
    setUploading((count) => count - 1);
  };
  /**
   * Takes an image's markdown, or its upload's line, out of the draft, and puts the keyboard back
   * in the box: the × it came from goes with its thumbnail, which would leave the focus on the page,
   * whose shortcuts would take the next keys.
   */
  const remove = (image: DraftImage): void => {
    const removed = removeDraftImage(text, box.current?.selectionStart ?? caret, image);
    pendingCaret.current = removed.caret;
    setText(removed.text);
    setCaret(removed.caret);
    box.current?.focus();
  };
  const images = draftImages(text, [...previews.keys()]);
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (candidates.length > 0) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const step = event.key === "ArrowDown" ? 1 : candidates.length - 1;
        setPick((pick + step) % candidates.length);
        return;
      }
      if (event.key === "Enter" || event.key === "Tab") {
        event.preventDefault();
        complete(candidates[Math.min(pick, candidates.length - 1)]?.name ?? "");
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        setDismissed(true);
        return;
      }
    }
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      submit();
      return;
    }
    if (event.key === "Escape" && text === "" && onEmptyEscape !== undefined) {
      event.preventDefault();
      onEmptyEscape();
    }
  };

  return (
    <form
      className={className}
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      {images.length === 0 ? null : (
        <ul aria-label="Images in the draft" className="mb-2 flex flex-wrap gap-2">
          {images.map((image) => (
            <li
              key={`${image.start}:${image.text}`}
              className="relative size-16 overflow-hidden rounded-lg bg-surface-2/50 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.08)]"
            >
              {image.id === null ? (
                <>
                  <img
                    src={previews.get(image.text)}
                    alt=""
                    className="size-full object-cover opacity-35"
                  />
                  <span className="absolute inset-0 grid place-items-center text-[11px] text-fg-primary">
                    Uploading…
                  </span>
                </>
              ) : (
                <KeptThumbnail id={image.id} alt={image.alt} />
              )}
              <button
                type="button"
                aria-label={
                  image.id === null
                    ? `Remove ${image.alt}, still uploading`
                    : `Remove ${image.alt === "" ? "the image" : image.alt}`
                }
                title="Remove"
                onClick={() => remove(image)}
                className="absolute top-1 right-1 grid size-5 place-items-center rounded-full bg-black/60 text-xs text-white hover:bg-black/80"
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="flex items-end gap-2">
        <div
          onDragOver={(event) => {
            if (filesDragged(event)) {
              event.preventDefault();
              event.dataTransfer.dropEffect = "copy";
              setDragging(true);
            }
          }}
          onDragLeave={(event) => {
            if (
              !(
                event.relatedTarget instanceof Node &&
                event.currentTarget.contains(event.relatedTarget)
              )
            ) {
              setDragging(false);
            }
          }}
          onDrop={(event) => {
            setDragging(false);
            if (event.dataTransfer.files.length > 0) {
              event.preventDefault();
              attach([...event.dataTransfer.files]);
            }
          }}
          className={`relative flex min-w-0 flex-1 items-end gap-2 rounded-[20px] bg-surface-2/50 pr-1.5 focus-within:shadow-[inset_0_0_0_1px_rgba(255,255,255,0.16)] ${
            dragging
              ? "shadow-[inset_0_0_0_1px_rgba(255,255,255,0.16)]"
              : "shadow-[inset_0_0_0_1px_rgba(255,255,255,0.06)]"
          }`}
        >
          {candidates.length > 0 ? (
            <ul
              aria-label="Citizens to mention"
              className="card absolute bottom-full left-2 mb-2 w-60 overflow-hidden py-1"
            >
              {candidates.map((member, index) => (
                <li key={member.name}>
                  <button
                    type="button"
                    onMouseDown={(event) => {
                      event.preventDefault();
                      complete(member.name);
                    }}
                    className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm ${
                      index === pick ? "bg-surface-2 text-fg-primary" : "text-fg-secondary"
                    }`}
                  >
                    {member.cli === null ? null : <CliIcon cli={member.cli} size={14} />}
                    <span className="flex-1 truncate">{member.name}</span>
                    <span className="truncate font-mono text-[11px] text-fg-muted">
                      {member.role}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
          <textarea
            ref={box}
            rows={1}
            value={text}
            placeholder={placeholder}
            aria-label={placeholder}
            onChange={(event) => {
              setText(event.target.value);
              setCaret(event.target.selectionStart);
              setPick(0);
              setDismissed(false);
            }}
            onSelect={(event) => setCaret(event.currentTarget.selectionStart)}
            onKeyDown={onKeyDown}
            onPaste={(event) => {
              // Text copied with a picture of it, as from a spreadsheet, pastes as the text.
              const files = [...event.clipboardData.files];
              if (files.length > 0 && event.clipboardData.getData("text/plain") === "") {
                event.preventDefault();
                attach(files);
              }
            }}
            className="block max-h-48 w-full resize-none bg-transparent px-3 py-2.5 text-sm text-fg-primary outline-none placeholder:text-fg-muted"
          />
          <div className="flex shrink-0 items-center gap-0.5 pb-1.5">
            <input
              ref={picker}
              type="file"
              accept={IMAGE_TYPES}
              multiple
              hidden
              onChange={(event) => {
                attach([...(event.currentTarget.files ?? [])]);
                event.currentTarget.value = "";
              }}
            />
            <Button
              aria-label="Add images"
              title="Add images"
              onClick={() => picker.current?.click()}
            >
              <ImageGlyph />
            </Button>
          </div>
        </div>
        <button
          type="submit"
          disabled={!sendable}
          aria-label="Send"
          aria-busy={send.isPending}
          title="Send"
          className={`grid size-10 shrink-0 place-items-center rounded-full bg-surface-2/50 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.06)] transition-colors focus-visible:ring-2 focus-visible:ring-fg-primary/30 focus-visible:outline-none disabled:pointer-events-none ${
            sendable ? "text-fg-primary hover:bg-surface-2" : "text-fg-muted"
          }`}
        >
          {send.isPending ? <Spinner /> : <ArrowGlyph />}
        </button>
        {action === undefined ? null : (
          <ActionButton
            action={action}
            pending={act.isPending}
            disabled={!actionable && !act.isPending}
            onClick={runAction}
          />
        )}
      </div>
      {send.error === null ? null : (
        <p role="alert" className="mt-2 text-xs text-red-400">
          {send.error instanceof ApiError ? send.error.message : "The message was not sent."}
        </p>
      )}
      {act.error === null ? null : (
        <p role="alert" className="mt-2 text-xs text-red-400">
          {act.error instanceof ApiError ? act.error.message : "The stage was not finished."}
        </p>
      )}
      {uploadFailure === null ? null : (
        <p role="alert" className="mt-2 text-xs text-red-400">
          {uploadFailure}
        </p>
      )}
    </form>
  );
}

/**
 * The round button an action takes after Send: a check on green, named by the action, and turning
 * while it goes. The task view's Approve also stands alone in it where its task has no open thread.
 * It is never `disabled`, which would drop it from the tab order and, with no pointer events, hide
 * the tooltip that says why it can't go: it is `aria-disabled`, dimmed, and its press does nothing.
 */
export function ActionButton({
  action,
  pending,
  disabled,
  onClick,
}: {
  action: ComposerAction;
  pending: boolean;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-disabled={disabled || pending}
      aria-label={action.label}
      aria-busy={pending}
      title={action.blocked ?? action.title}
      onClick={() => {
        if (!disabled && !pending) {
          onClick();
        }
      }}
      className={`grid size-10 shrink-0 place-items-center rounded-full bg-emerald-400/15 text-emerald-200 transition-colors focus-visible:ring-2 focus-visible:ring-emerald-300/40 focus-visible:outline-none ${
        disabled
          ? "cursor-not-allowed opacity-40"
          : pending
            ? "cursor-progress"
            : "hover:bg-emerald-400/25"
      }`}
    >
      {pending ? <Spinner /> : <CheckGlyph />}
    </button>
  );
}

/** An arrow pointing up, Send's mark, in the shape the iOS app's has. */
function ArrowGlyph() {
  return (
    <svg
      viewBox="0 0 16 16"
      width={18}
      height={18}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M8 13.5V2.75M3.25 7.5 8 2.75l4.75 4.75" />
    </svg>
  );
}

/** A check, an action's mark, in the shape the iOS app's Advance has. */
function CheckGlyph() {
  return (
    <svg
      viewBox="0 0 16 16"
      width={18}
      height={18}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M3 8.5 6.5 12 13 4.25" />
    </svg>
  );
}

/** A ring turning while a post or an approval is on its way. */
function Spinner() {
  return (
    <svg
      viewBox="0 0 16 16"
      width={16}
      height={16}
      fill="none"
      aria-hidden="true"
      className="motion-safe:animate-spin"
    >
      <circle cx={8} cy={8} r={6} stroke="currentColor" strokeOpacity={0.25} strokeWidth={1.8} />
      <path d="M14 8a6 6 0 0 0-6-6" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" />
    </svg>
  );
}

/** A picture in a frame, a mountain and the sun in it, drawn in the text's colour. */
function ImageGlyph() {
  return (
    <svg
      viewBox="0 0 16 16"
      width={16}
      height={16}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.3}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x={2} y={2.5} width={12} height={11} rx={2} />
      <circle cx={10.5} cy={6} r={1.2} />
      <path d="M2.5 12l3.8-4.2a1 1 0 0 1 1.5 0L12 12.5" />
    </svg>
  );
}

/** An image the board kept, read through it by its id, as a post reads it. */
function KeptThumbnail({ id, alt }: { id: string; alt: string }) {
  const image = useUploadedImage(id);
  return image.data === undefined ? (
    <span title={image.error?.message} className="block size-full" />
  ) : (
    <img src={image.data} alt={alt} className="size-full object-cover" />
  );
}
