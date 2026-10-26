import { LABEL } from "./analyze.ts";
import type { Analysis, Severity } from "./types.ts";

const useColor = () =>
  !process.env.NO_COLOR && (process.env.FORCE_COLOR === "1" || Boolean(process.stdout.isTTY));

const paint = (code: string, s: string) => (useColor() ? `\x1b[${code}m${s}\x1b[0m` : s);
const bold = (s: string) => paint("1", s);
const dim = (s: string) => paint("2", s);
const cyan = (s: string) => paint("36", s);
const green = (s: string) => paint("32", s);

const MARK: Record<Severity, (s: string) => string> = {
  critical: (s) => paint("31", s),
  warn: (s) => paint("33", s),
  info: (s) => paint("36", s),
};
const ICON: Record<Severity, string> = { critical: "✖", warn: "▲", info: "•" };

const BAR_WIDTH = 32;

/** Barra proporcional: dá para ver o culpado antes de ler o texto. */
function bar(share: number): string {
  const filled = Math.max(1, Math.round(share * BAR_WIDTH));
  return "█".repeat(filled) + dim("·".repeat(Math.max(0, BAR_WIDTH - filled)));
}

export function render(a: Analysis): string {
  const out: string[] = [];
  const worst = a.findings[0];

  out.push("");
  out.push(`  ${bold(a.url)}`);
  const ms = (v: number) => (a.ok ? `${Math.round(v)}ms` : "n/d");
  const failedNote = a.ok < a.samples ? ` (${a.samples - a.ok} de ${a.samples} amostras falharam)` : "";
  out.push(
    dim(
      `  ${a.ok}/${a.samples} ok · requisição p50 ${ms(a.totalP50)}${failedNote} / p95 ${ms(
        a.totalP95,
      )} · abrir conexão +${a.connectionMs}ms · primeira chamada ${
        a.ok ? `~${a.connectionMs + Math.round(a.totalP50)}ms` : "n/d"
      }`,
    ),
  );
  out.push("");

  for (const p of a.phases) {
    const label = LABEL[p.phase].padEnd(28);
    const time = `${Math.round(p.p50)}ms`.padStart(7);
    const pctText = `${Math.round(p.share * 100)}%`.padStart(4);
    const line = `  ${label}${time} ${pctText}  ${bar(p.share)}`;
    out.push(p.phase === a.culprit ? bold(line) : dim(line));
  }
  out.push("");

  if (worst) {
    out.push(
      worst.id === "healthy"
        ? `  ${green(`✔ ${worst.title}`)}`
        : `  ${MARK[worst.severity](`${ICON[worst.severity]} ${worst.title}`)}`,
    );
    out.push("");
  }

  for (const f of a.findings) {
    if (f.id === "healthy") continue;
    if (f === worst) out.push(dim(`     [${f.id}]`));
    else out.push(`  ${MARK[f.severity](ICON[f.severity])} ${bold(f.title)} ${dim(`[${f.id}]`)}`);
    if (f.detail) out.push(`     ${f.detail}`);
    if (f.hint) out.push(`     ${cyan("→")} ${f.hint}`);
    out.push("");
  }

  return out.join("\n");
}
