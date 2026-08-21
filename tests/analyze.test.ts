import { describe, expect, test } from "bun:test";
import { analyze, percentile, phaseStats } from "../src/analyze.ts";
import { daysUntil } from "../src/probe.ts";
import { normalizeUrl, parseArgs } from "../src/index.ts";
import type { Finding, Sample } from "../src/types.ts";

function sample(over: Partial<Sample> = {}): Sample {
  const base: Sample = {
    ok: true,
    status: 200,
    error: null,
    dnsMs: 5,
    tcpMs: 10,
    tlsMs: 20,
    ttfbMs: 50,
    downloadMs: 15,
    totalMs: 100,
    bytes: 1024,
    reused: false,
    contentEncoding: "gzip",
    contentType: "text/html",
    server: "traefik",
    redirects: [],
    redirectMs: 0,
    certExpiresInDays: 60,
    httpVersion: "1.1",
    failedAddresses: [],
  };
  return { ...base, ...over };
}

const find = (findings: Finding[], id: string) => findings.find((f) => f.id === id);
const has = (findings: Finding[], prefix: string) =>
  findings.find((f) => f.id.startsWith(prefix));

describe("percentile", () => {
  test("interpola", () => {
    expect(percentile([10, 20, 30, 40], 50)).toBe(25);
  });

  test("lida com lista vazia e unitária", () => {
    expect(percentile([], 95)).toBe(0);
    expect(percentile([7], 95)).toBe(7);
  });
});

describe("phaseStats", () => {
  test("share soma 1 entre as fases presentes", () => {
    const stats = phaseStats([sample()]);
    const total = stats.reduce((s, p) => s + p.share, 0);
    expect(total).toBeCloseTo(1, 5);
  });

  test("fase ausente não entra na conta", () => {
    const stats = phaseStats([sample({ tlsMs: null, dnsMs: null, tcpMs: null, reused: true })]);
    expect(stats.map((s) => s.phase)).toEqual(["ttfb", "download"]);
  });
});

describe("culpado", () => {
  test("TTFB dominante aponta a aplicação", () => {
    const a = analyze("https://x", [
      sample({ ttfbMs: 900, dnsMs: 5, tcpMs: 5, tlsMs: 10, downloadMs: 10, totalMs: 930 }),
    ]);
    expect(a.culprit).toBe("ttfb");
    expect(has(a.findings, "culprit-ttfb")?.hint).toContain("aplicação");
  });

  test("TLS dominante sugere keep-alive e TLS 1.3", () => {
    const a = analyze("https://x", [
      sample({ tlsMs: 800, ttfbMs: 40, dnsMs: 5, tcpMs: 10, downloadMs: 5, totalMs: 860 }),
    ]);
    expect(a.culprit).toBe("tls");
    expect(has(a.findings, "culprit-tls")?.hint).toContain("session resumption");
  });

  test("DNS dominante lembra do CoreDNS", () => {
    const a = analyze("https://x", [
      sample({ dnsMs: 700, tcpMs: 10, tlsMs: 20, ttfbMs: 30, downloadMs: 5, totalMs: 765 }),
    ]);
    expect(has(a.findings, "culprit-dns")?.hint).toContain("CoreDNS");
  });

  test("download dominante fala de compressão e paginação", () => {
    const a = analyze("https://x", [
      sample({ downloadMs: 900, dnsMs: 5, tcpMs: 5, tlsMs: 10, ttfbMs: 20, totalMs: 940 }),
    ]);
    expect(has(a.findings, "culprit-download")?.hint).toContain("Compressão");
  });

  test("fase com mais de 50% do tempo é crítica", () => {
    const a = analyze("https://x", [
      sample({ ttfbMs: 900, dnsMs: 5, tcpMs: 5, tlsMs: 10, downloadMs: 10, totalMs: 930 }),
    ]);
    expect(has(a.findings, "culprit-")?.severity).toBe("critical");
  });
});

describe("falhas", () => {
  test("nenhuma amostra ok vira crítico com o erro", () => {
    const a = analyze("https://x", [
      sample({ ok: false, error: "timeout após 10000ms", status: null }),
    ]);
    expect(find(a.findings, "unreachable")?.severity).toBe("critical");
    expect(find(a.findings, "unreachable")?.hint).toContain("firewall");
  });

  test("status 500 em todas explica que é a aplicação", () => {
    const a = analyze("https://x", [sample({ ok: false, status: 500, error: null })]);
    expect(find(a.findings, "unreachable")?.hint).toContain("aplicação");
  });

  test("intermitência é reportada separada da lentidão", () => {
    const a = analyze("https://x", [
      sample(),
      sample({ ok: false, error: "socket hang up" }),
      sample(),
    ]);
    expect(find(a.findings, "flaky")?.detail).toContain("socket hang up");
  });
});

