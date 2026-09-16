# trading-telegram-alerts

Shared alert-delivery plumbing for `boom-crash-spike-bot` and `gold-xauusd-bot`: idempotent, retrying dispatch (`AlertDispatcher`, `createAlertEnvelope`) over pluggable transports (`TelegramAlertTransport`, `GenericWebhookTransport`, `ConsoleAlertTransport`), so both bots deliver to the same Telegram chat through one well-tested path.

This package is intentionally free of any trading/domain logic (no archetypes, no setup formatting) — message *formatting* stays in each bot's own repo, since Boom/Crash and Gold alerts look nothing alike. This package only owns: build an envelope, dedupe it, retry it, send it.

## Usage

```js
import { AlertDispatcher, createAlertEnvelope, buildConfiguredTransports } from 'trading-telegram-alerts';

const dispatcher = new AlertDispatcher({
  transports: buildConfiguredTransports(process.env),
  stateStore, // anything with .snapshot() / .mutate(fn) — used for delivery dedup
});

const envelope = createAlertEnvelope({
  type: 'SPIKE_EVENT',
  text: 'BOOM 500 — SPIKE DETECTED — BULLISH',
  eventKey: `boom500:spike:${spikeId}`, // stable key -> automatic de-dup across restarts
});

await dispatcher.dispatch(envelope);
```

Requires `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` in the environment for `buildConfiguredTransports` to wire up Telegram delivery.

## Install (from either bot repo)

```json
"dependencies": {
  "trading-telegram-alerts": "github:OyindamolaAdefehinti/trading-telegram-alerts#v1.0.0"
}
```

Pin to a tag (`#v1.0.0`), not a branch, so both bots only pick up a change when deliberately bumped.

## Test

```bash
npm test
```
