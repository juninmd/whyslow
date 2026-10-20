import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import type { ProbeOptions, Sample } from "./types.ts";

const REDIRECT_CODES = new Set([301, 302, 303, 307, 308]);

export function daysUntil(validTo: string | undefined, now = Date.now()): number | null {
  if (!validTo) return null;
  const at = new Date(validTo).getTime();
  if (Number.isNaN(at)) return null;
  return Math.floor((at - now) / 86_400_000);
}

export interface ConnectionTiming {
  dnsMs: number | null;
  tcpMs: number | null;
  tlsMs: number | null;
  certExpiresInDays: number | null;
  error: string | null;
  /** endereço que aceitou a conexão */
  address: string | null;
  /** endereços que o DNS devolveu primeiro e recusaram conexão (clássico do ::1) */
  failedAddresses: string[];
}

/** Conecta na primeira família que aceitar, na ordem que o DNS devolveu. */
function connectFirstWorking(
  addresses: string[],
  port: number,
  timeoutMs: number,
): Promise<{ socket: net.Socket | null; address: string | null; failed: string[]; error: string | null }> {
  return new Promise((resolve) => {
    const failed: string[] = [];
    let index = 0;
    const tryNext = () => {
      const address = addresses[index++];
      if (!address) {
        resolve({ socket: null, address: null, failed, error: "nenhum endereço aceitou conexão" });
        return;
      }
      const socket = net.connect({ host: address, port });
      const timer = setTimeout(() => {
        socket.destroy();
        failed.push(`${address} (timeout)`);
        tryNext();
      }, timeoutMs);
      socket.once("connect", () => {
        clearTimeout(timer);
        resolve({ socket, address, failed, error: null });
      });
      socket.once("error", (e: Error) => {
        clearTimeout(timer);
        socket.destroy();
        failed.push(`${address} (${(e as NodeJS.ErrnoException).code ?? e.message})`);
        tryNext();
      });
    };
    tryNext();
  });
}

/**
 * Mede DNS, TCP e TLS em um socket próprio.
 *
 * Por que não usar os eventos do `http.request`: o Bun não emite `lookup`,
 * `connect` nem `secureConnect`, então lá dentro o handshake aparece embutido
 * no TTFB. Medindo por fora, a decomposição funciona nos dois runtimes.
 */
export function connectionTiming(url: string, opts: ProbeOptions): Promise<ConnectionTiming> {
  const target = new URL(url);
  const secure = target.protocol === "https:";
  const port = Number(target.port || (secure ? 443 : 80));
  const out: ConnectionTiming = {
    dnsMs: null,
    tcpMs: null,
    tlsMs: null,
    certExpiresInDays: null,
    error: null,
    address: null,
    failedAddresses: [],
  };

  return new Promise((resolve) => {
    const t0 = performance.now();
    const done = (patch: Partial<ConnectionTiming> = {}) => resolve({ ...out, ...patch });

    // `all: true` + `verbatim` = a mesma ordem que o cliente veria, IPv6 primeiro.
    dns.lookup(target.hostname, { all: true, verbatim: true }, async (err, results) => {
      const tDns = performance.now();
      out.dnsMs = Math.round(tDns - t0);
      if (err || !results?.length) {
        return done({ error: `DNS: ${err?.message ?? "sem endereço"}` });
      }

      const addresses = results.map((r) => r.address);
      const attempt = await connectFirstWorking(addresses, port, opts.timeoutMs);
      out.failedAddresses = attempt.failed;
      out.address = attempt.address;
      const tTcp = performance.now();
      if (!attempt.socket) return done({ error: `TCP: ${attempt.error}` });
      out.tcpMs = Math.round(tTcp - tDns);

      if (!secure) {
        attempt.socket.destroy();
        return done();
      }

      const secured = tls.connect(
        { socket: attempt.socket, servername: target.hostname, rejectUnauthorized: !opts.insecure },
        () => {
          out.tlsMs = Math.round(performance.now() - tTcp);
          const cert = secured.getPeerCertificate?.();
          out.certExpiresInDays = daysUntil(cert?.valid_to);
          secured.destroy();
          done();
        },
      );
      secured.on("error", (e: Error) => {
        secured.destroy();
        done({ error: `TLS: ${e.message}` });
      });
    });
  });
}

export interface RequestTiming {
  ok: boolean;
  status: number | null;
  ttfbMs: number | null;
  downloadMs: number | null;
  bytes: number;
  contentEncoding: string | null;
  contentType: string | null;
  server: string | null;
  location: string | null;
  httpVersion: string | null;
  error: string | null;
}

type Agents = { http: http.Agent; https: https.Agent };

export function createAgents(opts: ProbeOptions): Agents {
  return {
    http: new http.Agent({ keepAlive: opts.keepAlive }),
    https: new https.Agent({ keepAlive: opts.keepAlive, rejectUnauthorized: !opts.insecure }),
  };
}

