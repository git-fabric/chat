/**
 * @git-fabric/chat — entry point
 *
 * Re-exports layers, types, and the FabricApp factory for
 * programmatic consumption and gateway registration.
 */
export * from "./types.js";
export * as layers from "./layers/index.js";
export { createApp } from "./app.js";
export { createAdapterFromEnv } from "./adapters/env.js";
export * as sessions from "./layers/sessions.js";
export * as messages from "./layers/messages.js";
export * as search from "./layers/search.js";
//# sourceMappingURL=index.d.ts.map