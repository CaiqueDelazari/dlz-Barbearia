# Migração da barbearia: Supabase para PostgreSQL na VPS Hostinger

## Situação atual

- Projeto Supabase: `dlz-restaurantes`.
- Schema da barbearia: `barbearia`.
- O mesmo projeto Supabase hospeda outros sistemas em schemas diferentes.
- A aplicação usa `DB_SCHEMA=barbearia`.
- **Não desligar o Supabase antes da validação final.**

## Estratégia segura

Migrar somente o schema `barbearia`, mantendo o Supabase intacto durante a transição. A aplicação será testada contra o PostgreSQL local da VPS. O corte final só acontece após backup, restauração validada e teste funcional.

## Fase 1 — inventário e backup

Na máquina com acesso ao banco de origem, usar a conexão direta do PostgreSQL (porta 5432), nunca a conexão pooler 6543 para o dump:

```bash
mkdir -p backup-barbearia
pg_dump "$SOURCE_DATABASE_URL" \
  --schema=barbearia \
  --format=custom \
  --file=backup-barbearia/barbearia-$(date +%F-%H%M).dump
```

Conferir o arquivo e guardar uma cópia fora da VPS. Não imprimir a URL, senha ou conteúdo do dump em chats/logs.

Antes de copiar, registrar contagens das tabelas principais:

```sql
SELECT 'tenants' AS tabela, count(*) FROM barbearia.tenants
UNION ALL SELECT 'users', count(*) FROM barbearia.users
UNION ALL SELECT 'clients', count(*) FROM barbearia.clients
UNION ALL SELECT 'appointments', count(*) FROM barbearia.appointments
UNION ALL SELECT 'payments', count(*) FROM barbearia.payments;
```

## Fase 2 — PostgreSQL na VPS

Usar um container PostgreSQL dedicado, com volume persistente. Não usar `docker compose down` nos projetos existentes.

```bash
sudo mkdir -p /opt/postgres-barbearia/data
sudo chown -R 999:999 /opt/postgres-barbearia/data
```

Criar `/opt/postgres-barbearia/docker-compose.yml` com senha forte fornecida somente na sessão segura:

```yaml
services:
  postgres:
    image: postgres:16
    restart: unless-stopped
    environment:
      POSTGRES_DB: agenda
      POSTGRES_USER: postgres
      POSTGRES_PASSWORD: COLOCAR_SEGURO
    volumes:
      - ./data:/var/lib/postgresql/data
    ports:
      - "127.0.0.1:55432:5432"
```

Subir e verificar:

```bash
cd /opt/postgres-barbearia
docker compose up -d
docker compose ps
```

Criar o schema e usuário de aplicação:

```bash
docker exec -i postgres-barbearia-postgres-1 psql -U postgres -d agenda <<'SQL'
CREATE SCHEMA IF NOT EXISTS barbearia;
CREATE USER barbearia_app WITH PASSWORD 'COLOCAR_SEGURO';
GRANT USAGE ON SCHEMA barbearia TO barbearia_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA barbearia TO barbearia_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA barbearia TO barbearia_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA barbearia GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO barbearia_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA barbearia GRANT USAGE, SELECT ON SEQUENCES TO barbearia_app;
SQL
```

## Fase 3 — restauração

Restaurar o dump no PostgreSQL da VPS. Se o dump exigir extensões, instalar primeiro e registrar qualquer erro:

```bash
pg_restore \
  --clean --if-exists \
  --no-owner --no-privileges \
  --dbname="postgresql://postgres:SENHA@127.0.0.1:55432/agenda" \
  backup-barbearia/ARQUIVO.dump
```

Reaplicar permissões ao final e conferir as contagens. Não usar `--clean` em banco que contenha dados não pertencentes à cópia sem confirmar o alvo.

## Fase 4 — apontar uma cópia da aplicação

Alterar somente o `.env` da barbearia em uma release de teste:

```env
DATABASE_URL=postgresql://barbearia_app:SENHA@host.docker.internal:55432/agenda
DB_SCHEMA=barbearia
DATABASE_SSL=false
```

Se a aplicação estiver em container, usar uma rede/endpoint compatível com a topologia existente. Testar em container candidato antes de substituir `dlz-barbearia-app-1`.

## Fase 5 — validação obrigatória

- login de administrador;
- listagem da agenda;
- criação e cancelamento de um agendamento de teste;
- link `/agendamento/<token>` com botão Cancelar;
- remarcação;
- clientes e serviços;
- pagamentos/webhooks, sem cobrar dinheiro real;
- worker de notificações;
- isolamento do schema `barbearia`;
- contagens iguais às do backup.

## Fase 6 — corte e rollback

Somente com tudo validado:

1. fazer backup final do Supabase;
2. pausar novas reservas por poucos minutos, se necessário;
3. apontar o `.env` oficial para o PostgreSQL da VPS;
4. reiniciar somente o serviço da barbearia;
5. testar o site público e o painel;
6. manter o Supabase ligado por alguns dias como referência/contingência.

Se houver erro, restaurar o `DATABASE_URL` anterior e reiniciar apenas o app. Só cancelar o Supabase depois de confirmar que nenhum outro restaurante usa o projeto e que os backups foram testados.
