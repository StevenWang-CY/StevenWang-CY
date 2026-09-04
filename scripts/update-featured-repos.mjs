// Refreshes the selected Township and SILKern projects, plus light/dark
// contribution statistics. Curated artwork comes directly from each repo;
// missing artwork retains the last published poster so metrics keep updating.
// The original project cards and streak/contact strip share one live snapshot.
// Content-based URL suffixes invalidate GitHub's image cache when counts change.
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
import { renderProjectCard, renderContributionStats, projectAlt, artworkWithFallback } from "./profile-design.mjs";

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
const CACHE_REVISION = "r5";
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
    name: "township",
    heroPath: "docs/media/social-preview.png",
    heroMime: "image/png",
    heroSourceWidth: 1280,
    heroSourceHeight: 640,
    // The repository's social-preview card is authored at exactly 2:1
    // (wordmark, tagline, and the living pixel town) — use the full frame.
    heroCrop: "1280x640+0+0",
  },
  {
    name: "SILKern.",
    heroPath: "assets/cover.png",
    heroMime: "image/png",
    heroSourceWidth: 1280,
    heroSourceHeight: 640,
    // The repository's media-kit cover is authored at exactly 2:1 - the
    // SILKern lockup (weave mark, wordmark, and subline) - use the full frame.
    heroCrop: "1280x640+0+0",
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

  // Fetch the curated repository asset directly. README layout changes must
  // not invalidate existing artwork or block the statistics refresh.
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
  console.log(`using repository artwork for ${r.name}: ${expectedPath}`);
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

// Render the profile using the shared responsive design.

fs.mkdirSync(assetsDir, { recursive: true });

const [images, contributionStats] = await Promise.all([
  Promise.all(featuredRepos.map((repo, index) => {
    const previousFile = path.join(assetsDir, `featured-${index}.svg`);
    const previous = fs.existsSync(previousFile) ? fs.readFileSync(previousFile, "utf8") : "";
    return artworkWithFallback(() => heroImageData(repo), previous);
  })),
  contributionStatsData(),
]);

for (const variant of ["light", "dark"]) {
  const relativeFile = `assets/contribution-stats-${variant}.svg`;
  const file = path.join(repoRoot, relativeFile);
  const svg = renderContributionStats(contributionStats, variant, {
    userName, profileDate: isoDate(profileDate),
  });
  if (!fs.existsSync(file) || fs.readFileSync(file, "utf8") !== svg) {
    writeFileAtomic(file, svg);
    console.log(`wrote ${relativeFile}`);
  }
}

const assetRoot = `https://raw.githubusercontent.com/${userName}/${userName}/main/assets`;
const anchors = featuredRepos.map((r, i) => {
  const relativeFile = `assets/featured-${i}.svg`;
  const file = path.join(repoRoot, relativeFile);
  const svg = renderProjectCard(r, images[i]);
  if (!fs.existsSync(file) || fs.readFileSync(file, "utf8") !== svg) {
    writeFileAtomic(file, svg);
    console.log(`wrote ${relativeFile}`);
  }
  return `<a href="${r.html_url}"><img alt="${escAttr(projectAlt(r))}" src="${assetRoot}/featured-${i}.svg" width="846" /></a>`;
});

for (const file of fs.readdirSync(assetsDir)) {
  const match = /^featured-(\d+)(-mobile)?\.svg$/.exec(file);
  if ((match && (match[2] || Number(match[1]) >= featuredRepos.length)) || /^contribution-stats-mobile-(light|dark)\.svg$/.test(file)) {
    fs.rmSync(path.join(assetsDir, file));
    console.log(`removed retired assets/${file}`);
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
// Every featured card carries its own live star suffix so one project's
// activity can never leave another card cached behind GitHub's image proxy.
const featuredCacheKeys = new Map(
  featuredRepos.map((r, index) => [
    `/${userName}/${userName}/main/assets/featured-${index}.svg`,
    `${dailyCacheKey}-s${r.stargazers_count}`,
  ]),
);
const contributionCacheKey = `${dailyCacheKey}-c${contributionStats.total}`;
const updated = snakeUpdated.replace(/https:\/\/[^"'\s>]+/g, (match) => {
  const url = new URL(match);
  const isSnake =
    url.hostname === "raw.githubusercontent.com" &&
    url.pathname.includes("/output/github-contribution-grid-snake") &&
    url.pathname.endsWith(".svg");
  const featuredKey =
    url.hostname === "raw.githubusercontent.com"
      ? featuredCacheKeys.get(url.pathname)
      : undefined;
  const isFeaturedCard = featuredKey !== undefined;
  const isContributionStats =
    url.hostname === "raw.githubusercontent.com" &&
    url.pathname.startsWith(
      `/${userName}/${userName}/main/assets/contribution-stats-`,
    ) &&
    url.pathname.endsWith(".svg");
  if (!isSnake && !isFeaturedCard && !isContributionStats) return match;
  url.searchParams.set("v", isFeaturedCard ? featuredKey : contributionCacheKey);
  refreshedUrlCount += 1;
  return url.toString();
});
// Three snake URLs + three stats URLs + one URL per featured project.
const expectedRefreshedUrls = 6 + featuredRepos.length;
if (refreshedUrlCount !== expectedRefreshedUrls) {
  throw new Error(
    `expected ${expectedRefreshedUrls} dynamically refreshed image URLs, found ${refreshedUrlCount}`,
  );
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
    `featuredCache=${[...featuredCacheKeys.values()].join(",")}`,
    `contributionCache=${contributionCacheKey}`,
  );
} else {
  console.log("README.md already up to date");
}
