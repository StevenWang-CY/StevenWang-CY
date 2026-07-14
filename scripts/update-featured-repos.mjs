// Regenerates the featured project section with one deliberately selected
// repository: AutoPaperLab. Its card always uses the generated paper architecture
// figure from the repository README, then splices the linked card between the
// FEATURED-REPOS markers in README.md. It also generates repository-served
// light/dark contribution statistics from GitHub's own annual calendars and
// keys snake/stat images by their live contribution total and the featured
// card by its live star count, so changed numbers invalidate GitHub's image
// cache immediately after a refresh run without no-op URL churn.
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
import { loadPublicContributions } from "./public-contributions.mjs";

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
// The date supplies a stable daily base; live star/contribution suffixes change
// rendered URLs within that day. The revision changes whenever the image
// contract changes so GitHub's image proxy cannot retain an older design.
const CACHE_REVISION = "r3";
const dailyCacheKey =
  process.env.PROFILE_CACHE_KEY ??
  `${new Date().toISOString().slice(0, 10).replaceAll("-", "")}-${CACHE_REVISION}`;
if (!new RegExp(`^\\d{8}-${CACHE_REVISION}$`).test(dailyCacheKey)) {
  throw new Error(`invalid PROFILE_CACHE_KEY: ${dailyCacheKey}`);
}
const cacheYear = Number(dailyCacheKey.slice(0, 4));
const cacheMonth = Number(dailyCacheKey.slice(4, 6));
const cacheDay = Number(dailyCacheKey.slice(6, 8));
const profileDate = new Date(Date.UTC(cacheYear, cacheMonth - 1, cacheDay));
if (
  profileDate.getUTCFullYear() !== cacheYear ||
  profileDate.getUTCMonth() !== cacheMonth - 1 ||
  profileDate.getUTCDate() !== cacheDay
) {
  throw new Error(`invalid PROFILE_CACHE_KEY date: ${dailyCacheKey}`);
}

const FEATURED_PROJECTS = [
  {
    name: "AutoPaperLab",
    heroPath: "docs/assets/paper_figure_architecture.png",
    heroMime: "image/png",
    heroSourceWidth: 1284,
    heroSourceHeight: 758,
    // Remove only the blank paper margins. This exact 2:1 crop keeps every
    // labeled component, the lower decision branch, and both figure legends.
    heroCrop: "1284x642+0+90",
  },
];

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
const MIN_EXPECTED_CONTRIBUTIONS = 2_000;
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

const featuredRepos = await Promise.all(
  FEATURED_PROJECTS.map(async (project) => {
    const res = await fetchWithRetry(
      `https://api.github.com/repos/${encodeURIComponent(userName)}/${encodeURIComponent(project.name)}`,
      { headers: apiHeaders },
    );
    if (!res.ok) {
      throw new Error(
        `GitHub API ${res.status} loading ${project.name}: ${await res.text()}`,
      );
    }
    const repo = await res.json();
    const expected = `${userName}/${project.name}`.toLowerCase();
    if (
      repo.full_name?.toLowerCase() !== expected ||
      repo.owner?.login?.toLowerCase() !== userName.toLowerCase() ||
      repo.name !== project.name ||
      !Number.isSafeInteger(repo.stargazers_count) ||
      repo.stargazers_count < 0
    ) {
      throw new Error(`GitHub returned an unexpected repository for ${project.name}`);
    }
    return {
      ...repo,
      profileHeroPath: project.heroPath,
      profileHeroMime: project.heroMime,
      profileHeroSourceWidth: project.heroSourceWidth,
      profileHeroSourceHeight: project.heroSourceHeight,
      profileHeroCrop: project.heroCrop,
    };
  }),
);

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

