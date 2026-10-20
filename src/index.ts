import { analyze } from "./analyze.ts";
import { measure } from "./probe.ts";
import type { DiagnoseOptions, Diagnosis, ProbeOptions } from "./types.ts";

export { analyze } from "./analyze.ts";
export { measure } from "./probe.ts";
export { render } from "./render.ts";
export type {
  Analysis, DiagnoseOptions, Diagnosis, Finding, Phase, PhaseStat,
  ProbeOptions, Sample, Severity,
} from "./types.ts";

/** Normaliza um alvo HTTP(S), assumindo HTTPS quando não há esquema. */
export function normalizeUrl(raw: string): string {
  const target = new URL(/^[a-z][a-z\d+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`);
  if (target.protocol !== "http:" && target.protocol !== "https:") {
    throw new TypeError("A URL deve usar http ou https.");
  }
  return target.toString();
}

/** Mede um endpoint e retorna análise e amostras, sem imprimir nem encerrar o processo. */
export async function diagnose(url: string, options: DiagnoseOptions = {}): Promise<Diagnosis> {
  const samples = options.samples ?? 5;
  const opts: ProbeOptions = {
    timeoutMs: options.timeoutMs ?? 10_000,
    method: options.method ?? "GET",
    headers: { ...options.headers },
    maxRedirects: options.maxRedirects ?? 5,
    keepAlive: options.keepAlive ?? true,
    insecure: options.insecure ?? false,
  };
  if (!Number.isSafeInteger(samples) || samples < 1) {
    throw new RangeError("samples deve ser um inteiro positivo.");
  }
  if (!Number.isInteger(opts.timeoutMs) || opts.timeoutMs < 1 || opts.timeoutMs > 2_147_483_647) {
    throw new RangeError("timeoutMs deve ser um inteiro entre 1 e 2147483647.");
  }
  if (!Number.isSafeInteger(opts.maxRedirects) || opts.maxRedirects < 0) {
    throw new RangeError("maxRedirects deve ser um inteiro não negativo.");
  }
  const result = await measure(normalizeUrl(url), opts, samples);
  return { ...result, analysis: analyze(result.finalUrl, result.samples) };
}
