import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type {
  FetcherOptions,
  FetcherPort,
  FetcherResult,
  RejectResult,
} from "../src/application/ports/fetcher.ts";
import type { ClockPort } from "../src/application/ports/clock.ts";
import type { TransformPort } from "../src/application/ports/transformer.ts";
import { greenhouseAdapter, extractGreenhouseToken, detectGreenhouseEmbed } from "../src/infrastructure/greenhouse/adapter.ts";
import { leverAdapter, extractLeverToken, detectLeverEmbed } from "../src/infrastructure/lever/adapter.ts";
import { ashbyListAdapter, extractAshbyToken, detectAshbyEmbed } from "../src/infrastructure/ashby/list-adapter.ts";
import { capJobs } from "../src/infrastructure/ats/types.ts";
import { createAdapterRegistry } from "../src/application/adapters.ts";
import { tryTier2ShortCircuit } from "../src/application/use-cases/tier2.ts";
import { createCaptatumUseCase } from "../src/application/use-cases/captatum.ts";
import type { NormalizedBoard } from "../src/infrastructure/ats/types.ts";

function jsonResult(body: unknown, finalUrl = "https://api.test/", truncated = false): FetcherResult {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  const bytes = new TextEncoder().encode(text);
  return {
    status: 200,
    finalUrl,
    redirects: [],
    bodyStream: new ReadableStream<Uint8Array>({ start(c) { c.enqueue(bytes); c.close(); } }),
    contentType: "application/json",
    bytes: bytes.byteLength,
    ...(truncated ? { truncated: true } : {}),
  };
}

function statusResult(status: number, body = "Not Found"): FetcherResult {
  const bytes = new TextEncoder().encode(body);
  return {
    status,
    finalUrl: "https://api.test/",
    redirects: [],
    bodyStream: new ReadableStream<Uint8Array>({ start(c) { c.enqueue(bytes); c.close(); } }),
    contentType: "text/plain",
    bytes: bytes.byteLength,
  };
}

class FakeFetcher implements FetcherPort {
  readonly calls: Array<{ url: string; opts: FetcherOptions }> = [];
  private readonly result: FetcherResult | RejectResult;
  constructor(result: FetcherResult | RejectResult) {
    this.result = result;
  }
  async fetchGuarded(url: string, opts: FetcherOptions): Promise<FetcherResult | RejectResult> {
    this.calls.push({ url, opts });
    return this.result;
  }
}

class FakeClock implements ClockPort {
  private i = 0;
  private readonly ticks: number[];
  constructor(ticks: number[]) {
    this.ticks = ticks;
  }
  nowMs(): number {
    const t = this.ticks[Math.min(this.i, this.ticks.length - 1)];
    this.i += 1;
    return t ?? 0;
  }
}

const reject: RejectResult = { rejected: true, code: "private_ip", message: "blocked" };

// ---------- token extraction + sanitization (SSRF first line of defense) ----------

test("greenhouse token extraction: board root lists; job-detail + api-host + sanitization", () => {
  // board ROOT (exactly 1 segment) → list
  assert.equal(extractGreenhouseToken("https://boards.greenhouse.io/figma")?.token, "figma");
  assert.equal(extractGreenhouseToken("https://boards.greenhouse.io/figma")?.from, "url-host");
  assert.equal(extractGreenhouseToken("https://boards.greenhouse.io/acme?x=1")?.token, "acme"); // query is fine
  // ?gh_jid= is Greenhouse's single-job link shape (board root + job id) → fall through to Tier-1.
  assert.equal(extractGreenhouseToken("https://boards.greenhouse.io/figma?gh_jid=5364702004"), null);
  // API host (the list API itself) → list
  assert.equal(extractGreenhouseToken("https://boards-api.greenhouse.io/v1/boards/figma/jobs")?.token, "figma");
  assert.equal(extractGreenhouseToken("https://boards-api.greenhouse.io/v1/boards/figma/jobs")?.from, "api-host");
  // a single JOB-DETAIL url (/{token}/jobs/{id}) falls through to Tier-1 — NOT claimed as a board
  assert.equal(extractGreenhouseToken("https://boards.greenhouse.io/figma/jobs/5364702004"), null);
  assert.equal(extractGreenhouseToken("https://boards.greenhouse.io/acme/jobs/9"), null);
  // reserved infra paths are not boards
  assert.equal(extractGreenhouseToken("https://boards.greenhouse.io/embed/board?id=x"), null);
  // injection: an encoded path-traversal token fails closed (the `%` is outside the slug charset)
  assert.equal(extractGreenhouseToken("https://boards.greenhouse.io/..%2Fadmin"), null);
  assert.equal(extractGreenhouseToken("not a url"), null);
});

