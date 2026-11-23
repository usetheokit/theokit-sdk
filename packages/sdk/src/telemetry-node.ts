/**
 * `@theokit/sdk/telemetry-node` — registers OpenTelemetry OTLP providers for `AgentOptions.telemetry`.
 *
 * `AgentOptions.telemetry` records spans through the global OpenTelemetry API, and nothing there
 * registers a tracer or meter provider. `registerTelemetry` does: a global `TracerProvider` (batch
 * export over OTLP/HTTP) and a global `MeterProvider` (periodic OTLP/HTTP export, plus an optional
 * loopback Prometheus endpoint), both carrying a `service.name` resource. Exports run off the turn
 * path, and an export failure becomes one redacted line, never an exception.
 *
 * The OpenTelemetry packages are optional peers, imported inside `registerTelemetry`, so importing
 * the main entry never loads them.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { LogRecordExporter } from "@opentelemetry/sdk-logs";
import type { PushMetricExporter } from "@opentelemetry/sdk-metrics";
import type { SpanExporter } from "@opentelemetry/sdk-trace-base";
import { ConfigurationError } from "./errors.js";
import { diagFailure } from "./internal/diagnostics.js";
import { Security } from "./security.js";

/** Options for {@link registerTelemetry}. @public */
export interface RegisterTelemetryOptions {
  /** `http(s)` OTLP/HTTP base URL; traces go to `<endpoint>/v1/traces`, metrics to `<endpoint>/v1/metrics`. */
  endpoint: string;
  /** Value of the `service.name` resource attribute. */
  serviceName: string;
  /** Serve Prometheus metrics on `127.0.0.1:<port>/metrics` (loopback only). `0` picks a free port. */
  prometheusPort?: number;
  /** Export timeout in milliseconds. Default `5000`. */
  exportTimeoutMs?: number;
  /** Metric export interval in milliseconds. Default `60000`. */
  metricIntervalMs?: number;
  /** Receives one redacted line per export failure. Default: the SDK diagnostics channel. */
  onExportError?: (line: string) => void;
  /**
   * Log record exporter. When set, `registerTelemetry` also builds a `LoggerProvider` (same resource,
   * batch export) and the returned `log` emits through it. Without it, `log` is a no-op.
   */
  logExporter?: LogRecordExporter;
  /** Test seam: replaces the OTLP span exporter. */
  spanExporter?: SpanExporter;
  /** Test seam: replaces the OTLP metric exporter. */
  metricExporter?: PushMetricExporter;
}

/** A log record passed to {@link RegisteredTelemetry.log}. @public */
export interface TelemetryLogRecord {
  /** Log body. */
  body?: unknown;
  /** OpenTelemetry severity number (1-24). */
  severityNumber?: number;
  /** Severity label, e.g. `"INFO"`. */
  severityText?: string;
  /** Record attributes. */
  attributes?: Record<string, unknown>;
  /** Event time (epoch ms, `Date`, or hr-time). Default: now. */
  timestamp?: number | Date | [number, number];
}

/** Handle returned by {@link registerTelemetry}. @public */
export interface RegisteredTelemetry {
  /** `http://127.0.0.1:<port>/metrics` once listening, or `undefined` without `prometheusPort`. */
  readonly prometheusEndpoint: Promise<string | undefined>;
  /** Emits a log record through the configured `logExporter`; a no-op without one. Never throws. */
  log(record: TelemetryLogRecord): void;
  /** Exports pending spans, metrics and logs. */
  flush(): Promise<void>;
  /** Flushes, stops both providers and the Prometheus server, and disables the globals. Never rejects. */
  shutdown(): Promise<void>;
}

const DEFAULT_EXPORT_TIMEOUT_MS = 5000;
const DEFAULT_METRIC_INTERVAL_MS = 60000;

