import assert from "node:assert/strict";
import { test } from "node:test";
import { stripAdTrackerUrlsForLlm, transformContent } from "../src/application/use-cases/transform-content.ts";
import { detectSensitiveTransformInput } from "../src/infrastructure/llm/safety.ts";
import type { Result } from "../src/domain/result.ts";

function bare(over: Partial<Result>): Result {
  return {
    url: "https://x.test", bytes: 0, code: 200, codeText: "OK", durationMs: 0, result: "",
    schemaVersion: 1, finalUrl: "https://x.test", redirects: [], tier: 1, output: "summary",
    platform: { adapterId: "generic", label: "Generic", detectedFrom: "tier1" }, jsRequired: false,
    resolvedVia: "tier1", attempts: [], contentType: "text/html", timings: { totalMs: 0, fetchMs: 0 }, errors: [],
    ...over,
  };
}

test("transformContent prepends title + OG description when body is gated/thin (Pinterest regression)", () => {
  const c = transformContent(bare({
    title: "Decoração Festa Infantil fundo do mar",
    result: "", // login-gated body, no real content
    structured: { og: { "og:title": "Decoração Festa Infantil fundo do mar", "og:description": "Underwater party ideas" } },
  }));
  assert.ok(c.startsWith("Title: Decoração Festa Infantil fundo do mar"), `expected title preamble, got: ${c.slice(0, 80)}`);
  assert.ok(c.includes("Description: Underwater party ideas"));
});

test("transformContent appends JSON-LD as verified fields when present", () => {
  const c = transformContent(bare({
    title: "Job", result: "body text",
    structured: { jsonLd: { "@type": "JobPosting", title: "Job" } },
  }));
  assert.ok(c.includes("Title: Job"));
  assert.ok(c.includes("body text"));
  assert.ok(c.includes("Verified structured data (JSON-LD)"));
});

test("transformContent strips articleBody/description from JSON-LD (keeps metadata)", () => {
  const c = transformContent(bare({
    result: "visible body text",
    structured: {
      jsonLd: {
        "@type": "NewsArticle",
        headline: "H",
        articleBody: "HUGE DUPLICATED BODY TEXT",
        description: "long verbose description",
        author: { "@type": "Person", name: "Ada" },
      },
    },
  }));
  assert.ok(c.includes("visible body text"), "body still present");
  assert.ok(c.includes("NewsArticle"), "metadata kept");
  assert.ok(c.includes("Ada"), "nested metadata kept");
  assert.ok(!c.includes("HUGE DUPLICATED BODY TEXT"), "articleBody must be stripped");
  assert.ok(!c.includes("long verbose description"), "description must be stripped");
});

test("transformContent always includes the page-metadata envelope hint", () => {
  const c = transformContent(bare({ result: "just body" }));
  assert.match(c, /^Page metadata: contentType=unknown, finalUrl=https:\/\/x\.test, access=public, images=0\n\n/);
  assert.ok(c.endsWith("just body"));
});

test("transformContent strips ad/tracker URLs (token reduction) but keeps real content + first-party URLs (#44 phase 2)", () => {
  const adHeavy = [
    "O ministro afirmou ontem que a reforma será votada.",
    "Advertisement https://ad.doubleclick.net/ddm/track/?token=AfKj9xZp7Q2m&key=12345",
    "Continue lendo https://www.google-analytics.com/collect?v=1&tid=UA-1234&t=pageview",
    "Sponsored https://taboola.com/2x/redirect?pkg=abc",
  ].join("\n");
  const base = bare({
    title: "Reforma será votada",
    result: adHeavy,
    finalUrl: "https://estadao.com.br/politica/reforma",
    structured: {
      jsonLd: {
        "@type": "NewsArticle",
        headline: "Reforma será votada",
        author: { "@type": "Person", name: "Ada" },
        image: "https://img.estadao.com.br/cdn/asset.jpg", // first-party CDN image — KEPT
        publisher: { logo: "https://doubleclick.net/logo.png" }, // ad tracker — STRIPPED
      },
    },
  });
  // transformContent is PRE-strip; stripAdTrackerUrlsForLlm is the LLM-bound view.
  const c = stripAdTrackerUrlsForLlm(transformContent(base), base);
  // Real article content survives.
  assert.ok(c.includes("O ministro afirmou ontem que a reforma será votada."), "article body kept");
  assert.ok(c.includes("Reforma será votada"), "headline kept");
  assert.ok(c.includes("Ada"), "author kept");
  // First-party image URL survives (estadao.com.br is not an ad tracker).
  assert.ok(c.includes("img.estadao.com.br/cdn/asset.jpg"), "first-party image URL kept");
  // Ad/tracker URLs are stripped from body and JSON-LD.
  assert.ok(!c.includes("doubleclick.net"), "doubleclick URL stripped");
  assert.ok(!c.includes("google-analytics.com"), "google-analytics URL stripped");
  assert.ok(!c.includes("taboola.com"), "taboola URL stripped");
  // The source page URL in the envelope hint is NOT an ad tracker and survives.
  assert.ok(c.includes("estadao.com.br/politica/reforma"), "finalUrl kept");
  // Measurable token/size reduction: the ad-URL literals (~200 bytes here) are
  // absent from the content that reaches the safety scan + LLM.
  const adUrlBytes = [
    "https://ad.doubleclick.net/ddm/track/?token=AfKj9xZp7Q2m&key=12345",
    "https://www.google-analytics.com/collect?v=1&tid=UA-1234&t=pageview",
    "https://taboola.com/2x/redirect?pkg=abc",
    "https://doubleclick.net/logo.png",
  ];
  for (const u of adUrlBytes) assert.ok(!c.includes(u), `${u} must be stripped`);
  assert.ok(adUrlBytes.join("").length > 150, "ad-URL payload is a substantial reduction");
});