test("lever token extraction: board root lists; job-detail falls through", () => {
  assert.equal(extractLeverToken("https://jobs.lever.co/acmeco")?.token, "acmeco");
  assert.equal(extractLeverToken("https://jobs.lever.co/acmeco/")?.token, "acmeco"); // trailing slash = board root
  assert.equal(extractLeverToken("https://api.lever.co/v0/postings/acmeco?mode=json")?.token, "acmeco");
  // a single posting url (/{site}/{postingId}) falls through to Tier-1
  assert.equal(extractLeverToken("https://jobs.lever.co/acmeco/33538a2f-d27d-4a96"), null);
  assert.equal(extractLeverToken("https://jobs.lever.co/"), null);
});

test("ashby token extraction: board root lists; job-detail falls through", () => {
  assert.equal(extractAshbyToken("https://jobs.ashbyhq.com/langfuse")?.token, "langfuse");
  assert.equal(extractAshbyToken("https://api.ashbyhq.com/posting-api/job-board/langfuse?includeCompensation=true")?.token, "langfuse");
  // a single job url (/{org}/{jobId}) falls through to Tier-1 (SSR JobPosting JSON-LD)
  assert.equal(extractAshbyToken("https://jobs.ashbyhq.com/langfuse/1225fa3d"), null);
  assert.equal(extractAshbyToken("https://jobs.ashbyhq.com/embed"), null);
  assert.equal(extractAshbyToken("https://jobs.ashbyhq.com/api/x"), null);
  assert.equal(extractAshbyToken("https://jobs.ashbyhq.com/..%2Fadmin"), null);
});

// ---------- detect() URL + embed-HTML ----------

test("detect returns the adapter for ATS hosts, null otherwise; ashby_jid custom-domain is NOT grabbed", () => {
  const reg = createAdapterRegistry();
  assert.equal(reg.detect({ url: "https://boards.greenhouse.io/figma" })?.adapterId, "greenhouse");
  assert.equal(reg.detect({ url: "https://jobs.lever.co/acmeco" })?.adapterId, "lever");
  assert.equal(reg.detect({ url: "https://jobs.ashbyhq.com/langfuse" })?.adapterId, "ashby");
  assert.equal(reg.detect({ url: "https://boards-api.greenhouse.io/v1/boards/figma/jobs" })?.adapterId, "greenhouse");
  assert.equal(reg.detect({ url: "https://example.com/careers" }), null);
  // Non-regression: the single-job Ashby embed resolver owns ashby_jid custom-domain URLs;
  // the list adapter must not claim them.
  assert.equal(reg.detect({ url: "https://e2b.dev/careers?ashby_jid=abc" }), null);
});

test("embed-script detection from HTML", () => {
  assert.equal(detectGreenhouseEmbed('<script src="https://boards.greenhouse.io/embed/job_board/js?board=acme">'), "acme");
  assert.equal(detectGreenhouseEmbed('<script src="https://boards.greenhouse.io/embed/job_board/js?for=acme">'), "acme");
  assert.equal(detectLeverEmbed('<script src="https://api.lever.co/v0/postings/acmeco?mode=json">'), "acmeco");
  assert.equal(detectAshbyEmbed('<script src="https://jobs.ashbyhq.com/e2b/embed">'), "e2b");
  assert.equal(detectAshbyEmbed("no markers here"), null);
});

// resolve() for each ATS: pinned API URL (SSRF) + normalized field mapping

