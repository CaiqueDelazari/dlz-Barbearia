import { transaction } from '@/lib/db';
import { ApiError } from '@/lib/http';
import { env } from '@/lib/env';
import { hashPassword } from '@/lib/auth';
import { DEFAULT_TEMPLATES } from './notification.service';

export function slugify(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // tira acentos depois do NFD
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

/**
 * Cadastro de uma empresa nova. Tudo que ela precisa para funcionar nasce aqui:
 * settings, horario padrao e mensagens. Nenhuma linha de codigo por cliente.
 */
export async function createTenant(input: {
  businessName: string;
  slug?: string;
  ownerName: string;
  email: string;
  password: string;
  phone?: string;
  timezone?: string;
}): Promise<{ tenantId: string; slug: string; userId: string }> {
  if (input.password.length < 8) {
    throw ApiError.badRequest('A senha precisa ter ao menos 8 caracteres');
  }

  const base = slugify(input.slug || input.businessName);
  if (!base) throw ApiError.badRequest('Nome da empresa invalido');

  const passwordHash = await hashPassword(input.password);

  return transaction(async (tx) => {
    // slug unico: se ja existe, sufixa ate encontrar livre
    let slug = base;
    for (let i = 2; i < 50; i++) {
      const taken = await tx.query('SELECT 1 FROM tenants WHERE slug = $1', [slug]);
      if (!taken.rowCount) break;
      slug = `${base}-${i}`;
    }

    const tenant = await tx.query<{ id: string }>(
      `INSERT INTO tenants (slug, name, phone, whatsapp, timezone, plan, trial_ends_at)
       VALUES ($1,$2,$3,$3,$4,'trial', now() + interval '14 days')
       RETURNING id`,
      [slug, input.businessName.trim(), input.phone ?? null, input.timezone ?? env.defaultTimezone]
    );
    const tenantId = tenant.rows[0].id;

    await tx.query(
      `INSERT INTO business_settings (tenant_id, whatsapp_session_id) VALUES ($1, $2)`,
      [tenantId, slug]
    );

    const user = await tx.query<{ id: string }>(
      `INSERT INTO users (tenant_id, name, email, phone, password_hash, role)
       VALUES ($1,$2,$3,$4,$5,'OWNER') RETURNING id`,
      [tenantId, input.ownerName.trim(), input.email.trim().toLowerCase(), input.phone ?? null, passwordHash]
    );

    // horario padrao: seg-sex 09-19, sab 08-16, domingo fechado, almoco 12-13
    for (const weekday of [1, 2, 3, 4, 5]) {
      await tx.query(
        `INSERT INTO business_hours (tenant_id, weekday, opens_at, closes_at) VALUES ($1,$2,'09:00','19:00')`,
        [tenantId, weekday]
      );
      await tx.query(
        `INSERT INTO business_breaks (tenant_id, weekday, starts_at, ends_at, label)
         VALUES ($1,$2,'12:00','13:00','Almoço')`,
        [tenantId, weekday]
      );
    }
    await tx.query(
      `INSERT INTO business_hours (tenant_id, weekday, opens_at, closes_at) VALUES ($1,6,'08:00','16:00')`,
      [tenantId]
    );

    for (const [key, body] of Object.entries(DEFAULT_TEMPLATES)) {
      await tx.query(
        `INSERT INTO notification_templates (tenant_id, key, channel, body) VALUES ($1,$2,'whatsapp',$3)`,
        [tenantId, key, body]
      );
    }

    // o dono ja entra como profissional atendendo
    await tx.query(
      `INSERT INTO professionals (tenant_id, user_id, name, display_order)
       VALUES ($1,$2,$3,0)`,
      [tenantId, user.rows[0].id, input.ownerName.trim()]
    );

    return { tenantId, slug, userId: user.rows[0].id };
  });
}
