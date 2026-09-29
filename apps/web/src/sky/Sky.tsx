import { useEffect, useLayoutEffect, useRef, type ReactNode } from "react";
import type { SkyModel } from "./model.js";
import { SkyScene, type ScreenPoint } from "./scene.js";

export interface Insets {
  readonly left: number;
  readonly right: number;
}

interface SkyProps {
  readonly model: SkyModel;
  readonly paused: boolean;
  readonly hovered: string | null;
  readonly onHover: (name: string | null) => void;
  /** Screen space covered by islands at each side; the sky fits between them. */
  readonly insets: Insets;
  /** The anchor whose sphere is drawn brighter, the project the board has open. */
  readonly focus: string | null;
  readonly onSelectAnchor: (anchor: string) => void;
  /** Shown beside the hovered star and moved with it every frame. */
  readonly card: ReactNode;
}

const CARD_GAP = 26;
const EDGE = 12;

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
    scene.start();
    return () => {
      observer.disconnect();
      scene.stop();
      sceneRef.current = null;
    };
  }, []);

  useEffect(() => {
    sceneRef.current?.setModel(model);
  }, [model]);
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
        className="size-full"
        aria-hidden="true"
        onPointerMove={(event) => {
          const scene = sceneRef.current;
          const { offsetX, offsetY } = event.nativeEvent;
          const name = scene?.hitTest(offsetX, offsetY) ?? null;
          const sphere = name === null ? (scene?.hitTestAnchor(offsetX, offsetY) ?? null) : null;
          event.currentTarget.style.cursor = name !== null || sphere !== null ? "pointer" : "";
          if (name !== hovered) {
            onHover(name);
          }
        }}
        onPointerLeave={() => onHover(null)}
        onClick={(event) => {
          const scene = sceneRef.current;
          const { offsetX, offsetY } = event.nativeEvent;
          if (scene !== null && scene.hitTest(offsetX, offsetY) === null) {
            const sphere = scene.hitTestAnchor(offsetX, offsetY);
            if (sphere !== null) {
              onSelectAnchor(sphere);
            }
          }
        }}
      />
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
