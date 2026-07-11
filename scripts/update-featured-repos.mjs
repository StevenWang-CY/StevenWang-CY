// Regenerates the Featured Repositories section: picks the top 2
// most-starred repos owned by the user (forks, archived repos, and the
// profile repo excluded; ties broken by most recent push), renders each
// as a fixed-layout SVG card (assets/featured-N.svg) with the repo's
// own README hero image embedded, and splices matching <a><img></a>
// tags between the FEATURED-REPOS markers in README.md.
//
// SVG cards are used because GitHub sanitizes CSS out of README HTML:
// fonts and absolute positioning only survive inside an <img>-embedded
// SVG. Consequences: images must be base64-embedded (the CSP on
// raw.githubusercontent blocks external loads inside SVGs). A data-URI
// gif renders as a static frame in an SVG, so animated gifs are coalesced,
// sampled by elapsed time, and rebuilt as a CSS flipbook. Static images
// are normalized to a crisp 2x poster with ImageMagick (always on CI).
//
// Usage: node scripts/update-featured-repos.mjs <github_user_name>

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const [, , userName] = process.argv;

if (!userName) {
  console.error("usage: update-featured-repos.mjs <github_user_name>");
  process.exit(1);
}
if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(userName)) {
  throw new Error(`invalid GitHub user name: ${userName}`);
}

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const assetsDir = path.join(repoRoot, "assets");
const readmeFile = path.join(repoRoot, "README.md");

const token = process.env.GITHUB_TOKEN;
const imageProcessEnv = { ...process.env };
delete imageProcessEnv.GITHUB_TOKEN;
delete imageProcessEnv.GH_TOKEN;
const apiHeaders = {
  "User-Agent": userName,
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
  ...(token ? { Authorization: `Bearer ${token}` } : {}),
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);
const FETCH_TIMEOUT_MS = 15_000;
const MAX_IMAGE_BYTES = 16 * 1024 * 1024;
const ALLOWED_IMAGE_TYPES = new Set([
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/svg+xml",
  "image/webp",
]);

async function fetchWithRetry(url, options = {}) {
  let lastError;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetch(url, {
        ...options,
        signal: options.signal ?? AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      const retryable =
        RETRYABLE_STATUS.has(response.status) ||
        (response.status === 403 && response.headers.has("retry-after"));
      if (!retryable || attempt === 2) return response;
      lastError = new Error(`HTTP ${response.status} from ${url}`);
      if (response.body) await response.body.cancel().catch(() => {});
    } catch (error) {
      lastError = error;
      if (attempt === 2) throw error;
    }
    await sleep(300 * 2 ** attempt);
  }
  throw lastError;
}

async function readBodyLimited(response, limit) {
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => {});
      throw new Error(`response body exceeds ${limit} bytes`);
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, total);
}

const repos = [];
for (let page = 1; ; page++) {
  const res = await fetchWithRetry(
    `https://api.github.com/users/${encodeURIComponent(userName)}/repos?per_page=100&type=owner&page=${page}`,
    { headers: apiHeaders },
  );
  if (!res.ok) throw new Error(`GitHub API ${res.status}: ${await res.text()}`);
  const batch = await res.json();
  repos.push(...batch);
  if (batch.length < 100) break;
}

const top = repos
  .filter(
    (r) =>
      !r.fork &&
      !r.archived &&
      r.name.toLowerCase() !== userName.toLowerCase(),
  )
  .sort(
    (a, b) =>
      b.stargazers_count - a.stargazers_count ||
      new Date(b.pushed_at) - new Date(a.pushed_at) ||
      a.name.localeCompare(b.name),
  )
  .slice(0, 2);

if (top.length === 0) throw new Error("no eligible repos found");

const esc = (s) =>
  s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
const escAttr = (s) => esc(s).replaceAll('"', "&quot;");

function writeFileAtomic(file, content) {
  const temporary = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(temporary, content);
  fs.renameSync(temporary, file);
}

// ---------------------------------------------------------------------------
// Hero image: first image in the repo's README, gifs preferred, then
// raster screenshots, then anything else; GitHub's OpenGraph card as
// fallback. Returns raw bytes ready for embedding, or null.
// ---------------------------------------------------------------------------

