import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, join } from "node:path";
import { diag, metrics, trace } from "@opentelemetry/api";
import { InMemoryLogRecordExporter } from "@opentelemetry/sdk-logs";
import {
  AggregationTemporality,
  InMemoryMetricExporter,
  type PushMetricExporter,
} from "@opentelemetry/sdk-metrics";
import { InMemorySpanExporter } from "@opentelemetry/sdk-trace-base";
import { afterEach, describe, expect, it } from "vitest";
import { Agent } from "../../src/agent.js";
import { ConfigurationError } from "../../src/errors.js";
import { _resetTelemetryCacheForTests } from "../../src/internal/telemetry/tracer.js";
import {
  type RegisteredTelemetry,
  type RegisterTelemetryOptions,
  registerTelemetry,
} from "../../src/telemetry-node.js";
import { startFakeModelServer } from "../../src/testing/index.js";
import { useTempCwd } from "../helpers/temp-workspace.js";

useTempCwd();

let active: RegisteredTelemetry | undefined;

async function register(extra: Partial<RegisterTelemetryOptions> = {}) {
  const spanExporter = new InMemorySpanExporter();
  const metricExporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
  active = await registerTelemetry({
    endpoint: "http://localhost:4318/",
    serviceName: "svc-under-test",
    spanExporter,
    metricExporter,
    ...extra,
  });
  _resetTelemetryCacheForTests();
  return { spanExporter, metricExporter, handle: active };
}

afterEach(async () => {
  await active?.shutdown();
  active = undefined;
  trace.disable();
  metrics.disable();
  diag.disable();
  _resetTelemetryCacheForTests();
});

