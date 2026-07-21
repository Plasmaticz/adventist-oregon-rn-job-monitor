import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const SITE_JOBS_URL =
  "https://ecvz.fa.us2.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1/jobs";
export const SEARCH_API =
  "https://ecvz.fa.us2.oraclecloud.com/hcmRestApi/resources/latest/recruitingCEJobRequisitions";
export const SEARCH_TERMS = ["RN Resident", "RN New Grad", "RN Residency"];
export const ORGANIZATIONS = [
  {
    id: "300000009236546",
    name: "Adventist Health Portland",
  },
  {
    id: "300001042821913",
    name: "Adventist Health Columbia Gorge",
  },
];

const SITE_NUMBER = "CX_1";
const PAGE_SIZE = 25;
const ORGANIZATION_IDS = ORGANIZATIONS.map((organization) => organization.id);
const ORGANIZATION_FACET = ORGANIZATION_IDS.join(";");
const ORGANIZATION_NAMES = new Map(
  ORGANIZATIONS.map((organization) => [organization.id, organization.name]),
);
const TITLE_PATTERN = /\b(?:RN|Registered Nurse)\b/i;
const LISTINGS_START = "<!-- ADVENTIST-JOBS:START -->";
const LISTINGS_END = "<!-- ADVENTIST-JOBS:END -->";