test("greenhouse resolve: hits the pinned v1 API, normalizes title/location (no departments in metadata-only mode)", async () => {
  const fixture = JSON.parse(readFileSync("test/fixtures/ats/greenhouse-jobs.json", "utf8"));
  const fetcher = new FakeFetcher(jsonResult(fixture, "https://boards-api.greenhouse.io/v1/boards/figma/jobs"));
  const res = await greenhouseAdapter.resolve({ url: "https://boards.greenhouse.io/figma", now: "2026-07-01T00:00:00.000Z" }, fetcher);
  // SSRF: the adapter called ONLY the pinned API host with the sanitized token
  assert.deepEqual(fetcher.calls.map((c) => c.url), ["https://boards-api.greenhouse.io/v1/boards/figma/jobs"]);
  const board: NormalizedBoard = JSON.parse(res.content);
  assert.equal(board.platform, "greenhouse");
  assert.equal(board.board, "figma");
  assert.equal(board.jobCount, 3);
  assert.equal(board.jobs[0].title, "Account Executive, Emerging Enterprise (Berlin, Germany)");
  assert.equal(board.jobs[0].location, "Berlin, Germany");
  // Greenhouse's metadata-only /jobs response (no content=true) omits per-job departments, so
  // department is honestly null here — the field is still populated for Lever/Ashby.
  assert.equal(board.jobs[0].department, null);
  assert.ok(board.jobs[0].url.startsWith("https://boards.greenhouse.io/figma/jobs/"));
  assert.equal(board.truncated, false);
});

test("lever resolve: title from `text`, publishedAt from createdAt epoch, categories mapping", async () => {
  const fixture = JSON.parse(readFileSync("test/fixtures/ats/lever-postings.json", "utf8"));
  const fetcher = new FakeFetcher(jsonResult(fixture));
  const res = await leverAdapter.resolve({ url: "https://jobs.lever.co/acmeco", now: "2026-07-01T00:00:00.000Z" }, fetcher);
  assert.deepEqual(fetcher.calls.map((c) => c.url), ["https://api.lever.co/v0/postings/acmeco?mode=json"]);
  const board: NormalizedBoard = JSON.parse(res.content);
  assert.equal(board.platform, "lever");
  assert.equal(board.jobCount, 3);
  assert.equal(board.jobs[0].title, "AbelsonTaylor Writer"); // Lever uses `text`
  assert.equal(board.jobs[0].location, "Arlington, TX");
  assert.equal(board.jobs[0].employmentType, "Regular Full Time (Salary)");
  assert.equal(board.jobs[0].workplaceType, "hybrid");
  assert.equal(board.jobs[0].publishedAt, "2019-03-21T16:33:55.299Z"); // epoch-ms → ISO
});

test("ashby resolve: compensation summary + isRemote + workplaceType", async () => {
  const fixture = JSON.parse(readFileSync("test/fixtures/ats/ashby-jobs.json", "utf8"));
  const fetcher = new FakeFetcher(jsonResult(fixture));
  const res = await ashbyListAdapter.resolve({ url: "https://jobs.ashbyhq.com/langfuse", now: "2026-07-01T00:00:00.000Z" }, fetcher);
  assert.deepEqual(fetcher.calls.map((c) => c.url), ["https://api.ashbyhq.com/posting-api/job-board/langfuse?includeCompensation=true"]);
  const board: NormalizedBoard = JSON.parse(res.content);
  assert.equal(board.platform, "ashby");
  assert.equal(board.jobs[0].department, "Engineering");
  assert.equal(board.jobs[0].remote, true);
  assert.equal(board.jobs[0].workplaceType, "Hybrid");
  assert.match(board.jobs[0].compensation ?? "", /€90K/);
  assert.equal(board.jobs[0].url, "https://jobs.ashbyhq.com/langfuse/1225fa3d-d590-41d2-b798-ef927320fb2e");
});

// ---------- graceful failure → fall through ----------

test("resolve throws on reject / non-2xx / unparseable; short-circuit returns null", async () => {
  const now = "2026-07-01T00:00:00.000Z";
  const clock = new FakeClock([100, 200]);
  for (const result of [reject, statusResult(404), statusResult(200, "{not json")]) {
    const fetcher = new FakeFetcher(result);
    await assert.rejects(greenhouseAdapter.resolve({ url: "https://boards.greenhouse.io/figma", now }, fetcher));
    const out = await tryTier2ShortCircuit({ adapters: createAdapterRegistry(), url: "https://boards.greenhouse.io/figma", now, fetcher, clock });
    assert.equal(out, null, "a failed resolve must fall through to the generic path");
  }
});

