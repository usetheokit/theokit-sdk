import { trace } from "@opentelemetry/api";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { _resetTelemetryCacheForTests, createTelemetry } from "../../src/internal/telemetry/tracer.js";

const SECRET = "sk-abcdef0123456789ghijklmn";
let exporter: InMemorySpanExporter;
let provider: BasicTracerProvider;

beforeEach(() => {
  exporter = new InMemorySpanExporter();
  provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
  trace.setGlobalTracerProvider(provider);
  _resetTelemetryCacheForTests();
});

afterEach(async () => {
  await provider.shutdown();
  trace.disable();
  _resetTelemetryCacheForTests();
});

describe("wrapSpan redacts exception and status message", () => {
  it("recordException exports the masked message and stack", () => {
    const span = createTelemetry({ enabled: true }).startSpan("op");
    const err = new Error(`boom key=${SECRET}`);
    span.recordException(err);
    span.end();
    const [finished] = exporter.getFinishedSpans();
    const attrs = finished?.events.find((e) => e.name === "exception")?.attributes ?? {};
    expect(JSON.stringify(attrs)).not.toContain(SECRET);
    expect(String(attrs["exception.message"])).toContain("boom");
    expect(err.message).toContain(SECRET);
  });

  it("setStatus exports the masked message", () => {
    const span = createTelemetry({ enabled: true }).startSpan("op");
    span.setStatus({ code: 2, message: `failed key=${SECRET}` });
    span.end();
    const [finished] = exporter.getFinishedSpans();
    expect(finished?.status.message).toContain("failed");
    expect(finished?.status.message).not.toContain(SECRET);
  });
});
