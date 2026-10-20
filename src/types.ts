export type Phase = "dns" | "tcp" | "tls" | "ttfb" | "download";

export interface Sample {
  ok: boolean;
  status: number | null;
  error: string | null;
  /** null quando a fase não aconteceu (conexão reaproveitada, http sem TLS) */
  dnsMs: number | null;
  tcpMs: number | null;
  tlsMs: number | null;
  ttfbMs: number | null;
  downloadMs: number | null;
  totalMs: number;
  bytes: number;
  /** socket reaproveitado do keep-alive: não pagou DNS/TCP/TLS */
  reused: boolean;
  contentEncoding: string | null;
  contentType: string | null;
  server: string | null;
  /** cadeia de redirecionamentos até a resposta final */
  redirects: string[];
  redirectMs: number;
  certExpiresInDays: number | null;
  httpVersion: string | null;
  /** endereços recusados antes de um aceitar (o clássico ::1 antes do IPv4) */
  failedAddresses: string[];
}

export interface PhaseStat {
  phase: Phase;
  p50: number;
  p95: number;
  share: number;
}

export type Severity = "critical" | "warn" | "info";

export interface Finding {
  id: string;
  severity: Severity;
  title: string;
  detail: string;
  hint?: string;
}

export interface Analysis {
  url: string;
  samples: number;
  ok: number;
  /** tempo da requisição em si (TTFB + download), sem o custo de abrir conexão */
  totalP50: number;
  totalP95: number;
  /** DNS + TCP + TLS: o que um cliente novo paga antes da primeira resposta */
  connectionMs: number;
  phases: PhaseStat[];
  /** fase que mais pesa na mediana */
  culprit: Phase | null;
  findings: Finding[];
}

export interface ProbeOptions {
  timeoutMs: number;
  method: string;
  headers: Record<string, string>;
  maxRedirects: number;
  /** reaproveita a conexão entre amostras (mede o mundo real de um cliente) */
  keepAlive: boolean;
  insecure: boolean;
}

export type Prober = (url: string, opts: ProbeOptions) => Promise<Sample>;
