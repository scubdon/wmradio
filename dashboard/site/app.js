/* Walmart Radio dashboard — vanilla JS over pre-built JSON. No dependencies. */
"use strict";

const $ = s => document.querySelector(s);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};
const fmtInt = n => n.toLocaleString("en-US");
const pct = f => `${Math.round(f * 100)}%`;
const DAY_MS = 86400000;

// ---------- state ----------
let META, SONGS;            // meta.json, songs.json
let N;                      // play count
let T;                      // Float64Array epoch ms, ascending
let SID;                    // Uint32Array song id per play
let LHOUR, LDOW, LDAY;      // per-play local hour, local dow (Mon=0), local day key
let LSLOT;                  // per-play local half-hour slot (0–47)
let ARTISTS = new Map();    // artist -> {ids:[], total, rank}
let ARTIST_RANK = [];       // artist names, most-played first
let rangeDays = 30;         // top-section scope
let topLimit = 15;
let turnoverBack = 30;      // how far back the turnover panel compares against

// Per-song derived stats, filled once at boot (see computeSongStats). Anything
// that only needs a single pass over the log is computed here rather than
// precomputed in build.py — it keeps the payload flat as the log grows.
let S_FIRST, S_LAST;        // Float64Array: first / last play, epoch ms
let S_N7, S_N30, S_N90;     // Int32Array: plays in the trailing 7 / 30 / 90 days
let S_NWIN, S_NPREV;        // Int32Array: plays in this and the previous rotation window
let PREV_SAME;              // Int32Array: index of the previous play of the same song, or -1

const timeFmt = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
const dateFmt = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" });
const shortDateFmt = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });
const dtFmt = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
const monthFmt = new Intl.DateTimeFormat(undefined, { month: "short", year: "2-digit" });
const DOW_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

