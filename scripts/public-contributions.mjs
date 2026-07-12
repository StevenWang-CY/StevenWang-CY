// Loads the exact contribution days visible to an unauthenticated GitHub
// profile visitor. The caller token is used only for low-rate account metadata;
// it is deliberately never sent to the public contribution-calendar endpoint.

import fs from "node:fs";
import path from "node:path";

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);
const FETCH_TIMEOUT_MS = 15_000;
const MAX_ACCOUNT_BYTES = 256 * 1024;
const MAX_CALENDAR_BYTES = 2 * 1024 * 1024;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function isoDate(date) {
  return date.toISOString().slice(0, 10);
}

async function fetchWithRetry(url, options = {}) {
  let lastError;
  for (let attempt = 0; attempt < 3; attempt += 1) {
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

function htmlAttribute(fragment, name) {
  const match = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(["'])(.*?)\\1`, "is").exec(
    fragment,
  );
  return match?.[2] ?? null;
}

export function parsePublicContributionCalendar(html, userName, year) {
  if (!html.includes(`data-graph-url="/users/${userName}/contributions"`)) {
    throw new Error(`GitHub returned an unexpected ${year} public contribution page`);
  }
  const heading =
    /<h2\b[^>]*\bid=["']js-contribution-activity-description["'][^>]*>\s*([\d,]+)\s+contributions?\b/is.exec(
      html,
    );
  const totalContributions = Number(heading?.[1]?.replaceAll(",", ""));
  if (!Number.isSafeInteger(totalContributions) || totalContributions < 0) {
    throw new Error(`GitHub returned an invalid ${year} public contribution total`);
  }

  const byDate = new Map();
  const blockPattern =
    /<td\b([^>]*)>\s*<\/td>\s*<tool-tip\b([^>]*)>([^<]*)<\/tool-tip>/gis;
  let block;
  while ((block = blockPattern.exec(html)) !== null) {
    const cellAttributes = block[1];
    const className = htmlAttribute(cellAttributes, "class") ?? "";
    if (!className.split(/\s+/).includes("ContributionCalendar-day")) continue;

    const date = htmlAttribute(cellAttributes, "data-date");
    const cellId = htmlAttribute(cellAttributes, "id");
    const tooltipFor = htmlAttribute(block[2], "for");
    const tooltip = block[3].trim().replace(/\s+/g, " ");
    const countMatch = /^([\d,]+) contributions? on\b/i.exec(tooltip);
    const contributionCount = /^No contributions on\b/i.test(tooltip)
      ? 0
      : Number(countMatch?.[1]?.replaceAll(",", ""));
    const level = Number(htmlAttribute(cellAttributes, "data-level"));
    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(date ?? "") ||
      !cellId ||
      tooltipFor !== cellId ||
      !Number.isSafeInteger(contributionCount) ||
      contributionCount < 0 ||
      !Number.isSafeInteger(level) ||
      level < 0 ||
      level > 4 ||
      (contributionCount === 0) !== (level === 0) ||
      byDate.has(date)
    ) {
      throw new Error(`GitHub returned a malformed ${year} public contribution day`);
    }
    byDate.set(date, { contributionCount, level });
  }

  const expectedStart = new Date(Date.UTC(year, 0, 1));
  const expectedEnd = new Date(Date.UTC(year + 1, 0, 1));
  const expectedDayCount = Math.round((expectedEnd - expectedStart) / 86_400_000);
  const days = [...byDate]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([date, values]) => ({ date, ...values }));
  if (days.length !== expectedDayCount) {
    throw new Error(
      `GitHub returned a truncated ${year} public calendar (${days.length}/${expectedDayCount} days)`,
    );
  }
  for (let index = 0; index < days.length; index += 1) {
    const expectedDate = new Date(expectedStart.getTime() + index * 86_400_000);
    if (days[index].date !== isoDate(expectedDate)) {
      throw new Error(`GitHub returned a non-contiguous ${year} public calendar`);
    }
  }
  const dayTotal = days.reduce((sum, day) => sum + day.contributionCount, 0);
  if (dayTotal !== totalContributions) {
    throw new Error(
      `GitHub public ${year} total/day mismatch (${totalContributions}/${dayTotal})`,
    );
  }
  return { totalContributions, days };
}

export function buildPublicContributionGrid(days, profileDate) {
  const byDate = new Map(days.map((day) => [day.date, day]));
  const cutoffWeekday = profileDate.getUTCDay();
  const maxX = 52;
  const lastIndex = maxX * 7 + cutoffWeekday;
  const firstDate = new Date(profileDate.getTime() - lastIndex * 86_400_000);
  const firstAnnualDate = days[0]?.date;
  if (!firstAnnualDate) {
    throw new Error("public contribution calendar is empty");
  }

  const gridDays = [];
  for (let index = 0; index <= lastIndex; index += 1) {
    const date = isoDate(new Date(firstDate.getTime() + index * 86_400_000));
    const annualDay = byDate.get(date);
    if (!annualDay && date >= firstAnnualDate) {
      throw new Error(`public contribution calendar is missing ${date}`);
    }
    gridDays.push({
      x: Math.floor(index / 7),
      y: index % 7,
      date,
      contributionCount: annualDay?.contributionCount ?? 0,
    });
  }
  const gridTotal = gridDays.reduce(
    (sum, day) => sum + day.contributionCount,
    0,
  );
  return { gridDays, gridTotal };
}

function validateRequest(userName, profileDate) {
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(userName)) {
    throw new Error(`invalid GitHub user name: ${userName}`);
  }
  if (
    !(profileDate instanceof Date) ||
    !Number.isFinite(profileDate.getTime()) ||
    profileDate.getUTCHours() !== 0 ||
    profileDate.getUTCMinutes() !== 0 ||
    profileDate.getUTCSeconds() !== 0 ||
    profileDate.getUTCMilliseconds() !== 0
  ) {
    throw new Error("profileDate must be a valid UTC date at midnight");
  }
}