describe("achados extras", () => {
  test("p95 muito acima da mediana vira aviso de instabilidade", () => {
    const a = analyze("https://x", [
      sample({ ttfbMs: 100, downloadMs: 0 }),
      sample({ ttfbMs: 110, downloadMs: 0 }),
      sample({ ttfbMs: 120, downloadMs: 0 }),
      sample({ ttfbMs: 2000, downloadMs: 0 }),
    ]);
    expect(find(a.findings, "unstable")?.hint).toContain("cold start");
  });

  test("variação grande em valores minúsculos não vira alarme", () => {
    const a = analyze("https://x", [
      sample({ ttfbMs: 10, downloadMs: 0 }),
      sample({ ttfbMs: 12, downloadMs: 0 }),
      sample({ ttfbMs: 15, downloadMs: 0 }),
      sample({ ttfbMs: 90, downloadMs: 0 }),
    ]);
    expect(find(a.findings, "unstable")).toBeUndefined();
  });

  test("custo de abrir conexão é somado e explicado", () => {
    const a = analyze("https://x", [
      sample({ dnsMs: 20, tcpMs: 40, tlsMs: 80, ttfbMs: 50, downloadMs: 10, totalMs: 200 }),
      sample({ dnsMs: null, tcpMs: null, tlsMs: null, ttfbMs: 50, downloadMs: 10, totalMs: 60, reused: true }),
    ]);
    const f = find(a.findings, "keepalive-gain");
    expect(f?.title).toContain("140ms");
    expect(f?.hint).toContain("keep-alive");
    expect(a.connectionMs).toBe(140);
    // O tempo de requisição não pode carregar o custo da conexão embutido.
    expect(a.totalP50).toBe(60);
  });

  test("conexão barata não vira recomendação", () => {
    const a = analyze("https://x", [sample({ dnsMs: 2, tcpMs: 3, tlsMs: 5 })]);
    expect(find(a.findings, "keepalive-gain")).toBeUndefined();
  });

  test("texto grande sem compressão é apontado", () => {
    const a = analyze("https://x", [
      sample({ contentEncoding: null, contentType: "application/json", bytes: 50_000 }),
    ]);
    expect(find(a.findings, "no-compression")?.hint).toContain("gzip");
  });

  test("binário sem compressão não gera falso positivo", () => {
    const a = analyze("https://x", [
      sample({ contentEncoding: null, contentType: "image/png", bytes: 500_000 }),
    ]);
    expect(find(a.findings, "no-compression")).toBeUndefined();
  });

  test("cadeia de redirecionamento é somada e mostrada", () => {
    const a = analyze("https://x", [
      sample({ redirects: ["https://a", "https://b"], redirectMs: 240 }),
    ]);
    const f = find(a.findings, "redirects");
    expect(f?.severity).toBe("warn");
    expect(f?.title).toContain("+240ms");
  });

  test("endereço IPv6 que recusa antes do IPv4 é diagnosticado", () => {
    const a = analyze("http://localhost:11434/", [
      sample({ failedAddresses: ["::1 (ECONNREFUSED)"] }),
    ]);
    const f = find(a.findings, "address-fallback");
    expect(f?.severity).toBe("warn");
    expect(f?.hint).toContain("127.0.0.1");
  });

  test("endereço morto que não é IPv6 recebe outra dica", () => {
    const a = analyze("http://x/", [sample({ failedAddresses: ["10.0.0.9 (ETIMEDOUT)"] })]);
    expect(find(a.findings, "address-fallback")?.hint).toContain("endereço morto");
  });

  test("certificado perto do vencimento é crítico abaixo de 7 dias", () => {
    expect(find(analyze("https://x", [sample({ certExpiresInDays: 3 })]).findings, "cert-expiring")?.severity).toBe(
      "critical",
    );
    expect(find(analyze("https://x", [sample({ certExpiresInDays: 15 })]).findings, "cert-expiring")?.severity).toBe(
      "warn",
    );
    expect(find(analyze("https://x", [sample({ certExpiresInDays: 60 })]).findings, "cert-expiring")).toBeUndefined();
  });

  test("requisição rápida não vira problema, mas ainda mostra a fase dominante", () => {
    const a = analyze("https://x", [sample(), sample(), sample()]);
    expect(a.findings[0]?.id).toBe("healthy");
    expect(a.findings.every((f) => f.severity === "info")).toBe(true);
    expect(a.culprit).toBe("ttfb");
  });

  test("fase dominante em resposta rápida não é alarme", () => {
    const a = analyze("https://x", [
      sample({ ttfbMs: 30, dnsMs: 1, tcpMs: 1, tlsMs: 2, downloadMs: 2, totalMs: 36 }),
    ]);
    expect(a.findings.every((f) => f.severity === "info")).toBe(true);
  });
});

describe("cli", () => {
  test("normalizeUrl assume https", () => {
    expect(normalizeUrl("exemplo.com")).toBe("https://exemplo.com/");
    expect(normalizeUrl("http://exemplo.com")).toBe("http://exemplo.com/");
  });

  test("parseArgs lê amostras, método e cabeçalho", () => {
    const a = parseArgs(["https://x", "-n", "9", "-X", "post", "-H", "Authorization: Bearer z"]);
    expect(a.url).toBe("https://x");
    expect(a.samples).toBe(9);
    expect(a.method).toBe("POST");
    expect(a.headers.authorization).toBe("Bearer z");
  });

  test("cabeçalho sem dois-pontos é erro de uso", () => {
    expect(() => parseArgs(["https://x", "-H", "invalido"])).toThrow("cabeçalho inválido");
  });

  test("--no-keepalive desliga o reaproveitamento", () => {
    expect(parseArgs(["https://x", "--no-keepalive"]).keepAlive).toBe(false);
  });
});

describe("certificado", () => {
  test("daysUntil converte a data do handshake", () => {
    const now = new Date("2026-08-01T00:00:00Z").getTime();
    expect(daysUntil("Aug 21 00:00:00 2026 GMT", now)).toBe(20);
    expect(daysUntil(undefined, now)).toBeNull();
    expect(daysUntil("data inválida", now)).toBeNull();
  });
});