// A day key is the epoch-day number of a *local* calendar date. Reading one
// back with local getters slips a day wherever the UTC offset is negative
// (a Jan 14 key renders as Jan 13 in New York), so day keys are always read
// in UTC — both for formatting and for day-of-week arithmetic.
const dateFromKey = k => new Date(k * DAY_MS);
const keyDateFmt = new Intl.DateTimeFormat(undefined,
  { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
const keyDayFmt = new Intl.DateTimeFormat(undefined,
  { weekday: "short", month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
const keyMonthFmt = new Intl.DateTimeFormat(undefined,
  { month: "short", year: "2-digit", timeZone: "UTC" });

// ---------- shareable state ----------
// Every filter on the page lives in the query string, so "look at the weird
// playlist we get on overnight shift" is a link rather than a set of
// instructions. The hash is left to the song/artist router, which owns it.
//
// Writes are replaceState, not pushState: these are dials, not pages, and a
// history entry per chip click would bury the Back button. Song and artist
// pages still push history, because those *are* pages.
const URLSTATE = {
  range: { get: () => rangeDays, set: v => { rangeDays = +v; }, def: 30 },
  shift: {
    get: () => `${wrapState.from}-${wrapState.to}`,
    set: v => {
      const [f, t] = v.split("-").map(Number);
      if (f >= 0 && f < 48 && t >= 0 && t < 48) { wrapState.from = f; wrapState.to = t; }
    },
    def: "18-34",
  },
  days: {
    get: () => [...wrapState.days].sort().join(""),
    set: v => { wrapState.days = new Set([...v].map(Number).filter(d => d >= 0 && d < 7)); },
    def: "01234",
  },
  over: { get: () => wrapState.range, set: v => { wrapState.range = +v; }, def: 365 },
  back: { get: () => turnoverBack, set: v => { turnoverBack = +v; }, def: 30 },
  // The day view defaults to the last logged day, so only a date the reader
  // actually navigated to is worth putting in the URL.
  date: {
    get: () => {
      const p = $("#dayPick");
      return p && p.value !== p.max ? p.value : "";
    },
    set: v => { pendingDate = v; },
    def: "",
  },
  q: { get: () => browseQ, set: v => { browseQ = v.toLowerCase(); }, def: "" },
  status: { get: () => browseStatus, set: v => { browseStatus = v; }, def: "all" },
  sort: {
    get: () => `${browseMode === "artists" ? "a" : "s"}:${browseSort}:${browseDesc ? "d" : "a"}`,
    set: v => {
      const [mode, key, dir] = v.split(":");
      browseMode = mode === "a" ? "artists" : "songs";
      if (key) browseSort = key;
      browseDesc = dir !== "a";
    },
    def: "s:n:d",
  },
};
let pendingDate = null;      // a ?date= seen at boot, applied once the day view exists
let restoring = false;       // suppresses URL writes while applying an incoming URL

function readURL() {
  const p = new URLSearchParams(location.search);
  restoring = true;
  for (const [key, slot] of Object.entries(URLSTATE)) {
    const v = p.get(key);
    if (v != null && v !== "") { try { slot.set(v); } catch { /* ignore junk */ } }
  }
  restoring = false;
}
function writeURL() {
  if (restoring) return;
  const p = new URLSearchParams();
  for (const [key, slot] of Object.entries(URLSTATE)) {
    const v = slot.get();
    if (v != null && v !== "" && String(v) !== String(slot.def)) p.set(key, v);
  }
  const qs = p.toString();
  history.replaceState(null, "", (qs ? "?" + qs : location.pathname) + location.hash);
}

// ---------- boot ----------
(async function boot() {
  const [meta, songs, plays] = await Promise.all(
    ["data/meta.json", "data/songs.json", "data/plays.json"].map(u => fetch(u).then(r => r.json()))
  );
  META = meta; SONGS = songs;
  N = plays.dt.length;
  T = new Float64Array(N);
  SID = new Uint32Array(plays.s);
  let m = plays.t0;
  for (let i = 0; i < N; i++) { m += plays.dt[i]; T[i] = m * 60000; }

  LHOUR = new Uint8Array(N); LDOW = new Uint8Array(N); LDAY = new Int32Array(N);
  LSLOT = new Uint8Array(N);
  for (let i = 0; i < N; i++) {
    const d = new Date(T[i]);
    LHOUR[i] = d.getHours();
    LSLOT[i] = d.getHours() * 2 + (d.getMinutes() >= 30 ? 1 : 0);
    LDOW[i] = (d.getDay() + 6) % 7; // Mon=0
    LDAY[i] = Math.round((new Date(d.getFullYear(), d.getMonth(), d.getDate())).getTime() / DAY_MS);
  }
  SONGS.forEach(([artist, , , total], id) => {
    let a = ARTISTS.get(artist);
    if (!a) ARTISTS.set(artist, a = { ids: [], total: 0 });
    a.ids.push(id);
    a.total += total;
  });
  ARTIST_RANK = [...ARTISTS.entries()].sort((a, b) => b[1].total - a[1].total).map(e => e[0]);
  ARTIST_RANK.forEach((name, i) => { ARTISTS.get(name).rank = i + 1; });

  computeSongStats();
  readURL();          // before anything renders, so the page comes up shared-state

  renderStatLine();
  renderFindings();
  renderRecent();
  initRangeFilters();
  renderTopSection();
  renderDaily();
  initWrapped();
  initDayView();
  renderRotation();
  renderRecurrence();
  initTurnover();
  renderSilence();
  renderRecords();
  initBrowse();
  renderDataSection();
  renderFooter();
  writeURL();
  document.addEventListener("click", onGlobalClick);
  window.addEventListener("hashchange", route);
  route();
})();

// ---------- helpers ----------
function firstIdxAtOrAfter(ms) {
  let lo = 0, hi = N;
  while (lo < hi) { const mid = (lo + hi) >> 1; (T[mid] < ms) ? lo = mid + 1 : hi = mid; }
  return lo;
}
function rangeStartIdx(days) {
  return days ? firstIdxAtOrAfter(T[N - 1] - days * DAY_MS) : 0;
}
function coverNode(art, label, cls) {
  if (art) {
    const img = el("img", "cover" + (cls ? " " + cls : ""));
    img.src = "artwork/" + art;
    img.alt = "";
    img.loading = "lazy";
    img.addEventListener("error", () => {
      img.replaceWith(el("div", "cover ph" + (cls ? " " + cls : ""), (label || "?").slice(0, 1).toUpperCase()));
    }, { once: true });
    return img;
  }
  return el("div", "cover ph" + (cls ? " " + cls : ""), (label || "?").slice(0, 1).toUpperCase());
}
// ---------- YouTube ----------
// songs.json carries a video id per song, resolved offline by
// scripts/fetch_youtube.py and correctable by hand in youtube/links.tsv. Songs
// that matched nothing fall back to a search URL: still one click from the
// right video, and it can't rot the way a stored id can.
function ytHref(sid) {
  const [artist, song, , , vid] = SONGS[sid];
  return vid
    ? `https://www.youtube.com/watch?v=${vid}`
    : `https://www.youtube.com/results?search_query=${encodeURIComponent(artist + " " + song)}`;
}
function ytAnchor(cls) {
  const a = el("a", cls);
  a.target = "_blank";
  // Without noopener the opened tab gets a handle back to this one.
  a.rel = "noopener noreferrer";
  return a;
}
function playGlyph() {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", "M8 5.5v13l11-6.5z");
  path.setAttribute("fill", "currentColor");
  svg.append(path);
  return svg;
}
// The button under the title: the page's one outbound action.
function ytButton(sid) {
  const [artist, song, , , vid] = SONGS[sid];
  const a = ytAnchor("ytbtn" + (vid ? "" : " guess"));
  a.href = ytHref(sid);
  a.append(playGlyph(), el("span", null, vid ? "Play on YouTube" : "Find it on YouTube"));
  a.title = vid
    ? `Opens “${song}” by ${artist} on YouTube in a new tab`
    : `No video was matched to this title — opens a YouTube search in a new tab`;
  return a;
}
// The cover art doubles as the play control, but only when there is a real
// video behind it. Making a search look like a play button would promise
// something the link can't keep.
function coverPlay(sid, art, label, cls) {
  const cover = coverNode(art, label, cls);
  if (!SONGS[sid][4]) return cover;
  const wrap = ytAnchor("coverplay");
  wrap.href = ytHref(sid);
  wrap.setAttribute("aria-label", `Play “${SONGS[sid][1]}” on YouTube`);
  const badge = el("span", "playbadge");
  badge.append(playGlyph());
  wrap.append(cover, badge);
  return wrap;
}
function rampColors() {
  const cs = getComputedStyle(document.documentElement);
  // Light-to-saturated in both themes: "more" is always more blue, never whiter.
  return ["--seq-100", "--seq-200", "--seq-300", "--seq-400", "--seq-500", "--seq-600", "--seq-700"]
    .map(v => cs.getPropertyValue(v).trim());
}

// ---------- per-song stats ----------
// Windows are measured back from the last logged play, not from wall-clock
// now, so a stale build reports "this week" against the week it actually has.
function computeSongStats() {
  const M = SONGS.length;
  S_FIRST = new Float64Array(M);
  S_LAST = new Float64Array(M);
  S_N7 = new Int32Array(M); S_N30 = new Int32Array(M); S_N90 = new Int32Array(M);
  S_NWIN = new Int32Array(M); S_NPREV = new Int32Array(M);
  PREV_SAME = new Int32Array(N).fill(-1);

  const win = META.rotation.window_days;
  const end = T[N - 1];
  const c7 = end - 7 * DAY_MS, c30 = end - 30 * DAY_MS, c90 = end - 90 * DAY_MS;
  const cWin = end - win * DAY_MS, cPrev = end - 2 * win * DAY_MS;
  const lastIdx = new Int32Array(M).fill(-1);

  for (let i = 0; i < N; i++) {
    const s = SID[i], t = T[i];
    if (lastIdx[s] < 0) S_FIRST[s] = t; else PREV_SAME[i] = lastIdx[s];
    lastIdx[s] = i;
    S_LAST[s] = t;
    if (t >= c90) S_N90[s]++;
    if (t >= c30) S_N30[s]++;
    if (t >= c7) S_N7[s]++;
    if (t >= cWin) S_NWIN[s]++;
    else if (t >= cPrev) S_NPREV[s]++;
  }
}

// The same thresholds build.py uses for the rotation pool, so a song's badge
// can never disagree with the tier it appears under.
const STATUSES = [
  ["in", "In rotation", "at least 3 plays in the last four weeks"],
  ["fading", "Just dropped", "was in rotation last month, isn't now"],
  ["recurrent", "Recurrent", "still turns up, but below rotation pace"],
  ["dormant", "Dormant", "nothing in 90 days"],
];
function statusOf(sid) {
  const min = META.rotation.min_plays;
  if (S_NWIN[sid] >= min) return "in";
  if (S_NPREV[sid] >= min) return "fading";
  return S_N90[sid] > 0 ? "recurrent" : "dormant";
}
const statusLabel = k => STATUSES.find(s => s[0] === k)[1];

// ---------- headline stats + findings ----------
function renderStatLine() {
  const since = new Intl.DateTimeFormat(undefined, { month: "long", year: "numeric" })
    .format(new Date(META.first_day + "T12:00:00"));
  $("#statLine").textContent =
    `${fmtInt(META.total_plays)} plays · ${fmtInt(META.n_songs)} songs · ` +
    `${fmtInt(META.n_artists)} artists · tracking since ${since}`;
  $("#updatedLine").textContent =
    `${META.first_day} → ${META.last_day} · rebuilt ${dateFmt.format(new Date(META.generated_at))}`;
}

// The point of the strip: give someone a reason to keep scrolling to the
// reverse-engineering section, which is the part of this that doesn't exist
// anywhere else. Each item is a link to the analysis it came from.
function renderFindings() {
  const rot = META.rotation, dn = rot.daynight;
  const locked = (dn.n_night + dn.n_day) / Math.max(1, dn.n_tested);
  const lastMonth = META.trends[META.trends.length - 2] || META.trends[META.trends.length - 1];
  const items = [
    [fmtInt(rot.pool_size), "songs in rotation right now", "#rotationSection"],
    [`+${rot.n_entered} / −${rot.n_left}`,
     `swapped in and out in ${rot.window_days} days`, "#enteredList"],
    [pct(locked), "of songs are day-only or night-only", "#dnSub"],
    [pct(lastMonth[3]), "of airtime came from 50 songs last month", "#tierRows"],
  ];
  const rec = META.recurrence;
  if (rec && rec.p1)
    items.splice(2, 0, [`${Math.round(rec.p1 / 60)} hours`,
      "is the shortest the station will wait before playing a song again, its one hard rule",
      "#recurWrap"]);
  const sil = META.silence;
  if (sil && sil.shows) {
    const m = sil.shows.match;
    items.push([pct(m.show_hours_off / m.show_hours_total),
      "of the station's live-show hours carry no music in the log, and the grid lines up " +
      "with its published schedule", "#silenceWrap"]);
  }
  const wrap = $("#findings");
  wrap.replaceChildren();
  for (const [value, label, href] of items) {
    const a = el("a", "finding");
    a.href = href;
    a.append(el("span", "fv", value), el("span", "fl", label));
    wrap.append(a);
  }
}

// ---------- recently played ----------
// A plain recently-played list is the one thing this dataset makes ordinary.
// The repeat count is what a listener actually wonders — "didn't I just hear
// this?" — and it's the cheapest way in to the rest of the analysis.
function renderRecent() {
  const strip = $("#recentStrip");
  for (let i = N - 1; i >= Math.max(0, N - 100); i--) {
    const sid = SID[i];
    const [artist, song, art] = SONGS[sid];
    const b = el("button", "play-tile");
    b.dataset.sid = sid;
    b.append(coverNode(art, song));
    b.append(el("div", "t1", song), el("div", "t2", artist), el("div", "t3", agoLabel(T[i])));

    const n7 = S_N7[sid];
    b.append(el("div", "t4", n7 > 1 ? `${n7}× this week` : "once this week"));
    const prev = PREV_SAME[i];
    b.title = prev >= 0
      ? `${song} by ${artist}\nPreviously played ${fmtDur(T[i] - T[prev])} earlier · ` +
        `${n7} time${n7 === 1 ? "" : "s"} in the last 7 days`
      : `${song} by ${artist}\nFirst time in the log`;
    strip.append(b);
  }
}
function agoLabel(ms) {
  const mins = Math.round((Date.now() - ms) / 60000);
  if (mins < 60) return `${mins}m ago`;
  if (mins < 36 * 60) return `${Math.round(mins / 60)}h ago`;
  return dateFmt.format(new Date(ms));
}

// ---------- top lists + heatmap (scoped by range chips) ----------
// Marks the chip matching the current value and clears the rest. Called on
// every click and once at boot, so a restored URL lights up the right chip.
function syncChips(root, attr, value) {
  for (const c of root.querySelectorAll(".chip"))
    c.setAttribute("aria-pressed", String(c.dataset[attr] === String(value)));
}
function initRangeFilters() {
  syncChips($("#rangeFilters"), "days", rangeDays);
  $("#rangeFilters").addEventListener("click", e => {
    const btn = e.target.closest(".chip"); if (!btn) return;
    rangeDays = +btn.dataset.days;
    syncChips($("#rangeFilters"), "days", rangeDays);
    topLimit = 15;
    renderTopSection();
    writeURL();
  });
  for (const btn of [$("#moreSongs"), $("#moreArtists")])
    btn.addEventListener("click", () => { topLimit += 50; renderTopSection(); });
}
function renderTopSection() {
  const start = rangeStartIdx(rangeDays);
  const counts = new Map();
  for (let i = start; i < N; i++) counts.set(SID[i], (counts.get(SID[i]) || 0) + 1);

  const songRows = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  renderRankList($("#topSongs"), songRows.slice(0, topLimit).map(([sid, n]) => ({
    sid, n, t1: SONGS[sid][1], t2: SONGS[sid][0], art: SONGS[sid][2],
  })));

  const byArtist = new Map();
  for (const [sid, n] of counts.entries()) {
    const a = SONGS[sid][0];
    const rec = byArtist.get(a) || { n: 0, best: sid, bestN: 0 };
    rec.n += n;
    if (n > rec.bestN) { rec.best = sid; rec.bestN = n; }
    byArtist.set(a, rec);
  }
  const artistRows = [...byArtist.entries()].sort((a, b) => b[1].n - a[1].n);
  renderRankList($("#topArtists"), artistRows.slice(0, topLimit).map(([name, rec]) => {
    const k = ARTISTS.get(name).ids.length;
    return { artist: name, n: rec.n, t1: name, t2: `${fmtInt(k)} song${k > 1 ? "s" : ""}`,
             art: SONGS[rec.best][2] };
  }));

  toggleMore($("#moreSongs"), songRows.length);
  toggleMore($("#moreArtists"), artistRows.length);
}
function toggleMore(btn, total) {
  btn.hidden = topLimit >= total;
  btn.textContent = `Show ${Math.min(50, total - topLimit)} more`;
}
function renderRankList(root, rows, opts) {
  const o = opts || {};
  root.replaceChildren();
  const max = o.max != null ? o.max : (rows.length ? Math.max(...rows.map(r => r.n)) : 1);
  rows.forEach((r, i) => {
    const b = el("button", "rankrow");
    if (r.artist) b.dataset.artist = r.artist; else b.dataset.sid = r.sid;
    const meta = el("div", "meta");
    meta.append(el("div", "t1", r.t1));
    if (r.t2 !== "") meta.append(el("div", "t2", r.t2));
    const bar = el("div", "bar");
    bar.style.width = `${Math.max(2, (r.n / max) * 100)}%`;
    b.append(el("span", "rk", String(o.startRank ? o.startRank + i : i + 1)),
             coverNode(r.art, r.t1), meta,
             el("span", "n", r.nLabel != null ? r.nLabel : fmtInt(r.n)), bar);
    root.append(b);
  });
}

const hourLabel = h => h === 0 ? "12a" : h < 12 ? `${h}a` : h === 12 ? "12p" : `${h - 12}p`;
const andList = xs => xs.length < 2 ? xs.join("")
  : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`;

// ---------- daily chart ----------
function renderDaily() {
  const byDay = new Map();
  for (let i = 0; i < N; i++) byDay.set(LDAY[i], (byDay.get(LDAY[i]) || 0) + 1);
  const d0 = LDAY[0], d1 = LDAY[N - 1];
  const days = [], vals = [];
  for (let d = d0; d <= d1; d++) { days.push(d); vals.push(byDay.get(d) || 0); }

  const W = 900, H = 240, left = 42, right = 10, top = 12, bottom = 26;
  const iw = W - left - right, ih = H - top - bottom;
  const maxV = Math.ceil(Math.max(...vals) / 100) * 100;
  const x = i => left + (i / (days.length - 1)) * iw;
  const y = v => top + ih - (v / maxV) * ih;

  const svg = svgEl("svg", { viewBox: `0 0 ${W} ${H}`, class: "chart-svg", role: "img",
    "aria-label": "Plays per day over the full history" });

  // gap bands first (under everything)
  for (const [ga, gb] of META.gaps) {
    const gi = dayKeyOf(ga) - d0, gj = dayKeyOf(gb) - d0 + 1;
    if (gj < 0 || gi > days.length) continue;
    svg.append(svgEl("rect", { x: x(Math.max(0, gi)), y: top,
      width: Math.max(2, x(Math.min(days.length - 1, gj)) - x(Math.max(0, gi))),
      height: ih, fill: "var(--gap-band)" }));
  }
  for (let v = 0; v <= maxV; v += 100) {
    svg.append(svgEl("line", { x1: left, x2: W - right, y1: y(v), y2: y(v), class: v === 0 ? "axis-line" : "grid-line" }));
    if (v > 0) svg.append(svgText(left - 6, y(v) + 4, String(v), "end"));
  }
  let lastMonth = -1;
  days.forEach((d, i) => {
    const dt = dateFromKey(d);
    if (dt.getUTCDate() <= 3 && dt.getUTCMonth() !== lastMonth && dt.getUTCMonth() % 3 === 0) {
      lastMonth = dt.getUTCMonth();
      svg.append(svgText(x(i), H - 8, keyMonthFmt.format(dt), "middle"));
    }
  });

  let areaPath = `M ${x(0)} ${y(0)}`, linePath = "";
  vals.forEach((v, i) => {
    areaPath += ` L ${x(i).toFixed(1)} ${y(v).toFixed(1)}`;
    linePath += `${i ? " L" : "M"} ${x(i).toFixed(1)} ${y(v).toFixed(1)}`;
  });
  areaPath += ` L ${x(days.length - 1)} ${y(0)} Z`;
  svg.append(svgEl("path", { d: areaPath, fill: "var(--series-1-wash)" }));
  svg.append(svgEl("path", { d: linePath, fill: "none", stroke: "var(--series-1)",
    "stroke-width": 1.6, "stroke-linejoin": "round", "stroke-linecap": "round" }));

  const cross = svgEl("line", { y1: top, y2: top + ih, stroke: "var(--baseline)", "stroke-width": 1, visibility: "hidden" });
  const dot = svgEl("circle", { r: 4, fill: "var(--series-1)", stroke: "var(--surface-1)", "stroke-width": 2, visibility: "hidden" });
  svg.append(cross, dot);
  $("#dailyWrap").replaceChildren(svg);

  const wrap = $("#dailyWrap"), tip = $("#tip");
  svg.addEventListener("pointermove", ev => {
    const r = svg.getBoundingClientRect();
    const px = (ev.clientX - r.left) / r.width * W;
    const i = Math.max(0, Math.min(days.length - 1, Math.round((px - left) / iw * (days.length - 1))));
    cross.setAttribute("x1", x(i)); cross.setAttribute("x2", x(i));
    cross.setAttribute("visibility", "visible");
    dot.setAttribute("cx", x(i)); dot.setAttribute("cy", y(vals[i]));
    dot.setAttribute("visibility", "visible");
    showTip(wrap, ev, `${fmtInt(vals[i])} plays`, keyDateFmt.format(dateFromKey(days[i])));
  });
  svg.addEventListener("pointerleave", () => {
    cross.setAttribute("visibility", "hidden");
    dot.setAttribute("visibility", "hidden");
    tip.style.display = "none";
  });

  // monthly table twin
  const byMonth = new Map();
  days.forEach((d, i) => {
    const dt = dateFromKey(d);
    const k = `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, "0")}`;
    byMonth.set(k, (byMonth.get(k) || 0) + vals[i]);
  });
  const tbl = el("table", "tbl");
  const hr = el("tr"); hr.append(el("th", null, "Month"), el("th", null, "Plays")); tbl.append(hr);
  for (const [k, v] of byMonth) {
    const tr = el("tr"); tr.append(el("td", null, k), el("td", null, fmtInt(v))); tbl.append(tr);
  }
  $("#dailyTable").replaceChildren(tbl);
}
function dayKeyOf(iso) {
  const [yy, mm, dd] = iso.split("-").map(Number);
  return Math.round(new Date(yy, mm - 1, dd).getTime() / DAY_MS);
}

// ---------- personal wrapped ----------
// from/to are half-hour slots (0–47). A "to" earlier than "from" wraps past
// midnight; the post-midnight tail is attributed to the day the shift started.
const wrapState = { days: new Set([0, 1, 2, 3, 4]), from: 18, to: 34, range: 365 };
// The one definition of "your hours", shared by the song counts and the show
// hours so the two can never disagree about what the shift covers. An overnight
// range (to < from) attributes its post-midnight tail to the day the shift
// started, which is what the day chips mean.
function inShift(slot, dow) {
  const { days, from, to } = wrapState;
  if (to > from) return days.has(dow) && slot >= from && slot < to;
  if (to < from) return (slot >= from && days.has(dow)) ||
                        (slot < to && days.has((dow + 6) % 7));
  return days.has(dow);   // from == to → the whole day
}
const slotLabel = s => {
  const h = s >> 1, m = s & 1 ? "30" : "00";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${m}${h < 12 ? "a" : "p"}`;
};
function initWrapped() {
  const btns = $("#dayBtns");
  DOW_LABELS.forEach((d, i) => {
    const b = el("button", "daybtn", d.slice(0, 2));
    b.setAttribute("aria-pressed", wrapState.days.has(i));
    b.addEventListener("click", () => {
      wrapState.days.has(i) ? wrapState.days.delete(i) : wrapState.days.add(i);
      b.setAttribute("aria-pressed", wrapState.days.has(i));
      renderWrapped();
      writeURL();
    });
    btns.append(b);
  });
  const from = $("#hourFrom"), to = $("#hourTo");
  for (let s = 0; s < 48; s++) {
    from.append(new Option(slotLabel(s), s, s === wrapState.from, s === wrapState.from));
    to.append(new Option(slotLabel(s), s, s === wrapState.to, s === wrapState.to));
  }
  $("#wrapRange").value = String(wrapState.range);
  from.addEventListener("change", () => { wrapState.from = +from.value; renderWrapped(); writeURL(); });
  to.addEventListener("change", () => { wrapState.to = +to.value; renderWrapped(); writeURL(); });
  $("#wrapRange").addEventListener("change", e => {
    wrapState.range = +e.target.value; renderWrapped(); writeURL();
  });
  renderWrapped();
}
function renderWrapped() {
  const start = rangeStartIdx(wrapState.range);
  const included = i => inShift(LSLOT[i], LDOW[i]);
  const counts = new Map();
  let total = 0;
  for (let i = start; i < N; i++) {
    if (!included(i)) continue;
    counts.set(SID[i], (counts.get(SID[i]) || 0) + 1);
    total++;
  }
  const hrs = Math.round(total * 3.6 / 60); // ~3.6 min per logged song
  const sum = $("#wrapSummary");
  sum.replaceChildren();
  const mk = (v, c) => { const d = el("div"); d.append(el("div", "big", v), el("div", "cap", c)); return d; };
  sum.append(mk(fmtInt(total), "songs played at you"),
             mk(fmtInt(counts.size), "distinct songs"),
             mk(`~${fmtInt(hrs)}h`, "of Walmart Radio"));

  const top = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  renderRankList($("#wrapSongs"), top.slice(0, 10).map(([sid, n]) => ({
    sid, n, t1: SONGS[sid][1], t2: SONGS[sid][0], art: SONGS[sid][2] })));
  const byArtist = new Map();
  for (const [sid, n] of counts.entries()) {
    const a = SONGS[sid][0];
    const rec = byArtist.get(a) || { n: 0, best: sid, bestN: 0 };
    rec.n += n; if (n > rec.bestN) { rec.best = sid; rec.bestN = n; }
    byArtist.set(a, rec);
  }
  const artistTop = [...byArtist.entries()].sort((a, b) => b[1].n - a[1].n);
  renderRankList($("#wrapArtists"), artistTop.slice(0, 10)
    .map(([name, rec]) => ({ artist: name, n: rec.n, t1: name, t2: "", art: SONGS[rec.best][2] })));

  if (total) {
    const [topArtist, topRec] = artistTop[0];
    const k = ARTISTS.get(topArtist).ids.filter(id => counts.has(id)).length;
    $("#wrapLede").textContent =
      `You would have heard “${SONGS[top[0][0]][1]}” about ${fmtInt(top[0][1])} times, and ` +
      `${topArtist} ${fmtInt(topRec.n)} times across ${k} of their songs.`;
  } else {
    $("#wrapLede").textContent = "No plays logged in those hours. Try widening the range.";
  }

  renderWrapShows();
  renderWrapSkew(counts, total, start);
  renderWrapVersus(counts, total, start);
}

// Counts alone don't land — "you heard Flowers 212 times" is a number, but
// "your hours get it 2.7× more than everyone else's" is a fact about your
// shift. Same for the inverse: the hit the whole country knows that your shift
// somehow never met.
function renderWrapVersus(counts, total, start) {
  const root = $("#wrapVersus");
  root.replaceChildren();
  if (!total) return;

  const rest = new Map();
  let restTotal = 0;
  for (let i = start; i < N; i++) {
    const sid = SID[i];
    if (inShift(LSLOT[i], LDOW[i])) continue;
    rest.set(sid, (rest.get(sid) || 0) + 1);
    restTotal++;
  }
  if (!restTotal) return;

  const card = (kind, eyebrow, sid, big, note) => {
    const c = el("button", "card vs " + kind);
    c.dataset.sid = sid;
    c.append(el("div", "vseyebrow", eyebrow));
    const row = el("div", "vsrow");
    row.append(coverNode(SONGS[sid][2], SONGS[sid][1]));
    const t = el("div");
    t.append(el("div", "vstitle", SONGS[sid][1]), el("div", "vsartist", SONGS[sid][0]));
    row.append(t);
    c.append(row, el("div", "vsbig", big), el("div", "vsnote", note));
    return c;
  };

  // Theme song: biggest over-representation on your hours, with enough plays
  // behind it that the ratio isn't noise.
  let theme = null;
  for (const [sid, n] of counts) {
    if (n < 8) continue;
    const theirs = (rest.get(sid) || 0) / restTotal;
    if (theirs <= 0) continue;
    const ratio = (n / total) / theirs;
    if (!theme || ratio > theme.ratio) theme = { sid, n, ratio };
  }
  if (theme)
    root.append(card("up", "Your shift's theme song", theme.sid,
      `${theme.ratio.toFixed(1)}× more often`,
      `${fmtInt(theme.n)} plays on your hours. The rest of the week hears it a fraction ` +
      `as much, so this one is yours.`));

  // The one you escaped: heavily played overall, hardly ever on your hours.
  // Ranked on how many plays you missed, so it is a song worth having missed.
  let escaped = null;
  for (const [sid, n] of rest) {
    if (n < 30) continue;
    const mine = counts.get(sid) || 0;
    const expected = (n / restTotal) * total;
    if (mine >= expected * 0.35) continue;
    const missed = expected - mine;
    if (!escaped || missed > escaped.missed) escaped = { sid, mine, n, missed };
  }
  if (escaped)
    root.append(card("down", "The song you somehow escaped", escaped.sid,
      escaped.mine ? `only ${fmtInt(escaped.mine)} on your hours` : "never once on your hours",
      `${fmtInt(escaped.n)} plays during everyone else's. On your hours you would have ` +
      `expected about ${fmtInt(Math.round(escaped.mine + escaped.missed))}.`));

  // And the single interpretable answer to "is my Walmart different?" — how
  // much of the station's own top 100 your hours actually share.
  const topOf = (map, k) => new Set([...map.entries()]
    .sort((a, b) => b[1] - a[1]).slice(0, k).map(e => e[0]));
  const k = 100;
  const mineTop = topOf(counts, k), restTop = topOf(rest, k);
  if (mineTop.size >= 20) {
    let shared = 0;
    for (const sid of mineTop) if (restTop.has(sid)) shared++;
    const share = shared / mineTop.size;
    const d = el("div", "card vs neutral");
    d.append(el("div", "vseyebrow", "How different is your Walmart?"),
             el("div", "vsbig", pct(share)),
             el("div", "vsnote",
               `of your ${fmtInt(mineTop.size)} most-played songs are also in the top ` +
               `${fmtInt(restTop.size)} for the rest of the week. ` +
               (share > 0.8
                 ? "Mostly the same station, then. Your hours are not unusual ones."
                 : share > 0.6
                   ? "A clear majority overlaps, but a real slice of your shift is its own thing."
                   : "Less than two thirds. Your hours really are a different station.")));
    root.append(d);
  }
}

// The shows are the one part of a shift nobody has a play count for — the log
// holds no music inside their hours. Same selection as everything else in this
// section, measured in quarter-hours because a listener's slot boundaries are
// half-hours and every real timezone offset divides into 15.
let SHOW_OCC = null;
function showOccurrences() {
  if (SHOW_OCC) return SHOW_OCC;
  const sh = META.silence && META.silence.shows;
  if (!sh || !sh.dt.length) return (SHOW_OCC = []);
  const out = [];
  let t = sh.t0;
  for (let i = 0; i < sh.dt.length; i++) {
    t += sh.dt[i];
    out.push([t * 60000, sh.mins[i], sh.s[i]]);
  }
  return (SHOW_OCC = out);
}
function renderWrapShows() {
  const block = $("#wrapShowsBlock");
  const occ = showOccurrences();
  if (!occ.length) { block.hidden = true; return; }
  block.hidden = false;

  const names = META.silence.shows.names;
  const from = wrapState.range ? T[N - 1] - wrapState.range * DAY_MS : -Infinity;
  const mins = new Array(names.length).fill(0);
  const hit = ms => {
    const d = new Date(ms);
    return inShift(d.getHours() * 2 + (d.getMinutes() >= 30 ? 1 : 0), (d.getDay() + 6) % 7);
  };
  for (const [start, len, show] of occ) {
    if (start + len * 60000 <= from) continue;
    // Sample the middle of each quarter-hour: the shift boundaries are
    // half-hours and every real UTC offset is a multiple of 15 minutes, so no
    // quarter is ever split and the total is exact rather than approximate.
    for (let q = 0; q < len; q += 15)
      if (hit(start + q * 60000 + 450000)) mins[show] += 15;
  }

  const totalH = mins.reduce((a, b) => a + b, 0) / 60;
  $("#wrapShowsSub").textContent = totalH
    ? `About ${fmtInt(Math.round(totalH))} hours of live radio inside those hours. No music ` +
      `is logged during the shows, so none of it shows up in the counts above. Ended ` +
      `${META.silence.changeover}.`
    : `None. The live shows ran until ${META.silence.changeover}, outside the window ` +
      `you have picked, or outside the hours you work.`;

  const root = $("#wrapShows");
  root.replaceChildren();
  // A show your shift never once caught is as much a fact about the shift as
  // one it sat through 400 hours of, so all three always appear.
  names.forEach((name, i) => {
    const card = el("div", "showcard");
    card.style.borderLeftColor = SHOW_COLORS[i];
    card.append(el("div", "sname", name),
                el("div", "shrs", `${fmtInt(Math.round(mins[i] / 60))} hours`),
                el("div", "syrs", mins[i] ? "sat through" : "never caught it"));
    root.append(card);
  });
}

// Because dayparting is real, a given shift doesn't just hear less of the
// station — it hears a different station. This is the comparison that shows it:
// each song's share of your hours against its share of everyone else's.
function renderWrapSkew(counts, total, start) {
  const root = $("#wrapSkew");
  const rest = new Map();
  let restTotal = 0;
  for (let i = start; i < N; i++) { rest.set(SID[i], (rest.get(SID[i]) || 0) + 1); restTotal++; }

  const rows = [];
  for (const [sid, n] of counts) {
    if (n < 8) continue;   // below this, the ratio is noise dressed up as a finding
    const mine = n / total;
    const theirs = (rest.get(sid) - n) / Math.max(1, restTotal - total);
    if (theirs <= 0) continue;
    rows.push({ sid, n, ratio: mine / theirs });
  }
  rows.sort((a, b) => b.ratio - a.ratio);

  $("#wrapSkewSub").textContent = rows.length
    ? `How much more often your hours got each song than the rest of the week did. ` +
      `Anything near 1× is just the station. The top of this list is your shift.`
    : `Not enough plays in those hours to compare against the rest of the week.`;

  renderRankList(root, rows.slice(0, 8).map(r => ({
    sid: r.sid, n: r.ratio, t1: SONGS[r.sid][1],
    t2: `${SONGS[r.sid][0]} · ${fmtInt(r.n)} plays on your hours`,
    art: SONGS[r.sid][2], nLabel: `${r.ratio.toFixed(1)}×` })));
  if (!rows.length) root.replaceChildren();
}

// ---------- one day view ----------
// A silence this long is never one track running over; on this stream it is
// either the logger dropping out or a stretch of non-music programming. Either
// way it's the kind of thing you only see by reading a day in order.
const DAY_QUIET_MIN = 45 * 60000;
// "Didn't that just play?" — the threshold below which a repeat is surprising.
const QUICK_RETURN_MS = 4 * 3600000;

// Reading a day in order is where the programme grid becomes obvious, so name
// the blocks in place rather than leaving the reader with an unexplained hole.
const ctParts = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/Chicago", year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", hourCycle: "h23" });
function scheduledBreak(from, to) {
  const s = META.silence;
  if (!s || !s.blocks.length) return null;
  const at = ms => {
    const p = ctParts.formatToParts(new Date(ms));
    const g = t => p.find(x => x.type === t).value;
    return { day: `${g("year")}-${g("month")}-${g("day")}`, hour: +g("hour") };
  };
  // The gap opens with the last song logged before the break and closes with
  // the first one after, both a few minutes outside it, so the hours that are
  // actually empty are the ones half an hour inside each end.
  const a = at(from + 1800000), b = at(to - 1800000);
  if (s.changeover && a.day >= s.changeover) return null;
  const dow = (new Date(a.day + "T12:00:00").getDay() + 6) % 7;
  const hit = s.blocks.filter(x =>
    x.to > a.hour && x.from <= b.hour &&
    !(x.days === "weekdays" && dow > 4) && !(x.days === "weekends" && dow < 5));
  if (!hit.length) return null;
  // Adjacent blocks are listed separately when they differ by weekday (the
  // 6a hour runs every day, the 7a hour only Mon–Fri); on a day both apply,
  // what the listener met was one two-hour break. Non-adjacent ones mean the
  // silence swallowed a block and kept going, which is not a break.
  hit.sort((x, y) => x.from - y.from);
  if (hit.some((x, i) => i && x.from !== hit[i - 1].to)) return null;
  const lo = hit[0].from, hi = hit[hit.length - 1].to;
  // And it has to be about the right length. An outage that happens to start
  // inside a scheduled hour is still an outage.
  if (to - from > (hi - lo + 0.3) * 3600000) return null;
  const slot = `${hourLabel(lo)}–${hourLabel(hi % 24)} Central`;
  const show = (s.shows.per_show || []).find(x => x.slots.some(([f, t, days]) =>
    lo < t && hi > f && (days === "every day" || (days === "weekdays") === (dow < 5))));
  return show ? `${show.name}, ${slot}` : `the scheduled ${slot} break`;
}

