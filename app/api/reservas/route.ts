import { hasMinimumNotice, occupiedKeys, slotsForDate } from "@/lib/schedule";
import Stripe from "stripe";

type Payload = { name?: string; email?: string; phone?: string; category?: string; duration?: string; date?: string; time?: string; notes?: string; consent?: string };
const allowedCategories = new Set(["amor", "trabajo", "economia", "familia", "general"]);
const datePattern = /^\d{4}-\d{2}-\d{2}$/;
const prices: Record<number, number> = { 10: 1000, 30: 2500, 60: 5000 };

function supabaseConfig() {
  const url = process.env.SUPABASE_URL?.replace(/\/$/, "");
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  return url && key ? { url, key } : null;
}

function headers(key: string) { return { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" }; }

async function failPendingReservation(config: { url: string; key: string }, reservationKey: string, reason: string) {
  await fetch(`${config.url}/rest/v1/rpc/fail_reservation_payment`, {
    method: "POST", headers: headers(config.key),
    body: JSON.stringify({ p_reservation_key: reservationKey, p_response_code: reason.slice(0, 120) }),
  }).catch(() => undefined);
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const date = url.searchParams.get("date") ?? "";
  const duration = Number(url.searchParams.get("duration"));
  if (!datePattern.test(date) || ![10, 30, 60].includes(duration)) return Response.json({ error: "Fecha o duración no válidas." }, { status: 400 });
  const candidates = slotsForDate(date, duration), config = supabaseConfig();
  if (!config) return Response.json({ slots: candidates, databaseConfigured: false });
  const [bookedResponse, holdsResponse] = await Promise.all([
    fetch(`${config.url}/rest/v1/booked_slots?select=slot_key&slot_key=like.${encodeURIComponent(`${date}|%`)}`, { headers: headers(config.key), cache: "no-store" }),
    fetch(`${config.url}/rest/v1/slot_holds?select=slot_key&slot_key=like.${encodeURIComponent(`${date}|%`)}&expires_at=gt.${encodeURIComponent(new Date().toISOString())}`, { headers: headers(config.key), cache: "no-store" })
  ]);
  if (!bookedResponse.ok || !holdsResponse.ok) return Response.json({ error: "No se pudo consultar la agenda." }, { status: 502 });
  const booked = await bookedResponse.json() as Array<{ slot_key: string }>;
  const holds = await holdsResponse.json() as Array<{ slot_key: string }>;
  const occupied = new Set([...booked, ...holds].map((row) => row.slot_key));
  const slots = candidates.filter((time) => hasMinimumNotice(date, time) && occupiedKeys(date, time, duration).every((key) => !occupied.has(key)));
  return Response.json({ slots });
}

export async function POST(request: Request) {
  let reservationKey = "";
  let database: ReturnType<typeof supabaseConfig> = null;
  try {
    const body = await request.json() as Payload;
    const name = body.name?.trim() ?? "", email = body.email?.trim().toLowerCase() ?? "", phone = body.phone?.trim() ?? "", category = body.category ?? "", date = body.date ?? "", time = body.time ?? "", notes = body.notes?.trim() ?? "", duration = Number(body.duration);
    const validSlot = datePattern.test(date) && slotsForDate(date, duration).includes(time) && hasMinimumNotice(date, time);
    if (!name || !email.includes("@") || !phone || !allowedCategories.has(category) || !validSlot || body.consent !== "accepted" || !prices[duration]) return Response.json({ error: "Revisa los datos y recuerda reservar con un mínimo de 24 horas de antelación." }, { status: 400 });
    database = supabaseConfig();
    if (!database) return Response.json({ error: "La agenda todavía no tiene conectada su base de datos." }, { status: 503 });
    const stripeSecret = process.env.STRIPE_SECRET_KEY;
    if (!stripeSecret) return Response.json({ error: "El pago seguro todavía no está activado. Contacta con Tarot Luna." }, { status: 503 });

    reservationKey = crypto.randomUUID();
    const response = await fetch(`${database.url}/rest/v1/rpc/create_reservation`, { method: "POST", headers: headers(database.key), body: JSON.stringify({ p_reservation_key: reservationKey, p_name: name, p_email: email, p_phone: phone, p_category: category, p_duration: duration, p_date: date, p_time: time, p_notes: notes.slice(0, 800), p_slot_keys: occupiedKeys(date, time, duration) }) });
    if (!response.ok) {
      const detail = await response.text();
      if (response.status === 409 || detail.includes("23505") || detail.includes("duplicate key") || detail.includes("Franja no disponible")) return Response.json({ error: "Esa franja acaba de ocuparse. Elige otra hora." }, { status: 409 });
      throw new Error(detail);
    }

    const origin = (process.env.PUBLIC_SITE_URL?.replace(/\/$/, "") || new URL(request.url).origin).replace(/^http:/, "https:");
    const stripe = new Stripe(stripeSecret);
    const session = await stripe.checkout.sessions.create({
      mode: "payment", payment_method_types: ["bizum"], locale: "es", customer_email: email,
      client_reference_id: reservationKey, metadata: { reservation_key: reservationKey },
      line_items: [{ quantity: 1, price_data: { currency: "eur", unit_amount: prices[duration], product_data: { name: `Consulta Tarot Luna — ${duration} minutos`, description: `${date} a las ${time}` } } }],
      success_url: `${origin}/pago/correcto?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${origin}/pago/cancelado`, expires_at: Math.floor(Date.now() / 1000) + 30 * 60,
    }, { idempotencyKey: reservationKey });

    if (!session.url) throw new Error("Stripe no devolvió una dirección de pago");
    const orderUpdate = await fetch(`${database.url}/rest/v1/reservations?reservation_key=eq.${reservationKey}&status=eq.pending_payment`, {
      method: "PATCH", headers: { ...headers(database.key), Prefer: "return=representation" },
      body: JSON.stringify({ payment_order: session.id, payment_provider: "stripe_bizum" }),
    });
    if (!orderUpdate.ok) throw new Error(await orderUpdate.text());
    return Response.json({ ok: true, reservationKey, payment: { url: session.url } }, { status: 201 });
  } catch (error) {
    if (database && reservationKey) await failPendingReservation(database, reservationKey, "stripe_session_error");
    const message = error instanceof Error ? error.message : "Error inesperado";
    if (message.includes("UNIQUE") || message.includes("booked_slots") || message.includes("reservation_slot_unique")) return Response.json({ error: "Esa franja acaba de ocuparse. Elige otra hora." }, { status: 409 });
    return Response.json({ error: "No se pudo preparar el pago seguro. Inténtalo de nuevo." }, { status: 500 });
  }
}
