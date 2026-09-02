import Link from "next/link";
import { SiteShell } from "@/components/site-shell";

export default function PaymentCancelledPage() {
  return <SiteShell><main className="simple-page"><section className="success-card"><h1>El pago no se ha completado</h1><p>La cita no está confirmada. Puedes volver a reservar y realizar el pago de nuevo.</p><Link className="primary-button" href="/reservar">Volver a reservar</Link></section></main></SiteShell>;
}
