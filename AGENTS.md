# AGENTS.md

CLI e biblioteca ESM que mede DNS, TCP, TLS, TTFB e download de um endpoint HTTP e aponta a fase lenta.

## Stack
- TypeScript (ESM), Node >= 22 para consumir; Bun 1.3.13 (`packageManager`) para desenvolver.
- Sem dependências de execução. Dev: `typescript`, `@types/bun`, `@types/node`.
- Código em `src/` (`cli`, `index`, `probe`, `analyze`, `render`, `types`); testes em `tests/`; `scripts/test-package.mjs` valida o tarball.

## Comandos
- Instalar: `bun install --frozen-lockfile`
- Testes: `bun test`
- Tipos: `bun run typecheck` (`tsc --noEmit`)
- Build: `npm run build` (gera `dist/`)
- Pacote: `npm run test:package` (empacota, instala e exercita o tarball)
- Rodar da fonte: `bun run start <url> -n 10`

## Gates de CI
- `validate.yml` (PR e `main`) e `security.yml` (`main`, semanal) chamam workflows reutilizáveis de `juninmd/base-actions`.
- `release.yml` roda Release Please e publica no npm via OIDC. Ele referencia `./.github/workflows/ci.yml`, que não existe no repo, e falha em 0s: pendência conhecida, fora do escopo de docs.

## O que não fazer
- Não editar `bun.lock` à mão nem `.release-please-manifest.json`; a versão vem de Conventional Commits.
- Não adicionar dependência de execução: a ausência delas é parte do contrato do pacote.
- Não imprimir nem commitar `.env` ou tokens; `NPM_PUBLISH_ENABLED` é variável do repositório, não segredo.
- A biblioteca não pode imprimir no terminal nem chamar `process.exit()`; isso fica só em `src/cli.ts`.
- Documentação e mensagens em pt-BR; código, identificadores e commits em inglês.

<!-- base-actions-main-policy -->
## GitHub Actions — padrão obrigatório (@main)

- Referencie as actions internas sempre pelo branch, nunca por SHA:
  - `uses: juninmd/base-actions/<action>@main`
  - `uses: juninmd/base-actions/.github/workflows/<arquivo>.yml@main`
- Não fixe `@<sha>` em `juninmd/base-actions`: a atualização é centralizada no
  `main` e passa a valer no próximo run.
- PRs cujos checks não iniciam por billing/spending limit são mesclados pelo bot central
  `juninmd/base-actions/.github/workflows/auto-merge-billing-blocked.yml`.
  Para impedir o merge automático de um PR, aplique a label `do-not-merge`.