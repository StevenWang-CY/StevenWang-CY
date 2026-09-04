// Original project-card and streak presentation, restored from the profile's
// pre-redesign renderer. Live data and artwork fallbacks remain independent.
const esc = (value) => String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
const commaNumber = (value) => Number(value).toLocaleString("en-US");
const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function projectAlt(repo) {
  return [repo.name, repo.description,
    `${repo.stargazers_count} ${repo.stargazers_count === 1 ? "star" : "stars"}`, repo.language]
    .filter(Boolean).join(" — ");
}

const LANG_COLORS = {
  Python: "#3572A5",
  "Jupyter Notebook": "#DA5B0B",
  HTML: "#e34c26",
  CSS: "#663399",
  JavaScript: "#f1e05a",
  TypeScript: "#3178c6",
  "C++": "#f34b7d",
  C: "#555555",
  "C#": "#178600",
  Rust: "#dea584",
  Go: "#00ADD8",
  Java: "#b07219",
  Kotlin: "#A97BFF",
  Swift: "#F05138",
  Shell: "#89e051",
  MATLAB: "#e16737",
  Cuda: "#3A4E3A",
};

const STAR_PATH =
  "M8 .25a.75.75 0 0 1 .673.418l1.882 3.815 4.21.612a.75.75 0 0 1 .416 1.279l-3.046 2.97.719 4.192a.751.751 0 0 1-1.088.791L8 12.347l-3.766 1.98a.75.75 0 0 1-1.088-.79l.72-4.194L.818 6.374a.75.75 0 0 1 .416-1.28l4.21-.611L7.327.668A.75.75 0 0 1 8 .25Z";

function fmtPct(n) {
  return n.toFixed(3).replace(/\.?0+$/, "");
}

// Flipbook CSS: frame i is fully visible for its 1/F share of the
// cycle and hidden otherwise, with explicit 0% stops and near-instant
// (0.01%) snaps between stops — without a 0% stop browsers would tween
// opacity across the whole waiting period.
function flipbookCss(frameCount, cycleSec) {
  const EPS = 0.01;
  let css = `.gf{opacity:0;animation-duration:${cycleSec}s;animation-timing-function:linear;animation-iteration-count:infinite;animation-name:none}`;
  for (let i = 0; i < frameCount; i++) {
    const a = (i / frameCount) * 100;
    const b = ((i + 1) / frameCount) * 100;
    let kf;
    if (i === 0) {
      kf = `0%,${fmtPct(b)}%{opacity:1}${fmtPct(b + EPS)}%,100%{opacity:0}`;
    } else if (i === frameCount - 1) {
      kf = `0%,${fmtPct(a - EPS)}%{opacity:0}${fmtPct(a)}%,100%{opacity:1}`;
    } else {
      kf = `0%,${fmtPct(a - EPS)}%{opacity:0}${fmtPct(a)}%,${fmtPct(b)}%{opacity:1}${fmtPct(b + EPS)}%,100%{opacity:0}`;
    }
    css += `@keyframes g${i}{${kf}}.gf.g${i}{animation-name:g${i}}`;
  }
  return `${css}@media (prefers-reduced-motion:reduce){.gf{animation:none!important;opacity:0}.gf.g0{opacity:1}}`;
}

