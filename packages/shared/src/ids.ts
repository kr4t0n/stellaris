import { z } from "zod";

/** Names for agents, projects, channels, roles, runners: short, lowercase, filename-safe. */
export const NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/;
export const NameSchema = z
  .string()
  .regex(
    NAME_PATTERN,
    "expected 1-32 lowercase letters, digits, or hyphens, starting with a letter or digit",
  );
export type Name = z.infer<typeof NameSchema>;

/** ULIDs identify messages, tasks, proposals, decisions, and events. They sort by time as strings. */
export const ULID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/;
export const UlidSchema = z.string().regex(ULID_PATTERN, "expected a ULID");
export type Ulid = z.infer<typeof UlidSchema>;

/** A channel reference is `<channel>` for society channels or `<project>/<channel>` for project channels. */
export const CHANNEL_REF_PATTERN = /^(?:[a-z0-9][a-z0-9-]{0,31}\/)?[a-z0-9][a-z0-9-]{0,31}$/;
export const ChannelRefSchema = z
  .string()
  .regex(CHANNEL_REF_PATTERN, "expected <channel> or <project>/<channel>");
export type ChannelRef = z.infer<typeof ChannelRefSchema>;

export interface ParsedChannelRef {
  readonly project: Name | null;
  readonly channel: Name;
}

export function parseChannelRef(ref: ChannelRef): ParsedChannelRef {
  const slash = ref.indexOf("/");
  if (slash === -1) {
    return { project: null, channel: ref };
  }
  return { project: ref.slice(0, slash), channel: ref.slice(slash + 1) };
}

export function channelRef(project: Name | null, channel: Name): ChannelRef {
  return project === null ? channel : `${project}/${channel}`;
}

/**
 * ISO-8601 timestamps. YAML frontmatter parsers turn unquoted timestamps into Date objects,
 * so a Date is accepted and normalized back to its ISO string.
 */
export const IsoDateTimeSchema = z.preprocess(
  (value) => (value instanceof Date ? value.toISOString() : value),
  z.iso.datetime(),
);
export type IsoDateTime = z.infer<typeof IsoDateTimeSchema>;
