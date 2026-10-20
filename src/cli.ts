#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { realpathSync } from "node:fs";
import { diagnose, normalizeUrl, render } from "./index.ts";

export { normalizeUrl };

const HELP = `
whyslow — qual fase da requisição está lenta

  whyslow https://exemplo.com
  whyslow https://api.exemplo.com/health -n 10

Mede DNS, TCP, TLS, TTFB e download separadamente e diz qual é o culpado.

opções:
  -n, --samples <n>       amostras (padrão 5)
  -X, --method <verbo>    método HTTP (padrão GET)
  -H, --header 'K: V'     cabeçalho extra (repetível)
      --timeout <ms>      timeout de conexão/inatividade (padrão 10000)
      --no-keepalive      conexão nova a cada amostra (mede o custo frio)
      --max-redirects <n> saltos seguidos (padrão 5)
      --insecure          aceita certificado inválido
      --json              saída JSON (análise + amostras)
  -h, --help

exit: 0 saudável · 1 avisos · 2 problema crítico · 3 erro de uso
`;

interface Args {
  url?: string;
  samples: number;
  method: string;
  headers: Record<string, string>;
  timeoutMs: number;
  keepAlive: boolean;
  maxRedirects: number;
  insecure: boolean;
  json: boolean;
  help: boolean;
}

export function parseArgs(argv: string[]): Args {
  const a: Args = {
    samples: 5,
    method: "GET",
    headers: {},
    timeoutMs: 10_000,
    keepAlive: true,
    maxRedirects: 5,
    insecure: false,
    json: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    const next = () => argv[++i] ?? "";
    switch (arg) {
      case "-n":
      case "--samples":
        a.samples = Number(next());
        break;
      case "-X":
      case "--method":
        a.method = next().toUpperCase();
        break;
      case "-H":
      case "--header": {
        const raw = next();
        const at = raw.indexOf(":");
        if (at === -1) throw new Error(`cabeçalho inválido: ${raw}`);
        a.headers[raw.slice(0, at).trim().toLowerCase()] = raw.slice(at + 1).trim();
        break;
      }
      case "--timeout":
        a.timeoutMs = Number(next());
        break;
      case "--no-keepalive":
        a.keepAlive = false;
        break;
      case "--max-redirects":
        a.maxRedirects = Number(next());
        break;
      case "--insecure":
        a.insecure = true;
        break;
      case "--json":
        a.json = true;
        break;
      case "-h":
      case "--help":
        a.help = true;
        break;
      default:
        if (arg.startsWith("-")) throw new Error(`opção desconhecida: ${arg}`);
        a.url ??= arg;
    }
  }
  return a;
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.url) {
    console.log(HELP);
    return args.help ? 0 : 3;
  }

  const { analysis, samples } = await diagnose(args.url, {
    samples: args.samples,
    timeoutMs: args.timeoutMs,
    method: args.method,
    headers: args.headers,
    maxRedirects: args.maxRedirects,
    keepAlive: args.keepAlive,
    insecure: args.insecure,
  });
  console.log(args.json ? JSON.stringify({ analysis, samples }, null, 2) : render(analysis));

  if (analysis.findings.some((f) => f.severity === "critical")) return 2;
  return analysis.findings.some((f) => f.severity === "warn") ? 1 : 0;
}

// Só executa quando chamado como CLI: os testes importam parseArgs daqui.
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  try {
    process.exit(await main());
  } catch (err) {
    console.error(`\n  ✖ ${(err as Error).message}`);
    process.exit(3);
  }
}
