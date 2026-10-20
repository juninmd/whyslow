import { describe, expect, test } from "bun:test";
import http from "node:http";
import net from "node:net";
import { diagnose, analyze, normalizeUrl, render } from "../src/index.ts";
import { connectionTiming } from "../src/probe.ts";

describe("biblioteca", () => {
  test("mede HTTP real, preserva redirects e permite reanalisar", async () => {
    const server = http.createServer((req, res) => {
      if (req.url === "/a" || req.url === "/b") {
        res.writeHead(302, { location: req.url === "/a" ? "/b" : "/final" });
        res.end();
      } else {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ method: req.method, header: req.headers["x-test"] }));
      }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const { port } = server.address() as net.AddressInfo;
      const result = await diagnose(`http://127.0.0.1:${port}/a`, {
        samples: 3, headers: { "x-test": "library" },
      });
      expect(result.finalUrl).toBe(`http://127.0.0.1:${port}/final`);
      expect(result.samples).toHaveLength(3);
      expect(result.analysis.ok).toBe(3);
      expect(result.analysis.findings.find((f) => f.id === "redirects")?.severity).toBe("warn");
      expect(analyze(result.finalUrl, result.samples)).toEqual(result.analysis);
      expect(render(result.analysis)).toContain("3/3 ok");
      const defaults = await diagnose(`http://127.0.0.1:${port}/final`);
      expect(defaults.samples).toHaveLength(5);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  test("opções inválidas são rejeitadas antes de acessar a rede", async () => {
    for (const samples of [0, -1, 1.5, NaN, Infinity]) {
      await expect(diagnose("http://127.0.0.1", { samples })).rejects.toThrow("samples");
    }
    for (const timeoutMs of [0, -1, Infinity, 2_147_483_648]) {
      await expect(diagnose("http://127.0.0.1", { timeoutMs })).rejects.toThrow("timeoutMs");
    }
    await expect(diagnose("http://127.0.0.1", { maxRedirects: -1 })).rejects.toThrow("maxRedirects");
    expect(() => normalizeUrl("ftp://example.com")).toThrow("http ou https");
  });

  test("remove todos os headers personalizados após redirect entre origens", async () => {
    const received: http.IncomingHttpHeaders[] = [];
    const destination = http.createServer((req, res) => {
      received.push(req.headers);
      res.end("ok");
    });
    await new Promise<void>((resolve) => destination.listen(0, "127.0.0.1", resolve));
    const destinationPort = (destination.address() as net.AddressInfo).port;
    const source = http.createServer((req, res) => {
      expect(req.headers.authorization).toBe("Bearer synthetic");
      res.writeHead(302, { location: `http://127.0.0.1:${destinationPort}/final` });
      res.end();
    });
    await new Promise<void>((resolve) => source.listen(0, "127.0.0.1", resolve));
    try {
      const { port } = source.address() as net.AddressInfo;
      const result = await diagnose(`http://127.0.0.1:${port}`, {
        samples: 2,
        headers: { authorization: "Bearer synthetic", cookie: "session=synthetic", "x-api-key": "synthetic" },
      });
      expect(result.analysis.ok).toBe(2);
      expect(received.length).toBeGreaterThanOrEqual(2);
      for (const headers of received) {
        expect(headers.authorization).toBeUndefined();
        expect(headers.cookie).toBeUndefined();
        expect(headers["x-api-key"]).toBeUndefined();
      }
    } finally {
      for (const server of [source, destination]) {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    }
  });

  test("handshake TLS parado termina com timeout, inclusive com IP como alvo", async () => {
    const sockets = new Set<net.Socket>();
    const server = net.createServer((socket) => {
      sockets.add(socket);
      socket.on("error", () => {});
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const { port } = server.address() as net.AddressInfo;
      const result = await connectionTiming(`https://127.0.0.1:${port}`, {
        timeoutMs: 50, method: "GET", headers: {}, maxRedirects: 0,
        keepAlive: true, insecure: true,
      });
      expect(result.error).toContain("TLS: timeout");
    } finally {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 2000);
});
