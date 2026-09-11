#!/usr/bin/env node
/**
 * Cadastro da Riady Cortes -- o primeiro cliente de verdade (HANDOFF §7).
 *
 *   npm run db:seed:riady
 *
 * Diferente do `seed.mjs`, que cria um estúdio de demonstração, este script
 * grava os dados que o Riady respondeu no questionário de implantação. Roda uma
 * vez só: se o slug já existir, ele não faz nada.
 *
 * As mensagens automáticas NÃO são inseridas de propósito: quando a empresa não
 * tem linha em `notification_templates`, o envio cai no DEFAULT_TEMPLATES do
 * `notification.service.ts`. Duplicar o texto aqui só criaria duas cópias para
 * manter. Se ele quiser reescrever alguma, a tela de Mensagens grava a dele.
 *
 * A conta Ton/Stone usa o gateway Pagar.me. As credenciais ficam no ambiente da
 * VPS; este seed apenas liga o provider para a loja correta.
 */
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import bcrypt from 'bcryptjs';
import 'dotenv/config';

const { DATABASE_URL } = process.env;
if (!DATABASE_URL) {
  console.error('DATABASE_URL nao definida.');
  process.exit(1);
}

const SLUG = 'riady';

const SCHEMA = (process.env.DB_SCHEMA ?? process.env.SUPABASE_SCHEMA ?? 'public').trim();
if (!/^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(SCHEMA)) {
  console.error(`DB_SCHEMA invalido: ${JSON.stringify(SCHEMA)}`);
  process.exit(1);
}

/** Mesma regra do seed.mjs: senha sorteada e mostrada uma vez, nunca versionada. */
const PASSWORD = process.env.SEED_PASSWORD || randomBytes(9).toString('base64url');
const SENHA_SORTEADA = !process.env.SEED_PASSWORD;

// Este seed é o cadastro de um cliente real, então rodar com NODE_ENV=production
// é o esperado -- ao contrário do seed de demonstração, que se recusa.
const needsSsl =
  process.env.DATABASE_SSL !== 'false' &&
  /sslmode=require|neon\.tech|supabase|render\.com/.test(DATABASE_URL);

const client = new pg.Client({
  connectionString: DATABASE_URL,
  ssl: needsSsl ? { rejectUnauthorized: false } : undefined,
});

const NEGOCIO = {
  nome: 'Riady Cortes',
  telefone: '14991273691',
  instagram: '@RiadyCortes_Barbearia',
  // Falta cidade/UF/CEP: foi o que ele mandou.
  endereco: 'Rua João Ramos, 332 — Centenário Park',
};

const DONO = {
  nome: 'Riady Garcia Carvalho',
  email: 'riadygarcia01@gmail.com',
};

/**
 * Imagens da marca, servidas do proprio `public/` deste repositorio.
 *
 * Nao sao URL de fora: enquanto nao existe tela de upload, o arquivo do cliente
 * entra junto com o codigo. O `imageUrlSchema` aceita caminho local justamente
 * para o painel conseguir reeditar isto depois sem recusar o valor.
 *
 * A logo e PNG com fundo transparente, de proposito: o cabecalho do agendamento
 * e escuro, e a versao em foto da placa na parede clara abriria um retangulo
 * branco no meio dele.
 */
const IMAGENS = {
  logo: '/riady/logo.png',
  fotoDoRiady: '/riady/riady.jpg',
};

/**
 * Preço e duração como ele passou. A duração é o que monta o slot na agenda.
 *
 * `agendavel: false` são os serviços de química, que ele marca na mão depois de
 * conversar ("cliente entra em contato eu marco"). Entram como `active = false`:
 * ficam no catálogo com o preço mínimo registrado, mas não aparecem na página
 * pública. NÃO existe hoje uma coluna "só no balcão" -- é ativo ou não é.
 * A duração deles é um chute, porque ele não passou.
 */
