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

const timeFmt = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
const dateFmt = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" });
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

  $("#updatedLine").textContent =
    `${fmtInt(META.total_plays)} plays logged · ${META.first_day} → ${META.last_day} · updated ${dateFmt.format(new Date(META.generated_at))}`;

  renderKPIs();
  renderRecent();
  initRangeFilters();
  renderTopSection();
  renderDaily();
  initWrapped();
  initDayView();
  renderRotation();
  initBrowse();
  renderFooter();
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
function rampColors() {
  const cs = getComputedStyle(document.documentElement);
  // Light-to-saturated in both themes: "more" is always more blue, never whiter.
  return ["--seq-100", "--seq-200", "--seq-300", "--seq-400", "--seq-500", "--seq-600", "--seq-700"]
    .map(v => cs.getPropertyValue(v).trim());
}

// ---------- KPIs ----------
function renderKPIs() {
  const days = Math.round((T[N - 1] - T[0]) / DAY_MS);
  const kpis = [
    ["Songs logged", fmtInt(META.total_plays), "one row per play"],
    ["Distinct songs", fmtInt(META.n_songs), null],
    ["Distinct artists", fmtInt(META.n_artists), null],
    ["Days on record", fmtInt(days), `since ${META.first_day}`],
  ];
  const wrap = $("#kpis");
  for (const [label, value, hint] of kpis) {
    const t = el("div", "card tile");
    t.append(el("div", "label", label), el("div", "value", value));
    if (hint) t.append(el("div", "hint", hint));
    wrap.append(t);
  }
}

