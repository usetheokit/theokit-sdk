/**
 * `@theokit/sdk/telemetry-node` — registers OpenTelemetry OTLP providers (#1044).
 *
 * `AgentOptions.telemetry` records spans through the global OpenTelemetry API, but nothing registers
 * a tracer or meter provider, so turning telemetry on records nothing until the host wires the
 * OpenTelemetry SDK. `registerTelemetry` does that wiring: a global tracer provider (batch span
 * processor over OTLP/HTTP), a global meter provider (periodic reader over OTLP/HTTP), an optional
 * loopback-only Prometheus scrape endpoint, and an error logger that redacts secrets.
 *
 * Every OpenTelemetry SDK package is an optional peer imported inside `registerTelemetry`, so
 * importing the main entry never loads them.
 */

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { MetricReader, PushMetricExporter } from "@opentelemetry/sdk-metrics";
import type { SpanExporter } from "@opentelemetry/sdk-trace-base";
import { ConfigurationError } from "./errors.js";
import { diag as sdkDiag } from "./internal/diagnostics.js";
import { Security } from "./security.js";

export type { PushMetricExporter, SpanExporter };

/** Options for {@link registerTelemetry}. */
export interface RegisterTelemetryOptions {
  /** `http(s)` OTLP/HTTP base URL; `/v1/traces` and `/v1/metrics` are appended. */
  endpoint: string;
  /** Value of the `service.name` resource attribute. */
  serviceName: string;
  /** Serve Prometheus metrics on `127.0.0.1:<port>/metrics` (loopback only). `0` picks a free port. */
  prometheusPort?: number;
  /** Export timeout in ms. Default `5000`. */
  exportTimeoutMs?: number;
  /** Metric export interval in ms. Default `60000`. */
  metricIntervalMs?: number;
  /** Receives redacted export-failure lines. Default: the SDK diagnostics channel. */
  onExportError?: (line: string) => void;
  /** Test seam: replaces the OTLP span exporter. */
  spanExporter?: SpanExporter;
  /** Test seam: replaces the OTLP metric exporter. */
  metricExporter?: PushMetricExporter;
}

/** Handle returned by {@link registerTelemetry}. */
export interface RegisteredTelemetry {
  /** `http://127.0.0.1:<port>/metrics` once listening, or `undefined` without `prometheusPort`. */
  readonly prometheusEndpoint: Promise<string | undefined>;
  /** Exports everything buffered so far. */
  flush(): Promise<void>;
  /** Flushes, stops the providers and disables the globals. Never rejects. */
  shutdown(): Promise<void>;
}

const DEFAULT_EXPORT_TIMEOUT_MS = 5000;
const DEFAULT_METRIC_INTERVAL_MS = 60000;
const PROMETHEUS_PATH = "/metrics";

interface Closeable {
  shutdown(): Promise<void>;
  forceFlush(): Promise<void>;
}

function normalizeEndpoint(endpoint: string): string {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new ConfigurationError(`registerTelemetry: endpoint must be an http(s) URL`, {
      code: "telemetry_invalid_endpoint",
    });
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ConfigurationError(
      `registerTelemetry: endpoint must use http or https, got "${url.protocol}"`,
      { code: "telemetry_invalid_endpoint" },
    );
  }
  return endpoint.replace(/\/+$/, "");
}

async function loadPeer<T>(name: string, load: () => Promise<T>): Promise<T> {
  try {
    return await load();
  } catch (cause) {
    throw new ConfigurationError(
      `registerTelemetry needs the optional peer dependency "${name}"; install it to use @theokit/sdk/telemetry-node`,
      { code: "telemetry_peer_missing", cause },
    );
  }
}

/** Masks URL userinfo, then applies the SDK's secret redaction. */
function redactLine(raw: string): string {
  return Security.redact(raw.replace(/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/@]*@/gi, "$1***@"));
}

function describeArg(arg: unknown): string {
  if (arg instanceof Error) return arg.message;
  return typeof arg === "string" ? arg : (JSON.stringify(arg) ?? String(arg));
}

function makeReporter(onExportError?: (line: string) => void): (...parts: unknown[]) => void {
  return (...parts) => {
    const line = redactLine(parts.map(describeArg).join(" "));
    try {
      if (onExportError) onExportError(line);
      else sdkDiag(`[theokit-sdk] telemetry export error: ${line}\n`);
    } catch {
      // A failing error sink must not break the export path.
    }
  };
}

async function settle(tasks: Array<Promise<unknown>>, report: (...p: unknown[]) => void) {
  for (const r of await Promise.allSettled(tasks)) {
    if (r.status === "rejected") report(r.reason);
  }
}

function startPrometheusServer(
  handler: (req: unknown, res: unknown) => void,
  port: number,
): { server: Server; endpoint: Promise<string> } {
  const server = createServer((req, res) => {
    const path = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
    if (req.method === "GET" && path === PROMETHEUS_PATH) {
      handler(req, res);
      return;
    }
    res.statusCode = 404;
    res.end("Not found");
  }).unref();
  const endpoint = new Promise<string>((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port }, () => {
      const { port: bound } = server.address() as AddressInfo;
      resolve(`http://127.0.0.1:${bound}${PROMETHEUS_PATH}`);
    });
  });
  return { server, endpoint };
}

