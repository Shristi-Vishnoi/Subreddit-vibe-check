/* =========================================================
   THE SUBREDDIT VIBE CHECK
   A small, self-contained lexicon-based sentiment scorer
   runs entirely in the browser on post titles only.
   ========================================================= */

/* ---------- 1. Sentiment lexicon ----------
   Scores loosely follow the AFINN convention (-5 .. +5),
   plus a handful of Reddit-flavoured slang terms so the
   scorer actually understands the site it's reading. */
const LEXICON = {
  // strongly positive
  amazing:4, incredible:4, awesome:4, brilliant:4, excellent:4, fantastic:4,
  wonderful:4, love:3, loved:3, loving:3, perfect:4, masterpiece:4, legendary:4,
  goated:4, banger:4, based:3, iconic:3, wholesome:3, epic:3, glorious:4,

  // mildly positive
  good:2, great:3, nice:2, happy:3, glad:2, win:2, wins:2, winning:2, wholesomely:2,
  best:3, beautiful:3, exciting:2, excited:2, fun:2, funny:2, hilarious:3,
  impressive:3, success:2, successful:2, celebrate:2, celebrated:2, thanks:2,
  thank:2, grateful:2, hope:1, hopeful:2, proud:2, relief:2, relieved:2,
  cool:2, solid:2, fire:3, lit:2, respect:2, kind:2, helpful:2, useful:1,

  // strongly negative
  terrible:-4, horrible:-4, awful:-4, disaster:-4, tragedy:-4, tragic:-4,
  disgusting:-4, hate:-3, hated:-3, worst:-4, catastrophe:-4, nightmare:-3,
  devastating:-4, scandal:-3, corrupt:-3, corruption:-3, brutal:-3, cruel:-3,
  dead:-2, death:-3, dies:-3, died:-3, killed:-4, kill:-3, murder:-4,
  fraud:-3, scam:-3, cringe:-2, trash:-3, garbage:-3, mid:-1, ick:-2,

  // mildly negative
  bad:-2, sad:-2, angry:-2, annoying:-2, annoyed:-2, disappointed:-2,
  disappointing:-2, worried:-2, worrying:-2, worry:-1, fail:-2, failed:-2,
  failure:-2, wrong:-1, broken:-2, problem:-2, problems:-2, issue:-1,
  issues:-1, concern:-1, concerns:-1, concerning:-2, controversy:-2,
  controversial:-2, backlash:-3, criticism:-2, criticized:-2, slammed:-2,
  slams:-2, blasted:-2, ridiculous:-2, absurd:-2, mess:-2, chaos:-2,
  crisis:-3, warning:-1, alarm:-2, alarming:-2, sus:-2, cursed:-2,
  yikes:-2, awkward:-1, boring:-2, disturbing:-3, shocking:-2, outrage:-3,
  outraged:-3, furious:-3, panic:-3, scared:-2, afraid:-2, fear:-2,

  // neutral-ish but title-relevant intensifiers, left at 0 (no entry)
};

const NEGATORS = new Set(['not', 'no', 'never', "n't", 'without', 'lack', 'lacks']);
const BOOSTERS = new Set(['very', 'extremely', 'so', 'really', 'super', 'incredibly']);

