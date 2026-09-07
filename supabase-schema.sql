-- TAROT LUNA - BASE DE DATOS SEGURA Y COMPATIBLE CON LA WEB
-- Versión 2026-08-28. Ejecutar una sola vez en un proyecto nuevo de Supabase.

begin;
create extension if not exists pgcrypto;

create table if not exists public.reservations (
  id bigint generated always as identity primary key,
  reservation_key uuid not null unique,
  name text not null check (char_length(trim(name)) between 2 and 120),
  email text not null check (char_length(email) <= 254 and position('@' in email) > 1),
  phone text not null check (char_length(phone) between 7 and 30),
  category text not null check (category in ('amor','trabajo','economia','familia','general')),
  duration integer not null check (duration in (10,30,60)),
  amount_cents integer not null check (
    (duration = 10 and amount_cents = 1000) or
    (duration = 30 and amount_cents = 2500) or
    (duration = 60 and amount_cents = 5000)
  ),
  appointment_date date not null,
  appointment_time time not null,
  timezone text not null default 'Europe/Madrid',
  notes text not null default '' check (char_length(notes) <= 800),
  status text not null default 'pending_payment' check (
    status in ('pending_payment','paid','payment_failed','cancelled','refunded','completed','no_show')
  ),
  payment_provider text,
  payment_order text unique,
  payment_response_code text,
  paid_at timestamptz,
  expires_at timestamptz not null default (now() + interval '20 minutes'),
  privacy_version text not null default '2026-08-28',
  privacy_accepted_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Bloqueos temporales mientras el cliente completa el pago alojado de Stripe.
create table if not exists public.slot_holds (
  slot_key text primary key,
  reservation_key uuid not null references public.reservations(reservation_key) on delete cascade,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

-- Franjas definitivamente ocupadas, únicamente después del pago confirmado.
create table if not exists public.booked_slots (
  slot_key text primary key,
  reservation_key uuid not null references public.reservations(reservation_key) on delete cascade,
  created_at timestamptz not null default now()
);

-- Evita procesar dos veces una misma notificación bancaria.
create table if not exists public.payment_events (
  id bigint generated always as identity primary key,
  provider text not null,
  provider_event_id text not null,
  reservation_key uuid references public.reservations(reservation_key) on delete set null,
  response_code text,
  verified boolean not null default false,
  payload_digest text,
  created_at timestamptz not null default now(),
  unique (provider, provider_event_id)
);

create table if not exists public.notification_deliveries (
  id bigint generated always as identity primary key,
  reservation_key uuid not null references public.reservations(reservation_key) on delete cascade,
  channel text not null check (channel in ('email','sms','whatsapp')),
  recipient_masked text not null,
  status text not null check (status in ('pending','sent','failed')),
  provider_message_id text,
  error_code text,
  created_at timestamptz not null default now(),
  sent_at timestamptz
);

create table if not exists public.audit_log (
  id bigint generated always as identity primary key,
  reservation_key uuid references public.reservations(reservation_key) on delete set null,
  action text not null,
  actor text not null default 'system',
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists reservations_appointment_idx on public.reservations (appointment_date, appointment_time);
create index if not exists reservations_status_idx on public.reservations (status);
create index if not exists reservations_created_idx on public.reservations (created_at desc);
create index if not exists slot_holds_expiry_idx on public.slot_holds (expires_at);
create index if not exists payment_events_reservation_idx on public.payment_events (reservation_key);
create index if not exists notification_reservation_idx on public.notification_deliveries (reservation_key, created_at desc);
create index if not exists audit_reservation_idx on public.audit_log (reservation_key, created_at desc);

alter table public.reservations enable row level security;
alter table public.slot_holds enable row level security;
alter table public.booked_slots enable row level security;
alter table public.payment_events enable row level security;
alter table public.notification_deliveries enable row level security;
alter table public.audit_log enable row level security;

revoke all on table public.reservations, public.slot_holds, public.booked_slots,
  public.payment_events, public.notification_deliveries, public.audit_log
  from public, anon, authenticated;

grant all on table public.reservations, public.slot_holds, public.booked_slots,
  public.payment_events, public.notification_deliveries, public.audit_log
  to service_role;
grant usage, select on all sequences in schema public to service_role;

create or replace function public.set_updated_at()
returns trigger language plpgsql set search_path = public as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists reservations_set_updated_at on public.reservations;
create trigger reservations_set_updated_at
before update on public.reservations
for each row execute function public.set_updated_at();

-- Firma exacta utilizada actualmente por /api/reservas de la web.
create or replace function public.create_reservation(
  p_reservation_key uuid,
  p_name text,
  p_email text,
  p_phone text,
  p_category text,
  p_duration integer,
  p_date date,
  p_time time,
  p_notes text,
  p_slot_keys text[]
) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_amount integer;
  v_expiry timestamptz := now() + interval '31 minutes';
begin
  v_amount := case p_duration when 10 then 1000 when 30 then 2500 when 60 then 5000 else null end;
  if v_amount is null then raise exception 'Duración no válida'; end if;
  if coalesce(array_length(p_slot_keys, 1), 0) <> p_duration / 10 then
    raise exception 'Bloques horarios no válidos';
  end if;

  delete from public.slot_holds where expires_at <= now();

  if exists (select 1 from public.booked_slots where slot_key = any(p_slot_keys)) or
     exists (select 1 from public.slot_holds where slot_key = any(p_slot_keys) and expires_at > now()) then
    raise exception 'Franja no disponible' using errcode = '23505';
  end if;

  insert into public.reservations (
    reservation_key, name, email, phone, category, duration, amount_cents,
    appointment_date, appointment_time, notes, expires_at
  ) values (
    p_reservation_key, trim(p_name), lower(trim(p_email)), trim(p_phone),
    p_category, p_duration, v_amount, p_date, p_time,
    left(coalesce(p_notes,''), 800), v_expiry
  );

  insert into public.slot_holds (slot_key, reservation_key, expires_at)
  select unnest(p_slot_keys), p_reservation_key, v_expiry;

  insert into public.audit_log (reservation_key, action)
  values (p_reservation_key, 'reservation_created_pending_payment');
end;
$$;

create or replace function public.confirm_stripe_paid_reservation(
  p_reservation_key uuid,
  p_session_id text,
  p_event_id text,
  p_slot_keys text[]
) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_res public.reservations%rowtype;
begin
  select * into v_res from public.reservations where reservation_key = p_reservation_key for update;
  if not found then raise exception 'Reserva no encontrada'; end if;
  if v_res.payment_order is distinct from p_session_id then raise exception 'Sesión de pago no válida'; end if;
  if v_res.status = 'paid' then return; end if;
  if v_res.status not in ('pending_payment', 'payment_failed') then raise exception 'El estado no permite confirmar el pago'; end if;
  if coalesce(array_length(p_slot_keys, 1), 0) <> v_res.duration / 10 then raise exception 'Bloques horarios no válidos'; end if;
  if exists (select 1 from public.booked_slots where slot_key = any(p_slot_keys) and reservation_key <> p_reservation_key) then
    raise exception 'Conflicto con otra reserva ya pagada' using errcode = '23505';
  end if;

  insert into public.payment_events (
    provider, provider_event_id, reservation_key, response_code, verified
  ) values (
    'stripe', p_event_id, p_reservation_key, 'paid', true
  ) on conflict (provider, provider_event_id) do nothing;

  insert into public.booked_slots (slot_key, reservation_key)
  select unnest(p_slot_keys), p_reservation_key on conflict (slot_key) do nothing;

  delete from public.slot_holds where reservation_key = p_reservation_key;

  update public.reservations set
    status = 'paid',
    payment_provider = 'stripe_bizum',
    payment_order = p_session_id,
    payment_response_code = 'paid',
    paid_at = now()
  where reservation_key = p_reservation_key;

  insert into public.audit_log (reservation_key, action, metadata)
  values (
    p_reservation_key, 'payment_confirmed',
    jsonb_build_object('session_id', p_session_id, 'event_id', p_event_id)
  );
end;
$$;

create or replace function public.fail_reservation_payment(
  p_reservation_key uuid,
  p_response_code text
) returns void
language plpgsql security definer set search_path = public as $$
begin
  update public.reservations set
    status = 'payment_failed',
    payment_response_code = p_response_code
  where reservation_key = p_reservation_key and status = 'pending_payment';
  delete from public.slot_holds where reservation_key = p_reservation_key;
  insert into public.audit_log (reservation_key, action, metadata)
  values (p_reservation_key, 'payment_failed', jsonb_build_object('response_code', p_response_code));
end;
$$;

revoke all on function public.create_reservation(uuid,text,text,text,text,integer,date,time,text,text[])
  from public, anon, authenticated;
revoke all on function public.confirm_stripe_paid_reservation(uuid,text,text,text[])
  from public, anon, authenticated;
revoke all on function public.fail_reservation_payment(uuid,text)
  from public, anon, authenticated;

grant execute on function public.create_reservation(uuid,text,text,text,text,integer,date,time,text,text[])
  to service_role;
grant execute on function public.confirm_stripe_paid_reservation(uuid,text,text,text[])
  to service_role;
grant execute on function public.fail_reservation_payment(uuid,text)
  to service_role;

comment on table public.reservations is 'Reservas privadas de Tarot Luna; acceso exclusivo desde el servidor.';
comment on table public.slot_holds is 'Bloqueos temporales durante el pago alojado de Stripe.';
comment on table public.booked_slots is 'Bloques ocupados definitivamente después del pago confirmado.';
comment on table public.payment_events is 'Notificaciones bancarias verificadas e idempotentes.';
comment on table public.notification_deliveries is 'Trazabilidad de correo, SMS y WhatsApp sin guardar el mensaje completo.';
comment on table public.audit_log is 'Auditoría interna de cambios relevantes.';

commit;
