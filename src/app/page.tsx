import { redirect } from "next/navigation";
import { Dashboard } from "@/components/dashboard";
import { isAuthenticated } from "@/lib/auth";
import { getDashboardData } from "@/lib/db";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  if (!(await isAuthenticated())) redirect("/login");
  return <Dashboard initialData={getDashboardData("24h")} />;
}
