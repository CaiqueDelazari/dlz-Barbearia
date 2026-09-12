# Contexto atual — migração e cancelamento

## Objetivo do proprietário

1. Corrigir/garantir que o cliente consiga desmarcar o próprio agendamento.
2. Migrar o banco da barbearia do Supabase para PostgreSQL dentro da VPS Hostinger KVM 4.
3. Só desligar o Supabase depois de backup, migração validada e rollback disponível.

## Projeto

- Pasta local: `C:\Users\caiqu\OneDrive\Área de Trabalho\barbearia`
- App: Next.js 15, SaaS multi-tenant de agendamento.
- Produção: `https://dlzbarbearia.com.br`
- Loja usada no teste: slug `riady`.
- Código de gerenciamento do cliente: `src/app/agendamento/[token]/ManageBooking.tsx`.
- Rota de cancelamento: `DELETE /api/v1/public/booking/<token>`.
- Configuração: `business_settings.allow_client_cancel`.
- Prazo mínimo padrão: `minimum_reschedule_notice_minutes = 120`.

## Cancelamento

O código já possui botão, rota, segurança por token e testes E2E. O botão aparece somente se `allow_client_cancel` estiver ativo e o agendamento estiver fora da janela mínima. Os testes locais passaram: 82 aprovados, 0 falhas, 5 ignorados.

Consulta para verificar:

```sql
SELECT t.slug, bs.allow_client_cancel, bs.minimum_reschedule_notice_minutes
FROM barbearia.tenants t
LEFT JOIN barbearia.business_settings bs ON bs.tenant_id = t.id
WHERE t.slug = 'riady';
```

Ativação somente para a loja autorizada:

```sql
UPDATE barbearia.business_settings
SET allow_client_cancel = true
WHERE tenant_id = (SELECT id FROM barbearia.tenants WHERE slug = 'riady');
```

## VPS

- Hostinger: `srv1920715.hstgr.cloud`
- IP: `187.127.62.147`
- Ubuntu 24.04, KVM 4, 4 vCPU, 16 GB RAM, 200 GB disco.
- Acesso comprovado pelo Web Console como `root`.
- O link direto `https://cam.hostingervps.com/3583/` retorna 403 para automação; o usuário consegue abrir o terminal no próprio navegador.
- Caminho de produção: `/opt/dlz-barbearia`.
- App: container `dlz-barbearia-app-1`.
- Banco local: container `dlz-barbearia-db-1`, imagem `postgres:16-alpine`, status healthy.
- O volume do banco é `postgres_data`; não remover.
- O Compose tem serviços `db` e `app`; não usar `docker compose down`.

## Último diagnóstico executado no VPS

```text
dlz-barbearia-app-1   dlz-barbearia-app   Up
dlz-barbearia-db-1    postgres:16-alpine  Up (healthy)
```

Ao consultar com `psql -U postgres`, ocorreu `role "postgres" does not exist`. Precisamos descobrir o usuário configurado no container sem expor valores:

```bash
docker inspect dlz-barbearia-db-1 --format '{{range .Config.Env}}{{println .}}{{end}}' | sed -E 's/=.*$/=***REDACTED***/'
```

## Arquivos importantes

- `DEPLOY-CLAUDE.md`: estado e deploy da produção.
- `MIGRACAO_SUPABASE_PARA_HOSTINGER.md`: roteiro da migração.
- `docker-compose.yml`: topologia real da VPS.
- `.env.producao.exemplo`: nomes das variáveis, sem segredos.
- `database/migrations/`: migrations do schema `barbearia`.

## Regras de segurança

- Nunca colar `.env`, senhas, tokens ou `DATABASE_URL` em chat/Git.
- Fazer backup antes de alteração.
- Não desligar Supabase antes de validar a cópia.
- Não reiniciar a VPS inteira; atualizar somente o serviço necessário.
- Não rodar `db:reset`, seed ou migration destrutiva em produção.

## Estado atualizado da migração — 15:21

- Migração concluída e em produção.
- O app usa o PostgreSQL local da VPS, banco `agenda_migrated_v2`.
- Foram importadas 2 lojas e 2 configurações do Supabase.
- Cancelamento ativado para `riady`, com prazo mínimo de 60 minutos.
- Aplicação recriada sem reiniciar a VPS nem o banco.
- `https://dlzbarbearia.com.br` respondeu HTTP 200.
- Backups preservados em `/opt/dlz-barbearia/backups/`.
- Supabase permanece intacto e ainda não foi desligado.
- O banco antigo `agenda` foi uma tentativa intermediária e não é usado pelo app.
