# Deploy na VPS

A imagem é construída pelo GitHub Actions e publicada em
`ghcr.io/caiquedelazari/dlz-barbearia:latest`. A VPS **só baixa e sobe** — com
2 vCPUs, compilar Next.js aqui satura a máquina e deixa o Safra, que roda ao
lado, arrastado.

## Primeira vez

```bash
# 1. o código (só precisa do compose e deste diretório)
git clone https://github.com/CaiqueDelazari/dlz-Barbearia.git
cd dlz-Barbearia

# 2. o .env, que existe SÓ aqui
cp .env.producao.exemplo .env
$EDITOR .env            # senha do barbearia_app, JWT_SECRET, CRON_SECRET, bot

# 3. autenticar no registro (token com read:packages)
echo "$GHCR_TOKEN" | docker login ghcr.io -u CaiqueDelazari --password-stdin

# 4. subir
docker compose pull
docker compose up -d
docker compose logs -f app
```

Depois, adicione o bloco de `Caddyfile.exemplo` ao Caddy que já roda na
máquina e recarregue (`caddy reload` ou `systemctl reload caddy`).

## Atualizar

```bash
git pull                # se o compose mudou
docker compose pull
docker compose up -d
```

O Actions publica `:latest` a cada push na `main`, **depois** de `tsc --noEmit`
e da suíte de testes passarem. Build vermelho não vira imagem.

## Conferir que subiu de verdade

```bash
docker compose ps                       # app deve estar "healthy"
curl -sI http://127.0.0.1:3010/login    # 200
docker compose logs worker --tail 20    # uma linha a cada 5 min, sem "falhou"
```

O worker é a parte que mais silenciosamente quebra: sem ele a fila de
notificação apenas enche, o painel mostra tudo certo e o cliente não recebe
nada. Se aparecer `falhou` no log, o `CRON_SECRET` do `.env` provavelmente não
é o mesmo que o app subiu.

## Migrations

O banco **já está migrado** (7 migrations, aplicadas pelo MCP do Supabase). Para
as próximas, rode da sua máquina pela **conexão direta (5432)**, não pelo pooler
— DDL não combina com modo transaction:

```bash
DATABASE_URL='postgresql://...@db.levzbjfazivtgklbcphw.supabase.co:5432/postgres' \
DB_SCHEMA=barbearia npm run db:migrate
```

O `barbearia_app` tem privilégio de dado (SELECT/INSERT/UPDATE/DELETE), não de
DDL. Migration é operação de dono, e é bom que continue sendo.

## Pareamento do WhatsApp

Com o app no ar, entre no painel → WhatsApp → conectar, e leia o QR com o
celular da barbearia. A sessão nasce como `barb-<slug>`; o prefixo é o que a
impede de alcançar a sessão dos outros sistemas que dividem o mesmo bot.

Antes disso, confira em Configurações o **telefone de avisos**: se ele for o
mesmo número que você acabou de parear, o aviso de agendamento novo vai cair no
chat "Mensagem para si" do próprio dono, que é fácil de não ver.
