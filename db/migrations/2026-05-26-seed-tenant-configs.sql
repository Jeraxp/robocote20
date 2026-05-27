-- Migration data: popula `tenant_configs` pra tenants existentes ANTES do refactor
-- de autoF1.ts subir em produção.
--
-- O refactor faz fail-fast quando não tem config carregada. Sem essa migration,
-- cotações E2E em produção quebram. Aplicar ANTES do force-update do swarm.
--
-- Os valores aqui são os defaults Robocote que estavam hardcoded em autoF1.ts
-- (commit pre-refactor). Cobertura compreensiva, FIPE 100%, franquia normal,
-- assistência 200km, vidros básicos, RCF 100k/100k, danos morais 10k.
-- Insurer único: Porto com comissão 10% (mesmo comportamento hoje).
--
-- Idempotente: usa `ON CONFLICT DO NOTHING` no insert; após populado, rerunning
-- não duplica linha. Pra rever defaults depois, edite no painel admin (UI virá em
-- iteração futura) ou rode UPDATE direto neste arquivo.

WITH new_config AS (
  INSERT INTO tenant_configs (tenant_id, config, config_hash, source, change_note)
  SELECT
    t.id,
    jsonb_build_object(
      'version', '2.0',
      'generated_at', now()::text,
      'plano', 'seguros',
      'ramos', jsonb_build_array('auto'),
      'seguradoras', jsonb_build_array('porto'),
      'comissoes', jsonb_build_object('auto', 10),
      'coberturas', jsonb_build_object(
        'auto', jsonb_build_object(
          'tipo_cobertura', 'comprehensive',
          'tabela_fipe', 100,
          'franquia', 'normal',
          'isencao_franquia', false,
          'vidros', 'glass_basic_referenced',
          'assistencia_24h', 'assistance_200_km_referenced',
          'carro_reserva', 'no_car',
          'tipo_carro_reserva', 'no_car',
          'reposicao_zero_km', 'no_replacement',
          'rcf_dm', 100000,
          'rcf_dc', 100000,
          'danos_morais', 10000,
          'app_morte', 10000,
          'desp_extras', 0
        )
      )
    ),
    'seed_defaults_2026_05_26',  -- config_hash sintético; idempotência via WHERE NOT EXISTS abaixo
    'migration',
    'Seed inicial de defaults Robocote (pré-refactor autoF1 → quoteConfig)'
  FROM tenants t
  WHERE NOT EXISTS (
    SELECT 1 FROM tenant_configs tc WHERE tc.tenant_id = t.id
  )
  RETURNING id, tenant_id
)
UPDATE tenants t
SET current_config_id = nc.id
FROM new_config nc
WHERE t.id = nc.tenant_id;

-- Validação rápida: lista o que foi populado.
SELECT
  t.id AS tenant_id,
  t.name AS tenant_name,
  t.current_config_id,
  tc.created_at AS config_created_at,
  tc.source
FROM tenants t
LEFT JOIN tenant_configs tc ON tc.id = t.current_config_id
ORDER BY t.id;
