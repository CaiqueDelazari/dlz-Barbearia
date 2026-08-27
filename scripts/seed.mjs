#!/usr/bin/env node
/**
 * Popula o sistema com o Estúdio Duda Machado: usuário dono, profissionais,
 * serviços por categoria, horários e mensagens automáticas.
 *
 * Serve como empresa inicial de verdade e também como exemplo de tudo que uma
 * empresa nova precisa ter para a página pública funcionar.
 *
 *   npm run db:seed
 *
 * Para criar outra empresa em vez desta, use SEED_SLUG / SEED_EMAIL /
 * SEED_PASSWORD ou cadastre pela tela /cadastro.
 */
import pg from 'pg';
import bcrypt from 'bcryptjs';
import 'dotenv/config';

const { DATABASE_URL } = process.env;
if (!DATABASE_URL) {
  console.error('DATABASE_URL nao definida.');
  process.exit(1);
}

const SLUG = process.env.SEED_SLUG || 'duda-machado';
const EMAIL = process.env.SEED_EMAIL || 'duda@dudamachado.com.br';
const PASSWORD = process.env.SEED_PASSWORD || 'dudamachado';

const needsSsl =
  process.env.DATABASE_SSL !== 'false' &&
  /sslmode=require|neon\.tech|supabase|render\.com/.test(DATABASE_URL);

const client = new pg.Client({
  connectionString: DATABASE_URL,
  ssl: needsSsl ? { rejectUnauthorized: false } : undefined,
});

const NEGOCIO = {
  nome: 'Estúdio Duda Machado',
  telefone: '11987654321',
  instagram: '@dudamachado.studio',
  endereco: 'Rua Harmonia, 480 — Vila Madalena, São Paulo/SP',
};

/** As categorias viram as abas da página de agendamento. */
const SERVICOS = [
  // Cabelo
  { nome: 'Corte feminino', categoria: 'Cabelo', preco: 120, duracao: 60 },
  { nome: 'Corte masculino', categoria: 'Cabelo', preco: 70, duracao: 40 },
  { nome: 'Corte infantil', categoria: 'Cabelo', preco: 60, duracao: 40 },
  { nome: 'Escova', categoria: 'Cabelo', preco: 80, duracao: 45 },
  { nome: 'Penteado', categoria: 'Cabelo', preco: 180, duracao: 75 },

  // Coloração
  { nome: 'Retoque de raiz', categoria: 'Coloração', preco: 190, duracao: 90 },
  { nome: 'Coloração completa', categoria: 'Coloração', preco: 280, duracao: 120 },
  { nome: 'Mechas e iluminado', categoria: 'Coloração', preco: 420, duracao: 180 },
  { nome: 'Tonalizante', categoria: 'Coloração', preco: 130, duracao: 60 },

  // Tratamentos
  { nome: 'Hidratação', categoria: 'Tratamentos', preco: 90, duracao: 45 },
  { nome: 'Reconstrução capilar', categoria: 'Tratamentos', preco: 160, duracao: 75 },
  { nome: 'Botox capilar', categoria: 'Tratamentos', preco: 220, duracao: 90 },

  // Sobrancelha
  { nome: 'Design de sobrancelha', categoria: 'Sobrancelha', preco: 50, duracao: 30 },
  { nome: 'Design com henna', categoria: 'Sobrancelha', preco: 70, duracao: 40 },
];

/** Revenda de balcão: o que o salão vende junto com o atendimento. */
const PRODUTOS = [
  { nome: 'Xampu hidratante 300ml', marca: 'Kerastase', categoria: 'Cabelo', venda: 145, custo: 92, estoque: 8, minimo: 3 },
  { nome: 'Condicionador 250ml', marca: 'Kerastase', categoria: 'Cabelo', venda: 135, custo: 86, estoque: 6, minimo: 3 },
  { nome: 'Máscara de reconstrução 200g', marca: 'Wella', categoria: 'Tratamento', venda: 180, custo: 110, estoque: 4, minimo: 2 },
  { nome: 'Óleo de argan 60ml', marca: 'Moroccanoil', categoria: 'Finalizador', venda: 210, custo: 140, estoque: 3, minimo: 2 },
  { nome: 'Leave-in protetor térmico', marca: 'Wella', categoria: 'Finalizador', venda: 95, custo: 58, estoque: 2, minimo: 3 },
  { nome: 'Escova de cerdas naturais', marca: null, categoria: 'Acessório', venda: 70, custo: 38, estoque: 5, minimo: 2 },
];