function initDayView() {
  const pick = $("#dayPick");
  pick.min = isoLocal(new Date(T[0]));
  pick.max = isoLocal(new Date(T[N - 1]));
  // A ?date= from a shared link wins, as long as it is a day the log covers.
  pick.value = pendingDate && pendingDate >= pick.min && pendingDate <= pick.max
    ? pendingDate : pick.max;
  pick.addEventListener("change", () => { renderDayView(); writeURL(); });

  const step = n => {
    const iso = isoFromKey(dayKeyOf(pick.value) + n);
    if (iso < pick.min || iso > pick.max) return;
    pick.value = iso;
    renderDayView();
    writeURL();
  };
  $("#dayPrev").addEventListener("click", () => step(-1));
  $("#dayNext").addEventListener("click", () => step(1));
  $("#dayRandom").addEventListener("click", () => {
    // Pick from days that actually have plays, so "random" never lands in an
    // outage and looks broken.
    pick.value = isoFromKey(LDAY[Math.floor(Math.random() * N)]);
    renderDayView();
    writeURL();
  });
  renderDayView();
}
const isoLocal = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
// A day key is the epoch-day of a *local* calendar date, so it has to be read
// back with UTC getters — the same trap the daily chart hit. Doing this with
// local getters slips a day at negative offsets, which made Prev skip two days
// and Next do nothing at all.
const isoFromKey = k => {
  const d = dateFromKey(k);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-` +
         `${String(d.getUTCDate()).padStart(2, "0")}`;
};

function renderDayView() {
  const pick = $("#dayPick");
  const key = dayKeyOf(pick.value);
  const list = $("#dayList");
  list.replaceChildren();
  $("#dayPrev").disabled = isoFromKey(key - 1) < pick.min;
  $("#dayNext").disabled = isoFromKey(key + 1) > pick.max;

  const idx = [];
  for (let i = firstIdxAtOrAfter(key * DAY_MS - 14 * 3600000); i < N; i++) {
    if (LDAY[i] > key) break;
    if (LDAY[i] === key) idx.push(i);
  }
  if (!idx.length) {
    $("#daySummary").replaceChildren();
    list.append(el("p", "sub", "No plays recorded on this date. Likely a logger gap."));
    return;
  }

  const seen = new Map(), artistSeen = new Map();
  let repeats = 0, quiet = 0, quickest = null, debuts = 0, returns = 0;
  // Long enough that the song had genuinely gone away, rather than merely not
  // fitting into the last few days.
  const COMEBACK_DAYS = 60;

  idx.forEach((i, pos) => {
    const sid = SID[i], [artist, song, art] = SONGS[sid];

    if (pos) {
      const prev = T[idx[pos - 1]], gap = T[i] - prev;
      if (gap >= DAY_QUIET_MIN) {
        quiet++;
        const sched = scheduledBreak(prev, T[i]);
        list.append(el("div", "daygap", `${fmtDur(gap)} with nothing logged`
          + (sched ? ` (${sched})` : "")));
      }
    }

    const row = el("button", "dayrow");
    row.dataset.sid = sid;
    const meta = el("div", "meta");
    meta.append(el("span", null, song + " "), el("span", "a", "· " + artist));

    const prevPlay = seen.get(sid);
    if (prevPlay != null) {
      repeats++;
      const back = T[i] - prevPlay;
      if (quickest == null || back < quickest) quickest = back;
      const tag = el("span", "flag" + (back < QUICK_RETURN_MS ? " hot" : ""),
                     `again after ${fmtDur(back)}`);
      meta.append(tag);
    } else if (S_FIRST[sid] === T[i]) {
      // The first time this song ever appears in the log. Reading a day in
      // order is the only place you meet one of these as it happens.
      debuts++;
      meta.append(el("span", "flag new", "★ first time ever"));
    } else if (PREV_SAME[i] >= 0 && T[i] - T[PREV_SAME[i]] >= COMEBACK_DAYS * DAY_MS
               && !overlapsOutage(T[PREV_SAME[i]], T[i])) {
      // A genuine comeback, not us having missed the intervening plays.
      returns++;
      meta.append(el("span", "flag back",
        `↩ back after ${Math.round((T[i] - T[PREV_SAME[i]]) / DAY_MS)} days away`));
    } else if (artistSeen.has(artist)) {
      meta.append(el("span", "flag dim", `${artistSeen.get(artist) + 1}${nth(artistSeen.get(artist) + 1)} from ${artist}`));
    }
    seen.set(sid, T[i]);
    artistSeen.set(artist, (artistSeen.get(artist) || 0) + 1);

    row.append(el("time", null, timeFmt.format(new Date(T[i]))), coverNode(art, song), meta);
    list.append(row);
  });

  const bits = [
    `${fmtInt(idx.length)} plays`,
    `${fmtInt(seen.size)} distinct songs`,
    repeats ? `${fmtInt(repeats)} repeats` : "no repeats",
  ];
  if (quickest != null) bits.push(`quickest return ${fmtDur(quickest)}`);
  if (debuts) bits.push(`${fmtInt(debuts)} heard for the first time`);
  if (returns) bits.push(`${fmtInt(returns)} back from months away`);
  if (quiet) bits.push(`${quiet} silent stretch${quiet === 1 ? "" : "es"}`);
  $("#daySummary").replaceChildren(el("p", "sub", bits.join(" · ")));
}
const nth = n => n % 10 === 1 && n % 100 !== 11 ? "st"
              : n % 10 === 2 && n % 100 !== 12 ? "nd"
              : n % 10 === 3 && n % 100 !== 13 ? "rd" : "th";

// ---------- rotation ----------
function renderRotation() {
  const rot = META.rotation, dn = rot.daynight;

  $("#rotPlayCount").textContent = fmtInt(META.total_plays);
  $("#rotationSub").textContent =
    `Over the last ${rot.window_days} days the stream played ${fmtInt(rot.window_plays)} songs drawn ` +
    `from ${fmtInt(rot.distinct_songs)} distinct titles. How often each one came round:`;

  const rows = $("#tierRows");
  rows.replaceChildren();
  const maxPlays = Math.max(...rot.tiers.map(t => t.plays));
  for (const tier of rot.tiers) {
    if (!tier.songs) continue;
    const row = el("details", "tier");
    const sum = el("summary");
    sum.append(el("span", "tname", tier.label),
               el("span", "tblurb", tier.blurb),
               el("span", "tsongs", `${fmtInt(tier.songs)} songs`),
               el("span", "tshare", `${pct(tier.plays / rot.window_plays)} of airtime`));
    const bar = el("div", "tbar");
    bar.style.width = `${(tier.plays / maxPlays) * 100}%`;
    sum.append(bar);
    row.append(sum);
    const list = el("div", "ranklist");
    renderRankList(list, tier.top.map(([sid, n]) => ({
      sid, n, t1: SONGS[sid][1], t2: SONGS[sid][0], art: SONGS[sid][2],
      nLabel: `${n}×` })));
    row.append(list);
    rows.append(row);
  }
  $("#rotationNote").textContent =
    `Nothing here is announced. It is inferred from play counts. A song crossing from ` +
    `“Occasional” to “Regular” is the station adding it to rotation, and the reverse is it being retired.`;

  methodology($("#methRotation"), [
    ["What counts as “in rotation”",
     `A song is in the rotation pool if it was played at least ${rot.min_plays} times in the ` +
     `trailing ${rot.window_days} days. That's it. No smoothing, no decay, no manual list. ` +
     `${rot.window_days} days is long enough that a genuinely light-rotation track still ` +
     `clears the bar, and short enough to react when the station changes its mind.`],
    ["Where the tier boundaries come from",
     `Tiers are cuts on the same play count, chosen so each one describes a listening ` +
     `experience rather than a statistic: ${rot.tiers.map(t => `${t.label} is ${t.blurb}`).join(", ")}. ` +
     `A track sitting on a boundary will flip between tiers between refreshes.`],
    ["What “just added” and “dropped” mean",
     `The same ${rot.min_plays}-play test is applied to the previous ${rot.window_days}-day ` +
     `window and the two pools are compared. Applying it symmetrically matters: a one-sided ` +
     `test would count every song whose count merely wobbled across the threshold. ` +
     `“Just added” is not the same as new. A catalogue track returning after a year away ` +
     `enters the pool exactly like a current single does.`],
    ["What this can't tell you",
     `Nothing here uses show names, the published schedule, or any Walmart-supplied ` +
     `metadata, because none of it can be verified against the log. These are observed ` +
     `play frequencies, and “rotation” is the most economical explanation for them, ` +
     `not a document anyone published.`],
  ]);

  // just added
  $("#enteredSub").textContent =
    `${fmtInt(rot.n_entered)} songs have crossed into the pool since the previous window. ` +
    `The newcomers getting the most airtime:`;
  renderRankList($("#enteredList"), rot.entered.slice(0, 12).map(([sid, n]) => ({
    sid, n, t1: SONGS[sid][1], t2: SONGS[sid][0], art: SONGS[sid][2], nLabel: `${n}×` })));

  renderDropped();

  // day / night
  $("#dnSub").textContent =
    `${pct(dn.baseline)} of all plays land between 11pm and 6am Central. If one playlist ran ` +
    `around the clock, almost every song would sit near that mark. Instead, of the ` +
    `${fmtInt(dn.n_tested)} songs played at least ${dn.min_plays} times in the last ` +
    `${dn.window_days} days, ${fmtInt(dn.n_night)} skew significantly to the night and ` +
    `${fmtInt(dn.n_day)} to the day. Chance alone would produce about ${dn.expected} of each. ` +
    `The overnight pool leans dance, remix and indie. The daytime pool leans country and 80s pop.`;
  const share = r => ({ sid: r[0], n: r[2], t1: SONGS[r[0]][1],
                        t2: `${SONGS[r[0]][0]} · ${r[1]} plays`,
                        art: SONGS[r[0]][2], nLabel: pct(r[2]) });
  renderRankList($("#nightList"), dn.night_top.slice(0, 10).map(share), { max: 1 });
  renderRankList($("#dayList2"), dn.day_top.slice(0, 10).map(r =>
    ({ ...share(r), n: 1 - r[2], nLabel: pct(1 - r[2]) })), { max: 1 });
  $("#dnFoot").textContent =
    `Percentages are each song's share of plays falling in its column's hours. Songs at 0% ` +
    `overnight across 20-plus plays aren't a coincidence. They are never scheduled after dark.`;

  methodology($("#methDayNight"), [
    ["Why Central time",
     `Night is 11pm–6am on the station's own clock, not yours. Walmart Radio is programmed ` +
     `out of Bentonville and the schedule it used to publish was in Central, so a daypart ` +
     `boundary drawn in your timezone would smear across the real one. This is the only ` +
     `analysis on the page that doesn't use your local time.`],
    ["The test",
     `Each song played at least ${dn.min_plays} times in the trailing ${dn.window_days} days ` +
     `gets the share of its plays that landed at night, compared against the station-wide ` +
     `share of ${pct(dn.baseline)} with a normal-approximation z-test. Songs past ±2 are ` +
     `counted as skewed, which by construction misfires on about 2.3% of songs in each ` +
     `direction. That is where the ${dn.expected}-per-side figure comes from.`],
    ["Why this is evidence of separate pools",
     `Not the individual songs, but the spread. If one playlist ran around the clock, the ` +
     `z-scores would have a standard deviation near 1. It is ${dn.z_sd}. Something is ` +
     `partitioning the catalogue by time of day.`],
  ]);
}

