import { hasMinimumNotice, occupiedKeys, slotsForDate } from "@/lib/schedule";
import { encodeMerchantParameters, getRedsysConfig, redsysEndpoint, REDSYS_SIGNATURE_VERSION, signMerchantParameters } from "@/lib/redsys";
import { randomInt } from "node:crypto";

type Payload = { name?: string; email?: string; phone?: string; category?: string; duration?: string; date?: string; time?: string; notes?: string; consent?: string; paymentMethod?: string };
const allowedCategories = new Set(["amor", "trabajo", "economia", "familia", "general"]);
const datePattern = /^\d{4}-\d{2}-\d{2}$/;

function supabaseConfig() {
  const url = process.env.SUPABASE_URL?.replace(/\/$/, "");
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  return url && key ? { url, key } : null;
}

function headers(key: string) {
  return { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" };
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
  try {
    const body = await request.json() as Payload;
    const name = body.name?.trim() ?? "", email = body.email?.trim().toLowerCase() ?? "", phone = body.phone?.trim() ?? "", category = body.category ?? "", date = body.date ?? "", time = body.time ?? "", notes = body.notes?.trim() ?? "", duration = Number(body.duration), paymentMethod = body.paymentMethod ?? "card";
    const validSlot = datePattern.test(date) && slotsForDate(date, duration).includes(time) && hasMinimumNotice(date, time);
    if (!name || !email.includes("@") || !phone || !allowedCategories.has(category) || !validSlot || body.consent !== "accepted" || !["card", "bizum"].includes(paymentMethod)) return Response.json({ error: "Revisa los datos y recuerda reservar con un mínimo de 24 horas de antelación." }, { status: 400 });
    const config = supabaseConfig();
    if (!config) return Response.json({ error: "La agenda todavía no tiene conectada su base de datos. Puedes reservar mediante Google Forms." }, { status: 503 });
    const redsys = getRedsysConfig();
    if (!redsys) return Response.json({ error: "El pago seguro todavía no está activado. Contacta con Tarot Luna." }, { status: 503 });
    const reservationKey = crypto.randomUUID();
    const response = await fetch(`${config.url}/rest/v1/rpc/create_reservation`, { method: "POST", headers: headers(config.key), body: JSON.stringify({ p_reservation_key: reservationKey, p_name: name, p_email: email, p_phone: phone, p_category: category, p_duration: duration, p_date: date, p_time: time, p_notes: notes.slice(0, 800), p_slot_keys: occupiedKeys(date, time, duration) }) });
    if (!response.ok) {
      const detail = await response.text();
      if (response.status === 409 || detail.includes("duplicate key")) return Response.json({ error: "Esa franja acaba de ocuparse. Elige otra hora." }, { status: 409 });
      throw new Error(detail);
    }

    const order = `${String(Date.now()).slice(-11)}${randomInt(0, 10)}`;
    const orderUpdate = await fetch(`${config.url}/rest/v1/reservations?reservation_key=eq.${reservationKey}&status=eq.pending_payment`, {
      method: "PATCH", headers: { ...headers(config.key), Prefer: "return=representation" },
      body: JSON.stringify({ payment_order: order, payment_provider: paymentMethod === "bizum" ? "redsys_bizum" : "redsys_card" }),
    });
    if (!orderUpdate.ok) throw new Error(await orderUpdate.text());

    const origin = (process.env.PUBLIC_SITE_URL?.replace(/\/$/, "") || new URL(request.url).origin).replace(/^http:/, "https:");
    const amount = duration === 10 ? 1000 : duration === 30 ? 2500 : 5000;
    const merchantData: Record<string, string> = {
      DS_MERCHANT_ORDER: order,
      DS_MERCHANT_MERCHANTCODE: redsys.merchantCode,
      DS_MERCHANT_TERMINAL: redsys.terminal,
      DS_MERCHANT_CURRENCY: "978",
      DS_MERCHANT_TRANSACTIONTYPE: "0",
      DS_MERCHANT_AMOUNT: String(amount),
      DS_MERCHANT_MERCHANTURL: `${origin}/api/pagos/redsys/notificacion`,
      DS_MERCHANT_URLOK: `${origin}/pago/correcto`,
      DS_MERCHANT_URLKO: `${origin}/pago/cancelado`,
      DS_MERCHANT_MERCHANTNAME: "Tarot Luna",
      DS_MERCHANT_PRODUCTDESCRIPTION: `Consulta Tarot Luna - ${duration} minutos`,
      DS_MERCHANT_TITULAR: name.slice(0, 60),
    };
    if (paymentMethod === "bizum") merchantData.DS_MERCHANT_PAYMETHODS = "z";
    const merchantParameters = encodeMerchantParameters(merchantData);
    return Response.json({
      ok: true,
      reservationKey,
      payment: {
        url: redsysEndpoint(redsys.environment),
        signatureVersion: REDSYS_SIGNATURE_VERSION,
        merchantParameters,
        signature: signMerchantParameters(merchantParameters, order, redsys.secretKey),
      },
    }, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Error inesperado";
    if (message.includes("UNIQUE") || message.includes("booked_slots") || message.includes("reservation_slot_unique")) return Response.json({ error: "Esa franja acaba de ocuparse. Elige otra hora." }, { status: 409 });
    return Response.json({ error: "No se pudo registrar la reserva. Inténtalo de nuevo." }, { status: 500 });
  }
}
