import assert from 'node:assert/strict';
import { AlertDispatcher, createAlertEnvelope } from './alert-dispatcher.mjs';
import { chunkText, TelegramAlertTransport, buildConfiguredTransports } from './alert-transports.mjs';

// --- createAlertEnvelope ---
const envelope = createAlertEnvelope({ type: 'SPIKE_EVENT', text: 'BOOM 500 — SPIKE DETECTED', eventKey: 'boom500:spike:1' });
assert.equal(envelope.type, 'SPIKE_EVENT');
assert.equal(envelope.event_key, 'boom500:spike:1');
assert.throws(() => createAlertEnvelope({ type: '', text: 'x' }), /type is required/);
assert.throws(() => createAlertEnvelope({ type: 'X', text: '' }), /text is required/);

// --- chunkText ---
const short = chunkText('hello');
assert.deepEqual(short, ['hello']);
const long = chunkText('a'.repeat(9000));
assert.ok(long.length > 1, 'long text should be chunked');
assert.ok(long.every((chunk) => chunk.length <= 3800));

// --- AlertDispatcher: delivery + retry + dedup ---
class FlakyTransport {
  constructor(name, failTimes = 0) {
    this.name = name;
    this.remote = true;
    this.failTimes = failTimes;
    this.calls = 0;
  }
  async send() {
    this.calls += 1;
    if (this.calls <= this.failTimes) throw new Error('transient failure');
    return { ok: true };
  }
}

class MemoryStateStore {
  constructor() {
    this.state = {};
  }
  snapshot() {
    return this.state;
  }
  async mutate(fn) {
    fn(this.state);
  }
}

{
  const transport = new FlakyTransport('telegram', 1);
  const store = new MemoryStateStore();
  const dispatcher = new AlertDispatcher({
    transports: [transport],
    stateStore: store,
    retryDelaysMs: [0, 0, 0],
    sleepImpl: async () => {},
  });
  const env = createAlertEnvelope({ type: 'TEST', text: 'retry-me', eventKey: 'retry-test' });
  const result = await dispatcher.dispatch(env);
  assert.equal(result.delivered, true);
  assert.equal(transport.calls, 2, 'should retry once after the first failure');

  // Dispatching the same envelope again must be suppressed as a duplicate, not resent.
  const transport2 = new FlakyTransport('telegram', 0);
  const dispatcher2 = new AlertDispatcher({ transports: [transport2], stateStore: store });
  const result2 = await dispatcher2.dispatch(env);
  assert.equal(result2.delivered, true);
  assert.equal(transport2.calls, 0, 'duplicate envelope should not hit the transport again');
}

// --- buildConfiguredTransports ---
{
  const configured = buildConfiguredTransports({ TELEGRAM_BOT_TOKEN: 'tok', TELEGRAM_CHAT_ID: '123' });
  assert.ok(configured.some((t) => t instanceof TelegramAlertTransport));
  const unconfigured = buildConfiguredTransports({});
  assert.ok(!unconfigured.some((t) => t instanceof TelegramAlertTransport));
}

// --- TelegramAlertTransport: real send path with a mocked fetch ---
{
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body) });
    return { ok: true, json: async () => ({ ok: true }) };
  };
  const transport = new TelegramAlertTransport({ botToken: 'tok', chatId: '123', fetchImpl });
  const result = await transport.send(createAlertEnvelope({ type: 'X', text: 'hello world' }));
  assert.equal(result.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.telegram.org/bottok/sendMessage');
  assert.equal(calls[0].body.chat_id, '123');
  assert.equal(calls[0].body.text, 'hello world');
}

console.log('trading-telegram-alerts: all tests passed');
