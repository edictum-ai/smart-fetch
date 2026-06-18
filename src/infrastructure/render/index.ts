import { config } from "../../config.ts";
import { PlaywrightRenderer } from "./playwright-renderer.ts";

export { PlaywrightRenderer } from "./playwright-renderer.ts";
export type { PlaywrightRendererDeps } from "./playwright-renderer.ts";
export { P1BrowserUrlGuard } from "./browser-url-guard.ts";
export type { BrowserUrlGuard } from "./browser-url-guard.ts";

/**
 * Pick the renderer from config: a CDP sidecar (browser in its own container —
 * the secure hosted path) or an in-process launch (local-binary path, sandbox
 * on by default). The browser/SSRF blast radius must not run in-process with the
 * hosted gateway — see docs/threat-model.md.
 */
export function createRenderer(): PlaywrightRenderer {
  const cdpEndpoint = config.render.cdpEndpoint();
  if (cdpEndpoint) return new PlaywrightRenderer({ cdpEndpoint });
  return new PlaywrightRenderer({ chromiumSandbox: config.render.chromiumSandbox() });
}