const SERVICOS = [
  { nome: 'Corte', categoria: 'Barbearia', preco: 40, duracao: 30 },
  { nome: 'Barba', categoria: 'Barbearia', preco: 30, duracao: 20 },
  { nome: 'Barboterapia', categoria: 'Barbearia', preco: 40, duracao: 25 },
  { nome: 'Sobrancelha', categoria: 'Barbearia', preco: 15, duracao: 5 },
  { nome: 'Bigode', categoria: 'Barbearia', preco: 10, duracao: 5 },
  { nome: 'Cavanhaque', categoria: 'Barbearia', preco: 15, duracao: 10 },

  {
    nome: 'Selagem',
    categoria: 'Química',
    preco: 75,
    duracao: 90,
    agendavel: false,
    descricao: 'A partir de R$ 75. Valor e duração fechados no contato.',
  },
  {
    nome: 'Luzes',
    categoria: 'Química',
    preco: 100,
    duracao: 120,
    agendavel: false,
    descricao: 'A partir de R$ 100. Valor e duração fechados no contato.',
  },
  {
    nome: 'Platinado',
    categoria: 'Química',
    preco: 130,
    duracao: 150,
    agendavel: false,
    descricao: 'A partir de R$ 130. Valor e duração fechados no contato.',
  },
];

/**
 * Pomada Fox, quatro aromas, R$ 25 cada.
 *
 * `track_stock: false` porque ele não passou custo nem quantidade. Com controle
 * ligado e estoque zero, a venda seria recusada por "sem estoque"
 * (`sale.service.ts`). Sem controle, a venda passa e o estoque não é contado --
 * que é o certo até ele dar os números.
 */
const PRODUTOS = [
  { nome: 'Pomada Caramelo', marca: 'Fox', categoria: 'Pomada', venda: 25 },
  { nome: 'Pomada Uva', marca: 'Fox', categoria: 'Pomada', venda: 25 },
  { nome: 'Pomada Laranja', marca: 'Fox', categoria: 'Pomada', venda: 25 },
  { nome: 'Pomada Natural', marca: 'Fox', categoria: 'Pomada', venda: 25 },
];

/**
 * Horário derivado da grade de horários que ele mandou (a imagem com os slots
 * de cada dia). A tabela guarda uma abertura e um fechamento por dia; os vãos
 * do meio viram `business_breaks`.
 *
 * O fechamento é o último slot + 30 min: o último horário que ele oferece na
 * segunda é 16h, então a agenda vai até 16:30.
 *
 * Terça, quinta e sexta têm o mesmo vão das 14h às 17h -- três dias iguais é
 * rotina, não coincidência de horário ocupado. Quarta ele só começa 13h.
 * Domingo fechado (não há linha para o dia 0).
 */
const EXPEDIENTE = [
  { dia: 1, nome: 'Segunda', abre: '09:00', fecha: '16:30', pausas: [['11:30', '13:00', 'Almoço']] },
  { dia: 2, nome: 'Terça', abre: '09:00', fecha: '19:30', pausas: [['11:30', '13:00', 'Almoço'], ['14:00', '17:00', 'Intervalo']] },
  { dia: 3, nome: 'Quarta', abre: '13:00', fecha: '18:30', pausas: [['16:00', '17:00', 'Intervalo']] },
  { dia: 4, nome: 'Quinta', abre: '08:00', fecha: '19:30', pausas: [['11:30', '13:00', 'Almoço'], ['14:00', '17:00', 'Intervalo']] },
  { dia: 5, nome: 'Sexta', abre: '09:00', fecha: '19:30', pausas: [['11:30', '13:00', 'Almoço'], ['14:00', '17:00', 'Intervalo']] },
  { dia: 6, nome: 'Sábado', abre: '10:00', fecha: '16:30', pausas: [['12:00', '13:00', 'Almoço']] },
];

