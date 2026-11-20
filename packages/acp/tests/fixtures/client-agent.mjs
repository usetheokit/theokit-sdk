// Fixture ACP agent for client tests. Needs `pnpm --filter @theokit/acp build` first.
// Behaviour is chosen by the prompt text; events are appended to $FIXTURE_LOG.
import { appendFileSync } from "node:fs";
import { serveAcp } from "../../dist/index.js";

const log = (line) =>
  process.env.FIXTURE_LOG && appendFileSync(process.env.FIXTURE_LOG, `${line}\n`);

if (process.env.FIXTURE_EXIT_ON_INIT) {
  process.stderr.write("fixture failed to boot\n");
  process.exit(Number(process.env.FIXTURE_EXIT_ON_INIT));
}
log(`pid ${process.pid}`);
log(`env ${JSON.stringify(Object.keys(process.env).sort())}`);

const text = (t) => ({ type: "assistant", message: { content: [{ type: "text", text: t }] } });
const hooks = [];
const pluginManager = {
  register(plugin) {
    plugin.register({ on: (_event, handler) => hooks.push(handler) });
  },
};

function makeRun(prompt, signal) {
  async function* stream() {
    if (prompt === "ask") {
      const veto = await hooks[0]?.({ name: "write_file", args: {} });
      log(`veto ${JSON.stringify(veto ?? null)}`);
      yield text("asked");
    } else if (prompt === "hang") {
      yield text("started");
      await new Promise((resolve) => {
        if (signal.aborted) resolve();
        signal.addEventListener("abort", () => {
          log("cancel");
          resolve();
        });
      });
    } else if (prompt === "die") {
      yield text("before");
      await new Promise((r) => setTimeout(r, 50));
      process.stderr.write("fixture dying\n");
      process.exit(9);
    } else {
      yield text("hello");
      yield text(" world");
    }
  }
  return {
    status: "finished",
    stream,
    wait: async () => ({ status: signal.aborted ? "cancelled" : "finished" }),
  };
}

await serveAcp({
  permissionDefault: process.env.FIXTURE_PERMISSION ?? "auto",
  log: (m) => log(`log ${m}`),
  agent: (agentId) => ({
    agentId,
    pluginManager: () => pluginManager,
    send: async (prompt, { signal }) => makeRun(prompt, signal),
    dispose: async () => {},
  }),
});
