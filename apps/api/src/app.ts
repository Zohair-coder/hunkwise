import path from 'node:path';
import { timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import helmet from '@fastify/helmet';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance } from 'fastify';
import {
  createGitLabInstanceSchema,
  createDiffDiscussionSchema,
  createOverviewDiscussionSchema,
  replyDiscussionSchema,
  paginationSchema,
  submitReviewSchema,
  updateDiscussionResolutionSchema,
  updateGitLabInstanceSchema
} from '@hunkwise/contracts';
import type { HunkwiseStore, SecretCipher, UpdateInstanceRecord } from '@hunkwise/db';
import { ZodError } from 'zod';
import { GitLabClientError } from './gitlab-client.js';
import { GitLabReviewServiceError } from './gitlab-review-service.js';
import type { GitLabReviewActions } from './gitlab-review-service.js';
import { MergeRequestUrlError } from './gitlab-url.js';

export interface AppDependencies {
  store: HunkwiseStore;
  cipher: SecretCipher;
  gitlabReview: GitLabReviewActions;
  gitlabWebhookSecret?: string;
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
  if (typeof value.id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value.id)) {
    throw new HttpError(400, 'invalid_request', 'A valid UUID is required');
  }
  return value.id;
};

const isPgUniqueViolation = (error: unknown): boolean =>
  typeof error === 'object' && error !== null && 'code' in error && error.code === '23505';

type FastifyClientError = Error & { code?: string; statusCode?: number };
const isFastifyClientError = (error: unknown): error is FastifyClientError => error instanceof Error;

const webhookTokenMatches = (actual: string | undefined, expected: string | undefined): boolean => {
  if (!expected || !actual) return false;
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
};

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
    } else if (error instanceof MergeRequestUrlError) {
      statusCode = 400;
      code = error.code;
      message = error.message;
    } else if (error instanceof GitLabClientError) {
      statusCode = error.statusCode ?? 502;
      code = error.code;
      message = error.message;
    } else if (error instanceof GitLabReviewServiceError) {
      statusCode = error.code === 'instance_not_found' || error.code === 'review_not_found' || error.code === 'discussion_not_found' ? 404 : 400;
      code = error.code;
      message = error.message;
    } else if (isPgUniqueViolation(error)) {
      statusCode = 409;
      code = 'conflict';
      message = 'A resource with these values already exists';
    } else if (isFastifyClientError(error) && error.code === 'FST_ERR_CTP_INVALID_JSON_BODY') {
      statusCode = 400;
      code = 'invalid_json';
      message = 'Request body contains malformed JSON';
    } else if (isFastifyClientError(error) && (error.code === 'FST_ERR_CTP_BODY_TOO_LARGE' || error.statusCode === 413)) {
      statusCode = 413;
      code = 'payload_too_large';
      message = 'Request body exceeds the 1 MiB limit';
    } else if (isFastifyClientError(error) && error.statusCode !== undefined && error.statusCode >= 400 && error.statusCode < 500) {
      statusCode = error.statusCode;
      code = 'bad_request';
      message = statusCode === 400 ? 'Bad request' : error.message;
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
      return reply.status(503).send({
        error: {
          code: 'dependency_unavailable',
          message: 'PostgreSQL is unavailable',
          details: { checks: { database: 'unavailable' } },
          requestId: _request.id
        }
      });
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
  app.post('/api/instances/:id/test', async (request) => dependencies.gitlabReview.testInstance(idParams(request.params)));

  app.get('/api/reviews', async (request) => dependencies.store.listReviews(paginationSchema.parse(request.query)));
  app.get('/api/reviews/:id', async (request) => {
    const review = await dependencies.store.getReview(idParams(request.params));
    if (!review) throw new HttpError(404, 'not_found', 'Review run not found');
    return review;
  });
  app.post('/api/reviews', async (request, reply) => {
    const input = submitReviewSchema.parse(request.body);
    const result = await dependencies.gitlabReview.submit(input);
    return reply.status(202).send(result);
  });
  app.post('/api/reviews/:id/refresh', async (request, reply) => {
    const result = await dependencies.gitlabReview.refresh(idParams(request.params));
    return reply.status(202).send(result);
  });
  app.post('/api/reviews/:id/gitlab/discussions', async (request, reply) => {
    const result = await dependencies.gitlabReview.addOverviewDiscussion(idParams(request.params), createOverviewDiscussionSchema.parse(request.body));
    return reply.status(201).send(result);
  });
  app.post('/api/reviews/:id/gitlab/diff-discussions', async (request, reply) => {
    const result = await dependencies.gitlabReview.addDiffDiscussion(idParams(request.params), createDiffDiscussionSchema.parse(request.body));
    return reply.status(201).send(result);
  });
  app.post('/api/gitlab/discussions/:id/notes', async (request, reply) => {
    const result = await dependencies.gitlabReview.replyToDiscussion(idParams(request.params), replyDiscussionSchema.parse(request.body).body);
    return reply.status(201).send(result);
  });
  app.put('/api/gitlab/discussions/:id/resolution', async (request) =>
    dependencies.gitlabReview.setDiscussionResolved(idParams(request.params), updateDiscussionResolutionSchema.parse(request.body).resolved)
  );
  app.post('/api/webhooks/gitlab/:id', async (request, reply) => {
    if (!dependencies.gitlabWebhookSecret) throw new HttpError(503, 'webhook_not_configured', 'GitLab webhook secret is not configured');
    const supplied = request.headers['x-gitlab-token'];
    if (!webhookTokenMatches(typeof supplied === 'string' ? supplied : undefined, dependencies.gitlabWebhookSecret)) {
      throw new HttpError(401, 'invalid_webhook_token', 'GitLab webhook token is invalid');
    }
    const eventType = typeof request.headers['x-gitlab-event'] === 'string' ? request.headers['x-gitlab-event'] : 'unknown';
    const eventKey = typeof request.headers['x-gitlab-event-uuid'] === 'string' ? request.headers['x-gitlab-event-uuid'] : null;
    const result = await dependencies.gitlabReview.handleWebhook(idParams(request.params), eventType, eventKey, request.body);
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
