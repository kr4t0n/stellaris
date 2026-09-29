import { SOCIETY_SCOPE } from "@stellaris/shared";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { CitizenCard } from "./components/CitizenCard.js";
import { Hud } from "./components/Hud.js";
import { ApiError, createApi } from "./lib/api.js";
import { skyModel } from "./sky/model.js";
import { Sky } from "./sky/Sky.js";

/** The current time, refreshed on an interval, for relative times that should not go stale. */
function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}

/** The signed-in view: the sky of citizens, kept current by polling the board. */
export function Playground({ token, onSignOut }: { token: string; onSignOut: () => void }) {
  const api = useMemo(() => createApi(token), [token]);
  const society = useQuery({ queryKey: ["society"], queryFn: api.society, staleTime: 60_000 });
  const members = useQuery({ queryKey: ["members"], queryFn: api.members, refetchInterval: 5_000 });
  const projects = useQuery({
    queryKey: ["projects"],
    queryFn: api.projects,
    refetchInterval: 15_000,
  });
  const roles = useQuery({ queryKey: ["roles"], queryFn: api.roles, refetchInterval: 30_000 });
  const scheduler = useQuery({
    queryKey: ["scheduler"],
    queryFn: api.scheduler,
    refetchInterval: 2_000,
  });
  const [hovered, setHovered] = useState<string | null>(null);
  const now = useNow(30_000);

  const rejected = [society, members, projects, roles, scheduler].some(
    (query) => query.error instanceof ApiError && query.error.status === 401,
  );
  useEffect(() => {
    if (rejected) {
      onSignOut();
    }
  }, [rejected, onSignOut]);

  const model = useMemo(
    () =>
      members.data === undefined || projects.data === undefined || scheduler.data === undefined
        ? null
        : skyModel({ members: members.data, projects: projects.data, scheduler: scheduler.data }),
    [members.data, projects.data, scheduler.data],
  );

  if (model === null) {
    const unreachable = [members, projects, scheduler].some((query) => query.error !== null);
    return (
      <main className="grid h-full place-items-center">
        <p className="text-meta" aria-live="polite">
          {unreachable ? "The board server is not answering. Retrying…" : "Reading the board…"}
        </p>
      </main>
    );
  }

  const star = model.stars.find((candidate) => candidate.name === hovered);
  const member = members.data?.find((candidate) => candidate.name === hovered);
  const place =
    star === undefined || star.anchor === SOCIETY_SCOPE
      ? "the society"
      : (projects.data?.find((project) => project.slug === star.anchor)?.name ?? star.anchor);
  const purpose = roles.data?.find((role) => role.name === member?.role)?.purpose;

  return (
    <main className="relative h-full overflow-hidden">
      <Sky
        model={model}
        paused={scheduler.data?.paused ?? false}
        hovered={hovered}
        onHover={setHovered}
        card={
          star === undefined || member === undefined ? null : (
            <CitizenCard member={member} star={star} purpose={purpose} place={place} now={now} />
          )
        }
      />
      <Hud
        society={society.data?.name}
        citizens={model.stars.length}
        working={model.stars.filter((candidate) => candidate.state === "working").length}
        queued={model.stars.filter((candidate) => candidate.state === "queued").length}
        paused={scheduler.data?.paused ?? false}
        onSignOut={onSignOut}
      />
      {model.stars.length === 0 ? (
        <p className="pointer-events-none absolute inset-x-0 top-1/2 mt-24 text-center text-meta">
          No citizens yet. Ask the concierge for one, or add one with{" "}
          <code className="font-mono text-fg-secondary">stellaris agent add</code>.
        </p>
      ) : null}
      {/* The sky for keyboards and screen readers: focusing a citizen shows the same card. */}
      <ul className="sr-only" aria-label="Citizens">
        {model.stars.map((candidate) => (
          <li key={candidate.name}>
            <button
              type="button"
              onFocus={() => setHovered(candidate.name)}
              onBlur={() => setHovered(null)}
            >
              {candidate.name}, {candidate.state}
            </button>
          </li>
        ))}
      </ul>
    </main>
  );
}
