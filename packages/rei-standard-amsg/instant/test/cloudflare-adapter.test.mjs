import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';

import { createInstantHandler } from '../src/index.js';
import { createCloudflareWorker } from '../src/adapters/cloudflare.js';
import { toNetlifyHandler } from '../src/adapters/netlify.js';
import { toVercelEdgeHandler } from '../src/adapters/vercel.js';
import { toNodeHandler } from '../src/adapters/node.js';
import {
  generateTestVapid,
  generateTestSubscription,
  createFetchRouter,
  makeLlmResponse,
} from './helpers.mjs';

const LLM_URL = 'https://api.example.com/v1/chat/completions';

let vapid;
let subKit;

before(async () => {
  vapid = await generateTestVapid();
  subKit = await generateTestSubscription();
});

// waitUntil lifecycle wiring is exercised on the pure-push opt-out path —
// the SSE branch keeps the response stream open by design and does not
// register a separate background work item.
function makeRequest(body) {
  return new Request('https://worker.example.com/instant', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(body),
  });
}

function makePayload() {
  return {
    contactName: 'Rei',
    completePrompt: 'say hi briefly',
    apiUrl: LLM_URL,
    apiKey: 'sk-test',
    primaryModel: 'model-x',
    pushSubscription: subKit.subscription,
  };
}

function makeRouter(content = 'hi.') {
  return createFetchRouter({
    pushEndpoint: subKit.subscription.endpoint,
    llm: async () => makeLlmResponse(content),
  });
}

describe('Cloudflare waitUntil lifecycle', () => {
  it('createCloudflareWorker forwards ExecutionContext.waitUntil to the instant handler', async () => {
    const router = makeRouter();
    const waitUntilPromises = [];
    const ctx = {
      waitUntil(work) {
        waitUntilPromises.push(work);
      },
    };
    const worker = createCloudflareWorker((env) => ({
      vapid: {
        email: env.VAPID_EMAIL,
        publicKey: env.VAPID_PUBLIC_KEY,
        privateKey: env.VAPID_PRIVATE_KEY,
      },
      fetch: router.fetch,
    }));

    const res = await worker.fetch(makeRequest(makePayload()), {
      VAPID_EMAIL: vapid.email,
      VAPID_PUBLIC_KEY: vapid.publicKey,
      VAPID_PRIVATE_KEY: vapid.privateKey,
    }, ctx);

    assert.equal(res.status, 200);
    assert.equal(waitUntilPromises.length, 1);
    const result = await waitUntilPromises[0];
    assert.equal(result.messagesSent, 1);
    assert.equal(router.pushCalls.length, 1);
  });

  it('waitUntil background work resolves after the handler maps failures to HTTP errors', async () => {
    const events = [];
    const waitUntilPromises = [];
    const worker = createCloudflareWorker((env) => ({
      vapid: {
        email: env.VAPID_EMAIL,
        publicKey: env.VAPID_PUBLIC_KEY,
        privateKey: env.VAPID_PRIVATE_KEY,
      },
      fetch: async () => new Response('upstream down', { status: 500 }),
      onEvent(event) {
        events.push(event);
      },
    }));

    const res = await worker.fetch(makeRequest(makePayload()), {
      VAPID_EMAIL: vapid.email,
      VAPID_PUBLIC_KEY: vapid.publicKey,
      VAPID_PRIVATE_KEY: vapid.privateKey,
    }, {
      waitUntil(work) {
        waitUntilPromises.push(work);
      },
    });

    assert.equal(res.status, 502);
    assert.equal(waitUntilPromises.length, 1);
    await assert.doesNotReject(waitUntilPromises[0]);
    assert.equal(await waitUntilPromises[0], undefined);
    assert.equal(events.some((event) => event.type === 'wait_until_rejected'), true);
  });

  it('direct Cloudflare module usage of createInstantHandler can read ctx from the third fetch arg', async () => {
    const router = makeRouter();
    const waitUntilPromises = [];
    const handler = createInstantHandler({ vapid, fetch: router.fetch });

    const res = await handler(makeRequest(makePayload()), {}, {
      waitUntil(work) {
        waitUntilPromises.push(work);
      },
    });

    assert.equal(res.status, 200);
    assert.equal(waitUntilPromises.length, 1);
    assert.equal((await waitUntilPromises[0]).messagesSent, 1);
  });
});

describe('adapter waitUntil lifecycle', () => {
  it('createInstantHandler can use options.waitUntil when no adapter context exists', async () => {
    const router = makeRouter();
    const waitUntilPromises = [];
    const handler = createInstantHandler({
      vapid,
      fetch: router.fetch,
      waitUntil(work) {
        waitUntilPromises.push(work);
      },
    });

    const res = await handler(makeRequest(makePayload()));

    assert.equal(res.status, 200);
    assert.equal(waitUntilPromises.length, 1);
    assert.equal((await waitUntilPromises[0]).messagesSent, 1);
  });

  it('toNetlifyHandler forwards context.waitUntil', async () => {
    const router = makeRouter();
    const waitUntilPromises = [];
    const handler = createInstantHandler({ vapid, fetch: router.fetch });
    const netlifyHandler = toNetlifyHandler(handler);

    const res = await netlifyHandler(makeRequest(makePayload()), {
      waitUntil(work) {
        waitUntilPromises.push(work);
      },
    });

    assert.equal(res.status, 200);
    assert.equal(waitUntilPromises.length, 1);
    assert.equal((await waitUntilPromises[0]).messagesSent, 1);
  });

  it('toVercelEdgeHandler forwards context.waitUntil when a runtime provides it', async () => {
    const router = makeRouter();
    const waitUntilPromises = [];
    const handler = createInstantHandler({ vapid, fetch: router.fetch });
    const vercelHandler = toVercelEdgeHandler(handler);

    const res = await vercelHandler(makeRequest(makePayload()), {
      waitUntil(work) {
        waitUntilPromises.push(work);
      },
    });

    assert.equal(res.status, 200);
    assert.equal(waitUntilPromises.length, 1);
    assert.equal((await waitUntilPromises[0]).messagesSent, 1);
  });

  it('toNodeHandler can inject a host waitUntil through adapter options', async () => {
    const router = makeRouter();
    const waitUntilPromises = [];
    const handler = createInstantHandler({ vapid, fetch: router.fetch });
    const nodeHandler = toNodeHandler(handler, {
      waitUntil(work) {
        waitUntilPromises.push(work);
      },
    });
    const { req, res, bodyText } = makeNodeRequestResponse(makePayload());

    await nodeHandler(req, res);

    assert.equal(res.statusCode, 200);
    assert.equal(JSON.parse(bodyText()).success, true);
    assert.equal(waitUntilPromises.length, 1);
    assert.equal((await waitUntilPromises[0]).messagesSent, 1);
  });
});

function makeNodeRequestResponse(body) {
  const rawBody = JSON.stringify(body);
  const req = Readable.from([Buffer.from(rawBody)]);
  req.method = 'POST';
  req.url = '/instant';
  req.headers = {
    host: 'localhost',
    'content-type': 'application/json',
    accept: 'application/json',
    'content-length': String(Buffer.byteLength(rawBody)),
  };
  req.socket = {};

  const chunks = [];
  const res = {
    statusCode: 200,
    headersSent: false,
    headers: {},
    setHeader(name, value) {
      this.headers[String(name).toLowerCase()] = String(value);
    },
    end(chunk) {
      if (chunk) chunks.push(Buffer.from(chunk));
      this.headersSent = true;
    },
  };

  return {
    req,
    res,
    bodyText() {
      return Buffer.concat(chunks).toString('utf8');
    },
  };
}
