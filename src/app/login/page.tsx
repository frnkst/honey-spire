import { redirect } from "next/navigation";
import { Brand } from "@/components/brand";
import { LoginForm } from "@/components/login-form";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { isAuthenticated } from "@/lib/auth";

export const dynamic = "force-dynamic";

export default async function LoginPage() {
  if (await isAuthenticated()) redirect("/");
  return (
    <main className="hex-grid grid min-h-screen place-items-center px-4">
      <Card className="glass-card gold-glow w-full max-w-sm border-primary/20">
        <CardHeader className="items-center pb-2">
          <Brand />
          <p className="mt-4 text-center text-sm text-muted-foreground">
            Authenticate to access live honeypot telemetry.
          </p>
        </CardHeader>
        <CardContent>
          <LoginForm />
        </CardContent>
      </Card>
    </main>
  );
}
