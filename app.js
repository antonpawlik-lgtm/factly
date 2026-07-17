(function () {
  const STORAGE_STATS = 'factfeed_categoryStats';
  const STORAGE_SEEN = 'factfeed_seenIds';
  const WINDOW_AHEAD = 6;
  const AXIS_LOCK_PX = 12;
  const SWIPE_THRESHOLD_PX = 90;

  const feed = document.getElementById('feed');
  const hint = document.getElementById('hint');

  let facts = [];
  let byCategory = {};
  let categories = [];
  const categoryStats = loadJSON(STORAGE_STATS, {});
  const seenIds = loadJSON(STORAGE_SEEN, {});
  let hintTimer = null;

  function loadJSON(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (e) {
      return fallback;
    }
  }

  function saveStats() {
    localStorage.setItem(STORAGE_STATS, JSON.stringify(categoryStats));
  }

  function saveSeen() {
    localStorage.setItem(STORAGE_SEEN, JSON.stringify(seenIds));
  }

  function clamp(n, min, max) {
    return Math.max(min, Math.min(max, n));
  }

  function weightFor(category) {
    const stats = categoryStats[category] || { likes: 0, dislikes: 0 };
    const score = stats.likes - stats.dislikes;
    return clamp(1 + 0.4 * score, 0.15, 6);
  }

  function pickNextFact() {
    const weights = categories.map((c) => weightFor(c));
    const total = weights.reduce((a, b) => a + b, 0);
    let r = Math.random() * total;
    let chosenCategory = categories[categories.length - 1];
    for (let i = 0; i < categories.length; i++) {
      r -= weights[i];
      if (r <= 0) {
        chosenCategory = categories[i];
        break;
      }
    }

    const pool = byCategory[chosenCategory];
    const seen = seenIds[chosenCategory] || [];
    let candidates = pool.filter((f) => !seen.includes(f.id));
    if (candidates.length === 0) {
      seenIds[chosenCategory] = [];
      candidates = pool;
    }
    const fact = candidates[Math.floor(Math.random() * candidates.length)];

    seenIds[chosenCategory] = [...(seenIds[chosenCategory] || []), fact.id];
    saveSeen();
    return fact;
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  function react(card, fact, direction) {
    const stats = categoryStats[fact.category] || { likes: 0, dislikes: 0 };
    const prev = card.dataset.reaction;
    if (prev === 'like') stats.likes -= 1;
    if (prev === 'dislike') stats.dislikes -= 1;
    if (direction > 0) stats.likes += 1;
    else stats.dislikes += 1;
    categoryStats[fact.category] = stats;
    saveStats();

    card.dataset.reaction = direction > 0 ? 'like' : 'dislike';
    card.querySelector('.btn-like').classList.toggle('selected', direction > 0);
    card.querySelector('.btn-dislike').classList.toggle('selected', direction < 0);
    snapBack(card);
  }

  function snapBack(card) {
    card.style.transition = 'transform 0.2s ease, opacity 0.2s ease';
    card.style.transform = 'translateX(0) rotate(0)';
    card.style.opacity = '1';
  }

  function attachGestures(card, fact) {
    let pointer = null;

    card.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
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
      if (pointer.mode === 'horizontal') {
        const flash = card.querySelector('.swipe-flash');
        if (flash) flash.style.opacity = '0';
        if (Math.abs(dx) > SWIPE_THRESHOLD_PX) {
          react(card, fact, dx > 0 ? 1 : -1);
        } else {
          snapBack(card);
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

    return card;
  }

  const observer = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting && entry.intersectionRatio > 0.6) {
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

  function appendCard() {
    const fact = pickNextFact();
    const card = createCard(fact);
    feed.appendChild(card);
    observer.observe(card);
    trimOldCards();
  }

  function trimOldCards() {
    while (feed.children.length > WINDOW_AHEAD * 3) {
      const first = feed.firstElementChild;
      observer.unobserve(first);
      first.remove();
    }
  }

  function fillWindow() {
    for (let i = 0; i < WINDOW_AHEAD; i++) {
      appendCard();
    }
  }

  fetch('facts.json')
    .then((r) => r.json())
    .then((data) => {
      facts = data;
      categories = [...new Set(facts.map((f) => f.category))];
      byCategory = {};
      categories.forEach((c) => {
        byCategory[c] = facts.filter((f) => f.category === c);
      });
      fillWindow();
    })
    .catch((err) => {
      feed.innerHTML = `<div class="card"><div class="card-inner">Facts konnten nicht geladen werden: ${escapeHtml(
        String(err)
      )}</div></div>`;
    });
})();