test("short-circuit returns null for a non-ATS url (no detection)", async () => {
  const out = await tryTier2ShortCircuit({ adapters: createAdapterRegistry(), url: "https://example.com/careers", now: "2026-07-01T00:00:00.000Z", fetcher: new FakeFetcher(jsonResult({})), clock: new FakeClock([100]) });
  assert.equal(out, null);
});

// ---------- roster cap ----------

test("capJobs bounds the roster and flags truncation", () => {
  const big = Array.from({ length: 600 }, (_, i) => ({ i }));
  const capped = capJobs(big);
  assert.equal(capped.jobs.length, 500);
  assert.equal(capped.truncated, true);
  const small = capJobs([{ a: 1 }]);
  assert.equal(small.jobs.length, 1);
  assert.equal(small.truncated, false);
});

// ---------- integration via the use case (end-to-end Tier-2 path) ----------

test("CaptatumUseCase short-circuits an ATS url to a tier-2 result, fetching only the API", async () => {
  const fixture = JSON.parse(readFileSync("test/fixtures/ats/greenhouse-jobs.json", "utf8"));
  const fetcher = new FakeFetcher(jsonResult(fixture, "https://boards-api.greenhouse.io/v1/boards/figma/jobs"));
  // The extractor must NOT run — Tier-2 resolves before any HTML extraction.
  const extractHtml = (() => { throw new Error("extractor must not run for a Tier-2 URL"); }) as never;
  const result = await createCaptatumUseCase({
    fetcher,
    extractHtml,
    clock: new FakeClock([100, 150, 160]),
  }).execute({ url: "https://boards.greenhouse.io/figma", output: "raw" }, { fetchedAt: "2026-07-01T00:00:00.000Z" });

  assert.equal(result.tier, 2);
  assert.equal(result.platform.adapterId, "greenhouse");
  assert.equal(result.resolvedVia, "tier2-greenhouse");
  assert.equal(result.contentType, "application/json");
  assert.deepEqual(fetcher.calls.map((c) => c.url), ["https://boards-api.greenhouse.io/v1/boards/figma/jobs"]);
  const board: NormalizedBoard = JSON.parse(result.result);
  assert.equal(board.platform, "greenhouse");
  assert.equal(board.jobCount, 3);
  // P2: bytes reports the FETCHED API payload (egress/audit), not the normalized roster size.
  const fetchedBytes = Buffer.byteLength(JSON.stringify(fixture), "utf8");
  assert.equal(result.bytes, fetchedBytes);
  assert.notEqual(result.bytes, Buffer.byteLength(result.result, "utf8"));
  // P2: contentSha256 hashes the FETCHED payload (content-addressable evidence), not the roster.
  const fetchedSha = createHash("sha256").update(JSON.stringify(fixture)).digest("hex");
  assert.equal(result.contentSha256, fetchedSha);
  assert.notEqual(result.contentSha256, createHash("sha256").update(result.result).digest("hex"));
  // P3: the Tier-2 attempt is labeled step 2 (step 1 = Tier-1, step 3 = render), not step 1.
  assert.equal(result.attempts[0]?.step, 2);
});

test("CaptatumUseCase falls through to the generic path for a non-ATS url", async () => {
  const fetcher = new FakeFetcher(jsonResult({ jobs: [] })); // unused for tier2, but returned if generic fetch ran
  const extractHtml = (() => ({ title: "", text: "", structured: {}, shellGate: { jsRequired: false, reason: "content-present", textLength: 0, wordCount: 0, scriptCount: 0, appRootFound: false, structuredDataFound: false }, errors: [] })) as never;
  // A non-ATS url with an application/json body: tier2 detect is null → generic Tier-1 path runs.
  const result = await createCaptatumUseCase({
    fetcher,
    extractHtml,
    clock: new FakeClock([100, 150, 160, 160]),
  }).execute({ url: "https://example.com/careers", output: "raw" });
  assert.notEqual(result.tier, 2);
});

// ---------- review-driven regressions ----------

