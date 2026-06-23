import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";

/** Cap on a buffered LLM provider response — a summary/extract JSON is KB at
 *  most; 10 MiB is a generous abuse ceiling that prevents unbounded buffering
 *  from a misbehaving/hostile provider endpoint. */
const MAX_RESPONSE_BYTES = 10 * 1024 * 1024;

export async function postJson<T>(url: string, headers: Record<string, string>, body: unknown, timeoutMs: number): Promise<T> {
  const payload = JSON.stringify(body);
  return await new Promise<T>((resolve, reject) => {
    const parsed = new URL(url);
    const request = parsed.protocol === "http:" ? httpRequest : httpsRequest;
    const req = request(parsed, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-length": String(Buffer.byteLength(payload)),
        ...headers,
      },
    }, (res) => {
      const chunks: Buffer[] = [];
      let total = 0;
      res.on("data", (chunk: Buffer | string) => {
        total += chunk.length;
        if (total > MAX_RESPONSE_BYTES) {
          req.destroy(new Error("LLM provider response exceeded the 10 MiB byte cap"));
          return;
        }
        chunks.push(Buffer.from(chunk));
      });
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        if ((res.statusCode ?? 0) < 200 || (res.statusCode ?? 0) >= 300) {
          reject(new Error(`LLM provider returned HTTP ${res.statusCode}: ${text.slice(0, 200)}`));
          return;
        }
        try {
          resolve(JSON.parse(text) as T);
        } catch (error) {
          reject(error);
        }
      });
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error("LLM provider request timed out")));
    req.on("error", reject);
    req.end(payload);
  });
}