function readmeImageSources(text) {
  const urls = [];
  const htmlImage = /<(?:img|source)[^>]*\b(?:src|srcset)\s*=\s*["']([^"']+)["']/gi;
  let match;
  while ((match = htmlImage.exec(text)) !== null) {
    const firstSrc = match[1].trim().split(/\s*,\s*|\s+/)[0];
    urls.push(firstSrc.replaceAll("&amp;", "&"));
  }
  const markdownImage = /!\[[^\]]*\]\((?:<([^>]+)>|([^)\s]+))/g;
  while ((match = markdownImage.exec(text)) !== null) {
    urls.push((match[1] ?? match[2]).replaceAll("&amp;", "&"));
  }
  return urls;
}

function resolveReadmeImagePath(source, readmePath) {
  if (/^https?:\/\//.test(source)) return null;
  const clean = source.split(/[?#]/, 1)[0];
  const relative = clean.replace(/^\.\//, "");
  return clean.startsWith("/")
    ? clean.slice(1)
    : path.posix.normalize(path.posix.join(path.posix.dirname(readmePath), relative));
}

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

  const urls = readmeImageSources(text);

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
  const repoPath = resolveReadmeImagePath(best, readmePath);
  if (!repoPath) return fallback;
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

function heroResizeArgs(r) {
  if (!r.profileHeroCrop) return resizeArgs;
  const match = /^(\d+)x(\d+)\+(\d+)\+(\d+)$/.exec(r.profileHeroCrop);
  if (!match) throw new Error(`invalid hero crop for ${r.name}`);
  const [cropWidth, cropHeight, cropX, cropY] = match.slice(1).map(Number);
  if (
    !Number.isSafeInteger(r.profileHeroSourceWidth) ||
    !Number.isSafeInteger(r.profileHeroSourceHeight) ||
    cropWidth < 1 ||
    cropHeight < 1 ||
    cropX + cropWidth > r.profileHeroSourceWidth ||
    cropY + cropHeight > r.profileHeroSourceHeight ||
    cropWidth * POSTER_H !== cropHeight * POSTER_W
  ) {
    throw new Error(`hero crop is out of bounds or not 2:1 for ${r.name}`);
  }
  return [
    "-crop", r.profileHeroCrop,
    "+repage",
    "-resize", `${POSTER_W}x${POSTER_H}!`,
    "-strip",
  ];
}

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

const MONTH_NAMES = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

function isoDate(date) {
  return date.toISOString().slice(0, 10);
}

function commaNumber(value) {
  return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

async function contributionStatsData() {
  if (!token) {
    throw new Error("GITHUB_TOKEN is required to update contribution statistics");
  }
  const { days, totalContributions } = await loadPublicContributions({
    userName,
    profileDate,
    token,
    snapshotPath: process.env.PUBLIC_CONTRIBUTIONS_SNAPSHOT,
  });
  if (totalContributions < MIN_EXPECTED_CONTRIBUTIONS) {
    throw new Error(
      `GitHub returned only ${totalContributions} total contributions; refusing to replace a known 2,000+ profile total`,
    );
  }

  let currentEndIndex = days.length - 1;
  if (days[currentEndIndex]?.contributionCount === 0) currentEndIndex -= 1;
  let currentStartIndex = currentEndIndex;
  while (
    currentStartIndex >= 0 &&
    days[currentStartIndex].contributionCount > 0
  ) {
    currentStartIndex -= 1;
  }
  currentStartIndex += 1;
  const currentStreak = Math.max(0, currentEndIndex - currentStartIndex + 1);

  let longestStreak = 0;
  let longestStartIndex = -1;
  let longestEndIndex = -1;
  let runStartIndex = -1;
  for (let i = 0; i < days.length; i += 1) {
    if (days[i].contributionCount > 0) {
      if (runStartIndex === -1) runStartIndex = i;
      const runLength = i - runStartIndex + 1;
      if (runLength > longestStreak) {
        longestStreak = runLength;
        longestStartIndex = runStartIndex;
        longestEndIndex = i;
      }
    } else {
      runStartIndex = -1;
    }
  }

  const firstActiveDay = days.find((day) => day.contributionCount > 0)?.date;
  const stats = {
    total: totalContributions,
    firstActiveDate: firstActiveDay ?? null,
    currentStreak,
    currentStartDate: currentStreak ? days[currentStartIndex].date : null,
    currentEndDate: currentStreak ? days[currentEndIndex].date : null,
    longestStreak,
    longestStartDate: longestStreak ? days[longestStartIndex].date : null,
    longestEndDate: longestStreak ? days[longestEndIndex].date : null,
  };
  console.log(
    `contribution stats: ${commaNumber(stats.total)} total, ${stats.currentStreak}-day current streak, ${stats.longestStreak}-day longest streak`,
  );
  return stats;
}

async function requiredHeroImageData(r) {
  const expectedPath = r.profileHeroPath;
  const expectedMime = r.profileHeroMime;
  if (!expectedPath || !expectedMime) {
    throw new Error(`required hero configuration is missing for ${r.name}`);
  }

  const readmeResponse = await fetchWithRetry(
    `https://api.github.com/repos/${encodeURIComponent(userName)}/${encodeURIComponent(r.name)}/readme`,
    { headers: apiHeaders },
  );
  if (!readmeResponse.ok) {
    throw new Error(`README lookup failed for ${r.name}: HTTP ${readmeResponse.status}`);
  }
  const readme = await readmeResponse.json();
  const readmeText = Buffer.from(readme.content, "base64").toString("utf8");
  const resolvedSources = readmeImageSources(readmeText)
    .map((source) => resolveReadmeImagePath(source, readme.path ?? "README.md"))
    .filter(Boolean);
  if (!resolvedSources.includes(expectedPath)) {
    throw new Error(
      `${r.name} README no longer references required hero ${expectedPath}`,
    );
  }

  const encodedPath = expectedPath.split("/").map(encodeURIComponent).join("/");
  const assetResponse = await fetchWithRetry(
    `https://api.github.com/repos/${encodeURIComponent(userName)}/${encodeURIComponent(r.name)}/contents/${encodedPath}?ref=${encodeURIComponent(r.default_branch)}`,
    { headers: apiHeaders },
  );
  if (!assetResponse.ok) {
    throw new Error(
      `required hero download failed for ${r.name}: HTTP ${assetResponse.status}`,
    );
  }
  const asset = await assetResponse.json();
  if (
    asset.type !== "file" ||
    asset.path !== expectedPath ||
    asset.encoding !== "base64" ||
    !asset.content ||
    !Number.isFinite(asset.size) ||
    asset.size > MAX_IMAGE_BYTES
  ) {
    throw new Error(`required hero metadata is invalid for ${r.name}`);
  }
  const bytes = Buffer.from(asset.content.replaceAll("\n", ""), "base64");
  if (bytes.length !== asset.size) {
    throw new Error(`required hero size mismatch for ${r.name}`);
  }
  if (
    expectedMime === "image/png" &&
    (bytes.length < 24 ||
      bytes.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a")
  ) {
    throw new Error(`required hero is not a valid PNG for ${r.name}`);
  }
  if (
    expectedMime === "image/png" &&
    (bytes.readUInt32BE(16) !== r.profileHeroSourceWidth ||
      bytes.readUInt32BE(20) !== r.profileHeroSourceHeight)
  ) {
    throw new Error(
      `required hero dimensions changed for ${r.name}; expected ${r.profileHeroSourceWidth}x${r.profileHeroSourceHeight}`,
    );
  }
  if (!plausibleHero(bytes, r)) {
    throw new Error(`required hero has unusable dimensions for ${r.name}`);
  }
  console.log(`using required README hero for ${r.name}: ${expectedPath}`);
  return { bytes, mime: expectedMime };
}

async function heroImageData(r) {
  let downloaded;
  if (r.profileHeroPath) {
    downloaded = await requiredHeroImageData(r);
  } else {
    const primary = await heroImageUrl(r);
    const fallback = `https://opengraph.githubassets.com/1/${userName}/${r.name}`;
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
        downloaded = { bytes, mime };
        break;
      } catch (error) {
        console.error(`hero download failed for ${r.name}: ${error.message}`);
      }
    }
  }

  if (!downloaded) return null;
  const { bytes, mime } = downloaded;

  if (r.profileHeroCrop && !IM) {
    throw new Error(`ImageMagick is required for the configured ${r.name} hero crop`);
  }

  if (IM) {
    const normalizationArgs = heroResizeArgs(r);
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
            ...normalizationArgs,
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
        [`${tmp}[0]`, ...normalizationArgs, "png:-"],
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
  const cardDescription = [
    `${r.name} featured project card.`,
    r.profileHeroPath ? `Hero source: ${r.profileHeroPath}.` : "",
  ].filter(Boolean).join(" ");

  return `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" fill="none" xmlns="http://www.w3.org/2000/svg">
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

function pengRange(start, end) {
  if (!start || !end) return pengDate(isoDate(profileDate));
  if (start === end) return pengDate(start);
  const spansYears = start.slice(0, 4) !== end.slice(0, 4);
  return `${pengDate(start, spansYears)} - ${pengDate(end, spansYears)}`;
}

// Visual geometry and animation timings follow the MIT-licensed default card
// used by Peng. See THIRD_PARTY_NOTICES.md for source and license details.
function contributionStatsSvg(stats, dark) {
  const background = dark ? "#151515" : "#FFFEFE";
  const primary = dark ? "#FEFEFE" : "#151515";
  const muted = dark ? "#9E9E9E" : "#464646";
  const divider = "#E4E2E2";
  const accent = "#FB8C00";
  const totalRange = stats.firstActiveDate
    ? `${pengDate(stats.firstActiveDate, true)} - Present`
    : "No contributions yet";
  const currentRange = pengRange(stats.currentStartDate, stats.currentEndDate);
  const longestRange = pengRange(stats.longestStartDate, stats.longestEndDate);
  const description = [
    `${userName} GitHub streak statistics.`,
    `${commaNumber(stats.total)} total contributions.`,
    `${stats.currentStreak}-day current streak.`,
    `${stats.longestStreak}-day longest streak.`,
  ].join(" ");

  return `<svg xmlns='http://www.w3.org/2000/svg' style='isolation: isolate' viewBox='0 0 495 195' width='495px' height='195px' direction='ltr'>
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

// ---------------------------------------------------------------------------
// Write assets and splice the README block.
// ---------------------------------------------------------------------------

fs.mkdirSync(assetsDir, { recursive: true });

const [images, contributionStats] = await Promise.all([
  Promise.all(featuredRepos.map(heroImageData)),
  contributionStatsData(),
]);

for (const variant of ["light", "dark"]) {
  const relativeFile = `assets/contribution-stats-${variant}.svg`;
  const file = path.join(repoRoot, relativeFile);
  const svg = contributionStatsSvg(contributionStats, variant === "dark");
  if (!fs.existsSync(file) || fs.readFileSync(file, "utf8") !== svg) {
    writeFileAtomic(file, svg);
    console.log(`wrote ${relativeFile}`);
  }
}

const anchors = featuredRepos.map((r, i) => {
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
  if (match && Number(match[1]) >= featuredRepos.length) {
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

const featuredUpdated =
  readme.slice(0, start + START.length) + "\n" + block + "\n" + readme.slice(end);

const statsAlt = `Chuyue “Steven” Wang’s GitHub streak`;
const assetRoot = `https://raw.githubusercontent.com/${userName}/${userName}/main/assets`;
const statsBlock = `<div align="center">
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="${assetRoot}/contribution-stats-dark.svg" />
  <source media="(prefers-color-scheme: light)" srcset="${assetRoot}/contribution-stats-light.svg" />
  <img alt="${escAttr(statsAlt)}" src="${assetRoot}/contribution-stats-light.svg" width="58.5%" />
</picture><a href="https://chuyuewang.vercel.app/" title="Visit my website"><picture><img align="top" alt="Website" src="${assetRoot}/contact-website.svg?v=contact-inline-strip-r1" width="12.4%" /></picture></a><a href="https://www.linkedin.com/in/chuyue-wang/" title="Connect on LinkedIn"><picture><img align="top" alt="LinkedIn" src="${assetRoot}/contact-linkedin.svg?v=contact-inline-strip-r1" width="12.4%" /></picture></a><a href="mailto:stevenwang0805@outlook.com" title="Send me an email"><picture><img align="top" alt="Email" src="${assetRoot}/contact-email.svg?v=contact-inline-strip-r1" width="12.4%" /></picture></a>
</div>`;
const STATS_START = "<!-- CONTRIBUTION-STATS:START -->";
const STATS_END = "<!-- CONTRIBUTION-STATS:END -->";
const statsStart = featuredUpdated.indexOf(STATS_START);
const statsEnd = featuredUpdated.indexOf(STATS_END);
if (
  statsStart === -1 ||
  statsEnd === -1 ||
  statsEnd < statsStart ||
  statsStart !== featuredUpdated.lastIndexOf(STATS_START) ||
  statsEnd !== featuredUpdated.lastIndexOf(STATS_END)
) {
  throw new Error("CONTRIBUTION-STATS markers are missing, duplicated, or out of order");
}
const statsUpdated =
  featuredUpdated.slice(0, statsStart + STATS_START.length) +
  "\n" +
  statsBlock +
  "\n" +
  featuredUpdated.slice(statsEnd);

const snakeAltPattern =
  /alt="Chuyue “Steven” Wang’s GitHub contribution graph, animated as a snake(?: with a synchronized contribution counter)?"/g;
const snakeAltMatches = statsUpdated.match(snakeAltPattern) ?? [];
if (snakeAltMatches.length !== 1) {
  throw new Error(`expected one contribution-snake alt label, found ${snakeAltMatches.length}`);
}
const snakeUpdated = statsUpdated.replace(
  snakeAltPattern,
  'alt="Chuyue “Steven” Wang’s GitHub contribution graph, animated as a snake with a synchronized contribution counter"',
);

let refreshedUrlCount = 0;
const featuredCacheKey = `${dailyCacheKey}-s${featuredRepos[0].stargazers_count}`;
const contributionCacheKey = `${dailyCacheKey}-c${contributionStats.total}`;
const updated = snakeUpdated.replace(/https:\/\/[^"'\s>]+/g, (match) => {
  const url = new URL(match);
  const isSnake =
    url.hostname === "raw.githubusercontent.com" &&
    url.pathname.includes("/output/github-contribution-grid-snake") &&
    url.pathname.endsWith(".svg");
  const isFeaturedCard =
    url.hostname === "raw.githubusercontent.com" &&
    url.pathname === `/${userName}/${userName}/main/assets/featured-0.svg`;
  const isContributionStats =
    url.hostname === "raw.githubusercontent.com" &&
    url.pathname.startsWith(
      `/${userName}/${userName}/main/assets/contribution-stats-`,
    ) &&
    url.pathname.endsWith(".svg");
  if (!isSnake && !isFeaturedCard && !isContributionStats) return match;
  url.searchParams.set(
    "v",
    isFeaturedCard ? featuredCacheKey : contributionCacheKey,
  );
  refreshedUrlCount += 1;
  return url.toString();
});
if (refreshedUrlCount !== 7) {
  throw new Error(`expected 7 dynamically refreshed image URLs, found ${refreshedUrlCount}`);
}

if (updated !== readme) {
  writeFileAtomic(readmeFile, updated);
  console.log(
    "README.md updated:",
    featuredRepos
      .map(
        (r) =>
          `${r.name} (${r.stargazers_count} ${r.stargazers_count === 1 ? "star" : "stars"})`,
      )
      .join(", "),
    `cache=${dailyCacheKey}`,
    `featuredCache=${featuredCacheKey}`,
    `contributionCache=${contributionCacheKey}`,
  );
} else {
  console.log("README.md already up to date");
}
