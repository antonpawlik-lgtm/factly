// Pure recommendation math — no DOM, no storage. Stats objects have the
// shape { likes, dislikes, dwell } and are injected by the caller, which
// makes every function here unit-testable with a fixed rng.

export function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

export function statScore(stats) {
  if (!stats) return 0;
  return (stats.likes || 0) - (stats.dislikes || 0) + (stats.dwell || 0);
}

// Confidence smoothing: a single reaction shouldn't swing a weight hard.
// The raw score is scaled by n/(n+2) where n is the interaction volume —
// one lonely dislike moves the weight a third as far as it used to, while
// well-established preferences keep their full effect.
export function smoothedScore(stats) {
  if (!stats) return 0;
  const n = (stats.likes || 0) + (stats.dislikes || 0) + Math.abs(stats.dwell || 0);
  if (n === 0) return 0;
  return statScore(stats) * (n / (n + 2));
}

export function categoryWeight(stats) {
  return clamp(1 + 0.4 * smoothedScore(stats), 0.15, 6);
}

// Tighter clamp than categories: tag scores grow faster (one like touches up
// to 3 tags) and they act multiplicatively inside scoreFact.
export function tagWeight(stats) {
  return clamp(1 + 0.4 * smoothedScore(stats), 0.25, 4);
}

// Mean (not product) so multi-tag facts aren't systematically favored or
// punished just for carrying more tags. No/unknown tags = neutral weight 1.
export function factWeight(fact, tagStats) {
  const tags = (fact && fact.tags) || [];
  if (tags.length === 0) return 1;
  return tags.reduce((sum, t) => sum + tagWeight(tagStats[t]), 0) / tags.length;
}

// Recency cooldown instead of a hard seen-list reset: a fact seen in the
// current session is out entirely (weight 0), one seen within the last
// NOVELTY_COOLDOWN_SESSIONS is heavily damped, anything older is fresh.
// weightedRandom degrades to uniform when every candidate is 0, so a very
// long session recycles gracefully instead of dead-ending.
export const NOVELTY_COOLDOWN_SESSIONS = 3;

export function noveltyFactor(lastSeenSession, currentSession) {
  if (lastSeenSession === undefined || lastSeenSession === null) return 1;
  const age = currentSession - lastSeenSession;
  if (age <= 0) return 0;
  if (age < NOVELTY_COOLDOWN_SESSIONS) return 0.1;
  return 1;
}

// One number per fact: how much this fact deserves the next slot.
// Category taste × tag taste × freshness.
export function scoreFact(fact, { categoryStats, tagStats, seenAt, session }) {
  return (
    categoryWeight(categoryStats[fact.category]) *
    factWeight(fact, tagStats) *
    noveltyFactor(seenAt[String(fact.id)], session)
  );
}

// Cumulative weighted-random pick. Injectable rng makes it deterministic in
// tests; all-zero weights degrade to a uniform pick.
export function weightedRandom(items, getWeight, rng = Math.random) {
  if (!items || items.length === 0) return null;
  const weights = items.map((item) => Math.max(0, getWeight(item)));
  const total = weights.reduce((sum, w) => sum + w, 0);
  if (total === 0) return items[Math.floor(rng() * items.length)];
  let cursor = rng() * total;
  for (let i = 0; i < items.length; i++) {
    cursor -= weights[i];
    if (cursor <= 0) return items[i];
  }
  return items[items.length - 1];
}

// Gentle per-session decay so weights reflect current taste instead of being
// pinned forever by months-old reactions.
export function decayStats(statsObj, factor) {
  Object.values(statsObj).forEach((s) => {
    s.likes = (s.likes || 0) * factor;
    s.dislikes = (s.dislikes || 0) * factor;
    if (s.dwell) s.dwell *= factor;
  });
}
