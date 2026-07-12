// Adds a CSS-only contribution counter to Platane/snk's SVG output. The
// counter shares the snake's own animation duration and changes at each cell's
// completed-disappearance keyframe, adding that day's exact public count.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  loadPublicContributions,
  writePublicContributionsSnapshot,
} from "./public-contributions.mjs";

const COUNTER_REVISION = "r3";
const COUNTER_LINE_HEIGHT = 18;
const MAX_SVG_BYTES = 1024 * 1024;
const OUTPUT_SVG_MAX_BYTES = 256 * 1024;
const OLD_BOX = 'viewBox="-16 -32 880 192" width="880" height="192"';
const NEW_BOX = 'viewBox="-16 -32 880 194" width="880" height="194"';

const commaNumber = (value) =>
  String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ",");

function atomicWrite(file, content) {
  const temporary = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(temporary, content);
  fs.renameSync(temporary, file);
}

function parseProfileDate(cacheKey) {
  if (!new RegExp(`^\\d{8}-${COUNTER_REVISION}$`).test(cacheKey)) {
    throw new Error(`invalid profile cache key: ${cacheKey}`);
  }
  const year = Number(cacheKey.slice(0, 4));
  const month = Number(cacheKey.slice(4, 6));
  const day = Number(cacheKey.slice(6, 8));
  const profileDate = new Date(Date.UTC(year, month - 1, day));
  if (
    profileDate.getUTCFullYear() !== year ||
    profileDate.getUTCMonth() !== month - 1 ||
    profileDate.getUTCDate() !== day
  ) {
    throw new Error(`invalid profile cache-key date: ${cacheKey}`);
  }
  return profileDate;
}

function normalizeGeometry(source, file) {
  if (source.includes('id="snake-contribution-counter"')) {
    throw new Error(`${file}: contribution counter already exists`);
  }
  const stackRect = /<rect class="u [^"]+"[^>]*\/>/g;
  const segments = source.match(stackRect) ?? [];
  if (segments.length < 1) {
    throw new Error(`${file}: contribution progress bar is missing`);
  }
  const oldBoxCount = source.split(OLD_BOX).length - 1;
  const newBoxCount = source.split(NEW_BOX).length - 1;
  if (!((oldBoxCount === 1 && newBoxCount === 0) || (oldBoxCount === 0 && newBoxCount === 1))) {
    throw new Error(`${file}: unexpected snake canvas geometry`);
  }
  const oldSegments = segments.filter((segment) => segment.includes('y="144"'));
  const newSegments = segments.filter((segment) => segment.includes('y="132"'));
  if (
    !(
      (oldSegments.length === segments.length && newSegments.length === 0) ||
      (newSegments.length === segments.length && oldSegments.length === 0)
    )
  ) {
    throw new Error(`${file}: progress-bar segments have mixed geometry`);
  }

  let normalized = source;
  if (oldBoxCount === 1) normalized = normalized.replace(OLD_BOX, NEW_BOX);
  if (oldSegments.length === segments.length) {
    normalized = normalized.replace(stackRect, (segment) =>
      segment.replace('y="144"', 'y="132"'),
    );
  }
  const movedSegments = normalized.match(stackRect) ?? [];
  if (
    normalized.split(NEW_BOX).length - 1 !== 1 ||
    movedSegments.length !== segments.length ||
    movedSegments.some((segment) => !segment.includes('y="132"'))
  ) {
    throw new Error(`${file}: failed to normalize snake geometry`);
  }
  return normalized;
}

export function buildCounterStates(baseline, events, expectedFinal) {
  if (!Number.isSafeInteger(baseline) || baseline < 0 || !Array.isArray(events)) {
    throw new Error("invalid counter-state input");
  }
  const states = [
    { total: baseline, delta: 0, date: "", at: "0", step: 0 },
  ];
  let total = baseline;
  for (const event of events) {
    if (
      !Number.isSafeInteger(event.count) ||
      event.count < 1 ||
      !/^\d{4}-\d{2}-\d{2}$/.test(event.date) ||
      !Number.isFinite(event.after) ||
      event.after <= 0 ||
      event.after >= 100 ||
      !Number.isSafeInteger(event.step) ||
      event.step < 1
    ) {
      throw new Error("invalid contribution-counter event");
    }
    total += event.count;
    if (!Number.isSafeInteger(total)) {
      throw new Error("contribution counter exceeds the safe integer range");
    }
    states.push({
      total,
      delta: event.count,
      date: event.date,
      at: event.afterText,
      step: event.step,
    });
  }
  if (total !== expectedFinal) {
    throw new Error(`counter final total mismatch (${total}/${expectedFinal})`);
  }
  return states;
}

