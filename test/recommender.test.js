import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  clamp,
  statScore,
  smoothedScore,
  categoryWeight,
  tagWeight,
  factWeight,
  noveltyFactor,
  scoreFact,
  weightedRandom,
  decayStats,
} from '../src/recommender.js';

test('clamp bounds values', () => {
  assert.equal(clamp(5, 0, 10), 5);
  assert.equal(clamp(-1, 0, 10), 0);
  assert.equal(clamp(99, 0, 10), 10);
});

test('statScore handles missing stats and fields', () => {
  assert.equal(statScore(undefined), 0);
  assert.equal(statScore({}), 0);
  assert.equal(statScore({ likes: 3, dislikes: 1, dwell: 0.5 }), 2.5);
});

test('category weight is neutral at 1 with no history and clamped at extremes', () => {
  assert.equal(categoryWeight(undefined), 1);
  assert.equal(categoryWeight({ likes: 100, dislikes: 0 }), 6);
  assert.equal(categoryWeight({ likes: 0, dislikes: 100 }), 0.15);
});

test('tag weight uses the tighter clamp', () => {
  assert.equal(tagWeight({ likes: 100, dislikes: 0 }), 4);
  assert.equal(tagWeight({ likes: 0, dislikes: 100 }), 0.25);
});

test('smoothedScore damps low-volume signals and converges with volume', () => {
  assert.equal(smoothedScore(undefined), 0);
  assert.equal(smoothedScore({}), 0);
  // one dislike: raw -1, smoothed by 1/(1+2) — a third of the old impact
  assert.ok(Math.abs(smoothedScore({ likes: 0, dislikes: 1 }) - -1 / 3) < 1e-9);
  // heavy history keeps nearly full effect: 10 * (10/12)
  assert.ok(Math.abs(smoothedScore({ likes: 10, dislikes: 0 }) - 10 * (10 / 12)) < 1e-9);
});

test('factWeight is the mean of tag weights, neutral without tags', () => {
  // 3 likes: smoothed 3*(3/5)=1.8 -> tag weight 1 + 0.4*1.8 = 1.72
  const tagStats = { dinosaurs: { likes: 3, dislikes: 0 } };
  assert.equal(factWeight({ tags: [] }, tagStats), 1);
  assert.equal(factWeight({}, tagStats), 1);
  assert.equal(factWeight(null, tagStats), 1);
  assert.ok(Math.abs(factWeight({ tags: ['dinosaurs'] }, tagStats) - 1.72) < 1e-9);
  // mean(1.72, 1) = 1.36 — a multi-tag fact is diluted, not doubled
  assert.ok(Math.abs(factWeight({ tags: ['dinosaurs', 'fossils'] }, tagStats) - 1.36) < 1e-9);
});

test('noveltyFactor: excluded this session, damped for the cooldown, then fresh', () => {
  assert.equal(noveltyFactor(undefined, 10), 1); // never seen
  assert.equal(noveltyFactor(10, 10), 0); // seen this session
  assert.equal(noveltyFactor(9, 10), 0.1); // 1 session ago
  assert.equal(noveltyFactor(8, 10), 0.1); // 2 sessions ago
  assert.equal(noveltyFactor(7, 10), 1); // cooldown over
});

test('scoreFact combines category, tags, and novelty', () => {
  const ctx = {
    categoryStats: { history: { likes: 10, dislikes: 0 } },
    tagStats: {},
    seenAt: { 7: 5 },
    session: 5,
  };
  const fresh = { id: 1, category: 'history', tags: [] };
  const seenNow = { id: 7, category: 'history', tags: [] };
  const catW = categoryWeight(ctx.categoryStats.history);
  assert.ok(Math.abs(scoreFact(fresh, ctx) - catW) < 1e-9); // tags neutral, novelty 1
  assert.equal(scoreFact(seenNow, ctx), 0); // seen this session -> zero
});

test('weightedRandom picks deterministically with a fixed rng', () => {
  const items = ['a', 'b', 'c'];
  const weights = { a: 1, b: 2, c: 1 }; // cumulative: 1, 3, 4
  const getWeight = (i) => weights[i];
  assert.equal(weightedRandom(items, getWeight, () => 0.1), 'a'); // 0.4 <= 1
  assert.equal(weightedRandom(items, getWeight, () => 0.5), 'b'); // 2.0 <= 3
  assert.equal(weightedRandom(items, getWeight, () => 0.9), 'c'); // 3.6 <= 4
});

test('weightedRandom degrades to uniform when all weights are zero', () => {
  const items = ['a', 'b'];
  assert.equal(weightedRandom(items, () => 0, () => 0.9), 'b');
  assert.equal(weightedRandom(items, () => 0, () => 0.1), 'a');
});

test('weightedRandom handles empty input', () => {
  assert.equal(weightedRandom([], () => 1), null);
});

test('decayStats scales likes/dislikes/dwell', () => {
  const stats = { history: { likes: 10, dislikes: 5, dwell: 2 } };
  decayStats(stats, 0.5);
  assert.deepEqual(stats.history, { likes: 5, dislikes: 2.5, dwell: 1 });
});