export function renderProjectCard(r, image) {
  const W = 846;
  const H = 212;
  const IMG_Y = (H - 164) / 2;
  const META_BASELINE = H - 27;
  const FONT = "Cambria, Georgia, 'Times New Roman', serif";
  const langColor = LANG_COLORS[r.language] ?? "#8b949e";
  const stars = r.stargazers_count;

  let imagePart = "";
  let flipCss = "";
  if (image) {
    const box = `x="502" y="${IMG_Y}" width="328" height="164"`;
    const clip = `  <clipPath id="hero"><rect ${box} rx="6"/></clipPath>`;
    const frameRect = `  <rect class="frame" x="502.5" y="${IMG_Y + 0.5}" width="327" height="163" rx="6"/>`;
    if (image.kind === "anim") {
      flipCss = flipbookCss(image.frames.length, image.cycleSec);
      const layers = image.frames
        .map(
          (b64, i) =>
            `    <image class="gf g${i}" ${box} preserveAspectRatio="xMidYMid slice" href="data:${image.mime};base64,${b64}"/>`,
        )
        .join("\n");
      imagePart = [clip, `  <g clip-path="url(#hero)">`, layers, `  </g>`, frameRect].join("\n");
    } else {
      imagePart = [
        clip,
        `  <image ${box} preserveAspectRatio="xMidYMid slice" clip-path="url(#hero)" href="data:${image.mime};base64,${image.base64}"/>`,
        frameRect,
      ].join("\n");
    }
  }

  const langPart = r.language
    ? [
        `  <circle cx="122" cy="${META_BASELINE - 5}" r="6" fill="${langColor}"/>`,
        `  <text class="meta" x="134" y="${META_BASELINE}">${esc(r.language)}</text>`,
      ].join("\n")
    : "";
  const cardDescription = [
    `${r.name} featured project card.`,
    r.profileHeroPath ? `Hero source: ${r.profileHeroPath}.` : "",
  ].filter(Boolean).join(" ");

  return `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" fill="none" xmlns="http://www.w3.org/2000/svg" role="img" data-project="${esc(r.name)}" data-stars="${stars}">
  <title>${esc(projectAlt(r))}</title>
  <desc>${esc(cardDescription)}</desc>
  <style>
    text, div { font-family: ${FONT}; }
    .card { fill: #ffffff; stroke: #d1d9e0; }
    .frame { fill: none; stroke: #d1d9e0; }
    .name { fill: #0969da; font-size: 22px; font-weight: 700; }
    .desc { font-family: ${FONT}; font-size: 15px; line-height: 1.5; color: #59636e; margin: 0; overflow: hidden; overflow-wrap: anywhere; max-height: 90px; }
    .meta { fill: #59636e; font-size: 14px; }
    .star { fill: #59636e; }
    @media (prefers-color-scheme: dark) {
      .card { fill: #161b22; stroke: #3d444d; }
      .frame { stroke: #3d444d; }
      .name { fill: #4493f8; }
      .desc { color: #9198a1; }
      .meta { fill: #9198a1; }
      .star { fill: #9198a1; }
    }
    ${flipCss}
  </style>
  <rect class="card" x="0.5" y="0.5" width="${W - 1}" height="${H - 1}" rx="8"/>
  <text class="name" x="28" y="48">${esc(r.name)}</text>
  <foreignObject x="28" y="64" width="440" height="94">
    <div xmlns="http://www.w3.org/1999/xhtml" class="desc">${esc(r.description ?? "")}</div>
  </foreignObject>
  <g transform="translate(28, ${META_BASELINE - 17})"><path class="star" d="${STAR_PATH}"/></g>
  <text class="meta" x="50" y="${META_BASELINE}">${stars}</text>
${langPart}
${imagePart}
</svg>
`;
}

function pengDate(value, includeYear = false) {
  const [year, month, day] = value.split("-").map(Number);
  return `${MONTH_NAMES[month - 1]} ${day}${includeYear ? `, ${year}` : ""}`;
}

function pengRange(start, end, profileDate) {
  if (!start || !end) return pengDate(profileDate);
  if (start === end) return pengDate(start);
  const spansYears = start.slice(0, 4) !== end.slice(0, 4);
  return `${pengDate(start, spansYears)} - ${pengDate(end, spansYears)}`;
}