describe("registerTelemetry", () => {
  it("exports an agent.send span carrying the service.name resource", async () => {
    const { spanExporter, handle } = await register();
    const server = await startFakeModelServer({ reply: "pong" });
    try {
      const agent = await Agent.create({
        apiKey: "local",
        model: server.model,
        local: { cwd: process.cwd() },
        telemetry: { enabled: true, autoDetect: false },
      });
      await (await agent.send("hi")).wait();
      await agent.dispose();
      await handle.flush();
      const span = spanExporter.getFinishedSpans().find((s) => s.name === "agent.send");
      expect(span).toBeDefined();
      expect(span?.resource.attributes["service.name"]).toBe("svc-under-test");
    } finally {
      await server.close();
    }
  });

  it("serves /metrics on loopback and 404 elsewhere", async () => {
    const { handle } = await register({ prometheusPort: 0 });
    const url = await handle.prometheusEndpoint;
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/metrics$/);
    expect((await fetch(url as string)).status).toBe(200);
    expect((await fetch(new URL("/other", url as string))).status).toBe(404);
  });

  it("leaves prometheusEndpoint undefined without prometheusPort", async () => {
    const { handle } = await register();
    await expect(handle.prometheusEndpoint).resolves.toBeUndefined();
  });

  it("rejects a non-http endpoint naming `endpoint`", async () => {
    const err = await registerTelemetry({ endpoint: "ftp://x", serviceName: "s" }).catch((e) => e);
    expect(err).toBeInstanceOf(ConfigurationError);
    expect(err.message).toContain("endpoint");
  });

  it.each([
    ["no trailing slash", "", ""],
    ["one trailing slash", "", "/"],
    ["several trailing slashes", "", "///"],
    ["inner slash runs kept, trailing run stripped", "/a//b", "////"],
    ["a long inner slash run, then a non-slash tail", `/a${"/".repeat(2_000)}b`, "/"],
  ])("builds OTLP URLs from the normalized endpoint: %s", async (_name, path, trailing) => {
    const paths: string[] = [];
    const server = createServer((req, res) => {
      paths.push(req.url ?? "");
      req.resume();
      res.writeHead(200).end();
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    try {
      const { port } = server.address() as AddressInfo;
      active = await registerTelemetry({
        endpoint: `http://127.0.0.1:${port}${path}${trailing}`,
        serviceName: "svc",
        exportTimeoutMs: 2000,
      });
      trace.getTracer("t").startSpan("s").end();
      metrics.getMeter("m").createCounter("c").add(1);
      await active.flush();
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
    expect(paths.sort()).toEqual([`${path}/v1/metrics`, `${path}/v1/traces`]);
  });

  it("masks URL userinfo in export errors before onExportError", async () => {
    const lines: string[] = [];
    await register({ onExportError: (l) => lines.push(l) });
    diag.error("export failed for https://user:pw@host/v1/traces");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("https://***@host");
    expect(lines[0]).not.toContain("pw");
  });

  it("shutdown resolves when an exporter shutdown rejects", async () => {
    const failing: PushMetricExporter = {
      export: (_m, cb) => cb({ code: 0 }),
      forceFlush: () => Promise.resolve(),
      shutdown: () => Promise.reject(new Error("boom")),
      selectAggregationTemporality: () => AggregationTemporality.CUMULATIVE,
    };
    const { handle } = await register({ metricExporter: failing });
    await expect(handle.shutdown()).resolves.toBeUndefined();
  });

  it("rejects when a provider is already registered, and leaves no handle", async () => {
    await register();
    const err = await registerTelemetry({
      endpoint: "http://localhost:4318",
      serviceName: "second",
      spanExporter: new InMemorySpanExporter(),
      metricExporter: new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE),
    }).catch((e) => e);
    expect(err).toBeInstanceOf(ConfigurationError);
    expect(err.code).toBe("telemetry_provider_registered");
  });
});

const STATIC_RELATIVE_IMPORT =
  /(?:^|\n)\s*(?:import|export)\b(?:[^"'`;]*?from)?\s*["'](\.[^"']+)["']/g;

describe("main entry isolation", () => {
  const dist = new URL("../../dist/", import.meta.url);

  /** Every module reachable from dist/index.js through static relative imports. */
  function staticGraph(entry: string): string[] {
    const seen = new Set<string>();
    const queue = [entry];
    while (queue.length > 0) {
      const file = queue.pop() as string;
      if (seen.has(file)) continue;
      seen.add(file);
      const src = readFileSync(new URL(file, dist), "utf8");
      for (const m of src.matchAll(STATIC_RELATIVE_IMPORT)) {
        queue.push(join(dirname(file), m[1] as string));
      }
    }
    return [...seen];
  }

  it.skipIf(!existsSync(new URL("index.js", dist)))(
    "importing @theokit/sdk loads no @opentelemetry/sdk-* module",
    () => {
      const files = staticGraph("index.js");
      expect(files.length).toBeGreaterThan(1);
      for (const file of files) {
        expect(readFileSync(new URL(file, dist), "utf8")).not.toMatch(
          /from\s*["']@opentelemetry\/(sdk-|resources|exporter-)|import\s*["']@opentelemetry\/(sdk-|resources|exporter-)/,
        );
      }
    },
  );
});

describe("registerTelemetry logs", () => {
  it("emits a log record through the configured log exporter with the resource", async () => {
    const logExporter = new InMemoryLogRecordExporter();
    const { handle } = await register({ logExporter });
    handle.log({ body: "hello", severityText: "INFO", attributes: { k: "v" } });
    await handle.flush();
    const records = logExporter.getFinishedLogRecords();
    expect(records).toHaveLength(1);
    expect(records[0]?.body).toBe("hello");
    expect(records[0]?.attributes.k).toBe("v");
    expect(records[0]?.resource.attributes["service.name"]).toBe("svc-under-test");
  });

  it("keeps working without a log exporter: log is a no-op", async () => {
    const { handle } = await register();
    expect(() => handle.log({ body: "dropped" })).not.toThrow();
    await expect(handle.flush()).resolves.toBeUndefined();
  });
});