// ---------- recently played ----------
function renderRecent() {
  const strip = $("#recentStrip");
  for (let i = N - 1; i >= Math.max(0, N - 100); i--) {
    const [artist, song, art] = SONGS[SID[i]];
    const b = el("button", "play-tile");
    b.dataset.sid = SID[i];
    b.append(coverNode(art, song));
    b.append(el("div", "t1", song), el("div", "t2", artist), el("div", "t3", agoLabel(T[i])));
    b.title = `${song} — ${artist}`;
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
function initRangeFilters() {
  $("#rangeFilters").addEventListener("click", e => {
    const btn = e.target.closest(".chip"); if (!btn) return;
    for (const c of $("#rangeFilters").children) c.setAttribute?.("aria-pressed", "false");
    btn.setAttribute("aria-pressed", "true");
    rangeDays = +btn.dataset.days;
    topLimit = 15;
    renderTopSection();
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
  renderHeatmap(start);
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

// ---------- heatmap ----------
function renderHeatmap(start) {
  const grid = Array.from({ length: 7 }, () => new Array(24).fill(0));
  for (let i = start; i < N; i++) grid[LDOW[i]][LHOUR[i]]++;
  const max = Math.max(1, ...grid.flat());

  // Sequential ramp: more plays = more saturated blue, in both themes.
  const ramp = rampColors();
  const colorFor = v => v === 0 ? null : ramp[Math.min(6, Math.floor((v / max) * 7))];

  const cw = 30, ch = 22, left = 34, top = 18;
  const W = left + 24 * cw + 6, H = top + 7 * ch + 6;
  const svg = svgEl("svg", { viewBox: `0 0 ${W} ${H}`, class: "chart-svg", role: "img",
    "aria-label": "Plays by hour and day of week" });
  for (let h = 0; h < 24; h += 3)
    svg.append(svgText(left + h * cw + cw / 2, 12, hourLabel(h), "middle"));
  for (let d = 0; d < 7; d++) {
    svg.append(svgText(left - 6, top + d * ch + ch / 2 + 4, DOW_LABELS[d], "end"));
    for (let h = 0; h < 24; h++) {
      const v = grid[d][h];
      const rect = svgEl("rect", {
        x: left + h * cw + 1, y: top + d * ch + 1, width: cw - 2, height: ch - 2,
        rx: 3, fill: colorFor(v) || "transparent",
        stroke: v === 0 ? "var(--grid)" : "none", "stroke-width": 1,
      });
      rect.dataset.tip = JSON.stringify({ v: `${fmtInt(v)} plays`, l: `${DOW_LABELS[d]} ${hourLabel(h)}–${hourLabel((h + 1) % 24)}` });
      svg.append(rect);
    }
  }
  $("#heatWrap").replaceChildren(svg);
  attachCellTips(svg, $("#heatWrap"));

  const scale = $("#heatScale");
  scale.replaceChildren(el("span", null, "fewer plays"));
  const sw = el("div", "swatches");
  ramp.forEach(c => { const i = el("i"); i.style.background = c; sw.append(i); });
  scale.append(sw, el("span", null, "more plays"));

  const tbl = el("table", "tbl");
  const hr = el("tr"); hr.append(el("th", null, ""));
  for (let h = 0; h < 24; h += 3) hr.append(el("th", null, hourLabel(h)));
  tbl.append(hr);
  for (let d = 0; d < 7; d++) {
    const tr = el("tr"); tr.append(el("td", null, DOW_LABELS[d]));
    for (let h = 0; h < 24; h += 3)
      tr.append(el("td", null, fmtInt(grid[d].slice(h, h + 3).reduce((a, b) => a + b))));
    tbl.append(tr);
  }
  $("#heatTable").replaceChildren(tbl);
}
const hourLabel = h => h === 0 ? "12a" : h < 12 ? `${h}a` : h === 12 ? "12p" : `${h - 12}p`;

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
    });
    btns.append(b);
  });
  const from = $("#hourFrom"), to = $("#hourTo");
  for (let s = 0; s < 48; s++) {
    from.append(new Option(slotLabel(s), s, s === wrapState.from, s === wrapState.from));
    to.append(new Option(slotLabel(s), s, s === wrapState.to, s === wrapState.to));
  }
  from.addEventListener("change", () => { wrapState.from = +from.value; renderWrapped(); });
  to.addEventListener("change", () => { wrapState.to = +to.value; renderWrapped(); });
  $("#wrapRange").addEventListener("change", e => { wrapState.range = +e.target.value; renderWrapped(); });
  renderWrapped();
}
function renderWrapped() {
  const start = rangeStartIdx(wrapState.range);
  const { days, from, to } = wrapState;
  // Overnight range (to < from): the pre-midnight part counts toward the play's
  // own day, the post-midnight tail toward the previous day — so the day chips
  // mean "the day your shift starts".
  const included = to > from ? i => days.has(LDOW[i]) && LSLOT[i] >= from && LSLOT[i] < to
                 : to < from ? i => (LSLOT[i] >= from && days.has(LDOW[i])) ||
                                    (LSLOT[i] < to && days.has((LDOW[i] + 6) % 7))
                 : i => days.has(LDOW[i]); // from == to → full day
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
  renderRankList($("#wrapArtists"),
    [...byArtist.entries()].sort((a, b) => b[1].n - a[1].n).slice(0, 10)
      .map(([name, rec]) => ({ artist: name, n: rec.n, t1: name, t2: "", art: SONGS[rec.best][2] })));
}

// ---------- one day view ----------
function initDayView() {
  const pick = $("#dayPick");
  const last = new Date(T[N - 1]);
  pick.value = isoLocal(last);
  pick.min = isoLocal(new Date(T[0]));
  pick.max = pick.value;
  pick.addEventListener("change", renderDayView);
  renderDayView();
}
const isoLocal = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
function renderDayView() {
  const key = dayKeyOf($("#dayPick").value);
  const list = $("#dayList");
  list.replaceChildren();
  let found = 0;
  for (let i = 0; i < N; i++) {
    if (LDAY[i] !== key) continue;
    found++;
    const [artist, song, art] = SONGS[SID[i]];
    const row = el("button", "dayrow");
    row.dataset.sid = SID[i];
    const t = el("time", null, timeFmt.format(new Date(T[i])));
    const meta = el("div", "meta");
    meta.append(el("span", null, song + " "), el("span", "a", "· " + artist));
    row.append(t, coverNode(art, song), meta);
    list.append(row);
  }
  if (!found) list.append(el("p", "sub", "No plays recorded on this date — likely a logger gap."));
}

