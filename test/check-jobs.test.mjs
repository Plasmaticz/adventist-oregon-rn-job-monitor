import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  buildApiUrl,
  buildListingsSection,
  fetchJobs,
  parseSearchPayload,
  runMonitor,
} from "../scripts/check-jobs.mjs";
import {
  buildDailyDigestPayloads,
  buildNewRolePayloads,
  sendDiscordJobs,
} from "../scripts/send-discord.mjs";

const PORTLAND_ID = "300000009236546";
const DALLES_ID = "300001042821913";

function rawJob({
  id,
  title,
  organizationId = PORTLAND_ID,
  location = "Portland, OR, United States",
  workLocation = "AHPL - Hospital",
  postedAt = "2026-07-20",
}) {
  return {
    Id: id,
    Title: title,
    OrganizationId: organizationId,
    PrimaryLocation: location,
    PostedDate: postedAt,
    workLocation: [{ LocationName: workLocation }],
  };
}

function payload(jobs, totalCount = jobs.length) {
  return {
    items: [{ TotalJobsCount: totalCount, requisitionList: jobs }],
  };
}

function jsonResponse(value) {
  return { ok: true, json: async () => value };
}

function finderValue(url, name) {
  const finder = url.searchParams.get("finder");
  return finder.match(new RegExp(`(?:^|,)${name}=([^,]+)`))?.[1];
}

test("API requests contain all three search terms and both organization filters", () => {
  const url = buildApiUrl("RN Residency", 25);
  const finder = url.searchParams.get("finder");
  assert.match(finder, /keyword=RN Residency/);
  assert.match(finder, /offset=25/);
  assert.match(finder, new RegExp(PORTLAND_ID));
  assert.match(finder, new RegExp(DALLES_ID));
});

test("parser accepts only RN titles from the two allowed facilities", () => {
  const parsed = parseSearchPayload(
    payload([
      rawJob({ id: "100", title: "RN, Acute Care" }),
      rawJob({
        id: "101",
        title: "Registered Nurse Resident",
        organizationId: DALLES_ID,
        location: "The Dalles, OR, United States",
      }),
      rawJob({ id: "102", title: "Nurse Manager" }),
      rawJob({ id: "103", title: "RN, Outside Scope", organizationId: "999" }),
    ]),
  );

  assert.equal(parsed.jobs.length, 2);
  assert.equal(parsed.jobs[0].organization, "Adventist Health Portland");
  assert.equal(parsed.jobs[1].organization, "Adventist Health Columbia Gorge");
  assert.match(parsed.jobs[1].url, /\/job\/101$/);
});

test("fetcher combines three searches, paginates, and deduplicates roles", async () => {
  const requests = [];
  const portland = rawJob({ id: "100", title: "RN, Acute Care" });
  const dalles = rawJob({
    id: "101",
    title: "RN, House Supervisor",
    organizationId: DALLES_ID,
    location: "The Dalles, OR, United States",
    postedAt: "2026-07-21",
  });

  const jobs = await fetchJobs(async (url) => {
    requests.push(String(url));
    const keyword = finderValue(url, "keyword");
    const offset = Number(finderValue(url, "offset"));
    if (keyword === "RN Resident") return jsonResponse(payload([portland]));
    if (keyword === "RN New Grad") {
      return jsonResponse(offset === 0 ? payload([portland], 26) : payload([dalles], 26));
    }
    return jsonResponse(payload([dalles]));
  });

  assert.equal(requests.length, 4);
  assert.deepEqual(jobs.map((job) => job.id), ["101", "100"]);
  assert.deepEqual(jobs[0].matchedSearches, ["RN New Grad", "RN Residency"]);
  assert.deepEqual(jobs[1].matchedSearches, ["RN Resident", "RN New Grad"]);
});