async function main() {
  await client.connect();
  // Mesmo caminho do migrate e do app: sem isto o seed escreveria em `public`
  // enquanto as tabelas estao no schema da instalacao.
  await client.query(`SET search_path TO "${SCHEMA}", public, extensions`);
  await client.query('BEGIN');

  const existing = await client.query('SELECT id FROM tenants WHERE slug = $1', [SLUG]);
  if (existing.rowCount) {
    console.log(`A empresa "${SLUG}" ja existe. Nada a fazer.`);
    await client.query('ROLLBACK');
    await client.end();
    return;
  }

  const tenant = await client.query(
    `INSERT INTO tenants (slug, name, phone, whatsapp, instagram, address, logo_url, timezone, plan)
     VALUES ($1,$2,$3,$3,$4,$5,$6,'America/Sao_Paulo','active')
     RETURNING id`,
    [SLUG, NEGOCIO.nome, NEGOCIO.telefone, NEGOCIO.instagram, NEGOCIO.endereco, IMAGENS.logo]
  );
  const tenantId = tenant.rows[0].id;

  await client.query(
    `INSERT INTO business_settings
       (tenant_id, whatsapp_session_id, slot_interval_minutes,
        min_advance_minutes, max_advance_days, minimum_reschedule_notice_minutes,
        allow_client_cancel, online_payment_required, payment_provider,
        payment_methods, owner_notify_phone, owner_notify_enabled)
     VALUES ($1, $2, 30, 15, 35, 60, false, true, 'pagarme',
             ARRAY['pix','card']::text[], $3, true)`,
    [tenantId, SLUG, NEGOCIO.telefone]
  );

  const passwordHash = await bcrypt.hash(PASSWORD, 10);
  const owner = await client.query(
    `INSERT INTO users (tenant_id, name, email, phone, password_hash, role)
     VALUES ($1,$2,$3,$4,$5,'OWNER') RETURNING id`,
    [tenantId, DONO.nome, DONO.email, NEGOCIO.telefone, passwordHash]
  );

  // Ele atende sozinho por enquanto. Sem linha em professional_services, o
  // profissional faz todos os servicos -- que e o caso.
  await client.query(
    `INSERT INTO professionals (tenant_id, user_id, name, phone, photo_url, display_order)
     VALUES ($1,$2,'Riady',$3,$4,0)`,
    [tenantId, owner.rows[0].id, NEGOCIO.telefone, IMAGENS.fotoDoRiady]
  );

  for (const [index, servico] of SERVICOS.entries()) {
    await client.query(
      `INSERT INTO services (tenant_id, name, description, category, price,
                             duration_minutes, display_order, active)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [tenantId, servico.nome, servico.descricao ?? null, servico.categoria,
       servico.preco, servico.duracao, index, servico.agendavel !== false]
    );
  }

  for (const dia of EXPEDIENTE) {
    await client.query(
      `INSERT INTO business_hours (tenant_id, weekday, opens_at, closes_at) VALUES ($1,$2,$3,$4)`,
      [tenantId, dia.dia, dia.abre, dia.fecha]
    );
    for (const [inicio, fim, rotulo] of dia.pausas) {
      await client.query(
        `INSERT INTO business_breaks (tenant_id, weekday, starts_at, ends_at, label)
         VALUES ($1,$2,$3,$4,$5)`,
        [tenantId, dia.dia, inicio, fim, rotulo]
      );
    }
  }

  for (const [index, produto] of PRODUTOS.entries()) {
    await client.query(
      `INSERT INTO products (tenant_id, name, brand, category, price, cost_price,
                             track_stock, stock_quantity, min_stock, display_order)
       VALUES ($1,$2,$3,$4,$5,0,false,0,0,$6)`,
      [tenantId, produto.nome, produto.marca, produto.categoria, produto.venda, index]
    );
  }

  await client.query('COMMIT');

  console.log(`\n${NEGOCIO.nome} cadastrada.\n`);
  console.log(`  Pagina publica : /agendar/${SLUG}`);
  console.log(`  Painel         : /login`);
  console.log(`  E-mail         : ${DONO.email}`);
  console.log(`  Senha          : ${PASSWORD}`);
  if (SENHA_SORTEADA) {
    console.log('                   ^ sorteada agora e mostrada uma vez so.');
    console.log('                     Anote: so o hash foi gravado.');
  }
  console.log(`  Profissional   : Riady (login proprio, OWNER)`);
  console.log(`  Servicos       : 6 agendaveis + 3 de quimica desativados`);
  console.log(`  Produtos       : ${PRODUTOS.length} pomadas, sem controle de estoque`);
  console.log(`  Agenda         : 15 min de antecedencia, 35 dias a frente, remarcar ate 1h antes`);
  console.log(`  Pagamento      : Ton/Stone via Pagar.me (Pix e cartao)`);
  console.log(`  Avisos da loja : ${NEGOCIO.telefone}\n`);

  await client.end();
}

main().catch(async (err) => {
  await client.query('ROLLBACK').catch(() => {});
  console.error(err);
  process.exit(1);
});
