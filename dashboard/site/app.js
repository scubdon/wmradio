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
const DAY_MS = 86400000;

// ---------- state ----------
let META, SONGS;            // meta.json, songs.json
let N;                      // play count
let T;                      // Float64Array epoch ms, ascending
let SID;                    // Uint32Array song id per play
let LHOUR, LDOW, LDAY;      // per-play local hour, local dow (Mon=0), local day key
let ARTIST_IDS = new Map(); // artist name -> [song ids]
let rangeDays = 30;         // top-section scope

const timeFmt = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
const dateFmt = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" });
const monthFmt = new Intl.DateTimeFormat(undefined, { month: "short", year: "2-digit" });
const DOW_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

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
  for (let i = 0; i < N; i++) {
    const d = new Date(T[i]);
    LHOUR[i] = d.getHours();
    LDOW[i] = (d.getDay() + 6) % 7; // Mon=0
    LDAY[i] = Math.round((new Date(d.getFullYear(), d.getMonth(), d.getDate())).getTime() / DAY_MS);
  }
  SONGS.forEach(([artist], id) => {
    if (!ARTIST_IDS.has(artist)) ARTIST_IDS.set(artist, []);
    ARTIST_IDS.get(artist).push(id);
  });

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
  renderFooter();
  document.addEventListener("click", onGlobalClick);
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
function coverNode(art, label, size) {
  if (art) {
    const img = el("img", "cover");
    img.src = "artwork/" + art;
    img.alt = "";
    img.loading = "lazy";
    img.addEventListener("error", () => {
      img.replaceWith(el("div", "cover ph", (label || "?").slice(0, 1).toUpperCase()));
    }, { once: true });
    return img;
  }
  return el("div", "cover ph", (label || "?").slice(0, 1).toUpperCase());
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
    for (const c of $("#rangeFilters").children)
      if (c.classList) c.setAttribute?.("aria-pressed", "false");
    btn.setAttribute("aria-pressed", "true");
    rangeDays = +btn.dataset.days;
    renderTopSection();
  });
}
function renderTopSection() {
  const start = rangeStartIdx(rangeDays);
  const counts = new Map();
  for (let i = start; i < N; i++) counts.set(SID[i], (counts.get(SID[i]) || 0) + 1);

  const topSongs = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15);
  renderRankList($("#topSongs"), topSongs.map(([sid, n]) => ({
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
  const topArtists = [...byArtist.entries()].sort((a, b) => b[1].n - a[1].n).slice(0, 15);
  renderRankList($("#topArtists"), topArtists.map(([name, rec]) => ({
    sid: rec.best, n: rec.n, t1: name, t2: `${fmtInt(ARTIST_IDS.get(name).length)} song${ARTIST_IDS.get(name).length > 1 ? "s" : ""}`,
    art: SONGS[rec.best][2],
  })));

  renderHeatmap(start);
}
function renderRankList(root, rows) {
  root.replaceChildren();
  const max = rows.length ? rows[0].n : 1;
  rows.forEach((r, i) => {
    const b = el("button", "rankrow");
    b.dataset.sid = r.sid;
    const meta = el("div", "meta");
    meta.append(el("div", "t1", r.t1), el("div", "t2", r.t2));
    const bar = el("div", "bar");
    bar.style.width = `${Math.max(2, (r.n / max) * 100)}%`;
    b.append(el("span", "rk", String(i + 1)), coverNode(r.art, r.t1), meta,
             el("span", "n", fmtInt(r.n)), bar);
    root.append(b);
  });
}

// ---------- heatmap ----------
function renderHeatmap(start) {
  const grid = Array.from({ length: 7 }, () => new Array(24).fill(0));
  for (let i = start; i < N; i++) grid[LDOW[i]][LHOUR[i]]++;
  const max = Math.max(1, ...grid.flat());

  // Sequential ramp: "more" must move AWAY from the surface — darker steps on
  // the light surface, lighter/brighter steps on the dark surface.
  const ramp = ["--seq-100", "--seq-200", "--seq-300", "--seq-400", "--seq-500", "--seq-600", "--seq-700"]
    .map(v => getComputedStyle(document.documentElement).getPropertyValue(v).trim());
  if (matchMedia("(prefers-color-scheme: dark)").matches &&
      document.documentElement.dataset.theme !== "light") ramp.reverse();
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
  scale.replaceChildren(el("span", null, "fewer"));
  const sw = el("div", "swatches");
  ramp.forEach(c => { const i = el("i"); i.style.background = c; sw.append(i); });
  scale.append(sw, el("span", null, "more"));

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
    const dt = new Date(d * DAY_MS);
    if (dt.getDate() <= 3 && dt.getMonth() !== lastMonth && dt.getMonth() % 3 === 0) {
      lastMonth = dt.getMonth();
      svg.append(svgText(x(i), H - 8, monthFmt.format(dt), "middle"));
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
    showTip(wrap, ev, `${fmtInt(vals[i])} plays`, dateFmt.format(new Date(days[i] * DAY_MS)));
  });
  svg.addEventListener("pointerleave", () => {
    cross.setAttribute("visibility", "hidden");
    dot.setAttribute("visibility", "hidden");
    tip.style.display = "none";
  });

  // monthly table twin
  const byMonth = new Map();
  days.forEach((d, i) => {
    const dt = new Date(d * DAY_MS);
    const k = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}`;
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
const wrapState = { days: new Set([0, 1, 2, 3, 4]), from: 9, to: 17, range: 365 };
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
  for (let h = 0; h < 24; h++) {
    from.append(new Option(hourLabel(h), h, h === wrapState.from, h === wrapState.from));
    to.append(new Option(hourLabel(h), h, h === wrapState.to, h === wrapState.to));
  }
  from.addEventListener("change", () => { wrapState.from = +from.value; renderWrapped(); });
  to.addEventListener("change", () => { wrapState.to = +to.value; renderWrapped(); });
  $("#wrapRange").addEventListener("change", e => { wrapState.range = +e.target.value; renderWrapped(); });
  renderWrapped();
}
function renderWrapped() {
  const start = rangeStartIdx(wrapState.range);
  const { days, from, to } = wrapState;
  const inHours = to > from ? h => h >= from && h < to
                : to < from ? h => h >= from || h < to
                : () => true; // from == to → full day
  const counts = new Map();
  let total = 0;
  for (let i = start; i < N; i++) {
    if (!days.has(LDOW[i]) || !inHours(LHOUR[i])) continue;
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
      .map(([name, rec]) => ({ sid: rec.best, n: rec.n, t1: name, t2: "", art: SONGS[rec.best][2] })));
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
const SEGMENT_ORDER = ["World Music", "Overnights", "The Chris Show", "The Bo Show",
  "Kirby Gwen & Friends", "Sensory Hours"];
const SEGMENT_BLURBS = {
  "World Music": "The default daytime block — the biggest share of airtime.",
  "Overnights": "Late-night shuffle pool (11p–6a CT, minus the overnight shows).",
  "The Chris Show": "Weekday mornings + evenings (live 6–8a CT).",
  "The Bo Show": "Noon + midnight hour (CT).",
  "Kirby Gwen & Friends": "3–4p and 3–4a CT.",
  "Sensory Hours": "8–10a CT daily — the calmer block.",
};
function renderRotation() {
  const rot = META.rotation;
  $("#rotationSub").textContent =
    `Over the last ${rot.window_days} days the stream logged ${fmtInt(rot.window_plays)} plays drawing on ` +
    `${fmtInt(rot.pool_size)} songs played ${rot.min_plays}+ times — that's the working rotation. ` +
    `Below, each schedule segment's most-played songs; a ×lift badge means the song plays ` +
    `disproportionately in that segment (its signature tracks). Segment times follow the published ` +
    `schedule (Central Time).`;
  const grid = $("#segGrid");
  for (const name of SEGMENT_ORDER) {
    const seg = rot.segments[name];
    if (!seg) continue;
    const card = el("div", "card seg-card");
    card.append(el("h3", null, name));
    card.append(el("div", "seghint",
      `${SEGMENT_BLURBS[name] || ""} ${fmtInt(seg.total_plays)} plays · ${fmtInt(seg.distinct_songs)} distinct songs in the window.`));
    const ol = el("ol");
    seg.top.slice(0, 10).forEach(([sid, n, lift]) => {
      const li = el("li");
      const sn = el("span", "sn");
      sn.append(document.createTextNode(SONGS[sid][1] + " "));
      sn.append(el("span", "sa", "· " + SONGS[sid][0]));
      li.append(sn);
      if (lift >= 1.8) li.append(el("span", "lift", `×${lift.toFixed(1)}`));
      li.append(el("span", "sc", fmtInt(n)));
      ol.append(li);
    });
    card.append(ol);
    grid.append(card);
  }
}

// ---------- footer ----------
function renderFooter() {
  const g = META.gaps.map(([a, b]) => a === b ? a : `${a} → ${b}`);
  $("#footGaps").textContent =
    `Data completeness: ${g.length} recording gaps (logger downtime): ${g.join(" · ")}. ` +
    `The weeks before Christmas skew heavily to holiday music.`;
}

// ---------- song modal ----------
function onGlobalClick(e) {
  const btn = e.target.closest("[data-sid]");
  if (btn) openSongModal(+btn.dataset.sid);
}
$("#modalClose").addEventListener("click", () => $("#songModal").close());
$("#songModal").addEventListener("click", e => {
  if (e.target === e.currentTarget) e.currentTarget.close();
});
function openSongModal(sid) {
  const [artist, song, art, total] = SONGS[sid];
  const body = $("#modalBody");
  body.replaceChildren();

  let first = null, last = null;
  const byMonth = new Map();
  for (let i = 0; i < N; i++) {
    if (SID[i] !== sid) continue;
    if (first === null) first = T[i];
    last = T[i];
    const d = new Date(T[i]);
    const k = d.getFullYear() * 12 + d.getMonth();
    byMonth.set(k, (byMonth.get(k) || 0) + 1);
  }

  const head = el("div", "modal-head");
  head.append(coverNode(art, song));
  const hm = el("div");
  const h3 = el("h3", null, song);
  hm.append(h3, el("div", "a", artist));
  head.append(hm);
  body.append(head);

  const stats = el("div", "modal-stats");
  const mk = (v, l) => { const d = el("div"); d.append(el("div", "v", v), el("div", "l", l)); return d; };
  stats.append(mk(fmtInt(total), "total plays"),
               mk(dateFmt.format(new Date(first)), "first heard"),
               mk(dateFmt.format(new Date(last)), "last heard"));
  body.append(stats);

  // plays-per-month mini chart
  const k0 = new Date(T[0]).getFullYear() * 12 + new Date(T[0]).getMonth();
  const k1 = new Date(T[N - 1]).getFullYear() * 12 + new Date(T[N - 1]).getMonth();
  const vals = [];
  for (let k = k0; k <= k1; k++) vals.push(byMonth.get(k) || 0);
  const W = 480, H = 90, bw = W / vals.length;
  const maxV = Math.max(1, ...vals);
  const svg = svgEl("svg", { viewBox: `0 0 ${W} ${H}`, class: "chart-svg", role: "img",
    "aria-label": "Plays per month" });
  svg.append(svgEl("line", { x1: 0, x2: W, y1: H - 14, y2: H - 14, class: "axis-line" }));
  vals.forEach((v, i) => {
    if (!v) return;
    const bh = Math.max(2, (v / maxV) * (H - 24));
    svg.append(svgEl("rect", { x: i * bw + 1, y: H - 14 - bh, width: Math.max(2, bw - 2),
      height: bh, rx: Math.min(2, bw / 3), fill: "var(--series-1)" }));
  });
  svg.append(svgText(2, H - 2, monthFmt.format(new Date(T[0])), "start"));
  svg.append(svgText(W - 2, H - 2, monthFmt.format(new Date(T[N - 1])), "end"));
  const cap = el("div", "l", "");
  cap.style.cssText = "color:var(--muted);font-size:12px;margin-top:14px";
  cap.textContent = "Plays per month";
  body.append(cap, svg);

  $("#songModal").showModal();
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
