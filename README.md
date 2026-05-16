# Robocote 2.0 — Spike Oficial Segfy Nova Jornada

[![Build & Push GHCR](https://github.com/Jeraxp/robocote20/actions/workflows/build.yml/badge.svg)](https://github.com/Jeraxp/robocote20/actions/workflows/build.yml)

Spike determinístico de exploração da **Segfy Nova Jornada** (`api.automation.segfy.com`), que passa a ser o contrato canônico do Robocote 2.0.

O Robocote antigo usava integrações legadas (`multicalculo.segfy.com` e V2). Esse material serve só como referência de negócio/UX. A casa nova será construída do zero sobre Swagger oficial, credenciais novas e socket.io oficial.

## Stack

- Node 20+ com TypeScript (módulos ES, `tsx` direto)
- Hono como servidor HTTP minimalista
- `socket.io-client` para resultados assíncronos de cotação
- React + Vite para o Quote Room e o Webchat F1 com IA assistida
- Sem DB/fila no spike; logs sanitizados em `logs/*.json`

## Como rodar

```bash
npm install
cp .env.example .env
# Preencher quando a Segfy fornecer:
# SEGFY_CLIENT_ID, SEGFY_CLIENT_SECRET, RPI_CORRETORA_TOKEN
# Opcional para IA real:
# TASKDUN_AI_BASE_URL, TASKDUN_AI_API_KEY, TASKDUN_AI_MODEL
npm run dev
```

Acessos locais:

- Bancada técnica: `http://localhost:3030/public/index.html`
- Webchat F1: `http://localhost:3030/webchat`
- Quote Room: `http://localhost:3030/quote-room`
- Painel operacional: `http://localhost:3030/painel`

Para trabalhar no front com hot reload:

```bash
npm run dev:api
npm run dev:web
```

## Endpoints internos

| Endpoint | Função |
|---|---|
| `GET /health` | Status + flags de credenciais configuradas |
| `GET /api/jornadas/auto/f1` | Contrato determinístico da jornada Auto F1 |
| `POST /api/assistente/auto/f1/mensagem` | IA Taskdun interpreta mensagem livre e propõe estado da jornada |
| `POST /api/assistente/rag/search` | Busca semântica na base RAG curada, sem aceitar CPF/CNPJ/telefone na consulta |
| `POST /api/jornadas/auto/f1/cotacao?timeoutMs=45000` | Webchat F1 -> socket.io -> `calculate` -> `show-results` -> DTO seguro |
| `GET /api/cotacoes/:guid/resumo` | DTO seguro para o Robocote Quote Room |
| `GET /api/painel/leads` | Leads, etapas comerciais, conversas e dados coletados com mascaramento de PII |
| `POST /api/painel/leads/manual` | Cadastra lead manual captado pelo corretor/indicação e coloca no Kanban |
| `PATCH /api/painel/leads/:id/stage` | Move lead entre colunas do Kanban operacional |
| `GET /test/auth?refresh=1` | Valida BasicAuth -> Bearer sem devolver o token |
| `GET /test/marcas/:tipo` | `brand-list` oficial, filtrado para carro\|moto\|caminhao |
| `GET /test/modelos?brand_id&model_year&vehicle_type=car` | `model-list` oficial com UUID de marca da NJ |
| `GET /test/profissoes` | `profession-list` oficial |
| `GET /test/renovacao` | `renewal-list` oficial |
| `POST /test/calcular` | Dispara `calculate` sem listener (usar com cuidado) |
| `POST /test/cotacao?timeoutMs=30000` | Abre socket.io -> aguarda conexão -> dispara `calculate` -> coleta eventos |
| `GET /test/resultado/:guid` | Fallback interno que chama `POST show-results` oficial |
| `GET /test/listen/:roomId?timeoutMs=15000` | Escuta um room sem disparar cotação |
| `GET /test/diagnostico/token-transport?run=1` | Diagnostica formato do token da corretora sem cotação real |
| `GET /test/placa/:placa` | Stub: decode por placa não é premissa no Vehicle NJ |
| `GET /test/condutor/:cpf` | Stub: lookup CPF existe em Residence, não em Vehicle NJ |

## Segurança

- Logs passam por redaction centralizada antes de gravar.
- Bearer, token da corretora, CPF/CNPJ/documento, placa, chassi, nome, email e telefone não devem aparecer em texto cru.
- `GET /test/auth` informa apenas tamanho do Bearer e flags de refresh; nunca retorna prefixo do token.
- A base RAG inicial deve indexar somente conhecimento curado e sanitizado; conversas, respostas de usuário, cotações cruas, payloads, tokens e logs com PII ficam fora.

## IA e RAG

Cada turno passa por duas chamadas em sequência:

1. **Roteador/Extractor** (`ROBOCOTE_EXTRACTOR_MODEL`, mini): classifica `mode` (capture vs consult) e `action`. Em modo Captura, extrai o slot. Em modo Consulta, só sinaliza a pergunta. Saída JSON estruturada, sem voz.
2. **Reply** (`ROBOCOTE_DIALOG_MODEL` ou `ROBOCOTE_ANALYST_MODEL`): gera a fala da Vivi como corretora digital. O dialog (gpt-5.3-chat) cobre turnos rotineiros; o analyst (gpt-5.4) entra em modo Consulta, etapa de perfil/cobertura, ask_clarification e mensagens complexas (franquia, cobertura, comparação, sinistro, etc).

O Personality Core da Vivi vive em [`persona/vivi.md`](persona/vivi.md) e é injetado no system prompt do reply em runtime via `src/assistant/persona.ts`. Editar o `.md` muda o comportamento sem alterar código.

- `ROBOCOTE_EMBEDDING_MODEL`: padrão `text-embedding-3-large`, escolhido para priorizar qualidade semântica na base de conhecimento.
- `ROBOCOTE_VECTOR_STORE_ID`: id da Vector Store OpenAI quando a base RAG curada estiver criada (RAG ainda não integrado ao reply — próxima rodada).

Fontes candidatas encontradas no servidor Robocote para a primeira base:

- Fluxos e perguntas: `fluxos`, `fluxos_categorias`, `fluxos_interacao`, `tipos_interacoes`, `tipos_respostas`.
- Configurações públicas/revisadas de chatbots e corretores: usar apenas textos, contatos e regras aprovados.
- Normalizadores de produtos/coberturas do legado: úteis como glossário de negócio, nunca como contrato técnico final.
- Listas e mapeamentos de seguradoras, coberturas, franquias, assistências e tipos de resposta.

Metadados mínimos por documento RAG:

- `source_type`, `product`, `visibility`, `origin`, `contains_pii=false`, `updated_at`.

## Estrutura

```
persona/
└── vivi.md                  ← Personality Core canônico (fonte única)
src/
├── assistant/
│   ├── autoF1.ts            ← router + reply + intent (capture vs consult)
│   ├── persona.ts           ← loader do Personality Core
│   └── rag.ts               ← vector store search (não plugado no reply ainda)
├── index.ts
├── journey/autoF1.ts
├── quote/summary.ts
├── routes/api.ts
├── routes/test.ts
├── segfy/
│   ├── auth.ts
│   ├── client.ts
│   ├── diagnostico.ts
│   ├── marcas.ts
│   ├── modelos.ts
│   ├── profissoes.ts
│   ├── renovacao.ts
│   ├── placa.ts
│   ├── condutor.ts
│   ├── calcular.ts
│   ├── resultado.ts
│   └── socket.ts
└── utils/
    ├── logger.ts
    └── redact.ts
frontend/
└── src/
    ├── App.tsx
    ├── DeterministicChat.tsx
    ├── chatFlow.ts
    ├── main.tsx
    ├── styles.css
    └── types.ts
```

## Estado atual (2026-05-14)

- Credenciais base (`client_id`/`secret`) validadas em 2026-05-13: `/auths/token` retorna Bearer com `expires_in=86400`.
- Token da corretora testado em 2026-05-13: catálogo/apoio aceitam envelope `POST { config: { token }, data: ... }`.
- Para `model-list`, use `brand_id` UUID retornado por `brand-list`, `vehicle_type` (`car`, `motorcycle`, `truck`) e `model_year`.
- `calculate` com payload controlado validado em 2026-05-13: API retornou `status=OK`, GUID e eventos via socket.
- O socket real publica eventos com `action`: `STEP`, `RESULT`, `PDF`; no teste controlado vieram 62 eventos, incluindo 9 resultados e 9 PDFs.
- `show-results` oficial recuperou os 9 resultados pelo GUID da cotação.
- `GET /api/cotacoes/:guid/resumo` normaliza o retorno em DTO seguro sem CPF, placa, chassi, tokens, PDF cru ou payload bruto da Segfy.
- O Quote Room React consome esse DTO e apresenta ranking, recomendação consultiva, comparativo e produtos adicionais.
- O Webchat F1 agora expõe somente a conversa com IA: a Vivi interpreta as respostas, a jornada segura valida o estado e a cotação oficial continua sendo a entrega final.
- O Webchat F1 não usa mais veículo fixo de teste; a cotação real exige marca, ano e modelo selecionado no catálogo com FIPE.
- A IA usa a API Taskdun quando `TASKDUN_AI_BASE_URL` + `TASKDUN_AI_API_KEY` estiverem configurados; sem credencial, o endpoint cai em regras locais para manter o fluxo testável.
- A IA nunca substitui o contrato: ela só propõe `answer_step` ou `calculate`; o frontend ainda passa por `validateStepValue`, catálogo oficial e cálculo Segfy.
- A rota `POST /api/jornadas/auto/f1/cotacao` abre socket.io antes do `calculate`, envia o callback, aguarda resultados, chama `show-results` e devolve o DTO seguro para o front.
- Teste end-to-end em 2026-05-14: `calculate=OK`, GUID novo, 53 eventos de socket, 9 resultados, 5 opções principais e 4 seguradoras.
- A mensagem para WhatsApp já é gerada a partir do estado da jornada e pode ser copiada pela interface.
- Próximo passo real: evoluir a conversa consultiva da Vivi e depois plugar a Evolution API/WhatsApp sem perder a jornada segura nem o Quote Room.

## Estado atual (2026-05-15) — Personality Core da Vivi

- Personality Core da Vivi forjado em [persona/vivi.md](persona/vivi.md) e injetado no reply em runtime via `src/assistant/persona.ts` (cache em memória).
- Refactor de `src/assistant/autoF1.ts` em três frentes amarradas:
  - **Roteador de intenção** decide `mode: 'capture' | 'consult'` por turno; em consulta a Vivi responde sem avançar a etapa e oferece retomar.
  - **Stack invertida** conforme indicação do Visão: dialog default `gpt-5.3-chat-latest`, analyst `gpt-5.4`, extractor segue mini.
  - **Channel-aware**: request aceita `channel: 'webchat' | 'whatsapp'`; limites de comprimento (420/280) entram no system prompt e em truncate de segurança.
- `mustStayLocal` foi reduzido: catálogo (marca/ano/modelo) e CPF seguem em regras locais; demais etapas vão à IA para que a Vivi possa conversar de verdade.
- Frontend (`DeterministicChat.tsx`) atualizado para tipar `mode`, `channel`, `consult_reply` e envia `channel: 'webchat'` explícito. Comportamento visual inalterado — `consult_reply` cai no fallback de mostrar a reply na mesma etapa, sem quebrar o roteiro.
- Cotação Segfy (calculate + socket.io + show-results + Quote Room) **intocada**. Toda mudança vive na camada conversacional.
- RAG curado ainda não plugado no reply — placeholder com regra pétrea no Personality Core: "nunca invente preço/cobertura/franquia". RAG é o próximo passo natural.

## Estado atual (2026-05-16) — Painel operacional

- `SessionStore` agora registra etapa comercial, mensagens inbound/outbound e dados estruturados por lead.
- O orquestrador WhatsApp grava interações sanitizadas a cada turno e move leads automaticamente para `Contatados` e `Em Negociação` quando a cotação é entregue.
- `/painel` abre um Kanban simples com 6 colunas: Novos Leads, Contatados, Em Negociação, Sem Retorno, Vendas e Perdido.
- Clique no card abre um modal sobre a tela, no estilo Trello, com conversa, ficha do lead, dados coletados e link do Quote Room quando existir.
- O botão "Adicionar novo lead" permite cadastro manual de indicação/prospecção com nome, WhatsApp, origem, veículo informado e observações.
- O painel consome somente DTO sanitizado: CPF, telefone, CEP e documentos saem mascarados.
- Persistência segue in-memory no spike; em produção, esta interface deve migrar para Postgres mantendo o contrato de `SessionStore`.

## Testes locais

```bash
npm run typecheck
npm run build
```

Sem credenciais novas, validar apenas `/health`, stubs e diagnóstico dry-run.

---

*Forjado para a casa nova do Robocote 2.0 — Nova Jornada oficial primeiro.*