function counterSelfTest() {
  const events = [
    { count: 2, date: "2026-01-01", after: 10, afterText: "10", step: 1 },
    { count: 3, date: "2026-01-02", after: 20, afterText: "20", step: 2 },
    { count: 1, date: "2026-01-03", after: 30, afterText: "30", step: 3 },
  ];
  const totals = buildCounterStates(100, events, 106).map((state) => state.total);
  if (totals.join(",") !== "100,102,105,106" || totals[2] - totals[1] !== 3) {
    throw new Error("counter arithmetic self-test failed");
  }
}

function analyzeSnake(source, file, contributionData) {
  if (Buffer.byteLength(source) > MAX_SVG_BYTES) {
    throw new Error(`${file}: input SVG exceeds ${MAX_SVG_BYTES} bytes`);
  }
  if (
    /<!DOCTYPE|<!ENTITY|<\s*(?:script|foreignObject|image|use|a|animate|set)\b|\s+on[a-z]+\s*=|(?:href|xlink:href)\s*=|@import|javascript:|data:/i.test(
      source,
    )
  ) {
    throw new Error(`${file}: unsafe SVG content`);
  }
  const styleMatch = /<style>([\s\S]*?)<\/style>/.exec(source);
  if (!styleMatch || source.match(/<style>/g)?.length !== 1) {
    throw new Error(`${file}: expected exactly one style element`);
  }
  const style = styleMatch[1];
  const durations = [
    ...style.matchAll(/animation:none(?: linear)? (\d+)ms(?: linear)? infinite/g),
  ].map((match) => Number(match[1]));
  if (
    durations.length !== 3 ||
    new Set(durations).size !== 1 ||
    durations[0] < 1_000 ||
    durations[0] > 120_000 ||
    durations[0] % 100 !== 0
  ) {
    throw new Error(`${file}: snake animation duration is invalid`);
  }
  const duration = durations[0];
  const routeSteps = duration / 100;
  const stackCss = [
    ...style.matchAll(/@keyframes u[A-Za-z0-9]+\{([\s\S]*?)\}\.u\./g),
  ]
    .map((match) => match[1])
    .join("");
  if (!stackCss) {
    throw new Error(`${file}: contribution progress-bar animation is missing`);
  }

  const gridByCoordinate = new Map(
    contributionData.gridDays.map((day) => [`${day.x},${day.y}`, day]),
  );
  const seenCoordinates = new Set();
  const events = [];
  const rectPattern = /<rect class="c(?: ([A-Za-z0-9]+))?" x="([\d.]+)" y="([\d.]+)" rx="2" ry="2"\/>/g;
  let rect;
  while ((rect = rectPattern.exec(source)) !== null) {
    const classId = rect[1] ?? "";
    const rawX = Number(rect[2]);
    const rawY = Number(rect[3]);
    const x = (rawX - 2) / 16;
    const y = (rawY - 2) / 16;
    const coordinate = `${x},${y}`;
    const day = gridByCoordinate.get(coordinate);
    if (
      !Number.isSafeInteger(x) ||
      !Number.isSafeInteger(y) ||
      !day ||
      seenCoordinates.has(coordinate)
    ) {
      throw new Error(`${file}: snake cell geometry does not match GitHub's grid`);
    }
    seenCoordinates.add(coordinate);
    if ((day.contributionCount > 0) !== Boolean(classId)) {
      throw new Error(`${file}: active snake cell differs from GitHub at ${day.date}`);
    }
    if (!classId) continue;

    const escapedId = classId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const classRule = new RegExp(
      `\\.c\\.${escapedId}\\{fill:var\\(--c([1-4])\\);animation-name:${escapedId}\\}`,
    ).exec(style);
    const level = Number(classRule?.[1]);
    if (!Number.isSafeInteger(level) || level < 1 || level > 4) {
      throw new Error(`${file}: contribution level is invalid at ${day.date}`);
    }
    const keyframes = new RegExp(
      `@keyframes ${escapedId}\\{([\\d.]+)%\\{fill:var\\(--c${level}\\)\\}([\\d.]+)%,100%\\{fill:var\\(--ce\\)\\}\\}`,
    ).exec(style);
    const beforeText = keyframes?.[1];
    const afterText = keyframes?.[2];
    const before = Number(beforeText);
    const after = Number(afterText);
    const midpoint = (before + after) / 2;
    const step = Math.round((midpoint / 100) * routeSteps);
    const expectedMidpoint = (step / routeSteps) * 100;
    if (
      !Number.isFinite(before) ||
      !Number.isFinite(after) ||
      before < 0 ||
      after <= before ||
      after >= 100 ||
      step < 1 ||
      step >= routeSteps ||
      Math.abs(midpoint - expectedMidpoint) > 0.011 ||
      !stackCss.includes(`${beforeText}%`) ||
      !stackCss.includes(`${afterText}%`)
    ) {
      throw new Error(`${file}: invalid swallow timing for ${day.date}`);
    }
    events.push({
      id: classId,
      x,
      y,
      date: day.date,
      count: day.contributionCount,
      level,
      before,
      beforeText,
      after,
      afterText,
      step,
    });
  }
  if (seenCoordinates.size !== contributionData.gridDays.length) {
    throw new Error(
      `${file}: snake grid is truncated (${seenCoordinates.size}/${contributionData.gridDays.length})`,
    );
  }
  events.sort((left, right) => left.step - right.step);
  if (
    events.length < 1 ||
    new Set(events.map((event) => event.step)).size !== events.length ||
    new Set(events.map((event) => event.afterText)).size !== events.length
  ) {
    throw new Error(`${file}: swallow events are missing or duplicated`);
  }
  const eventTotal = events.reduce((sum, event) => sum + event.count, 0);
  if (eventTotal !== contributionData.gridTotal) {
    throw new Error(`${file}: swallowed contribution total is incomplete`);
  }
  const baseline = contributionData.totalContributions - contributionData.gridTotal;
  if (!Number.isSafeInteger(baseline) || baseline < 0) {
    throw new Error(`${file}: contribution baseline is invalid`);
  }
  const states = buildCounterStates(
    baseline,
    events,
    contributionData.totalContributions,
  );
  return { duration, routeSteps, events, states, baseline };
}