// Visual geometry and animation timings follow the MIT-licensed default card
// used by Peng. See THIRD_PARTY_NOTICES.md for source and license details.
export function renderContributionStats(stats, theme, { userName, profileDate }) {
  const dark = theme === "dark";
  const background = dark ? "#151515" : "#FFFEFE";
  const primary = dark ? "#FEFEFE" : "#151515";
  const muted = dark ? "#9E9E9E" : "#464646";
  const divider = "#E4E2E2";
  const accent = "#FB8C00";
  const totalRange = stats.firstActiveDate
    ? `${pengDate(stats.firstActiveDate, true)} - Present`
    : "No contributions yet";
  const currentRange = pengRange(stats.currentStartDate, stats.currentEndDate, profileDate);
  const longestRange = pengRange(stats.longestStartDate, stats.longestEndDate, profileDate);
  const description = [
    `${userName} GitHub streak statistics.`,
    `${commaNumber(stats.total)} total contributions.`,
    `${stats.currentStreak}-day current streak.`,
    `${stats.longestStreak}-day longest streak.`,
  ].join(" ");

  return `<svg xmlns='http://www.w3.org/2000/svg' style='isolation: isolate' viewBox='0 0 495 195' width='495px' height='195px' direction='ltr' role='img' data-total='${stats.total}' data-current-streak='${stats.currentStreak}' data-longest-streak='${stats.longestStreak}' data-as-of='${profileDate}'>
  <title>GitHub streak statistics</title>
  <desc>${esc(description)}</desc>
  <style>
    @keyframes currstreak {
      0% { font-size: 3px; opacity: 0.2; }
      80% { font-size: 34px; opacity: 1; }
      100% { font-size: 28px; opacity: 1; }
    }
    @keyframes fadein {
      0% { opacity: 0; }
      100% { opacity: 1; }
    }
    @media (prefers-reduced-motion: reduce) {
      [style*='animation'] { animation: none !important; opacity: 1 !important; }
    }
  </style>
  <defs>
    <clipPath id='outer_rectangle'>
      <rect width='495' height='195' rx='4.5'/>
    </clipPath>
    <mask id='mask_out_ring_behind_fire'>
      <rect width='495' height='195' fill='white'/>
      <ellipse cx='247.5' cy='32' rx='13' ry='18' fill='black'/>
    </mask>
  </defs>
  <g clip-path='url(#outer_rectangle)'>
    <rect stroke='#000000' stroke-opacity='0' fill='${background}' rx='4.5' x='0.5' y='0.5' width='494' height='194'/>
    <line x1='165' y1='28' x2='165' y2='170' vector-effect='non-scaling-stroke' stroke-width='1' stroke='${divider}' stroke-linejoin='miter' stroke-linecap='square' stroke-miterlimit='3'/>
    <line x1='330' y1='28' x2='330' y2='170' vector-effect='non-scaling-stroke' stroke-width='1' stroke='${divider}' stroke-linejoin='miter' stroke-linecap='square' stroke-miterlimit='3'/>

    <g transform='translate(82.5, 48)'>
      <text x='0' y='32' text-anchor='middle' fill='${primary}' font-family='Segoe UI, Ubuntu, sans-serif' font-weight='700' font-size='28px' style='animation: fadein 0.5s linear 0.6s both'>${esc(commaNumber(stats.total))}</text>
    </g>
    <g transform='translate(82.5, 84)'>
      <text x='0' y='32' text-anchor='middle' fill='${primary}' font-family='Segoe UI, Ubuntu, sans-serif' font-weight='400' font-size='14px' style='animation: fadein 0.5s linear 0.7s both'>Total Contributions</text>
    </g>
    <g transform='translate(82.5, 114)'>
      <text x='0' y='32' text-anchor='middle' fill='${muted}' font-family='Segoe UI, Ubuntu, sans-serif' font-weight='400' font-size='12px' style='animation: fadein 0.5s linear 0.8s both'>${esc(totalRange)}</text>
    </g>

    <g transform='translate(247.5, 108)'>
      <text x='0' y='32' text-anchor='middle' fill='${accent}' font-family='Segoe UI, Ubuntu, sans-serif' font-weight='700' font-size='14px' style='animation: fadein 0.5s linear 0.9s both'>Current Streak</text>
    </g>
    <g transform='translate(247.5, 145)'>
      <text x='0' y='21' text-anchor='middle' fill='${muted}' font-family='Segoe UI, Ubuntu, sans-serif' font-weight='400' font-size='12px' style='animation: fadein 0.5s linear 0.9s both'>${esc(currentRange)}</text>
    </g>
    <g mask='url(#mask_out_ring_behind_fire)'>
      <circle cx='247.5' cy='71' r='40' fill='none' stroke='${accent}' stroke-width='5' style='animation: fadein 0.5s linear 0.4s both'/>
    </g>
    <g transform='translate(247.5, 19.5)' stroke-opacity='0' style='animation: fadein 0.5s linear 0.6s both'>
      <path d='M -12 -0.5 L 15 -0.5 L 15 23.5 L -12 23.5 L -12 -0.5 Z' fill='none'/>
      <path d='M 1.5 0.67 C 1.5 0.67 2.24 3.32 2.24 5.47 C 2.24 7.53 0.89 9.2 -1.17 9.2 C -3.23 9.2 -4.79 7.53 -4.79 5.47 L -4.76 5.11 C -6.78 7.51 -8 10.62 -8 13.99 C -8 18.41 -4.42 22 0 22 C 4.42 22 8 18.41 8 13.99 C 8 8.6 5.41 3.79 1.5 0.67 Z M -0.29 19 C -2.07 19 -3.51 17.6 -3.51 15.86 C -3.51 14.24 -2.46 13.1 -0.7 12.74 C 1.07 12.38 2.9 11.53 3.92 10.16 C 4.31 11.45 4.51 12.81 4.51 14.2 C 4.51 16.85 2.36 19 -0.29 19 Z' fill='${accent}'/>
    </g>
    <g transform='translate(247.5, 48)'>
      <text x='0' y='32' text-anchor='middle' fill='${primary}' font-family='Segoe UI, Ubuntu, sans-serif' font-weight='700' font-size='28px' style='animation: currstreak 0.6s linear forwards'>${esc(String(stats.currentStreak))}</text>
    </g>

    <g transform='translate(412.5, 48)'>
      <text x='0' y='32' text-anchor='middle' fill='${primary}' font-family='Segoe UI, Ubuntu, sans-serif' font-weight='700' font-size='28px' style='animation: fadein 0.5s linear 1.2s both'>${esc(String(stats.longestStreak))}</text>
    </g>
    <g transform='translate(412.5, 84)'>
      <text x='0' y='32' text-anchor='middle' fill='${primary}' font-family='Segoe UI, Ubuntu, sans-serif' font-weight='400' font-size='14px' style='animation: fadein 0.5s linear 1.3s both'>Longest Streak</text>
    </g>
    <g transform='translate(412.5, 114)'>
      <text x='0' y='32' text-anchor='middle' fill='${muted}' font-family='Segoe UI, Ubuntu, sans-serif' font-weight='400' font-size='12px' style='animation: fadein 0.5s linear 1.4s both'>${esc(longestRange)}</text>
    </g>
  </g>
</svg>
`;
}

// Artwork is optional presentation. If an upstream asset moves or is briefly
// unavailable, keep its last published poster while refreshing all live data.
export async function artworkWithFallback(load, previousSvg, warn = console.warn) {
  try {
    const image = await load();
    if (image) return image;
    throw new Error("no usable project image");
  } catch (error) {
    const match = /<image\b[^>]*\bhref="data:(image\/(?:png|jpeg));base64,([A-Za-z0-9+/=]+)"/.exec(previousSvg ?? "");
    if (match) {
      const bytes = Buffer.from(match[2], "base64");
      const valid = match[1] === "image/png"
        ? bytes.length >= 24 && bytes.subarray(0, 8).toString("hex") === "89504e470d0a1a0a"
        : bytes.length >= 4 && bytes.subarray(0, 2).toString("hex") === "ffd8" && bytes.subarray(-2).toString("hex") === "ffd9";
      if (valid && bytes.length <= 16 * 1024 * 1024) {
        warn(`Project artwork: ${error.message}; retaining the last published poster.`);
        return { kind: "static", mime: match[1], base64: match[2] };
      }
    }
    warn(`Project artwork: ${error.message}; rendering a text fallback.`);
    return null;
  }
}
