import { readJSON, writeJSON } from './storage.js';
import { clamp, weightedRandom, decayStats, scoreFact, noveltyFactor } from './recommender.js';
import { nextReaction, applyReactionDelta } from './reactions.js';

const STORAGE_STATS = 'factfeed_categoryStats';
const STORAGE_TAG_STATS = 'factfeed_tagStats';
const STORAGE_SEEN_AT = 'factfeed_seenAt';
const STORAGE_SESSION = 'factfeed_session';
const STORAGE_SHOW_COUNTS = 'factfeed_showCounts';
const STORAGE_REACTIONS = 'factfeed_reactions';
const STORAGE_FAVORITES = 'factfeed_favorites';
const STORAGE_BOOSTED = 'factfeed_boosted';
const STORAGE_LANGUAGE = 'factfeed_language';
const WINDOW_AHEAD = 6;
const AXIS_LOCK_PX = 12;
const SWIPE_THRESHOLD_PX = 90;
const TAP_MOVE_THRESHOLD_PX = 24;
const SESSION_DECAY = 0.98;

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
  science: '#a78bfa',
  history: '#f59e0b',
  nature: '#14b8a6',
  space: '#6366f1',
  animals: '#22c55e',
  geography: '#f97316',
  technology: '#3b82f6',
  psychology: '#ec4899',
  food: '#ef4444',
  curiosities: '#eab308',
};

const categoryColor = (category) => CATEGORY_COLORS[category] || null;

const saveStats = () => writeJSON(STORAGE_STATS, categoryStats);
const saveTagStats = () => writeJSON(STORAGE_TAG_STATS, tagStats);
const saveSeenAt = () => writeJSON(STORAGE_SEEN_AT, seenAt);
const saveShowCounts = () => writeJSON(STORAGE_SHOW_COUNTS, showCounts);
const saveFavorites = () => writeJSON(STORAGE_FAVORITES, [...favorites]);
const saveBoosted = () => writeJSON(STORAGE_BOOSTED, [...boostedIds]);
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
    fact = weightedRandom(candidates, (f) => scoreFact(f, { categoryStats, tagStats, seenAt, session }));
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
  snapBack(card);
}

function snapBack(card) {
  card.style.transition = 'transform 0.2s ease, opacity 0.2s ease';
  card.style.transform = 'translateX(0) rotate(0)';
  card.style.opacity = '1';
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
  const shareData = { title: 'Fact Feed', text: fact.text, url: url.toString() };
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

function attachGestures(card, fact) {
  let pointer = null;
  let lastTapTime = 0;

  card.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    // Let taps on interactive elements (action buttons, source link, boost
    // button) stay plain native clicks — if the swipe gesture below claims
    // this pointer (e.g. via a bit of jitter reading as a horizontal drag)
    // and calls setPointerCapture, the element's own click event can
    // silently fail to fire on real touch devices.
    if (e.target.closest('.gesture-exempt')) return;
    pointer = { id: e.pointerId, x0: e.clientX, y0: e.clientY, mode: 'undecided' };
  });

  card.addEventListener('pointermove', (e) => {
    if (!pointer || e.pointerId !== pointer.id) return;
    const dx = e.clientX - pointer.x0;
    const dy = e.clientY - pointer.y0;

    if (pointer.mode === 'undecided') {
      if (Math.hypot(dx, dy) < AXIS_LOCK_PX) return;
      const angle = Math.abs((Math.atan2(dy, dx) * 180) / Math.PI);
      pointer.mode = angle < 30 || angle > 150 ? 'horizontal' : 'vertical';
      if (pointer.mode === 'horizontal') {
        card.setPointerCapture(pointer.id);
      }
    }

    if (pointer.mode === 'horizontal') {
      e.preventDefault();
      card.style.transition = 'none';
      card.style.transform = `translateX(${dx}px) rotate(${dx / 20}deg)`;
      card.style.opacity = String(1 - Math.min(Math.abs(dx) / 300, 0.5));
      const flash = card.querySelector('.swipe-flash');
      if (flash) {
        flash.style.background = dx > 0 ? 'var(--like)' : 'var(--dislike)';
        flash.style.opacity = String(Math.min(Math.abs(dx) / 200, 0.35));
      }
    }
  });

  function endGesture(e) {
    if (!pointer || e.pointerId !== pointer.id) return;
    const dx = e.clientX - pointer.x0;
    const dy = e.clientY - pointer.y0;
    const distance = Math.hypot(dx, dy);

    if (pointer.mode === 'horizontal') {
      const flash = card.querySelector('.swipe-flash');
      if (flash) flash.style.opacity = '0';
      if (Math.abs(dx) > SWIPE_THRESHOLD_PX) {
        react(card, fact, dx > 0 ? 1 : -1);
        pointer = null;
        return;
      }
      snapBack(card);
    }

    // A real finger tap rarely stays under AXIS_LOCK_PX, so `mode` often
    // already flipped to 'vertical' (or a too-small 'horizontal') by the
    // time the finger lifts. Judge tap-vs-drag on total distance here
    // instead of trusting `mode`, so double-tap stays reliable on touch.
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
    pointer = null;
  }

  card.addEventListener('pointerup', endGesture);
  // A cancelled pointer (browser took over the gesture, common on iOS) can
  // carry garbage coordinates — treating it like pointerup could read as a
  // full-distance swipe and fire an unintended dislike. Only clean up.
  card.addEventListener('pointercancel', () => {
    if (pointer) {
      const flash = card.querySelector('.swipe-flash');
      if (flash) flash.style.opacity = '0';
      snapBack(card);
    }
    pointer = null;
  });
}

