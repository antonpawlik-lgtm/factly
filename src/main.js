import { readJSON, writeJSON } from './storage.js';
import { clamp, weightedRandom, decayStats, scoreFact, noveltyFactor } from './recommender.js';
import { nextReaction, applyReactionDelta } from './reactions.js';

const STORAGE_STATS = 'factly_categoryStats';
const STORAGE_TAG_STATS = 'factly_tagStats';
const STORAGE_SEEN_AT = 'factly_seenAt';
const STORAGE_SESSION = 'factly_session';
const STORAGE_SHOW_COUNTS = 'factly_showCounts';
const STORAGE_REACTIONS = 'factly_reactions';
const STORAGE_FAVORITES = 'factly_favorites';
const STORAGE_BOOSTED = 'factly_boosted';
const STORAGE_MUTED = 'factly_mutedCategories';
const STORAGE_FAVORITE_CATS = 'factly_favoriteCategories';
const STORAGE_LANGUAGE = 'factly_language';
const WINDOW_AHEAD = 6;
const TAP_MOVE_THRESHOLD_PX = 24;
const SESSION_DECAY = 0.98;

// One-time migration: the app was renamed Fact Feed -> Factly and storage
// keys moved from factfeed_* to factly_*. Carry existing data over so the
// learned profile, reactions, and favorites survive the rename.
try {
  if (!localStorage.getItem(STORAGE_STATS) && localStorage.getItem('factfeed_categoryStats')) {
    const legacyMap = {
      factfeed_categoryStats: STORAGE_STATS,
      factfeed_tagStats: STORAGE_TAG_STATS,
      factfeed_seenAt: STORAGE_SEEN_AT,
      factfeed_session: STORAGE_SESSION,
      factfeed_showCounts: STORAGE_SHOW_COUNTS,
      factfeed_reactions: STORAGE_REACTIONS,
      factfeed_favorites: STORAGE_FAVORITES,
      factfeed_boosted: STORAGE_BOOSTED,
      factfeed_language: STORAGE_LANGUAGE,
    };
    Object.entries(legacyMap).forEach(([oldKey, newKey]) => {
      const value = localStorage.getItem(oldKey);
      if (value !== null) localStorage.setItem(newKey, value);
      localStorage.removeItem(oldKey);
    });
  }
} catch {
  /* storage unavailable — nothing to migrate */
}

const feed = document.getElementById('feed');
const hint = document.getElementById('hint');
const toast = document.getElementById('toast');
const savedView = document.getElementById('saved-view');
const settingsView = document.getElementById('settings-view');
const nav = document.getElementById('nav');

let allFacts = [];
let facts = [];
let categories = [];
let factById = new Map();
const categoryStats = readJSON(STORAGE_STATS, {});
const tagStats = readJSON(STORAGE_TAG_STATS, {});
const seenAt = readJSON(STORAGE_SEEN_AT, {}); // { "17": 12 } — session number a fact was last shown
const showCounts = readJSON(STORAGE_SHOW_COUNTS, {}); // { history: 42 } — how often each category was shown
const reactions = readJSON(STORAGE_REACTIONS, {}); // { "17": "like", "48": "dislike" }
const favorites = new Set(readJSON(STORAGE_FAVORITES, []));
const boostedIds = new Set(readJSON(STORAGE_BOOSTED, [])); // "Mehr davon" is once per fact
// Profil > "Deine Themen": tapping a chip cycles normal -> favorite ->
// muted -> normal. Favorites rank first and get a scoring boost; muted
// ones disappear from the feed pool and the header chips entirely.
const mutedCategories = new Set(readJSON(STORAGE_MUTED, []));
const favoriteCategories = new Set(readJSON(STORAGE_FAVORITE_CATS, []));
// How much a starred topic's facts are boosted in the picker.
const FAVORITE_CATEGORY_BOOST = 1.8;
let selectedLanguage = localStorage.getItem(STORAGE_LANGUAGE) || 'all'; // 'de' | 'en' | 'all'
let hintTimer = null;
let toastTimer = null;

// German display labels for the otherwise-English category slugs. Unmapped
// (future) categories fall back to the raw slug.
const CATEGORY_LABELS = {
  science: 'Wissenschaft',
  history: 'Geschichte',
  nature: 'Natur',
  space: 'Weltraum',
  animals: 'Tiere',
  geography: 'Geografie',
  technology: 'Technik',
  psychology: 'Psychologie',
  food: 'Essen',
  curiosities: 'Kurioses',
};

const categoryLabel = (category) => CATEGORY_LABELS[category] || category;

// Per-category accent color, shown on the category label so categories are
// distinguishable at a glance. Unmapped (future) categories fall back to
// the default --accent color via CSS.
const CATEGORY_COLORS = {
  science: '#38bdf8',
  history: '#f59e0b',
  nature: '#34d399',
  space: '#818cf8',
  animals: '#fb923c',
  geography: '#2dd4bf',
  technology: '#60a5fa',
  psychology: '#f472b6',
  food: '#f87171',
  curiosities: '#c084fc',
  'news-general': '#e11d48',
  'news-tech': '#0ea5e9',
};

const categoryColor = (category) => CATEGORY_COLORS[category] || null;

// Decorative emoji per category, shown as a soft watermark on the card —
// the lightweight take on "images" without photo sourcing/licensing.
const CATEGORY_EMOJI = {
  science: '🔬',
  history: '🏛️',
  nature: '🌿',
  space: '🪐',
  animals: '🦊',
  geography: '🗺️',
  technology: '💾',
  psychology: '🧠',
  food: '🍫',
  curiosities: '🎲',
  'news-general': '🌍',
  'news-tech': '📡',
};

