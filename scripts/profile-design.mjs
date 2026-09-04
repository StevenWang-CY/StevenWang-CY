// Repository-served SVGs: no remote fonts, scripts, or external image loads.
const SERIF = "Georgia, 'Times New Roman', serif";
const SANS = "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";
const MONO = "ui-monospace, SFMono-Regular, Consolas, monospace";

export const PALETTES = {
  light: { surface: "#FAF9F6", ink: "#292D30", muted: "#596168", line: "#DDDCD6", accent: "#856B47" },
  dark: { surface: "#121920", ink: "#E6E2D9", muted: "#A3ABB0", line: "#303A43", accent: "#C4AD87" },
};

export const escapeXml = (value) => String(value)
  .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;").replaceAll("'", "&apos;");

function wrap(text, limit) {
  const lines = [];
  for (const word of text.split(/\s+/)) {
    const last = lines.length - 1;
    if (last < 0 || `${lines[last]} ${word}`.length > limit) lines.push(word);
    else lines[last] += ` ${word}`;
  }
  return lines;
}

function themeCss() {
  const rules = (p) => `.surface{fill:${p.surface};stroke:${p.line}}.ink{fill:${p.ink}}.muted{fill:${p.muted}}.accent{fill:${p.accent}}.rule{stroke:${p.line}}`;
  return `${rules(PALETTES.light)}@media(prefers-color-scheme:dark){${rules(PALETTES.dark)}}`;
}

function flipbookCss(frameCount, cycleSec) {
  let css = `.gf{opacity:0;animation-duration:${cycleSec}s;animation-timing-function:steps(1,end);animation-iteration-count:infinite}`;
  for (let i = 0; i < frameCount; i++) {
    const start = (i / frameCount * 100).toFixed(4);
    const end = ((i + 1) / frameCount * 100).toFixed(4);
    css += `@keyframes frame${i}{0%{opacity:${i === 0 ? 1 : 0}}${start}%{opacity:1}${end}%{opacity:0}100%{opacity:0}}.g${i}{animation-name:frame${i}}`;
  }
  return `${css}@media(prefers-reduced-motion:reduce){.gf{animation:none;opacity:0}.g0{opacity:1}}`;
}

export function projectAlt(repo) {
  return [repo.profileTitle, repo.profileSummary,
    `${repo.stargazers_count} ${repo.stargazers_count === 1 ? "star" : "stars"}`, repo.language]
    .filter(Boolean).join(" — ");
}

