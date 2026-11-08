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

describe("wrapSpan error redaction", () => {
  it("masks secrets in status.message and exception message/stack", () => {
    const t = createTelemetry({ enabled: true } as never);
    const span = t.startSpan("x");
    const err = new Error(`auth failed key=${SECRET}`);
    span.recordException(err);
    span.setStatus({ code: 2, message: `auth failed key=${SECRET}` });
    span.end();
    const [s] = exporter.getFinishedSpans();
    expect(s?.status.message).not.toContain(SECRET);
    const ev = s?.events.find((e) => e.name === "exception");
    expect(ev?.attributes?.["exception.message"]).toBeDefined();
    expect(JSON.stringify(ev?.attributes)).not.toContain(SECRET);
    expect(err.message).toContain(SECRET); // caller's error untouched
  });
});
