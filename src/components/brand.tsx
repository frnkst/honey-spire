import { Hexagon } from "lucide-react";
import { cn } from "@/lib/utils";

export function Brand({ compact = false }: { compact?: boolean }) {
  return (
    <div className="flex items-center gap-3">
      <div className="relative grid size-10 place-items-center">
        <Hexagon className="absolute size-10 text-primary/40" strokeWidth={1} />
        <div className="h-6 w-2.5 rounded-t-full bg-gradient-to-t from-secondary to-primary shadow-[0_0_20px_rgba(242,201,76,.35)]" />
      </div>
      <div className={cn(compact && "hidden sm:block")}>
        <div className="font-heading text-lg font-semibold tracking-[0.16em]">
          HONEY SPIRE
        </div>
        <div className="text-[10px] uppercase tracking-[0.22em] text-muted-foreground">
          SSH threat intelligence
        </div>
      </div>
    </div>
  );
}
