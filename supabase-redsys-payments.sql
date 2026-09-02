-- TAROT LUNA — CONFIRMACIÓN SEGURA DE PAGOS REDSYS/BIZUM
-- Ejecutar una sola vez en Supabase SQL Editor antes de activar los cobros.
begin;

create or replace function public.confirm_paid_reservation(
  p_reservation_key uuid,
  p_payment_order text,
  p_response_code text,
  p_slot_keys text[]
) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_res public.reservations%rowtype;
begin
  select * into v_res from public.reservations
  where reservation_key = p_reservation_key for update;
  if not found then raise exception 'Reserva no encontrada'; end if;
  if v_res.status = 'paid' and v_res.payment_order = p_payment_order then return; end if;
  if v_res.status not in ('pending_payment', 'payment_failed') then
    raise exception 'El estado de la reserva no permite confirmar el pago';
  end if;
  if coalesce(array_length(p_slot_keys, 1), 0) <> v_res.duration / 10 then
    raise exception 'Bloques horarios no válidos';
  end if;
  if exists (
    select 1 from public.booked_slots
    where slot_key = any(p_slot_keys) and reservation_key <> p_reservation_key
  ) then
    raise exception 'Conflicto con otra reserva ya pagada' using errcode = '23505';
  end if;

  insert into public.payment_events (provider, provider_event_id, reservation_key, response_code, verified)
  values ('redsys', p_payment_order, p_reservation_key, p_response_code, true)
  on conflict (provider, provider_event_id) do nothing;

  delete from public.slot_holds where slot_key = any(p_slot_keys);
  insert into public.booked_slots (slot_key, reservation_key)
  select unnest(p_slot_keys), p_reservation_key
  on conflict (slot_key) do nothing;

  update public.reservations set
    status = 'paid', payment_provider = coalesce(payment_provider, 'redsys'),
    payment_order = p_payment_order, payment_response_code = p_response_code, paid_at = now()
  where reservation_key = p_reservation_key;

  insert into public.audit_log (reservation_key, action, actor, metadata)
  values (p_reservation_key, 'payment_confirmed', 'redsys_webhook', jsonb_build_object('order', p_payment_order, 'response_code', p_response_code));
end;
$$;

revoke all on function public.confirm_paid_reservation(uuid,text,text,text[]) from public, anon, authenticated;
grant execute on function public.confirm_paid_reservation(uuid,text,text,text[]) to service_role;
commit;