// ---------- how long before you hear it again ----------
// The question a play count can't answer: is there a rotation clock, or is the
// station shuffling? The histogram answers it visually — the empty bins on the
// left are a rule, and everything to the right of them is a shrug.
function renderRecurrence() {
  const r = META.recurrence;
  if (!r || !r.n_gaps) return;
  $("#recurCard").hidden = false;

  const hrs = m => m < 1440 ? `${(m / 60).toFixed(1)} hours` : `${(m / 1440).toFixed(1)} days`;
  const shortH = m => m < 1440 ? `${Math.round(m / 60)}h` : `${(m / 1440).toFixed(1)}d`;

  $("#recurSub").textContent =
    `Every gap between one play of a song and its next, over the last ${r.window_days} days. ` +
    `That is ${fmtInt(r.n_gaps)} of them across ${fmtInt(r.n_songs)} songs. The station's one hard rule ` +
    `is on the left of this chart: almost nothing comes back inside ${shortH(r.p1)}. ` +
    `Half of all repeats wait ${hrs(r.p50)} or more.`;

  // Bar chart over the published bins. Widths are equal rather than
  // proportional to the bin: the bins get wider as the tail thins out, and a
  // true histogram would flatten the very structure this is about.
  const W = 900, H = 250, left = 46, right = 12, top = 14, bottom = 46;
  const iw = W - left - right, ih = H - top - bottom;
  const bins = r.hist;
  const maxV = Math.max(...bins.map(b => b[2]));
  const bw = iw / bins.length;
  const svg = svgEl("svg", { viewBox: `0 0 ${W} ${H}`, class: "chart-svg", role: "img",
    "aria-label": "How long the station waits before repeating a song" });

  for (let i = 0; i <= 4; i++) {
    const v = Math.round(maxV / 4 * i), y = top + ih - (v / maxV) * ih;
    svg.append(svgEl("line", { x1: left, x2: W - right, y1: y, y2: y,
      class: i === 0 ? "axis-line" : "grid-line" }));
    svg.append(svgText(left - 6, y + 4, fmtInt(v), "end"));
  }

  bins.forEach(([lo, hi, n], i) => {
    const x = left + i * bw;
    if (n) {
      const bh = Math.max(1.5, (n / maxV) * ih);
      const rect = svgEl("rect", { x: x + bw * 0.12, y: top + ih - bh,
        width: bw * 0.76, height: bh, rx: 2,
        // The bins below the floor are the finding, so they get their own
        // colour on the rare occasion anything lands in one.
        fill: hi != null && hi <= r.p1 / 60 ? "var(--series-2)" : "var(--series-1)" });
      rect.dataset.tip = JSON.stringify({
        v: `${fmtInt(n)} repeat${n === 1 ? "" : "s"} (${pct(n / r.n_gaps)})`,
        l: hi == null ? `waited more than ${lo} hours` : `waited ${lo}–${hi} hours` });
      svg.append(rect);
    } else {
      // An empty bin has to be visible, or the wall reads as the chart simply
      // starting further right.
      svg.append(svgEl("rect", { x: x + bw * 0.12, y: top + ih - 3,
        width: bw * 0.76, height: 3, rx: 1.5, fill: "var(--grid)" }));
    }
    if (i % 2 === 0)
      svg.append(svgText(x + bw / 2, H - 28, hi == null ? `${lo}h+` : `${lo}h`, "middle"));
  });

  // The floor, drawn where it actually falls between the bins.
  const floorX = (() => {
    const h = r.p1 / 60;
    const i = bins.findIndex(([lo, hi]) => hi != null && h >= lo && h < hi);
    if (i < 0) return null;
    const [lo, hi] = bins[i];
    return left + (i + (h - lo) / (hi - lo)) * bw;
  })();
  if (floorX != null) {
    svg.append(svgEl("line", { x1: floorX, x2: floorX, y1: top, y2: top + ih,
      stroke: "var(--baseline)", "stroke-width": 1.2, "stroke-dasharray": "4 3" }));
    svg.append(svgText(floorX + 5, top + 12, `${shortH(r.p1)}: nothing repeats sooner`, "start"));
  }
  svg.append(svgText(left, H - 8, "time until the same song plays again", "start"));
  $("#recurWrap").replaceChildren(svg);
  attachCellTips(svg, $("#recurWrap"));

  // The conclusion is read off the comparison rather than asserted, so the day
  // the station starts working to a clock, this paragraph changes by itself.
  const clocked = r.cv_steadier / Math.max(1, r.cv_n);
  $("#recurFoot").textContent = r.cv_obs == null ? "" :
    `Above that floor, though, there is no clock. Give each song the same number of plays ` +
    `and drop them at random through the window, allowing only the same minimum gap, and ` +
    `the made-up schedule is about as even as the real one ` +
    `(${r.cv_null.toFixed(2)} against ${r.cv_obs.toFixed(2)}, where a coin-flip process scores 1.0). ` +
    (clocked > 0.62
      ? `${pct(clocked)} of songs are steadier than their own random twin, which is more than ` +
        `chance would give, so something clock-like may be creeping in.`
      : `${pct(clocked)} of songs come out steadier than their own random twin, and chance ` +
        `alone would give about half. So this is a shuffle with a cooling-off period, not a ` +
        `rotation clock. The station picks what to play next, not when to play it again.`);

  const bandRoot = $("#recurBands");
  bandRoot.replaceChildren();
  const maxBand = Math.max(...r.bands.map(b => b.songs));
  for (const b of r.bands) {
    if (!b.songs) continue;
    const card = el("div", "bandcard");
    card.append(el("div", "bname", b.label),
                el("div", "brange", b.to_h == null ? `over ${b.from_h}h apart`
                  : b.from_h === 0 ? `under ${b.to_h}h apart`
                  : `${b.from_h}–${b.to_h}h apart`),
                el("div", "bsongs", `${fmtInt(b.songs)} songs`),
                el("div", "bblurb", b.blurb));
    const bar = el("div", "bbar");
    bar.style.width = `${(b.songs / maxBand) * 100}%`;
    card.append(bar);
    bandRoot.append(card);
  }

  const list = el("div", "ranklist");
  renderRankList(list, r.fastest.map(([sid, med, q1, q3, n]) => ({
    sid, n: 1 / med, t1: SONGS[sid][1],
    t2: `${SONGS[sid][0]} · ${n} plays · usually ${shortH(q1)}–${shortH(q3)} apart`,
    art: SONGS[sid][2], nLabel: `every ${shortH(med)}` })), { max: 1 / r.fastest[0][1] });
  $("#recurFastest").replaceChildren(list);

  methodology($("#methRecur"), [
    ["What is being measured",
     `For every song played at least ${r.min_plays} times in the last ${r.window_days} days, ` +
     `the gap between each play and the next. Not an average wait, but the whole distribution, ` +
     `because an average hides the thing worth seeing. A song played twice a day for a week ` +
     `and then dropped has the same average as one played steadily all month.`],
    ["The floor, and why it is the interesting part",
     `${pct(1 - r.under_day / r.n_gaps)} of repeats wait longer than a full day, and the bins ` +
     `below ${shortH(r.p1)} are empty rather than merely thin. A minimum separation is the ` +
     `one piece of the station's scheduling logic this data pins down directly. It relaxes ` +
     `in December, when the holiday pool gets small enough that the station has no choice.`],
    ["The test for a rotation clock",
     `Each song is compared against itself: same play count, same window, but with the plays ` +
     `dropped at random subject to the same minimum gap. The comparison is the coefficient of ` +
     `variation of the gaps, where 0 is clockwork and 1 is memoryless. Real songs score ` +
     `${r.cv_obs} and their random twins ${r.cv_null}, over ${fmtInt(r.cv_n)} songs with at least ` +
     `${r.cv_min_plays} plays. The floor is granted to the random version at its loosest ` +
     `reading, so any genuine regularity has the best chance of showing.`],
    ["What this can't tell you",
     `Nothing about *why* a song is picked. The pool is clearly weighted, and this says ` +
     `nothing about the weights. And an hour with no music is still an hour: during the years ` +
     `the live-show grid was running, roughly five hours a day carried none, which stretches ` +
     `some gaps for reasons that have nothing to do with the song.`],
  ]);
}