function validateContributionData(data, userName, profileDate) {
  const cutoff = isoDate(profileDate);
  if (
    data?.version !== 1 ||
    data.userName !== userName ||
    data.profileDate !== cutoff ||
    !Number.isSafeInteger(data.firstYear) ||
    !Number.isSafeInteger(data.lastYear) ||
    data.lastYear !== profileDate.getUTCFullYear() ||
    !Array.isArray(data.days) ||
    !Array.isArray(data.gridDays)
  ) {
    throw new Error("public contribution snapshot metadata is invalid");
  }

  const expectedStart = new Date(Date.UTC(data.firstYear, 0, 1));
  const expectedDayCount =
    Math.round((profileDate.getTime() - expectedStart.getTime()) / 86_400_000) + 1;
  if (data.days.length !== expectedDayCount) {
    throw new Error(
      `unexpected public contribution-calendar length (${data.days.length}/${expectedDayCount})`,
    );
  }
  const dayByDate = new Map();
  for (let index = 0; index < data.days.length; index += 1) {
    const expectedDate = new Date(expectedStart.getTime() + index * 86_400_000);
    const day = data.days[index];
    if (
      day?.date !== isoDate(expectedDate) ||
      !Number.isSafeInteger(day.contributionCount) ||
      day.contributionCount < 0 ||
      !Number.isSafeInteger(day.level) ||
      day.level < 0 ||
      day.level > 4 ||
      (day.contributionCount === 0) !== (day.level === 0)
    ) {
      throw new Error("GitHub returned malformed public contribution days");
    }
    dayByDate.set(day.date, day);
  }
  const totalContributions = data.days.reduce(
    (sum, day) => sum + day.contributionCount,
    0,
  );
  if (
    !Number.isSafeInteger(totalContributions) ||
    data.totalContributions !== totalContributions
  ) {
    throw new Error("public contribution total is invalid");
  }

  if (data.gridDays.length < 1) {
    throw new Error("public rolling contribution grid is empty");
  }
  const coordinateSet = new Set();
  const gridDateSet = new Set();
  const maxX = Math.max(...data.gridDays.map((day) => day?.x ?? -1));
  const cutoffWeekday = profileDate.getUTCDay();
  const expectedGridCount = maxX * 7 + cutoffWeekday + 1;
  const firstGridDate = new Date(`${data.gridDays[0]?.date}T00:00:00Z`);
  if (
    maxX !== 52 ||
    data.gridDays.length !== expectedGridCount ||
    !Number.isFinite(firstGridDate.getTime()) ||
    data.gridDays[0]?.x !== 0 ||
    data.gridDays[0]?.y !== 0 ||
    data.gridDays.at(-1)?.x !== maxX ||
    data.gridDays.at(-1)?.y !== cutoffWeekday ||
    data.gridDays.at(-1)?.date !== cutoff
  ) {
    throw new Error("public rolling contribution-grid geometry is invalid");
  }
  for (const day of data.gridDays) {
    const coordinate = `${day?.x},${day?.y}`;
    const expectedDate = new Date(
      firstGridDate.getTime() + (day.x * 7 + day.y) * 86_400_000,
    );
    const annualDay = dayByDate.get(day.date);
    if (
      !Number.isSafeInteger(day.x) ||
      day.x < 0 ||
      !Number.isSafeInteger(day.y) ||
      day.y < 0 ||
      day.y > 6 ||
      day.date !== isoDate(expectedDate) ||
      !Number.isSafeInteger(day.contributionCount) ||
      day.contributionCount < 0 ||
      (annualDay
        ? annualDay.contributionCount !== day.contributionCount
        : day.date >= data.days[0].date || day.contributionCount !== 0) ||
      coordinateSet.has(coordinate) ||
      gridDateSet.has(day.date)
    ) {
      throw new Error("public rolling contribution-grid data is invalid");
    }
    coordinateSet.add(coordinate);
    gridDateSet.add(day.date);
  }
  const gridTotal = data.gridDays.reduce(
    (sum, day) => sum + day.contributionCount,
    0,
  );
  if (
    !Number.isSafeInteger(gridTotal) ||
    data.gridTotal !== gridTotal ||
    gridTotal > totalContributions
  ) {
    throw new Error("public rolling contribution total is invalid");
  }

  return {
    version: 1,
    userName,
    profileDate: cutoff,
    firstYear: data.firstYear,
    lastYear: data.lastYear,
    totalContributions,
    gridTotal,
    days: data.days,
    gridDays: data.gridDays,
  };
}

