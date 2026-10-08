import { USER_NAME, type Member } from "@stellaris/shared";
import { createContext, useContext } from "react";
import { CliIcon } from "../components/CliIcon.js";
import type { SignIn } from "../lib/api.js";

/** The GitHub account this browser signed in with, which the user's posts and names show. */
export const SignInContext = createContext<SignIn | undefined>(undefined);

/** A GitHub avatar's address at `px` pixels, so the browser fetches the size it shows. */
function avatarAt(url: string, px: number): string {
  const sized = new URL(url);
  sized.searchParams.set(sized.hostname === "github.com" ? "size" : "s", String(px));
  return sized.href;
}

/** Who wrote something: a citizen's CLI mark, the user, or the board itself. */
export function Avatar({
  name,
  members,
}: {
  name: string;
  members: readonly Member[] | undefined;
}) {
  const signIn = useContext(SignInContext);
  const cli = members?.find((member) => member.name === name)?.cli ?? null;
  if (cli !== null) {
    return (
      <span className="grid size-7 shrink-0 place-items-center rounded-lg bg-surface-2/80">
        <CliIcon cli={cli} size={16} />
      </span>
    );
  }
  if (name === USER_NAME && signIn !== undefined) {
    return (
      <img
        src={avatarAt(signIn.avatarUrl, 56)}
        alt=""
        width={28}
        height={28}
        referrerPolicy="no-referrer"
        className="size-7 shrink-0 rounded-lg bg-surface-2/80 object-cover"
      />
    );
  }
  if (name === USER_NAME) {
    return (
      <span className="grid size-7 shrink-0 place-items-center rounded-lg bg-fg-primary/90 text-[10px] font-semibold text-surface-0">
        you
      </span>
    );
  }
  return (
    <span
      aria-hidden="true"
      className="grid size-7 shrink-0 place-items-center rounded-lg bg-surface-2/50 text-xs text-fg-muted"
    >
      ✦
    </span>
  );
}

/** A citizen's name with its CLI mark, inline in a sentence. */
export function Citizen({
  name,
  members,
}: {
  name: string;
  members: readonly Member[] | undefined;
}) {
  const cli = members?.find((member) => member.name === name)?.cli ?? null;
  return (
    <span className="inline-flex items-center gap-1 align-middle">
      {cli === null ? null : <CliIcon cli={cli} size={12} />}
      <span className="text-fg-secondary">{name}</span>
    </span>
  );
}

/** How the board names an author: the user by the GitHub account signed in, else as "you". */
export function displayName(name: string, signIn?: SignIn): string {
  return name === USER_NAME ? (signIn?.login ?? "you") : name;
}

/** `displayName` for this browser's sign-in. */
export function useDisplayName(): (name: string) => string {
  const signIn = useContext(SignInContext);
  return (name) => displayName(name, signIn);
}
