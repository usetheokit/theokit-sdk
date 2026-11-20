/** #1044 — `registerTelemetry` from `@theokit/sdk/telemetry-node`. */
import { execFileSync } from "node:child_process";
import { AggregationTemporality, InMemoryMetricExporter } from "@opentelemetry/sdk-metrics";
import { InMemorySpanExporter, type ReadableSpan } from "@opentelemetry/sdk-trace-base";
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
    const { diag } = await import("@opentelemetry/api");
    diag.error("export failed", new Error("boom https://user:pw@host"));
    expect(lines.join("\n")).toContain("https://***@host");
    expect(lines.join("\n")).not.toContain("user:pw");
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

  it("no module of the main entry's source graph names an @opentelemetry/sdk-* package", () => {
    const hits = execFileSync(
      "grep",
      [
        "-rlE",
        'from "@opentelemetry/(sdk|resources|exporter)|import\\("@opentelemetry/(sdk|resources|exporter)',
        "src",
      ],
      { cwd: new URL("../..", import.meta.url).pathname, encoding: "utf8" },
    )
      .split("\n")
      .filter((f) => f !== "" && f !== "src/telemetry-node.ts");
    expect(hits).toEqual([]);
  });
});
