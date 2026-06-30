import { afterEach, describe, expect, it } from 'vitest';
import { startMastraDevServer } from '../helpers/mastra-dev-server.js';

describe('Mastra dev server acceptance', () => {
  let server: Awaited<ReturnType<typeof startMastraDevServer>> | undefined;

  afterEach(async () => {
    await server?.stop();
    server = undefined;
  });

  it('boots from the workspace root without peer or module-resolution failures', async () => {
    server = await startMastraDevServer({
      rejectOutput: [
        /Peer dependency version mismatch detected/,
        /ERR_MODULE_NOT_FOUND/,
      ],
    });

    const port = new URL(server.baseUrl).port;
    expect(server.output()).toContain(`Studio: http://localhost:${port}`);
    expect(server.output()).toContain(`API:    http://localhost:${port}/api`);

    const prefixed = await fetch(`${server.baseUrl}/api/plus-one/inbound`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    const root = await fetch(`${server.baseUrl}/plus-one/inbound`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });

    expect(prefixed.status).toBe(404);
    expect(root.status).not.toBe(404);
  }, 120_000);
});