export function renderProjectCard(repo, image, { mobile = false } = {}) {
  const W = mobile ? 400 : 846;
  const H = mobile ? 350 : 212;
  const textX = mobile ? 22 : 28;
  const imageX = mobile ? 22 : 502;
  const imageY = mobile ? 162 : 24;
  const imageW = mobile ? 356 : 328;
  const imageH = imageW / 2;
  const lines = wrap(repo.profileSummary, mobile ? 44 : 52);
  const title = escapeXml(projectAlt(repo));
  const box = `x="${imageX}" y="${imageY}" width="${imageW}" height="${imageH}"`;
  const frames = image?.kind === "anim" ? image.frames : image ? [image.base64] : [];
  const imageMarkup = frames.map((frame, index) =>
    `<image${frames.length > 1 ? ` class="gf g${index}"` : ""} ${box} preserveAspectRatio="xMidYMid meet" href="data:${image.mime};base64,${frame}"/>`).join("\n");
  const metaY = mobile ? 145 : 185;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-labelledby="title" data-project="${escapeXml(repo.name)}" data-stars="${repo.stargazers_count}">
  <title id="title">${title}</title>
  <desc>${escapeXml(repo.profileSummary)}</desc>
  <style>${themeCss()}
    text{font-family:${SANS}}.category{font-family:${MONO};font-size:10px;letter-spacing:1.5px}.name{font-family:${SERIF};font-size:30px}.summary{font-size:${mobile ? 14 : 16}px}.meta{font-family:${MONO};font-size:12px}
    ${frames.length > 1 ? flipbookCss(frames.length, image.cycleSec) : ""}
  </style>
  <rect class="surface" x="0.5" y="0.5" width="${W - 1}" height="${H - 1}" rx="6"/>
  <text class="category accent" x="${textX}" y="${mobile ? 26 : 31}">${escapeXml(repo.profileCategory)}</text>
  <text class="name ink" x="${textX}" y="${mobile ? 62 : 73}">${escapeXml(repo.profileTitle)}</text>
  ${lines.map((line, index) => `<text class="summary muted" x="${textX}" y="${(mobile ? 87 : 104) + index * (mobile ? 19 : 23)}">${escapeXml(line)}</text>`).join("\n  ")}
  <text class="meta muted" x="${textX}" y="${metaY}">☆ ${repo.stargazers_count} ${repo.stargazers_count === 1 ? "star" : "stars"}${repo.language ? ` · ${escapeXml(repo.language)}` : ""}</text>
  ${image ? `<defs><clipPath id="hero"><rect ${box} rx="3"/></clipPath></defs><g clip-path="url(#hero)">${imageMarkup}</g>` : `<text class="meta muted" x="${imageX + imageW / 2}" y="${imageY + imageH / 2}" text-anchor="middle">View repository ↗</text>`}
</svg>\n`;
}

function dateLabel(value, includeYear = false) {
  return new Intl.DateTimeFormat("en-US", {
    month: "short", day: "numeric", ...(includeYear ? { year: "numeric" } : {}), timeZone: "UTC",
  }).format(new Date(`${value}T00:00:00Z`));
}

function dateRange(start, end) {
  if (!start || !end) return "No active streak";
  if (start === end) return dateLabel(start);
  const years = start.slice(0, 4) !== end.slice(0, 4);
  return `${dateLabel(start, years)} – ${dateLabel(end, years)}`;
}

export function renderContributionStats(stats, theme, { mobile = false, userName, profileDate } = {}) {
  const p = PALETTES[theme];
  const W = mobile ? 400 : 846;
  const H = mobile ? 214 : 132;
  const cells = [
    { value: stats.total.toLocaleString("en-US"), label: "Total contributions", range: stats.firstActiveDate ? `Since ${dateLabel(stats.firstActiveDate, true)}` : "No contributions yet" },
    { value: String(stats.currentStreak), label: "Current streak · days", range: dateRange(stats.currentStartDate, stats.currentEndDate) },
    { value: String(stats.longestStreak), label: "Longest streak · days", range: dateRange(stats.longestStartDate, stats.longestEndDate) },
  ];
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-labelledby="title" data-total="${stats.total}" data-current-streak="${stats.currentStreak}" data-longest-streak="${stats.longestStreak}" data-as-of="${profileDate}">
  <title id="title">${escapeXml(userName)} GitHub contribution statistics</title>
  <desc>${stats.total.toLocaleString("en-US")} total contributions. ${stats.currentStreak}-day current streak. ${stats.longestStreak}-day longest streak.</desc>
  <style>text{font-family:${SANS};text-anchor:middle}.number{font-family:${SERIF};font-size:38px;fill:${p.ink}}.label{font-size:14px;fill:${p.ink}}.range{font-size:12px;fill:${p.muted}}</style>
  <path d="M0 .5H${W}M0 ${H - .5}H${W}${mobile ? "M200 118V197" : "M282 25V107M564 25V107"}" fill="none" stroke="${p.line}"/>
  ${cells.map((cell, index) => {
    const x = mobile ? index === 0 ? 200 : index === 1 ? 100 : 300 : 141 + index * 282;
    const y = mobile ? index === 0 ? 42 : 147 : 51;
    return `<g data-metric="${index}"><text class="number" x="${x}" y="${y}">${cell.value}</text><text class="label" x="${x}" y="${y + 25}">${cell.label}</text><text class="range" x="${x}" y="${y + 46}">${escapeXml(cell.range)}</text></g>`;
  }).join("\n  ")}
</svg>\n`;
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