async function heroImageUrl(r) {
  const fallback = `https://opengraph.githubassets.com/1/${userName}/${r.name}`;

  let rd;
  try {
    rd = await fetchWithRetry(
      `https://api.github.com/repos/${encodeURIComponent(userName)}/${encodeURIComponent(r.name)}/readme`,
      { headers: apiHeaders },
    );
  } catch (error) {
    console.error(`README lookup failed for ${r.name}: ${error.message}`);
    return fallback;
  }
  if (!rd.ok) return fallback;
  const { content, path: readmePath = "README.md" } = await rd.json();
  const text = Buffer.from(content, "base64").toString("utf8");

  const urls = [];
  const htmlImage = /<(?:img|source)[^>]*\b(?:src|srcset)\s*=\s*["']([^"']+)["']/gi;
  let m;
  while ((m = htmlImage.exec(text)) !== null) {
    const firstSrc = m[1].trim().split(/\s*,\s*|\s+/)[0];
    urls.push(firstSrc.replaceAll("&amp;", "&"));
  }
  const markdownImage = /!\[[^\]]*\]\((?:<([^>]+)>|([^)\s]+))/g;
  while ((m = markdownImage.exec(text)) !== null) {
    urls.push((m[1] ?? m[2]).replaceAll("&amp;", "&"));
  }

  // Status badges are useful in a README but make poor card artwork.
  const isBadge = (u) =>
    /(?:^|\/\/)(?:img\.shields\.io|badgen\.net|badge\.fury\.io|codecov\.io|coveralls\.io)\//i.test(u) ||
    /\/actions\/workflows\/[^/]+\/badge\.svg(?:\?|$)/i.test(u);
  const candidates = urls.filter((u) => !isBadge(u));
  if (candidates.length === 0) return fallback;

  const rank = (u) => {
    const p = u.split("?")[0].toLowerCase();
    if (p.endsWith(".gif")) return 0;
    if (/(?:^|[\/_-])(hero|banner|cover|header)(?:[\/_-]|\.)/.test(p)) return 1;
    if (/\.(png|jpe?g|webp)$/.test(p)) return 2;
    return 3;
  };
  const best = candidates
    .map((u, i) => ({ u, i }))
    .sort((a, b) => rank(a.u) - rank(b.u) || a.i - b.i)[0].u;

  if (/^https?:\/\//.test(best)) return best;
  const clean = best.split(/[?#]/, 1)[0];
  const relative = clean.replace(/^\.\//, "");
  const repoPath = clean.startsWith("/")
    ? clean.slice(1)
    : path.posix.normalize(path.posix.join(path.posix.dirname(readmePath), relative));
  const encodedPath = repoPath.split("/").map(encodeURIComponent).join("/");
  return `https://raw.githubusercontent.com/${encodeURIComponent(userName)}/${encodeURIComponent(r.name)}/${encodeURIComponent(r.default_branch)}/${encodedPath}`;
}

function imageMagick() {
  for (const bin of ["magick", "convert"]) {
    try {
      execFileSync(bin, ["-version"], {
        stdio: "pipe",
        timeout: 5_000,
        env: imageProcessEnv,
      });
      return bin;
    } catch {
      /* not available */
    }
  }
  return null;
}

const IM = imageMagick();
const IM_OPTIONS = {
  stdio: "pipe",
  timeout: 90_000,
  maxBuffer: 64 * 1024 * 1024,
  env: {
    ...imageProcessEnv,
    MAGICK_MEMORY_LIMIT: "768MiB",
    MAGICK_MAP_LIMIT: "2GiB",
    MAGICK_DISK_LIMIT: "4GiB",
    MAGICK_THREAD_LIMIT: "2",
    MAGICK_TIME_LIMIT: "90",
  },
};
// Rendered at 2x the on-card 328x164 box for crisp display.
const POSTER_W = 656;
const POSTER_H = 328;
// Animated gifs become a CSS flipbook: up to this many frames sampled
// evenly across the animation, embedded as JPEGs and cycled with
// keyframes (a data-URI gif inside an SVG <image> renders frozen, but
// CSS animation inside GitHub-served SVGs works).
const MAX_FLIP_FRAMES = 16;
const MAX_SOURCE_FRAMES = 300;

const resizeArgs = [
  "-resize", `${POSTER_W}x${POSTER_H}^`,
  "-gravity", "center",
  "-extent", `${POSTER_W}x${POSTER_H}`,
  "-strip",
];

function imIdentify(tmp, format) {
  return execFileSync(
    IM === "magick" ? "magick" : "identify",
    IM === "magick" ? ["identify", "-format", format, tmp] : ["-format", format, tmp],
    IM_OPTIONS,
  ).toString();
}

function plausibleHero(bytes, r) {
  if (!IM) return true;
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "hero-check-"));
  const tmp = path.join(workDir, "candidate");
  fs.writeFileSync(tmp, bytes);
  try {
    const [width, height] = imIdentify(tmp, "%w %h\n")
      .trim()
      .split(/\s+/, 2)
      .map(Number);
    const aspect = width / height;
    const plausible =
      Number.isFinite(aspect) &&
      width >= 320 &&
      height >= 120 &&
      width <= 4_000 &&
      height <= 2_500 &&
      width * height <= 10_000_000 &&
      aspect >= 1.25 &&
      aspect <= 3.2;
    if (!plausible) {
      console.error(
        `hero rejected for ${r.name}: ${width}x${height} is not a usable landscape crop`,
      );
    }
    return plausible;
  } catch (error) {
    console.error(`hero rejected for ${r.name}: cannot inspect image (${error.message})`);
    return false;
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

async function heroImageData(r) {
  const primary = await heroImageUrl(r);
  const fallback = `https://opengraph.githubassets.com/1/${userName}/${r.name}`;
  let downloaded;

  for (const url of new Set([primary, fallback])) {
    try {
      const resp = await fetchWithRetry(url, {
        headers: { "User-Agent": userName },
      });
      if (!resp.ok) {
        console.error(`hero download failed for ${r.name}: HTTP ${resp.status} from ${url}`);
        continue;
      }
      const mime = (resp.headers.get("content-type")?.split(";")[0] || "").toLowerCase();
      const declaredSize = Number(resp.headers.get("content-length"));
      if (!ALLOWED_IMAGE_TYPES.has(mime)) {
        console.error(`hero download rejected for ${r.name}: unsupported media type ${mime || "unknown"}`);
        if (resp.body) await resp.body.cancel().catch(() => {});
        continue;
      }
      if (Number.isFinite(declaredSize) && declaredSize > MAX_IMAGE_BYTES) {
        console.error(`hero download rejected for ${r.name}: image exceeds 16 MiB`);
        if (resp.body) await resp.body.cancel().catch(() => {});
        continue;
      }
      const bytes = await readBodyLimited(resp, MAX_IMAGE_BYTES);
      if (url !== fallback && !plausibleHero(bytes, r)) continue;
      downloaded = {
        bytes,
        mime,
      };
      break;
    } catch (error) {
      console.error(`hero download failed for ${r.name}: ${error.message}`);
    }
  }

  if (!downloaded) return null;
  const { bytes, mime } = downloaded;

  if (IM) {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "profile-card-"));
    const tmp = path.join(workDir, "source-image");
    const frameDir = path.join(workDir, "frames");
    fs.mkdirSync(frameDir);
    fs.writeFileSync(tmp, bytes);
    try {
      const frameCount = parseInt(imIdentify(tmp, "%n\n").trim().split("\n")[0], 10);

      if (
        mime === "image/gif" &&
        Number.isFinite(frameCount) &&
        frameCount > 1 &&
        frameCount <= MAX_SOURCE_FRAMES
      ) {
        // Real animation duration from per-frame delays (centiseconds).
        const delays = imIdentify(tmp, "%T\n")
          .trim()
          .split("\n")
          .map((d) => parseInt(d, 10) || 6);

        const normalizedDelays = Array.from(
          { length: frameCount },
          (_, i) => delays[i] || 6,
        );
        const totalDelay = normalizedDelays.reduce((a, b) => a + b, 0);
        const cycleSec = totalDelay / 100;
        const cumulative = [];
        normalizedDelays.reduce(
          (sum, delay, i) => (cumulative[i] = sum + delay),
          0,
        );
        const n = Math.min(MAX_FLIP_FRAMES, frameCount);
        const pickedIndices = Array.from({ length: n }, (_, i) => {
          const target = (i * totalDelay) / n;
          const frame = cumulative.findIndex((end) => end > target);
          return frame === -1 ? frameCount - 1 : frame;
        });
        const uniqueIndices = [...new Set(pickedIndices)].sort((a, b) => a - b);
        const keep = new Set(uniqueIndices);
        const deleteIndices = Array.from(
          { length: frameCount },
          (_, i) => i,
        ).filter((i) => !keep.has(i));

        // Coalesce composites the delta-patch frames into full images. Delete
        // unsampled frames before resizing/encoding so large GIFs remain bounded.
        execFileSync(
          IM,
          [
            tmp,
            "-coalesce",
            ...(deleteIndices.length
              ? ["-delete", deleteIndices.join(",")]
              : []),
            ...resizeArgs,
            "-quality", "80",
            path.join(frameDir, "f-%04d.jpg"),
          ],
          IM_OPTIONS,
        );
        const all = fs.readdirSync(frameDir).sort();
        if (all.length !== uniqueIndices.length) {
          throw new Error(
            `expected ${uniqueIndices.length} sampled frames, found ${all.length}`,
          );
        }
        const filesBySourceIndex = new Map(
          uniqueIndices.map((sourceIndex, i) => [sourceIndex, all[i]]),
        );
        const frames = pickedIndices.map((sourceIndex) =>
          fs.readFileSync(
            path.join(frameDir, filesBySourceIndex.get(sourceIndex)),
          ).toString("base64"),
        );
        console.log(
          `flipbook for ${r.name}: ${n}/${frameCount} frames, ${cycleSec.toFixed(1)}s cycle, via ${IM}`,
        );
        return { kind: "anim", mime: "image/jpeg", frames, cycleSec };
      }

      const poster = execFileSync(
        IM,
        [`${tmp}[0]`, ...resizeArgs, "png:-"],
        IM_OPTIONS,
      );
      console.log(`poster for ${r.name}: via ${IM}`);
      return { kind: "static", mime: "image/png", base64: poster.toString("base64") };
    } catch (e) {
      console.error(`poster extraction failed for ${r.name}: ${e.message}`);
    } finally {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  } else {
    console.log(`imagemagick unavailable; embedding raw image for ${r.name}`);
  }

  return { kind: "static", mime, base64: bytes.toString("base64") };
}

// ---------------------------------------------------------------------------
// Fixed-layout SVG card. Everything is absolutely positioned on an
// 846x212 canvas; Cambria (with serif fallbacks) for all text; light
// and dark palettes switch via prefers-color-scheme, matching how the
// README's <picture> blocks behave.
// ---------------------------------------------------------------------------

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

function svgCard(r, image) {
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

  return `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" fill="none" xmlns="http://www.w3.org/2000/svg">
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

// ---------------------------------------------------------------------------
// Write assets and splice the README block.
// ---------------------------------------------------------------------------

fs.mkdirSync(assetsDir, { recursive: true });

const images = await Promise.all(top.map(heroImageData));

const anchors = top.map((r, i) => {
  const relativeFile = `assets/featured-${i}.svg`;
  const file = path.join(repoRoot, relativeFile);
  const svg = svgCard(r, images[i]);
  if (!fs.existsSync(file) || fs.readFileSync(file, "utf8") !== svg) {
    writeFileAtomic(file, svg);
    console.log(`wrote ${relativeFile}`);
  }
  const alt = [
    r.name,
    r.description,
    `${r.stargazers_count} ${r.stargazers_count === 1 ? "star" : "stars"}`,
    r.language,
  ].filter(Boolean).join(" — ");
  return `<a href="${r.html_url}"><img alt="${escAttr(alt)}" src="https://raw.githubusercontent.com/${userName}/${userName}/main/${relativeFile}" width="846" /></a>`;
});

for (const file of fs.readdirSync(assetsDir)) {
  const match = /^featured-(\d+)\.svg$/.exec(file);
  if (match && Number(match[1]) >= top.length) {
    fs.rmSync(path.join(assetsDir, file));
    console.log(`removed stale assets/${file}`);
  }
}

const block = anchors.join("\n\n");

const readme = fs.readFileSync(readmeFile, "utf8");
const START = "<!-- FEATURED-REPOS:START -->";
const END = "<!-- FEATURED-REPOS:END -->";
const start = readme.indexOf(START);
const end = readme.indexOf(END);
if (
  start === -1 ||
  end === -1 ||
  end < start ||
  start !== readme.lastIndexOf(START) ||
  end !== readme.lastIndexOf(END)
)
  throw new Error("FEATURED-REPOS markers are missing, duplicated, or out of order");

const updated =
  readme.slice(0, start + START.length) + "\n" + block + "\n" + readme.slice(end);

if (updated !== readme) {
  writeFileAtomic(readmeFile, updated);
  console.log(
    "README.md updated:",
    top.map((r) => `${r.name} (${r.stargazers_count} stars)`).join(", "),
  );
} else {
  console.log("README.md already up to date");
}
