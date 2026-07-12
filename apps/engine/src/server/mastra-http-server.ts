import { serve, type ServerType } from '@hono/node-server';
import type { Mastra } from '@mastra/core';
import { MastraServer, type HonoBindings, type HonoVariables } from '@mastra/hono';
import { Hono } from 'hono';

type GatewayApp = Hono<{ Bindings: HonoBindings; Variables: HonoVariables }>;

export interface MastraHttpServerHandle {
  close(): Promise<void>;
}

export async function startMastraHttpServer(
  input: {
    mastra: Mastra;
    host: string;
    port: number;
    isReady: () => boolean;
  },
  dependencies: {
    initializeMastra?: (app: GatewayApp, mastra: Mastra) => Promise<void>;
    listen?: typeof serve;
  } = {},
): Promise<MastraHttpServerHandle> {
  const app: GatewayApp = new Hono();
  app.get('/health/live', (context) => context.json({ status: 'live' }));
  app.get('/health/ready', (context) => input.isReady()
    ? context.json({ status: 'ready' })
    : context.json({ status: 'starting' }, 503));

  await (dependencies.initializeMastra ?? initializeMastra)(app, input.mastra);
  const listen = dependencies.listen ?? serve;
  let nodeServer!: ServerType;
  nodeServer = await new Promise<ServerType>((resolve, reject) => {
    const server = listen({
      fetch: app.fetch,
      hostname: input.host,
      port: input.port,
    }, () => resolve(server));
    server.once('error', reject);
  });

  return {
    close: async () => new Promise<void>((resolve, reject) => {
      nodeServer.close((error?: Error) => {
        if (error !== undefined) {
          reject(error);
          return;
        }
        resolve();
      });
    }),
  };
}

async function initializeMastra(app: GatewayApp, mastra: Mastra): Promise<void> {
  await new MastraServer({ app, mastra }).init();
}
