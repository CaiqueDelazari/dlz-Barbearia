import type { Metadata } from 'next';
import { ManageBooking } from './ManageBooking';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Meu agendamento',
  robots: { index: false, follow: false }, // link privado do cliente
};

export default async function ManageBookingPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return <ManageBooking token={token} />;
}
