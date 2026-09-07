import { occupiedKeys } from "@/lib/schedule";
import Stripe from "stripe";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function supabaseConfig() {
  const url = process.env.SUPABASE_URL?.replace(/\/$/, "");
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  return url && key ? { url, key } : null;
}
function dbHeaders(key: string) { return { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" }; }
type Reservation = { reservation_key: string; name: string; email: string; duration: number; amount_cents: number; appointment_date: string; appointment_time: string; status: string; payment_order: string | null };

async function notifyPaid(reservation: Reservation, sessionId: string) {
  if (!process.env.RESEND_API_KEY) return;
  const dateTime = `${reservation.appointment_date} a las ${reservation.appointment_time.slice(0, 5)}`;
  await fetch("https://api.resend.com/emails", {
    method: "POST", headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: process.env.RESERVATION_FROM_EMAIL ?? "Tarot Luna <reservas@resend.dev>",
      to: [reservation.email, process.env.ADMIN_EMAIL ?? "lunatarotista211@gmail.com"],
      subject: "Pago confirmado — reserva Tarot Luna",
      text: `Hola ${reservation.name}. El pago de tu reserva ha sido confirmado.\n\nCita: ${dateTime}\nDuración: ${reservation.duration} minutos\nReferencia: ${sessionId}\n\nTarot Luna`,
    }),
  }).catch(() => undefined);
}

export async function POST(request: Request) {
  const secretKey = process.env.STRIPE_SECRET_KEY, webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  const database = supabaseConfig();
  if (!secretKey || !webhookSecret || !database) return new Response("Configuración incompleta", { status: 503 });
  const signature = request.headers.get("stripe-signature");
  if (!signature) return new Response("Firma ausente", { status: 400 });

  let event: Stripe.Event;
  try { event = new Stripe(secretKey).webhooks.constructEvent(await request.text(), signature, webhookSecret); }
  catch { return new Response("Firma no válida", { status: 400 }); }

  const handled = new Set(["checkout.session.completed", "checkout.session.async_payment_succeeded", "checkout.session.async_payment_failed", "checkout.session.expired"]);
  if (!handled.has(event.type)) return new Response("OK", { status: 200 });
  const session = event.data.object as Stripe.Checkout.Session;
  const reservationKey = session.metadata?.reservation_key ?? session.client_reference_id;
  if (!reservationKey) return new Response("Reserva no identificada", { status: 400 });

  const query = new URLSearchParams({ select: "reservation_key,name,email,duration,amount_cents,appointment_date,appointment_time,status,payment_order", reservation_key: `eq.${reservationKey}`, limit: "1" });
  const reservationResponse = await fetch(`${database.url}/rest/v1/reservations?${query}`, { headers: dbHeaders(database.key), cache: "no-store" });
  if (!reservationResponse.ok) return new Response("Error de base de datos", { status: 502 });
  const reservation = (await reservationResponse.json() as Reservation[])[0];
  if (!reservation || reservation.payment_order !== session.id) return new Response("Sesión no válida", { status: 400 });

  const paidEvent = event.type === "checkout.session.completed" || event.type === "checkout.session.async_payment_succeeded";
  if (paidEvent) {
    if (session.payment_status !== "paid" || session.currency !== "eur" || session.amount_total !== reservation.amount_cents) return new Response("Pago o importe no válido", { status: 400 });
    const update = await fetch(`${database.url}/rest/v1/rpc/confirm_stripe_paid_reservation`, {
      method: "POST", headers: dbHeaders(database.key),
      body: JSON.stringify({ p_reservation_key: reservation.reservation_key, p_session_id: session.id, p_event_id: event.id, p_slot_keys: occupiedKeys(reservation.appointment_date, reservation.appointment_time.slice(0, 5), reservation.duration) }),
    });
    if (!update.ok) return new Response("No se pudo conciliar el pago", { status: 500 });
    if (reservation.status !== "paid") await notifyPaid(reservation, session.id);
  } else {
    const update = await fetch(`${database.url}/rest/v1/rpc/fail_reservation_payment`, {
      method: "POST", headers: dbHeaders(database.key),
      body: JSON.stringify({ p_reservation_key: reservation.reservation_key, p_response_code: event.type }),
    });
    if (!update.ok) return new Response("No se pudo actualizar la reserva", { status: 500 });
  }
  return new Response("OK", { status: 200 });
}
