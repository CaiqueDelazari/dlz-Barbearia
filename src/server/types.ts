export type Tenant = {
  id: string;
  slug: string;
  name: string;
  phone: string | null;
  whatsapp: string | null;
  instagram: string | null;
  address: string | null;
  logo_url: string | null;
  cover_url: string | null;
  timezone: string;
  currency: string;
  active: boolean;
};

export type BusinessSettings = {
  tenant_id: string;
  slot_interval_minutes: number;
  min_advance_minutes: number;
  max_advance_days: number;
  minimum_reschedule_notice_minutes: number;
  allow_client_cancel: boolean;
  online_payment_required: boolean;
  allow_deposit: boolean;
  allow_full_payment: boolean;
  deposit_percent: number;
  forfeit_deposit_on_no_show: boolean;
  hold_expiration_minutes: number;
  allow_split_appointments: boolean;
  allow_professional_choice: boolean;
  reminder_24h_enabled: boolean;
  reminder_1h_enabled: boolean;
  return_reminder_enabled: boolean;
  return_reminder_days: number;
  manage_link_ttl_hours: number;
  payment_methods: string[];
  whatsapp_session_id: string | null;
  payment_provider: string;
  owner_notify_phone: string | null;
  owner_notify_enabled: boolean;
};

export type Service = {
  id: string;
  tenant_id: string;
  name: string;
  description: string | null;
  price: number;
  duration_minutes: number;
  image_url: string | null;
  category: string | null;
  display_order: number;
  active: boolean;
};

export type Professional = {
  id: string;
  tenant_id: string;
  name: string;
  bio: string | null;
  photo_url: string | null;
  display_order: number;
  active: boolean;
};

export type Client = {
  id: string;
  tenant_id: string;
  name: string;
  phone: string;
  email: string | null;
  notes: string | null;
  blocked: boolean;
  no_show_count: number;
};

export type AppointmentStatus =
  | 'pending' | 'confirmed' | 'completed' | 'cancelled' | 'no_show' | 'rescheduled';

export type PaymentStatus =
  | 'pending' | 'processing' | 'paid' | 'partially_paid' | 'failed' | 'refunded' | 'cancelled';

export type Appointment = {
  id: string;
  tenant_id: string;
  booking_group_id: string;
  client_id: string;
  professional_id: string | null;
  starts_at: Date;
  ends_at: Date;
  duration_minutes: number;
  status: AppointmentStatus;
  source: 'online' | 'manual' | 'whatsapp' | 'ai';
  total_amount: number;
  paid_amount: number;
  payment_status: PaymentStatus;
  hold_expires_at: Date | null;
  manage_token: string | null;
  notes: string | null;
};

export type Slot = {
  /** HH:mm no fuso do tenant */
  time: string;
  /** instante ISO do inicio */
  startsAt: string;
  endsAt: string;
  professionalId: string | null;
  professionalName: string | null;
};
