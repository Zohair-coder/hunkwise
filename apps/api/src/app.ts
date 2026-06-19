import path from 'node:path';
import { fileURLToPath } from 'node:url';
import helmet from '@fastify/helmet';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance } from 'fastify';
import {
  createGitLabInstanceSchema,
  paginationSchema,
  submitReviewSchema,
  updateGitLabInstanceSchema
} from '@hunkwise/contracts';
import type { HunkwiseStore, SecretCipher, UpdateInstanceRecord } from '@hunkwise/db';
import { ZodError } from 'zod';
import type { GitLabGateway, ReviewEngine } from './services.js';
import { DownstreamUnavailableError } from './services.js';

export interface AppDependencies {
  store: HunkwiseStore;
  cipher: SecretCipher;
  gitlab: GitLabGateway;
  reviewEngine: ReviewEngine;
}

export interface BuildAppOptions {
  logger?: boolean | Record<string, unknown>;
  serveFrontend?: boolean;
  webDistDir?: string;
}

class HttpError extends Error {
  constructor(readonly statusCode: number, readonly code: string, message: string) {
    super(message);
  }
}

const idParams = (params: unknown): string => {
  const value = params as { id?: unknown };
  if (typeof value.id !== 'string' || !/^[0-9a-f-]{36}$/i.test(value.id)) {
    throw new HttpError(400, 'invalid_request', 'A valid UUID is required');
  }
  return value.id;
};

const isPgUniqueViolation = (error: unknown): boolean =>
  typeof error === 'object' && error !== null && 'code' in error && error.code === '23505';

export async function buildApp(dependencies: AppDependencies, options: BuildAppOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: options.logger ?? false,
    bodyLimit: 1024 * 1024,
    trustProxy: false,
    requestIdHeader: 'x-request-id',
    genReqId: (request) => {
      const supplied = request.headers['x-request-id'];
      return typeof supplied === 'string' && /^[A-Za-z0-9._-]{1,128}$/.test(supplied) ? supplied : crypto.randomUUID();
    }
  });

  await app.register(helmet);
  app.addHook('onSend', (request, reply, payload, done) => {
    void reply.header('x-request-id', request.id);
    done(null, payload);
  });

  app.setErrorHandler((error, request, reply) => {
    let statusCode = 500;
    let code = 'internal_error';
    let message = 'An unexpected error occurred';
    let details: unknown;
    if (error instanceof ZodError) {
      statusCode = 400;
      code = 'validation_error';
      message = 'Request validation failed';
      details = error.flatten();
    } else if (error instanceof HttpError) {
      statusCode = error.statusCode;
      code = error.code;
      message = error.message;
    } else if (error instanceof DownstreamUnavailableError) {
      statusCode = 501;
      code = 'integration_not_implemented';
      message = error.message;
    } else if (isPgUniqueViolation(error)) {
      statusCode = 409;
      code = 'conflict';
      message = 'A resource with these values already exists';
    } else {
      request.log.error({ err: error }, 'request failed');
    }
    void reply.status(statusCode).send({ error: { code, message, ...(details === undefined ? {} : { details }), requestId: request.id } });
  });

  app.get('/health/live', () => ({ status: 'ok', service: 'hunkwise-api' }));
  app.get('/health/ready', async (_request, reply) => {
    try {
      await dependencies.store.ping();
      return { status: 'ready', checks: { database: 'ok' } };
    } catch {
      return reply.status(503).send({ status: 'not_ready', checks: { database: 'unavailable' } });
    }
  });

  app.get('/api/instances', async () => ({ items: await dependencies.store.listInstances() }));
  app.get('/api/instances/:id', async (request) => {
    const instance = await dependencies.store.getInstance(idParams(request.params));
    if (!instance) throw new HttpError(404, 'not_found', 'GitLab instance not found');
    return instance;
  });
  app.post('/api/instances', async (request, reply) => {
    const input = createGitLabInstanceSchema.parse(request.body);
    const instance = await dependencies.store.createInstance({
      name: input.name,
      baseUrl: input.baseUrl,
      encryptedAccessToken: dependencies.cipher.encrypt(input.accessToken)
    });
    return reply.status(201).send(instance);
  });
  app.patch('/api/instances/:id', async (request) => {
    const input = updateGitLabInstanceSchema.parse(request.body);
    const update: UpdateInstanceRecord = {};
    if (input.name !== undefined) update.name = input.name;
    if (input.baseUrl !== undefined) update.baseUrl = input.baseUrl;
    if (input.accessToken !== undefined) update.encryptedAccessToken = dependencies.cipher.encrypt(input.accessToken);
    const instance = await dependencies.store.updateInstance(idParams(request.params), update);
    if (!instance) throw new HttpError(404, 'not_found', 'GitLab instance not found');
    return instance;
  });
  app.delete('/api/instances/:id', async (request, reply) => {
    if (!await dependencies.store.deleteInstance(idParams(request.params))) {
      throw new HttpError(404, 'not_found', 'GitLab instance not found');
    }
    return reply.status(204).send();
  });

  app.get('/api/reviews', async (request) => dependencies.store.listReviews(paginationSchema.parse(request.query)));
  app.get('/api/reviews/:id', async (request) => {
    const review = await dependencies.store.getReview(idParams(request.params));
    if (!review) throw new HttpError(404, 'not_found', 'Review run not found');
    return review;
  });
  app.post('/api/reviews', async (request, reply) => {
    const input = submitReviewSchema.parse(request.body);
    const instance = await dependencies.store.getInstance(input.instanceId);
    if (!instance) throw new HttpError(404, 'not_found', 'GitLab instance not found');
    const resolved = await dependencies.gitlab.resolveMergeRequest(instance, input.mergeRequestUrl);
    const result = await dependencies.reviewEngine.start(resolved);
    return reply.status(202).send(result);
  });

  if (options.serveFrontend) {
    const defaultRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../web/dist');
    const root = options.webDistDir ?? defaultRoot;
    await app.register(fastifyStatic, { root, wildcard: false });
    app.setNotFoundHandler((request, reply) => {
      if (request.method === 'GET' && !request.url.startsWith('/api/') && request.headers.accept?.includes('text/html')) {
        return reply.sendFile('index.html');
      }
      return reply.status(404).send({ error: { code: 'not_found', message: 'Route not found', requestId: request.id } });
    });
  } else {
    app.setNotFoundHandler((request, reply) =>
      reply.status(404).send({ error: { code: 'not_found', message: 'Route not found', requestId: request.id } })
    );
  }

  return app;
}
