import { redirect } from "next/navigation";
import { Brand } from "@/components/brand";
import { LoginForm } from "@/components/login-form";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { isAuthenticated } from "@/lib/auth";

export const dynamic = "force-dynamic";

export default async function LoginPage() {
  if (await isAuthenticated()) redirect("/");
  return (
    <main className="threat-field grid min-h-screen lg:grid-cols-[1.2fr_.8fr]">
      <section className="relative hidden min-h-screen overflow-hidden border-r border-white/[.06] p-12 lg:flex lg:flex-col lg:justify-between">
        <div className="scan-line" />
        <Brand />
        <div className="max-w-2xl">
          <p className="data-label mb-5 text-primary">Restricted telemetry node</p>
          <h1 className="font-heading text-[clamp(4rem,7vw,7.5rem)] font-semibold uppercase leading-[.78] tracking-[-.035em]">
            Observe
            <br />
            the noise.
          </h1>
          <p className="mt-8 max-w-lg text-base leading-7 text-muted-foreground">
            A live field instrument for hostile SSH traffic—source signals,
            credential patterns, fingerprints, and shell activity.
          </p>
        </div>
        <div className="flex items-center justify-between border-t border-white/[.08] pt-5">
          <span className="data-label">Node nh-01</span>
          <span className="data-label text-secondary">Encrypted operator access</span>
        </div>
      </section>

      <section className="relative grid min-h-screen place-items-center px-5 py-10 sm:px-10">
        <div className="absolute left-5 top-6 lg:hidden">
          <Brand />
        </div>
        <Card className="glass-card instrument-card reveal w-full max-w-md border-white/[.08] py-7">
          <CardHeader className="gap-4 px-6 sm:px-8">
            <div className="flex items-center justify-between">
              <span className="section-index">AUTH / 01</span>
              <span className="size-2 rounded-full bg-primary shadow-[0_0_16px_rgba(255,194,71,.65)]" />
            </div>
            <div>
              <h2 className="font-heading text-4xl font-semibold uppercase leading-none tracking-tight">
                Operator login
              </h2>
              <p className="mt-3 max-w-xs text-sm leading-6 text-muted-foreground">
                Authenticate to enter the live threat observatory.
              </p>
            </div>
          </CardHeader>
          <CardContent className="px-6 sm:px-8">
            <LoginForm />
          </CardContent>
        </Card>
      </section>
    </main>
  );
}
