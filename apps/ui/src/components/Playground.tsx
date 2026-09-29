import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useRouterState } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api/client.js";
import {
  createWorldScene,
  type Building,
  type Camera,
  type Focus,
  type SceneCallbacks,
  type WorldScene,
} from "../world/scene.js";
import { TILE } from "../world/sprites.js";
import type { Citizen, Plot, Point, World, WorldSnapshot } from "../world/types.js";
import { worldFrom } from "../world/world.js";
import { CommandPalette, type PaletteEntry } from "./CommandPalette.js";
import { ConfirmDialog } from "./Dialog.js";
import { Hud } from "./Hud.js";
import { inputClass } from "./ui.js";
import { WorldMirror } from "./WorldMirror.js";

type Pending =
  | { kind: "join"; citizen: string; project: string }
  | { kind: "leave"; citizen: string; project: string }
  | { kind: "handover"; taskId: string; title: string; project: string; citizen: string }
  | { kind: "ask" }
  | null;

function toScreen(camera: Camera, point: Point): { x: number; y: number } {
  return { x: camera.x + point.x * TILE * camera.zoom, y: camera.y + point.y * TILE * camera.zoom };
}

function focusFromPath(pathname: string): Focus {
  const project = /^\/projects\/([^/]+)/.exec(pathname)?.[1];
  if (project !== undefined) return { kind: "plot", slug: project };
  const citizen = /^\/citizens\/([^/]+)/.exec(pathname)?.[1];
  if (citizen !== undefined) return { kind: "citizen", name: citizen };
  if (pathname === "/desk") return { kind: "building", building: "mailbox" };
  if (pathname === "/society") return { kind: "building", building: "townHall" };
  if (pathname === "/library") return { kind: "building", building: "library" };
  return null;
}

/**
 * The playground: the canvas world underneath, and over it the DOM that is read or typed: labels,
 * bubbles, the identity card, the HUD, dialogs, the keyboard mirror, and the command palette.
 */
