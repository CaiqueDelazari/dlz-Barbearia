import type { Metadata } from 'next';
import { ManageBooking } from './ManageBooking';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Meu agendamento',
  robots: { index: false, follow: false }, // link privado do cliente
};

export default function ManageBookingPage({ params }: { params: { token: string } }) {
  return <ManageBooking token={params.token} />;
}
