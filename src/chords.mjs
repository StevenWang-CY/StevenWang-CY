// A Year in Twelve Chords — deterministic SVG generator.
//
// Renders 12 guitar chord-diagram boxes (one per contribution month) and
// animates them as "The Year, Played Once": a single brass pick-bead performs
// the page left->right as one legato lead. Its landing height traces the year's
// melodic contour (each month's busiest weekday); every landing plucks that
// string into a damped standing wave, blooms the root ring with a ripple,
// brightens the notes, re-inks a legato tie over a faint pre-printed staff, and
// wakes the neighbouring month in sympathy — climaxing on the home chord's
// fermata (rising sustain rings, glowing frame, a swaying diamond).
//
// Motion is pure declarative SMIL on ONE shared period (repeatCount=indefinite,
// absolute keyTimes — no syncbase, no JS), so it animates and loops seamlessly
// when embedded via <img>/<picture>. Frame 0 is a clean, legible resting sheet.

// ---------- palettes ----------

export const PALETTES = {
  dark: {
    id: 'dark',
    bg: '#12100E',
    ink: '#EDE6D6',
    accent: '#E0A458',
    stringOpacity: 0.55,
    fretOpacity: 0.32,
    slurOpacity: 0.5,
    printOpacity: 0.26,
    labelOpacity: 0.82,
    subOpacity: 0.6,
    haloPeak: 0.55,
    shimmerPeak: 0.95,
  },
  light: {
    id: 'light',
    bg: '#F6F1E7',
    ink: '#33271F',
    accent: '#C8892F',
    stringOpacity: 0.6,
    fretOpacity: 0.34,
    slurOpacity: 0.6,
    printOpacity: 0.3,
    labelOpacity: 0.88,
    subOpacity: 0.66,
    haloPeak: 0.42,
    shimmerPeak: 0.9,
  },
};

// ---------- geometry ----------

const W = 880;
const H = 104;
const X0 = 52; // centres the 12 boxes (no legend/title anymore)
const STEP_X = 66;
const BOX_W = 50;
const COL_W = 10;

const SUNDAY_Y = 20;
const ROW_TOP = 38;
const ROW_GAP = 8;
const LINE_TOP = 34;
const LINE_BOT = 82;
const FRAME_TOP = 12;
const FRAME_BOT = 90;
const REST_Y = 58; // where the bead lands for a silent month

const FONT = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';

// ---------- timing (seconds) ----------

const STEP = 1.0; // one month per second
const DWELL = 0.45; // note rings while the bead rests on a fret
const FLY = 0.55; // hop flight (DWELL + FLY = STEP)
const HOP = 9; // arc lift of a hop
const NOTE = 0.7; // note-bloom duration
const FERM = 1.6; // home-chord fermata sustain
const RESTBAR = 0.9; // breath before the loop repeats

const boxLeft = (i) => X0 + i * STEP_X;
const colCenter = (L, c) => L + c * COL_W - 5;
const rowY = (r) => ROW_TOP + r * ROW_GAP;

const r1 = (n) => Math.round(n * 10) / 10;
const r4 = (n) => Math.round(n * 1e4) / 1e4;
const esc = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function bucketRadius(count) {
  if (count <= 0) return 0;
  if (count <= 3) return 1.6;
  if (count <= 7) return 2.4;
  if (count <= 15) return 3.2;
  return 3.8;
}

// approximate quadratic-Bezier length (for a tie's stroke-dash length)
function quadLen(ax, ay, cx, cy, bx, by, n = 16) {
  let len = 0, px = ax, py = ay;
  for (let k = 1; k <= n; k++) {
    const t = k / n, u = 1 - t;
    const x = u * u * ax + 2 * u * t * cx + t * t * bx;
    const y = u * u * ay + 2 * u * t * cy + t * t * by;
    len += Math.hypot(x - px, y - py);
    px = x; py = y;
  }
  return len;
}

// ---------- rendering ----------