test("stripAdTrackerUrls does not over-strip a legit URL comma/ampersand-adjacent to a tracker (review fix)", () => {
  const base = bare({
    result: [
      "Links:",
      "https://doubleclick.net/ad1,https://estadao.com.br/real-article",
      "https://doubleclick.net/ad2&https://estadao.com.br/other",
      "https://doubleclick.net:8080/x",          // explicit port — still matched by name
      "https://u:p@googletagmanager.com/gtm.js", // userinfo — host still matched
    ].join("\n"),
  });
  const c = stripAdTrackerUrlsForLlm(transformContent(base), base);
  assert.ok(!c.includes("doubleclick.net"), "tracker URLs stripped (incl. with port)");
  assert.ok(!c.includes("googletagmanager.com"), "tracker with userinfo stripped");
  // Legit first-party URLs are NOT swallowed by greedy adjacency matching.
  assert.ok(c.includes("https://estadao.com.br/real-article"), "comma-adjacent legit URL preserved");
  assert.ok(c.includes("https://estadao.com.br/other"), "ampersand-adjacent legit URL preserved");
});

test("stripAdTrackerUrls preserves first-party URLs when a vendor apex IS the fetched page (codex SF-4)", () => {
  const base = bare({
    url: "https://amplitude.com/",
    finalUrl: "https://amplitude.com/product",
    result: [
      "Amplitude is the digital analytics platform.",
      "See https://amplitude.com/pricing and https://www.amplitude.com/docs.",
      "Trackers: https://doubleclick.net/ad https://googletagmanager.com/gtm.js",
    ].join("\n"),
  });
  const c = stripAdTrackerUrlsForLlm(transformContent(base), base);
  // First-party (the fetched page's own apex + subdomains) survive even though
  // amplitude.com is in the adblock list.
  assert.ok(c.includes("https://amplitude.com/pricing"), "first-party page URL preserved");
  assert.ok(c.includes("https://www.amplitude.com/docs"), "first-party www subdomain preserved");
  // Third-party trackers are still stripped.
  assert.ok(!c.includes("doubleclick.net"), "third-party tracker stripped");
  assert.ok(!c.includes("googletagmanager.com"), "third-party tracker stripped");
});

test("P1 (#46): a credential in a tracker query string is caught — scan sees pre-strip content, strip is LLM-only", () => {
  // The bug: the ad-strip truncated tracker URLs at `&`, orphaning `&access_token=…`
  // as bare text the scanner can't see as a URL → credential bypassed local-only
  // routing. Fix: the scan runs on PRE-strip content (full URL intact).
  const base = bare({ result: "See https://doubleclick.net/collect?foo=1&access_token=ya29.a0AfH6SECRET" });
  const pre = transformContent(base); // PRE-strip — what the safety scan now sees
  assert.ok(pre.includes("access_token=ya29.a0AfH6SECRET"), "pre-strip content keeps the credential param");
  assert.equal(detectSensitiveTransformInput({ content: pre }).sensitive, true, "scan flags the access_token");
  // The LLM-bound content still strips the tracker host (token reduction) — but
  // that never affects the scan above.
  const llm = stripAdTrackerUrlsForLlm(pre, base);
  assert.ok(!llm.includes("doubleclick.net"), "LLM content strips the tracker host");
});



