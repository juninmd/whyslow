import type { Analysis, Finding, Phase, PhaseStat, Sample, Severity } from "./types.ts";

const PHASES: Phase[] = ["dns", "tcp", "tls", "ttfb", "download"];

const FIELD: Record<Phase, keyof Sample> = {
  dns: "dnsMs",
  tcp: "tcpMs",
  tls: "tlsMs",
  ttfb: "ttfbMs",
  download: "downloadMs",
};

export const LABEL: Record<Phase, string> = {
  dns: "resolução DNS",
  tcp: "conexão TCP",
  tls: "handshake TLS",
  ttfb: "espera pelo servidor (TTFB)",
  download: "download do corpo",
};

export function percentile(values: number[], p: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 1) return sorted[0] as number;
  const rank = (p / 100) * (sorted.length - 1);
  const low = Math.floor(rank);
  const hi = Math.ceil(rank);
  const a = sorted[low] as number;
  const b = sorted[hi] as number;
  return a + (b - a) * (rank - low);
}

const values = (samples: Sample[], phase: Phase): number[] =>
  samples
    .map((s) => s[FIELD[phase]])
    .filter((v): v is number => typeof v === "number");

/** O que cada fase pesa na mediana do total. Fase ausente não entra na conta. */
export function phaseStats(samples: Sample[]): PhaseStat[] {
  const stats = PHASES.map((phase) => {
    const v = values(samples, phase);
    return { phase, p50: percentile(v, 50), p95: percentile(v, 95), share: 0 };
  }).filter((s) => s.p50 > 0 || s.p95 > 0);
  const total = stats.reduce((sum, s) => sum + s.p50, 0);
  return stats.map((s) => ({ ...s, share: total ? s.p50 / total : 0 }));
}

const isText = (contentType: string | null) =>
  Boolean(contentType && /text\/|json|javascript|xml|svg/.test(contentType));

/**
 * Transforma as amostras em um culpado e uma ação.
 * Pura: os testes descrevem cenários de latência sem tocar a rede.
 */