const categoryEmoji = (category) => CATEGORY_EMOJI[category] || '✨';

// Inline SVG icons for the action rail (replaces emoji — crisper, themeable
// via currentColor). fill toggles to currentColor via .selected in CSS.
const ICON = {
  like: '<svg viewBox="0 0 24 24"><path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1-1.1a5.5 5.5 0 1 0-7.8 7.8l1.1 1L12 21l7.7-7.6 1.1-1a5.5 5.5 0 0 0 0-7.8z"/></svg>',
  dislike: '<svg viewBox="0 0 24 24"><path d="M10 15v4a3 3 0 0 0 3 3l4-9V2H5.72a2 2 0 0 0-2 1.7l-1.38 9a2 2 0 0 0 2 2.3z"/><path d="M17 2h2.67A2.31 2.31 0 0 1 22 4v7a2.31 2.31 0 0 1-2.33 2H17"/></svg>',
  save: '<svg viewBox="0 0 24 24"><path d="M6 3h12a1 1 0 0 1 1 1v17l-7-4.2L5 21V4a1 1 0 0 1 1-1z"/></svg>',
  share: '<svg viewBox="0 0 24 24"><path d="M12 15V3m0 0L8 7m4-4 4 4"/><path d="M5 12v7a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-7"/></svg>',
};

// The docked action rail, shared by fact and news cards. The generic
// btn-like/btn-dislike/btn-save/btn-share classes keep react()/renderReaction
// and the save/share wiring identical across card types.
function actionRailHTML() {
  return `
    <div class="card-actions gesture-exempt">
      <button class="btn-like" type="button" aria-label="Mag ich" aria-pressed="false">${ICON.like}</button>
      <button class="btn-dislike" type="button" aria-label="Nicht interessiert" aria-pressed="false">${ICON.dislike}</button>
      <button class="btn-save" type="button" aria-label="Merken" aria-pressed="false">${ICON.save}</button>
      <button class="btn-share" type="button" aria-label="Teilen">${ICON.share}</button>
    </div>`;
}

// Order + German labels for the header/profile category chips.
const CHIP_CATEGORIES = Object.keys(CATEGORY_LABELS);
let selectedCategory = 'all'; // 'all' | one of CHIP_CATEGORIES

const headerEl = document.getElementById('app-header');
const chipsEl = document.getElementById('chips');
const feedCountEl = document.getElementById('feed-count');

function renderChips() {
  if (!chipsEl) return;
  const mk = (slug, label, color) => {
    const active = selectedCategory === slug;
    const btn = document.createElement('button');
    btn.className = `chip${active ? ' active' : ''}`;
    btn.style.setProperty('--c', color);
    btn.textContent = label;
    btn.addEventListener('click', () => {
      selectedCategory = slug;
      renderChips();
      rebuildPools();
      resetFeed();
    });
    return btn;
  };
  chipsEl.replaceChildren(
    mk('all', 'Alle', 'var(--accent)'),
    ...orderedChipCategories()
      .filter((slug) => !mutedCategories.has(slug))
      .map((slug) =>
        mk(
          slug,
          `${favoriteCategories.has(slug) ? '★ ' : ''}${categoryLabel(slug)}`,
          categoryColor(slug) || 'var(--accent)'
        )
      )
  );
}

function updateFeedMeta() {
  if (feedCountEl) feedCountEl.textContent = `${facts.length} Fakten`;
}

// Tint the whole chrome (brand "ly", active chip/nav) to the active card's
// category color, so scrolling gently shifts the accent.
function setLiveAccent(color) {
  if (color) document.documentElement.style.setProperty('--accent', color);
}

const saveStats = () => writeJSON(STORAGE_STATS, categoryStats);
const saveTagStats = () => writeJSON(STORAGE_TAG_STATS, tagStats);
const saveSeenAt = () => writeJSON(STORAGE_SEEN_AT, seenAt);
const saveShowCounts = () => writeJSON(STORAGE_SHOW_COUNTS, showCounts);
const saveFavorites = () => writeJSON(STORAGE_FAVORITES, [...favorites]);
const saveBoosted = () => writeJSON(STORAGE_BOOSTED, [...boostedIds]);
const saveMuted = () => writeJSON(STORAGE_MUTED, [...mutedCategories]);
const saveFavoriteCats = () => writeJSON(STORAGE_FAVORITE_CATS, [...favoriteCategories]);

// Display order for topic chips: starred topics first, then normal, muted
// last (profile only — the header hides muted entirely).
function orderedChipCategories() {
  const rank = (slug) => (favoriteCategories.has(slug) ? 0 : mutedCategories.has(slug) ? 2 : 1);
  return [...CHIP_CATEGORIES].sort((a, b) => rank(a) - rank(b) || CHIP_CATEGORIES.indexOf(a) - CHIP_CATEGORIES.indexOf(b));
}
const saveReactions = () => writeJSON(STORAGE_REACTIONS, reactions);

// Session counter drives the novelty cooldown (facts seen in recent sessions
// are damped, not hard-excluded). Increments once per app start.
const session = (readJSON(STORAGE_SESSION, 0) || 0) + 1;
writeJSON(STORAGE_SESSION, session);
// The old hard seen-list is superseded by seenAt; clean up the legacy key.
try { localStorage.removeItem('factfeed_seenIds'); } catch { /* ignore */ }

// Gentle per-session decay so weights reflect current taste; explicit
// per-fact reactions stay stored exactly, only the aggregate signal fades.
decayStats(categoryStats, SESSION_DECAY);
decayStats(tagStats, SESSION_DECAY);
saveStats();
saveTagStats();

// ---------- dwell (implicit interest signal) ----------

