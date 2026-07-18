(function () {
  const STORAGE_STATS = 'factfeed_categoryStats';
  const STORAGE_TAG_STATS = 'factfeed_tagStats';
  const STORAGE_SEEN = 'factfeed_seenIds';
  const STORAGE_REACTIONS = 'factfeed_reactions';
  const WINDOW_AHEAD = 6;
  const AXIS_LOCK_PX = 12;
  const SWIPE_THRESHOLD_PX = 90;
  const TAP_MOVE_THRESHOLD_PX = 24;

  const feed = document.getElementById('feed');
  const hint = document.getElementById('hint');

  let facts = [];
  let byCategory = {};
  let categories = [];
  let factById = new Map();
  const categoryStats = loadJSON(STORAGE_STATS, {});
  const tagStats = loadJSON(STORAGE_TAG_STATS, {});
  const seenIds = loadJSON(STORAGE_SEEN, {});
  const reactions = loadJSON(STORAGE_REACTIONS, {}); // { "17": "like", "48": "dislike" }
  let hintTimer = null;

  function loadJSON(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (e) {
      return fallback;
    }
  }

  function saveJSON(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
      return true;
    } catch (e) {
      console.warn(`Could not save ${key}`, e);
      return false;
    }
  }

  function saveStats() {
    saveJSON(STORAGE_STATS, categoryStats);
  }

  function saveTagStats() {
    saveJSON(STORAGE_TAG_STATS, tagStats);
  }

  function saveSeen() {
    saveJSON(STORAGE_SEEN, seenIds);
  }

  function clamp(n, min, max) {
    return Math.max(min, Math.min(max, n));
  }

  function weightFor(category) {
    const stats = categoryStats[category] || { likes: 0, dislikes: 0, dwell: 0 };
    const score = stats.likes - stats.dislikes + (stats.dwell || 0);
    return clamp(1 + 0.4 * score, 0.15, 6);
  }

  // Tags are fine-grained sub-topics (e.g. "dinosaurs" within history) that
  // cut across categories. Same formula shape as weightFor, but a tighter
  // clamp: tag scores grow faster (one like touches up to 3 tags) and the
  // per-category candidate pools they act on are small.
  function tagWeightFor(tag) {
    const stats = tagStats[tag] || { likes: 0, dislikes: 0, dwell: 0 };
    const score = stats.likes - stats.dislikes + (stats.dwell || 0);
    return clamp(1 + 0.4 * score, 0.25, 4);
  }

  // Mean (not product) so multi-tag facts aren't systematically favored or
  // punished just for carrying more tags. No/unknown tags = neutral weight 1,
  // which also keeps old cached facts.json and future tagless news cards safe.
  function factWeightFor(fact) {
    const tags = fact.tags || [];
    if (tags.length === 0) return 1;
    return tags.reduce((sum, t) => sum + tagWeightFor(t), 0) / tags.length;
  }

  // Implicit signal alongside explicit likes/dislikes: how long a fact stayed
  // the active (>60% visible) card versus how long its text takes to read.
  // Lingering well past the expected reading time counts as mild interest,
  // scrolling past almost immediately counts as mild disinterest — same idea
  // as watch-time/completion-rate weighting, just scaled down since it's an
  // inferred rather than an explicit signal.
  const DWELL_LINGER_RATIO = 1.4;
  const DWELL_SKIP_RATIO = 0.35;
  const DWELL_LINGER_SCORE = 0.3;
  const DWELL_SKIP_SCORE = -0.2;
  // Hard cap: even if a card somehow stays "active" for minutes (missed
  // visibility event, stuck tab), it can never count as more than 30s.
  const DWELL_CAP_MS = 30000;
  // One dwell signal per fact per session, so bouncing up and down over the
  // same card doesn't stack the same signal repeatedly.
  const dwellRecorded = new Set();

  function applyDwellSignal(card, dwellMs) {
    const factId = card.dataset.factId;
    if (dwellRecorded.has(factId)) return;
    const category = card.dataset.category;
    const expectedMs = Number(card.dataset.expectedMs) || 3000;
    const ratio = Math.min(dwellMs, DWELL_CAP_MS) / expectedMs;
    if (ratio > DWELL_SKIP_RATIO && ratio < DWELL_LINGER_RATIO) return; // normal reading pace
    dwellRecorded.add(factId);

    const delta = ratio > DWELL_LINGER_RATIO ? DWELL_LINGER_SCORE : DWELL_SKIP_SCORE;
    const stats = categoryStats[category] || { likes: 0, dislikes: 0, dwell: 0 };
    stats.dwell = (stats.dwell || 0) + delta;
    categoryStats[category] = stats;
    saveStats();

    // Each tag gets the full delta (not divided by tag count) — consistent
    // with reactions giving each tag a full like, and tag-count-neutral
    // overall because factWeightFor averages. filter(Boolean) makes tagless
    // cards (e.g. future news cards) a silent no-op: ''.split(',') is [''].
    const tags = (card.dataset.tags || '').split(',').filter(Boolean);
    tags.forEach((tag) => {
      const ts = tagStats[tag] || { likes: 0, dislikes: 0, dwell: 0 };
      ts.dwell = (ts.dwell || 0) + delta;
      tagStats[tag] = ts;
    });
    if (tags.length > 0) saveTagStats();
  }

  // Even if one category ends up completely dominant (heavily liked while
  // others sit at the weight floor), every so often ignore the weights
  // entirely and pull from a uniformly random category. Keeps the feed from
  // fully locking into one bubble — same idea as "interest exploration" in
  // recommender systems.
  const EXPLORE_RATE = 0.15;

  function pickNextFact() {
    if (categories.length === 0) return null;
    let chosenCategory;
    if (Math.random() < EXPLORE_RATE) {
      chosenCategory = categories[Math.floor(Math.random() * categories.length)];
    } else {
      const weights = categories.map((c) => weightFor(c));
      const total = weights.reduce((a, b) => a + b, 0);
      let r = Math.random() * total;
      chosenCategory = categories[categories.length - 1];
      for (let i = 0; i < categories.length; i++) {
        r -= weights[i];
        if (r <= 0) {
          chosenCategory = categories[i];
          break;
        }
      }
    }

    const pool = byCategory[chosenCategory];
    const seen = seenIds[chosenCategory] || [];
    let candidates = pool.filter((f) => !seen.includes(f.id));
    if (candidates.length === 0) {
      seenIds[chosenCategory] = [];
      candidates = pool;
    }
    const candWeights = candidates.map(factWeightFor);
    const candTotal = candWeights.reduce((a, b) => a + b, 0);
    let cr = Math.random() * candTotal;
    let fact = candidates[candidates.length - 1];
    for (let i = 0; i < candidates.length; i++) {
      cr -= candWeights[i];
      if (cr <= 0) {
        fact = candidates[i];
        break;
      }
    }

    seenIds[chosenCategory] = [...(seenIds[chosenCategory] || []), fact.id];
    saveSeen();
    return fact;
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  function updateReactionStats(store, key, previous, next) {
    const stats = store[key] || { likes: 0, dislikes: 0, dwell: 0 };
    if (previous === 'like') stats.likes = Math.max(0, stats.likes - 1);
    if (previous === 'dislike') stats.dislikes = Math.max(0, stats.dislikes - 1);
    if (next === 'like') stats.likes += 1;
    if (next === 'dislike') stats.dislikes += 1;
    store[key] = stats;
  }

  // Reactions are persisted per fact id, so a fact that comes around again
  // (after a category cycle reset or a reload) shows its stored reaction and
  // re-rating it rebooks the stats instead of double-counting.
  function setFactReaction(fact, requested, allowToggleOff) {
    const factId = String(fact.id);
    const previous = reactions[factId] || null;
    if (previous === requested && !allowToggleOff) return previous;

    // Same reaction again = toggle it off; anything else switches to it.
    const next = previous === requested ? null : requested;

    updateReactionStats(categoryStats, fact.category, previous, next);
    (fact.tags || []).forEach((tag) => updateReactionStats(tagStats, tag, previous, next));

    if (next) reactions[factId] = next;
    else delete reactions[factId];
    saveJSON(STORAGE_REACTIONS, reactions);
    saveStats();
    saveTagStats();
    return next;
  }

  function renderReaction(card, reaction) {
    if (reaction) card.dataset.reaction = reaction;
    else delete card.dataset.reaction;
    card.querySelector('.btn-like').classList.toggle('selected', reaction === 'like');
    card.querySelector('.btn-dislike').classList.toggle('selected', reaction === 'dislike');
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
      // Let taps on the like/dislike buttons stay plain native clicks — if the
      // swipe gesture below claims this pointer (e.g. via a bit of jitter
      // reading as a horizontal drag) and calls setPointerCapture, the
      // button's own click event can silently fail to fire on real touch
      // devices.
      if (e.target.closest('.card-actions')) return;
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
      if (distance < TAP_MOVE_THRESHOLD_PX && !e.target.closest('.card-actions')) {
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
    card.addEventListener('pointercancel', endGesture);
  }

  function createCard(fact) {
    const card = document.createElement('div');
    card.className = 'card';
    card.dataset.factId = String(fact.id);
    card.dataset.category = fact.category;
    card.dataset.tags = (fact.tags || []).join(',');
    const words = fact.text.trim().split(/\s+/).length;
    card.dataset.expectedMs = String(clamp(words * 240, 1200, 8000));

    card.innerHTML = `
      <div class="swipe-flash"></div>
      <div class="card-inner">
        <div class="card-category">${escapeHtml(fact.category)}</div>
        <div class="card-text">${escapeHtml(fact.text)}</div>
        <div class="card-lang">${fact.lang.toUpperCase()}</div>
      </div>
      <div class="card-actions">
        <button class="btn-like" aria-label="Like">&#10084;&#65039;</button>
        <button class="btn-dislike" aria-label="Dislike">&#128078;</button>
      </div>
    `;

    attachGestures(card, fact);
    card.querySelector('.btn-like').addEventListener('click', () => react(card, fact, 1));
    card.querySelector('.btn-dislike').addEventListener('click', () => react(card, fact, -1));

    // Restore a previously stored reaction so re-shown facts display it.
    const stored = reactions[String(fact.id)] || null;
    if (stored) renderReaction(card, stored);

    return card;
  }

  let activeCard = null;
  let activeSince = null;

  function flushActiveDwell() {
    if (!activeCard || activeSince === null) return;
    applyDwellSignal(activeCard, performance.now() - activeSince);
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
      flushActiveDwell();
    } else if (activeCard) {
      activeSince = performance.now();
    }
  });
  // pagehide (not beforeunload — unreliable on iOS) captures the last card's
  // dwell when the app is closed.
  window.addEventListener('pagehide', flushActiveDwell);

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

  document.addEventListener('keydown', (e) => {
    if (!activeCard) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      const target = e.key === 'ArrowDown' ? activeCard.nextElementSibling : activeCard.previousElementSibling;
      if (target) {
        e.preventDefault();
        target.scrollIntoView({ behavior: 'smooth' });
      }
    } else if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      const fact = factById.get(Number(activeCard.dataset.factId));
      if (fact) react(activeCard, fact, e.key === 'ArrowRight' ? 1 : -1);
    }
  });

  function appendCard() {
    const fact = pickNextFact();
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

  async function init() {
    try {
      facts = await loadFacts();
      factById = new Map(facts.map((f) => [f.id, f]));
      categories = [...new Set(facts.map((f) => f.category))];
      byCategory = {};
      categories.forEach((c) => {
        byCategory[c] = facts.filter((f) => f.category === c);
      });
      fillWindow();
    } catch (error) {
      renderFatalError(error);
    }
  }

  init();
})();
