import { occupiedKeys } from "@/lib/schedule";
import { decodeMerchantParameters, getRedsysConfig, isApprovedResponse, parameter, REDSYS_SIGNATURE_VERSION, verifyRedsysSignature } from "@/lib/redsys";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function supabaseConfig() {
  const url = process.env.SUPABASE_URL?.replace(/\/$/, "");
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  return url && key ? { url, key } : null;
}

function dbHeaders(key: string) {
  return { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" };
}

export async function POST(request: Request) {
  try {
    const redsys = getRedsysConfig(), database = supabaseConfig();
    if (!redsys || !database) return new Response("Configuración incompleta", { status: 503 });
    const form = await request.formData();
    const signatureVersion = String(form.get("Ds_SignatureVersion") ?? form.get("DS_SIGNATUREVERSION") ?? "");
    const encoded = String(form.get("Ds_MerchantParameters") ?? form.get("DS_MERCHANTPARAMETERS") ?? "");
    const signature = String(form.get("Ds_Signature") ?? form.get("DS_SIGNATURE") ?? "");
    if (signatureVersion !== REDSYS_SIGNATURE_VERSION || !encoded || !signature) return new Response("Petición no válida", { status: 400 });

    const params = decodeMerchantParameters(encoded);
    const order = parameter(params, "Ds_Order");
    if (!order || !verifyRedsysSignature(encoded, signature, order, redsys.secretKey)) return new Response("Firma no válida", { status: 400 });

    const merchantCode = parameter(params, "Ds_MerchantCode");
    const terminal = parameter(params, "Ds_Terminal");
    const amount = parameter(params, "Ds_Amount");
    const currency = parameter(params, "Ds_Currency");
    const transactionType = parameter(params, "Ds_TransactionType");
    const responseCode = parameter(params, "Ds_Response");
    if (merchantCode !== redsys.merchantCode || Number(terminal) !== Number(redsys.terminal) || currency !== "978" || transactionType !== "0") {
      return new Response("Datos de comercio no válidos", { status: 400 });
    }

    const query = new URLSearchParams({ select: "reservation_key,name,email,duration,amount_cents,appointment_date,appointment_time,status", payment_order: `eq.${order}`, limit: "1" });
    const reservationResponse = await fetch(`${database.url}/rest/v1/reservations?${query}`, { headers: dbHeaders(database.key), cache: "no-store" });
    if (!reservationResponse.ok) return new Response("Error de base de datos", { status: 502 });
    const rows = await reservationResponse.json() as Array<{ reservation_key: string; name: string; email: string; duration: number; amount_cents: number; appointment_date: string; appointment_time: string; status: string }>;
    const reservation = rows[0];
    if (!reservation || String(reservation.amount_cents) !== amount) return new Response("Pedido o importe no válido", { status: 400 });
    if (reservation.status === "paid") return new Response("OK", { status: 200 });

    const rpc = isApprovedResponse(responseCode) ? "confirm_paid_reservation" : "fail_reservation_payment";
    const body = isApprovedResponse(responseCode)
      ? { p_reservation_key: reservation.reservation_key, p_payment_order: order, p_response_code: responseCode, p_slot_keys: occupiedKeys(reservation.appointment_date, reservation.appointment_time.slice(0, 5), reservation.duration) }
      : { p_reservation_key: reservation.reservation_key, p_response_code: responseCode || "UNKNOWN" };
    const update = await fetch(`${database.url}/rest/v1/rpc/${rpc}`, { method: "POST", headers: dbHeaders(database.key), body: JSON.stringify(body) });
    if (!update.ok) return new Response("No se pudo conciliar el pago", { status: 500 });

    if (isApprovedResponse(responseCode) && process.env.RESEND_API_KEY) {
      const dateTime = `${reservation.appointment_date} a las ${reservation.appointment_time.slice(0, 5)}`;
      await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          from: process.env.RESERVATION_FROM_EMAIL ?? "Tarot Luna <reservas@resend.dev>",
          to: [reservation.email, "lunatarotista211@gmail.com"],
          subject: `Pago confirmado — reserva ${order}`,
          text: `Hola ${reservation.name}. El pago de tu reserva ha sido confirmado.\n\nCita: ${dateTime}\nDuración: ${reservation.duration} minutos\nPedido: ${order}\n\nTarot Luna`,
        }),
      }).catch(() => undefined);
    }
    return new Response("OK", { status: 200 });
  } catch {
    return new Response("Notificación no procesada", { status: 400 });
  }
}