export function Playground({ snapshot }: { snapshot: WorldSnapshot | null }) {
  const host = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<WorldScene | null>(null);
  const [ready, setReady] = useState<"loading" | "ready" | "unsupported">("loading");
  const [camera, setCamera] = useState<Camera>({ x: 0, y: 0, zoom: 2 });
  const [hoverCitizen, setHoverCitizen] = useState<string | null>(null);
  const [hoverPlot, setHoverPlot] = useState<string | null>(null);
  const [pending, setPending] = useState<Pending>(null);
  const [ask, setAsk] = useState("");
  const [palette, setPalette] = useState(false);
  const navigate = useNavigate();
  // The scene lives as long as the host element; callbacks reach the current navigate through a ref.
  const navigateRef = useRef(navigate);
  useEffect(() => {
    navigateRef.current = navigate;
  }, [navigate]);
  const queryClient = useQueryClient();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const world = useMemo(() => (snapshot === null ? null : worldFrom(snapshot)), [snapshot]);
  const worldRef = useRef<World | null>(null);
  useEffect(() => {
    worldRef.current = world;
  }, [world]);

  const act = useMutation({
    mutationFn: async (action: Exclude<Pending, null>) => {
      switch (action.kind) {
        case "join":
          return api.verb("join_project", { project: action.project, agent: action.citizen });
        case "leave":
          return api.verb("leave_project", { project: action.project, agent: action.citizen });
        case "handover":
          return api.verb("post_message", {
            channel: `${action.project}/general`,
            body: `@${action.citizen} please take task ${action.taskId}: ${action.title}`,
          });
        case "ask":
          return api.verb("post_message", { channel: "general", body: ask });
        default:
          return Promise.reject(new Error("unknown action"));
      }
    },
    onSuccess: () => {
      setPending(null);
      setAsk("");
      void queryClient.invalidateQueries();
    },
  });

  // The scene is created once per host element and torn down with it.
  useEffect(() => {
    const element = host.current;
    if (element === null) return undefined;
    let cancelled = false;
    let scene: WorldScene | null = null;
    const callbacks: SceneCallbacks = {
      onHoverCitizen: setHoverCitizen,
      onHoverPlot: setHoverPlot,
      onClickCitizen: (name) =>
        void navigateRef.current({ to: "/citizens/$name", params: { name } }),
      onClickPlot: (slug) => void navigateRef.current({ to: "/projects/$slug", params: { slug } }),
      onClickCrop: (taskId, slug) =>
        void navigateRef.current({ to: "/projects/$slug/tasks/$taskId", params: { slug, taskId } }),
      onClickBuilding: (building: Building) => {
        switch (building) {
          case "mailbox":
            void navigateRef.current({ to: "/desk" });
            return;
          case "townHall":
            void navigateRef.current({ to: "/society" });
            return;
          case "library":
            void navigateRef.current({ to: "/library" });
            return;
          case "frontDesk":
            setPending({ kind: "ask" });
            return;
          case "clock":
            void navigateRef.current({ to: "/society" });
            return;
          default:
            return;
        }
      },
      onDropCitizen: (name, from, target) => {
        const current = worldRef.current;
        const citizen = current?.citizens.find((entry) => entry.name === name);
        if (citizen === undefined) return;
        const plot = current?.plots.find((entry) => entry.slug === target);
        if (plot !== undefined && !plot.members.includes(name)) {
          setPending({ kind: "join", citizen: name, project: plot.slug });
          return;
        }
        const fromPlot = current?.plots.find((entry) => entry.slug === from);
        if (target === null && fromPlot !== undefined && fromPlot.members.includes(name)) {
          setPending({ kind: "leave", citizen: name, project: fromPlot.slug });
        }
      },
      onDropCrop: (taskId, slug, citizen) => {
        const current = worldRef.current;
        const crop = current?.plots
          .find((plot) => plot.slug === slug)
          ?.crops.find((entry) => entry.taskId === taskId);
        if (crop === undefined) return;
        setPending({ kind: "handover", taskId, title: crop.title, project: slug, citizen });
      },
      onCamera: setCamera,
    };
    void (async () => {
      try {
        const created = await createWorldScene(element, callbacks);
        if (cancelled) {
          created.destroy();
          return;
        }
        scene = created;
        sceneRef.current = created;
        setReady("ready");
        if (worldRef.current !== null) created.apply(worldRef.current);
      } catch {
        if (!cancelled) setReady("unsupported");
      }
    })();
    return () => {
      cancelled = true;
      sceneRef.current = null;
      setReady("loading");
      scene?.destroy();
    };
  }, []);

  useEffect(() => {
    if (world !== null) sceneRef.current?.apply(world);
  }, [world]);

  useEffect(() => {
    if (ready !== "ready") return;
    const scene = sceneRef.current;
    if (scene === null) return;
    scene.setInset(pathname === "/" ? 0 : Math.min(600, window.innerWidth * 0.6));
    const target = focusFromPath(pathname);
    if (target === null) {
      scene.focus(null);
      scene.fit();
    } else {
      scene.focus(target);
    }
  }, [pathname, ready]);

  useEffect(() => {
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = (): void => sceneRef.current?.setReducedMotion(media.matches);
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  const jumpTo = useCallback(
    (target: Focus) => {
      if (target === null) return;
      if (target.kind === "plot")
        void navigate({ to: "/projects/$slug", params: { slug: target.slug } });
      else if (target.kind === "citizen")
        void navigate({ to: "/citizens/$name", params: { name: target.name } });
      else if (target.building === "mailbox") void navigate({ to: "/desk" });
      else if (target.building === "library") void navigate({ to: "/library" });
      else if (target.building === "frontDesk") setPending({ kind: "ask" });
      else void navigate({ to: "/society" });
    },
    [navigate],
  );

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      const target = event.target;
      const typing =
        target instanceof HTMLElement &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.tagName === "SELECT" ||
          target.isContentEditable);
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setPalette((value) => !value);
        return;
      }
      if (typing || event.metaKey || event.ctrlKey || event.altKey) return;
      const scene = sceneRef.current;
      if (scene === null) return;
      const step = 48;
      switch (event.key) {
        case "ArrowLeft":
          scene.panBy(step, 0);
          break;
        case "ArrowRight":
          scene.panBy(-step, 0);
          break;
        case "ArrowUp":
          scene.panBy(0, step);
          break;
        case "ArrowDown":
          scene.panBy(0, -step);
          break;
        case "+":
        case "=":
          scene.zoomBy(1);
          break;
        case "-":
          scene.zoomBy(-1);
          break;
        case "0":
          scene.fit();
          break;
        case "Escape":
          if (pathname !== "/") void navigate({ to: "/" });
          break;
        default: {
          const digit = Number(event.key);
          if (Number.isInteger(digit) && digit >= 1 && digit <= 9) {
            const plot = worldRef.current?.plots[digit - 1];
            if (plot !== undefined)
              void navigate({ to: "/projects/$slug", params: { slug: plot.slug } });
          }
          return;
        }
      }
      event.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [navigate, pathname]);

  const paletteEntries = useMemo<PaletteEntry[]>(() => {
    if (world === null || snapshot === null) return [];
    const entries: PaletteEntry[] = [];
    for (const plot of world.plots) {
      entries.push({
        key: `plot:${plot.slug}`,
        label: plot.name,
        hint: "project",
        run: () => void navigate({ to: "/projects/$slug", params: { slug: plot.slug } }),
      });
      for (const crop of plot.crops) {
        entries.push({
          key: `task:${crop.taskId}`,
          label: crop.title,
          hint: `task · ${plot.slug} · ${crop.stage}`,
          run: () =>
            void navigate({
              to: "/projects/$slug/tasks/$taskId",
              params: { slug: plot.slug, taskId: crop.taskId },
            }),
        });
      }
    }
    for (const citizen of world.citizens) {
      entries.push({
        key: `citizen:${citizen.name}`,
        label: citizen.name,
        hint: `${citizen.role} on ${citizen.cli}`,
        run: () => void navigate({ to: "/citizens/$name", params: { name: citizen.name } }),
      });
    }
    entries.push(
      {
        key: "desk",
        label: "Mailbox",
        hint: "what needs you",
        run: () => void navigate({ to: "/desk" }),
      },
      {
        key: "hall",
        label: "Town hall",
        hint: "members, roles, proposals, signals",
        run: () => void navigate({ to: "/society" }),
      },
      {
        key: "library",
        label: "Library",
        hint: "skills and knowledge",
        run: () => void navigate({ to: "/library" }),
      },
      {
        key: "ask",
        label: "Ask the society",
        hint: "front desk",
        run: () => setPending({ kind: "ask" }),
      },
    );
    return entries;
  }, [world, snapshot, navigate]);

  const hovered = world?.citizens.find((citizen) => citizen.name === hoverCitizen) ?? null;

  return (
    <div className="fixed inset-0 flex flex-col bg-board-bg text-board-text">
      <Hud world={world} onPalette={() => setPalette(true)} onFit={() => sceneRef.current?.fit()} />
      <div className="relative min-h-0 flex-1">
        <div ref={host} data-testid="world-canvas" className="absolute inset-0 select-none" />
        {ready === "unsupported" ? (
          <div className="absolute inset-0 flex items-center justify-center p-8 text-center text-sm text-board-muted">
            This browser cannot draw the world (WebGL is unavailable). The mailbox, town hall,
            library, and projects still work from the bar above.
          </div>
        ) : null}
        {snapshot === null && ready !== "unsupported" ? (
          <div className="absolute inset-0 flex items-center justify-center text-sm text-board-muted">
            Loading the society…
          </div>
        ) : null}
        {world === null || ready !== "ready" ? null : (
          <Overlay world={world} camera={camera} hovered={hovered} hoverPlot={hoverPlot} />
        )}
        {world === null ? null : (
          <WorldMirror
            world={world}
            onFocus={(target) => sceneRef.current?.focus(target)}
            onOpen={jumpTo}
          />
        )}
        <p className="pointer-events-none absolute bottom-2 left-3 text-[11px] text-board-muted">
          Drag to pan · wheel to zoom · arrows and 0 · 1–9 jump to a plot · drag a citizen into a
          plot to add it · drag a crop onto a citizen to hand it over
        </p>
      </div>
      <CommandPalette open={palette} entries={paletteEntries} onClose={() => setPalette(false)} />
      <ConfirmDialog
        open={pending?.kind === "join"}
        title={pending?.kind === "join" ? `Add ${pending.citizen} to ${pending.project}?` : ""}
        confirmLabel="Add to project"
        busy={act.isPending}
        error={act.error}
        onConfirm={() => pending !== null && act.mutate(pending)}
        onCancel={() => setPending(null)}
      >
        It gets a worktree on the project and an onboarding turn, which costs one turn.
      </ConfirmDialog>
      <ConfirmDialog
        open={pending?.kind === "leave"}
        title={
          pending?.kind === "leave" ? `Remove ${pending.citizen} from ${pending.project}?` : ""
        }
        confirmLabel="Remove from project"
        tone="danger"
        busy={act.isPending}
        error={act.error}
        onConfirm={() => pending !== null && act.mutate(pending)}
        onCancel={() => setPending(null)}
      >
        Its claims on the project go back to open. Its home and memory stay.
      </ConfirmDialog>
      <ConfirmDialog
        open={pending?.kind === "handover"}
        title={pending?.kind === "handover" ? `Hand "${pending.title}" to ${pending.citizen}?` : ""}
        confirmLabel="Post the mention"
        busy={act.isPending}
        error={act.error}
        onConfirm={() => pending !== null && act.mutate(pending)}
        onCancel={() => setPending(null)}
      >
        This posts a mention in the project's general channel, which wakes the citizen for a turn.
      </ConfirmDialog>
      <ConfirmDialog
        open={pending?.kind === "ask"}
        title="Ask the society"
        confirmLabel="Post to the front desk"
        busy={act.isPending || ask.trim().length === 0}
        error={act.error}
        onConfirm={() => pending !== null && act.mutate(pending)}
        onCancel={() => setPending(null)}
      >
        <p className="mb-2">Name no project and no citizen; the concierge routes it.</p>
        <textarea
          value={ask}
          onChange={(event) => setAsk(event.target.value)}
          rows={4}
          placeholder="What do you need?"
          className={`${inputClass} w-full font-mono`}
        />
      </ConfirmDialog>
    </div>
  );
}