export function renderChords(shaped, theme) {
  const p = PALETTES[theme] || PALETTES.dark;
  const { months, homeIndex } = shaped;

  // --- landing point of the pick for each month (traces the melodic contour) ---
  const pts = months.map((m, i) => {
    const L = boxLeft(i);
    if (!m.rootDate || m.total <= 0) return { x: L + 25, y: REST_Y, kind: 'rest' };
    if (m.rootIsSunday) return { x: colCenter(L, m.rootCol), y: SUNDAY_Y, kind: 'sun' };
    const day = m.days.find((d) => d.date === m.rootDate);
    const row = (day ? day.weekday : 1) - 1;
    return { x: colCenter(L, m.rootCol), y: rowY(row), row, kind: 'string' };
  });

  // arcs between consecutive landings (used by the bead's path, the ties, the printed staff)
  const arcs = [];
  for (let i = 0; i < months.length - 1; i++) {
    const a = pts[i], b = pts[i + 1];
    const mx = (a.x + b.x) / 2;
    const my = Math.min(a.y, b.y) - HOP;
    arcs.push({ a, b, mx, my, d: `M${r1(a.x)} ${r1(a.y)}Q${r1(mx)} ${r1(my)} ${r1(b.x)} ${r1(b.y)}`, len: quadLen(a.x, a.y, mx, my, b.x, b.y) });
  }

  // --- timeline ---
  const n = months.length; // 12
  const lastLand = (n - 1) * STEP; // 11
  const A = (j) => j * STEP; // landing time of box j
  const aHome = homeIndex >= 0 ? A(homeIndex) : null;
  let PERIOD = lastLand + RESTBAR;
  if (aHome != null) PERIOD = Math.max(PERIOD, aHome + FERM + 0.3);
  PERIOD = r4(PERIOD);
  const r3 = (x) => Math.round(x * 1e3) / 1e3;
  const f = (t) => r3(Math.min(1, Math.max(0, t / PERIOD)));

  // period-looped animation-string helpers (absolute keyTimes; no syncbase)
  const animEl = (attr, kt, vs, calc = 'linear', splines = '') =>
    `<animate attributeName="${attr}" dur="${PERIOD}s" repeatCount="indefinite" calcMode="${calc}" keyTimes="${kt}" values="${vs}"` +
    (calc === 'spline' ? ` keySplines="${splines}"` : '') + ` fill="freeze"/>`;

  // a single bump: rest -> mids... -> rest, active in [T, T+D]
  const pulse = (attr, rest, mids, T, D) => {
    const f0 = f(T), f1 = f(T + D);
    const kt = ['0', f0], vs = [rest, mids[0]];
    for (let k = 1; k < mids.length; k++) { kt.push(r4(f0 + (f1 - f0) * k / (mids.length - 1))); vs.push(mids[k]); }
    kt.push('1'); vs.push(rest);
    return animEl(attr, kt.join(';'), vs.join(';'));
  };
  // multiple bumps of a single peak at several times (for sympathetic shimmer)
  const bumps = (attr, rest, peak, times, D) => {
    const segs = times.filter((t) => t != null).map((t) => [f(t), f(t + D)]).sort((x, y) => x[0] - y[0]);
    if (!segs.length) return '';
    const kt = ['0'], vs = [rest];
    for (const [s, e] of segs) { kt.push(s, r4((s + e) / 2), e); vs.push(rest, peak, rest); }
    kt.push('1'); vs.push(rest);
    return animEl(attr, kt.join(';'), vs.join(';'));
  };

  const dotCenters = {}; // date -> {x,y} for streak slurs
  const boxDots = months.map(() => []); // per-box dot centres for the fermata gleam
  const parts = [];

  // defs: one shared soft-glow filter (halo + gleam)
  parts.push(
    `<defs><filter id="glow-${p.id}" x="-40%" y="-40%" width="180%" height="180%"><feGaussianBlur stdDeviation="2"/></filter></defs>`
  );

  // background
  parts.push(`<rect x="0" y="0" width="${W}" height="${H}" fill="${p.bg}"/>`);

  // printed melody staff (the whole year's contour, pre-printed like real sheet music)
  const staffD = arcs.map((s) => s.d).join('');
  if (staffD) {
    parts.push(
      `<path d="${staffD}" fill="none" stroke="${p.ink}" stroke-width="0.7" stroke-opacity="${p.printOpacity}">` +
        pulse('stroke-opacity', p.printOpacity, [p.printOpacity, r4(p.printOpacity + 0.08), p.printOpacity], lastLand + 0.1, RESTBAR - 0.2) +
        `</path>`
    );
  }
  const slurSlot = parts.length; // streak slurs get spliced here (under dots)

  // shimmer schedule: for box i, which rows shimmer and at what times (a neighbour's root row)
  const shimmer = months.map(() => ({}));
  for (let i = 0; i < n; i++) {
    for (const nb of [i - 1, i + 1]) {
      if (nb < 0 || nb >= n) continue;
      if (pts[nb].kind !== 'string') continue;
      const row = pts[nb].row;
      (shimmer[i][row] = shimmer[i][row] || []).push(A(nb) + 0.15);
    }
  }

  // ---- boxes ----
  months.forEach((m, i) => {
    const L = boxLeft(i);
    const isHome = i === homeIndex;
    const T = A(i);
    const g = [];

    // home frame + fermata halo
    if (isHome) {
      g.push(
        `<rect x="${r1(L - 5)}" y="${FRAME_TOP}" width="${BOX_W + 10}" height="${FRAME_BOT - FRAME_TOP}" rx="4" fill="none" stroke="${p.accent}" stroke-opacity="0.9" stroke-width="1.1">` +
          pulse('stroke-width', '1.1', ['1.1', '1.6', '1.1'], T, FERM) +
          `</rect>`
      );
      g.push(
        `<rect x="${r1(L - 5)}" y="${FRAME_TOP}" width="${BOX_W + 10}" height="${FRAME_BOT - FRAME_TOP}" rx="5" fill="none" stroke="${p.accent}" stroke-width="2.4" filter="url(#glow-${p.id})" opacity="0">` +
          pulse('opacity', '0', ['0', String(p.haloPeak), '0'], T, FERM) +
          `</rect>`
      );
    }

    // strings (static frame) + sympathetic shimmer where a neighbour's root shares the row
    const slines = [];
    for (let r = 0; r < 6; r++) {
      const y = rowY(r);
      const times = shimmer[i][r];
      slines.push(
        times && times.length
          ? `<line x1="${L}" y1="${y}" x2="${L + BOX_W}" y2="${y}">${bumps('stroke-opacity', String(p.stringOpacity), String(p.shimmerPeak), times, 0.6)}</line>`
          : `<line x1="${L}" y1="${y}" x2="${L + BOX_W}" y2="${y}"/>`
      );
    }
    g.push(`<g stroke="${p.ink}" stroke-width="0.7" stroke-opacity="${p.stringOpacity}">${slines.join('')}</g>`);
    // frets (shared attrs) + the thick nut
    const frets = [];
    for (let k = 1; k <= 5; k++) {
      const x = L + k * COL_W;
      frets.push(`<line x1="${x}" y1="${LINE_TOP + 2}" x2="${x}" y2="${LINE_BOT - 2}"/>`);
    }
    g.push(`<g stroke="${p.ink}" stroke-width="0.6" stroke-opacity="${p.fretOpacity}">${frets.join('')}</g>`);
    g.push(`<line x1="${L}" y1="${LINE_TOP}" x2="${L}" y2="${LINE_BOT}" stroke="${p.ink}" stroke-width="2.4" stroke-opacity="0.9" stroke-linecap="round"/>`);

    // standing-wave overlay for a struck string root (endpoint-pinned pluck; home = octave S-curve)
    if (pts[i].kind === 'string') {
      const yy = pts[i].y;
      const d = isHome ? 'M0 0 Q12.5 -6 25 0 Q37.5 6 50 0' : 'M0 0 Q25 -6 50 0';
      g.push(
        `<g transform="translate(${L} ${yy})"><path d="${d}" fill="none" stroke="${p.accent}" stroke-width="0.9" opacity="0" transform="scale(1 0)">` +
          `<animateTransform attributeName="transform" type="scale" dur="${PERIOD}s" repeatCount="indefinite" calcMode="linear" keyTimes="0;${f(T)};${r3(f(T) + (f(T + NOTE) - f(T)) * 0.2)};${r3(f(T) + (f(T + NOTE) - f(T)) * 0.44)};${r3(f(T) + (f(T + NOTE) - f(T)) * 0.66)};${r3(f(T) + (f(T + NOTE) - f(T)) * 0.85)};${f(T + NOTE)};1" values="1 0;1 0;1 1;1 -0.62;1 0.4;1 -0.22;1 0;1 0" fill="freeze"/>` +
          pulse('opacity', '0', ['0', '0.9', '0.9', '0'], T, NOTE) +
          `</path></g>`
      );
    }

    // Sunday o/x strip (o-root blooms; no more x-flinch)
    for (const [colStr, mark] of Object.entries(m.sundayByCol)) {
      const c = Number(colStr);
      const x = colCenter(L, c);
      const isRoot = m.rootIsSunday && m.rootCol === c;
      const col = isRoot ? p.accent : p.ink;
      const op = isRoot ? 1 : mark === 'o' ? 0.85 : 0.5;
      if (mark === 'o') {
        g.push(
          `<circle cx="${x}" cy="${SUNDAY_Y}" r="${isRoot ? 2.6 : 2}" fill="none" stroke="${col}" stroke-width="${isRoot ? 1.2 : 0.9}" stroke-opacity="${op}">` +
            (isRoot ? pulse('r', '2.6', ['2.6', '3.4', '2.6'], T, NOTE) : '') +
            `</circle>`
        );
      } else {
        g.push(
          `<g stroke="${col}" stroke-width="0.9" stroke-opacity="${op}" stroke-linecap="round">` +
            `<line x1="${x - 2}" y1="${SUNDAY_Y - 2}" x2="${x + 2}" y2="${SUNDAY_Y + 2}"/>` +
            `<line x1="${x - 2}" y1="${SUNDAY_Y + 2}" x2="${x + 2}" y2="${SUNDAY_Y - 2}"/></g>`
        );
      }
    }

    // dots + root ring; the root blooms (r + a fading ripple) as the note is struck
    const dots = [];
    let rootRing = '';
    for (const d of m.days) {
      if (d.weekday === 0 || d.count <= 0) continue;
      const r = d.weekday - 1;
      const c = d.weekOfMonth;
      const x = colCenter(L, c);
      const y = rowY(r);
      dotCenters[d.date] = { x, y };
      boxDots[i].push({ x, y });
      const rad = bucketRadius(d.count);
      const isRoot = !m.rootIsSunday && m.rootDate === d.date;
      if (isRoot) {
        const R = r1(rad + 1);
        rootRing =
          `<circle cx="${x}" cy="${y}" r="${R}" fill="none" stroke="${p.accent}" stroke-width="1.3">` +
          pulse('r', String(R), [String(R), String(r1(R + 1.6)), String(R)], T, NOTE) +
          pulse('stroke-width', '1.3', ['1.3', '2', '1.3'], T, NOTE) +
          `</circle>`;
      } else {
        dots.push(`<circle cx="${x}" cy="${y}" r="${rad}"/>`);
      }
    }
    if (dots.length || rootRing) {
      g.push(`<g fill="${p.ink}">${dots.join('')}${rootRing}</g>`);
    }

    parts.push(`<g>${g.join('')}</g>`);
  });

  // streak slurs (static; under dots) — spliced into the printed-staff slot
  const dates = Object.keys(dotCenters).sort();
  const streak = [];
  for (let k = 1; k < dates.length; k++) {
    const pr = dates[k - 1], cu = dates[k];
    if (dayDiff(pr, cu) !== 1 || pr.slice(0, 7) !== cu.slice(0, 7)) continue;
    const Aa = dotCenters[pr], Bb = dotCenters[cu];
    const mx = (Aa.x + Bb.x) / 2, my = Math.min(Aa.y, Bb.y) - 6;
    streak.push(`<path d="M${r1(Aa.x)} ${r1(Aa.y)}Q${r1(mx)} ${r1(my)} ${r1(Bb.x)} ${r1(Bb.y)}"/>`);
  }
  if (streak.length) {
    parts.splice(slurSlot, 0, `<g fill="none" stroke="${p.ink}" stroke-width="0.8" stroke-opacity="${p.slurOpacity}">${streak.join('')}</g>`);
  }

  // ---- overlay: legato ties (drawn under the flying bead), fermata sustain rings, gleam, bead ----
  const overlay = [];

  // legato ties: each draws during its flight, then fades; the printed staff remains
  arcs.forEach((s, i) => {
    const Li = r1(s.len);
    const t0 = A(i) + DWELL; // flight start
    const t1 = A(i + 1); // flight end (landing)
    const fd = f(t0), fl = f(t1), fade = f(t1 + 0.8);
    overlay.push(
      `<path d="${s.d}" fill="none" stroke="${p.accent}" stroke-width="1" stroke-dasharray="${Li}" stroke-dashoffset="${Li}" opacity="0">` +
        animEl('stroke-dashoffset', `0;${fd};${fl};1`, `${Li};${Li};0;0`) +
        animEl('opacity', `0;${fd};${r4(fd + 0.004)};${fl};${fade};1`, `0;0;1;1;0;0`) +
        `</path>`
    );
  });

  // fermata sustain rings + neighbour gleam (home only, string/sun root)
  if (homeIndex >= 0 && (pts[homeIndex].kind === 'string' || pts[homeIndex].kind === 'sun')) {
    const hx = pts[homeIndex].x, hy = pts[homeIndex].y, T = A(homeIndex);
    const ring = (begin) => {
      const g0 = f(begin), g1 = f(begin + 1.3);
      return (
        `<g opacity="1"><circle cx="${hx}" cy="${hy}" r="3" fill="none" stroke="${p.accent}" stroke-width="1.2" stroke-opacity="0">` +
        animEl('r', `0;${g0};${g1};1`, `3;3;16;16`) +
        animEl('stroke-width', `0;${g0};${g1};1`, `1.2;1.2;0.3;0.3`) +
        animEl('stroke-opacity', `0;${g0};${r4((g0 + g1) / 2)};${g1};1`, `0;0;0.5;0;0`) +
        `<animateTransform attributeName="transform" type="translate" dur="${PERIOD}s" repeatCount="indefinite" calcMode="linear" keyTimes="0;${g0};${g1};1" values="0 0;0 0;0 -3;0 -3" fill="freeze"/>` +
        `</circle></g>`
      );
    };
    overlay.push(ring(T));
    overlay.push(ring(T + 0.5));
    // gleam the nearest dot in each neighbour month
    for (const nb of [homeIndex - 1, homeIndex + 1]) {
      if (nb < 0 || nb >= n || !boxDots[nb].length) continue;
      const pick = nb < homeIndex
        ? boxDots[nb].reduce((a, b) => (b.x > a.x ? b : a))
        : boxDots[nb].reduce((a, b) => (b.x < a.x ? b : a));
      overlay.push(
        `<circle cx="${pick.x}" cy="${pick.y}" r="3.4" fill="none" stroke="${p.accent}" stroke-opacity="0">` +
          pulse('stroke-opacity', '0', ['0', '0.6', '0'], T + 0.4, NOTE) +
          `</circle>`
      );
    }
  }

  // the pick-bead: cx/cy keyframed to land exactly on each root (arc via an apex keyframe)
  {
    const kt = [0], cxv = [pts[0].x], cyv = [pts[0].y];
    for (let i = 0; i < arcs.length; i++) {
      const ts = A(i) + DWELL, tm = ts + FLY / 2, te = A(i + 1);
      kt.push(ts, tm, te);
      cxv.push(pts[i].x, arcs[i].mx, pts[i + 1].x);
      cyv.push(pts[i].y, arcs[i].my, pts[i + 1].y);
    }
    kt.push(PERIOD); cxv.push(pts[n - 1].x); cyv.push(pts[n - 1].y);
    const ktn = kt.map((t) => f(t)).join(';');
    overlay.push(
      `<circle r="1.7" fill="${p.accent}" cx="${r1(pts[0].x)}" cy="${r1(pts[0].y)}">` +
        `<animate attributeName="cx" dur="${PERIOD}s" repeatCount="indefinite" calcMode="linear" keyTimes="${ktn}" values="${cxv.map(r1).join(';')}" fill="freeze"/>` +
        `<animate attributeName="cy" dur="${PERIOD}s" repeatCount="indefinite" calcMode="linear" keyTimes="${ktn}" values="${cyv.map(r1).join(';')}" fill="freeze"/>` +
        `</circle>`
    );
  }

  parts.push(`<g>${overlay.join('')}</g>`);

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" role="img" ` +
    `aria-label="A Year in Twelve Chords: my GitHub contributions as a page of guitar chord diagrams, played once left to right as a single legato lead">` +
    parts.join('') +
    `</svg>`
  );
}

function dayDiff(a, b) {
  return Math.round((Date.parse(b) - Date.parse(a)) / 86400000);
}
