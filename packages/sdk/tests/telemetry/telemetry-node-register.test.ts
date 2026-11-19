/**
 * #1044 — `registerTelemetry` from `@theokit/sdk/telemetry-node`.
 */

import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { AggregationTemporality, InMemoryMetricExporter } from "@opentelemetry/sdk-metrics";
import { InMemorySpanExporter } from "@opentelemetry/sdk-trace-base";
import { afterEach, describe, expect, it } from "vitest";

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

describe("registerTelemetry (#1044)", () => {
  it("exports an agent.send span carrying the service.name resource", async () => {
    const spanExporter = new InMemorySpanExporter();
    const metricExporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
    active = await registerTelemetry({ ...base, spanExporter, metricExporter });
    _resetTelemetryCacheForTests();
    const agent = await Agent.create({
      apiKey: "theo_test_fixture",
      model: { id: "openai/gpt-4o-mini" },
      telemetry: { enabled: true },
    });
    const run = await agent.send("hello");
    await run.wait();
    await agent.dispose();
    const deadline = Date.now() + 5000;
    let span: ReturnType<InMemorySpanExporter["getFinishedSpans"]>[number] | undefined;
    while (span === undefined && Date.now() < deadline) {
      await active.flush();
      span = spanExporter.getFinishedSpans().find((s) => s.name === "agent.send");
      if (span === undefined) await new Promise((r) => setTimeout(r, 20));
    }
    expect(span?.resource.attributes["service.name"]).toBe("svc-test");
  });

  it("serves Prometheus on loopback /metrics only", async () => {
    active = await registerTelemetry({
      ...base,
      prometheusPort: 0,
      spanExporter: new InMemorySpanExporter(),
      metricExporter: new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE),
    });
    const url = await active.prometheusEndpoint;
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/metrics$/);
    expect((await fetch(url as string)).status).toBe(200);
    expect((await fetch((url as string).replace("/metrics", "/other"))).status).toBe(404);
  });

  it("has no prometheus endpoint without prometheusPort", async () => {
    active = await registerTelemetry({
      ...base,
      spanExporter: new InMemorySpanExporter(),
      metricExporter: new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE),
    });
    expect(await active.prometheusEndpoint).toBeUndefined();
  });

  it("rejects a non-http endpoint with ConfigurationError naming endpoint", async () => {
    const err = await registerTelemetry({ ...base, endpoint: "ftp://x" }).catch((e) => e);
    expect(err).toBeInstanceOf(ConfigurationError);
    expect(err.message).toContain("endpoint");
  });

  it("masks URL userinfo in export errors reaching onExportError", async () => {
    const lines: string[] = [];
    const spanExporter = new InMemorySpanExporter();
    spanExporter.export = (_spans, cb) =>
      cb({ code: 1, error: new Error("failed https://user:pw@host/v1/traces") });
    active = await registerTelemetry({
      ...base,
      spanExporter,
      metricExporter: new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE),
      onExportError: (l) => lines.push(l),
    });
    const { trace } = await import("@opentelemetry/api");
    trace.getTracer("t").startSpan("x").end();
    await active.flush();
    await new Promise((r) => setTimeout(r, 50));
    const joined = lines.join("\n");
    expect(joined).toContain("https://***@host");
    expect(joined).not.toContain("user:pw");
  });

  it("shutdown resolves even when an exporter shutdown rejects", async () => {
    const spanExporter = new InMemorySpanExporter();
    spanExporter.shutdown = () => Promise.reject(new Error("boom"));
    const t = await registerTelemetry({
      ...base,
      spanExporter,
      metricExporter: new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE),
    });
    await expect(t.shutdown()).resolves.toBeUndefined();
  });

  it("importing the main entry loads no @opentelemetry/sdk-* module", () => {
    const entry = fileURLToPath(new URL("../../src/index.ts", import.meta.url));
    const script = `import { registerHooks } from "node:module";
      const seen = [];
      registerHooks({ resolve(spec, ctx, next) { seen.push(spec); return next(spec, ctx); } });
      await import(${JSON.stringify(entry)});
      console.log(JSON.stringify(seen.filter((s) => /@opentelemetry[\\/]sdk-/.test(s))));`;
    const out = execFileSync(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "-e", script],
      { encoding: "utf8", cwd: fileURLToPath(new URL("../..", import.meta.url)) },
    );
    expect(JSON.parse(out.trim().split("\n").pop() as string)).toEqual([]);
  });
});
