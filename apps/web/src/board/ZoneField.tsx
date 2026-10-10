import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { choiceClass, LIST_CARD } from "../components/Picker.js";
import { FIELD } from "./ThreadForms.js";

/** Every zone the browser knows, UTC first. */
const ZONES = ["UTC", ...Intl.supportedValuesOf("timeZone").filter((zone) => zone !== "UTC")];

/** How many matches the list shows; typing narrows the rest. */
const SHOWN = 50;

/** A zone's offset from UTC now, as `UTC+08:00`, or `UTC` for none. */
function offsetOf(zone: string, now: Date): string {
  const name =
    new Intl.DateTimeFormat("en-US", { timeZone: zone, timeZoneName: "longOffset" })
      .formatToParts(now)
      .find((part) => part.type === "timeZoneName")?.value ?? "";
  return name === "GMT" ? "UTC" : name.replace("GMT", "UTC");
}

/**
 * A time zone typed or picked: the text box filters the zones the browser knows, listed below it
 * in the card the board's pickers use, with each zone's offset from UTC now. The list takes room
 * in the form rather than floating, so it never covers the form's buttons.
 */
export function ZoneField({
  value,
  onChange,
  label,
  placeholder,
}: {
  value: string;
  onChange: (zone: string) => void;
  label: string;
  placeholder?: string | undefined;
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const items = useRef<Array<HTMLButtonElement | null>>([]);
  const query = value.trim().toLowerCase();
  const matches = useMemo(
    () =>
      (query === "" ? ZONES : ZONES.filter((zone) => zone.toLowerCase().includes(query))).slice(
        0,
        SHOWN,
      ),
    [query],
  );
  const now = useMemo(() => new Date(), []);

  // The choice the arrow keys are on stays in view as they move through a long list.
  useEffect(() => {
    if (open) {
      items.current[active]?.scrollIntoView({ block: "nearest" });
    }
  }, [open, active]);

  useEffect(() => {
    if (!open) {
      return undefined;
    }
    // Closed once a click elsewhere has landed: the list takes room in the form, so closing it as
    // the pointer goes down would move the button being clicked out from under the pointer.
    const away = (event: MouseEvent): void => {
      if (!(event.target instanceof Node && root.current?.contains(event.target) === true)) {
        setOpen(false);
      }
    };
    window.addEventListener("click", away);
    return () => window.removeEventListener("click", away);
  }, [open]);

  const choose = (zone: string): void => {
    onChange(zone);
    setOpen(false);
  };
  const keys = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (!open) {
        setOpen(true);
        return;
      }
      const step = event.key === "ArrowDown" ? 1 : -1;
      setActive((at) => (at + step + matches.length) % Math.max(matches.length, 1));
      return;
    }
    if (event.key === "Enter" && open && matches[active] !== undefined) {
      // Picking a zone is not submitting the form it sits in.
      event.preventDefault();
      choose(matches[active]);
      return;
    }
    if (event.key === "Tab") {
      setOpen(false);
      return;
    }
    if (event.key === "Escape" && open) {
      // The board closes on Escape too; this one only closes the list.
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
    }
  };

  return (
    <div ref={root} className="relative min-w-0 flex-1">
      <input
        aria-label={label}
        value={value}
        spellCheck={false}
        autoComplete="off"
        placeholder={placeholder}
        onChange={(event) => {
          onChange(event.target.value);
          setActive(0);
          setOpen(true);
        }}
        onClick={() => setOpen(true)}
        onKeyDown={keys}
        className={FIELD}
      />
      {open && matches.length > 0 && !(matches.length === 1 && matches[0] === value) ? (
        <div className={`max-h-48 ${LIST_CARD}`}>
          {matches.map((zone, index) => (
            <button
              key={zone}
              ref={(element) => {
                items.current[index] = element;
              }}
              type="button"
              // The arrow keys move through the list from the text box, which keeps the focus.
              tabIndex={-1}
              aria-current={index === active ? "true" : undefined}
              onPointerDown={(event) => event.preventDefault()}
              onPointerEnter={() => setActive(index)}
              onClick={() => choose(zone)}
              className={choiceClass(index === active)}
            >
              <span className="min-w-0 flex-1 truncate text-xs text-fg-secondary">{zone}</span>
              <span className="shrink-0 text-[11px] text-fg-muted">{offsetOf(zone, now)}</span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