test("cap-then-map: a >cap board reports the true count, caps the jobs, flags truncated", async () => {
  const bigBoard = {
    jobs: Array.from({ length: 600 }, (_, i) => ({
      id: i,
      title: `Role ${i}`,
      absolute_url: `https://boards.greenhouse.io/big/jobs/${i}`,
    })),
  };
  const fetcher = new FakeFetcher(jsonResult(bigBoard));
  const res = await greenhouseAdapter.resolve({ url: "https://boards.greenhouse.io/big", now: "2026-07-01T00:00:00.000Z" }, fetcher);
  const board: NormalizedBoard = JSON.parse(res.content);
  assert.equal(board.jobCount, 600);     // rawCount = true board size (input was capped, not the count)
  assert.equal(board.jobs.length, 500);  // roster capped at ATS_JOB_CAP
  assert.equal(board.truncated, true);
});

test("a byte-truncated board response falls through (never served as a complete roster)", async () => {
  // truncated:true with a body that happens to be valid JSON prefix — must NOT be served.
  const fetcher = new FakeFetcher(jsonResult({ jobs: [{ id: 1, title: "A", absolute_url: "https://x/y/1" }] }, "https://api.test/", true));
  await assert.rejects(greenhouseAdapter.resolve({ url: "https://boards.greenhouse.io/x", now: "2026-07-01T00:00:00.000Z" }, fetcher));
  const out = await tryTier2ShortCircuit({ adapters: createAdapterRegistry(), url: "https://boards.greenhouse.io/x", now: "2026-07-01T00:00:00.000Z", fetcher, clock: new FakeClock([100, 200]) });
  assert.equal(out, null);
});

test("single-job ATS detail URLs fall through to the generic path (not claimed as a board)", async () => {
  // A job-detail URL on each ATS host must NOT be claimed — Tier-1 extracts the specific job.
  const reg = createAdapterRegistry();
  assert.equal(reg.detect({ url: "https://jobs.ashbyhq.com/langfuse/1225fa3d-d590-41d2-b798-ef927320fb2e" }), null);
  assert.equal(reg.detect({ url: "https://boards.greenhouse.io/figma/jobs/5364702004" }), null);
  assert.equal(reg.detect({ url: "https://jobs.lever.co/acmeco/33538a2f-d27d-4a96-8f05-fa4b0e4d940e" }), null);
  const out = await tryTier2ShortCircuit({ adapters: reg, url: "https://jobs.ashbyhq.com/langfuse/1225fa3d", now: "2026-07-01T00:00:00.000Z", fetcher: new FakeFetcher(jsonResult({})), clock: new FakeClock([100]) });
  assert.equal(out, null);
});

test("no-provider summary on a Tier-2 roster returns parseable JSON, not a sliced excerpt", async () => {
  // Regression: output:"summary" with no transformer used to run fallbackExcerpt, slicing the JSON
  // mid-object and labelling the corrupt result application/json. A >10-job roster exceeds the excerpt.
  const board = {
    jobs: Array.from({ length: 20 }, (_, i) => ({
      id: i,
      title: `Role number ${i} at the company`,
      absolute_url: `https://boards.greenhouse.io/x/jobs/${i}`,
      location: { name: "Berlin, Germany" },
    })),
  };
  const fetcher = new FakeFetcher(jsonResult(board, "https://boards-api.greenhouse.io/v1/boards/x/jobs"));
  const extractHtml = (() => { throw new Error("extractor must not run for a Tier-2 URL"); }) as never;
  const result = await createCaptatumUseCase({
    fetcher,
    extractHtml,
    clock: new FakeClock([100, 150, 160, 160]),
  }).execute({ url: "https://boards.greenhouse.io/x", output: "summary" });

  assert.equal(result.tier, 2);
  assert.equal(result.output, "raw");
  assert.equal(result.transform?.provider, "none");
  assert.equal(result.contentType, "application/json");
  // The roster MUST be parseable JSON (not byte-sliced mid-object).
  const parsed: NormalizedBoard = JSON.parse(result.result);
  assert.equal(parsed.jobCount, 20);
  assert.equal(parsed.jobs.length, 20);
});