// How long a fact stayed the active (>60% visible) card versus how long its
// text takes to read. Lingering well past the expected reading time counts
// as mild interest, scrolling past almost immediately as mild disinterest.
const DWELL_LINGER_RATIO = 1.4;
const DWELL_SKIP_RATIO = 0.35;
const DWELL_LINGER_SCORE = 0.3;
// Scrolling past almost immediately is a "silent dislike" — weaker than an
// explicit one (1.0), but strong enough that the feed learns from pure
// scrolling behavior without the user ever pressing a button.
const DWELL_SKIP_SCORE = -0.3;
// Hard cap: even if a card somehow stays "active" for minutes (missed
// visibility event, stuck tab), it can never count as more than 30s.
const DWELL_CAP_MS = 30000;
// One dwell signal per fact per session, so bouncing up and down over the
// same card doesn't stack the same signal repeatedly.
const dwellRecorded = new Set();

function applyDwellSignal(card, dwellMs, reason = 'scroll') {
  const factId = card.dataset.factId;
  if (dwellRecorded.has(factId)) return;
  const category = card.dataset.category;
  const expectedMs = Number(card.dataset.expectedMs) || 3000;
  const ratio = Math.min(dwellMs, DWELL_CAP_MS) / expectedMs;
  // The FIRST verdict on a fact stands, including a neutral one — otherwise
  // scrolling back up over already-read cards would re-judge each of them
  // as an instant skip.
  dwellRecorded.add(factId);
  if (ratio > DWELL_SKIP_RATIO && ratio < DWELL_LINGER_RATIO) return; // normal reading pace

  const delta = ratio > DWELL_LINGER_RATIO ? DWELL_LINGER_SCORE : DWELL_SKIP_SCORE;
  // A skip is only meaningful when the user actively scrolled past. Locking
  // the phone or switching tabs one second after a card appeared is not a
  // judgement on the card — count only positive lingering in that case.
  if (delta < 0 && reason !== 'scroll') {
    dwellRecorded.delete(factId); // no verdict passed — the card gets a fresh chance
    return;
  }
  const stats = categoryStats[category] || { likes: 0, dislikes: 0, dwell: 0 };
  stats.dwell = (stats.dwell || 0) + delta;
  categoryStats[category] = stats;
  saveStats();

  // Each tag gets the full delta (not divided by tag count) — consistent
  // with reactions giving each tag a full like, and tag-count-neutral
  // overall because factWeight averages. filter(Boolean) makes tagless
  // cards (e.g. future news cards) a silent no-op: ''.split(',') is [''].
  const tags = (card.dataset.tags || '').split(',').filter(Boolean);
  tags.forEach((tag) => {
    const ts = tagStats[tag] || { likes: 0, dislikes: 0, dwell: 0 };
    ts.dwell = (ts.dwell || 0) + delta;
    tagStats[tag] = ts;
  });
  if (tags.length > 0) saveTagStats();
}

// ---------- news ----------

// Real headlines mixed into the feed. news.json is produced every few hours
// by .github/workflows/update-news.yml; the pool is small and rotates, so
// "seen" tracking is session-only (in memory) — never localStorage.
const NEWS_RATE = 0.35; // ~every 3rd card
const NEWS_MAX_AGE_MS = 48 * 3600 * 1000;
let newsPool = [];
const newsById = new Map(); // lets the saved view render a saved headline
const seenNewsIds = new Set();

function pickNextNews() {
  const pool = selectedLanguage === 'all' ? newsPool : newsPool.filter((n) => n.lang === selectedLanguage);
  if (pool.length === 0) return null;
  let candidates = pool.filter((n) => !seenNewsIds.has(n.id));
  if (candidates.length === 0) {
    seenNewsIds.clear();
    candidates = pool;
  }
  const item = candidates[Math.floor(Math.random() * candidates.length)];
  seenNewsIds.add(item.id);
  return item;
}

// News must never delay or break the fact feed: fetched in parallel with
// facts.json; on any failure or staleness the pool just stays empty and the
// feed silently shows 100% facts.
fetch('news.json')
  .then((r) => (r.ok ? r.json() : { items: [] }))
  .then((data) => {
    const freshEnough =
      data && data.generatedAt && Date.now() - new Date(data.generatedAt).getTime() < NEWS_MAX_AGE_MS;
    newsPool = freshEnough ? (data.items || []).filter((n) => n && n.id && n.headline && n.url) : [];
    newsById.clear();
    newsPool.forEach((n) => newsById.set(n.id, n));
    // Reactions on rotated-out headlines are dead weight — prune them.
    const alive = new Set(newsPool.map((n) => n.id));
    let pruned = false;
    Object.keys(reactions).forEach((k) => {
      if (k.startsWith('n_') && !alive.has(k)) {
        delete reactions[k];
        pruned = true;
      }
    });
    if (pruned) saveReactions();
  })
  .catch(() => {
    newsPool = [];
  });

// ---------- fact picking ----------

// Every so often ignore taste entirely and explore — but explore *where the
// algorithm knows least*: the category shown least often so far, so data
// gets collected exactly where preferences are still unknown.
const EXPLORE_RATE = 0.15;
// Feed diversity: never more than this many cards of one category in a row,
// no matter how dominant its weight is.
const MAX_CATEGORY_STREAK = 2;

let streakCategory = null;
let streakCount = 0;