// ---------- how much the playlist changed ----------
// "Just added" and "dropped" are this window against the last one. This is the
// same test against a window further back, which is the question a reader
// actually has: how much of what I hear now is what I heard then?
function initTurnover() {
  syncChips($("#turnoverFilters"), "back", turnoverBack);
  $("#turnoverFilters").addEventListener("click", e => {
    const btn = e.target.closest(".chip"); if (!btn) return;
    turnoverBack = +btn.dataset.back;
    syncChips($("#turnoverFilters"), "back", turnoverBack);
    renderTurnover();
    writeURL();
  });
  renderTurnover();
}
// The pool as it stood `endMs` — the same rule build.py uses, so a pool
// computed here and one computed there always mean the same thing.
function poolAt(endMs) {
  const win = META.rotation.window_days * DAY_MS;
  const min = META.rotation.min_plays;
  const counts = new Map();
  // Half-open on the same side build.py's `ts_utc >= cutoff` is, or the
  // current-pool figure here comes out one short of the one in the card above.
  for (let i = firstIdxAtOrAfter(endMs - 1 - win); i < N && T[i] < endMs; i++)
    counts.set(SID[i], (counts.get(SID[i]) || 0) + 1);
  const pool = new Set();
  for (const [sid, n] of counts) if (n >= min) pool.add(sid);
  return pool;
}
function renderTurnover() {
  const end = T[N - 1] + 1;
  const now = poolAt(end);
  const then = poolAt(end - turnoverBack * DAY_MS);
  let stayed = 0;
  for (const sid of now) if (then.has(sid)) stayed++;
  const entered = now.size - stayed, left = then.size - stayed;
  const overlap = stayed / Math.max(1, new Set([...now, ...then]).size);

  const label = turnoverBack === 365 ? "a year ago" : `${turnoverBack} days ago`;
  $("#turnoverSub").textContent =
    `The rotation pool as it stands against the pool ${label}, using the same ` +
    `${META.rotation.min_plays}-plays-in-${META.rotation.window_days}-days test at ` +
    `both dates. How often does Walmart actually change its playlist?`;

  const root = $("#turnoverStats");
  root.replaceChildren();
  const total = Math.max(1, entered + left + stayed);
  for (const [cls, sign, v, l] of [
    ["in", "+", entered, `entered rotation since ${label}`],
    ["out", "−", left, `left rotation since ${label}`],
    ["same", "", stayed, "were in the pool then and still are"],
  ]) {
    const d = el("div", "tocell " + cls);
    d.append(el("div", "tov", sign + fmtInt(v)), el("div", "tol", l));
    const bar = el("div", "tobar");
    bar.style.width = `${(v / total) * 100}%`;
    d.append(bar);
    root.append(d);
  }

  // Whether the pool *grew* or merely churned is the whole reading of these
  // numbers, and it changes with the window — over a month the pool is flat
  // and this is pure swapping; over a year it is visibly bigger. Say whichever
  // is true rather than asserting the short-window answer at every setting.
  const growth = (now.size - then.size) / Math.max(1, then.size);
  $("#turnoverFoot").textContent =
    `${pct(overlap)} of the two pools is shared. The pool itself went from ` +
    `${fmtInt(then.size)} songs to ${fmtInt(now.size)}, ` +
    (Math.abs(growth) < 0.05
      ? `essentially flat, so this is the station swapping tracks, not stocking up.`
      : growth > 0
        ? `which is ${pct(growth)} bigger, so it is both widening the pool and cycling through it.`
        : `which is ${pct(-growth)} smaller, so it is tightening the pool as well as cycling it.`);
}

// ---------- the live shows and their daily grid ----------
// Three live shows held fixed Central-time slots, seven days a week, until the
// grid was dropped. The slots below are the station's own published schedule;
// the grid charts how much music the log holds in each hour against them. No
// music is logged inside the show hours, so the chart reads as the schedule.
function renderSilence() {
  const s = META.silence;
  if (!s || !s.before) return;
  $("#silenceCard").hidden = false;

  const b = s.before, a = s.after, sh = s.shows, m = sh.match;
  // Grouped by which days they apply to, because "6a–7a, 7a–8a weekdays" is a
  // list of rows, not a description of a schedule.
  const byDays = new Map();
  for (const x of s.blocks) {
    const label = x.to - x.from === 1
      ? hourLabel(x.from) : `${hourLabel(x.from)}–${hourLabel(x.to % 24)}`;
    byDays.set(x.days, (byDays.get(x.days) || []).concat(label));
  }
  const blockText = [...byDays].map(([days, hrs]) =>
    `the ${andList(hrs)} hour${hrs.length > 1 ? "s" : ""} ` +
    `${days === "every day" ? days : "on " + days}`).join(", plus ");
  $("#silenceSub").textContent =
    `For ${fmtInt(b.days)} days the station ran three live shows on a fixed daily grid, ` +
    `${andList(sh.names)}, taking about ${b.silent_hours_per_day} hours out of every 24: ` +
    `${blockText}, on Central time. The slots come from the station's own published ` +
    `schedule, down to the morning show running two hours on weekdays and one at ` +
    `weekends. The grid below shows them against the music log.`;

  const cw = 30, ch = 22, left = 34, top = 18, gap = 40;
  const rows = a ? 8 : 7;
  const W = left + 24 * cw + 6;
  const H = top + 7 * ch + (a ? gap + ch : 0) + 8;
  const svg = svgEl("svg", { viewBox: `0 0 ${W} ${H}`, class: "chart-svg", role: "img",
    "aria-label": "Hours of the day with nothing logged, by weekday, on Central time" });
  for (let h = 0; h < 24; h += 3)
    svg.append(svgText(left + h * cw + cw / 2, 12, hourLabel(h), "middle"));

  // Silence is drawn as ink over an empty-day base, so "loud" reads as blank
  // and the schedule reads as the marks — the opposite of the play heatmap,
  // which is the point. Each block is inked in its show's colour, so the match
  // is legible in the chart and not only in the sentence above it.
  const cell = (x, y, share, fill, tip) => {
    svg.append(svgEl("rect", { x: x + 1, y: y + 1, width: cw - 2, height: ch - 2,
      rx: 3, fill: "var(--cal-empty)" }));
    const r = svgEl("rect", { x: x + 1, y: y + 1, width: cw - 2, height: ch - 2,
      rx: 3, fill, opacity: share.toFixed(3) });
    r.dataset.tip = JSON.stringify(tip);
    svg.append(r);
  };

  // (weekday, hour) -> show index, from the published slots.
  const showAt = new Map();
  sh.per_show.forEach((x, i) => {
    for (const [from, to, days] of x.slots)
      for (let h = from; h < to; h++)
        for (let d = 0; d < 7; d++)
          if (days === "every day" || (days === "weekdays") === (d < 5)) showAt.set(d * 24 + h, i);
  });

  for (let d = 0; d < 7; d++) {
    const y = top + d * ch;
    svg.append(svgText(left - 6, y + ch / 2 + 4, DOW_LABELS[d], "end"));
    for (let h = 0; h < 24; h++) {
      const share = b.grid[d][h] || 0, plays = b.plays[d][h];
      const si = showAt.get(d * 24 + h);
      cell(left + h * cw, y, share, si == null ? "var(--muted)" : SHOW_COLORS[si], {
        v: si == null ? `${pct(share)} with no music` : sh.names[si],
        l: `${DOW_LABELS[d]} ${hourLabel(h)}–${hourLabel((h + 1) % 24)} Central · ` +
           `no music logged on ${pct(share)} of ${fmtInt(b.days)} days · ` +
           `${plays} plays an hour on average` });
    }
  }

  if (a) {
    const y = top + 7 * ch + gap;
    svg.append(svgText(left - 6, y + ch / 2 + 4, "Now", "end"));
    svg.append(svgText(left, y - 10, `Since ${a.from}: every day, all seven`, "start"));
    for (let h = 0; h < 24; h++) {
      let sil = 0, plays = 0;
      for (let d = 0; d < 7; d++) { sil += a.grid[d][h] || 0; plays += a.plays[d][h] || 0; }
      cell(left + h * cw, y, sil / 7, "var(--muted)", {
        v: `${pct(sil / 7)} with no music`,
        l: `${hourLabel(h)}–${hourLabel((h + 1) % 24)} Central · ${(plays / 7).toFixed(1)} plays ` +
           `an hour on average, over ${fmtInt(a.days)} days since ${a.from}` });
    }
  }

  $("#silenceWrap").replaceChildren(svg);
  attachCellTips(svg, $("#silenceWrap"));

  const scale = $("#silenceScale");
  scale.replaceChildren();
  sh.names.forEach((name, i) => {
    const item = el("span", "lgi");
    const dot = el("i");
    dot.style.background = SHOW_COLORS[i];
    item.append(dot, document.createTextNode(name));
    scale.append(item);
  });
  scale.append(el("span", "lgi", "Paler = music logged on more of the days"));

  const list = $("#showList");
  list.replaceChildren();
  sh.per_show.forEach((x, i) => {
    const card = el("div", "showcard");
    card.style.borderLeftColor = SHOW_COLORS[i];
    const slots = x.slots.map(([from, to, days]) =>
      `${hourLabel(from)}–${hourLabel(to % 24)}${days === "every day" ? "" : " " + days}`);
    card.append(el("div", "sname", x.name),
                el("div", "sslot", slots.join(" · ") + " Central"),
                el("div", "shrs", `${fmtInt(x.hours)} hours`),
                el("div", "syrs", x.by_year.map(([y, n]) => `${y}: ${fmtInt(n)}h`).join(" · ")));
    list.append(card);
  });

  $("#silenceFoot").textContent = a
    ? `The grid stopped on ${s.changeover}. Since then the stream has run songs through ` +
      `all 24 hours, seven days a week, at ${fmtInt(a.plays_per_day)} plays a day against ` +
      `${fmtInt(b.plays_per_day)} before. Whether the shows ended or simply stopped being ` +
      `carried on this stream, the log cannot say. The station stopped publishing the ` +
      `schedule too.`
    : `The grid is still in force.`;

  methodology($("#methSilence"), [
    ["Where the slots come from",
     `The station's own published programming page, not from this log. It gives three live ` +
     `shows on fixed Central-time slots, including the detail that the morning show runs ` +
     `two hours on weekdays and one at weekends. The grid draws those slots in each show's ` +
     `colour.`],
    ["How the log lines up with them",
     `The music log holds no songs inside the show hours and is busy outside them: ` +
     `${fmtInt(m.show_hours_off)} of ${fmtInt(m.show_hours_total)} published show hours ` +
     `carry no music, against ${fmtInt(m.other_hours_off)} of ` +
     `${fmtInt(m.other_hours_total)} other hours. The alignment holds on the hour, across ` +
     `every daylight-saving change in the log, and keeps the weekday/weekend split.`],
    ["Not to be confused with logger downtime",
     `The ${fmtInt(META.coverage.n_outages)} real outages look nothing like this grid: they ` +
     `fall at no particular time of day, and most of them last more than a day. The two are ` +
     `counted separately throughout the site.`],
    ["Which hours and days count",
     `An hour counts as carrying no music if it logged at most two track changes, not zero, ` +
     `because a song starting just before the top of the hour still lands one row inside it. ` +
     `The split is not a close call: inside a show slot an hour logs nought to three changes ` +
     `or it logs twelve and up, with nothing in between. Days the logger missed any part of ` +
     `are dropped, along with the first and last day of the log. That leaves ` +
     `${fmtInt(b.days)} clean days before the change and ${a ? fmtInt(a.days) : 0} after.`],
    ["What it still can't tell you",
     `Nothing about what was said or played during the shows, and nothing about the music ` +
     `blocks the same schedule lists, including the 8–10a Sensory Hours, which report track ` +
     `changes exactly like any other hour and so leave no trace here at all. If stores lower ` +
     `or mute their own speakers, one shared stream looks identical either way, and this log ` +
     `cannot see it.`],
  ]);
}
const SHOW_COLORS = ["var(--series-1)", "var(--series-2)", "var(--series-3)"];

