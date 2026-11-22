// Fixture ACP agent for the client tests. Behaviour is chosen by the prompt text.
import { appendFileSync } from "node:fs";
import { serveAcp } from "../../dist/index.js";

const log = process.env.FIXTURE_LOG;
const note = (line) => {
  if (log) appendFileSync(log, `${line}\n`);
};
const assistant = (text) => ({
  type: "assistant",
  message: { role: "assistant", content: [{ type: "text", text }] },
});

const forever = () => new Promise(() => {});

function makeAgent(sessionId) {
  const handlers = [];
  const manager = {
    register: async (plugin) => {
      plugin.register?.({ on: (_event, handler) => handlers.push(handler) });
    },
  };
  const state = { status: "finished" };
  const scenarios = {
    async *hi() {
      yield assistant("hello ");
      yield assistant("world");
    },
    async *tool() {
      let result;
      for (const handler of handlers)
        result = (await handler({ name: "danger", args: {} })) ?? result;
      note(`permission-result:${JSON.stringify(result ?? null)}`);
      yield assistant(result?.block ? `blocked: ${result.message}` : "allowed");
    },
    async *wait(signal) {
      yield assistant("started");
      await new Promise((resolve) => {
        if (signal.aborted) resolve();
        signal.addEventListener("abort", resolve, { once: true });
      });
      note("cancelled");
      state.status = "cancelled";
    },
    async *pid() {
      yield assistant(String(process.pid));
      await forever();
    },
    async *die() {
      yield assistant("about to die");
      for (let i = 0; i < 40; i++) process.stderr.write(`noise ${i}\n`);
      process.stderr.write("fatal: boom\n", () => process.exit(3));
      await forever();
    },
  };
  return {
    agentId: sessionId,
    pluginManager: () => manager,
    async send(text, options = {}) {
      const scenario = scenarios[text];
      return {
        get status() {
          return state.status;
        },
        stream: () => scenario(options.signal),
        wait: async () => ({ status: state.status }),
        cancel: async () => {},
      };
    },
  };
}

await serveAcp({ agent: makeAgent, permissionDefault: "ask" });
