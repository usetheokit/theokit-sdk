/** #1044 — `registerTelemetry` from `@theokit/sdk/telemetry-node`. */
import { execFileSync } from "node:child_process";
import { DiagLogLevel, diag, trace } from "@opentelemetry/api";
import { AggregationTemporality, InMemoryMetricExporter } from "@opentelemetry/sdk-metrics";
import { InMemorySpanExporter, type ReadableSpan } from "@opentelemetry/sdk-trace-base";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Agent } from "../../src/agent.js";
import { ConfigurationError } from "../../src/errors.js";
import { _resetTelemetryCacheForTests } from "../../src/internal/telemetry/tracer.js";
import { type RegisteredTelemetry, registerTelemetry } from "../../src/telemetry-node.js";
import { useTempCwd } from "../helpers/temp-workspace.js";

useTempCwd();

let active: RegisteredTelemetry | undefined;

afterEach(async () => {
  await active?.shutdown();
  active = undefined;
  _resetTelemetryCacheForTests();
});

const base = { endpoint: "http://localhost:4318/", serviceName: "svc-test" };

function memory() {
  return {
    spanExporter: new InMemorySpanExporter(),
    metricExporter: new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE),
  };
}

describe("registerTelemetry", () => {
  it("exports an agent.send span carrying service.name", async () => {
    const seams = memory();
    active = await registerTelemetry({ ...base, ...seams });
    const agent = await Agent.create({
      apiKey: "theo_test_fixture",
      model: { id: "openai/gpt-4o-mini" },
      telemetry: { enabled: true },
    });
    const run = await agent.send("hello");
    await run.wait();
    let span: ReadableSpan | undefined;
    for (let i = 0; i < 100 && span === undefined; i++) {
      await active.flush();
      span = seams.spanExporter.getFinishedSpans().find((s) => s.name === "agent.send");
      if (span === undefined) await new Promise((r) => setTimeout(r, 10));
    }
    expect(span?.resource.attributes["service.name"]).toBe("svc-test");
    await agent.dispose();
  });

  it("serves Prometheus on loopback /metrics only", async () => {
    active = await registerTelemetry({ ...base, ...memory(), prometheusPort: 0 });
    const url = await active.prometheusEndpoint;
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/metrics$/);
    expect((await fetch(url as string)).status).toBe(200);
    expect((await fetch((url as string).replace("/metrics", "/other"))).status).toBe(404);
  });

  it("rejects a non-http endpoint naming endpoint", async () => {
    const err = await registerTelemetry({ ...base, endpoint: "ftp://x" }).catch((e) => e);
    expect(err).toBeInstanceOf(ConfigurationError);
    expect(err.message).toContain("endpoint");
  });

  it("redacts URL userinfo in export errors", async () => {
    const lines: string[] = [];
    const seams = memory();
    seams.spanExporter.export = (_spans, done) =>
      done({ code: 1, error: new Error("failed https://user:pw@host/v1") });
    active = await registerTelemetry({ ...base, ...seams, onExportError: (l) => lines.push(l) });
    trace.getTracer("t").startSpan("x").end();
    await active.flush();
    expect(lines.join("\n")).toContain("https://***@host");
    expect(lines.join("\n")).not.toContain("user:pw");
  });

  it("leaves a host-installed diag logger alone across register and shutdown", async () => {
    const seen: string[] = [];
    const logger = {
      error: (m: string) => seen.push(m),
      warn() {},
      info() {},
      debug() {},
      verbose() {},
    };
    diag.setLogger(logger, DiagLogLevel.ERROR);
    try {
      active = await registerTelemetry({ ...base, ...memory() });
      await active.shutdown();
      diag.error("still mine");
      expect(seen).toEqual(["still mine"]);
    } finally {
      diag.disable();
    }
  });

  it("shutdown resolves when an exporter shutdown rejects", async () => {
    const seams = memory();
    seams.spanExporter.shutdown = () => Promise.reject(new Error("nope"));
    active = await registerTelemetry({ ...base, ...seams, onExportError: () => {} });
    await expect(active.shutdown()).resolves.toBeUndefined();
    await expect(active.shutdown()).resolves.toBeUndefined();
  });

  it("rejects a second registration while one is active", async () => {
    active = await registerTelemetry({ ...base, ...memory() });
    const err = await registerTelemetry({ ...base, ...memory() }).catch((e) => e);
    expect(err).toBeInstanceOf(ConfigurationError);
    expect(err.code).toBe("telemetry_already_registered");
  });

  it("a missing peer rejects with telemetry_peer_missing naming the package", async () => {
    vi.resetModules();
    vi.doMock("@opentelemetry/sdk-metrics", () => {
      throw new Error("Cannot find package");
    });
    try {
      const mod = await import("../../src/telemetry-node.js");
      const err = await mod.registerTelemetry({ ...base, ...memory() }).catch((e) => e);
      expect(err).toBeInstanceOf(Error);
      expect(err.code).toBe("telemetry_peer_missing");
      expect(err.message).toContain("@opentelemetry/sdk-metrics");
    } finally {
      vi.doUnmock("@opentelemetry/sdk-metrics");
      vi.resetModules();
    }
  });

  it("a missing OTLP exporter peer names it when no exporter is injected", async () => {
    vi.resetModules();
    vi.doMock("@opentelemetry/exporter-trace-otlp-http", () => {
      throw new Error("Cannot find package");
    });
    try {
      const mod = await import("../../src/telemetry-node.js");
      const err = await mod.registerTelemetry(base).catch((e) => e);
      expect(err.code).toBe("telemetry_peer_missing");
      expect(err.message).toContain("@opentelemetry/exporter-trace-otlp-http");
    } finally {
      vi.doUnmock("@opentelemetry/exporter-trace-otlp-http");
      vi.resetModules();
    }
  });
});

describe("main entry isolation (runtime, built dist)", () => {
  const dist = new URL("../../dist/", import.meta.url);
  const probe = (body: string): string[] => {
    const script = `
      import { registerHooks } from "node:module";
      const seen = new Set();
      registerHooks({ resolve(spec, ctx, next) {
        const r = next(spec, ctx);
        if (/@opentelemetry[\\/](sdk-|resources|exporter-)/.test(spec + r.url)) seen.add(spec);
        return r;
      } });
      ${body}
      process.stdout.write(JSON.stringify([...seen]));`;
    const out = execFileSync(process.execPath, ["--input-type=module", "-e", script], {
      cwd: new URL("../..", import.meta.url).pathname,
      encoding: "utf8",
    });
    return JSON.parse(out);
  };

  it("importing the main entry loads no @opentelemetry/sdk-* module", () => {
    expect(probe(`await import(${JSON.stringify(new URL("index.js", dist).href)});`)).toEqual([]);
  });

  it("control: registerTelemetry does load them, so the probe can see a load", () => {
    const loaded = probe(`
      const m = await import(${JSON.stringify(new URL("telemetry-node.js", dist).href)});
      const t = await m.registerTelemetry({ endpoint: "http://localhost:4318", serviceName: "x" });
      await t.shutdown();`);
    expect(loaded.some((n) => n.includes("sdk-trace-base"))).toBe(true);
  });
});