function pickNextFact() {
  if (facts.length === 0) return null;

  // Never pick a fact whose card is still in the visible DOM window — after
  // a full pool cycle the uniform recycle could otherwise put the same fact
  // on screen twice.
  const inDom = new Set([...feed.children].map((c) => Number(c.dataset.factId)));
  let candidates = facts.filter((f) => !inDom.has(f.id));
  if (candidates.length === 0) candidates = facts;

  // Diversity rule: after MAX_CATEGORY_STREAK same-category cards in a row,
  // the next pick must come from a different category (unless that would
  // leave nothing to pick from).
  if (streakCategory && streakCount >= MAX_CATEGORY_STREAK) {
    const diverse = candidates.filter((f) => f.category !== streakCategory);
    if (diverse.length > 0) candidates = diverse;
  }

  let fact;
  if (Math.random() < EXPLORE_RATE) {
    const leastShown = categories.reduce(
      (min, c) => ((showCounts[c] || 0) < (showCounts[min] || 0) ? c : min),
      categories[0]
    );
    const pool = candidates.filter((f) => f.category === leastShown);
    fact = weightedRandom(pool.length > 0 ? pool : candidates, (f) =>
      noveltyFactor(seenAt[String(f.id)], session)
    );
  } else {
    // Direct per-fact scoring (category taste x tag taste x freshness) —
    // a great fact in a weak category can still win the slot.
    fact = weightedRandom(
      candidates,
      (f) =>
        scoreFact(f, { categoryStats, tagStats, seenAt, session }) *
        (favoriteCategories.has(f.category) ? FAVORITE_CATEGORY_BOOST : 1)
    );
  }
  if (!fact) return null;

  seenAt[String(fact.id)] = session;
  saveSeenAt();
  showCounts[fact.category] = (showCounts[fact.category] || 0) + 1;
  saveShowCounts();
  if (fact.category === streakCategory) streakCount += 1;
  else {
    streakCategory = fact.category;
    streakCount = 1;
  }
  return fact;
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// ---------- reactions ----------

// Reactions are persisted per fact id, so a fact that comes around again
// (after a category cycle reset or a reload) shows its stored reaction and
// re-rating it rebooks the stats instead of double-counting.
function setFactReaction(fact, requested, allowToggleOff) {
  const factId = String(fact.id);
  const previous = reactions[factId] || null;
  const { changed, next } = nextReaction(previous, requested, allowToggleOff);
  if (!changed) return next;

  categoryStats[fact.category] = applyReactionDelta(categoryStats[fact.category], previous, next);
  (fact.tags || []).forEach((tag) => {
    tagStats[tag] = applyReactionDelta(tagStats[tag], previous, next);
  });

  if (next) reactions[factId] = next;
  else delete reactions[factId];
  saveReactions();
  saveStats();
  saveTagStats();
  return next;
}

function renderReaction(card, reaction) {
  if (reaction) card.dataset.reaction = reaction;
  else delete card.dataset.reaction;
  const likeBtn = card.querySelector('.btn-like');
  const dislikeBtn = card.querySelector('.btn-dislike');
  likeBtn.classList.toggle('selected', reaction === 'like');
  dislikeBtn.classList.toggle('selected', reaction === 'dislike');
  likeBtn.setAttribute('aria-pressed', String(reaction === 'like'));
  dislikeBtn.setAttribute('aria-pressed', String(reaction === 'dislike'));
}

function react(card, fact, direction, { allowToggleOff = true } = {}) {
  const requested = direction > 0 ? 'like' : 'dislike';
  const reaction = setFactReaction(fact, requested, allowToggleOff);
  renderReaction(card, reaction);
}

// ---------- favorites / boost / share ----------

function toggleFavorite(factId) {
  if (favorites.has(factId)) favorites.delete(factId);
  else favorites.add(factId);
  saveFavorites();
  return favorites.has(factId);
}

// Explicit "more of this topic" — a stronger, targeted signal than a like:
// boosts only the fact's tags, not its whole category.
function boostFactTopics(fact, amount = 2) {
  (fact.tags || []).forEach((tag) => {
    const stats = tagStats[tag] || { likes: 0, dislikes: 0, dwell: 0 };
    stats.likes += amount;
    tagStats[tag] = stats;
  });
  saveTagStats();
}

async function shareFact(fact) {
  const url = new URL(location.href);
  url.hash = `fact=${fact.id}`;
  const shareData = { title: 'Factly', text: fact.text, url: url.toString() };
  try {
    if (navigator.share) {
      await navigator.share(shareData);
      return;
    }
    await navigator.clipboard.writeText(`${fact.text}\n${url}`);
    showToast('Link kopiert');
  } catch {
    // user cancelled the share sheet — nothing to do
  }
}

// News items share the article itself, not an app deep link.
async function shareNews(item) {
  const shareData = { title: item.source, text: item.headline, url: item.url };
  try {
    if (navigator.share) {
      await navigator.share(shareData);
      return;
    }
    await navigator.clipboard.writeText(`${item.headline}\n${item.url}`);
    showToast('Link kopiert');
  } catch {
    // user cancelled the share sheet — nothing to do
  }
}

// Toasts get their own element so they never overwrite the gesture hint.
function showToast(text) {
  if (!toast) return;
  toast.textContent = text;
  toast.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.add('hidden'), 1500);
}

// ---------- gestures ----------

const DOUBLE_TAP_MS = 300;

function showHeartBurst(card, clientX, clientY) {
  const rect = card.getBoundingClientRect();
  const el = document.createElement('div');
  el.className = 'heart-burst';
  el.textContent = '❤️';
  el.style.left = `${clientX - rect.left}px`;
  el.style.top = `${clientY - rect.top}px`;
  card.appendChild(el);
  el.addEventListener('animationend', () => el.remove());
}

