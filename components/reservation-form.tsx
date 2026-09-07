"use client";
import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { CalendarDays, CheckCircle2, CreditCard, Mail, MessageCircle } from "lucide-react";

const categoryLabels: Record<string, string> = { amor: "Amor", trabajo: "Trabajo", economia: "Economía", familia: "Familia", general: "General" };
function minimumDateValue() { const date = new Date(); date.setHours(date.getHours() + 24); return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`; }

export function ReservationForm() {
  const params = useSearchParams();
  const [minimumDate] = useState(() => minimumDateValue());
  const [date, setDate] = useState(minimumDate), [duration, setDuration] = useState("30");
  const [slots, setSlots] = useState<string[]>([]), [selectedTime, setSelectedTime] = useState("");
  const [loadingSlots, setLoadingSlots] = useState(true);
  const [status, setStatus] = useState<"idle" | "sending" | "success" | "error">("idle");
  const [message, setMessage] = useState(""), [reservationCode, setReservationCode] = useState("");
  useEffect(() => { const controller = new AbortController(); fetch(`/api/reservas?date=${encodeURIComponent(date)}&duration=${duration}`, { signal: controller.signal }).then((response) => response.json()).then((result: { slots?: string[] }) => setSlots(result.slots ?? [])).catch((error) => { if (error.name !== "AbortError") setSlots([]); }).finally(() => setLoadingSlots(false)); return () => controller.abort(); }, [date, duration]);
  function changeDate(value: string) { setLoadingSlots(true); setSelectedTime(""); setDate(value); }
  function changeDuration(value: string) { setLoadingSlots(true); setSelectedTime(""); setDuration(value); }
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); setStatus("sending"); setMessage("");
    try {
      const response = await fetch("/api/reservas", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(Object.fromEntries(new FormData(event.currentTarget))) });
      const result = await response.json() as { error?: string; reservationKey?: string; payment?: { url: string } };
      if (!response.ok) throw new Error(result.error || "No se pudo registrar la solicitud.");
      setReservationCode(result.reservationKey ?? "");
      if (result.payment?.url) window.location.assign(result.payment.url); else setStatus("success");
    } catch (error) { setMessage(error instanceof Error ? error.message : "Ha ocurrido un error."); setStatus("error"); }
  }
  if (status === "success") return <div className="success-card"><CheckCircle2 /><h2>Reserva guardada</h2><p>La cita se confirmará únicamente cuando Stripe comunique el pago correcto.</p>{reservationCode && <p className="reservation-code"><span>Código de reserva</span><strong>{reservationCode}</strong></p>}<a className="primary-button" href="mailto:lunatarotista211@gmail.com"><Mail /> Contactar por correo</a></div>;
  return <form className="reservation-form" onSubmit={submit}>
    <div className="form-section"><div className="form-section-title"><span>1</span><div><h2>Elige tu consulta</h2><p>Selecciona el área y la duración.</p></div></div><div className="form-grid"><label>Tipo de consulta<select name="category" defaultValue={params.get("consulta") ?? "general"} required>{Object.entries(categoryLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><label>Duración y precio<select name="duration" value={duration} onChange={(event) => changeDuration(event.target.value)} required><option value="10">10 minutos — 10 € (exprés)</option><option value="30">30 minutos — 25 €</option><option value="60">60 minutos — 50 €</option></select></label></div></div>
    <div className="form-section"><div className="form-section-title"><span>2</span><div><h2>Elige día y hora</h2><p>Solo aparecen las franjas disponibles. Las reservas requieren al menos 24 horas de antelación.</p></div></div><label className="date-field">Fecha<input type="date" name="date" min={minimumDate} value={date} onChange={(event) => changeDate(event.target.value)} required /></label><input type="hidden" name="time" value={selectedTime} /><div className="slot-picker" aria-live="polite">{loadingSlots ? <p>Consultando disponibilidad…</p> : slots.length ? slots.map((slot) => <button type="button" key={slot} className={selectedTime === slot ? "slot-button selected" : "slot-button"} onClick={() => setSelectedTime(slot)}>{slot}</button>) : <p>No quedan horas disponibles para este día.</p>}</div></div>
    <div className="form-section"><div className="form-section-title"><span>3</span><div><h2>Tus datos</h2><p>Los usaremos únicamente para gestionar la reserva.</p></div></div><div className="form-grid"><label>Nombre y apellidos<input name="name" autoComplete="name" required /></label><label>Correo electrónico<input type="email" name="email" autoComplete="email" required /></label><label>Teléfono<input type="tel" name="phone" autoComplete="tel" required /></label><label className="full-field">Cuéntanos brevemente tu consulta<textarea name="notes" rows={4} maxLength={800} /></label></div><label className="consent"><input type="checkbox" name="consent" value="accepted" required /> Acepto la política de privacidad y el uso de mis datos para gestionar esta reserva.</label></div>
    <div className="payment-preview"><div><span className="payment-icon"><CreditCard /></span><div><h2>Pago seguro con Bizum</h2><p>Stripe procesará el pago. Tarot Luna no recibe ni almacena tus credenciales bancarias.</p></div></div><span className="pending-badge">Stripe</span></div>
    {status === "error" && <p className="form-error" role="alert">{message}</p>}<button className="primary-button submit-button" disabled={status === "sending" || !selectedTime}>{status === "sending" ? "Preparando pago…" : "Reservar y pagar con Bizum"}<CalendarDays /></button><p className="form-help"><MessageCircle /> La cita solo queda confirmada después de que Stripe valide el pago.</p>
  </form>;
}
