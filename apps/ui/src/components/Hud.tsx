import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { api, setToken } from "../api/client.js";
import type { World } from "../world/types.js";
import { Button, Pill } from "./ui.js";

const linkClass =
  "rounded px-2 py-1 text-xs text-board-muted hover:bg-board-panel hover:text-board-text [&.active]:bg-board-panel [&.active]:text-board-text";

/** The strip across the top of the world: where to go, what it costs today, and the pause switch. */
export function Hud({
  world,
  onPalette,
  onFit,
}: {
  world: World | null;
  onPalette: () => void;
  onFit: () => void;
}) {
  const queryClient = useQueryClient();
  const society = useQuery({ queryKey: ["society"], queryFn: api.society });
  const scheduler = useQuery({ queryKey: ["scheduler"], queryFn: api.scheduler });
  const toggle = useMutation({
    mutationFn: () => (scheduler.data?.paused ? api.resume() : api.pause()),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["scheduler"] }),
  });
  const running = scheduler.data?.running ?? [];
  return (
    <header
      data-testid="hud"
      className="pointer-events-auto flex h-12 items-center gap-2 border-b border-board-border bg-board-bg/90 px-3 backdrop-blur"
    >
      <Link
        to="/"
        className="mr-2 text-sm font-semibold text-board-text"
        activeOptions={{ exact: true }}
      >
        {society.data?.name ?? "Stellaris"}
      </Link>
      <Link to="/desk" className={linkClass}>
        Mailbox
        {world !== null && world.mailbox.waiting > 0 ? (
          <span
            data-testid="mailbox-flag"
            className="ml-1 rounded-full bg-rose-500 px-1.5 text-[10px] font-semibold text-white"
          >
            {world.mailbox.waiting}
          </span>
        ) : null}
      </Link>
      <Link to="/society" className={linkClass}>
        Town hall
      </Link>
      <Link to="/library" className={linkClass}>
        Library
      </Link>
      <Link to="/live" className={linkClass}>
        Live
      </Link>
      <button type="button" onClick={onPalette} className={linkClass}>
        Go to… <kbd className="ml-1 rounded border border-board-border px-1 text-[10px]">⌘K</kbd>
      </button>
      <button type="button" onClick={onFit} className={linkClass}>
        Fit
      </button>
      <div className="ml-auto flex items-center gap-2 text-xs">
        {world === null ? null : (
          <span data-testid="coins" className="text-amber-300" title="Metered spend since midnight">
            ◎ {world.coins.toFixed(2)} today
          </span>
        )}
        {running.map((pair) => (
          <Pill key={pair} className="border-emerald-800 text-emerald-300">
            {pair}
          </Pill>
        ))}
        {scheduler.data?.paused ? (
          <Pill className="border-amber-800 text-amber-300">night: paused</Pill>
        ) : null}
        <Button
          tone={scheduler.data?.paused ? "primary" : "default"}
          onClick={() => toggle.mutate()}
          disabled={toggle.isPending}
        >
          {scheduler.data?.paused ? "Resume" : "Pause"}
        </Button>
        <button
          type="button"
          onClick={() => {
            setToken(null);
            window.location.href = "/login";
          }}
          className={linkClass}
        >
          Sign out
        </button>
      </div>
    </header>
  );
}
