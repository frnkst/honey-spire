import { isAuthenticated } from "@/lib/auth";
import { liveEvents } from "@/lib/live-events";
import type { AttackEvent, CommandEvent } from "@/lib/types";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  if (!(await isAuthenticated())) {
    return new Response("Unauthorized", { status: 401 });
  }

  const encoder = new TextEncoder();
  let cleanup = () => {};
  const stream = new ReadableStream({
    start(controller) {
      const sendAttack = (attack: AttackEvent) => {
        controller.enqueue(
          encoder.encode(`event: attack\ndata: ${JSON.stringify(attack)}\n\n`),
        );
      };
      const sendCommand = (command: CommandEvent) => {
        controller.enqueue(
          encoder.encode(`event: command\ndata: ${JSON.stringify(command)}\n\n`),
        );
      };
      const heartbeat = setInterval(() => {
        controller.enqueue(encoder.encode(": heartbeat\n\n"));
      }, 20_000);
      liveEvents.on("attack", sendAttack);
      liveEvents.on("command", sendCommand);
      cleanup = () => {
        clearInterval(heartbeat);
        liveEvents.off("attack", sendAttack);
        liveEvents.off("command", sendCommand);
      };
      request.signal.addEventListener("abort", cleanup, { once: true });
    },
    cancel() {
      cleanup();
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    },
  });
}
