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
  assert.equal('reply_markup' in calls[0].body, false, 'no reply_markup key when none was supplied');
}

// --- createAlertEnvelope: replyMarkup carried through ---
{
  const replyMarkup = { inline_keyboard: [[{ text: '✅ I took this trade', callback_data: 'register_trade:abc123' }]] };
  const withMarkup = createAlertEnvelope({ type: 'X', text: 'setup confirmed', replyMarkup });
  assert.deepEqual(withMarkup.replyMarkup, replyMarkup);

  const withoutMarkup = createAlertEnvelope({ type: 'X', text: 'no button here' });
  assert.equal('replyMarkup' in withoutMarkup, false, 'envelopes without a replyMarkup should not carry the key at all');
}

// --- TelegramAlertTransport: reply_markup posted on a single-chunk message, message_id captured ---
{
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body) });
    return { ok: true, json: async () => ({ ok: true, result: { message_id: 4242 } }) };
  };
  const transport = new TelegramAlertTransport({ botToken: 'tok', chatId: '123', fetchImpl });
  const replyMarkup = { inline_keyboard: [[{ text: '✅ I took this trade', callback_data: 'register_trade:abc123' }]] };
  const envelope = createAlertEnvelope({ type: 'X', text: 'setup confirmed', replyMarkup });
  const result = await transport.send(envelope);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].body.reply_markup, replyMarkup);
  assert.equal(result.message_id, 4242);
}

// --- TelegramAlertTransport: reply_markup only attaches to the LAST chunk when text is chunked ---
{
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body) });
    return { ok: true, json: async () => ({ ok: true, result: { message_id: calls.length } }) };
  };
  const transport = new TelegramAlertTransport({ botToken: 'tok', chatId: '123', fetchImpl });
  const replyMarkup = { inline_keyboard: [[{ text: '✅ Confirm closed', callback_data: 'close_trade:xyz789' }]] };
  const envelope = createAlertEnvelope({ type: 'X', text: 'a'.repeat(9000), replyMarkup });
  const result = await transport.send(envelope);
  assert.ok(calls.length > 1, 'long text should still be chunked');
  for (let i = 0; i < calls.length - 1; i += 1) {
    assert.equal('reply_markup' in calls[i].body, false, 'only the last chunk may carry the button');
  }
  assert.deepEqual(calls.at(-1).body.reply_markup, replyMarkup);
  assert.equal(result.message_id, calls.length, 'message_id captured from the final chunk response');
}

// --- TelegramAlertTransport: editMessageReplyMarkup ---
{
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body) });
    return { ok: true, json: async () => ({ ok: true }) };
  };
  const transport = new TelegramAlertTransport({ botToken: 'tok', chatId: '123', fetchImpl });
  const result = await transport.editMessageReplyMarkup(4242, { inline_keyboard: [[{ text: '✅ Registered', callback_data: 'noop' }]] });
  assert.equal(result.ok, true);
  assert.equal(calls[0].url, 'https://api.telegram.org/bottok/editMessageReplyMarkup');
  assert.equal(calls[0].body.chat_id, '123');
  assert.equal(calls[0].body.message_id, 4242);
  assert.deepEqual(calls[0].body.reply_markup, { inline_keyboard: [[{ text: '✅ Registered', callback_data: 'noop' }]] });

  // Passing no replyMarkup clears the keyboard.
  const cleared = await transport.editMessageReplyMarkup(4242);
  assert.deepEqual(calls[1].body.reply_markup, { inline_keyboard: [] });
  assert.equal(cleared.ok, true);
}

// --- TelegramAlertTransport: answerCallbackQuery ---
{
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body) });
    return { ok: true, json: async () => ({ ok: true }) };
  };
  const transport = new TelegramAlertTransport({ botToken: 'tok', chatId: '123', fetchImpl });
  const result = await transport.answerCallbackQuery('cbq-1', { text: 'Trade registered.' });
  assert.equal(result.ok, true);
  assert.equal(calls[0].url, 'https://api.telegram.org/bottok/answerCallbackQuery');
  assert.equal(calls[0].body.callback_query_id, 'cbq-1');
  assert.equal(calls[0].body.text, 'Trade registered.');

  const bare = await transport.answerCallbackQuery('cbq-2');
  assert.equal('text' in calls[1].body, false, 'text is omitted when not supplied');
}

console.log('trading-telegram-alerts: all tests passed');
