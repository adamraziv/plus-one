import { StructuredOutputProcessor } from '@mastra/core/processors';
import { z } from 'zod';
import { describe, expect, it, vi } from 'vitest';

describe('Mastra structured output patch', () => {
  it('does not abort when the structurer emits after its controller closes', async () => {
    const processor = new StructuredOutputProcessor({
      schema: z.object({ answer: z.string() }) as never,
      model: { id: 'provider/model-a' } as never,
      errorStrategy: 'strict',
    });
    const structuringProcessor = processor as unknown as {
      getStructuringStream: () => Promise<{ fullStream: AsyncIterable<unknown> }>;
    };
    vi.spyOn(structuringProcessor, 'getStructuringStream').mockResolvedValue({
      fullStream: (async function* () {
        yield { type: 'object-result', runId: 'run_01', from: 'AGENT', object: { answer: '42' } };
      })(),
    });

    let controller: TransformStreamDefaultController<unknown> | undefined;
    const stream = new TransformStream<unknown, unknown>({
      start(value) {
        controller = value;
      },
    });
    await stream.writable.getWriter().close();
    const abort = vi.fn();

    await processor.processOutputStream({
      part: { type: 'finish' },
      state: { controller },
      streamParts: [],
      abort,
    } as never);

    expect(abort).not.toHaveBeenCalled();
  });
});
