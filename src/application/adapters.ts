import { PlatformAdapterRegistry } from "./ports/platform-adapter.ts";
import { greenhouseAdapter } from "../infrastructure/greenhouse/adapter.ts";
import { leverAdapter } from "../infrastructure/lever/adapter.ts";
import { ashbyListAdapter } from "../infrastructure/ashby/list-adapter.ts";

/**
 * Build the platform-adapter registry. This is the composition point that wires
 * concrete Tier-2 adapters behind the PlatformAdapter port — one folder under
 * src/infrastructure/<platform>/ + one line here + one fixture each. The use
 * case depends only on the registry (a port type), never on these concretes.
 *
 * Mirrors ~/sandbox's createProviderRegistry pattern.
 */
export function createAdapterRegistry(): PlatformAdapterRegistry {
  return new PlatformAdapterRegistry([ashbyListAdapter, greenhouseAdapter, leverAdapter]);
}
