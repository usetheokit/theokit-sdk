/**
 * `@theokit/sdk/telemetry-node` — registers OpenTelemetry providers so that
 * `AgentOptions.telemetry` has somewhere to send its spans and metrics.
 *
 * The OpenTelemetry SDK and exporter packages are optional peers, imported inside
 * `registerTelemetry` so that importing the main entry never loads them.
 */

import { ConfigurationError } from "./errors.js";
import { diag as sdkDiag } from "./internal/diagnostics.js";
import { Security } from "./security.js";

type SpanExporter = import("@opentelemetry/sdk-trace-base").SpanExporter;
type PushMetricExporter = import("@opentelemetry/sdk-metrics").PushMetricExporter;
type MetricReader = import("@opentelemetry/sdk-metrics").MetricReader;
type OtelResource = import("@opentelemetry/resources").Resource;

/** Options for {@link registerTelemetry}. */
export interface RegisterTelemetryOptions {
  /** `http(s)` OTLP/HTTP base URL; `/v1/traces` and `/v1/metrics` are appended. */
  endpoint: string;
  /** Value of the `service.name` resource attribute. */
  serviceName: string;
  /** Serve Prometheus metrics on `127.0.0.1:<port>/metrics` (loopback only). `0` picks a free port. */
  prometheusPort?: number;
  /** Per-export timeout. Default 5000. */
  exportTimeoutMs?: number;
  /** Metric export interval. Default 60000. */
  metricIntervalMs?: number;
  /** Receives redacted export-failure lines. Default: the SDK diagnostics channel. */
  onExportError?: (line: string) => void;
  /** Test seam: replaces the OTLP trace exporter. */
  spanExporter?: SpanExporter;
  /** Test seam: replaces the OTLP metric exporter. */
  metricExporter?: PushMetricExporter;
}

/** Handle returned by {@link registerTelemetry}. */
export interface RegisteredTelemetry {
  /** Resolves to `http://127.0.0.1:<port>/metrics`, or `undefined` without `prometheusPort`. */
  readonly prometheusEndpoint: Promise<string | undefined>;
  flush(): Promise<void>;
  /** Flushes, shuts the providers down and disables the globals. Never rejects. */
  shutdown(): Promise<void>;
}

const DEFAULT_EXPORT_TIMEOUT_MS = 5000;
const DEFAULT_METRIC_INTERVAL_MS = 60_000;
const LOOPBACK = "127.0.0.1";

function normalizeEndpoint(endpoint: unknown): string {
  const fail = (): never => {
    throw new ConfigurationError("registerTelemetry: `endpoint` must be an http(s) URL", {
      code: "invalid_telemetry_endpoint",
    });
  };
  if (typeof endpoint !== "string") return fail();
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return fail();
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return fail();
  return endpoint.replace(/\/+$/, "");
}

/** Redacts secrets and masks URL userinfo (`https://user:pw@host` → `https://***@host`). */
function sanitizeLine(text: string): string {
  const masked = text.replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/?#@]+@/gi, "$1***@");
  return Security.redact(masked).replace(/\r?\n/g, " ");
}

async function loadPeer<T>(name: string): Promise<T> {
  try {
    return (await import(name)) as T;
  } catch (cause) {
    const err = cause as { code?: string; message?: string };
    if (err?.code === "ERR_MODULE_NOT_FOUND" || err?.code === "MODULE_NOT_FOUND") {
      if (typeof err.message === "string" && err.message.includes(name)) {
        throw new ConfigurationError(
          `registerTelemetry: optional peer dependency "${name}" is not installed. Install it to use @theokit/sdk/telemetry-node.`,
          { code: "telemetry_peer_missing", cause },
        );
      }
    }
    throw cause;
  }
}

interface Peers {
  trace: typeof import("@opentelemetry/sdk-trace-base");
  metrics: typeof import("@opentelemetry/sdk-metrics");
  resources: typeof import("@opentelemetry/resources");
  traceOtlp?: typeof import("@opentelemetry/exporter-trace-otlp-http");
  metricsOtlp?: typeof import("@opentelemetry/exporter-metrics-otlp-http");
  prometheus?: typeof import("@opentelemetry/exporter-prometheus");
}

async function loadPeers(options: RegisterTelemetryOptions): Promise<Peers> {
  const peers: Peers = {
    trace: await loadPeer("@opentelemetry/sdk-trace-base"),
    metrics: await loadPeer("@opentelemetry/sdk-metrics"),
    resources: await loadPeer("@opentelemetry/resources"),
  };
  if (options.spanExporter === undefined) {
    peers.traceOtlp = await loadPeer("@opentelemetry/exporter-trace-otlp-http");
  }
  if (options.metricExporter === undefined) {
    peers.metricsOtlp = await loadPeer("@opentelemetry/exporter-metrics-otlp-http");
  }
  if (options.prometheusPort !== undefined) {
    peers.prometheus = await loadPeer("@opentelemetry/exporter-prometheus");
  }
  return peers;
}

async function installDiagLogger(sink: (line: string) => void): Promise<boolean> {
  const { diag, DiagLogLevel } = await import("@opentelemetry/api");
  const write = (...args: unknown[]): void => {
    try {
      sink(sanitizeLine(args.map((a) => (a instanceof Error ? a.message : String(a))).join(" ")));
    } catch {
      // a faulty sink must not break the exporter
    }
  };
  const noop = (): void => {};
  const logger = { error: write, warn: noop, info: noop, debug: noop, verbose: noop };
  return diag.setLogger(logger, { logLevel: DiagLogLevel.ERROR, suppressOverrideMessage: true });
}

