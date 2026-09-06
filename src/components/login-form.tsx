"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { LoaderCircle, LockKeyhole } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export function LoginForm() {
  const router = useRouter();
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setError("");
    const data = new FormData(event.currentTarget);
    const response = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        username: data.get("username"),
        password: data.get("password"),
      }),
    });
    setSubmitting(false);
    if (!response.ok) {
      setError(
        response.status === 429
          ? "Too many attempts. Try again shortly."
          : "Invalid username or password.",
      );
      return;
    }
    router.replace("/");
    router.refresh();
  }

  return (
    <form className="space-y-5" onSubmit={submit}>
      <div className="space-y-2.5">
        <Label className="data-label" htmlFor="username">Operator ID</Label>
        <Input
          autoComplete="username"
          className="h-11 rounded-sm border-white/10 bg-black/20 px-3 font-mono focus-visible:border-primary/60 focus-visible:ring-primary/15"
          id="username"
          name="username"
          placeholder="admin"
          required
        />
      </div>
      <div className="space-y-2.5">
        <Label className="data-label" htmlFor="password">Access key</Label>
        <Input
          autoComplete="current-password"
          className="h-11 rounded-sm border-white/10 bg-black/20 px-3 font-mono focus-visible:border-primary/60 focus-visible:ring-primary/15"
          id="password"
          name="password"
          placeholder="••••••••••••"
          required
          type="password"
        />
      </div>
      {error ? (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      ) : null}
      <Button className="h-11 w-full rounded-sm font-mono text-xs uppercase tracking-[.14em]" disabled={submitting} type="submit">
        {submitting ? (
          <LoaderCircle className="animate-spin" />
        ) : (
          <LockKeyhole />
        )}
        Enter dashboard
      </Button>
    </form>
  );
}
