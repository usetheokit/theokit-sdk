/**
 * `@theokit/sdk/testing` — helpers for testing an agent end to end without a credential.
 *
 * Free of any test-runner import, so it works under any runner.
 */
export type {
  FakeModelRequest,
  FakeModelServer,
  FakeModelServerOptions,
} from "./fake-model-server.js";
export { startFakeModelServer } from "./fake-model-server.js";
