// A Year in Twelve Chords — deterministic SVG generator.
//
// Given a *shaped* year (12 months of contribution data) and a theme, returns
// an SVG string: a row of twelve guitar chord-diagram boxes, one per month.
//   - box            = month
//   - 6 strings      = Mon..Sat (top->bottom = low E -> high e)
//   - fret columns   = week-of-month (ceil(dayOfMonth/7), 1..5)
//   - filled dot     = an active day (radius bucketed by commit count)
//   - hollow ring    = that month's busiest day (the chord "root")
//   - o / x above    = Sunday contributed / didn't (the 7th-day resolution)
//   - slur arcs      = streaks (consecutive active days joined dot-to-dot)
//   - box outline ◆  = the "home chord" (month with the highest total)
//
// Motion is pure SMIL (JS-free) so it animates when embedded via <img>/<picture>.

// ---------- palettes ----------

export const PALETTES = {
  dark: {
    id: 'dark',
    bg: '#12100E',
    ink: '#EDE6D6',
    accent: '#E0A458',
    stringOpacity: 0.55,
    fretOpacity: 0.32,
    slurOpacity: 0.55,
    labelOpacity: 0.82,
    subOpacity: 0.6,
    strumMid: 0.3,
    paperGrain: 0,
  },
  light: {
    id: 'light',
    bg: '#F6F1E7',
    ink: '#33271F',
    accent: '#C8892F',
    stringOpacity: 0.6,
    fretOpacity: 0.34,
    slurOpacity: 0.62,
    labelOpacity: 0.88,
    subOpacity: 0.66,
    strumMid: 0.24,
    paperGrain: 0.02,
  },
};

// ---------- geometry ----------

const W = 880;
const H = 168;
const X0 = 34; // first box left
const STEP = 66; // box-to-box horizontal step
const BOX_W = 50; // 5 columns * 10px
const COL_W = 10;

const TITLE_Y = 22;
const MONTH_LABEL_Y = 52;
const SUNDAY_Y = 66;
const ROW_TOP = 82; // Mon
const ROW_GAP = 8;
const LINE_TOP = 78;
const LINE_BOT = 126;
const TOTAL_Y = 142;
const FRAME_TOP = 44; // home-chord outline
const FRAME_BOT = 150;
const LEGEND_X = 26;

const FONT = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';

const boxLeft = (i) => X0 + i * STEP;
const colCenter = (L, c) => L + c * COL_W - 5; // c = 1..5 -> +5,15,25,35,45
const rowY = (r) => ROW_TOP + r * ROW_GAP; // r = 0..5 (Mon..Sat)

const r1 = (n) => Math.round(n * 10) / 10;
const esc = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// commit-count -> dot radius (fixed buckets; capped to protect 8px string gap)
function bucketRadius(count) {
  if (count <= 0) return 0;
  if (count <= 3) return 1.6;
  if (count <= 7) return 2.4;
  if (count <= 15) return 3.2;
  return 3.8;
}

// staggered strum timing on a single 10s loop; box i is "played" in its slice
function slice(i) {
  const a = +(i * 0.07).toFixed(4);
  const b = +(a + 0.08).toFixed(4);
  const a2 = +(a + 0.004).toFixed(4);
  const b2 = +(b - 0.004).toFixed(4);
  const mid = +((a + b) / 2).toFixed(4);
  return { a, b, a2, b2, mid };
}

// ---------- rendering ----------

