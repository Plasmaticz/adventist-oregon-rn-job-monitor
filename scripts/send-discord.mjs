import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const EMBEDS_PER_MESSAGE = 8;
const NEW_ROLE_COLOR = 0xf05a28;
const DAILY_DIGEST_COLOR = 0x176b55;

function clean(value, fallback = "Not listed", limit = 1000) {
  const text = String(value ?? "").trim() || fallback;
  return text.slice(0, limit);
}

function formatDate(value) {
  if (!value) return "Not listed";
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? clean(value) : date.toISOString().slice(0, 10);
}

export function buildJobEmbed(job, { isNew = false } = {}) {
  return {
    title: clean(job.title, "Adventist Health RN role", 256),
    url: job.url,
    description: isNew
      ? "A new Adventist Health Oregon nursing opportunity was just posted."
      : "Current Adventist Health Oregon nursing opening",
    color: isNew ? NEW_ROLE_COLOR : DAILY_DIGEST_COLOR,
    fields: [
      { name: "Facility", value: clean(job.organization), inline: true },
      { name: "Location", value: clean(job.location), inline: true },
      { name: "Posted", value: formatDate(job.postedAt), inline: true },
      { name: "Work location", value: clean(job.workLocation), inline: true },
      {
        name: "Matched search",
        value: clean(job.matchedSearches?.join(", ")),
        inline: true,
      },
      { name: "Requisition", value: clean(job.requisitionId), inline: true },
    ],
    footer: { text: "Adventist Health Oregon RN Job Monitor" },
  };
}

export function buildNewRolePayloads(jobs) {
  return jobs.map((job) => ({
    content: "@everyone\n# **NEW ROLE**",
    embeds: [buildJobEmbed(job, { isNew: true })],
    allowed_mentions: { parse: ["everyone"] },
  }));
}

export function buildDailyDigestPayloads(jobs) {
  if (jobs.length === 0) {
    return [
      {
        content: "# Current Adventist Health Oregon New-Grad RN Roles",
        embeds: [
          {
            title: "No roles available :( Come back tomorrow",
            description: "No matching openings are currently listed.",
            color: DAILY_DIGEST_COLOR,
            footer: { text: "Adventist Health Oregon RN Job Monitor" },
          },
        ],
        allowed_mentions: { parse: [] },
      },
    ];
  }

  const payloads = [];
  for (let index = 0; index < jobs.length; index += EMBEDS_PER_MESSAGE) {
    payloads.push({
      content:
        index === 0
          ? `# Current Adventist Health Oregon New-Grad RN Roles\n**${jobs.length} current ${jobs.length === 1 ? "opening" : "openings"}**`
          : "**Current Adventist Health roles continued**",
      embeds: jobs
        .slice(index, index + EMBEDS_PER_MESSAGE)
        .map((job) => buildJobEmbed(job)),
      allowed_mentions: { parse: [] },
    });
  }
  return payloads;
}

export async function sendDiscordPayloads(webhookUrl, payloads, fetchImpl = fetch) {
  const url = new URL(webhookUrl);
  url.searchParams.set("wait", "true");
  for (const payload of payloads) {
    const response = await fetchImpl(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: "Adventist Oregon RN Job Monitor",
        ...payload,
      }),
    });
    if (!response.ok) {
      throw new Error(
        `Discord webhook failed (${response.status}): ${await response.text()}`,
      );
    }
  }
}

export async function sendDiscordJobs(webhookUrl, jobs, mode, fetchImpl = fetch) {
  const payloads =
    mode === "new"
      ? buildNewRolePayloads(jobs)
      : mode === "daily"
        ? buildDailyDigestPayloads(jobs)
        : null;
  if (!payloads) throw new Error(`Unknown Discord notification mode: ${mode}`);
  await sendDiscordPayloads(webhookUrl, payloads, fetchImpl);
}

async function main() {
  const [mode, jobsPath] = process.argv.slice(2);
  const webhookUrl = process.env.DISCORD_WEBHOOK_URL;
  if (!mode || !jobsPath) throw new Error("Usage: send-discord.mjs MODE JOBS_JSON_PATH");
  if (!webhookUrl) {
    console.log("DISCORD_WEBHOOK_URL is not configured; skipping Discord alert.");
    return;
  }
  const jobs = JSON.parse(await readFile(jobsPath, "utf8"));
  if (!Array.isArray(jobs)) throw new Error("Jobs JSON must contain an array");
  await sendDiscordJobs(webhookUrl, jobs, mode);
  console.log(`Discord ${mode} notification sent for ${jobs.length} jobs.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error.stack ?? error.message);
    process.exitCode = 1;
  });
}