export function readPublicContributionsSnapshot(snapshotPath, userName, profileDate) {
  validateRequest(userName, profileDate);
  const stat = fs.lstatSync(snapshotPath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 2 || stat.size > 8 * 1024 * 1024) {
    throw new Error("public contribution snapshot file is invalid");
  }
  let data;
  try {
    data = JSON.parse(fs.readFileSync(snapshotPath, "utf8"));
  } catch {
    throw new Error("public contribution snapshot is malformed JSON");
  }
  return validateContributionData(data, userName, profileDate);
}

export function writePublicContributionsSnapshot(
  snapshotPath,
  data,
  userName,
  profileDate,
) {
  const validated = validateContributionData(data, userName, profileDate);
  fs.mkdirSync(path.dirname(snapshotPath), { recursive: true });
  const temporary = `${snapshotPath}.tmp-${process.pid}`;
  fs.writeFileSync(temporary, `${JSON.stringify(validated)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, snapshotPath);
}

export async function loadPublicContributions({
  userName,
  profileDate,
  token,
  snapshotPath,
}) {
  validateRequest(userName, profileDate);
  if (snapshotPath) {
    return readPublicContributionsSnapshot(snapshotPath, userName, profileDate);
  }

  const accountHeaders = {
    "User-Agent": userName,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
  const accountResponse = await fetchWithRetry(
    `https://api.github.com/users/${encodeURIComponent(userName)}`,
    { headers: accountHeaders },
  );
  if (!accountResponse.ok) {
    throw new Error(`GitHub user lookup failed with HTTP ${accountResponse.status}`);
  }
  const accountBytes = await readBodyLimited(accountResponse, MAX_ACCOUNT_BYTES);
  let account;
  try {
    account = JSON.parse(accountBytes.toString("utf8"));
  } catch {
    throw new Error("GitHub returned malformed account metadata");
  }
  if (
    account.login?.toLowerCase() !== userName.toLowerCase() ||
    !/^\d{4}-\d{2}-\d{2}T/.test(account.created_at ?? "")
  ) {
    throw new Error("GitHub returned unexpected account metadata");
  }

  const firstYear = new Date(account.created_at).getUTCFullYear();
  const lastYear = profileDate.getUTCFullYear();
  const years = Array.from(
    { length: lastYear - firstYear + 1 },
    (_, index) => firstYear + index,
  );
  if (years.length < 1 || years.length > 100) {
    throw new Error(`unexpected GitHub account age: ${years.length} years`);
  }

  // This header set intentionally has no Authorization or Cookie field.
  const publicContributionHeaders = {
    "User-Agent": userName,
    Accept: "text/html",
  };
  const fetchConsistentSnapshot = async () => {
    const calendarPromises = years.map(async (year) => {
      const from = `${year}-01-01`;
      const toDate = year === lastYear ? isoDate(profileDate) : `${year}-12-31`;
      const url =
        `https://github.com/users/${encodeURIComponent(userName)}/contributions` +
        `?from=${encodeURIComponent(from)}&to=${encodeURIComponent(toDate)}`;
      const response = await fetchWithRetry(url, {
        headers: publicContributionHeaders,
      });
      if (!response.ok) {
        throw new Error(
          `GitHub public contribution calendar ${response.status} for ${year}`,
        );
      }
      const contentType = response.headers.get("content-type") ?? "";
      if (!contentType.toLowerCase().startsWith("text/html")) {
        throw new Error(`GitHub returned unexpected ${year} calendar content type`);
      }
      const html = (await readBodyLimited(response, MAX_CALENDAR_BYTES)).toString(
        "utf8",
      );
      return parsePublicContributionCalendar(html, userName, year);
    });
    const calendars = await Promise.all(calendarPromises);

    const cutoff = isoDate(profileDate);
    const days = calendars
      .flatMap((calendar) => calendar.days)
      .filter((day) => day.date <= cutoff);
    const totalContributions = days.reduce(
      (sum, day) => sum + day.contributionCount,
      0,
    );
    const rolling = buildPublicContributionGrid(days, profileDate);
    return validateContributionData(
      {
        version: 1,
        userName,
        profileDate: cutoff,
        days,
        totalContributions,
        firstYear,
        lastYear,
        gridDays: rolling.gridDays,
        gridTotal: rolling.gridTotal,
      },
      userName,
      profileDate,
    );
  };

  // Retry the complete public snapshot, not an individual page, so a transient
  // response or edge-cache refresh cannot leave a partially refreshed result.
  let lastSnapshotError;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await fetchConsistentSnapshot();
    } catch (error) {
      lastSnapshotError = error;
      if (attempt === 2) throw error;
      await sleep(400 * 2 ** attempt);
    }
  }
  throw lastSnapshotError;
}
