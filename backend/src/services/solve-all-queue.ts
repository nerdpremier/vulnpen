import {
  releaseAbortController,
  reserveAbortController,
} from "./agent-controller-registry";

export interface ReservedSolveTarget {
  sessionId: string;
  name: string;
  abortCtrl: AbortController;
}

export function reserveSolveTarget(
  sessionId: string,
  name: string,
): ReservedSolveTarget | null {
  const abortCtrl = reserveAbortController(sessionId);
  return abortCtrl ? { sessionId, name, abortCtrl } : null;
}

export async function runReservedSolveQueue(
  targets: ReservedSolveTarget[],
  limit: number,
  run: (target: ReservedSolveTarget) => Promise<void>,
): Promise<void> {
  const queue = [...targets];
  const workers = Array.from(
    { length: Math.min(limit, queue.length) },
    async () => {
      for (let next = queue.shift(); next; next = queue.shift()) {
        try {
          await run(next);
        } catch (error) {
          console.error(
            `[CTF] solve-all worker failed for ${next.sessionId} (${next.name}):`,
            error,
          );
        } finally {
          releaseAbortController(next.sessionId, next.abortCtrl);
        }
      }
    },
  );
  await Promise.all(workers);
}
