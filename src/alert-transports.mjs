function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function chunkText(text, maxLength = 3800) {
  const input = String(text ?? '');
  if (input.length <= maxLength) return [input];
  const chunks = [];
  let remaining = input;
  while (remaining.length > maxLength) {
    let split = remaining.lastIndexOf('\n', maxLength);
    if (split < Math.floor(maxLength * 0.6)) split = remaining.lastIndexOf(' ', maxLength);
    if (split < Math.floor(maxLength * 0.6)) split = maxLength;
    chunks.push(remaining.slice(0, split).trimEnd());
    remaining = remaining.slice(split).trimStart();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

async function fetchWithTimeout(fetchImpl, url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

export class ConsoleAlertTransport {
  constructor({ logger = console.log } = {}) {
    this.name = 'console';
    this.remote = false;
    this.logger = logger;
  }

  async send(envelope) {
    this.logger(`\n[${envelope.type}] ${envelope.text}\n`);
    return { ok: true, transport: this.name, remote: false };
  }
}

export class GenericWebhookTransport {
  constructor({ url, fetchImpl = fetch, timeoutMs = 10_000, headers = {} } = {}) {
    if (!url) throw new Error('GenericWebhookTransport requires a URL.');
    this.name = 'webhook';
    this.remote = true;
    this.url = url;
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.headers = headers;
  }

  async send(envelope) {
    const response = await fetchWithTimeout(this.fetchImpl, this.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...this.headers,
      },
      body: JSON.stringify({
        id: envelope.id,
        type: envelope.type,
        priority: envelope.priority,
        created_at: envelope.created_at,
        text: envelope.text,
        metadata: envelope.metadata ?? {},
      }),
    }, this.timeoutMs);

    if (!response.ok) throw new Error(`Webhook delivery failed with HTTP ${response.status}.`);
    return { ok: true, transport: this.name, remote: true, status: response.status };
  }
}

export class TelegramAlertTransport {
  constructor({ botToken, chatId, fetchImpl = fetch, timeoutMs = 10_000 } = {}) {
    if (!botToken || !chatId) throw new Error('TelegramAlertTransport requires botToken and chatId.');
    this.name = 'telegram';
    this.remote = true;
    this.botToken = botToken;
    this.chatId = String(chatId);
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
  }

  async send(envelope) {
    const chunks = chunkText(envelope.text);
    const url = `https://api.telegram.org/bot${this.botToken}/sendMessage`;
    for (const chunk of chunks) {
      const response = await fetchWithTimeout(this.fetchImpl, url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          chat_id: this.chatId,
          text: chunk,
          disable_web_page_preview: true,
        }),
      }, this.timeoutMs);
      if (!response.ok) throw new Error(`Telegram delivery failed with HTTP ${response.status}.`);
      const payload = await response.json().catch(() => ({}));
      if (payload?.ok === false) throw new Error(`Telegram rejected the alert: ${payload.description ?? 'unknown error'}`);
      if (chunks.length > 1) await wait(75);
    }
    return { ok: true, transport: this.name, remote: true, chunks: chunks.length };
  }
}

export function buildConfiguredTransports(env = process.env, { fetchImpl = fetch, logger = console.log } = {}) {
  const transports = [new ConsoleAlertTransport({ logger })];

  if (env.ALERT_WEBHOOK_URL) {
    let headers = {};
    if (env.ALERT_WEBHOOK_BEARER_TOKEN) {
      headers = { authorization: `Bearer ${env.ALERT_WEBHOOK_BEARER_TOKEN}` };
    }
    transports.push(new GenericWebhookTransport({
      url: env.ALERT_WEBHOOK_URL,
      fetchImpl,
      headers,
      timeoutMs: Number(env.ALERT_HTTP_TIMEOUT_MS || 10_000),
    }));
  }

  if (env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID) {
    transports.push(new TelegramAlertTransport({
      botToken: env.TELEGRAM_BOT_TOKEN,
      chatId: env.TELEGRAM_CHAT_ID,
      fetchImpl,
      timeoutMs: Number(env.ALERT_HTTP_TIMEOUT_MS || 10_000),
    }));
  }

  return transports;
}

export { chunkText };