// Horizontal swipe-to-like was removed on tester feedback — it fought the
// vertical scroll on real devices. Cards only detect double-tap-to-like now;
// everything else is buttons. Scrolling stays fully native.
function attachGestures(card, fact) {
  let pointer = null;
  let lastTapTime = 0;

  card.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    // Taps on interactive elements (action buttons, source link) stay plain
    // native clicks and never count toward a double-tap.
    if (e.target.closest('.gesture-exempt')) return;
    pointer = { id: e.pointerId, x0: e.clientX, y0: e.clientY };
  });

  card.addEventListener('pointerup', (e) => {
    if (!pointer || e.pointerId !== pointer.id) return;
    const distance = Math.hypot(e.clientX - pointer.x0, e.clientY - pointer.y0);
    pointer = null;
    // Judge tap-vs-scroll on total travel: a real finger tap wobbles a few
    // pixels, a scroll moves far.
    if (distance < TAP_MOVE_THRESHOLD_PX && !e.target.closest('.gesture-exempt')) {
      const now = Date.now();
      if (now - lastTapTime < DOUBLE_TAP_MS) {
        react(card, fact, 1, { allowToggleOff: false });
        showHeartBurst(card, e.clientX, e.clientY);
        lastTapTime = 0;
      } else {
        lastTapTime = now;
      }
    }
  });

  card.addEventListener('pointercancel', () => {
    pointer = null;
  });
}

// ---------- cards ----------

function relativeTime(iso) {
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (!Number.isFinite(mins) || mins < 0) return '';
  if (mins < 60) return `vor ${mins} Min.`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `vor ${hours} Std.`;
  return `vor ${Math.round(hours / 24)} Tg.`;
}

// News cards reuse the card shell (gestures, like/dislike, dwell) but render
// headline + summary + source and link out to the article. No tags, no save,
// no "Mehr davon" — headlines rotate out within hours anyway. Reactions book
// into categoryStats['news-<topic>'] via the generic react() path.
function createNewsCard(item) {
  const card = document.createElement('article');
  card.className = 'card card-news';
  card.dataset.factId = item.id;
  card.dataset.category = `news-${item.topic}`;
  card.dataset.tags = '';
  const words = `${item.headline} ${item.summary || ''}`.trim().split(/\s+/).length;
  card.dataset.expectedMs = String(clamp(words * 240, 1200, 8000));

  const color = categoryColor(card.dataset.category);
  if (color) card.style.setProperty('--cat-color', color);

  const timeStr = relativeTime(item.publishedAt);
  card.innerHTML = `
    <div class="card-inner">
      <span class="card-emoji" aria-hidden="true">${categoryEmoji(card.dataset.category)}</span>
      <p class="card-category"><span class="cat-dot"></span>News · ${item.topic === 'tech' ? 'Tech' : 'Welt'}</p>
      <div class="card-body">
        <p class="card-text">${escapeHtml(item.headline)}</p>
      </div>
      ${item.summary ? `<p class="card-summary">${escapeHtml(item.summary)}</p>` : ''}
      <p class="card-source">${escapeHtml(item.source)}${timeStr ? ' · ' + timeStr : ''}</p>
      <a class="card-link gesture-exempt" href="${escapeHtml(item.url)}" target="_blank" rel="noopener noreferrer">Artikel öffnen ↗</a>
      ${actionRailHTML()}
    </div>
  `;

  const pseudoFact = { id: item.id, category: `news-${item.topic}`, tags: [] };
  attachGestures(card, pseudoFact);
  card.querySelector('.btn-like').addEventListener('click', () => react(card, pseudoFact, 1));
  card.querySelector('.btn-dislike').addEventListener('click', () => react(card, pseudoFact, -1));

  const saveBtn = card.querySelector('.btn-save');
  const renderSaved = (saved) => {
    saveBtn.classList.toggle('selected', saved);
    saveBtn.setAttribute('aria-pressed', String(saved));
  };
  renderSaved(favorites.has(item.id));
  saveBtn.addEventListener('click', () => {
    const nowSaved = toggleFavorite(item.id);
    renderSaved(nowSaved);
    showToast(nowSaved ? 'Gemerkt' : 'Entfernt');
  });

  card.querySelector('.btn-share').addEventListener('click', () => shareNews(item));

  const stored = reactions[String(item.id)] || null;
  if (stored) renderReaction(card, stored);
  return card;
}

function createSourceLink(fact) {
  if (!fact.source || !fact.source.url) return null;
  const link = document.createElement('a');
  link.className = 'fact-source gesture-exempt';
  link.href = fact.source.url;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  link.textContent = `Quelle: ${fact.source.publisher || new URL(fact.source.url).hostname}`;
  return link;
}

