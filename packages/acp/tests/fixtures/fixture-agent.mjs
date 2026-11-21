// Fixture ACP agent served with serveAcp, run as a child process by tests/client.test.ts.
// Behaviour is picked by FIXTURE_MODE; FIXTURE_LOG is a file it appends observations to.
import { appendFileSync } from "node:fs";
import { serveAcp } from "../../dist/index.js";

const mode = process.env.FIXTURE_MODE ?? "chat";
const log = (line) => {
  if (process.env.FIXTURE_LOG) appendFileSync(process.env.FIXTURE_LOG, `${line}\n`);
};
log(`pid ${process.pid}`);

if (mode === "exit-init") {
  process.stderr.write("fixture: boom during startup\n");
  process.exit(3);
}

const assistant = (text) => ({
  type: "assistant",
  message: { role: "assistant", content: [{ type: "text", text }] },
});

const modes = {
  async *chat() {
    yield assistant("hello ");
    yield assistant("world");
  },
  async *perm(ctx) {
    const verdict = await ctx.hooks[0]({ name: "danger_tool", args: {} });
    log(`permission ${verdict?.block ? "blocked" : "allowed"}: ${verdict?.message ?? ""}`);
    yield assistant(verdict?.block ? "blocked" : "allowed");
  },
  async *cancel(ctx) {
    yield assistant("started");
    await new Promise((resolve) => {
      if (ctx.signal.aborted) resolve();
      ctx.signal.addEventListener("abort", () => resolve(), { once: true });
    });
    log("session/cancel observed");
    ctx.state.status = "cancelled";
  },
  async *"exit-prompt"() {
    yield assistant("partial");
    process.stderr.write("fixture: crashing mid-prompt\n");
    process.exit(7);
  },
};

function makeAgent() {
  const hooks = [];
  const manager = {
    register(plugin) {
      plugin.register({ on: (_hook, handler) => hooks.push(handler) });
    },
  };
  return {
    agentId: "fixture",
    pluginManager: () => manager,
    async send(_text, { signal }) {
      const state = { status: "finished" };
      const stream = () => modes[mode]({ hooks, signal, state });
      return { stream, wait: async () => ({ status: state.status }), status: "finished" };
    },
  };
}

await serveAcp({
  agent: () => makeAgent(),
  permissionDefault: mode === "perm" ? "ask" : "auto",
  log: () => undefined,
});