// Reusable ⓘ body: a list of question → answer pairs, so a claim on the page
// is always one click from the rule that produced it.
function methodology(root, pairs) {
  root.replaceChildren();
  for (const [q, a] of pairs) {
    root.append(el("h4", "methq", q), el("p", "metha", a));
  }
}

// ---------- dropped from rotation ----------
// The inverse of "just added", and the more revealing half: you can watch a
// track being retired, and see how hard it was working right before it was.
function renderDropped() {
  const rot = META.rotation;
  $("#droppedSub").textContent =
    `${fmtInt(rot.n_left)} songs fell below ${rot.min_plays} plays this window after clearing ` +
    `it last window. Ranked by how hard they were being played on the way out:`;

  const tbl = el("table", "tbl");
  const hr = el("tr");
  for (const [h, cls, title] of [
    ["Song", null, null],
    ["Was", "num", "Plays per day in the previous window"],
    ["Now", "num", "Plays in the current window"],
    ["Last", "num", "Most recent play"],
    ["Age", "num", "Days between its first and last play in the log"],
  ]) {
    const th = el("th", cls, h);
    if (title) th.title = title;
    hr.append(th);
  }
  tbl.append(hr);

  for (const [sid, nPrev, perDay, nNow, last, days] of rot.dropped.slice(0, 12)) {
    const tr = el("tr", "clickrow");
    tr.dataset.sid = sid;
    const t = el("td");
    t.append(el("div", "dt1", SONGS[sid][1]), el("div", "dt2", SONGS[sid][0]));
    tr.append(t,
      el("td", "num", `${perDay}/day`),
      el("td", "num", nNow ? `${nNow}×` : "—"),
      el("td", "num", shortDateFmt.format(new Date(last + "T12:00:00"))),
      el("td", "num", `${fmtInt(days)}d`));
    tbl.append(tr);
  }
  $("#droppedList").replaceChildren(tbl);
}

// ---------- records & oddities ----------
function renderRecords() {
  const wrap = $("#recordsList");
  wrap.replaceChildren();
  for (const r of META.records) {
    const card = el(r.sid != null || r.artist ? "button" : "div", "card record");
    if (r.sid != null) card.dataset.sid = r.sid;
    else if (r.artist) card.dataset.artist = r.artist;
    card.append(el("div", "rlabel", r.title),
                el("div", "rvalue", r.value),
                el("div", "rsub", r.sub));
    wrap.append(card);
  }
}

// ---------- dataset explorer ----------
// Deliberately not a BI tool: search, a status filter, and a sort on every
// column. That's enough to answer "which songs haven't played since 2024" or
// "what's still active but barely" without leaving the page.
let browseMode = "songs", browseLimit = 50, browseQ = "";
let browseStatus = "all", browseSort = "n", browseDesc = true;

const SONG_COLS = [
  ["t1", "Song", "text"],
  ["t2", "Artist", "text"],
  ["first", "First heard", "date"],
  ["last", "Last heard", "date"],
  ["n", "Plays", "num"],
  ["n30", "Last 30d", "num"],
  ["status", "Status", "status"],
];
const ARTIST_COLS = [
  ["t1", "Artist", "text"],
  ["k", "Songs", "num"],
  ["first", "First heard", "date"],
  ["last", "Last heard", "date"],
  ["n", "Plays", "num"],
  ["n30", "Last 30d", "num"],
  ["inrot", "In rotation", "num"],
];

function initBrowse() {
  $("#browseCount").textContent = `${fmtInt(META.n_songs)} songs by ${fmtInt(META.n_artists)} artists`;

  const sf = $("#statusFilters");
  for (const [key, label] of [["all", "All"], ...STATUSES.map(s => [s[0], s[1]])]) {
    const b = el("button", "chip", label);
    b.dataset.status = key;
    const help = STATUSES.find(s => s[0] === key);
    if (help) b.title = help[2];
    sf.append(b);
  }
  syncChips(sf, "status", browseStatus);
  sf.hidden = browseMode === "artists";
  $("#browseQ").value = browseQ;
  syncChips($("#browseSection .filters"), "mode", browseMode);

  sf.addEventListener("click", e => {
    const btn = e.target.closest(".chip"); if (!btn) return;
    browseStatus = btn.dataset.status;
    syncChips(sf, "status", browseStatus);
    browseLimit = 50;
    renderBrowse();
    writeURL();
  });

  $("#browseQ").addEventListener("input", e => {
    browseQ = e.target.value.trim().toLowerCase();
    browseLimit = 50;
    renderBrowse();
    writeURL();
  });
  $("#browseSection .filters").addEventListener("click", e => {
    const btn = e.target.closest("[data-mode]"); if (!btn) return;
    browseMode = btn.dataset.mode;
    syncChips(btn.parentElement, "mode", browseMode);
    browseLimit = 50;
    browseSort = "n"; browseDesc = true;
    sf.hidden = browseMode === "artists";
    renderBrowse();
    writeURL();
  });
  $("#browseMore").addEventListener("click", () => { browseLimit += 200; renderBrowse(); });
  renderBrowse();
}

function browseRows() {
  if (browseMode === "songs") {
    let rows = SONGS.map(([artist, song, art, n], sid) => ({
      sid, art, n, t1: song, t2: artist,
      first: S_FIRST[sid], last: S_LAST[sid], n30: S_N30[sid], status: statusOf(sid),
    }));
    if (browseStatus !== "all") rows = rows.filter(r => r.status === browseStatus);
    if (browseQ) rows = rows.filter(r =>
      r.t1.toLowerCase().includes(browseQ) || r.t2.toLowerCase().includes(browseQ));
    return rows;
  }
  let rows = ARTIST_RANK.map(name => {
    const a = ARTISTS.get(name);
    const best = a.ids.reduce((p, c) => SONGS[c][3] > SONGS[p][3] ? c : p, a.ids[0]);
    return {
      artist: name, t1: name, art: SONGS[best][2], n: a.total, k: a.ids.length,
      first: Math.min(...a.ids.map(i => S_FIRST[i])),
      last: Math.max(...a.ids.map(i => S_LAST[i])),
      n30: a.ids.reduce((s, i) => s + S_N30[i], 0),
      inrot: a.ids.filter(i => statusOf(i) === "in").length,
    };
  });
  if (browseQ) rows = rows.filter(r => r.t1.toLowerCase().includes(browseQ));
  return rows;
}

function renderBrowse() {
  const cols = browseMode === "songs" ? SONG_COLS : ARTIST_COLS;
  const rows = browseRows();
  const dir = browseDesc ? -1 : 1;
  rows.sort((a, b) => {
    const x = a[browseSort], y = b[browseSort];
    if (typeof x === "string") return dir * (x < y ? 1 : x > y ? -1 : 0);
    return dir * ((x || 0) - (y || 0));
  });

  const tbl = el("table", "tbl exp");
  const hr = el("tr");
  for (const [key, label, kind] of cols) {
    const th = el("th", kind === "num" ? "num sortable" : "sortable", label);
    th.dataset.sort = key;
    if (browseSort === key) {
      th.classList.add("sorted");
      th.append(el("span", "arrow", browseDesc ? " ↓" : " ↑"));
    }
    hr.append(th);
  }
  tbl.append(hr);

  for (const r of rows.slice(0, browseLimit)) {
    const tr = el("tr", "clickrow");
    if (r.sid != null) tr.dataset.sid = r.sid; else tr.dataset.artist = r.artist;
    for (const [key, , kind] of cols) {
      if (key === "t1") {
        const td = el("td", "namecell");
        td.append(coverNode(r.art, r.t1, "sm"), el("span", null, r.t1));
        tr.append(td);
      } else if (kind === "date") {
        tr.append(el("td", null, keyDateFmt.format(new Date(r[key]))));
      } else if (kind === "status") {
        const td = el("td");
        td.append(el("span", "badge s-" + r[key], statusLabel(r[key])));
        tr.append(td);
      } else {
        tr.append(el("td", kind === "num" ? "num" : null,
                     typeof r[key] === "number" ? fmtInt(r[key]) : r[key]));
      }
    }
    tbl.append(tr);
  }

  const root = $("#browseTable");
  root.replaceChildren(tbl);
  if (!rows.length) root.append(el("p", "sub", "Nothing matches that."));
  tbl.addEventListener("click", e => {
    const th = e.target.closest("[data-sort]"); if (!th) return;
    if (browseSort === th.dataset.sort) browseDesc = !browseDesc;
    else { browseSort = th.dataset.sort; browseDesc = th.dataset.sort !== "t1" && th.dataset.sort !== "t2"; }
    browseLimit = Math.max(50, browseLimit);
    renderBrowse();
    writeURL();
  });

  const btn = $("#browseMore");
  btn.hidden = browseLimit >= rows.length;
  btn.textContent = `Show ${Math.min(200, Math.max(0, rows.length - browseLimit))} more of ${fmtInt(rows.length)}`;
}