function clean(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

export function buildSearchPageUrl(term) {
  const url = new URL(SITE_JOBS_URL);
  url.searchParams.set("keyword", term);
  url.searchParams.set("lastSelectedFacet", "ORGANIZATIONS");
  url.searchParams.set("mode", "job-location");
  url.searchParams.set("selectedOrganizationsFacet", ORGANIZATION_FACET);
  return url.toString();
}

export function buildApiUrl(term, offset = 0, limit = PAGE_SIZE) {
  const finder = [
    "findReqs;siteNumber=" + SITE_NUMBER,
    `limit=${limit}`,
    `offset=${offset}`,
    `keyword=${term}`,
    `selectedOrganizationsFacet=${ORGANIZATION_FACET}`,
  ].join(",");
  const url = new URL(SEARCH_API);
  url.searchParams.set("onlyData", "true");
  url.searchParams.set(
    "expand",
    "requisitionList.workLocation,requisitionList.otherWorkLocations,requisitionList.secondaryLocations",
  );
  url.searchParams.set("finder", finder);
  return url;
}

export function parseSearchPayload(payload) {
  const result = payload?.items?.[0];
  if (!result || !Array.isArray(result.requisitionList)) {
    throw new Error("Adventist Health search returned an unexpected response");
  }

  const jobs = result.requisitionList.flatMap((raw) => {
    const id = clean(raw.Id);
    const title = clean(raw.Title);
    const organizationId = clean(raw.OrganizationId);
    if (
      !id ||
      !title ||
      !TITLE_PATTERN.test(title) ||
      !ORGANIZATION_IDS.includes(organizationId)
    ) {
      return [];
    }

    return [
      {
        id,
        title,
        organization: ORGANIZATION_NAMES.get(organizationId),
        location: clean(raw.PrimaryLocation) || "Not listed",
        workLocation: clean(raw.workLocation?.[0]?.LocationName) || "Not listed",
        postedAt: clean(raw.PostedDate),
        requisitionId: id,
        url: `${SITE_JOBS_URL.replace(/\/jobs$/, "")}/job/${encodeURIComponent(id)}`,
      },
    ];
  });

  return {
    jobs,
    totalCount: Math.max(0, Number(result.TotalJobsCount) || 0),
  };
}

async function fetchPage(term, offset, fetchImpl) {
  const response = await fetchImpl(buildApiUrl(term, offset), {
    headers: {
      Accept: "application/json",
      "User-Agent": "adventist-oregon-rn-job-monitor/1.0",
    },
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) {
    throw new Error(`Adventist Health search returned HTTP ${response.status}`);
  }
  return parseSearchPayload(await response.json());
}

export async function fetchJobs(fetchImpl = fetch) {
  const jobsById = new Map();

  for (const term of SEARCH_TERMS) {
    const first = await fetchPage(term, 0, fetchImpl);
    const searchJobs = [...first.jobs];
    for (let offset = PAGE_SIZE; offset < first.totalCount; offset += PAGE_SIZE) {
      searchJobs.push(...(await fetchPage(term, offset, fetchImpl)).jobs);
    }

    for (const job of searchJobs) {
      const existing = jobsById.get(job.id);
      jobsById.set(job.id, {
        ...(existing ?? job),
        matchedSearches: [
          ...new Set([...(existing?.matchedSearches ?? []), term]),
        ],
      });
    }
  }

  return [...jobsById.values()].sort((a, b) =>
    `${b.postedAt}${b.id}`.localeCompare(`${a.postedAt}${a.id}`),
  );
}

async function readState(statePath) {
  try {
    const parsed = JSON.parse(await readFile(statePath, "utf8"));
    return {
      initialized: parsed.initialized === true,
      seen: Array.isArray(parsed.seen) ? parsed.seen.map(String) : [],
    };
  } catch (error) {
    if (error.code === "ENOENT") return { initialized: false, seen: [] };
    throw new Error(`Could not read ${statePath}: ${error.message}`);
  }
}

function formatPostedDate(value) {
  if (!value) return "Not listed";
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? value : date.toISOString().slice(0, 10);
}

export function buildAlert(jobs) {
  const noun = jobs.length === 1 ? "role" : "roles";
  const sections = jobs.map(
    (job) =>
      `## [${job.title}](${job.url})\n\n- Facility: ${job.organization}\n- Location: ${job.location}\n- Work location: ${job.workLocation}\n- Posted: ${formatPostedDate(job.postedAt)}\n- Matched search: ${job.matchedSearches.join(", ")}\n- Requisition: ${job.requisitionId}`,
  );
  return [
    `# ${jobs.length} new Adventist Health Oregon RN ${noun}`,
    "",
    ...sections.flatMap((section) => [section, ""]),
    "Sources:",
    ...SEARCH_TERMS.map((term) => `- [${term}](${buildSearchPageUrl(term)})`),
    "",
    `_Checked ${new Date().toISOString()}_`,
  ].join("\n");
}

function escapeTableCell(value) {
  return clean(value).replace(/\|/g, "\\|");
}

export function buildListingsSection(jobs) {
  const noun = jobs.length === 1 ? "opening" : "openings";
  const rows = jobs.length
    ? jobs.map(
        (job) =>
          `| [${escapeTableCell(job.title)}](${job.url}) | ${escapeTableCell(job.organization)} | ${escapeTableCell(job.location)} | ${formatPostedDate(job.postedAt)} | ${escapeTableCell(job.matchedSearches.join(", "))} | ${escapeTableCell(job.requisitionId)} |`,
      )
    : ["| No matching openings are currently listed. |  |  |  |  |  |"];

  return [
    LISTINGS_START,
    `**${jobs.length} current ${noun}**`,
    "",
    "| Position | Facility | Location | Posted | Matched search | Requisition |",
    "| --- | --- | --- | --- | --- | --- |",
    ...rows,
    "",
    SEARCH_TERMS.map((term) => `[${term}](${buildSearchPageUrl(term)})`).join(" | "),
    LISTINGS_END,
  ].join("\n");
}

export async function updateReadme(readmePath, jobs) {
  if (!readmePath) return false;
  const current = await readFile(readmePath, "utf8");
  const section = buildListingsSection(jobs);
  const pattern = new RegExp(`${LISTINGS_START}[\\s\\S]*?${LISTINGS_END}`);
  const next = current.replace(pattern, section);
  if (next === current) return false;
  await writeFile(readmePath, next, "utf8");
  return true;
}

async function setActionsOutputs(values, outputPath) {
  if (!outputPath) return;
  const lines = Object.entries(values)
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
  await appendFile(outputPath, `${lines}\n`, "utf8");
}

export async function runMonitor({
  statePath,
  alertPath,
  newJobsPath,
  readmePath,
  actionsOutputPath,
  sendTestAlert = false,
  fetchImpl = fetch,
}) {
  const previous = await readState(statePath);
  const jobs = await fetchJobs(fetchImpl);
  const seen = new Set(previous.seen);
  const unseen = jobs.filter((job) => !seen.has(job.id));
  const newJobs = sendTestAlert ? jobs.slice(0, 1) : previous.initialized ? unseen : [];

  for (const job of jobs) seen.add(job.id);
  const nextState = { initialized: true, seen: [...seen].sort() };
  const stateChanged =
    !previous.initialized ||
    JSON.stringify(nextState.seen) !== JSON.stringify([...previous.seen].sort());
  const readmeChanged = await updateReadme(readmePath, jobs);

  if (stateChanged) {
    await mkdir(dirname(statePath), { recursive: true });
    await writeFile(statePath, `${JSON.stringify(nextState, null, 2)}\n`, "utf8");
  }
  if (newJobs.length > 0) {
    await mkdir(dirname(alertPath), { recursive: true });
    await writeFile(alertPath, buildAlert(newJobs), "utf8");
    if (newJobsPath) {
      await mkdir(dirname(newJobsPath), { recursive: true });
      await writeFile(newJobsPath, `${JSON.stringify(newJobs, null, 2)}\n`, "utf8");
    }
  }

  await setActionsOutputs(
    {
      new_count: newJobs.length,
      current_count: jobs.length,
      state_changed: stateChanged,
      readme_changed: readmeChanged,
      repo_changed: stateChanged || readmeChanged,
      baseline_created: !previous.initialized && !sendTestAlert,
    },
    actionsOutputPath,
  );
  return {
    jobs,
    newJobs,
    stateChanged,
    readmeChanged,
    baselineCreated: !previous.initialized,
  };
}

function parseArgs(args) {
  const options = {
    statePath: "data/seen_jobs.json",
    alertPath: "new_jobs.md",
    newJobsPath: undefined,
    readmePath: "README.md",
    actionsOutputPath: process.env.GITHUB_OUTPUT,
    sendTestAlert: false,
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--send-test-alert") options.sendTestAlert = true;
    else if (arg === "--state") options.statePath = args[++index];
    else if (arg === "--alert-file") options.alertPath = args[++index];
    else if (arg === "--new-jobs-file") options.newJobsPath = args[++index];
    else if (arg === "--readme") options.readmePath = args[++index];
    else if (arg === "--output") options.actionsOutputPath = args[++index];
    else throw new Error(`Unknown argument: ${arg}`);
  }
  options.statePath = resolve(options.statePath);
  options.alertPath = resolve(options.alertPath);
  if (options.newJobsPath) options.newJobsPath = resolve(options.newJobsPath);
  options.readmePath = resolve(options.readmePath);
  return options;
}

async function main() {
  const result = await runMonitor(parseArgs(process.argv.slice(2)));
  if (result.baselineCreated && result.newJobs.length === 0) {
    console.log(`Baseline saved with ${result.jobs.length} current jobs; no alert sent.`);
  } else {
    console.log(`Found ${result.jobs.length} current jobs and ${result.newJobs.length} new jobs.`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error.stack ?? error.message);
    process.exitCode = 1;
  });
}
