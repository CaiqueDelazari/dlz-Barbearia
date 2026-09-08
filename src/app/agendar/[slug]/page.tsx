import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { query } from '@/lib/db';
import { getSettings, getTenantBySlug } from '@/server/repositories/tenant.repo';
import { BookingFlow } from './BookingFlow';

export const dynamic = 'force-dynamic';

async function loadPage(slug: string) {
  try {
    const tenant = await getTenantBySlug(slug);
    const settings = await getSettings(tenant.id);

    const [services, professionals, products] = await Promise.all([
      query(
        `SELECT id, name, description, price::float8 AS price,
                duration_minutes AS "durationMinutes", image_url AS "imageUrl", category
           FROM services WHERE tenant_id = $1 AND active
           ORDER BY display_order, name`,
        [tenant.id]
      ),
      query(
        `SELECT id, name, bio, photo_url AS "photoUrl"
           FROM professionals WHERE tenant_id = $1 AND active
           ORDER BY display_order, name`,
        [tenant.id]
      ),
      // vitrine: o cliente vê o que o estúdio revende e pede no balcão.
      // `cost_price` e `stock_quantity` ficam de fora — não são assunto de
      // quem está do lado de fora.
      query(
        `SELECT id, name, description, brand, category,
                price::float8 AS price, image_url AS "imageUrl"
           FROM products WHERE tenant_id = $1 AND active
           ORDER BY display_order, name`,
        [tenant.id]
      ),
    ]);

    return { tenant, settings, services, professionals, products };
  } catch {
    return null;
  }
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const data = await loadPage((await params).slug);
  if (!data) return { title: 'Página não encontrada' };
  return {
    title: `${data.tenant.name} | Agende seu horário`,
    description: `Agende online seu horário na ${data.tenant.name}.`,
  };
}

/**
 * Pagina publica da empresa. Renderiza no servidor com os dados ja carregados
 * para o cliente abrir o link do Instagram/WhatsApp e ver a lista na hora.
 */
export default async function AgendarPage({ params }: { params: Promise<{ slug: string }> }) {
  const data = await loadPage((await params).slug);
  if (!data) notFound();

  const { tenant, settings, services, professionals, products } = data;

  return (
    <BookingFlow
      tenant={{
        slug: tenant.slug,
        name: tenant.name,
        address: tenant.address,
        instagram: tenant.instagram,
        // o fixo serve de reserva: muita loja tem um numero so, e ele e o mesmo
        whatsapp: tenant.whatsapp ?? tenant.phone,
        logoUrl: tenant.logo_url,
        timezone: tenant.timezone,
      }}
      services={services as never}
      professionals={professionals as never}
      products={products as never}
      config={{
        depositPercent: Number(settings.deposit_percent),
        allowDeposit: settings.allow_deposit,
        allowFullPayment: settings.allow_full_payment,
        paymentRequired: settings.online_payment_required,
        paymentMethods: settings.payment_methods,
        allowProfessionalChoice: settings.allow_professional_choice,
        allowSplit: settings.allow_split_appointments,
        maxAdvanceDays: settings.max_advance_days,
        holdMinutes: settings.hold_expiration_minutes,
        allowClientCancel: settings.allow_client_cancel,
      }}
    />
  );
}
