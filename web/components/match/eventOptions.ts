import { COLORS } from "@/components/Pitch";
import type { SelectOption } from "@/components/Select";
import { detailsFor } from "@/lib/tagging";
import { EVENT_KEYS, EVENT_LABELS, EVENT_OUTCOMES, EVENT_TYPES, type EventType, type Match, type MatchEvent } from "@/lib/types";

// The options of the drop-downs of the tagging, in one place: type (with its key), result and detail of a type, team.

export const teamColor = (e: Pick<MatchEvent, "team">) => (e.team === "own" ? COLORS.own : e.team === "opp" ? COLORS.opp : "var(--color-faint)");

export const TYPE_OPTIONS: SelectOption<EventType>[] = EVENT_TYPES.map((t) => ({ value: t, label: EVENT_LABELS[t], hint: EVENT_KEYS[t] }));

export const outcomeOptions = (type: EventType): SelectOption<string>[] =>
  Object.entries(EVENT_OUTCOMES[type] ?? {}).map(([value, label]) => ({ value, label }));

export const detailOptions = (e: Pick<MatchEvent, "type" | "outcome">): SelectOption<string>[] => detailsFor(e).map(([value, label]) => ({ value, label }));

export const teamOptions = (match: Match): SelectOption<"own" | "opp">[] => [
  { value: "own", label: match.focus_team, color: COLORS.own },
  { value: "opp", label: match.other_team, color: COLORS.opp },
];
