# Deploy Robocote 2.0 — Swarm Hetzner

Guia pra subir o spike como serviço Docker Swarm no mesmo cluster que hospeda Traefik, Evolution, n8n e Chatwoot.

## Estado inicial (2026-05-15)

- Imagem **ainda não publicada** em registry. Você (ou um runner) precisa fazer build local e push.
- Subdomínio sugerido: `rcdemo.robocote.com.br`. Trocar via variável `ROBOCOTE_HOST` no Portainer.
- DNS provider: HostGator (não Cloudflare). Subdomínio precisa ser criado lá.

## Passo a passo

### 1. Criar A record no HostGator

No painel HostGator → Zona DNS do `robocote.com.br`:

```
Tipo:  A
Nome:  rcdemo
Valor: 5.161.253.111
TTL:   3600 (1h)
```

Propagação leva ~10min em média. Confere com `nslookup rcdemo.robocote.com.br`.

### 2. Build da imagem + push pra registry

A imagem precisa estar acessível pelo swarm. Três caminhos:

**Opção A — Docker Hub (mais simples se tiver conta):**

```powershell
# Na máquina local, dentro de robocote-2.0-spike/
docker build -t robocote/robocote-2:0.1.0 .
docker tag robocote/robocote-2:0.1.0 robocote/robocote-2:latest
docker login
docker push robocote/robocote-2:0.1.0
docker push robocote/robocote-2:latest
```

**Opção B — GitHub Container Registry (GHCR):**

```powershell
# Requer GitHub PAT com escopo write:packages
docker build -t ghcr.io/SEUUSUARIO/robocote-2:0.1.0 .
echo $env:GHCR_TOKEN | docker login ghcr.io -u SEUUSUARIO --password-stdin
docker push ghcr.io/SEUUSUARIO/robocote-2:0.1.0
```

E no `swarm-stack.yml`, definir `ROBOCOTE_IMAGE=ghcr.io/SEUUSUARIO/robocote-2:0.1.0` nas variáveis do Portainer.

**Opção C — Registry self-hosted no swarm (overkill pro MVP):**

Pular por enquanto. Se virar necessidade recorrente, subimos um `registry:2` no próprio swarm.

### 3. Variáveis de ambiente

No Portainer → Stacks → Add stack → Web editor:
- Cola o conteúdo de `swarm-stack.yml`.
- Embaixo do editor, em **Environment variables** (não inline no compose por questão de segurança), preencher:

| Variável | Valor recomendado |
|---|---|
| `ROBOCOTE_IMAGE` | `robocote/robocote-2:0.1.0` (ou GHCR) |
| `ROBOCOTE_HOST` | `rcdemo.robocote.com.br` |
| `ROBOCOTE_QUOTE_BASE_URL` | `https://rcdemo.robocote.com.br` |
| `DATABASE_URL` | Postgres do Robocote 2.0 com `db/schema.sql` aplicado |
| `DATABASE_SSL` | `0` no swarm interno; `1` em banco gerenciado com SSL |
| `ROBOCOTE_PANEL_TOKEN` | token forte para bloquear `/painel` e APIs admin |
| `ROBOCOTE_TENANT_ID` | `rpi` |
| `ROBOCOTE_TENANT_SLUG` | `rpi` |
| `ROBOCOTE_TENANT_NAME` | nome da corretora-piloto |
| `SEGFY_CLIENT_ID` | (do `.robocote/secrets.env`) |
| `SEGFY_CLIENT_SECRET` | (do `.robocote/secrets.env`) |
| `RPI_CORRETORA_TOKEN` | (do `.robocote/secrets.env`) |
| `TASKDUN_AI_BASE_URL` | URL da API Taskdun |
| `TASKDUN_AI_API_KEY` | chave Taskdun |
| `EVOLUTION_BASE_URL` | `https://rcevoapi.robocote.com.br` |
| `EVOLUTION_API_KEY` | extraída do container Evolution (AUTHENTICATION_API_KEY) |
| `EVOLUTION_INSTANCE` | `Robocote2` |
| `EVOLUTION_WEBHOOK_SECRET` | string aleatória ≥32 chars (gerar com `openssl rand -hex 32`) |
| `ROBOCOTE_DEBUG_ROUTER` | `0` em produção, `1` enquanto valida |

Sem `DATABASE_URL`, o painel sobe em modo memória: bom para smoke test, ruim para produção porque tenants, usuários e sessões somem ao reiniciar. Sem `ROBOCOTE_PANEL_TOKEN`, o alpha continua aberto para facilitar desenvolvimento local; em URL pública ele deve ficar preenchido.

### 4. Deploy

Portainer → **Deploy the stack**. Acompanha o log do serviço `robocote-2_robocote-2.1` pra confirmar:

- `🔥 robocote-2.0-spike — fornalha acesa` no stdout = startup ok
- Healthcheck `/health` retorna 200 = pronto pra tráfego
- Traefik faz roteamento automático (Let's Encrypt provisiona cert na primeira request HTTPS — pode levar 10-30s)

### 5. Configurar webhook da Robocote2

Após o stack estar **healthy** e o DNS resolvendo, registrar webhook na instância Evolution:

```bash
curl -X POST 'https://rcevoapi.robocote.com.br/webhook/set/Robocote2' \
  -H 'apikey: <EVOLUTION_API_KEY>' \
  -H 'Content-Type: application/json' \
  -d '{
    "url": "https://rcdemo.robocote.com.br/webhooks/evolution/incoming",
    "enabled": true,
    "webhookByEvents": false,
    "events": ["MESSAGES_UPSERT"],
    "headers": { "x-webhook-secret": "<EVOLUTION_WEBHOOK_SECRET>" }
  }'
```

(TAILA pode fazer isso via API quando o deploy estiver de pé.)

### 6. Teste end-to-end

1. Conferir `https://rcdemo.robocote.com.br/health` → JSON com `evolution_configured: true`.
2. Conferir `https://rcdemo.robocote.com.br/webchat` → carregar e cotar uma vez (sanity check do frontend).
3. Mandar mensagem do celular pessoal pro número `48996142524` → Vivi deve responder.
4. Completar fluxo → Vivi envia link `https://rcdemo.robocote.com.br/quote-room/<guid>`.

## Rollback

Se algo quebrar:

- Portainer → Stack → **Stop** desliga o serviço sem deletar volume nem network.
- Re-rodar com tag anterior (`ROBOCOTE_IMAGE=robocote/robocote-2:0.0.x`).
- A Robocote2 (instância Evolution) sobrevive — só fica sem webhook funcional até voltar o backend.

## Cuidados

- **Nunca commitar `.env` real** no repo. Variáveis sensíveis vivem no Portainer Stack Environment.
- **`ROBOCOTE_DEBUG_ROUTER=1`** loga decisões do extractor — útil enquanto valida, desliga em produção.
- **Resource limits** estão modestos (1 CPU, 768 MB RAM). Pra carga maior, aumentar `deploy.resources.limits`.