export function analyze(url: string, samples: Sample[]): Analysis {
  const findings: Finding[] = [];
  const push = (id: string, severity: Severity, title: string, detail: string, hint?: string) =>
    findings.push({ id, severity, title, detail, hint });

  const ok = samples.filter((s) => s.ok);
  const failed = samples.filter((s) => !s.ok);
  // "Total" aqui é o tempo da requisição em si (TTFB + download). O custo de
  // abrir conexão é reportado à parte: misturar os dois esconde os dois.
  const totals = samples.map((s) => (s.ttfbMs ?? 0) + (s.downloadMs ?? 0));
  const stats = phaseStats(samples);
  const culprit = stats.length
    ? (stats.reduce((a, b) => (b.p50 > a.p50 ? b : a)).phase as Phase)
    : null;

  // ---- falhou de vez -----------------------------------------------------
  if (!ok.length && samples.length) {
    const first = samples[0] as Sample;
    push(
      "unreachable",
      "critical",
      first.error ? `Não completou: ${first.error}` : `Resposta ${first.status}`,
      first.error
        ? "Nenhuma amostra chegou ao fim."
        : `Todas as ${samples.length} amostras responderam ${first.status}.`,
      first.error?.includes("timeout")
        ? "Timeout com TCP estabelecido é servidor pendurado; timeout sem TCP é rede/firewall."
        : "Status fora da faixa 2xx/3xx: o problema é a aplicação, não a latência.",
    );
  } else if (failed.length) {
    push(
      "flaky",
      "critical",
      `${failed.length} de ${samples.length} amostras falharam`,
      failed
        .map((f) => f.error ?? `status ${f.status}`)
        .filter((v, i, arr) => arr.indexOf(v) === i)
        .join(" · "),
      "Intermitência é pior que lentidão: veja balanceador com backend doente ou limite de conexão.",
    );
  }

  // ---- o culpado ---------------------------------------------------------
  const worst = stats.find((s) => s.phase === culprit);
  if (worst && culprit) {
    const share = Math.round(worst.share * 100);
    const hints: Record<Phase, string> = {
      dns: "DNS lento é resolver ruim ou TTL curto. Teste outro resolver e confira se o registro tem TTL decente. Em cluster, suspeite do CoreDNS e do ndots do /etc/resolv.conf.",
      tcp: "Conexão TCP lenta é distância ou fila no balanceador. Se o RTT é alto, nenhuma otimização de app resolve — aproxime o servidor ou use CDN.",
      tls: "Handshake caro: cadeia de certificados longa, sem session resumption ou sem TLS 1.3. Keep-alive resolve na prática, porque paga o handshake uma vez só.",
      ttfb: "TTFB alto é a aplicação pensando: consulta lenta, cold start ou trabalho síncrono no request. É aqui que profiling de backend paga.",
      download: "Download dominando é corpo grande ou banda curta. Compressão e paginação resolvem mais que servidor mais rápido.",
    };
    // Uma fase dominante só é problema se o total também for ruim: 90% de TTFB
    // em 40ms não é sintoma de nada.
    const totalP50 = percentile(totals, 50);
    const severity: Severity =
      share >= 50 && totalP50 >= 500 ? "critical" : share >= 50 && totalP50 >= 200 ? "warn" : "info";
    push(
      `culprit-${culprit}`,
      severity,
      `${LABEL[culprit]} é ${share}% do tempo (p50 ${Math.round(worst.p50)}ms)`,
      stats.map((s) => `${s.phase} ${Math.round(s.p50)}ms`).join(" · "),
      hints[culprit],
    );
  }

  // ---- instabilidade -----------------------------------------------------
  const p50 = percentile(totals, 50);
  const p95 = percentile(totals, 95);
  // Exige um piso absoluto: 3x de 20ms para 60ms não é sintoma de nada.
  if (p50 > 0 && p95 > p50 * 3 && p95 >= 200 && samples.length >= 3) {
    push(
      "unstable",
      "warn",
      `Latência instável: p95 (${Math.round(p95)}ms) é ${(p95 / p50).toFixed(1)}x a mediana`,
      "A média esconde o que o usuário sente.",
      "Cauda longa costuma ser GC, cold start de réplica nova ou uma réplica doente no balanceamento.",
    );
  }

  // ---- custo da conexão fria --------------------------------------------
  const connCost =
    percentile(values(samples, "dns"), 50) +
    percentile(values(samples, "tcp"), 50) +
    percentile(values(samples, "tls"), 50);
  if (connCost > 20) {
    push(
      "keepalive-gain",
      "info",
      `Abrir conexão custa ~${Math.round(connCost)}ms (DNS + TCP + TLS)`,
      "É o preço da primeira requisição de cada cliente novo.",
      "Com keep-alive esse custo é pago uma vez, não por requisição. Confira o pool de conexões do cliente e o keep-alive timeout do servidor.",
    );
  }

  const last = ok.at(-1) ?? samples.at(-1);

  // ---- endereço que recusa antes do que funciona -------------------------
  const rejected = samples.flatMap((s) => s.failedAddresses);
  if (rejected.length) {
    const unique = [...new Set(rejected)];
    const ipv6 = unique.some((a) => a.includes(":") && !a.startsWith("127."));
    push(
      "address-fallback",
      "warn",
      `O host resolve para endereço que recusa conexão: ${unique.join(", ")}`,
      "O cliente tenta o primeiro endereço, apanha, e só então cai para o que funciona.",
      ipv6
        ? "Clássico do IPv6: o DNS devolve ::1/AAAA primeiro e o serviço só escuta em IPv4. Faça o serviço escutar em ambos, ou aponte o cliente para 127.0.0.1 em vez de localhost."
        : "Tire do DNS o endereço morto — cada cliente novo paga esse tempo antes de acertar.",
    );
  }

  // ---- compressão --------------------------------------------------------
  if (last && !last.contentEncoding && isText(last.contentType) && last.bytes > 2048) {
    push(
      "no-compression",
      "warn",
      `Resposta de ${(last.bytes / 1024).toFixed(1)} KB sem compressão`,
      `content-type ${last.contentType}, sem content-encoding.`,
      "Ligue gzip/brotli no servidor ou no ingress: texto costuma encolher 70%.",
    );
  }

  // ---- redirecionamentos -------------------------------------------------
  if (last?.redirects.length) {
    push(
      "redirects",
      last.redirects.length > 1 ? "warn" : "info",
      `${last.redirects.length} redirecionamento(s) antes da resposta (+${Math.round(last.redirectMs)}ms)`,
      last.redirects.join(" → "),
      "Cada salto paga uma volta completa. Aponte o cliente direto para o destino final.",
    );
  }

  // ---- certificado -------------------------------------------------------
  const certDays = samples.map((s) => s.certExpiresInDays).find((d) => typeof d === "number");
  if (typeof certDays === "number" && certDays < 21) {
    push(
      "cert-expiring",
      certDays < 7 ? "critical" : "warn",
      `Certificado TLS expira em ${certDays} dia(s)`,
      "Medido no handshake desta requisição.",
      "Se é cert-manager, veja o Certificate e o Order agora — renovação falha em silêncio.",
    );
  }

  // ---- HTTP/1.1 em corpo grande -----------------------------------------
  if (last?.httpVersion === "1.1" && last.bytes > 100_000) {
    push(
      "http1",
      "info",
      "HTTP/1.1 com corpo grande",
      `${(last.bytes / 1024).toFixed(0)} KB por HTTP/1.1.`,
      "HTTP/2 ajuda quando há muitas requisições paralelas; para um corpo só, compressão rende mais.",
    );
  }

  // Nenhum problema real: a manchete é a confirmação, não a fase dominante.
  if (!findings.some((f) => f.severity !== "info")) {
    findings.unshift({
      id: "healthy",
      severity: "info",
      title: `Nada de anormal: p50 ${Math.round(p50)}ms`,
      detail: stats.map((s) => `${s.phase} ${Math.round(s.p50)}ms`).join(" · "),
    });
  }

  const order: Record<Severity, number> = { critical: 0, warn: 1, info: 2 };
  return {
    url,
    samples: samples.length,
    ok: ok.length,
    totalP50: p50,
    totalP95: p95,
    connectionMs: Math.round(connCost),
    phases: stats,
    culprit,
    findings: findings.sort((a, b) => order[a.severity] - order[b.severity]),
  };
}