// ---------- rotation ----------
function renderRotation() {
  const rot = META.rotation, dn = rot.daynight;

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
    `Nothing here is announced — it's inferred from play counts. A song crossing from ` +
    `“Occasional” to “Regular” is the station adding it to rotation; the reverse is it being retired.`;

  // just added
  $("#enteredSub").textContent =
    `Counting a song as “in rotation” once it reaches ${rot.min_plays} plays in a ` +
    `${rot.window_days}-day window: ${fmtInt(rot.n_entered)} songs have entered since the previous ` +
    `window and ${fmtInt(rot.n_left)} have dropped out. The newcomers getting the most airtime:`;
  renderRankList($("#enteredList"), rot.entered.slice(0, 12).map(([sid, n]) => ({
    sid, n, t1: SONGS[sid][1], t2: SONGS[sid][0], art: SONGS[sid][2], nLabel: `${n}×` })));

  renderTrends();

  // day / night
  $("#dnSub").textContent =
    `${pct(dn.baseline)} of all plays land between 11pm and 6am Central. If one playlist ran ` +
    `around the clock, almost every song would sit near that mark. Instead, of the ` +
    `${fmtInt(dn.n_tested)} songs played at least ${dn.min_plays} times in the last ` +
    `${dn.window_days} days, ${fmtInt(dn.n_night)} skew significantly to the night and ` +
    `${fmtInt(dn.n_day)} to the day — chance alone would produce about ${dn.expected} of each. ` +
    `The overnight pool leans dance, remix and indie; the daytime pool leans country and 80s pop.`;
  const share = r => ({ sid: r[0], n: r[2], t1: SONGS[r[0]][1],
                        t2: `${SONGS[r[0]][0]} · ${r[1]} plays`,
                        art: SONGS[r[0]][2], nLabel: pct(r[2]) });
  renderRankList($("#nightList"), dn.night_top.slice(0, 10).map(share), { max: 1 });
  renderRankList($("#dayList2"), dn.day_top.slice(0, 10).map(r =>
    ({ ...share(r), n: 1 - r[2], nLabel: pct(1 - r[2]) })), { max: 1 });
  $("#dnFoot").textContent =
    `Percentages are each song's share of plays falling in its column's hours. Songs at 0% ` +
    `overnight across 20-plus plays aren't a coincidence — they're never scheduled after dark.`;
}

function renderTrends() {
  // Both measures are sensitive to how many plays a month has, so only
  // near-complete months qualify. The first survivor is then dropped too: its
  // "not heard last month" figure is measured against a stub of a month.
  const tr = META.trends.filter(t => t[1] >= 8000).slice(1);
  const W = 460, H = 190, left = 34, right = 8, top = 10, bottom = 24;
  const iw = W - left - right, ih = H - top - bottom;
  const x = i => left + (i / (tr.length - 1)) * iw;
  const y = v => top + ih - v * ih;
  const svg = svgEl("svg", { viewBox: `0 0 ${W} ${H}`, class: "chart-svg", role: "img",
    "aria-label": "Playlist concentration and freshness by month" });
  for (let v = 0; v <= 1; v += 0.25) {
    svg.append(svgEl("line", { x1: left, x2: W - right, y1: y(v), y2: y(v),
      class: v === 0 ? "axis-line" : "grid-line" }));
    svg.append(svgText(left - 6, y(v) + 4, pct(v), "end"));
  }
  tr.forEach((t, i) => {
    const dt = new Date(t[0] + "T00:00:00");
    if (dt.getMonth() % 6 !== 0) return;
    // Pin the end labels inward so they don't run off the viewBox.
    const anchor = i === 0 ? "start" : i === tr.length - 1 ? "end" : "middle";
    svg.append(svgText(x(i), H - 8, monthFmt.format(dt), anchor));
  });
  const line = (idx, stroke) => {
    let d = "";
    tr.forEach((t, i) => { d += `${i ? " L" : "M"} ${x(i).toFixed(1)} ${y(t[idx]).toFixed(1)}`; });
    svg.append(svgEl("path", { d, fill: "none", stroke, "stroke-width": 1.6,
      "stroke-linejoin": "round" }));
  };
  line(3, "var(--series-1)");
  line(4, "var(--series-2)");
  $("#trendWrap").replaceChildren(svg);

  const lg = $("#trendLegend");
  lg.replaceChildren();
  [["var(--series-1)", "Airtime from the month's top 50 songs"],
   ["var(--series-2)", "Airtime from songs not heard the month before"]].forEach(([c, label]) => {
    const item = el("span", "lgi");
    const dot = el("i"); dot.style.background = c;
    item.append(dot, document.createTextNode(label));
    lg.append(item);
  });
}

