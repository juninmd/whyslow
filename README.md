# 🐌 whyslow

"Está lento" não é diagnóstico. Esta CLI mede **DNS, TCP, TLS, TTFB e download separadamente**
e aponta qual fase é a culpada — com a ação correspondente.

```
  http://localhost:11434/api/tags
  3/3 ok · requisição p50 2ms / p95 3ms · abrir conexão +25ms · primeira chamada ~27ms

  resolução DNS                   9ms  33%  ███████████·····················
  conexão TCP                    16ms  59%  ███████████████████·············
  espera pelo servidor (TTFB)     2ms   7%  ██······························

  ▲ O host resolve para endereço que recusa conexão: ::1 (ECONNREFUSED)
     → Clássico do IPv6: o DNS devolve ::1/AAAA primeiro e o serviço só escuta em IPv4.
       Faça o serviço escutar em ambos, ou aponte o cliente para 127.0.0.1.
```

## Uso

```bash
bun install
bun run src/index.ts https://api.exemplo.com/health
bun run src/index.ts exemplo.com -n 10          # sem esquema, assume https
bun link && whyslow exemplo.com                  # instala como `whyslow`
```

| flag | efeito |
|---|---|
| `-n, --samples <n>` | amostras (padrão 5) |
| `-X, --method <verbo>` | método HTTP |
| `-H, --header 'K: V'` | cabeçalho extra (repetível) |
| `--timeout <ms>` | timeout por amostra (padrão 10000) |
| `--no-keepalive` | paga conexão nova a cada amostra |
| `--max-redirects <n>` | saltos seguidos (padrão 5) |
| `--insecure` | aceita certificado inválido |
| `--json` | análise + amostras cruas |

Exit: `0` saudável · `1` avisos · `2` crítico · `3` erro de uso. Serve para script.

## Os dois números que importam

O cabeçalho separa o que costuma vir misturado:

- **requisição p50/p95** — TTFB + download, com a conexão já aberta. É o que um cliente com
  keep-alive sente em regime.
- **abrir conexão** — DNS + TCP + TLS. É o pedágio da *primeira* requisição de cada cliente novo.

Somar os dois num número só esconde os dois. Um endpoint com 5ms de requisição e 300ms de
handshake não tem problema de aplicação — tem problema de pool de conexão.

## O que ele diagnostica

| id | dispara quando | o que entrega |
|---|---|---|
| `culprit-dns` | DNS domina | resolver, TTL, e no cluster: CoreDNS e `ndots` do `/etc/resolv.conf` |
| `culprit-tcp` | TCP domina | RTT/distância — nenhuma otimização de app resolve |
| `culprit-tls` | handshake domina | cadeia longa, sem session resumption, sem TLS 1.3 |
| `culprit-ttfb` | servidor demora | é a aplicação pensando: query lenta, cold start, trabalho síncrono |
| `culprit-download` | corpo domina | compressão e paginação rendem mais que servidor mais rápido |
| `address-fallback` | um endereço recusa antes de outro aceitar | o clássico `::1` antes do IPv4 |
| `keepalive-gain` | conexão custa > 20ms | quanto o pool de conexões economiza |
| `no-compression` | texto > 2KB sem `content-encoding` | gzip/brotli no servidor ou no ingress |
| `redirects` | há saltos antes da resposta | cada salto é uma volta completa |
| `unstable` | p95 > 3× p50 (e ≥ 200ms) | cauda longa: GC, cold start, réplica doente |
| `flaky` | parte das amostras falha | intermitência é pior que lentidão |
| `cert-expiring` | certificado < 21 dias | crítico abaixo de 7 |
| `unreachable` | nada completou | separa timeout com TCP (servidor pendurado) de sem TCP (rede/firewall) |

Uma fase dominante **só vira alarme se o total também for ruim**: 90% de TTFB em 40ms não é
sintoma de nada, e a ferramenta não grita por isso.

## Como as fases são medidas

O `http.request` do Node expõe as fases pelos eventos do socket (`lookup`, `connect`,
`secureConnect`) — **mas o Bun não emite esses eventos**, e lá o handshake aparece embutido no
TTFB. Por isso o whyslow mede a conexão em um socket próprio (`node:dns` + `node:net` +
`node:tls`) e o TTFB/download em uma requisição sobre conexão já aquecida. A decomposição
funciona igual nos dois runtimes, ao custo de a conexão medida não ser literalmente a mesma
que serviu a requisição.

O probe de conexão tenta **todos** os endereços que o DNS devolve, na ordem original, e reporta
os que recusaram — foi assim que o `address-fallback` apareceu.

## Testes

```bash
bun test          # 29 testes
bunx tsc --noEmit
```

A análise é pura (`analyze(url, samples) -> Analysis`): os testes descrevem cenários de latência
sem tocar a rede. Cobrem cada culpado, o piso que evita alarme em endpoint rápido, instabilidade,
compressão ausente, redirecionamento, certificado vencendo e o fallback de endereço.

## Limitações

- HTTP/1.1 e HTTP/2 via `node:http(s)`; não mede QUIC/HTTP3.
- Não segue `Retry-After` nem faz autenticação além do que você passar em `-H`.
- Um alvo por execução: é ferramenta de investigação, não monitor contínuo.
