/**
 * Live Tier-2 ATS verification — runs the REAL production pipeline (guarded
 * fetch + extractHtml) against live ATS career-board URLs and prints the
 * resolved roster. Proves the moat: a generic fetch of e.g. jobs.lever.co
 * returns a JS shell, but the Tier-2 adapter returns the full structured roster.
 *
 *   node --no-warnings src/dev/ats-probe.ts
 *
 * Hits the public network. Add a URL arg to probe a single board.
 */
import { createCaptatumUseCase } from "../application/use-cases/captatum.ts";
import { extractHtml } from "../infrastructure/extract/index.ts";
import { createWreqGuardedFetcher } from "../infrastructure/wreq/requester.ts";

const clock = { nowMs: () => Date.now() };
const captatum = createCaptatumUseCase({
  fetcher: createWreqGuardedFetcher(),
  extractHtml,
  clock,
});

interface Board {
  platform: string;
  url: string;
}

const boards: Board[] = [
  { platform: "greenhouse", url: "https://boards.greenhouse.io/figma" },
  { platform: "lever", url: "https://jobs.lever.co/leverdemo" },
  { platform: "ashby", url: "https://jobs.ashbyhq.com/langfuse" },
];

const argUrl = process.argv[2];
const targets = argUrl ? [{ platform: "arg", url: argUrl }] : boards;

for (const board of targets) {
  process.stdout.write(`\n=== ${board.platform}: ${board.url} ===\n`);
  try {
    const result = await captatum.execute({ url: board.url, output: "raw" });
    process.stdout.write(
      `tier=${result.tier} platform=${result.platform.adapterId} resolvedVia=${result.resolvedVia} code=${result.code} contentType=${result.contentType}\n`,
    );
    if (result.tier !== 2) {
      process.stdout.write(`NOT tier 2 — result head: ${result.result.slice(0, 200)}\n`);
      continue;
    }
    const envelope = JSON.parse(result.result) as {
      platform: string; board: string; jobCount: number; truncated: boolean;
      jobs: Array<{ title: string; location: string | null; department: string | null }>;
    };
    process.stdout.write(
      `roster: ${envelope.jobCount} jobs (truncated=${envelope.truncated}) on board "${envelope.board}"\n`,
    );
    for (const job of envelope.jobs.slice(0, 3)) {
      process.stdout.write(`  - ${job.title}  [${job.location ?? "?"}${job.department ? ` · ${job.department}` : ""}]\n`);
    }
  } catch (error) {
    process.stdout.write(`ERROR: ${error instanceof Error ? error.message : String(error)}\n`);
  }
}
