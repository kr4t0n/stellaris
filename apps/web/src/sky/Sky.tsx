import { useEffect, useLayoutEffect, useRef, type ReactNode } from "react";
import { useEntities } from "../components/Entities.js";
import { withTitles } from "../lib/entities.js";
import { postedLine, type LiveStore } from "../lib/live.js";
import { starOf, type SkyModel } from "./model.js";
import { SkyScene, type ScreenPoint } from "./scene.js";

export interface Insets {
  readonly left: number;
  readonly right: number;
}

interface SkyProps {
  readonly model: SkyModel;
  readonly paused: boolean;
  /** What is hovered: a star's id, or `task:<id>` for a task's mark. */
  readonly hovered: string | null;
  readonly onHover: (id: string | null) => void;
  /** Screen space covered by islands at each side; the sky fits between them. */
  readonly insets: Insets;
  /** The anchor whose sphere is drawn brighter, the project the board has open. */
  readonly focus: string | null;
  readonly onSelectAnchor: (anchor: string) => void;
  readonly onSelectStar: (id: string) => void;
  readonly onSelectTask: (id: string) => void;
  /** The live turn stream, whose tool calls flicker stars and whose posts rise from them. */
  readonly live: LiveStore;
  /** Shown beside what is hovered and moved with it every frame. */
  readonly card: ReactNode;
}

/**
 * Events older than this are the server's buffer replayed on connect, not motion now. Measured on
 * the browser's clock against the server's stamps, so it allows for some drift between the two.
 */
const RECENT_MS = 15_000;

const CARD_GAP = 26;
const EDGE = 12;
/** A press that moves further than this is a drag, and does not also click. */
const DRAG_SLOP = 4;
/** How much one pixel of wheel travel zooms; a trackpad pinch arrives as a wheel with Ctrl held. */
const WHEEL_ZOOM = 0.0015;
const PINCH_ZOOM = 0.01;
const STEP_ZOOM = 1.3;

const CONTROL =
  "grid size-7 place-items-center rounded-md text-sm text-fg-tertiary transition-colors hover:bg-surface-2/70 hover:text-fg-primary focus-visible:ring-2 focus-visible:ring-fg-primary/30 focus-visible:outline-none";

/** Puts the card beside the star inside the sky's free area, flipping sides to stay in it. */
function place(
  card: HTMLElement | null,
  point: ScreenPoint | null,
  bounds: DOMRect,
  insets: Insets,
): void {
  if (card === null) {
    return;
  }
  if (point === null) {
    card.style.visibility = "hidden";
    return;
  }
  const width = card.offsetWidth;
  const height = card.offsetHeight;
  const left = insets.left + EDGE;
  const right = bounds.width - insets.right - EDGE;
  const fitsRight = point.x + CARD_GAP + width <= right;
  const x = fitsRight ? point.x + CARD_GAP : point.x - CARD_GAP - width;
  const y = Math.min(Math.max(EDGE, point.y - height / 3), bounds.height - height - EDGE);
  card.style.transform = `translate(${Math.round(Math.max(left, x))}px, ${Math.round(y)}px)`;
  card.style.visibility = "visible";
}