/** Labels, bubbles, and the identity card, placed from scene coordinates and never interactive. */
function Overlay({
  world,
  camera,
  hovered,
  hoverPlot,
}: {
  world: World;
  camera: Camera;
  hovered: Citizen | null;
  hoverPlot: string | null;
}) {
  const place = (point: Point, dx = 0, dy = 0) => {
    const screen = toScreen(camera, point);
    return { left: screen.x + dx * camera.zoom, top: screen.y + dy * camera.zoom };
  };
  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden">
      {(
        [
          ["Front desk", world.square.frontDesk],
          ["Town hall", world.square.townHall],
          ["Library", world.square.library],
        ] as const
      ).map(([label, rect]) => (
        <div
          key={label}
          style={place({ x: rect.x + rect.w / 2, y: rect.y + rect.h }, 0, 2)}
          className="absolute -translate-x-1/2 whitespace-nowrap text-[10px] text-board-muted"
        >
          {label}
        </div>
      ))}
      <div
        style={place({ x: world.square.mailbox.x + 0.5, y: world.square.mailbox.y + 1 }, 0, 2)}
        className="absolute -translate-x-1/2 whitespace-nowrap text-[10px] text-board-muted"
      >
        {world.mailbox.waiting > 0 ? `Mailbox · ${world.mailbox.waiting}` : "Mailbox"}
      </div>
      {world.memorials.map((memorial) => (
        <div
          key={memorial.agent}
          style={place({ x: memorial.at.x + 0.5, y: memorial.at.y + 1 }, 0, 2)}
          className="absolute -translate-x-1/2 whitespace-nowrap text-[10px] text-board-muted"
          title={memorial.reason}
        >
          {memorial.agent}
        </div>
      ))}
      {world.plots.map((plot: Plot) => (
        <div
          key={plot.slug}
          style={place(plot.sign, TILE + 4, -6)}
          className={`absolute -translate-y-full whitespace-nowrap rounded border px-1.5 py-0.5 text-[11px] ${
            hoverPlot === plot.slug
              ? "border-board-accent bg-board-panel text-board-text"
              : "border-board-border bg-board-bg/80 text-board-muted"
          }`}
        >
          <span className="font-semibold text-board-text">{plot.name}</span>
          <span className="ml-1">
            {plot.members.length} ·{" "}
            {
              plot.crops.filter((crop) => crop.stage !== "harvested" && crop.stage !== "withered")
                .length
            }{" "}
            growing
            {plot.overflow > 0 ? ` · +${plot.overflow}` : ""}
          </span>
        </div>
      ))}
      {world.citizens.map((citizen) => (
        <div key={citizen.name}>
          <div
            style={place(citizen.at, TILE / 2, TILE + 2)}
            className="absolute -translate-x-1/2 whitespace-nowrap text-[10px] text-board-muted"
          >
            {citizen.name}
          </div>
          {citizen.bubble === null ? null : (
            <div
              style={place(citizen.at, TILE / 2, -TILE * 1.4)}
              className="absolute max-w-56 -translate-x-1/2 -translate-y-full rounded-lg border border-board-border bg-board-panel px-2 py-1 text-[11px] text-board-text shadow"
            >
              {citizen.bubble}
            </div>
          )}
        </div>
      ))}
      {hovered === null ? null : (
        <div
          data-testid="identity-card"
          style={place(hovered.at, TILE, -TILE)}
          className="absolute z-10 w-64 -translate-y-full rounded-lg border border-board-border bg-board-panel p-3 text-xs shadow-xl"
        >
          <div className="flex items-baseline gap-2">
            <span className="text-sm font-semibold">{hovered.name}</span>
            <span className="text-board-muted">
              {hovered.role} on {hovered.cli}
              {hovered.model === null ? "" : ` · ${hovered.model}`}
            </span>
          </div>
          <div className="mt-1 text-board-muted">
            {hovered.state === "working" || hovered.state === "talking"
              ? `Working in ${hovered.where}`
              : hovered.state === "walking"
                ? `On the way to ${hovered.where}`
                : hovered.state === "sleeping"
                  ? "Idle for days"
                  : hovered.where === "home"
                    ? "At home"
                    : `At the ${hovered.where}`}
            {hovered.lastTurn === null ? "" : ` · last turn: ${hovered.lastTurn}`}
          </div>
          <div className="mt-1">
            {hovered.claims} claim(s) · skills:{" "}
            {hovered.skills.length === 0 ? "none" : hovered.skills.join(", ")}
          </div>
          <p className="mt-1 text-board-muted">
            {hovered.profile.length === 0 ? "No profile yet." : hovered.profile}
          </p>
        </div>
      )}
    </div>
  );
}
