import { cn } from "@/lib/utils";

export function Brand({ compact = false }: { compact?: boolean }) {
  return (
    <div className="flex items-center gap-3">
      <div className="relative grid size-11 place-items-center" aria-hidden="true">
        <div className="absolute inset-0 rotate-45 border border-primary/25" />
        <div className="absolute inset-[5px] rotate-45 border border-secondary/20" />
        <div className="absolute bottom-2 h-7 w-[5px] bg-gradient-to-t from-secondary via-primary to-[#fff2bb] shadow-[0_0_22px_rgba(255,194,71,.45)]" />
        <div className="absolute bottom-2 h-px w-7 bg-primary/50" />
      </div>
      <div className={cn(compact && "hidden sm:block")}>
        <div className="font-heading text-xl font-semibold leading-none tracking-[0.18em]">
          NEONHIVE
        </div>
        <div className="mt-1 font-mono text-[9px] uppercase tracking-[0.2em] text-primary/70">
          Signal intelligence / honeypots
        </div>
      </div>
    </div>
  );
}