/** The world layer: one canvas driven by the scene, and the hover card as DOM above it. */
export function Sky({
  model,
  paused,
  hovered,
  onHover,
  insets,
  focus,
  onSelectAnchor,
  onSelectStar,
  onSelectTask,
  live,
  card,
}: SkyProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<SkyScene | null>(null);
  // The scene's frame callback outlives renders, so it reads the latest insets through a ref.
  const insetsRef = useRef(insets);
  useLayoutEffect(() => {
    insetsRef.current = insets;
  }, [insets]);
  // The stream's listener outlives renders too, and finds stars in the latest model.
  const modelRef = useRef(model);
  useLayoutEffect(() => {
    modelRef.current = model;
  }, [model]);
  // And it reads a posted line with the ids it names as their titles.
  const entities = useEntities();
  const entitiesRef = useRef(entities);
  useLayoutEffect(() => {
    entitiesRef.current = entities;
  }, [entities]);
  // A press on the sky, and whether it has moved far enough to be a drag rather than a click.
  const pressRef = useRef<{ x: number; y: number; dragging: boolean } | null>(null);
  const draggedRef = useRef(false);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null) {
      throw new Error("the sky's canvas is not mounted");
    }
    let bounds = canvas.getBoundingClientRect();
    const scene = new SkyScene(canvas, {
      reducedMotion: window.matchMedia("(prefers-reduced-motion: reduce)").matches,
      onHoverPosition: (point) => place(cardRef.current, point, bounds, insetsRef.current),
    });
    sceneRef.current = scene;
    const observer = new ResizeObserver(() => {
      bounds = canvas.getBoundingClientRect();
      scene.resize(bounds.width, bounds.height, window.devicePixelRatio);
    });
    observer.observe(canvas);
    // Not a React handler: the listener must be active to stop a pinch from zooming the page.
    const wheel = (event: WheelEvent): void => {
      event.preventDefault();
      const pixels =
        event.deltaMode === WheelEvent.DOM_DELTA_LINE ? event.deltaY * 16 : event.deltaY;
      scene.zoomBy(Math.exp(-pixels * (event.ctrlKey ? PINCH_ZOOM : WHEEL_ZOOM)), {
        x: event.offsetX,
        y: event.offsetY,
      });
    };
    canvas.addEventListener("wheel", wheel, { passive: false });
    scene.start();
    return () => {
      canvas.removeEventListener("wheel", wheel);
      observer.disconnect();
      scene.stop();
      sceneRef.current = null;
    };
  }, []);

  useEffect(() => {
    sceneRef.current?.setModel(model);
  }, [model]);
  // Motion is set off by the live stream and fades on its own; nothing about it is kept.
  useEffect(
    () =>
      live.listen((item) => {
        const scene = sceneRef.current;
        if (
          scene === null ||
          item.event.type !== "tool_call" ||
          Date.now() - Date.parse(item.ts) > RECENT_MS
        ) {
          return;
        }
        const star = starOf(modelRef.current, item.agent, item.project);
        if (star === null) {
          return;
        }
        scene.flash(star);
        const line = postedLine(item.event.name, item.event.input);
        if (line !== null) {
          scene.say(star, withTitles(line, entitiesRef.current));
        }
      }),
    [live],
  );
  useEffect(() => {
    sceneRef.current?.setPaused(paused);
  }, [paused]);
  useEffect(() => {
    sceneRef.current?.setHovered(hovered);
  }, [hovered]);
  useEffect(() => {
    sceneRef.current?.setFocus(focus);
  }, [focus]);
  useEffect(() => {
    sceneRef.current?.setInsets(insets.left, insets.right);
  }, [insets.left, insets.right]);

  return (
    <div className="absolute inset-0">
      <canvas
        ref={canvasRef}
        className="size-full touch-none"
        aria-hidden="true"
        onPointerDown={(event) => {
          if (event.button === 0) {
            pressRef.current = { x: event.clientX, y: event.clientY, dragging: false };
            draggedRef.current = false;
          }
        }}
        onPointerUp={(event) => {
          if (pressRef.current?.dragging === true) {
            event.currentTarget.releasePointerCapture(event.pointerId);
            event.currentTarget.style.cursor = "grab";
          }
          pressRef.current = null;
        }}
        onPointerMove={(event) => {
          const scene = sceneRef.current;
          const press = pressRef.current;
          if (press !== null && scene !== null) {
            const dx = event.clientX - press.x;
            const dy = event.clientY - press.y;
            if (!press.dragging && Math.hypot(dx, dy) > DRAG_SLOP) {
              press.dragging = true;
              draggedRef.current = true;
              event.currentTarget.setPointerCapture(event.pointerId);
              onHover(null);
            }
            if (press.dragging) {
              scene.panBy(dx, dy);
              press.x = event.clientX;
              press.y = event.clientY;
              event.currentTarget.style.cursor = "grabbing";
              return;
            }
          }
          const { offsetX, offsetY } = event.nativeEvent;
          const star = scene?.hitTest(offsetX, offsetY) ?? null;
          const mark = star === null ? (scene?.hitTestMark(offsetX, offsetY) ?? null) : null;
          const id = star ?? (mark === null ? null : `task:${mark}`);
          const sphere = id === null ? (scene?.hitTestAnchor(offsetX, offsetY) ?? null) : null;
          event.currentTarget.style.cursor = id !== null || sphere !== null ? "pointer" : "grab";
          if (id !== hovered) {
            onHover(id);
          }
        }}
        onPointerLeave={() => onHover(null)}
        onClick={(event) => {
          const scene = sceneRef.current;
          const { offsetX, offsetY } = event.nativeEvent;
          // The click that ends a drag lands wherever the drag stopped; it selects nothing.
          if (scene === null || draggedRef.current) {
            draggedRef.current = false;
            return;
          }
          const id = scene.hitTest(offsetX, offsetY);
          const mark = id === null ? scene.hitTestMark(offsetX, offsetY) : null;
          const sphere =
            id === null && mark === null ? scene.hitTestAnchor(offsetX, offsetY) : null;
          if (id !== null) {
            onSelectStar(id);
          } else if (mark !== null) {
            onSelectTask(mark);
          } else if (sphere !== null) {
            onSelectAnchor(sphere);
          }
        }}
      />
      <fieldset
        className="card absolute bottom-4 flex flex-col gap-0.5 p-1"
        style={{ right: insets.right + 16 }}
      >
        <legend className="sr-only">Camera</legend>
        <button
          type="button"
          aria-label="Zoom in"
          className={CONTROL}
          onClick={() => sceneRef.current?.zoomBy(STEP_ZOOM)}
        >
          +
        </button>
        <button
          type="button"
          aria-label="Zoom out"
          className={CONTROL}
          onClick={() => sceneRef.current?.zoomBy(1 / STEP_ZOOM)}
        >
          −
        </button>
        <button
          type="button"
          aria-label="Fit the whole sky"
          title="Fit the whole sky"
          className={CONTROL}
          onClick={() => sceneRef.current?.home()}
        >
          ⤢
        </button>
      </fieldset>
      <div
        ref={cardRef}
        className="pointer-events-none absolute top-0 left-0 will-change-transform"
        style={{ visibility: "hidden" }}
      >
        {card}
      </div>
    </div>
  );
}