function createCard(fact) {
  const card = document.createElement('article');
  card.className = 'card';
  card.dataset.factId = String(fact.id);
  card.dataset.category = fact.category;
  card.dataset.tags = (fact.tags || []).join(',');

  // In "Beide" mode the card shows the fact in both languages; in de/en it
  // shows only that language's version (native text or translation).
  const primary = factText(fact);
  const showBoth = selectedLanguage === 'all' && Boolean(fact.textAlt);
  const displayed = showBoth ? `${primary} ${fact.textAlt}` : primary;
  const words = displayed.trim().split(/\s+/).length;
  card.dataset.expectedMs = String(clamp(words * 240, 1200, 8000));

  const color = categoryColor(fact.category);
  if (color) card.style.setProperty('--cat-color', color);

  const langLabel = showBoth ? 'DE · EN' : (fact.lang === selectedLanguage || selectedLanguage === 'all' ? fact.lang : selectedLanguage).toUpperCase();
  card.innerHTML = `
    <div class="card-inner">
      <span class="card-emoji" aria-hidden="true">${categoryEmoji(fact.category)}</span>
      <p class="card-category"><span class="cat-dot"></span>${escapeHtml(categoryLabel(fact.category))}</p>
      <div class="card-body">
        <p class="card-text">${escapeHtml(primary)}</p>
        ${showBoth ? `<p class="card-text-alt">${escapeHtml(fact.textAlt)}</p>` : ''}
      </div>
      <p class="card-lang">${langLabel}</p>
      ${actionRailHTML()}
    </div>
  `;

  // Source link goes before the (absolutely-positioned) rail so document flow
  // stays tidy, though visually the rail floats regardless.
  const sourceLink = createSourceLink(fact);
  if (sourceLink) card.querySelector('.card-lang').after(sourceLink);

  attachGestures(card, fact);
  card.querySelector('.btn-like').addEventListener('click', () => react(card, fact, 1));
  card.querySelector('.btn-dislike').addEventListener('click', () => react(card, fact, -1));

  const saveBtn = card.querySelector('.btn-save');
  const renderSaved = (saved) => {
    saveBtn.classList.toggle('selected', saved);
    saveBtn.setAttribute('aria-pressed', String(saved));
  };
  renderSaved(favorites.has(fact.id));
  saveBtn.addEventListener('click', () => {
    const nowSaved = toggleFavorite(fact.id);
    renderSaved(nowSaved);
    showToast(nowSaved ? 'Gemerkt' : 'Entfernt');
  });

  card.querySelector('.btn-share').addEventListener('click', () => shareFact(fact));

  // Restore a previously stored reaction so re-shown facts display it.
  const stored = reactions[String(fact.id)] || null;
  if (stored) renderReaction(card, stored);

  return card;
}

// ---------- active-card tracking & dwell clock ----------

let activeCard = null;
let activeSince = null;

function flushActiveDwell(reason = 'scroll') {
  if (!activeCard || activeSince === null) return;
  applyDwellSignal(activeCard, performance.now() - activeSince, reason);
  activeSince = null;
}

function setActiveCard(card) {
  if (card === activeCard) return;
  flushActiveDwell();
  activeCard = card;
  activeSince = performance.now();
  // Shift the chrome accent to this card's category color.
  const color = categoryColor(card.dataset.category);
  if (color) setLiveAccent(color);
}

// Backgrounding the tab / locking the phone must not count as reading time:
// flush the dwell clock when hidden, restart it when visible again.
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    flushActiveDwell('hide');
  } else if (activeCard) {
    activeSince = performance.now();
  }
});
// pagehide (not beforeunload — unreliable on iOS) captures the last card's
// dwell when the app is closed.
window.addEventListener('pagehide', () => flushActiveDwell('hide'));

const observer = new IntersectionObserver(
  (entries) => {
    entries.forEach((entry) => {
      if (entry.isIntersecting && entry.intersectionRatio > 0.6) {
        setActiveCard(entry.target);
        const idx = Array.from(feed.children).indexOf(entry.target);
        if (idx > feed.children.length - 3) {
          appendCard();
        }
        if (hint && !hint.classList.contains('hidden')) {
          clearTimeout(hintTimer);
          hintTimer = setTimeout(() => hint.classList.add('hidden'), 1500);
        }
      }
    });
  },
  { threshold: [0.6] }
);

// ---------- keyboard ----------

// Resolves the entity behind a card for the generic react() path: a real
// fact, or a pseudo-fact for a news card (id "n_...", no tags).
function cardEntity(card) {
  const idStr = card.dataset.factId;
  if (idStr.startsWith('n_')) {
    const item = newsPool.find((n) => n.id === idStr);
    return item ? { id: item.id, category: `news-${item.topic}`, tags: [] } : null;
  }
  return factById.get(Number(idStr)) || null;
}

document.addEventListener('keydown', (e) => {
  if (!activeCard || currentView !== 'feed') return;
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    const target = e.key === 'ArrowDown' ? activeCard.nextElementSibling : activeCard.previousElementSibling;
    if (target) {
      e.preventDefault();
      target.scrollIntoView({ behavior: 'smooth' });
    }
  } else if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
    const entity = cardEntity(activeCard);
    if (entity) react(activeCard, entity, e.key === 'ArrowRight' ? 1 : -1);
  } else if (e.key === 's' || e.key === 'S') {
    const fact = factById.get(Number(activeCard.dataset.factId));
    if (fact) {
      const nowSaved = toggleFavorite(fact.id);
      const btn = activeCard.querySelector('.btn-save');
      if (btn) {
        btn.classList.toggle('selected', nowSaved);
        btn.setAttribute('aria-pressed', String(nowSaved));
      }
      showToast(nowSaved ? 'Gespeichert' : 'Entfernt');
    }
  } else if (e.key === 'Enter') {
    const link = activeCard.querySelector('.fact-source, .card-link');
    if (link) window.open(link.href, '_blank', 'noopener');
  }
});

// ---------- feed lifecycle ----------

function appendCard(specificFact) {
  let card = null;
  if (specificFact) {
    card = createCard(specificFact);
    // News mixes in only in the unfiltered "Alle" feed — a category filter
    // means the user asked for exactly that topic.
  } else if (selectedCategory === 'all' && newsPool.length > 0 && Math.random() < NEWS_RATE) {
    const item = pickNextNews();
    if (item) card = createNewsCard(item);
  }
  if (!card) {
    const fact = pickNextFact();
    if (!fact) return;
    card = createCard(fact);
  }
  feed.appendChild(card);
  observer.observe(card);
  trimOldCards();
}