test("a provider:none transform fallback restores the parseable Tier-2 roster", async () => {
  // A configured transformer that resolves to provider:none returns a preambled LLM input as
  // transformed.result; the Tier-2 path must restore the original roster (parseable JSON), not keep it.
  const board = { jobs: Array.from({ length: 12 }, (_, i) => ({ id: i, title: `Role ${i}`, absolute_url: `https://boards.greenhouse.io/x/jobs/${i}` })) };
  const fetcher = new FakeFetcher(jsonResult(board, "https://boards-api.greenhouse.io/v1/boards/x/jobs"));
  const extractHtml = (() => { throw new Error("extractor must not run for a Tier-2 URL"); }) as never;
  const transformer: TransformPort = {
    async transform() { return { result: "Title: x\nPage metadata: ...\nNOT-JSON-PREAMBLE", info: { provider: "none", reason: "unconfigured" } }; },
  };
  const result = await createCaptatumUseCase({ fetcher, extractHtml, transformer, clock: new FakeClock([100, 150, 160, 160]) })
    .execute({ url: "https://boards.greenhouse.io/x", output: "summary" });
  assert.equal(result.tier, 2);
  assert.equal(result.contentType, "application/json");
  assert.equal(result.transform?.provider, "none");
  const parsed: NormalizedBoard = JSON.parse(result.result); // parseable roster restored, not the preamble
  assert.equal(parsed.jobCount, 12);
});

test("single-job ATS DETAIL API URLs fall through; only the exact list endpoint is claimed", () => {
  // list endpoint shapes are claimed
  assert.equal(extractGreenhouseToken("https://boards-api.greenhouse.io/v1/boards/figma/jobs")?.token, "figma");
  assert.equal(extractLeverToken("https://api.lever.co/v0/postings/acmeco")?.token, "acmeco");
  assert.equal(extractAshbyToken("https://api.ashbyhq.com/posting-api/job-board/langfuse")?.token, "langfuse");
  // a trailing job-id (single-item API URL) is NOT claimed → falls through to Tier-1
  assert.equal(extractGreenhouseToken("https://boards-api.greenhouse.io/v1/boards/figma/jobs/5364702004"), null);
  assert.equal(extractLeverToken("https://api.lever.co/v0/postings/acmeco/abc-posting-id"), null);
  assert.equal(extractAshbyToken("https://api.ashbyhq.com/posting-api/job-board/langfuse/extra-seg"), null);
});

test("caller fetch caps are honored (min with the ATS platform limit)", async () => {
  const fixture = JSON.parse(readFileSync("test/fixtures/ats/greenhouse-jobs.json", "utf8"));
  const fetcher = new FakeFetcher(jsonResult(fixture));
  await greenhouseAdapter.resolve(
    { url: "https://boards.greenhouse.io/figma", now: "2026-07-01T00:00:00.000Z", maxBytes: 1024, timeoutMs: 1000, maxHops: 2 },
    fetcher,
  );
  assert.equal(fetcher.calls[0]?.opts.maxBytes, 1024); // min(ATS 8MiB, caller 1024) = 1024
  assert.equal(fetcher.calls[0]?.opts.timeoutMs, 1000);
  assert.equal(fetcher.calls[0]?.opts.maxHops, 2);
});

test("Greenhouse job-boards host is detected (token routes to the same API)", () => {
  // Greenhouse serves board roots on job-boards.greenhouse.io too (verified: reddit).
  assert.equal(extractGreenhouseToken("https://job-boards.greenhouse.io/reddit")?.token, "reddit");
  assert.equal(extractGreenhouseToken("https://job-boards.greenhouse.io/reddit")?.from, "url-host");
  // a job-detail path on that host still falls through to Tier-1
  assert.equal(extractGreenhouseToken("https://job-boards.greenhouse.io/reddit/jobs/8012700"), null);
});

test("Lever EU boards are flagged and routed to api.eu.lever.co (not the US instance)", async () => {
  assert.equal(extractLeverToken("https://jobs.eu.lever.co/acmeco")?.token, "acmeco");
  assert.equal(extractLeverToken("https://jobs.eu.lever.co/acmeco")?.eu, true);
  assert.equal(extractLeverToken("https://api.eu.lever.co/v0/postings/acmeco")?.eu, true);
  assert.equal(extractLeverToken("https://jobs.lever.co/acmeco")?.eu, false);
  const fixture = JSON.parse(readFileSync("test/fixtures/ats/lever-postings.json", "utf8"));
  const fetcher = new FakeFetcher(jsonResult(fixture));
  await leverAdapter.resolve({ url: "https://jobs.eu.lever.co/acmeco", now: "2026-07-01T00:00:00.000Z" }, fetcher);
  assert.deepEqual(fetcher.calls.map((c) => c.url), ["https://api.eu.lever.co/v0/postings/acmeco?mode=json"]);
});