// ---------- cards ----------

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
  const words = fact.text.trim().split(/\s+/).length;
  card.dataset.expectedMs = String(clamp(words * 240, 1200, 8000));

  card.innerHTML = `
    <div class="swipe-flash"></div>
    <div class="card-inner">
      <p class="card-category">${escapeHtml(categoryLabel(fact.category))}</p>
      <p class="card-text">${escapeHtml(fact.text)}</p>
      <p class="card-lang">${fact.lang.toUpperCase()}</p>
      <button class="btn-more gesture-exempt" type="button">Mehr davon</button>
    </div>
    <div class="card-actions gesture-exempt">
      <button class="btn-like" type="button" aria-label="Fact gefällt mir" aria-pressed="false">&#10084;&#65039;</button>
      <button class="btn-dislike" type="button" aria-label="Fact gefällt mir nicht" aria-pressed="false">&#128078;</button>
      <button class="btn-save" type="button" aria-label="Fact speichern" aria-pressed="false">&#128278;</button>
      <button class="btn-share" type="button" aria-label="Fact teilen">&#128228;</button>
    </div>
  `;

  const sourceLink = createSourceLink(fact);
  if (sourceLink) card.querySelector('.card-inner').appendChild(sourceLink);

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
    showToast(nowSaved ? 'Gespeichert' : 'Entfernt');
  });

  card.querySelector('.btn-share').addEventListener('click', () => shareFact(fact));

  // "Mehr davon" is a one-time boost per fact — persisted, so the button
  // can't be farmed for +2 every time the fact cycles back around.
  const moreBtn = card.querySelector('.btn-more');
  const renderBoosted = () => {
    moreBtn.textContent = '✓ Kommt öfter';
    moreBtn.disabled = true;
  };
  if (boostedIds.has(fact.id)) renderBoosted();
  moreBtn.addEventListener('click', () => {
    if (boostedIds.has(fact.id)) return;
    boostFactTopics(fact);
    boostedIds.add(fact.id);
    saveBoosted();
    renderBoosted();
  });

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

document.addEventListener('keydown', (e) => {
  if (!activeCard || currentView !== 'feed') return;
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    const target = e.key === 'ArrowDown' ? activeCard.nextElementSibling : activeCard.previousElementSibling;
    if (target) {
      e.preventDefault();
      target.scrollIntoView({ behavior: 'smooth' });
    }
  } else if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
    const fact = factById.get(Number(activeCard.dataset.factId));
    if (fact) react(activeCard, fact, e.key === 'ArrowRight' ? 1 : -1);
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
    const link = activeCard.querySelector('.fact-source');
    if (link) window.open(link.href, '_blank', 'noopener');
  }
});

// ---------- feed lifecycle ----------

function appendCard(specificFact) {
  const fact = specificFact || pickNextFact();
  if (!fact) return;
  const card = createCard(fact);
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

function applyLanguageFilter(list) {
  if (selectedLanguage === 'all') return list;
  return list.filter((fact) => fact.lang === selectedLanguage);
}

function rebuildPools() {
  facts = applyLanguageFilter(allFacts);
  if (facts.length === 0) facts = allFacts; // never leave the feed empty
  categories = [...new Set(facts.map((f) => f.category))];
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
  savedView.innerHTML = '<h2>Gespeicherte Facts</h2>';
  const ids = [...favorites];
  if (ids.length === 0) {
    savedView.innerHTML += '<p class="empty-note">Noch nichts gespeichert. Tippe 🔖 auf einer Karte, um einen Fact hier abzulegen.</p>';
    return;
  }
  ids.forEach((id) => {
    const fact = factById.get(id);
    if (!fact) return;
    const item = document.createElement('article');
    item.className = 'saved-item';
    item.innerHTML = `
      <p class="saved-item-category">${escapeHtml(categoryLabel(fact.category))}</p>
      <p class="saved-item-text">${escapeHtml(fact.text)}</p>
      <div class="saved-item-actions">
        <button class="saved-share" type="button">Teilen</button>
        <button class="saved-remove" type="button">Entfernen</button>
      </div>
    `;
    item.querySelector('.saved-share').addEventListener('click', () => shareFact(fact));
    item.querySelector('.saved-remove').addEventListener('click', () => {
      favorites.delete(id);
      saveFavorites();
      item.remove();
      if (favorites.size === 0) renderSavedView();
    });
    savedView.appendChild(item);
  });
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

  settingsView.innerHTML = `
    <h2>Einstellungen</h2>
    <section class="settings-block">
      <h3>Sprache der Facts</h3>
      ${langOptions}
    </section>
    <section class="settings-block">
      <h3>Profil</h3>
      <p class="settings-note">${Object.keys(reactions).length} Bewertungen · ${favorites.size} gespeichert</p>
      <button class="btn-reset" type="button">Profil zurücksetzen</button>
      <p class="settings-note">Löscht Bewertungen, gelernte Vorlieben und Gespeichertes auf diesem Gerät.</p>
    </section>
  `;

  settingsView.querySelectorAll('input[name="language"]').forEach((input) => {
    input.addEventListener('change', () => {
      selectedLanguage = input.value;
      localStorage.setItem(STORAGE_LANGUAGE, selectedLanguage);
      rebuildPools();
      resetFeed();
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