function trimOldCards() {
  while (feed.children.length > WINDOW_AHEAD * 3) {
    const first = feed.firstElementChild;
    const h = first.offsetHeight;
    observer.unobserve(first);
    first.remove();
    // Safari has no scroll anchoring: removing a card from the top would
    // otherwise visually jump the feed by one viewport height.
    feed.scrollTop -= h;
  }
}

function fillWindow() {
  for (let i = 0; i < WINDOW_AHEAD; i++) {
    appendCard();
  }
}

// Which text a fact shows in the current language mode: its native text when
// the mode matches (or mode is 'all'), otherwise the translation. Falls back
// to the native text for facts without a translation (cache skew).
function factText(fact) {
  if (selectedLanguage === 'all' || fact.lang === selectedLanguage) return fact.text;
  return fact.textAlt || fact.text;
}

function rebuildPools() {
  // Language no longer splits the fact pool: every fact carries both
  // languages (text + textAlt), the language setting only decides which
  // version(s) a card displays. News stays language-filtered at pick time.
  facts = allFacts;
  if (mutedCategories.size > 0 && mutedCategories.size < CHIP_CATEGORIES.length) {
    const unmuted = facts.filter((f) => !mutedCategories.has(f.category));
    if (unmuted.length > 0) facts = unmuted;
  }
  if (selectedCategory !== 'all') {
    const byCat = facts.filter((f) => f.category === selectedCategory);
    if (byCat.length > 0) facts = byCat;
  }
  if (facts.length === 0) facts = allFacts; // never leave the feed empty
  categories = [...new Set(facts.map((f) => f.category))];
  updateFeedMeta();
}

function resetFeed() {
  activeCard = null;
  activeSince = null;
  streakCategory = null;
  streakCount = 0;
  feed.innerHTML = '';
  fillWindow();
  feed.scrollTop = 0;
}

// ---------- views (feed / saved / settings) ----------

let currentView = 'feed';

function switchView(name) {
  currentView = name;
  feed.classList.toggle('hidden', name !== 'feed');
  if (headerEl) headerEl.classList.toggle('hidden', name !== 'feed'); // brand + chips are feed-only
  savedView.classList.toggle('hidden', name !== 'saved');
  settingsView.classList.toggle('hidden', name !== 'settings');
  nav.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b.dataset.view === name));
  if (name === 'saved') renderSavedView();
  if (name === 'settings') renderSettingsView();
  if (name !== 'feed') flushActiveDwell('hide');
  else if (activeCard) activeSince = performance.now();
}

nav.addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-view]');
  if (btn) switchView(btn.dataset.view);
});

function renderSavedView() {
  const ids = [...favorites];
  const n = ids.length;
  savedView.innerHTML = `
    <div class="panel-title">Gemerkt</div>
    <p class="panel-sub">${n > 0 ? `${n} ${n === 1 ? 'Fakt' : 'Fakten'} in deiner Sammlung` : 'Deine Lieblingsfakten an einem Ort'}</p>
  `;

  if (n === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.innerHTML = `
      <div class="empty-icon">${ICON.save}</div>
      <div class="empty-title">Noch nichts gemerkt</div>
      <div class="empty-text">Tippe im Feed auf das <span class="accent">Lesezeichen</span>, um Fakten hier zu sammeln.</div>
      <button class="empty-cta" type="button">Zum Feed</button>
    `;
    empty.querySelector('.empty-cta').addEventListener('click', () => switchView('feed'));
    savedView.appendChild(empty);
    return;
  }

  const list = document.createElement('div');
  list.className = 'saved-list';
  ids.forEach((id) => {
    // A saved id is either a fact (integer id, in factById) or a news headline
    // (string id, in newsById while still in the current pool). Normalise both
    // into { category, label, text, share } so one renderer handles them.
    const fact = factById.get(id);
    const news = fact ? null : newsById.get(id);
    if (!fact && !news) return; // rotated-out headline — nothing to show

    const view = fact
      ? {
          category: fact.category,
          label: categoryLabel(fact.category),
          text: factText(fact),
          share: () => shareFact(fact),
        }
      : {
          category: `news-${news.topic}`,
          label: `News · ${news.topic === 'tech' ? 'Tech' : 'Welt'}`,
          text: news.headline,
          share: () => shareNews(news),
        };

    const item = document.createElement('article');
    item.className = 'saved-item';
    const color = categoryColor(view.category);
    if (color) item.style.setProperty('--cat-color', color);
    item.innerHTML = `
      <p class="saved-item-category"><span class="cat-dot"></span>${escapeHtml(view.label)}</p>
      <p class="saved-item-text">${escapeHtml(view.text)}</p>
      <div class="saved-item-actions">
        <button class="saved-share" type="button">Teilen</button>
        <button class="saved-remove" type="button">Entfernen</button>
      </div>
    `;
    item.querySelector('.saved-share').addEventListener('click', view.share);
    item.querySelector('.saved-remove').addEventListener('click', () => {
      favorites.delete(id);
      saveFavorites();
      item.remove();
      if (favorites.size === 0) renderSavedView();
    });
    list.appendChild(item);
  });
  savedView.appendChild(list);
}