async function startPrometheus(
  peers: Peers,
  port: number,
): Promise<{ reader: MetricReader; close: () => Promise<void>; url: string }> {
  const { createServer } = await import("node:http");
  const exporter = new peers.prometheus!.PrometheusExporter({ preventServerStart: true });
  const server = createServer((req, res) => {
    const path = (req.url ?? "").split("?")[0];
    if (req.method === "GET" && path === "/metrics") {
      exporter.getMetricsRequestHandler(req, res);
      return;
    }
    res.statusCode = 404;
    res.end();
  });
  const close = (): Promise<void> =>
    new Promise((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections?.();
    });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, LOOPBACK, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  const boundPort = typeof address === "object" && address !== null ? address.port : port;
  return { reader: exporter, close, url: `http://${LOOPBACK}:${boundPort}/metrics` };
}

function buildSpanExporter(peers: Peers, options: RegisterTelemetryOptions, base: string) {
  const timeout = options.exportTimeoutMs ?? DEFAULT_EXPORT_TIMEOUT_MS;
  return (
    options.spanExporter ??
    new peers.traceOtlp!.OTLPTraceExporter({ url: `${base}/v1/traces`, timeoutMillis: timeout })
  );
}

function buildMetricExporter(peers: Peers, options: RegisterTelemetryOptions, base: string) {
  const timeout = options.exportTimeoutMs ?? DEFAULT_EXPORT_TIMEOUT_MS;
  return (
    options.metricExporter ??
    new peers.metricsOtlp!.OTLPMetricExporter({ url: `${base}/v1/metrics`, timeoutMillis: timeout })
  );
}

interface ExportResultLike {
  code: number;
  error?: Error;
}

/** Reports failed export results to `report`; the exporter's own callback still runs. */
function reportFailures<
  E extends { export: (data: never, cb: (r: ExportResultLike) => void) => void },
>(exporter: E, report: (error: unknown) => void): E {
  const original = exporter.export.bind(exporter);
  exporter.export = (data, cb) =>
    original(data, (result) => {
      if (result.code !== 0) report(result.error ?? new Error("export failed"));
      cb(result);
    });
  return exporter;
}

async function safely(fn: () => unknown): Promise<void> {
  try {
    await fn();
  } catch {
    // shutdown and flush of one part must not stop the rest
  }
}

/**
 * Registers global OpenTelemetry tracer and meter providers that export over OTLP/HTTP, so spans
 * recorded by agents created with `telemetry: { enabled: true }` actually leave the process.
 *
 * @throws ConfigurationError `invalid_telemetry_endpoint` for a non-http(s) endpoint, and
 *   `telemetry_peer_missing` when an optional OpenTelemetry package is not installed.
 */
export async function registerTelemetry(
  options: RegisterTelemetryOptions,
): Promise<RegisteredTelemetry> {
  const base = normalizeEndpoint(options.endpoint);
  const peers = await loadPeers(options);
  const api = await import("@opentelemetry/api");
  const resource: OtelResource = peers.resources.resourceFromAttributes({
    "service.name": options.serviceName,
  });
  const timeout = options.exportTimeoutMs ?? DEFAULT_EXPORT_TIMEOUT_MS;
  const rawSink = options.onExportError ?? ((line: string) => sdkDiag(`${line}\n`));
  const sink = (line: string): void => {
    try {
      rawSink(sanitizeLine(line));
    } catch {
      // a faulty sink must not break the exporter
    }
  };
  const report = (error: unknown): void =>
    sink(error instanceof Error ? error.message : String(error));

  const tracerProvider = new peers.trace.BasicTracerProvider({
    resource,
    spanProcessors: [
      new peers.trace.BatchSpanProcessor(
        reportFailures(buildSpanExporter(peers, options, base), report),
        {
          exportTimeoutMillis: timeout,
        },
      ),
    ],
  });
  const prom =
    options.prometheusPort === undefined
      ? undefined
      : await startPrometheus(peers, options.prometheusPort);
  const closeProm = prom?.close;
  const readers: MetricReader[] = [
    new peers.metrics.PeriodicExportingMetricReader({
      exporter: reportFailures(buildMetricExporter(peers, options, base), report),
      exportIntervalMillis: options.metricIntervalMs ?? DEFAULT_METRIC_INTERVAL_MS,
      exportTimeoutMillis: timeout,
    }),
    ...(prom === undefined ? [] : [prom.reader]),
  ];
  const meterProvider = new peers.metrics.MeterProvider({ resource, readers });
  const diagInstalled = await installDiagLogger(sink);
  let shutdownPromise: Promise<void> | undefined;

  const flush = async (): Promise<void> => {
    try {
      await tracerProvider.forceFlush();
      await meterProvider.forceFlush();
    } catch (error) {
      // Export failures are reported through the sink, already redacted; flush does not throw them.
      report(error);
    }
  };
  const shutdown = (): Promise<void> => {
    shutdownPromise ??= (async () => {
      await safely(() => tracerProvider.forceFlush());
      await safely(() => tracerProvider.shutdown());
      await safely(() => meterProvider.shutdown());
      await safely(() => closeProm?.());
      api.trace.disable();
      api.metrics.disable();
      if (diagInstalled) api.diag.disable();
    })();
    return shutdownPromise;
  };

  api.trace.setGlobalTracerProvider(tracerProvider);
  api.metrics.setGlobalMeterProvider(meterProvider);
  return { prometheusEndpoint: Promise.resolve(prom?.url), flush, shutdown };
}