const TEMPLATES = {
  confirmation:
    'Olá, {cliente}! Seu horário no {empresa} está confirmado.\n\n{data} às {hora}\n{servicos}\nCom {profissional}\nTotal: {valor_total}\n\nPara ver, remarcar ou cancelar: {link}',
  reminder_24h:
    'Oi, {cliente}! Lembrete: seu horário no {empresa} é amanhã às {hora}.\n\n{servicos}\n\nSe precisar remarcar: {link}',
  reminder_1h: '{cliente}, seu horário no {empresa} é daqui a 1 hora ({hora}). Te esperamos!',
  return:
    'Oi, {cliente}! Já faz {dias} dias desde seu último atendimento no {empresa}. Quer garantir seu próximo horário?\n\n{link_agendamento}',
  cancelled:
    'Olá, {cliente}. Seu horário no {empresa} em {data} às {hora} foi cancelado.\nPara marcar outro: {link_agendamento}',
  payment_link:
    'Olá, {cliente}! Para confirmar seu horário no {empresa} em {data} às {hora}, finalize o pagamento de {valor_pagar} aqui: {link_pagamento}\n\nO horário fica reservado por {minutos} minutos.',
};

async function main() {
  await client.connect();
  await client.query('BEGIN');

  const existing = await client.query('SELECT id FROM tenants WHERE slug = $1', [SLUG]);
  if (existing.rowCount) {
    console.log(`A empresa "${SLUG}" ja existe. Nada a fazer.`);
    await client.query('ROLLBACK');
    await client.end();
    return;
  }

  const tenant = await client.query(
    `INSERT INTO tenants (slug, name, phone, whatsapp, instagram, address, timezone, plan, trial_ends_at)
     VALUES ($1,$2,$3,$3,$4,$5,'America/Sao_Paulo','trial', now() + interval '14 days')
     RETURNING id`,
    [SLUG, NEGOCIO.nome, NEGOCIO.telefone, NEGOCIO.instagram, NEGOCIO.endereco]
  );
  const tenantId = tenant.rows[0].id;

  // coloração e mechas são caras: sinal de 50% evita buraco na agenda
  await client.query(
    `INSERT INTO business_settings
       (tenant_id, whatsapp_session_id, online_payment_required, deposit_percent,
        minimum_reschedule_notice_minutes, return_reminder_days)
     VALUES ($1, $2, true, 50, 120, 30)`,
    [tenantId, SLUG]
  );

  const passwordHash = await bcrypt.hash(PASSWORD, 10);
  const owner = await client.query(
    `INSERT INTO users (tenant_id, name, email, phone, password_hash, role)
     VALUES ($1, 'Duda Machado', $2, $3, $4, 'OWNER') RETURNING id`,
    [tenantId, EMAIL, NEGOCIO.telefone, passwordHash]
  );

  const duda = await client.query(
    `INSERT INTO professionals (tenant_id, user_id, name, bio, display_order)
     VALUES ($1, $2, 'Duda Machado', 'Corte e coloração', 0) RETURNING id`,
    [tenantId, owner.rows[0].id]
  );
  const larissa = await client.query(
    `INSERT INTO professionals (tenant_id, name, bio, display_order)
     VALUES ($1, 'Larissa', 'Tratamentos e sobrancelha', 1) RETURNING id`,
    [tenantId]
  );

  const servicoIds = {};
  for (const [index, servico] of SERVICOS.entries()) {
    const row = await client.query(
      `INSERT INTO services (tenant_id, name, category, price, duration_minutes, display_order)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [tenantId, servico.nome, servico.categoria, servico.preco, servico.duracao, index]
    );
    servicoIds[servico.nome] = row.rows[0].id;
  }

  // Só a Larissa faz sobrancelha; o resto as duas atendem (sem vínculo = todas).
  for (const nome of ['Design de sobrancelha', 'Design com henna']) {
    await client.query(
      `INSERT INTO professional_services (tenant_id, professional_id, service_id) VALUES ($1,$2,$3)`,
      [tenantId, larissa.rows[0].id, servicoIds[nome]]
    );
  }
  // Mechas e iluminado: só a Duda.
  await client.query(
    `INSERT INTO professional_services (tenant_id, professional_id, service_id) VALUES ($1,$2,$3)`,
    [tenantId, duda.rows[0].id, servicoIds['Mechas e iluminado']]
  );

  // terça a sexta 09:00–19:00, sábado 09:00–17:00; domingo e segunda fechado
  for (const weekday of [2, 3, 4, 5]) {
    await client.query(
      `INSERT INTO business_hours (tenant_id, weekday, opens_at, closes_at) VALUES ($1,$2,'09:00','19:00')`,
      [tenantId, weekday]
    );
    await client.query(
      `INSERT INTO business_breaks (tenant_id, weekday, starts_at, ends_at, label)
       VALUES ($1,$2,'13:00','14:00','Almoço')`,
      [tenantId, weekday]
    );
  }
  await client.query(
    `INSERT INTO business_hours (tenant_id, weekday, opens_at, closes_at) VALUES ($1,6,'09:00','17:00')`,
    [tenantId]
  );

  for (const [index, produto] of PRODUTOS.entries()) {
    const row = await client.query(
      `INSERT INTO products (tenant_id, name, brand, category, price, cost_price,
                             track_stock, stock_quantity, min_stock, display_order)
       VALUES ($1,$2,$3,$4,$5,$6,true,$7,$8,$9) RETURNING id`,
      [tenantId, produto.nome, produto.marca, produto.categoria, produto.venda,
       produto.custo, produto.estoque, produto.minimo, index]
    );
    await client.query(
      `INSERT INTO product_movements (tenant_id, product_id, quantity, reason, notes, user_id)
       VALUES ($1,$2,$3,'restock','Estoque inicial',$4)`,
      [tenantId, row.rows[0].id, produto.estoque, owner.rows[0].id]
    );
  }

  for (const [key, body] of Object.entries(TEMPLATES)) {
    await client.query(
      `INSERT INTO notification_templates (tenant_id, key, channel, body) VALUES ($1,$2,'whatsapp',$3)`,
      [tenantId, key, body]
    );
  }

  await client.query(
    `INSERT INTO clients (tenant_id, name, phone) VALUES
       ($1, 'Camila Ferreira', '11988887777'),
       ($1, 'Renata Alves', '11977776666'),
       ($1, 'Bruno Tavares', '11966665555')`,
    [tenantId]
  );

  await client.query('COMMIT');

  const categorias = [...new Set(SERVICOS.map((s) => s.categoria))];
  console.log(`\n${NEGOCIO.nome} criado.\n`);
  console.log(`  Pagina publica : /agendar/${SLUG}`);
  console.log(`  Painel         : /login`);
  console.log(`  E-mail         : ${EMAIL}`);
  console.log(`  Senha          : ${PASSWORD}`);
  console.log(`  Profissionais  : Duda Machado, Larissa`);
  console.log(`  Servicos       : ${SERVICOS.length} em ${categorias.length} abas (${categorias.join(', ')})`);
  console.log(`  Produtos       : ${PRODUTOS.length} em estoque`);
  console.log(`  Funcionamento  : ter-sex 09:00-19:00, sab 09:00-17:00\n`);

  await client.end();
}

main().catch(async (err) => {
  await client.query('ROLLBACK').catch(() => {});
  console.error(err);
  process.exit(1);
});