function renderSettingsView() {
  const langOptions = [
    ['de', 'Deutsch'],
    ['en', 'English'],
    ['all', 'Beide'],
  ]
    .map(
      ([value, label]) => `
      <label class="lang-option">
        <input type="radio" name="language" value="${value}" ${selectedLanguage === value ? 'checked' : ''} />
        ${label}
      </label>`
    )
    .join('');

  const themeChips = orderedChipCategories()
    .map((slug) => {
      const state = favoriteCategories.has(slug) ? 'fav' : mutedCategories.has(slug) ? 'muted' : '';
      return `<button class="theme-chip${state ? ' ' + state : ''}" type="button" data-slug="${slug}"
        style="--c:${categoryColor(slug) || 'var(--accent)'}" aria-pressed="${!mutedCategories.has(slug)}">${
        state === 'fav' ? '★ ' : '<span class="cat-dot"></span>'
      }${escapeHtml(categoryLabel(slug))}</button>`;
    })
    .join('');

  const likedTotal = favorites.size;
  const ratedTotal = Object.keys(reactions).length;

  settingsView.innerHTML = `
    <div class="panel-title">Profil</div>
    <div class="profile-card">
      <div class="profile-head">
        <div class="profile-avatar">FF</div>
        <div>
          <div class="profile-name">Fakten-Fan</div>
          <div class="profile-meta">Dein Profil auf diesem Gerät</div>
        </div>
      </div>
      <div class="profile-stats">
        <div class="stat-tile"><div class="stat-num accent">${likedTotal}</div><div class="stat-label">Gemerkt</div></div>
        <div class="stat-tile"><div class="stat-num">${ratedTotal}</div><div class="stat-label">Bewertet</div></div>
        <div class="stat-tile"><div class="stat-num">${CHIP_CATEGORIES.length}</div><div class="stat-label">Themen</div></div>
      </div>
    </div>

    <div class="section-label">Deine Themen</div>
    <div class="theme-chips">${themeChips}</div>
    <p class="panel-sub">Tippen wechselt: normal → ★ Favorit (kommt öfter) → ausgeblendet.</p>

    <div class="section-label">Sprache der Fakten</div>
    <div class="settings-block">${langOptions}</div>

    <button class="btn-reset" type="button">Profil zurücksetzen</button>
  `;

  settingsView.querySelectorAll('input[name="language"]').forEach((input) => {
    input.addEventListener('change', () => {
      selectedLanguage = input.value;
      localStorage.setItem(STORAGE_LANGUAGE, selectedLanguage);
      rebuildPools();
      resetFeed();
    });
  });

  settingsView.querySelectorAll('.theme-chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      const slug = chip.dataset.slug;
      // Cycle: normal -> favorite -> muted -> normal.
      if (favoriteCategories.has(slug)) {
        favoriteCategories.delete(slug);
        if (mutedCategories.size < CHIP_CATEGORIES.length - 1) {
          // at least one topic always stays on
          mutedCategories.add(slug);
          if (selectedCategory === slug) selectedCategory = 'all';
        } else {
          showToast('Mindestens ein Thema muss aktiv bleiben');
        }
      } else if (mutedCategories.has(slug)) {
        mutedCategories.delete(slug);
      } else {
        favoriteCategories.add(slug);
      }
      saveMuted();
      saveFavoriteCats();
      renderChips();
      rebuildPools();
      resetFeed();
      renderSettingsView(); // re-render so chip order and states stay consistent
    });
  });

  const resetBtn = settingsView.querySelector('.btn-reset');
  resetBtn.addEventListener('click', () => {
    if (!resetBtn.dataset.confirming) {
      resetBtn.dataset.confirming = '1';
      resetBtn.textContent = 'Wirklich alles zurücksetzen?';
      return;
    }
    [
      STORAGE_STATS,
      STORAGE_TAG_STATS,
      STORAGE_SEEN_AT,
      STORAGE_SESSION,
      STORAGE_SHOW_COUNTS,
      STORAGE_REACTIONS,
      STORAGE_FAVORITES,
      STORAGE_BOOSTED,
      STORAGE_MUTED,
      STORAGE_FAVORITE_CATS,
    ].forEach((k) => localStorage.removeItem(k));
    location.reload();
  });
}

// ---------- boot ----------

function isValidFact(fact) {
  return Boolean(
    fact &&
    Number.isInteger(fact.id) &&
    typeof fact.text === 'string' &&
    fact.text.trim() &&
    typeof fact.category === 'string' &&
    ['de', 'en'].includes(fact.lang) &&
    Array.isArray(fact.tags)
  );
}

function renderFatalError(error) {
  feed.innerHTML = `<div class="card"><div class="card-inner">Facts konnten nicht geladen werden: ${escapeHtml(
    String(error && error.message ? error.message : error)
  )}</div></div>`;
}

async function loadFacts() {
  const response = await fetch('facts.json');
  if (!response.ok) {
    throw new Error(`facts.json konnte nicht geladen werden: HTTP ${response.status}`);
  }
  const data = await response.json();
  if (!Array.isArray(data)) {
    throw new Error('facts.json enthält kein Array.');
  }
  const validFacts = data.filter(isValidFact);
  if (validFacts.length === 0) {
    throw new Error('Keine gültigen Facts gefunden.');
  }
  if (validFacts.length !== data.length) {
    console.warn(`${data.length - validFacts.length} ungültige Facts wurden ignoriert.`);
  }
  return validFacts;
}

function getRequestedFactId() {
  const match = location.hash.match(/^#fact=(\d+)$/);
  return match ? Number(match[1]) : null;
}

async function init() {
  try {
    renderChips();
    allFacts = await loadFacts();
    factById = new Map(allFacts.map((f) => [f.id, f]));
    rebuildPools();

    // Deep link (#fact=123): show the shared fact first, then the normal feed.
    const requestedId = getRequestedFactId();
    const requested = requestedId !== null ? factById.get(requestedId) : null;
    if (requested) {
      appendCard(requested);
      // Book it like a regular pick so it doesn't come around again shortly.
      seenAt[String(requested.id)] = session;
      saveSeenAt();
    }

    fillWindow();
  } catch (error) {
    renderFatalError(error);
  }
}

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch((error) => {
      console.warn('Service worker registration failed', error);
    });
  });
}

init();