/** Tokenize a title into lowercase word tokens, stripping punctuation. */
function tokenize(title) {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9'\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

/** Score a single title. Returns a signed integer. */
function scoreTitle(title) {
  const tokens = tokenize(title);
  let score = 0;
  for (let i = 0; i < tokens.length; i++) {
    const word = tokens[i];
    if (!(word in LEXICON)) continue;
    let wordScore = LEXICON[word];

    const prev1 = tokens[i - 1];
    const prev2 = tokens[i - 2];
    if (NEGATORS.has(prev1) || NEGATORS.has(prev2)) wordScore *= -1;
    if (BOOSTERS.has(prev1)) wordScore *= 1.5;

    score += wordScore;
  }
  return score;
}

function classify(score) {
  if (score > 0) return 'positive';
  if (score < 0) return 'negative';
  return 'neutral';
}

/* ---------- 2. Reddit fetching ----------
   We route through a small Cloudflare Worker instead of public
   CORS-proxy mirrors: Reddit itself doesn't send CORS headers,
   and free third-party proxies (allorigins/corsproxy/codetabs)
   are unreliable under real traffic — rate limits, downtime,
   403s. The Worker fetches Reddit server-side (no CORS involved)
   and forwards the JSON back with an open CORS header. */

// TODO: replace with YOUR deployed Worker URL from the Cloudflare dashboard
const PROXY_URL = 'https://reddit-proxy.riya123hifi.workers.dev';

async function fetchHotPosts(subreddit) {
  const target = `${PROXY_URL}?sub=${encodeURIComponent(subreddit)}`;
  return directFetch(target);
}

async function directFetch(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 9000);
  let response;
  try {
    response = await fetch(url, {
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    });
  } catch (e) {
    throw new Error(e.name === 'AbortError' ? 'timeout' : 'network_error');
  } finally {
    clearTimeout(timeout);
  }

  if (response.status === 404) throw new Error('not_found');
  if (response.status === 403 || response.status === 429) throw new Error('blocked');
  if (!response.ok) throw new Error(`http_${response.status}`);

  let data;
  try {
    data = await response.json();
  } catch (e) {
    throw new Error('bad_json');
  }
  if (!data || !data.data || !Array.isArray(data.data.children)) throw new Error('bad_shape');
  if (data.data.children.length === 0) throw new Error('empty');
  return data.data.children
    .filter((c) => c.kind === 't3')
    .map((c) => ({
      title: c.data.title,
      permalink: `https://www.reddit.com${c.data.permalink}`,
      ups: c.data.ups,
      author: c.data.author,
    }));
}

/* ---------- 3. DOM wiring ---------- */

const form = document.getElementById('scanForm');
const input = document.getElementById('subredditInput');
const errorMsg = document.getElementById('errorMsg');
const loadingSection = document.getElementById('loadingSection');
const loadingSub = document.getElementById('loadingSub');
const readingSection = document.getElementById('readingSection');
const scanBtn = document.getElementById('scanBtn');
const signalDot = document.getElementById('signalDot');
const signalLabel = document.getElementById('signalLabel');
const presets = document.getElementById('presets');
const feedFilters = document.getElementById('feedFilters');

let currentPosts = []; // holds {title, permalink, ups, score, tone}
let activeFilter = 'all';