/** TTFB e download de uma requisição. Com o agente aquecido, exclui o handshake. */
export function requestTiming(
  url: string,
  opts: ProbeOptions,
  agents: Agents,
): Promise<RequestTiming> {
  return new Promise((resolve) => {
    const target = new URL(url);
    const secure = target.protocol === "https:";
    const lib = secure ? https : http;
    const t0 = performance.now();
    let settled = false;
    const base: RequestTiming = {
      ok: false,
      status: null,
      ttfbMs: null,
      downloadMs: null,
      bytes: 0,
      contentEncoding: null,
      contentType: null,
      server: null,
      location: null,
      httpVersion: null,
      error: null,
    };
    const finish = (patch: Partial<RequestTiming>) => {
      if (settled) return;
      settled = true;
      resolve({ ...base, ...patch });
    };

    const req = lib.request(
      target,
      {
        method: opts.method,
        headers: { "user-agent": "whyslow/0.1", "accept-encoding": "gzip, br", ...opts.headers },
        agent: secure ? agents.https : agents.http,
        timeout: opts.timeoutMs,
      },
      (res) => {
        const tResponse = performance.now();
        const status = res.statusCode ?? 0;
        let bytes = 0;
        res.on("data", (chunk: Buffer) => {
          bytes += chunk.length;
        });
        res.on("end", () =>
          finish({
            ok: status >= 200 && status < 400,
            status,
            ttfbMs: Math.round(tResponse - t0),
            downloadMs: Math.round(performance.now() - tResponse),
            bytes,
            contentEncoding: (res.headers["content-encoding"] as string) ?? null,
            contentType: (res.headers["content-type"] as string) ?? null,
            server: (res.headers.server as string) ?? null,
            location: (res.headers.location as string) ?? null,
            httpVersion: res.httpVersion ?? null,
          }),
        );
        res.on("error", (err) => finish({ error: err.message, status }));
      },
    );
    req.on("timeout", () => {
      req.destroy();
      finish({ error: `timeout após ${opts.timeoutMs}ms` });
    });
    req.on("error", (err) => finish({ error: err.message }));
    req.end();
  });
}

/** Resolve a cadeia de redirecionamentos uma vez, antes de medir. */
export async function resolveRedirects(
  url: string,
  opts: ProbeOptions,
  agents: Agents,
): Promise<{ finalUrl: string; chain: string[]; ms: number }> {
  const chain: string[] = [];
  let current = url;
  let ms = 0;
  for (let hop = 0; hop < opts.maxRedirects; hop++) {
    const res = await requestTiming(current, opts, agents);
    ms += (res.ttfbMs ?? 0) + (res.downloadMs ?? 0);
    if (!res.status || !REDIRECT_CODES.has(res.status) || !res.location) {
      return { finalUrl: current, chain, ms: hop ? ms : 0 };
    }
    current = new URL(res.location, current).toString();
    chain.push(current);
  }
  return { finalUrl: current, chain, ms };
}

/** Junta as duas medições em uma amostra completa. */
export function toSample(
  conn: ConnectionTiming | null,
  req: RequestTiming,
  extra: { redirects: string[]; redirectMs: number; reused: boolean },
): Sample {
  const parts = [conn?.dnsMs, conn?.tcpMs, conn?.tlsMs, req.ttfbMs, req.downloadMs].filter(
    (n): n is number => typeof n === "number",
  );
  return {
    ok: req.ok && !conn?.error,
    status: req.status,
    error: req.error ?? conn?.error ?? null,
    dnsMs: conn?.dnsMs ?? null,
    tcpMs: conn?.tcpMs ?? null,
    tlsMs: conn?.tlsMs ?? null,
    ttfbMs: req.ttfbMs,
    downloadMs: req.downloadMs,
    totalMs: parts.reduce((a, b) => a + b, 0),
    bytes: req.bytes,
    reused: extra.reused,
    contentEncoding: req.contentEncoding,
    contentType: req.contentType,
    server: req.server,
    redirects: extra.redirects,
    redirectMs: extra.redirectMs,
    certExpiresInDays: conn?.certExpiresInDays ?? null,
    httpVersion: req.httpVersion,
    failedAddresses: conn?.failedAddresses ?? [],
  };
}

/**
 * Uma rodada completa: resolve redirecionamentos, aquece a conexão e mede
 * `count` amostras. A conexão fria é medida à parte, em socket próprio.
 */
export async function measure(
  url: string,
  opts: ProbeOptions,
  count: number,
): Promise<{ samples: Sample[]; finalUrl: string }> {
  const agents = createAgents(opts);
  try {
    const { finalUrl, chain, ms } = await resolveRedirects(url, opts, agents);
    const samples: Sample[] = [];
    for (let i = 0; i < count; i++) {
      // Sem keep-alive toda amostra paga a conexão; com keep-alive, só a primeira.
      const cold = i === 0 || !opts.keepAlive;
      const conn = cold ? await connectionTiming(finalUrl, opts) : null;
      const req = await requestTiming(finalUrl, opts, agents);
      samples.push(
        toSample(conn, req, {
          redirects: i === 0 ? chain : [],
          redirectMs: i === 0 ? Math.round(ms) : 0,
          reused: !cold,
        }),
      );
    }
    return { samples, finalUrl };
  } finally {
    agents.http.destroy();
    agents.https.destroy();
  }
}
