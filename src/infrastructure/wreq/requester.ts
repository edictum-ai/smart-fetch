import type { IncomingHttpHeaders } from "node:http";
import { Readable } from "node:stream";
import { fetch as wreqFetch } from "wreq-js";
import type { FetcherPort } from "../../application/ports/fetcher.ts";
import { GuardedHttpFetcher } from "../http/guarded-fetcher.ts";
import { GuardedFetchError, isAbortError } from "../http/errors.ts";
import {
  type HttpRequester,
  type HttpRequestInput,
  type HttpResponse,
  NodeHttpRequester,
} from "../http/request.ts";

/**
 * Tier-1 wreq-js adapter behind guarded fetch semantics.
 *
 * The guard resolves and validates DNS before this requester is called. For
 * plain HTTP, wreq connects to that checked IP with the original Host header.
 * HTTPS falls back to Node's requester because it can preserve both checked-IP
 * connect semantics and original-host SNI/cert verification.
 */
class WreqTier1Requester implements HttpRequester {
  private readonly httpsFallback: HttpRequester;

  constructor(httpsFallback: HttpRequester = new NodeHttpRequester()) {
    this.httpsFallback = httpsFallback;
  }

  async request(input: HttpRequestInput): Promise<HttpResponse> {
    if (input.url.protocol === "https:") {
      return await this.httpsFallback.request(input);
    }

    try {
      const response = await wreqFetch(connectUrl(input), {
        redirect: "manual",
        signal: input.signal,
        timeout: input.timeoutMs,
        compress: false,
        cookieMode: "ephemeral",
        headers: {
          Host: input.hostHeader,
          "Accept-Encoding": "gzip, br, deflate",
          "User-Agent": "smart-fetch/0.1",
        },
      });

      return {
        status: response.status,
        headers: toIncomingHeaders(response.headers),
        body: response.body ? Readable.fromWeb(response.body) : Readable.from([]),
      };
    } catch (error) {
      if (input.signal.aborted || isAbortError(error)) {
        throw new GuardedFetchError("timeout", "Fetch timed out");
      }
      throw new GuardedFetchError("network_error", "Network request failed");
    }
  }
}

export function createWreqGuardedFetcher(): FetcherPort {
  return new GuardedHttpFetcher({ requester: new WreqTier1Requester() });
}

function connectUrl(input: HttpRequestInput): string {
  const host = input.family === 6 ? `[${input.address}]` : input.address;
  const port = input.url.port ? `:${input.url.port}` : "";
  return `${input.url.protocol}//${host}${port}${input.url.pathname}${input.url.search}`;
}

function toIncomingHeaders(headers: Iterable<[string, string]>): IncomingHttpHeaders {
  const result: IncomingHttpHeaders = {};
  for (const [name, value] of headers) {
    const key = name.toLowerCase();
    const current = result[key];
    if (current === undefined) {
      result[key] = value;
    } else if (Array.isArray(current)) {
      current.push(value);
    } else {
      result[key] = [current, value];
    }
  }
  return result;
}
