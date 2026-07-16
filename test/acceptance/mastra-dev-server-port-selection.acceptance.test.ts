import { afterEach, describe, expect, it } from 'vitest';
import { startMastraDevServer } from '../helpers/mastra-dev-server.js';

describe('Mastra dev server helper acceptance', () => {
  let server: Awaited<ReturnType<typeof startMastraDevServer>> | undefined;

  afterEach(async () => {
    await server?.stop();
    server = undefined;
  });

  it('returns the actual base URL for the allocated test port', async () => {
    server = await startMastraDevServer({
      rejectOutput: [
        /Peer dependency version mismatch detected/,
        /ERR_MODULE_NOT_FOUND/,
      ],
    });

    const match = server.output().match(/Studio:\s+http:\/\/localhost:(\d+)/i);
    expect(match?.[1]).toBeDefined();
    expect(server.baseUrl).toBe(`http://127.0.0.1:${match![1]}`);

    const response = await fetch(`${server.baseUrl}/plus-one/inbound`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });

    expect(response.status).not.toBe(404);
  }, 120_000);
});
