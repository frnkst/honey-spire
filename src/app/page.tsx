import { redirect } from "next/navigation";
import { Dashboard } from "@/components/dashboard";
import { isAuthenticated } from "@/lib/auth";
import { getMapSensors } from "@/lib/beecons";
import { getDashboardData } from "@/lib/db";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  if (!(await isAuthenticated())) redirect("/login");
  const [data, sensors] = await Promise.all([
    getDashboardData("24h"),
    getMapSensors(),
  ]);
  return <Dashboard initialData={{ ...data, sensors }} />;
}