test("monitor baselines current jobs and later reports only unseen roles", async () => {
  const directory = await mkdtemp(join(tmpdir(), "adventist-monitor-"));
  const statePath = join(directory, "seen.json");
  const alertPath = join(directory, "alert.md");
  const newJobsPath = join(directory, "new.json");
  const readmePath = join(directory, "README.md");
  const firstPayload = payload([rawJob({ id: "100", title: "RN, Acute Care" })]);
  const secondPayload = payload([
    rawJob({ id: "101", title: "RN Resident, Pediatrics", postedAt: "2026-07-21" }),
    rawJob({ id: "100", title: "RN, Acute Care" }),
  ]);

  try {
    await writeFile(statePath, '{"initialized":false,"seen":[]}\n');
    await writeFile(
      readmePath,
      "# Monitor\n\n<!-- ADVENTIST-JOBS:START -->\nWaiting\n<!-- ADVENTIST-JOBS:END -->\n",
    );
    const first = await runMonitor({
      statePath,
      alertPath,
      newJobsPath,
      readmePath,
      fetchImpl: async () => jsonResponse(firstPayload),
    });
    assert.equal(first.newJobs.length, 0);

    const second = await runMonitor({
      statePath,
      alertPath,
      newJobsPath,
      readmePath,
      fetchImpl: async () => jsonResponse(secondPayload),
    });
    assert.deepEqual(second.newJobs.map((job) => job.id), ["101"]);
    assert.match(await readFile(alertPath, "utf8"), /RN Resident, Pediatrics/);
    assert.equal(JSON.parse(await readFile(newJobsPath, "utf8")).length, 1);
    assert.match(await readFile(readmePath, "utf8"), /2 current openings/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("manual test sends exactly one current role", async () => {
  const directory = await mkdtemp(join(tmpdir(), "adventist-test-alert-"));
  const statePath = join(directory, "seen.json");
  const alertPath = join(directory, "alert.md");
  try {
    await writeFile(statePath, '{"initialized":true,"seen":["100","101"]}\n');
    const result = await runMonitor({
      statePath,
      alertPath,
      sendTestAlert: true,
      fetchImpl: async () =>
        jsonResponse(
          payload([
            rawJob({ id: "101", title: "RN Resident, Pediatrics" }),
            rawJob({ id: "100", title: "RN, Acute Care" }),
          ]),
        ),
    });
    assert.equal(result.newJobs.length, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("README section has a useful empty state", () => {
  assert.match(buildListingsSection([]), /No matching openings/);
});

test("new Discord alert is embedded and notifies everyone", () => {
  const job = {
    ...parseSearchPayload(payload([rawJob({ id: "100", title: "RN, Acute Care" })]))
      .jobs[0],
    matchedSearches: ["RN New Grad"],
  };
  const [message] = buildNewRolePayloads([job]);
  assert.match(message.content, /@everyone/);
  assert.match(message.content, /\*\*NEW ROLE\*\*/);
  assert.deepEqual(message.allowed_mentions, { parse: ["everyone"] });
  assert.equal(message.embeds[0].fields[0].value, "Adventist Health Portland");
});

test("daily Discord digest batches roles without mass mentions", () => {
  const job = {
    ...parseSearchPayload(payload([rawJob({ id: "100", title: "RN, Acute Care" })]))
      .jobs[0],
    matchedSearches: ["RN New Grad"],
  };
  const messages = buildDailyDigestPayloads(
    Array.from({ length: 9 }, (_, index) => ({ ...job, id: String(index) })),
  );
  assert.equal(messages.length, 2);
  assert.equal(messages[0].embeds.length, 8);
  assert.deepEqual(messages[0].allowed_mentions, { parse: [] });
});

test("empty daily Discord digest sends a no-roles embed", () => {
  const [message] = buildDailyDigestPayloads([]);

  assert.match(message.content, /Current Adventist Health Oregon/);
  assert.equal(message.embeds.length, 1);
  assert.equal(message.embeds[0].title, "No roles available :( Come back tomorrow");
  assert.deepEqual(message.allowed_mentions, { parse: [] });
});

test("Discord sender waits for webhook confirmation", async () => {
  const requests = [];
  const job = {
    ...parseSearchPayload(payload([rawJob({ id: "100", title: "RN, Acute Care" })]))
      .jobs[0],
    matchedSearches: ["RN Resident"],
  };
  await sendDiscordJobs(
    "https://discord.com/api/webhooks/example/token",
    [job],
    "new",
    async (url, options) => {
      requests.push({ url: String(url), options });
      return { ok: true };
    },
  );
  assert.equal(requests.length, 1);
  assert.match(requests[0].url, /wait=true/);
  assert.equal(JSON.parse(requests[0].options.body).embeds.length, 1);
});