// ---------- use the data ----------
function renderDataSection() {
  const c = META.coverage;
  const mb = b => `${(b / 1048576).toFixed(1)} MB`;

  const dl = $("#downloads");
  dl.replaceChildren();
  for (const [file, label, note, bytes] of [
    ["data/plays.csv", "plays.csv", "Plain text, one header row.", c.csv_bytes],
    ["data/plays.parquet", "plays.parquet", "zstd-compressed, typed timestamps.", c.parquet_bytes],
  ]) {
    const a = el("a", "dlrow");
    a.href = file;
    a.setAttribute("download", "");
    a.append(el("span", "dlname", label),
             el("span", "dlmeta", `${mb(bytes)} · ${fmtInt(c.rows)} rows`),
             el("span", "dlnote", note));
    dl.append(a);
  }

  const stats = $("#coverageStats");
  stats.replaceChildren();
  for (const [v, l] of [
    [pct(c.uptime), "of hours logged something"],
    [fmtInt(c.span_days), "days of span"],
    [fmtInt(c.n_outages), "logger outages"],
    [`${fmtInt(c.outage_hours)}h`, "lost to outages"],
    [fmtInt(c.blank_days), "days with nothing at all"],
    [dateFmt.format(new Date(META.generated_at)), "last refreshed"],
  ]) {
    const d = el("div");
    d.append(el("div", "v", v), el("div", "l", l));
    stats.append(d);
  }

  // The honest version of the coverage number. Most of the missing time lines up
  // with the live-show grid rather than the logger failing, and saying otherwise
  // would misdescribe the dataset.
  const sil = META.silence;
  methodology($("#coverageNote"), [
    ["How coverage is measured",
     `The share of clock hours between the first and last play in which the logger recorded ` +
     `anything, whether a song or one of the markers the early metadata source emitted for a ` +
     `live show or an advert. ${fmtInt(c.covered_hours)} of ${fmtInt(c.span_hours)} hours qualify. ` +
     `Songs on their own reach ${pct(c.song_uptime)}. The ${fmtInt(c.n_events)} show and advert markers ` +
     `account for a further ${fmtInt(c.event_hours)} hours that would otherwise read as unobserved.`],
    ["Where the rest of the time went",
     `Two different things, counted separately rather than bundled into one downtime figure. ` +
     `${fmtInt(c.n_outages)} outages totalling ${fmtInt(c.outage_hours)} hours, the longest ` +
     `${fmtInt(c.longest_outage_hours)} hours, are the logger failing, with nothing at all ` +
     `recorded. The other ${fmtInt(c.n_quiet)} stretches, about ${fmtInt(c.quiet_hours)} hours, ` +
     `are the stream up but not reporting a song.`],
    ["Why the shows only show up for the first two years",
     `The early metadata source named the live shows, which is how ${fmtInt(c.n_shows)} show ` +
     `blocks and ${fmtInt(c.n_promos)} adverts are in the dataset` +
     (sil && sil.changeover ? `, and how the grid below was confirmed` : "") + `. ` +
     `On 2025-07-24 the source changed to one that reports only artist and title, so from that ` +
     `date the shows leave no trace whatever. Their hours after it are genuinely unobserved, ` +
     `not empty, which is a limit of the logger rather than a fact about the station.`],
    ["What that means for the file",
     `Play counts are lower bounds. A hole in a song's history is usually the station's ` +
     `schedule and occasionally ours, so check anything that compares two periods against ` +
     `the outage list below` +
     (sil && sil.changeover
       ? `, and bear in mind the grid lifted on ${sil.changeover}, so hours that carried no ` +
         `music for the first two years are full of it now`
       : "") + `.`],
  ]);

  const tbl = el("table", "tbl");
  const hr = el("tr");
  hr.append(el("th", null, "From"), el("th", null, "To"), el("th", null, "Days"));
  tbl.append(hr);
  for (const [a, b] of META.gaps) {
    const days = Math.round((dayKeyOf(b) - dayKeyOf(a))) + 1;
    const tr = el("tr");
    tr.append(el("td", null, a), el("td", null, b), el("td", "num", fmtInt(days)));
    tbl.append(tr);
  }
  $("#outageTable").replaceChildren(tbl);
}

// ---------- footer ----------
function renderFooter() {
  const g = META.gaps.map(([a, b]) => a === b ? a : `${a} → ${b}`);
  const s = META.silence;
  $("#footGaps").textContent =
    `Data completeness: ${g.length} recording gaps (logger downtime): ${g.join(" · ")}. ` +
    (s && s.changeover
      ? `Shorter stretches with no music are not logger downtime. Until ${s.changeover} the ` +
        `station ran a fixed daily grid of live shows. `
      : "") +
    `The weeks before Christmas skew heavily to holiday music.`;
}

// ---------- routing ----------
function onGlobalClick(e) {
  const a = e.target.closest("[data-artist]");
  if (a) { location.hash = "artist/" + encodeURIComponent(a.dataset.artist); return; }
  const s = e.target.closest("[data-sid]");
  if (s) location.hash = "song/" + s.dataset.sid;
}
function route() {
  const h = decodeURIComponent(location.hash.slice(1));
  const detail = $("#detail");
  if (h.startsWith("song/")) showDetail(songPage(+h.slice(5)));
  else if (h.startsWith("artist/")) showDetail(artistPage(h.slice(7)));
  else {
    detail.hidden = true; detail.replaceChildren();
    $("#home").hidden = false;
  }
}
function showDetail(node) {
  const detail = $("#detail");
  $("#home").hidden = true;
  detail.replaceChildren(node);
  detail.hidden = false;
  window.scrollTo(0, 0);
}
function backLink() {
  const a = el("a", "backlink", "← All the charts");
  a.href = "#";
  return a;
}

// ---------- scans ----------
let OUTAGES = null;
function overlapsOutage(a, b) {
  if (!OUTAGES) OUTAGES = META.gaps.map(([s, e]) =>
    [dayKeyOf(s) * DAY_MS, (dayKeyOf(e) + 1) * DAY_MS]);
  return OUTAGES.some(([s, e]) => a < e && b > s);
}
function scanPlays(match) {
  const times = [], byMonth = new Map(), byHour = new Array(24).fill(0),
        byDow = new Array(7).fill(0);
  for (let i = 0; i < N; i++) {
    if (!match(SID[i])) continue;
    times.push(i);
    const d = new Date(T[i]);
    const k = d.getFullYear() * 12 + d.getMonth();
    byMonth.set(k, (byMonth.get(k) || 0) + 1);
    byHour[LHOUR[i]]++;
    byDow[LDOW[i]]++;
  }
  return { times, byMonth, byHour, byDow };
}
function statRow(pairs) {
  const row = el("div", "statrow");
  for (const [v, l] of pairs) {
    if (v == null) continue;
    const d = el("div");
    d.append(el("div", "v", v), el("div", "l", l));
    row.append(d);
  }
  return row;
}

// ---------- song page ----------
function songPage(sid) {
  if (!SONGS[sid]) return el("p", "sub", "Unknown song.");
  const [artist, song, art, total] = SONGS[sid];
  const page = el("div", "page");
  page.append(backLink());

  const head = el("div", "pagehead");
  head.append(coverPlay(sid, art, song, "xl"));
  const ht = el("div");
  ht.append(el("p", "eyebrow", "Song"), el("h1", null, song));
  const link = el("button", "artistlink", artist);
  link.dataset.artist = artist;
  ht.append(link);
  const st = statusOf(sid);
  const badge = el("p", "badgeline");
  badge.append(el("span", "badge s-" + st, statusLabel(st)),
               el("span", "badgenote", STATUSES.find(s => s[0] === st)[2]));
  ht.append(badge);
  ht.append(ytButton(sid));
  head.append(ht);
  page.append(head);

  const sc = scanPlays(s => s === sid);
  const first = T[sc.times[0]], last = T[sc.times[sc.times.length - 1]];
  const spanDays = Math.max(1, (last - first) / DAY_MS);
  // Stretches that straddle logger downtime aren't the station resting the
  // song, they're us not listening — so they don't count as silence.
  const gaps = [], clean = [];
  for (let i = 1; i < sc.times.length; i++) {
    const a = T[sc.times[i - 1]], b = T[sc.times[i]];
    gaps.push(b - a);
    if (!overlapsOutage(a, b)) clean.push(b - a);
  }
  const longest = clean.length ? Math.max(...clean) : 0;
  const sorted = gaps.slice().sort((a, b) => a - b);
  const q = f => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * f))];
  const median = sorted.length ? sorted[sorted.length >> 1] : 0;
  const shortest = sorted.length ? sorted[0] : 0;
  const peakHour = sc.byHour.indexOf(Math.max(...sc.byHour));

  page.append(statRow([
    [fmtInt(total), "total plays"],
    [`#${sid + 1}`, "all-time rank"],
    [(total / spanDays * 7).toFixed(1), "plays per week"],
    [dateFmt.format(new Date(first)), "first heard"],
    [dateFmt.format(new Date(last)), "last heard"],
    [median ? fmtDur(median) : null, "typical wait between plays"],
    // The middle half of the waits. A median on its own reads as a schedule;
    // the spread is what says whether there is one.
    [sorted.length >= 8 ? `${fmtDur(q(0.25))} – ${fmtDur(q(0.75))}` : null,
     "the middle half of its waits"],
    [shortest ? fmtDur(shortest) : null, "shortest wait ever"],
    [longest ? fmtDur(longest) : null, "longest silence"],
    [`${hourLabel(peakHour)}–${hourLabel((peakHour + 1) % 24)}`, "favourite hour"],
  ]));
  page.append(windowRow(sid));
  if (sorted.length >= 12) page.append(gapCard(sorted));

  page.append(scatterCard(sc.times, "Every play, one dot",
    "Date across, time of day down. Vertical bands are days it was hammered. A " +
    "dot sitting high or low the whole way across means it only ever gets " +
    "scheduled at that time."));

  page.append(calendarCard(sc.times, "Every day it played",
    "One square per day since logging began. Solid runs are spells in rotation, " +
    "and blank runs are the song sitting out."));
  page.append(chartCard("Plays per month", monthChart(sc.byMonth),
    "Every month since logging began. Flat stretches are gaps in the log, not the station."));
  page.append(twoUp(
    chartCard("By hour of day", barChart(sc.byHour, i => hourLabel(i), 3), "Your local time."),
    chartCard("By day of week", barChart(sc.byDow, i => DOW_LABELS[i], 1), null)));

  page.append(recentPlaysCard(sc.times, `Last plays of “${song}”`));

  const sibs = ARTISTS.get(artist).ids.filter(i => i !== sid)
    .sort((a, b) => SONGS[b][3] - SONGS[a][3]);
  if (sibs.length) {
    const card = el("div", "card");
    card.append(el("h3", "cardtitle", `More from ${artist}`));
    const list = el("div", "ranklist");
    renderRankList(list, sibs.slice(0, 10).map(id => ({
      sid: id, n: SONGS[id][3], t1: SONGS[id][1], t2: "", art: SONGS[id][2] })));
    card.append(list);
    page.append(card);
  }
  document.title = `${song} by ${artist} · Recently played at Walmart`;
  return page;
}

// ---------- artist page ----------
function artistPage(name) {
  const a = ARTISTS.get(name);
  if (!a) return el("p", "sub", "Unknown artist.");
  const page = el("div", "page");
  page.append(backLink());

  const ids = a.ids.slice().sort((x, y) => SONGS[y][3] - SONGS[x][3]);
  const head = el("div", "pagehead");
  head.append(coverNode(SONGS[ids[0]][2], name, "xl"));
  const ht = el("div");
  ht.append(el("p", "eyebrow", "Artist"), el("h1", null, name));
  ht.append(el("p", "sub", `${fmtInt(a.total)} plays across ${fmtInt(ids.length)} ` +
    `song${ids.length > 1 ? "s" : ""}`));
  head.append(ht);
  page.append(head);

  const idSet = new Set(ids);
  const sc = scanPlays(s => idSet.has(s));
  const first = T[sc.times[0]], last = T[sc.times[sc.times.length - 1]];
  const spanDays = Math.max(1, (last - first) / DAY_MS);
  const peakHour = sc.byHour.indexOf(Math.max(...sc.byHour));

  page.append(statRow([
    [fmtInt(a.total), "total plays"],
    [`#${a.rank}`, "artist rank"],
    [fmtInt(ids.length), "songs in the log"],
    [`${(a.total / META.total_plays * 100).toFixed(2)}%`, "of all airtime"],
    [(a.total / spanDays * 7).toFixed(1), "plays per week"],
    [dateFmt.format(new Date(first)), "first heard"],
    [dateFmt.format(new Date(last)), "last heard"],
    [`${hourLabel(peakHour)}–${hourLabel((peakHour + 1) % 24)}`, "favourite hour"],
  ]));

  const card = el("div", "card");
  card.append(el("h3", "cardtitle", "Every song, most played first"));
  const list = el("div", "ranklist");
  renderRankList(list, ids.map(id => ({
    sid: id, n: SONGS[id][3], t1: SONGS[id][1],
    t2: `${pct(SONGS[id][3] / a.total)} of their airtime`, art: SONGS[id][2] })));
  card.append(list);
  page.append(card);

  page.append(scatterCard(sc.times, "Every play, one dot",
    `Date across, time of day down, with every ${name} play in the log.`));
  page.append(calendarCard(sc.times, "Every day they played",
    `One square per day since logging began, counting all ${fmtInt(ids.length)} ` +
    `song${ids.length > 1 ? "s" : ""}.`));
  page.append(chartCard("Plays per month", monthChart(sc.byMonth),
    `Every ${name} play, by month.`));
  page.append(twoUp(
    chartCard("By hour of day", barChart(sc.byHour, i => hourLabel(i), 3), "Your local time."),
    chartCard("By day of week", barChart(sc.byDow, i => DOW_LABELS[i], 1), null)));

  page.append(recentPlaysCard(sc.times, `Last plays from ${name}`));
  document.title = `${name} · Recently played at Walmart`;
  return page;
}

function twoUp(a, b) {
  const row = el("div", "cols2");
  row.append(a, b);
  return row;
}
// Recent-window counts. A total play count says how big a song has been; these
// say whether it is anything now.
function windowRow(sid) {
  const card = el("div", "card windows");
  card.append(el("h3", "cardtitle", "Lately"));
  const row = el("div", "statrow flat");
  for (const [v, l] of [
    [fmtInt(S_N7[sid]), "last 7 days"],
    [fmtInt(S_N30[sid]), "last 30 days"],
    [fmtInt(S_N90[sid]), "last 90 days"],
    [fmtInt(S_NWIN[sid]), `this ${META.rotation.window_days}-day window`],
    [fmtInt(S_NPREV[sid]), "the window before"],
  ]) {
    const d = el("div");
    d.append(el("div", "v", v), el("div", "l", l));
    row.append(d);
  }
  card.append(row);
  const delta = S_NWIN[sid] - S_NPREV[sid];
  card.append(el("p", "sub", delta === 0
    ? "Holding steady against the previous window."
    : `${delta > 0 ? "Up" : "Down"} ${fmtInt(Math.abs(delta))} plays against the previous window.`));
  return card;
}

