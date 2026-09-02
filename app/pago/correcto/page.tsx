import Link from "next/link";
import { CheckCircle2 } from "lucide-react";
import { SiteShell } from "@/components/site-shell";

export default function PaymentSuccessPage() {
  return <SiteShell><main className="simple-page"><section className="success-card"><CheckCircle2 /><h1>Pago recibido</h1><p>Estamos verificando la confirmación segura enviada directamente por el banco. Cuando termine, la cita quedará bloqueada definitivamente en la agenda.</p><Link className="primary-button" href="/">Volver al inicio</Link></section></main></SiteShell>;
}
