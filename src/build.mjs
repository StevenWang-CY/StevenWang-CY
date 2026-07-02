// A Year in Twelve Chords — entry point.
//
// Fetches a GitHub contribution calendar (or a demo/fixture), shapes it into
// twelve months, and writes two theme variants: dist/chords-dark.svg and
// dist/chords-light.svg.
//
// Usage:
//   node src/build.mjs                         # live: needs GH_LOGIN + a token
//   node src/build.mjs --demo heavy            # synthesize a year (heavy|sparse|empty)
//   node src/build.mjs --fixture test/fixtures/heavy.json
//   node src/build.mjs --out dist              # output dir (default: dist)
//
// Auth for the live path: set GH_LOGIN and one of GH_TOKEN / GITHUB_TOKEN.
// GITHUB_TOKEN reads PUBLIC contributions; a classic PAT with `read:user`
// also includes private-contribution counts.

import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { renderChords, PALETTES } from './chords.mjs';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function parseArgs(argv) {
  const args = { out: 'dist' };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--demo') args.demo = argv[++i];
    else if (a === '--fixture') args.fixture = argv[++i];
    else if (a === '--out') args.out = argv[++i];
    else if (a === '--login') args.login = argv[++i];
  }
  return args;
}

// ---------- data acquisition ----------

async function fetchCalendar(login, token) {
  const to = new Date();
  const from = new Date(Date.UTC(to.getUTCFullYear() - 1, to.getUTCMonth(), 1, 0, 0, 0));
  const query = `query($login:String!, $from:DateTime!, $to:DateTime!) {
    user(login:$login) {
      contributionsCollection(from:$from, to:$to) {
        contributionCalendar {
          totalContributions
          weeks { contributionDays { date weekday contributionCount } }
        }
      }
    }
  }`;
  const res = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'User-Agent': 'year-in-twelve-chords',
    },
    body: JSON.stringify({ query, variables: { login, from: from.toISOString(), to: to.toISOString() } }),
  });
  if (!res.ok) throw new Error(`GitHub GraphQL ${res.status}: ${await res.text()}`);
  const json = await res.json();
  if (json.errors) throw new Error(`GraphQL errors: ${JSON.stringify(json.errors)}`);
  const cal = json.data?.user?.contributionsCollection?.contributionCalendar;
  if (!cal) throw new Error(`No contribution calendar for login "${login}"`);
  return cal;
}