test("an ATS URL with an explicit port does NOT short-circuit (preserves the fetchGuarded port guard)", async () => {
  // boards.greenhouse.io:22 would be rejected as blocked_port in the generic path; the short-circuit
  // must not rewrite it to the legit API (default port) and bypass that guard.
  const fetcher = new FakeFetcher(jsonResult({ jobs: [] }));
  const out = await tryTier2ShortCircuit({ adapters: createAdapterRegistry(), url: "https://boards.greenhouse.io:22/figma", now: "2026-07-01T00:00:00.000Z", fetcher, clock: new FakeClock([100]) });
  assert.equal(out, null);
  assert.equal(fetcher.calls.length, 0); // the adapter never fetched — fell through to the generic path
});

test("non-canonical ATS API paths are not claimed (only the exact documented endpoint)", () => {
  // canonical list endpoints ARE claimed
  assert.equal(extractGreenhouseToken("https://boards-api.greenhouse.io/v1/boards/figma/jobs")?.token, "figma");
  assert.equal(extractLeverToken("https://api.lever.co/v0/postings/acmeco")?.token, "acmeco");
  assert.equal(extractAshbyToken("https://api.ashbyhq.com/posting-api/job-board/langfuse")?.token, "langfuse");
  // non-canonical: wrong version, or the marker segment not at its canonical position
  assert.equal(extractGreenhouseToken("https://boards-api.greenhouse.io/v2/boards/figma/jobs"), null);
  assert.equal(extractGreenhouseToken("https://boards-api.greenhouse.io/foo/boards/figma/jobs"), null);
  assert.equal(extractLeverToken("https://api.lever.co/v1/postings/acmeco"), null);
  assert.equal(extractAshbyToken("https://api.ashbyhq.com/v2/job-board/langfuse"), null);
});

test("Lever salary fields are mapped into compensation", async () => {
  const postings = [
    { id: "a", text: "Paid Role", hostedUrl: "https://jobs.lever.co/x/a", createdAt: 1553186035299, salaryRange: { min: 10000, max: 125000, currency: "USD", interval: "per-year-salary" } },
    { id: "b", text: "Plain Role", hostedUrl: "https://jobs.lever.co/x/b", createdAt: 1553186035299, salaryDescriptionPlain: "€80K-€120K" },
    { id: "c", text: "No Pay", hostedUrl: "https://jobs.lever.co/x/c", createdAt: 1553186035299 },
  ];
  const fetcher = new FakeFetcher(jsonResult(postings));
  const res = await leverAdapter.resolve({ url: "https://jobs.lever.co/x", now: "2026-07-01T00:00:00.000Z" }, fetcher);
  const board: NormalizedBoard = JSON.parse(res.content);
  assert.equal(board.jobs[0].compensation, "USD 10000-125000 per-year-salary"); // formatted salaryRange
  assert.equal(board.jobs[1].compensation, "€80K-€120K"); // pre-formatted description
  assert.equal(board.jobs[2].compensation, null); // no salary data
});

test("Ashby direct-link-only (isListed:false) jobs are excluded from the roster and count", async () => {
  const board = { jobs: [
    { id: "1", title: "Listed", jobUrl: "https://jobs.ashbyhq.com/x/1", isListed: true },
    { id: "2", title: "Hidden", jobUrl: "https://jobs.ashbyhq.com/x/2", isListed: false },
    { id: "3", title: "Default-listed", jobUrl: "https://jobs.ashbyhq.com/x/3" }, // isListed absent → treated as listed
  ] };
  const fetcher = new FakeFetcher(jsonResult(board));
  const res = await ashbyListAdapter.resolve({ url: "https://jobs.ashbyhq.com/x", now: "2026-07-01T00:00:00.000Z" }, fetcher);
  const env: NormalizedBoard = JSON.parse(res.content);
  assert.equal(env.jobCount, 2); // the isListed:false job excluded from the count too
  assert.deepEqual(env.jobs.map((j) => j.title), ["Listed", "Default-listed"]);
});

