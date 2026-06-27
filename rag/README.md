# RAG — Base de Conhecimento da Robocote

Liga a Robocote para **explicar seguro** (coberturas, franquia, assistência) com base curada,
sem inventar — respeitando as regras pétreas da persona.

## Estrutura
- `knowledge/` — documentos curados (`.md`), um conceito por arquivo. Conteúdo **conceitual e educacional**, nunca regras/valores de seguradora específica.
- `ingest.mjs` — cria a Vector Store na OpenAI, sobe os arquivos e imprime o `ROBOCOTE_VECTOR_STORE_ID`.

## Como rodar (1ª vez e a cada atualização da base)
Da raiz do projeto (`robocote-2.0-spike`):

```bash
node rag/ingest.mjs
```

Ao final, copie o `ROBOCOTE_VECTOR_STORE_ID=vs_...` impresso para o `.env` (local) e para as
variáveis do stack no Portainer (produção). Reinicie o serviço. O `/health` passa a mostrar
`robocote_rag_configured: true`.

## Fluxo
1. `ingest.mjs` indexa a base na Vector Store hospedada da OpenAI.
2. `src/assistant/rag.ts` (`searchKnowledge`) consulta essa store em `/v1/vector_stores/{id}/search`.
3. (Próxima viga) o assistente consulta o RAG no **Modo Consulta** para responder dúvidas na conversa.

## Editar a base
Adicione/edite arquivos em `knowledge/` e rode `node rag/ingest.mjs` de novo. Cada execução cria
uma nova store — atualize o `ROBOCOTE_VECTOR_STORE_ID` com o novo id.