// ---------- browse ----------
let browseMode = "songs", browseLimit = 40, browseQ = "";
function initBrowse() {
  $("#browseCount").textContent = `${fmtInt(META.n_songs)} songs by ${fmtInt(META.n_artists)} artists`;
  $("#browseQ").addEventListener("input", e => {
    browseQ = e.target.value.trim().toLowerCase();
    browseLimit = 40;
    renderBrowse();
  });
  $("#browseSection .filters").addEventListener("click", e => {
    const btn = e.target.closest(".chip"); if (!btn) return;
    for (const c of btn.parentElement.querySelectorAll(".chip")) c.setAttribute("aria-pressed", "false");
    btn.setAttribute("aria-pressed", "true");
    browseMode = btn.dataset.mode;
    browseLimit = 40;
    renderBrowse();
  });
  $("#browseMore").addEventListener("click", () => { browseLimit += 100; renderBrowse(); });
  renderBrowse();
}
function renderBrowse() {
  let rows;
  if (browseMode === "songs") {
    rows = SONGS.map(([artist, song, art, n], sid) => ({ sid, n, t1: song, t2: artist, art }));
    if (browseQ) rows = rows.filter(r =>
      r.t1.toLowerCase().includes(browseQ) || r.t2.toLowerCase().includes(browseQ));
  } else {
    rows = ARTIST_RANK.map(name => {
      const a = ARTISTS.get(name);
      const best = a.ids.reduce((p, c) => SONGS[c][3] > SONGS[p][3] ? c : p, a.ids[0]);
      return { artist: name, n: a.total, t1: name,
               t2: `${fmtInt(a.ids.length)} song${a.ids.length > 1 ? "s" : ""}`,
               art: SONGS[best][2] };
    });
    if (browseQ) rows = rows.filter(r => r.t1.toLowerCase().includes(browseQ));
  }
  renderRankList($("#browseList"), rows.slice(0, browseLimit), { max: rows.length ? rows[0].n : 1 });
  if (!rows.length) $("#browseList").append(el("p", "sub", "Nothing matches that."));
  const btn = $("#browseMore");
  btn.hidden = browseLimit >= rows.length;
  btn.textContent = `Show ${Math.min(100, Math.max(0, rows.length - browseLimit))} more of ${fmtInt(rows.length)}`;
}

// ---------- footer ----------
function renderFooter() {
  const g = META.gaps.map(([a, b]) => a === b ? a : `${a} → ${b}`);
  $("#footGaps").textContent =
    `Data completeness: ${g.length} recording gaps (logger downtime): ${g.join(" · ")}. ` +
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
  head.append(coverNode(art, song, "xl"));
  const ht = el("div");
  ht.append(el("p", "eyebrow", "Song"), el("h1", null, song));
  const link = el("button", "artistlink", artist);
  link.dataset.artist = artist;
  ht.append(link);
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
  const median = gaps.length ? gaps.slice().sort((a, b) => a - b)[gaps.length >> 1] : 0;
  const peakHour = sc.byHour.indexOf(Math.max(...sc.byHour));

  page.append(statRow([
    [fmtInt(total), "total plays"],
    [`#${sid + 1}`, "all-time rank"],
    [(total / spanDays * 7).toFixed(1), "plays per week"],
    [dateFmt.format(new Date(first)), "first heard"],
    [dateFmt.format(new Date(last)), "last heard"],
    [median ? fmtDur(median) : null, "typical wait between plays"],
    [longest ? fmtDur(longest) : null, "longest silence"],
    [`${hourLabel(peakHour)}–${hourLabel((peakHour + 1) % 24)}`, "favourite hour"],
  ]));

  page.append(calendarCard(sc.times, "Every day it played",
    "One square per day since logging began. Solid runs are spells in rotation; " +
    "blank runs are the song sitting out."));
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
  document.title = `${song} — ${artist} · Recently played at Walmart`;
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