// Every individual play as a dot: date across, time of day down. This is the
// one chart that shows rotation spells and dayparting at the same time — a
// song entering rotation appears as a wall of dots, and one that only ever
// plays overnight sits in a band at the bottom.
function scatterCard(times, title, note) {
  const W = 900, H = 240, left = 34, right = 10, top = 10, bottom = 24;
  const iw = W - left - right, ih = H - top - bottom;
  const d0 = LDAY[0], d1 = LDAY[N - 1];
  const x = k => left + ((k - d0) / Math.max(1, d1 - d0)) * iw;
  const y = mins => top + (mins / 1440) * ih;

  const svg = svgEl("svg", { viewBox: `0 0 ${W} ${H}`, class: "chart-svg", role: "img",
    "aria-label": `${title}: one dot per play, date across and time of day down` });

  for (const [ga, gb] of META.gaps) {
    const xa = x(dayKeyOf(ga)), xb = x(dayKeyOf(gb) + 1);
    svg.append(svgEl("rect", { x: xa, y: top, width: Math.max(1.5, xb - xa), height: ih,
      fill: "var(--gap-band)" }));
  }
  for (let h = 0; h <= 24; h += 6) {
    svg.append(svgEl("line", { x1: left, x2: W - right, y1: y(h * 60), y2: y(h * 60),
      class: h === 0 || h === 24 ? "axis-line" : "grid-line" }));
    if (h < 24) svg.append(svgText(left - 6, y(h * 60) + 10, hourLabel(h), "end"));
  }
  let lastMonth = -1;
  for (let k = d0; k <= d1; k++) {
    const dt = dateFromKey(k);
    if (dt.getUTCDate() <= 3 && dt.getUTCMonth() !== lastMonth && dt.getUTCMonth() % 3 === 0) {
      lastMonth = dt.getUTCMonth();
      svg.append(svgText(x(k), H - 7, keyMonthFmt.format(dt), "middle"));
    }
  }
  // Low opacity so overlapping dots build up: a dense spell reads darker
  // without needing a separate density chart.
  for (const i of times) {
    const d = new Date(T[i]);
    svg.append(svgEl("circle", { cx: x(LDAY[i]).toFixed(1),
      cy: y(d.getHours() * 60 + d.getMinutes()).toFixed(1),
      r: 1.7, fill: "var(--series-1)", opacity: 0.55 }));
  }
  return chartCard(title, svg, note);
}
// This song's own version of the station-wide recurrence chart: how long it
// waits before coming back. The station's floor shows up here as an empty left
// edge, and a song with a genuinely erratic rotation shows up as a long tail.
function gapCard(sorted) {
  const r = META.recurrence;
  const bins = (r && r.hist.map(b => b[0])) || [0, 4, 8, 12, 16, 20, 24, 30, 36, 48, 72, 120, 168];
  const edges = bins.concat([Infinity]);
  const counts = edges.slice(0, -1).map((lo, i) =>
    sorted.filter(g => g >= lo * 3600000 && g < edges[i + 1] * 3600000).length);

  const W = 460, H = 160, left = 30, right = 8, top = 10, bottom = 34;
  const iw = W - left - right, ih = H - top - bottom;
  const maxV = Math.max(1, ...counts);
  const bw = iw / counts.length;
  const svg = svgEl("svg", { viewBox: `0 0 ${W} ${H}`, class: "chart-svg", role: "img",
    "aria-label": "How long this song waits before playing again" });
  for (const v of [0, maxV]) {
    const y = top + ih - (v / maxV) * ih;
    svg.append(svgEl("line", { x1: left, x2: W - right, y1: y, y2: y,
      class: v === 0 ? "axis-line" : "grid-line" }));
    svg.append(svgText(left - 5, y + 4, fmtInt(v), "end"));
  }
  counts.forEach((n, i) => {
    if (n) {
      const bh = Math.max(1.5, (n / maxV) * ih);
      const rect = svgEl("rect", { x: left + i * bw + bw * 0.12, y: top + ih - bh,
        width: Math.max(1.5, bw * 0.76), height: bh, rx: 1.5, fill: "var(--series-1)" });
      rect.dataset.tip = JSON.stringify({
        v: `${fmtInt(n)} time${n === 1 ? "" : "s"}`,
        l: edges[i + 1] === Infinity ? `waited more than ${bins[i]} hours`
                                     : `waited ${bins[i]}–${edges[i + 1]} hours` });
      svg.append(rect);
    }
    if (i % 3 === 0)
      svg.append(svgText(left + i * bw + bw / 2, H - 16,
        edges[i + 1] === Infinity ? `${bins[i]}h+` : `${bins[i]}h`, "middle"));
  });
  svg.append(svgText(left, H - 4, "time until it played again", "start"));
  return chartCard("How long before it came back", svg,
    `Every gap between one play and the next, all ${fmtInt(sorted.length)} of them. ` +
    `The empty bins on the left are the station's rule against repeating a song too soon.`);
}
function recentPlaysCard(times, title) {
  const card = el("div", "card");
  card.append(el("h3", "cardtitle", title));
  const list = el("div", "playlog");
  for (const i of times.slice(-40).reverse()) {
    const row = el("div", "logrow");
    row.append(el("time", null, dtFmt.format(new Date(T[i]))));
    const [ar, sg] = SONGS[SID[i]];
    row.append(el("span", "lt", sg), el("span", "la", ar));
    list.append(row);
  }
  card.append(list);
  return card;
}
// GitHub-style calendar: one cell per day, weeks as columns, Monday on top.
// A song averages barely more than one play on the days it appears at all, so
// what this really shows is *presence* — the stretches where a track was in
// rotation, and the dormant runs between them.
let OUTAGE_DAYS = null;
function outageDays() {
  if (!OUTAGE_DAYS) {
    OUTAGE_DAYS = new Set();
    for (const [a, b] of META.gaps)
      for (let k = dayKeyOf(a); k <= dayKeyOf(b); k++) OUTAGE_DAYS.add(k);
  }
  return OUTAGE_DAYS;
}
function calendarCard(times, title, note) {
  const byDay = new Map();
  for (const i of times) byDay.set(LDAY[i], (byDay.get(LDAY[i]) || 0) + 1);
  const d0 = LDAY[0], d1 = LDAY[N - 1];
  const lead = (dateFromKey(d0).getUTCDay() + 6) % 7;   // Monday = 0
  const start = d0 - lead;
  const weeks = Math.ceil((d1 - start + 1) / 7);

  const cell = 10, step = 11.6, left = 30, top = 18;
  const W = left + weeks * step, H = top + 7 * step;
  const svg = svgEl("svg", { viewBox: `0 0 ${W} ${H}`, class: "chart-svg cal",
    role: "img", "aria-label": `${title}: one cell per day` });

  const out = outageDays();
  const ramp = rampColors();
  const levels = [ramp[2], ramp[4], ramp[6]];          // 1 play, 2, 3+
  let lastLabel = -99, maxDay = 0;

  for (let w = 0; w < weeks; w++) {
    for (let r = 0; r < 7; r++) {
      const key = start + w * 7 + r;
      if (key < d0 || key > d1) continue;
      const n = byDay.get(key) || 0;
      maxDay = Math.max(maxDay, n);
      const down = out.has(key);
      const rect = svgEl("rect", {
        x: left + w * step, y: top + r * step, width: cell, height: cell, rx: 2,
        fill: n ? levels[Math.min(2, n - 1)] : down ? "var(--cal-out)" : "var(--cal-empty)",
      });
      rect.dataset.tip = JSON.stringify({
        v: n ? `${n} play${n === 1 ? "" : "s"}` : down ? "logger down" : "not played",
        l: keyDayFmt.format(dateFromKey(key)),
      });
      svg.append(rect);
    }
    const first = dateFromKey(start + w * 7);
    if (first.getUTCDate() <= 7 && first.getUTCMonth() % 2 === 0 && w - lastLabel >= 6) {
      lastLabel = w;
      svg.append(svgText(left + w * step, 11, keyMonthFmt.format(first), "start"));
    }
  }
  for (const r of [0, 2, 4])
    svg.append(svgText(left - 5, top + r * step + cell - 1, DOW_LABELS[r], "end"));

  const card = el("div", "card");
  card.append(el("h3", "cardtitle", title));
  if (note) card.append(el("p", "sub", note));
  const wrap = el("div", "chart-wrap");
  wrap.append(svg);
  card.append(wrap);
  attachCellTips(svg, wrap);

  const legend = el("div", "heat-scale cal-legend");
  legend.append(el("span", null, "fewer"));
  const sw = el("div", "swatches");
  for (const c of ["var(--cal-empty)", ...levels.slice(0, Math.max(1, maxDay))]) {
    const i = el("i"); i.style.background = c; sw.append(i);
  }
  legend.append(sw, el("span", null, "more plays that day"));
  const outMark = el("span", "outkey");
  const oi = el("i"); oi.style.background = "var(--cal-out)";
  outMark.append(oi, document.createTextNode("logger down"));
  legend.append(outMark);
  card.append(legend);
  return card;
}
function chartCard(title, svg, note) {
  const card = el("div", "card");
  card.append(el("h3", "cardtitle", title));
  if (note) card.append(el("p", "sub", note));
  const wrap = el("div", "chart-wrap");
  wrap.append(svg);
  card.append(wrap);
  attachCellTips(svg, wrap);
  return card;
}
function fmtDur(ms) {
  const h = ms / 3600000;
  if (h < 48) return `${h.toFixed(1)}h`;
  const d = h / 24;
  return d < 60 ? `${Math.round(d)} days` : `${(d / 30.44).toFixed(1)} months`;
}
function monthChart(byMonth) {
  const k0 = new Date(T[0]).getFullYear() * 12 + new Date(T[0]).getMonth();
  const k1 = new Date(T[N - 1]).getFullYear() * 12 + new Date(T[N - 1]).getMonth();
  const vals = [], labels = [];
  for (let k = k0; k <= k1; k++) {
    vals.push(byMonth.get(k) || 0);
    labels.push(new Date(Math.floor(k / 12), k % 12, 1));
  }
  return barChart(vals, i => monthFmt.format(labels[i]), 3, v => `${fmtInt(v)} plays`);
}
function barChart(vals, labelFor, labelEvery, tipFmt) {
  const W = 460, H = 150, left = 30, right = 6, top = 8, bottom = 22;
  const iw = W - left - right, ih = H - top - bottom;
  const maxV = Math.max(1, ...vals);
  const bw = iw / vals.length;
  const svg = svgEl("svg", { viewBox: `0 0 ${W} ${H}`, class: "chart-svg", role: "img",
    "aria-label": "Play counts" });
  const ticks = [0, Math.round(maxV / 2), maxV];
  for (const v of ticks) {
    const y = top + ih - (v / maxV) * ih;
    svg.append(svgEl("line", { x1: left, x2: W - right, y1: y, y2: y,
      class: v === 0 ? "axis-line" : "grid-line" }));
    svg.append(svgText(left - 5, y + 4, fmtInt(v), "end"));
  }
  vals.forEach((v, i) => {
    if (v) {
      const bh = Math.max(1.5, (v / maxV) * ih);
      const rect = svgEl("rect", { x: left + i * bw + bw * 0.12, y: top + ih - bh,
        width: Math.max(1.5, bw * 0.76), height: bh, rx: Math.min(2, bw / 4),
        fill: "var(--series-1)" });
      rect.dataset.tip = JSON.stringify({
        v: tipFmt ? tipFmt(v) : `${fmtInt(v)} plays`, l: labelFor(i) });
      svg.append(rect);
    }
    if (i % labelEvery === 0 && bw * labelEvery > 24)
      svg.append(svgText(left + i * bw + bw / 2, H - 7, labelFor(i), "middle"));
  });
  return svg;
}

// ---------- svg + tooltip utils ----------
function svgEl(tag, attrs) {
  const n = document.createElementNS("http://www.w3.org/2000/svg", tag);
  for (const [k, v] of Object.entries(attrs || {})) n.setAttribute(k, v);
  return n;
}
function svgText(x, y, str, anchor) {
  const t = svgEl("text", { x, y, "text-anchor": anchor || "start" });
  t.textContent = str;
  return t;
}
function showTip(wrap, ev, value, label) {
  const tip = $("#tip");
  tip.replaceChildren(el("div", "tv", value), el("div", "tl", label));
  tip.style.display = "block";
  const r = wrap.getBoundingClientRect();
  let tx = ev.clientX - r.left + 14, ty = ev.clientY - r.top - 10;
  wrap.append(tip);
  const tw = tip.offsetWidth;
  if (ev.clientX + tw + 24 > window.innerWidth) tx -= tw + 28;
  tip.style.left = tx + "px";
  tip.style.top = ty + "px";
}
function attachCellTips(svg, wrap) {
  svg.addEventListener("pointermove", ev => {
    const c = ev.target.closest("[data-tip]");
    if (!c) { $("#tip").style.display = "none"; return; }
    const d = JSON.parse(c.dataset.tip);
    showTip(wrap, ev, d.v, d.l);
  });
  svg.addEventListener("pointerleave", () => { $("#tip").style.display = "none"; });
}