export function renderChords(shaped, theme) {
  const p = PALETTES[theme] || PALETTES.dark;
  const { months, totalContributions, homeIndex } = shaped;
  const homeLabel = homeIndex >= 0 && months[homeIndex] ? months[homeIndex].label : '—';

  const dotCenters = {}; // date -> {x, y} for slur routing
  const parts = [];

  // defs: the soft strum glow gradient + optional paper grain
  parts.push(`<defs>
    <linearGradient id="strum-${p.id}" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="${p.accent}" stop-opacity="0"/>
      <stop offset="0.5" stop-color="${p.accent}" stop-opacity="${p.strumMid}"/>
      <stop offset="1" stop-color="${p.accent}" stop-opacity="0"/>
    </linearGradient>
  </defs>`);

  // background
  parts.push(`<rect x="0" y="0" width="${W}" height="${H}" fill="${p.bg}"/>`);

  // title band
  parts.push(
    `<text x="${X0}" y="${TITLE_Y}" font-family="${FONT}" font-size="11" letter-spacing="2.5" fill="${p.ink}" fill-opacity="${p.labelOpacity}">A YEAR IN TWELVE CHORDS</text>`
  );
  parts.push(
    `<text x="${W - 8}" y="${TITLE_Y}" text-anchor="end" font-family="${FONT}" font-size="9" fill="${p.ink}" fill-opacity="${p.subOpacity}">${esc(
      totalContributions.toLocaleString('en-US')
    )} total · home chord: ${esc(homeLabel)}</text>`
  );

  // left legend (drawn once, shared by every box)
  const legend = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];
  const legendY = [SUNDAY_Y, rowY(0), rowY(1), rowY(2), rowY(3), rowY(4), rowY(5)];
  legend.forEach((lab, k) => {
    parts.push(
      `<text x="${LEGEND_X}" y="${legendY[k] + 2.4}" text-anchor="end" font-family="${FONT}" font-size="7" fill="${p.ink}" fill-opacity="0.5">${lab}</text>`
    );
  });

  // twelve boxes
  months.forEach((m, i) => {
    const L = boxLeft(i);
    const cx = L + BOX_W / 2;
    const isHome = i === homeIndex;
    const empty = m.total <= 0;
    const { a, b, a2, b2, mid } = slice(i);

    const g = [];

    // home-chord frame
    if (isHome) {
      g.push(
        `<rect x="${r1(L - 5)}" y="${FRAME_TOP}" width="${BOX_W + 10}" height="${
          FRAME_BOT - FRAME_TOP
        }" rx="4" fill="none" stroke="${p.accent}" stroke-width="1.1" stroke-opacity="0.9"/>`
      );
    }

    // month label
    g.push(
      `<text x="${cx}" y="${MONTH_LABEL_Y}" text-anchor="middle" font-family="${FONT}" font-size="9" fill="${p.ink}" fill-opacity="${p.labelOpacity}">${esc(
        m.label
      )}</text>`
    );

    // strings (6 horizontal lines)
    for (let r = 0; r < 6; r++) {
      const y = rowY(r);
      g.push(
        `<line x1="${L}" y1="${y}" x2="${L + BOX_W}" y2="${y}" stroke="${p.ink}" stroke-width="0.7" stroke-opacity="${p.stringOpacity}"/>`
      );
    }
    // nut (thick) + frets (thin)
    for (let k = 0; k <= 5; k++) {
      const x = L + k * COL_W;
      if (k === 0) {
        g.push(
          `<line x1="${x}" y1="${LINE_TOP}" x2="${x}" y2="${LINE_BOT}" stroke="${p.ink}" stroke-width="2.4" stroke-opacity="0.9" stroke-linecap="round"/>`
        );
      } else {
        g.push(
          `<line x1="${x}" y1="${LINE_TOP + 2}" x2="${x}" y2="${LINE_BOT - 2}" stroke="${p.ink}" stroke-width="0.6" stroke-opacity="${p.fretOpacity}"/>`
        );
      }
    }

    // Sunday o/x strip (weekday 0). Busiest-day-is-Sunday -> brass emphasis.
    for (const [colStr, mark] of Object.entries(m.sundayByCol)) {
      const c = Number(colStr);
      const x = colCenter(L, c);
      const brass = m.rootIsSunday && m.rootCol === c;
      const col = brass ? p.accent : p.ink;
      const op = brass ? 1 : mark === 'o' ? 0.85 : 0.5;
      if (mark === 'o') {
        g.push(
          `<circle cx="${x}" cy="${SUNDAY_Y}" r="${brass ? 2.6 : 2}" fill="none" stroke="${col}" stroke-width="${brass ? 1.2 : 0.9}" stroke-opacity="${op}"/>`
        );
      } else {
        // muted 'x' with a tiny flinch as the strum passes
        g.push(
          `<g stroke="${col}" stroke-width="0.9" stroke-opacity="${op}" stroke-linecap="round">` +
            `<line x1="${x - 2}" y1="${SUNDAY_Y - 2}" x2="${x + 2}" y2="${SUNDAY_Y + 2}"/>` +
            `<line x1="${x - 2}" y1="${SUNDAY_Y + 2}" x2="${x + 2}" y2="${SUNDAY_Y - 2}"/>` +
            `<animateTransform attributeName="transform" type="translate" dur="10s" repeatCount="indefinite" keyTimes="0;${a};${a2};${b2};${b};1" values="0 0;0 0;2 0;-2 0;0 0;0 0"/>` +
            `</g>`
        );
      }
    }

    // dots (Mon..Sat active days) + root ring, wrapped in a pulsing group
    const dots = [];
    for (const d of m.days) {
      if (d.weekday === 0 || d.count <= 0) continue; // Sunday handled above
      const r = d.weekday - 1; // Mon..Sat -> 0..5
      const c = d.weekOfMonth;
      const x = colCenter(L, c);
      const y = rowY(r);
      dotCenters[d.date] = { x, y };
      const rad = bucketRadius(d.count);
      const isRoot = !m.rootIsSunday && m.rootDate === d.date;
      if (isRoot) {
        dots.push(
          `<circle cx="${x}" cy="${y}" r="${r1(rad + 1)}" fill="none" stroke="${p.accent}" stroke-width="1.3"/>`
        );
      } else {
        dots.push(`<circle cx="${x}" cy="${y}" r="${rad}"/>`);
      }
    }
    if (dots.length) {
      g.push(
        `<g fill="${p.ink}">${dots.join('')}<animate attributeName="opacity" dur="10s" repeatCount="indefinite" keyTimes="0;${a};${mid};${b};1" values="0.85;0.85;1;0.85;0.85"/></g>`
      );
    }

    // monthly total (or N.C. for a silent month)
    g.push(
      `<text x="${cx}" y="${TOTAL_Y}" text-anchor="middle" font-family="${FONT}" font-size="8.5" fill="${p.ink}" fill-opacity="${p.subOpacity}">${
        empty ? 'N.C.' : esc(m.total.toLocaleString('en-US')) + (isHome ? ' ◆' : '')
      }</text>`
    );

    // strum: a soft brass band sweeping down across the six strings in its slice
    g.push(
      `<rect x="${L}" y="${LINE_TOP}" width="${BOX_W}" height="7" rx="3" fill="url(#strum-${p.id})" opacity="0">` +
        `<animate attributeName="opacity" dur="10s" repeatCount="indefinite" keyTimes="0;${a};${a2};${b2};${b};1" values="0;0;0.9;0.9;0;0"/>` +
        `<animateTransform attributeName="transform" type="translate" dur="10s" repeatCount="indefinite" keyTimes="0;${a};${b};1" values="0 0;0 0;0 ${
          LINE_BOT - LINE_TOP - 5
        };0 ${LINE_BOT - LINE_TOP - 5}"/>` +
        `</rect>`
    );

    parts.push(`<g>${g.join('')}</g>`);
  });

  // slurs: connect consecutive (diff == 1 day) active dot-days *within a month*
  // (a legato phrase). Cross-month ties are omitted — across the box gap they
  // read as stray hairs rather than slurs.
  const dates = Object.keys(dotCenters).sort();
  const arcs = [];
  for (let k = 1; k < dates.length; k++) {
    const prev = dates[k - 1];
    const cur = dates[k];
    if (dayDiff(prev, cur) !== 1) continue;
    if (prev.slice(0, 7) !== cur.slice(0, 7)) continue; // same month only
    const A = dotCenters[prev];
    const B = dotCenters[cur];
    const mx = (A.x + B.x) / 2;
    const my = Math.min(A.y, B.y) - 6;
    arcs.push(`<path d="M${r1(A.x)} ${r1(A.y)}Q${r1(mx)} ${r1(my)} ${r1(B.x)} ${r1(B.y)}"/>`);
  }
  // slurs sit under the dots so dots stay crisp on top; shared stroke on the group
  if (arcs.length) {
    parts.splice(
      2,
      0,
      `<g fill="none" stroke="${p.ink}" stroke-width="0.8" stroke-opacity="${p.slurOpacity}">${arcs.join('')}</g>`
    );
  }

  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" role="img" ` +
    `aria-label="A Year in Twelve Chords: my GitHub contributions as a page of guitar chord diagrams, one box per month">` +
    parts.join('') +
    `</svg>`;
  return svg;
}

function dayDiff(a, b) {
  return Math.round((Date.parse(b) - Date.parse(a)) / 86400000);
}
