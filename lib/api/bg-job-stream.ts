/** Server-Sent Events untuk progress background job — fallback polling di client. */

import { NextResponse } from 'next/server';

const TERMINAL = new Set(['DONE', 'FAILED']);
const MAX_STREAM_MS = 55_000;
const POLL_MS = 1000;

export type JobStreamEvent = {
  id: string;
  type: string;
  status: string;
  result?: unknown;
  lastError?: unknown;
  progress?: unknown;
  createdAt?: unknown;
  finishedAt?: unknown;
};

export function serializeJobStreamEvent(job: Record<string, unknown>): JobStreamEvent {
  const result = job.result as Record<string, unknown> | null | undefined;
  return {
    id: String(job.id || ''),
    type: String(job.type || ''),
    status: String(job.status || ''),
    result: job.result,
    lastError: job.lastError,
    progress: job.progress ?? result?.progress ?? null,
    createdAt: job.createdAt,
    finishedAt: job.finishedAt,
  };
}

export function createBgJobStreamResponse(
  poll: () => Promise<Record<string, unknown> | null>,
): NextResponse {
  const encoder = new TextEncoder();
  let closed = false;

  const stream = new ReadableStream({
    async start(controller) {
      const started = Date.now();
      try {
        while (!closed && Date.now() - started < MAX_STREAM_MS) {
          const job = await poll();
          if (!job) {
            controller.enqueue(encoder.encode(
              `event: error\ndata: ${JSON.stringify({ error: 'Job tidak ditemukan' })}\n\n`,
            ));
            break;
          }
          const payload = serializeJobStreamEvent(job);
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
          if (TERMINAL.has(payload.status)) break;
          await new Promise((resolve) => setTimeout(resolve, POLL_MS));
        }
      } catch (e) {
        controller.enqueue(encoder.encode(
          `event: error\ndata: ${JSON.stringify({ error: e instanceof Error ? e.message : String(e) })}\n\n`,
        ));
      } finally {
        controller.close();
      }
    },
    cancel() {
      closed = true;
    },
  });

  return new NextResponse(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}
