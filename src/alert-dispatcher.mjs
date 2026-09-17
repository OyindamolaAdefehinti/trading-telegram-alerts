import { createHash } from 'node:crypto';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function stableId(value) {
  return createHash('sha256').update(String(value)).digest('hex').slice(0, 20);
}

function nowIso(now) {
  return new Date(now()).toISOString();
}

function normaliseDeliveryState(state) {
  if (!state.notification_delivery || typeof state.notification_delivery !== 'object') {
    state.notification_delivery = { delivered: {}, failed: [], last_remote_success_epoch: null };
  }
  if (!state.notification_delivery.delivered || typeof state.notification_delivery.delivered !== 'object') {
    state.notification_delivery.delivered = {};
  }
  if (!Array.isArray(state.notification_delivery.failed)) state.notification_delivery.failed = [];
  return state.notification_delivery;
}

export function createAlertEnvelope({
  type,
  text,
  priority = 'NORMAL',
  eventKey = null,
  metadata = {},
  replyMarkup = null,
  now = Date.now,
} = {}) {
  const cleanType = String(type ?? '').trim();
  const cleanText = String(text ?? '').trim();
  if (!cleanType) throw new Error('Alert type is required.');
  if (!cleanText) throw new Error('Alert text is required.');
  const createdAt = nowIso(now);
  const idSource = eventKey ?? `${cleanType}:${createdAt}:${cleanText}`;
  return {
    id: stableId(idSource),
    event_key: String(idSource),
    type: cleanType,
    priority,
    created_at: createdAt,
    text: cleanText,
    metadata: metadata ?? {},
    ...(replyMarkup ? { replyMarkup } : {}),
  };
}

export class AlertDispatcher {
  constructor({
    transports = [],
    stateStore = null,
    maxAttempts = 3,
    retryDelaysMs = [250, 1000, 3000],
    sleepImpl = sleep,
    now = Date.now,
  } = {}) {
    this.transports = transports;
    this.stateStore = stateStore;
    this.maxAttempts = Math.max(1, Number(maxAttempts) || 1);
    this.retryDelaysMs = retryDelaysMs;
    this.sleepImpl = sleepImpl;
    this.now = now;
  }

  async alreadyDelivered(envelope, transportName) {
    if (!this.stateStore) return false;
    const state = this.stateStore.snapshot();
    const delivered = state.notification_delivery?.delivered ?? {};
    return delivered[`${envelope.id}:${transportName}`]?.status === 'DELIVERED';
  }

  async recordResult(envelope, result) {
    if (!this.stateStore) return;
    const epoch = Math.floor(this.now() / 1000);
    await this.stateStore.mutate((state) => {
      const delivery = normaliseDeliveryState(state);
      const key = `${envelope.id}:${result.transport}`;
      if (result.ok) {
        delivery.delivered[key] = {
          status: 'DELIVERED',
          alert_id: envelope.id,
          transport: result.transport,
          remote: result.remote === true,
          epoch,
        };
        if (result.remote === true) delivery.last_remote_success_epoch = epoch;
        const keys = Object.keys(delivery.delivered);
        if (keys.length > 1500) {
          for (const oldKey of keys.slice(0, keys.length - 1500)) delete delivery.delivered[oldKey];
        }
      } else {
        delivery.failed.push({
          alert_id: envelope.id,
          transport: result.transport,
          epoch,
          error: result.error,
        });
        delivery.failed = delivery.failed.slice(-300);
      }
    });
  }

  async sendViaTransport(transport, envelope) {
    if (await this.alreadyDelivered(envelope, transport.name)) {
      return { ok: true, duplicate_suppressed: true, transport: transport.name, remote: transport.remote === true };
    }

    let lastError = null;
    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      try {
        const result = await transport.send(envelope);
        const success = { ok: true, attempt, transport: transport.name, remote: transport.remote === true, ...result };
        await this.recordResult(envelope, success);
        return success;
      } catch (error) {
        lastError = error;
        if (attempt < this.maxAttempts) {
          const delay = this.retryDelaysMs[Math.min(attempt - 1, this.retryDelaysMs.length - 1)] ?? 0;
          if (delay > 0) await this.sleepImpl(delay);
        }
      }
    }

    const failure = {
      ok: false,
      transport: transport.name,
      remote: transport.remote === true,
      error: lastError instanceof Error ? lastError.message : String(lastError),
    };
    await this.recordResult(envelope, failure);
    return failure;
  }

  async dispatch(envelope) {
    if (!envelope?.id || !envelope?.text) throw new Error('A valid alert envelope is required.');
    if (!this.transports.length) {
      return {
        status: 'NO_TRANSPORT_CONFIGURED',
        delivered: false,
        remote_delivered: false,
        results: [],
      };
    }

    const results = [];
    for (const transport of this.transports) {
      results.push(await this.sendViaTransport(transport, envelope));
    }

    const remote = results.filter((item) => item.remote);
    const remoteDelivered = remote.length > 0 && remote.every((item) => item.ok);
    const localDelivered = results.some((item) => item.ok && !item.remote);
    const anyFailed = results.some((item) => !item.ok);

    return {
      status: anyFailed ? 'DELIVERY_PARTIAL_OR_FAILED' : 'DELIVERED',
      delivered: results.some((item) => item.ok),
      local_delivered: localDelivered,
      remote_configured: remote.length > 0,
      remote_delivered: remoteDelivered,
      results,
    };
  }
}
