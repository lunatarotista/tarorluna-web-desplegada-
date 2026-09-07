-- TAROT LUNA — MIGRACIÓN SEGURA A STRIPE + BIZUM
-- Ejecutar una sola vez en Supabase > SQL Editor antes de probar Stripe.
begin;

create or replace function public.create_reservation(
  p_reservation_key uuid, p_name text, p_email text, p_phone text,
  p_category text, p_duration integer, p_date date, p_time time,
  p_notes text, p_slot_keys text[]
) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_amount integer;
  v_expiry timestamptz := now() + interval '31 minutes';
begin
  v_amount := case p_duration when 10 then 1000 when 30 then 2500 when 60 then 5000 else null end;
  if v_amount is null then raise exception 'Duración no válida'; end if;
  if coalesce(array_length(p_slot_keys, 1), 0) <> p_duration / 10 then raise exception 'Bloques horarios no válidos'; end if;
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
    p_category, p_duration, v_amount, p_date, p_time, left(coalesce(p_notes,''), 800), v_expiry
  );
  insert into public.slot_holds (slot_key, reservation_key, expires_at)
  select unnest(p_slot_keys), p_reservation_key, v_expiry;
  insert into public.audit_log (reservation_key, action, actor)
  values (p_reservation_key, 'reservation_created_pending_payment', 'web');
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
  insert into public.payment_events (provider, provider_event_id, reservation_key, response_code, verified)
  values ('stripe', p_event_id, p_reservation_key, 'paid', true)
  on conflict (provider, provider_event_id) do nothing;
  delete from public.slot_holds where slot_key = any(p_slot_keys);
  insert into public.booked_slots (slot_key, reservation_key)
  select unnest(p_slot_keys), p_reservation_key on conflict (slot_key) do nothing;
  update public.reservations set status = 'paid', payment_provider = 'stripe_bizum',
    payment_order = p_session_id, payment_response_code = 'paid', paid_at = now()
  where reservation_key = p_reservation_key;
  insert into public.audit_log (reservation_key, action, actor, metadata)
  values (p_reservation_key, 'payment_confirmed', 'stripe_webhook', jsonb_build_object('session_id', p_session_id, 'event_id', p_event_id));
end;
$$;

revoke all on function public.create_reservation(uuid,text,text,text,text,integer,date,time,text,text[]) from public, anon, authenticated;
revoke all on function public.confirm_stripe_paid_reservation(uuid,text,text,text[]) from public, anon, authenticated;
grant execute on function public.create_reservation(uuid,text,text,text,text,integer,date,time,text,text[]) to service_role;
grant execute on function public.confirm_stripe_paid_reservation(uuid,text,text,text[]) to service_role;

comment on table public.slot_holds is 'Bloqueos temporales durante el pago alojado de Stripe.';
comment on table public.payment_events is 'Eventos de pago verificados e idempotentes.';
commit;