// deterministic PRNG so demo/fixtures are reproducible
function mulberry32(seed) {
  let t = seed >>> 0;
  return () => {
    t += 0x6d2b79f5;
    let x = t;
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

export function synthCalendar(profile) {
  const rnd = mulberry32(profile === 'sparse' ? 7 : profile === 'empty' ? 1 : 42);
  const end = new Date();
  end.setUTCHours(0, 0, 0, 0);
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - 370);
  // align start back to the preceding Sunday so weeks are Sun-based
  start.setUTCDate(start.getUTCDate() - start.getUTCDay());

  const weeks = [];
  let week = null;
  let total = 0;
  for (let d = new Date(start); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
    const wd = d.getUTCDay();
    if (wd === 0 || week === null) {
      week = { contributionDays: [] };
      weeks.push(week);
    }
    let count = 0;
    if (profile === 'empty') {
      count = 0;
    } else if (profile === 'sparse') {
      if (rnd() < 0.18) count = 1 + Math.floor(rnd() * 3);
    } else {
      // heavy: weekday-forward with occasional spikes; lighter weekends
      const weekend = wd === 0 || wd === 6;
      const p = weekend ? 0.4 : 0.86;
      if (rnd() < p) {
        const base = weekend ? 1 + rnd() * 4 : 1 + rnd() * rnd() * 16;
        count = Math.max(1, Math.round(base));
        if (rnd() < 0.03) count += 8 + Math.floor(rnd() * 20); // rare big day
      }
    }
    total += count;
    week.contributionDays.push({
      date: d.toISOString().slice(0, 10),
      weekday: wd,
      contributionCount: count,
    });
  }
  return { totalContributions: total, weeks };
}

// ---------- shaping ----------

function weekOfMonth(dayOfMonth) {
  return Math.ceil(dayOfMonth / 7); // 1..5
}

export function shape(cal) {
  const flat = [];
  for (const w of cal.weeks || []) {
    for (const day of w.contributionDays || []) {
      const date = day.date;
      const weekday =
        typeof day.weekday === 'number' ? day.weekday : new Date(date + 'T00:00:00Z').getUTCDay();
      flat.push({ date, weekday, count: day.contributionCount || 0 });
    }
  }
  flat.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  // group by YYYY-MM
  const byMonth = new Map();
  for (const d of flat) {
    const key = d.date.slice(0, 7);
    if (!byMonth.has(key)) byMonth.set(key, []);
    byMonth.get(key).push(d);
  }
  const keys = [...byMonth.keys()].sort();
  const last12 = keys.slice(-12);

  const months = last12.map((key) => {
    const days = byMonth.get(key).map((d) => {
      const dayOfMonth = Number(d.date.slice(8, 10));
      return { date: d.date, weekday: d.weekday, count: d.count, weekOfMonth: weekOfMonth(dayOfMonth) };
    });
    const total = days.reduce((s, d) => s + d.count, 0);

    // busiest day (the "root"); ties -> earliest date
    let root = null;
    for (const d of days) {
      if (d.count <= 0) continue;
      if (!root || d.count > root.count) root = d;
    }

    // Sunday o/x per column
    const sundayByCol = {};
    for (const d of days) {
      if (d.weekday === 0) sundayByCol[d.weekOfMonth] = d.count > 0 ? 'o' : 'x';
    }

    const monthIdx = Number(key.slice(5, 7)) - 1;
    return {
      label: MONTHS[monthIdx],
      total,
      days,
      sundayByCol,
      rootDate: root ? root.date : null,
      rootIsSunday: root ? root.weekday === 0 : false,
      rootCol: root ? root.weekOfMonth : null,
    };
  });

  // pad to 12 boxes (silent months) if the source had fewer
  while (months.length < 12) {
    months.unshift({ label: '—', total: 0, days: [], sundayByCol: {}, rootDate: null, rootIsSunday: false, rootCol: null });
  }

  let homeIndex = -1;
  let best = -1;
  months.forEach((m, i) => {
    if (m.total > best) {
      best = m.total;
      homeIndex = m.total > 0 ? i : homeIndex;
    }
  });

  const totalContributions =
    typeof cal.totalContributions === 'number'
      ? cal.totalContributions
      : flat.reduce((s, d) => s + d.count, 0);

  return { months, totalContributions, homeIndex };
}

// ---------- main ----------

async function main() {
  const args = parseArgs(process.argv);
  let cal;
  if (args.demo) {
    cal = synthCalendar(args.demo);
    console.log(`[chords] demo profile "${args.demo}" — ${cal.totalContributions} contributions`);
  } else if (args.fixture) {
    cal = JSON.parse(readFileSync(args.fixture, 'utf8'));
    console.log(`[chords] fixture ${args.fixture}`);
  } else {
    const login = args.login || process.env.GH_LOGIN;
    const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
    if (!login || !token) {
      console.error('Missing GH_LOGIN and/or a token (GH_TOKEN / GITHUB_TOKEN). Or use --demo / --fixture.');
      process.exit(1);
    }
    cal = await fetchCalendar(login, token);
    console.log(`[chords] fetched ${login} — ${cal.totalContributions} contributions`);
  }

  const shaped = shape(cal);
  mkdirSync(args.out, { recursive: true });
  for (const theme of Object.keys(PALETTES)) {
    const svg = renderChords(shaped, theme);
    const file = `${args.out}/chords-${theme}.svg`;
    writeFileSync(file, svg);
    console.log(`[chords] wrote ${file} (${(svg.length / 1024).toFixed(1)} KB)`);
  }
}

// Only run when invoked directly (allows importing synthCalendar/shape from tools).
import { pathToFileURL } from 'node:url';
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