form.addEventListener('submit', (e) => {
  e.preventDefault();
  const raw = input.value.trim().replace(/^\/?r\//i, '');
  if (!raw) {
    showError('Enter a subreddit name to take its pulse.');
    return;
  }
  runScan(raw);
});

presets.addEventListener('click', (e) => {
  const btn = e.target.closest('.preset-chip');
  if (!btn) return;
  input.value = btn.dataset.sub;
  runScan(btn.dataset.sub);
});

feedFilters.addEventListener('click', (e) => {
  const btn = e.target.closest('.filter-chip');
  if (!btn) return;
  activeFilter = btn.dataset.filter;
  [...feedFilters.children].forEach((c) => c.classList.toggle('is-active', c === btn));
  renderFeed();
});

async function runScan(subreddit) {
  hideError();
  readingSection.hidden = true;
  loadingSection.hidden = false;
  loadingSub.textContent = subreddit;
  scanBtn.disabled = true;
  setSignal('idle', 'Scanning…');

  try {
    const posts = await fetchHotPosts(subreddit);
    currentPosts = posts.map((p) => {
      const score = scoreTitle(p.title);
      return { ...p, score, tone: classify(score) };
    });
    renderDashboard(subreddit);
    setSignal('live', `Live — r/${subreddit}`);
  } catch (err) {
    handleFetchError(err, subreddit);
    setSignal('error', 'Scan failed');
  } finally {
    loadingSection.hidden = true;
    scanBtn.disabled = false;
  }
}

function handleFetchError(err, subreddit) {
  const msg = err && err.message;
  console.error('[vibe-check] scan failed:', err);
  if (msg === 'not_found') {
    showError(`r/${subreddit} doesn't seem to exist. Check the spelling and try again.`);
  } else if (msg === 'empty') {
    showError(`r/${subreddit} has no hot posts to read right now.`);
  } else if (msg === 'blocked') {
    showError('Reddit rate-limited this request. Wait a moment and try again.');
  } else if (msg === 'timeout') {
    showError('The request timed out. Try again in a moment.');
  } else {
    showError(`Couldn't reach r/${subreddit} right now (${msg || 'unknown error'}). Open the browser console (F12) for details, or try again in a moment.`);
  }
}

function showError(msg) {
  errorMsg.textContent = msg;
  errorMsg.hidden = false;
}
function hideError() {
  errorMsg.hidden = true;
}
function setSignal(state, label) {
  signalDot.dataset.state = state;
  signalLabel.textContent = label;
}

/* ---------- 4. Rendering ---------- */

const MOOD_BANDS = [
  { max: -3, label: 'Doom & gloom' },
  { max: -0.6, label: 'Grumbling' },
  { max: 0.6, label: 'Mixed bag' },
  { max: 3, label: 'Good vibes' },
  { max: Infinity, label: 'Thriving' },
];

function moodLabel(avg) {
  return MOOD_BANDS.find((b) => avg <= b.max).label;
}

function renderDashboard(subreddit) {
  document.getElementById('gaugeSub').textContent = subreddit;

  const total = currentPosts.length;
  const avg = total ? currentPosts.reduce((s, p) => s + p.score, 0) / total : 0;

  // Gauge needle: clamp average to [-5, 5], map to [-90deg, 90deg]
  const clamped = Math.max(-5, Math.min(5, avg));
  const angle = (clamped / 5) * 90;
  document.getElementById('needle').setAttribute('transform', `rotate(${angle} 150 160)`);
  document.getElementById('gaugeScore').textContent = avg.toFixed(1);
  document.getElementById('gaugeMood').textContent = moodLabel(avg);

  const pos = currentPosts.filter((p) => p.tone === 'positive').length;
  const neu = currentPosts.filter((p) => p.tone === 'neutral').length;
  const neg = currentPosts.filter((p) => p.tone === 'negative').length;

  document.getElementById('countPos').textContent = pos;
  document.getElementById('countNeu').textContent = neu;
  document.getElementById('countNeg').textContent = neg;
  document.getElementById('fillPos').style.width = total ? `${(pos / total) * 100}%` : '0%';
  document.getElementById('fillNeu').style.width = total ? `${(neu / total) * 100}%` : '0%';
  document.getElementById('fillNeg').style.width = total ? `${(neg / total) * 100}%` : '0%';

  const best = currentPosts.reduce((a, b) => (b.score > a.score ? b : a), currentPosts[0]);
  const worst = currentPosts.reduce((a, b) => (b.score < a.score ? b : a), currentPosts[0]);
  document.getElementById('bestTitle').textContent = best ? best.title : '—';
  document.getElementById('worstTitle').textContent = worst ? worst.title : '—';

  activeFilter = 'all';
  [...feedFilters.children].forEach((c) => c.classList.toggle('is-active', c.dataset.filter === 'all'));
  renderFeed();

  readingSection.hidden = false;
}

function renderFeed() {
  const feedList = document.getElementById('feedList');
  feedList.innerHTML = '';
  currentPosts.forEach((p, i) => {
    const li = document.createElement('li');
    const row = document.createElement('a');
    row.className = 'feed-row';
    row.dataset.tone = p.tone;
    row.href = p.permalink;
    row.target = '_blank';
    row.rel = 'noopener noreferrer';
    if (activeFilter !== 'all' && p.tone !== activeFilter) row.classList.add('is-hidden');

    row.innerHTML = `
      <span class="feed-index">${String(i + 1).padStart(2, '0')}</span>
      <span class="feed-title">${escapeHtml(p.title)}</span>
      <span class="feed-meta">
        <span class="feed-tag" aria-hidden="true"></span>
        <span class="feed-score">${p.score > 0 ? '+' : ''}${p.score}</span>
      </span>
    `;
    li.appendChild(row);
    feedList.appendChild(li);
  });
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}