/** Masks `scheme://user:pw@host` userinfo, then applies the SDK's secret redactor. */
function redactLine(text: string): string {
  return Security.redact(text.replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/?#@]*@/gi, "$1***@"));
}

function describeArg(arg: unknown): string {
  if (arg instanceof Error) return arg.message;
  if (typeof arg === "string") return arg;
  try {
    return JSON.stringify(arg) ?? String(arg);
  } catch {
    return String(arg);
  }
}

function normalizeEndpoint(endpoint: string): string {
  let parsed: URL | undefined;
  try {
    parsed = new URL(endpoint);
  } catch {
    parsed = undefined;
  }
  if (parsed === undefined || (parsed.protocol !== "http:" && parsed.protocol !== "https:")) {
    throw new ConfigurationError("registerTelemetry: `endpoint` must be an http(s) URL", {
      code: "telemetry_endpoint_invalid",
    });
  }
  let end = endpoint.length;
  while (end > 0 && endpoint.charCodeAt(end - 1) === 47) end--;
  return endpoint.slice(0, end);
}

async function loadPeer<T>(name: string): Promise<T> {
  try {
    return (await import(name)) as T;
  } catch (cause) {
    throw new ConfigurationError(
      `registerTelemetry needs the optional peer dependency "${name}"; install it to register telemetry providers`,
      { code: "telemetry_peer_missing", cause },
    );
  }
}

// biome-ignore lint/suspicious/noExplicitAny: peers are optional, so their module types are not imported by value.
type Peer = any;

/** Loads a peer by a literal specifier, so bundlers keep it external and lazy. */
const peers = {
  api: () => loadPeer<Peer>("@opentelemetry/api"),
  trace: () => loadPeer<Peer>("@opentelemetry/sdk-trace-base"),
  metrics: () => loadPeer<Peer>("@opentelemetry/sdk-metrics"),
  resources: () => loadPeer<Peer>("@opentelemetry/resources"),
  logs: () => loadPeer<Peer>("@opentelemetry/sdk-logs"),
};

interface LogSetup {
  readonly provider: { forceFlush(): Promise<void>; shutdown(): Promise<void> } | undefined;
  readonly log: (record: TelemetryLogRecord) => void;
}

async function setupLogs(
  exporter: LogRecordExporter | undefined,
  resource: unknown,
  timeout: number,
): Promise<LogSetup> {
  if (exporter === undefined) return { provider: undefined, log() {} };
  const logsSdk = await peers.logs();
  const provider = new logsSdk.LoggerProvider({
    resource,
    processors: [new logsSdk.BatchLogRecordProcessor({ exporter, exportTimeoutMillis: timeout })],
  });
  const logger = provider.getLogger("@theokit/sdk");
  return {
    provider,
    log(record) {
      try {
        logger.emit(record);
      } catch {
        // logging must never break the caller
      }
    },
  };
}

async function loadTraceExporter(
  options: RegisterTelemetryOptions,
  base: string,
): Promise<SpanExporter> {
  if (options.spanExporter !== undefined) return options.spanExporter;
  const mod = await loadPeer<Peer>("@opentelemetry/exporter-trace-otlp-http");
  return new mod.OTLPTraceExporter({
    url: `${base}/v1/traces`,
    timeoutMillis: options.exportTimeoutMs ?? DEFAULT_EXPORT_TIMEOUT_MS,
  });
}

async function loadMetricExporter(
  options: RegisterTelemetryOptions,
  base: string,
): Promise<PushMetricExporter> {
  if (options.metricExporter !== undefined) return options.metricExporter;
  const mod = await loadPeer<Peer>("@opentelemetry/exporter-metrics-otlp-http");
  return new mod.OTLPMetricExporter({
    url: `${base}/v1/metrics`,
    timeoutMillis: options.exportTimeoutMs ?? DEFAULT_EXPORT_TIMEOUT_MS,
  });
}

interface PrometheusServer {
  readonly reader: unknown;
  readonly endpoint: Promise<string>;
  close(): Promise<void>;
}

async function startPrometheus(port: number): Promise<PrometheusServer> {
  const mod = await loadPeer<Peer>("@opentelemetry/exporter-prometheus");
  const reader = new mod.PrometheusExporter({ preventServerStart: true });
  const server: Server = createServer((req, res) => {
    const path = (req.url ?? "").split("?")[0];
    if (req.method === "GET" && path === "/metrics") {
      reader.getMetricsRequestHandler(req, res);
      return;
    }
    res.statusCode = 404;
    res.end();
  });
  const endpoint = new Promise<string>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}/metrics`);
    });
  });
  // A failed listen must not become an unhandled rejection; `prometheusEndpoint` reports it.
  endpoint.catch(() => undefined);
  return {
    reader,
    endpoint,
    close: () =>
      new Promise<void>((resolve) => {
        if (!server.listening) return resolve();
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}

/**
 * Registers global OTLP tracer and meter providers.
 *
 * Rejects with `ConfigurationError` when `endpoint` is not an `http(s)` URL (`telemetry_endpoint_invalid`),
 * when an optional OpenTelemetry peer is not installed (`telemetry_peer_missing`), or when a provider is
 * already registered (`telemetry_provider_registered`).
 *
 * @public
 */
export async function registerTelemetry(
  options: RegisterTelemetryOptions,
): Promise<RegisteredTelemetry> {
  const base = normalizeEndpoint(options.endpoint);
  const [api, traceSdk, metricsSdk, resources] = await Promise.all([
    peers.api(),
    peers.trace(),
    peers.metrics(),
    peers.resources(),
  ]);
  const spanExporter = await loadTraceExporter(options, base);
  const metricExporter = await loadMetricExporter(options, base);
  const resource = resources.resourceFromAttributes({ "service.name": options.serviceName });
  const timeout = options.exportTimeoutMs ?? DEFAULT_EXPORT_TIMEOUT_MS;
  const logSetup = await setupLogs(options.logExporter, resource, timeout);
  const prometheus =
    options.prometheusPort === undefined
      ? undefined
      : await startPrometheus(options.prometheusPort);

  const report = options.onExportError ?? diagFailure;
  const emit = (...args: unknown[]): void => {
    try {
      report(redactLine(args.map(describeArg).join(" ")));
    } catch {
      // A throwing error sink must not break the export path.
    }
  };

  const tracerProvider = new traceSdk.BasicTracerProvider({
    resource,
    spanProcessors: [
      new traceSdk.BatchSpanProcessor(spanExporter, { exportTimeoutMillis: timeout }),
    ],
  });
  const readers = [
    new metricsSdk.PeriodicExportingMetricReader({
      exporter: metricExporter,
      exportIntervalMillis: options.metricIntervalMs ?? DEFAULT_METRIC_INTERVAL_MS,
      exportTimeoutMillis: timeout,
    }),
    ...(prometheus === undefined ? [] : [prometheus.reader]),
  ];
  const meterProvider = new metricsSdk.MeterProvider({ resource, readers });

  const stop = async (): Promise<void> => {
    await Promise.allSettled([
      tracerProvider.shutdown(),
      meterProvider.shutdown(),
      logSetup.provider?.shutdown(),
      prometheus?.close(),
    ]);
  };

  // Disable only what this call registered: a failed second call must not tear down the first.
  const traceSet = api.trace.setGlobalTracerProvider(tracerProvider);
  const metricsSet = traceSet && api.metrics.setGlobalMeterProvider(meterProvider);
  if (!metricsSet) {
    if (traceSet) api.trace.disable();
    await stop();
    throw new ConfigurationError(
      "registerTelemetry: a tracer or meter provider is already registered in this process",
      { code: "telemetry_provider_registered" },
    );
  }
  api.diag.setLogger(
    { error: emit, warn: emit, info() {}, debug() {}, verbose() {} },
    api.DiagLogLevel.WARN,
  );

  return {
    prometheusEndpoint: prometheus === undefined ? Promise.resolve(undefined) : prometheus.endpoint,
    log: logSetup.log,
    async flush() {
      await Promise.allSettled([
        tracerProvider.forceFlush(),
        meterProvider.forceFlush(),
        logSetup.provider?.forceFlush(),
      ]);
    },
    async shutdown() {
      try {
        api.trace.disable();
        api.metrics.disable();
        api.diag.disable();
        await stop();
      } catch {
        // shutdown never rejects
      }
    },
  };
}
