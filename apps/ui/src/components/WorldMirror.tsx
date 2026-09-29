import { useEffect, useRef, useState } from "react";
import type { Focus } from "../world/scene.js";
import type { World } from "../world/types.js";
import { describeWorld } from "../world/world.js";

/**
 * The world for keyboard and screen-reader users: one focusable entry per entity, in the same
 * words the browser session asserts on, and a live region that announces what changed. Focusing
 * an entry moves the camera and opens the same card a hover would.
 */
export function WorldMirror({
  world,
  onFocus,
  onOpen,
}: {
  world: World;
  onFocus: (target: Focus) => void;
  onOpen: (target: Focus) => void;
}) {
  const described = describeWorld(world);
  const previous = useRef<string[] | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const [log, setLog] = useState<string[]>([]);
  useEffect(() => {
    const lines = [...described.citizens, ...described.plots, ...described.square.slice(0, 2)];
    if (previous.current !== null) {
      const before = previous.current;
      const changed = lines.filter((line) => !before.includes(line));
      if (changed.length > 0) {
        setAnnouncement(changed.join(". "));
        setLog((current) => [...current, ...changed].slice(-80));
      }
    }
    previous.current = lines;
  }, [described.citizens, described.plots, described.square]);

  const entry = (label: string, target: Focus, key: string) => (
    <li key={key}>
      <button
        type="button"
        onFocus={() => onFocus(target)}
        onClick={() => onOpen(target)}
        className="focus:not-sr-only focus:fixed focus:top-16 focus:left-4 focus:z-50 focus:rounded focus:bg-board-panel focus:px-3 focus:py-1 focus:text-sm focus:text-board-text focus:ring-2 focus:ring-board-accent"
      >
        {label}
      </button>
    </li>
  );

  return (
    <div data-testid="world-mirror" className="sr-only" aria-label="The world">
      <h2>Citizens</h2>
      <ul>
        {world.citizens.map((citizen, index) =>
          entry(
            described.citizens[index] ?? citizen.name,
            { kind: "citizen", name: citizen.name },
            `citizen-${citizen.name}`,
          ),
        )}
      </ul>
      <h2>Plots</h2>
      <ul>
        {world.plots.map((plot, index) =>
          entry(
            described.plots[index] ?? plot.slug,
            { kind: "plot", slug: plot.slug },
            `plot-${plot.slug}`,
          ),
        )}
      </ul>
      <h2>Square</h2>
      <ul>
        {entry(
          described.square[0] ?? "Mailbox",
          { kind: "building", building: "mailbox" },
          "mailbox",
        )}
        {entry(
          described.square[1] ?? "Town hall",
          { kind: "building", building: "townHall" },
          "townHall",
        )}
        {entry(
          described.square[2] ?? "Library",
          { kind: "building", building: "library" },
          "library",
        )}
        {entry(described.square[3] ?? "Clock", { kind: "building", building: "clock" }, "clock")}
        {entry(
          "Front desk: ask the society",
          { kind: "building", building: "frontDesk" },
          "frontDesk",
        )}
      </ul>
      <div aria-live="polite" data-testid="world-announcements">
        {announcement}
      </div>
      <h2>What changed</h2>
      <ol data-testid="world-log">
        {log.map((line, index) => (
          <li key={`${index}-${line}`}>{line}</li>
        ))}
      </ol>
    </div>
  );
}
