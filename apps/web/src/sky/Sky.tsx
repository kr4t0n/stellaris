import { useEffect, useRef, type ReactNode } from "react";
import type { SkyModel } from "./model.js";
import { SkyScene, type ScreenPoint } from "./scene.js";

interface SkyProps {
  readonly model: SkyModel;
  readonly paused: boolean;
  readonly hovered: string | null;
  readonly onHover: (name: string | null) => void;
  /** Shown beside the hovered star and moved with it every frame. */
  readonly card: ReactNode;
}

const CARD_GAP = 26;

/** Puts the card beside the star, flipping to the left or clamping when it would leave the sky. */
function place(card: HTMLElement | null, point: ScreenPoint | null, bounds: DOMRect): void {
  if (card === null) {
    return;
  }
  if (point === null) {
    card.style.visibility = "hidden";
    return;
  }
  const width = card.offsetWidth;
  const height = card.offsetHeight;
  const right = point.x + CARD_GAP + width <= bounds.width - 12;
  const x = right ? point.x + CARD_GAP : point.x - CARD_GAP - width;
  const y = Math.min(Math.max(12, point.y - height / 3), bounds.height - height - 12);
  card.style.transform = `translate(${Math.round(Math.max(12, x))}px, ${Math.round(y)}px)`;
  card.style.visibility = "visible";
}

/** The world layer: one canvas driven by the scene, and the hover card as DOM above it. */
export function Sky({ model, paused, hovered, onHover, card }: SkyProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<SkyScene | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null) {
      throw new Error("the sky's canvas is not mounted");
    }
    let bounds = canvas.getBoundingClientRect();
    const scene = new SkyScene(canvas, {
      reducedMotion: window.matchMedia("(prefers-reduced-motion: reduce)").matches,
      onHoverPosition: (point) => place(cardRef.current, point, bounds),
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

  return (
    <div className="absolute inset-0">
      <canvas
        ref={canvasRef}
        className="size-full"
        style={{ cursor: hovered === null ? "default" : "pointer" }}
        aria-hidden="true"
        onPointerMove={(event) => {
          const name =
            sceneRef.current?.hitTest(event.nativeEvent.offsetX, event.nativeEvent.offsetY) ?? null;
          if (name !== hovered) {
            onHover(name);
          }
        }}
        onPointerLeave={() => onHover(null)}
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