function counterCss(analysis, dark) {
  const finalOffset = (analysis.states.length - 1) * COUNTER_LINE_HEIGHT;
  const primary = dark ? "#FEFEFE" : "#151515";
  const muted = dark ? "#9E9E9E" : "#464646";
  const frames = ["0%{transform:translateY(0px)}"];
  for (let index = 0; index < analysis.events.length; index += 1) {
    frames.push(
      `${analysis.events[index].afterText}%{transform:translateY(-${(index + 1) * COUNTER_LINE_HEIGHT}px)}`,
    );
  }
  frames.push(`100%{transform:translateY(-${finalOffset}px)}`);
  return `.snk-counter-label{fill:${muted};font:400 11px 'Segoe UI',Ubuntu,sans-serif}.snk-counter-value{fill:${primary};font:700 14px 'Segoe UI',Ubuntu,sans-serif}.snk-counter-values{transform:translateY(-${finalOffset}px);animation:snk-counter ${analysis.duration}ms steps(1,end) infinite}@keyframes snk-counter{${frames.join("")}}@media (prefers-reduced-motion:reduce){.c,.u,.s,.snk-counter-values{animation:none!important}.u{transform:scale(1,1)!important}.s{display:none}.snk-counter-values{transform:translateY(-${finalOffset}px)!important}}`;
}

function counterMarkup(analysis, contributionData) {
  const values = analysis.states
    .map(
      (state, index) =>
        `<text class="snk-counter-value" x="764" y="${126 + index * COUNTER_LINE_HEIGHT}" text-anchor="end" data-total="${state.total}" data-delta="${state.delta}" data-date="${state.date}" data-at="${state.at}" data-step="${state.step}">${commaNumber(state.total)}</text>`,
    )
    .join("");
  const aria =
    `Animated contribution total from ${analysis.baseline} to ${contributionData.totalContributions}; ` +
    "each swallowed day adds that day's public contribution count";
  return `<defs><clipPath id="snake-counter-window"><rect x="676" y="112" width="90" height="17"/></clipPath></defs><g id="snake-contribution-counter" role="img" aria-label="${aria}" data-start-total="${analysis.baseline}" data-final-total="${contributionData.totalContributions}" data-grid-total="${contributionData.gridTotal}" data-event-count="${analysis.events.length}" data-duration-ms="${analysis.duration}"><text class="snk-counter-label" x="772" y="126">contributions</text><g clip-path="url(#snake-counter-window)" aria-hidden="true"><g class="snk-counter-values">${values}</g></g></g>`;
}

