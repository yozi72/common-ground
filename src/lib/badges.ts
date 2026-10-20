// Badge definitions. Thresholds must match supabase/migrations/0003_stats_badges.sql.
// Badges are about participation only; they never identify anyone.

export type Stats = { people: number; conversations: number; friends: number; full_rounds: number; reconnections: number };

export type Badge = { id: string; name: string; description: string; earned: boolean; progress?: string; kind: "people" | "friends" | "special" };

export const PEOPLE_TIERS = [1, 5, 10, 25, 50, 100] as const;
export const FRIEND_TIERS = [1, 2, 5, 10, 25] as const;

const PEOPLE_NAMES: Record<number, string> = { 1: "First conversation", 5: "Five voices", 10: "Ten voices", 25: "Twenty-five voices", 50: "Fifty voices", 100: "A hundred voices" };
const FRIEND_NAMES: Record<number, string> = { 1: "First friend", 2: "Two friends", 5: "Five friends", 10: "Ten friends", 25: "Twenty-five friends" };

export function badgesFor(s: Stats): Badge[] {
  const out: Badge[] = [];
  for (const t of PEOPLE_TIERS) {
    out.push({ id: `people-${t}`, kind: "people", name: PEOPLE_NAMES[t], description: `Talked with ${t} ${t === 1 ? "person" : "different people"}`, earned: s.people >= t, progress: s.people < t ? `${s.people} / ${t}` : undefined });
  }
  for (const t of FRIEND_TIERS) {
    out.push({ id: `friends-${t}`, kind: "friends", name: FRIEND_NAMES[t], description: `${t} ${t === 1 ? "person" : "people"} you both chose to talk with again`, earned: s.friends >= t, progress: s.friends < t ? `${s.friends} / ${t}` : undefined });
  }
  out.push({ id: "full-round", kind: "special", name: "Full round", description: "Finished all ten opening questions in one conversation", earned: s.full_rounds > 0 });
  out.push({ id: "came-back", kind: "special", name: "Came back", description: "Had a second conversation with a friend", earned: s.reconnections > 0 });
  return out;
}

// Next milestone text for the profile header, e.g. "3 more conversations to Ten voices".
export function nextMilestone(s: Stats): string | null {
  const next = PEOPLE_TIERS.find((t) => t > s.people);
  if (!next) return null;
  const n = next - s.people;
  return `${n} more ${n === 1 ? "person" : "people"} to “${PEOPLE_NAMES[next]}”`;
}

// Coarse labels shown to the other participant.
export function peerBadgeLabels(b: { people_tier: number; friends_tier: number; full_round: boolean; came_back: boolean } | null): string[] {
  if (!b) return [];
  const out: string[] = [];
  if (b.people_tier >= 5) out.push(`Talked with ${b.people_tier}+ people`);
  else if (b.people_tier >= 1) out.push("Has talked here before");
  else out.push("First conversation");
  if (b.friends_tier >= 1) out.push(`${b.friends_tier}+ friend${b.friends_tier === 1 ? "" : "s"} here`);
  if (b.came_back) out.push("Came back");
  return out;
}