function closeServer(server: Server | undefined): Promise<void> {
  if (!server?.listening) return Promise.resolve();
  return new Promise((resolve) => server.close(() => resolve()));
}

/**
 * Registers global OpenTelemetry tracer and meter providers that export over OTLP/HTTP.
 *
 * @throws ConfigurationError `telemetry_invalid_endpoint` for a non-http(s) `endpoint`,
 *   `telemetry_peer_missing` when an optional OpenTelemetry package is not installed,
 *   `telemetry_already_registered` when a global provider is already set.
 */
export async function registerTelemetry(
  options: RegisterTelemetryOptions,
): Promise<RegisteredTelemetry> {
  const base = normalizeEndpoint(options.endpoint);
  const timeout = options.exportTimeoutMs ?? DEFAULT_EXPORT_TIMEOUT_MS;
  const interval = options.metricIntervalMs ?? DEFAULT_METRIC_INTERVAL_MS;
  const report = makeReporter(options.onExportError);

  const api = await loadPeer("@opentelemetry/api", () => import("@opentelemetry/api"));
  const traceSdk = await loadPeer(
    "@opentelemetry/sdk-trace-base",
    () => import("@opentelemetry/sdk-trace-base"),
  );
  const metricsSdk = await loadPeer(
    "@opentelemetry/sdk-metrics",
    () => import("@opentelemetry/sdk-metrics"),
  );
  const { resourceFromAttributes } = await loadPeer(
    "@opentelemetry/resources",
    () => import("@opentelemetry/resources"),
  );

  const spanExporter =
    options.spanExporter ??
    new (
      await loadPeer(
        "@opentelemetry/exporter-trace-otlp-http",
        () => import("@opentelemetry/exporter-trace-otlp-http"),
      )
    ).OTLPTraceExporter({ url: `${base}/v1/traces`, timeoutMillis: timeout });
  const metricExporter =
    options.metricExporter ??
    new (
      await loadPeer(
        "@opentelemetry/exporter-metrics-otlp-http",
        () => import("@opentelemetry/exporter-metrics-otlp-http"),
      )
    ).OTLPMetricExporter({ url: `${base}/v1/metrics`, timeoutMillis: timeout });

  const readers: MetricReader[] = [
    new metricsSdk.PeriodicExportingMetricReader({
      exporter: metricExporter,
      exportIntervalMillis: interval,
      exportTimeoutMillis: timeout,
    }),
  ];

  let server: Server | undefined;
  let prometheusEndpoint: Promise<string | undefined> = Promise.resolve(undefined);
  if (options.prometheusPort !== undefined) {
    const { PrometheusExporter } = await loadPeer(
      "@opentelemetry/exporter-prometheus",
      () => import("@opentelemetry/exporter-prometheus"),
    );
    const prom = new PrometheusExporter({ preventServerStart: true });
    readers.push(prom as unknown as MetricReader);
    const started = startPrometheusServer(
      (req, res) => prom.getMetricsRequestHandler(req as never, res as never),
      options.prometheusPort,
    );
    server = started.server;
    prometheusEndpoint = started.endpoint;
    prometheusEndpoint.catch((err) => report(err));
  }

  const resource = resourceFromAttributes({ "service.name": options.serviceName });
  const tracerProvider = new traceSdk.BasicTracerProvider({
    resource,
    spanProcessors: [
      new traceSdk.BatchSpanProcessor(spanExporter, { exportTimeoutMillis: timeout }),
    ],
  });
  const meterProvider = new metricsSdk.MeterProvider({ resource, readers });

  const tracerOk = api.trace.setGlobalTracerProvider(tracerProvider);
  const meterOk = tracerOk && api.metrics.setGlobalMeterProvider(meterProvider);
  if (!meterOk) {
    if (tracerOk) api.trace.disable();
    await settle(
      [tracerProvider.shutdown(), meterProvider.shutdown(), closeServer(server)],
      report,
    );
    throw new ConfigurationError(
      "registerTelemetry: a global OpenTelemetry tracer or meter provider is already registered",
      { code: "telemetry_already_registered" },
    );
  }
  api.diag.setLogger(
    { error: report, warn: () => {}, info: () => {}, debug: () => {}, verbose: () => {} },
    api.DiagLogLevel.ERROR,
  );
  return buildHandle({ api, tracerProvider, meterProvider, server, prometheusEndpoint, report });
}

interface HandleParts {
  api: typeof import("@opentelemetry/api");
  tracerProvider: Closeable;
  meterProvider: Closeable;
  server: Server | undefined;
  prometheusEndpoint: Promise<string | undefined>;
  report: (...parts: unknown[]) => void;
}

function buildHandle(p: HandleParts): RegisteredTelemetry {
  let stopped: Promise<void> | undefined;
  return {
    prometheusEndpoint: p.prometheusEndpoint.catch(() => undefined),
    flush: () => settle([p.tracerProvider.forceFlush(), p.meterProvider.forceFlush()], p.report),
    shutdown: () => {
      stopped ??= (async () => {
        await settle(
          [p.tracerProvider.shutdown(), p.meterProvider.shutdown(), closeServer(p.server)],
          p.report,
        );
        p.api.trace.disable();
        p.api.metrics.disable();
        p.api.diag.disable();
      })().catch(() => undefined);
      return stopped;
    },
  };
}