function enhanceSnake(source, file, contributionData) {
  const normalized = normalizeGeometry(source, file);
  const analysis = analyzeSnake(normalized, file, contributionData);
  const isLight = normalized.includes("--ce:#ebedf0");
  const isDark = normalized.includes("--ce:#161b22");
  if (isLight === isDark) {
    throw new Error(`${file}: expected exactly one GitHub light/dark palette`);
  }
  const css = counterCss(analysis, isDark);
  const markup = counterMarkup(analysis, contributionData);
  const description =
    `<desc>Generated with https://github.com/Platane/snk. ` +
    `The synchronized public contribution counter starts at ${analysis.baseline}, ` +
    `adds each swallowed day's exact count, and reaches ${contributionData.totalContributions}.</desc>`;
  const output = normalized
    .replace(
      "<desc>Generated with https://github.com/Platane/snk</desc>",
      description,
    )
    .replace("</style>", `${css}</style>`)
    .replace("</svg>", `${markup}</svg>`);
  if (
    !output.includes('id="snake-contribution-counter"') ||
    !output.includes("@keyframes snk-counter") ||
    Buffer.byteLength(output) > OUTPUT_SVG_MAX_BYTES
  ) {
    throw new Error(`${file}: enhanced SVG is incomplete or too large`);
  }
  const signature = JSON.stringify({
    duration: analysis.duration,
    events: analysis.events.map(({ date, count, level, afterText, step }) => ({
      date,
      count,
      level,
      afterText,
      step,
    })),
    totals: analysis.states.map((state) => state.total),
  });
  return { output, analysis, signature };
}

async function main() {
  counterSelfTest();
  const [, , userName, cacheKey, snapshotPath, ...svgFiles] = process.argv;
  if (!userName || !cacheKey || !snapshotPath || svgFiles.length !== 2) {
    throw new Error(
      "usage: node scripts/enhance-snake.mjs <github-user> <YYYYMMDD-r3> <snapshot.json> <light.svg> <dark.svg>",
    );
  }
  const profileDate = parseProfileDate(cacheKey);
  const contributionData = await loadPublicContributions({
    userName,
    profileDate,
    token: process.env.GITHUB_TOKEN,
  });
  const prepared = svgFiles.map((file) => {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 2 || stat.size > MAX_SVG_BYTES) {
      throw new Error(`${file}: input SVG file is invalid`);
    }
    return {
      file,
      ...enhanceSnake(fs.readFileSync(file, "utf8"), file, contributionData),
    };
  });
  if (prepared[0].signature !== prepared[1].signature) {
    throw new Error("light and dark snake counter schedules differ");
  }
  for (const item of prepared) atomicWrite(item.file, item.output);
  writePublicContributionsSnapshot(
    snapshotPath,
    contributionData,
    userName,
    profileDate,
  );

  const example = prepared[0].analysis.events.find((event) => event.count === 3);
  const exampleIndex = example
    ? prepared[0].analysis.events.indexOf(example) + 1
    : -1;
  const before = exampleIndex > 0
    ? prepared[0].analysis.states[exampleIndex - 1].total
    : null;
  const after = exampleIndex > 0
    ? prepared[0].analysis.states[exampleIndex].total
    : null;
  console.log(
    `snake counter: ${prepared[0].analysis.events.length} swallowed days, ` +
      `${prepared[0].analysis.baseline} -> ${contributionData.totalContributions}, ` +
      `${prepared[0].analysis.duration}ms loop`,
  );
  if (example) {
    console.log(
      `verified +3 jump on ${example.date} at ${example.afterText}%: ${before} -> ${after}`,
    );
  }
  console.log(
    `wrote ${snapshotPath} and ${svgFiles.map((file) => path.basename(file)).join(", ")}`,
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
