import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const root = fileURLToPath(new URL("../", import.meta.url));
const npmCli = process.env.npm_execpath;
assert(npmCli?.endsWith(".js"), "Execute com npm run test:package.");
const fixture = await mkdtemp(join(tmpdir(), "whyslow-package-"));
const npm = (args, cwd = root) => exec(process.execPath, [npmCli, ...args], {
  cwd, timeout: 60_000, maxBuffer: 2_000_000,
});
const run = (args) => exec(process.execPath, args, { cwd: fixture, timeout: 15_000 });
let server;
try {
  const packed = JSON.parse((await npm(["pack", "--json", "--pack-destination", fixture])).stdout)[0];
  assert(packed.files.some((file) => file.path === "dist/index.d.ts"));
  assert(!packed.files.some((file) => file.path.startsWith("src/") || file.path.startsWith("tests/")));
  await writeFile(join(fixture, "package.json"), JSON.stringify({ private: true, type: "module" }));
  await npm(["install", join(fixture, packed.filename), "--ignore-scripts", "--no-audit", "--no-fund"], fixture);

  // Importar a biblioteca não imprime nada nem executa a CLI.
  const imported = await run(["--input-type=module", "-e", "await import('whyslow'); console.log('imported');"]);
  assert.equal(imported.stdout.trim(), "imported");
  assert.equal(imported.stderr, "");

  const requests = [];
  server = http.createServer((req, res) => {
    requests.push({ method: req.method, header: req.headers["x-test"] });
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("ok");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}/health`;
  const consumer = `
    import assert from 'node:assert/strict';
    import { diagnose, analyze, render } from 'whyslow';
    const result = await diagnose(${JSON.stringify(url)}, {
      samples: 3, method: 'HEAD', headers: { 'x-test': 'package' }, timeoutMs: 1000,
    });
    assert.equal(result.analysis.ok, 3);
    assert.equal(result.samples.length, 3);
    assert.deepEqual(analyze(result.finalUrl, result.samples), result.analysis);
    assert.match(render(result.analysis), /3\\/3 ok/);
  `;
  await writeFile(join(fixture, "consumer.mjs"), consumer);
  await run(["consumer.mjs"]);
  assert(requests.length >= 3);
  assert(requests.every((request) => request.method === "HEAD" && request.header === "package"));

  // TypeScript resolve o pacote instalado, sem depender de bun-types.
  await writeFile(join(fixture, "consumer.mts"), `
    import { diagnose, analyze, measure, render, normalizeUrl } from 'whyslow';
    import type { DiagnoseOptions, Diagnosis, Analysis, Sample, ProbeOptions, Finding } from 'whyslow';
    const options: DiagnoseOptions = { samples: 3, timeoutMs: 1000 };
    const result: Diagnosis = await diagnose(${JSON.stringify(url)}, options);
    const analysis: Analysis = analyze(result.finalUrl, result.samples);
    const sample: Sample | undefined = result.samples[0];
    const finding: Finding | undefined = analysis.findings[0];
    const probe: ProbeOptions = { timeoutMs: 1000, method: 'GET', headers: {}, maxRedirects: 5, keepAlive: true, insecure: false };
    void [sample, finding, render(analysis), measure, probe, normalizeUrl('example.com')];
    // @ts-expect-error samples aceita somente número
    void diagnose('https://example.com', { samples: '3' });
  `);
  await writeFile(join(fixture, "tsconfig.json"), JSON.stringify({
    compilerOptions: {
      strict: true, noEmit: true, target: "ES2022", module: "NodeNext",
      moduleResolution: "NodeNext", types: ["node"],
      typeRoots: [join(root, "node_modules", "@types")],
    },
    files: ["consumer.mts"],
  }));
  await run([join(root, "node_modules", "typescript", "bin", "tsc"), "-p", "tsconfig.json"]);

  const cli = join(fixture, "node_modules", "whyslow", "dist", "cli.js");
  assert.match((await run([cli, "--help"])).stdout, /whyslow/);
  const cliResult = await run([cli, url, "-n", "2", "--json"]);
  assert.equal(JSON.parse(cliResult.stdout).analysis.ok, 2);
  assert.equal(cliResult.stderr, "");
  await assert.rejects(run([cli, url, "--samples", "Infinity"]), (error) => error.code === 3);

  // npm exec usa o bin registrado pelo pacote, incluindo o shim do Windows.
  assert.match((await npm(["exec", "--offline", "--", "whyslow", "--help"], fixture)).stdout, /whyslow/);
  const installed = JSON.parse(await readFile(join(dirname(cli), "..", "package.json"), "utf8"));
  console.log(`Pacote ${installed.name}@${installed.version}: import, HTTP, tipos, CLI e npm exec OK.`);
} finally {
  if (server) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
  // fixture vem de mkdtemp dentro do diretório temporário e pertence a este processo.
  assert.equal(dirname(fixture), resolve(tmpdir()));
  await rm(fixture, { recursive: true, force: true });
}
