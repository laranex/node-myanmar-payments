---
name: node-myanmar-payments
description: >
  Integrate Myanmar payment gateways (KBZ Pay, Wave Money, AYA Pay, Yoma MMQR, CyberSource) in a Node.js or TypeScript app with @laranex/myanmar-payments.
license: MIT
metadata:
  author: Nay Thu Khant
---

# Node Myanmar Payments

## When to use

Use this skill when a Node.js or TypeScript app takes payments through KBZ Pay, Wave Money, AYA Payment Gateway, Yoma MMQR or CyberSource. Start payments and verify callbacks with the package's typed API; never build gateway signatures by hand. In NestJS, use `@laranex/nestjs-myanmar-payments` instead; it wraps this package.

## Install

```bash
npm install @laranex/myanmar-payments
```

Requires Node.js 20+ and has no runtime dependencies (global `fetch`, `node:crypto`); it ships ESM and CommonJS with types. Import shared types from the root and each gateway from the root or its subpath: `@laranex/myanmar-payments/kbz-pay`, `/wave-money`, `/aya-pay`, `/yoma-mmqr` and `/cyber-source`.

## Configure

`MyanmarPayments.fromEnv(process.env)` reads `KBZ_PAY_*`, `WAVE_MONEY_*`, `AYA_PAY_*` (or `AYA_PGW_*`), `YOMA_MMQR_*` and `CYBER_SOURCE_*` (the same variables as the PHP, Go and Python SDKs). `sandbox` defaults to `true`; set `*_SANDBOX=false` (or `sandbox: false`) in production.

```ts
import { MyanmarPayments } from '@laranex/myanmar-payments';

const payments = MyanmarPayments.fromEnv(process.env); // create once, share across requests
const kbz = payments.kbzPay(); // also waveMoney(), ayaPay(), yomaMmqr(), cyberSource()
```

- Or build one gateway: `new KbzPay(new KbzPayConfig({ appId, appKey, merchantCode }))`, `KbzPay.fromEnv()` or `new KbzPay(KbzPayConfig.fromEnv(process.env))`.
- Or pass the settings directly: gateways and `new MyanmarPayments({ kbzPay: { appId, appKey, merchantCode } })` take config objects or plain option objects; a string `sandbox` such as `'false'` is read like the variable.
- Options (second argument): `{ httpClient, fetch, timeoutMs }` (default 30 seconds). Yoma and the facade also take `tokenCache` (any `TokenCache`, default `MemoryTokenCache`; back it with Redis when you run several processes).
- A missing credential throws `ConfigurationError` (`gateway`, `key`).

## Use

### Amounts

Amounts are `Amount.kyat(1000)`, `Amount.parse('1000.50')` or a whole `number`/`bigint`; never a float such as `10.5`. Only KBZ Pay (up to 2 decimals) and CyberSource accept decimals; Wave, AYA and Yoma take whole kyat. Invalid data throws `InvalidPaymentDataError` with `errors` per field, before any request is sent. Compare a gateway's amount by value with `amount.equals(callback.amount)`.

### Start a payment

Each gateway takes a data object (`KbzPayPaymentData`, `WaveMoneyPaymentData` with `WaveMoneyItem`s, `AyaPayPaymentData` with an `AyaPayMethod`, `YomaMmqrPaymentData`, `CyberSourcePaymentData` with a `CyberSourceTransactionType`) and returns a typed result:

```ts
import { Amount } from '@laranex/myanmar-payments';

const payment = await kbz.pwa({
  orderId: 'ORDER_1',
  amount: Amount.kyat(1000),
  callbackUrl: 'https://shop.test/payments/kbz/callback',
});
res.writeHead(302, { Location: payment.url }).end();
```

- `RedirectPayment` (`url`) from `kbz.pwa(data)` and `wave.initiate(data)`. Wave fills `data.merchantReferenceId` when empty; store it.
- `FormPayment` from `aya.initiate(data)` and `cyberSource.initiate(data)` (no network call): send `payment.toHtml()` as an auto-submitting page, or render `action`, `fields` and `enctype` yourself.
- `QrPayment` from `kbz.qr(data)` (encode `qrString`) and `yoma.initiate(data)` (`qrImageDataUri()`, `expiresAt`, `reference`). A Yoma QR lives `YomaMmqr.QR_LIFETIME_SECONDS` (120); renew it with `yoma.renewQr(orderId)`.
- `AppPayment` from `kbz.app(data)`: `res.json(payment)` sends `orderId`, `orderInfo`, `sign` and `signType` to your mobile app.

AYA needs a channel: `await aya.services()` lists `AyaPayService` entries (`key`, `supports(method)`), then `aya.initiate({ orderId: 'ORDER123', amount: 1000, channel: 'kbz_pay', method: AyaPayMethod.Qr })`. Every network method takes `{ signal }` as its last argument.

### Handle the callback

Build a `CallbackRequest` from the raw request, verify it, then reply:

```ts
import { CallbackRequest, SignatureVerificationError } from '@laranex/myanmar-payments';

const request = await CallbackRequest.fromNodeRequest(req); // or fromWebRequest(request)
try {
  const callback = kbz.handleCallback(request);
  if (callback.isSuccessful()) {
    // compare callback.amount with the order, then fulfill callback.orderId once
  }
  callback.acknowledgement.send(res); // or return callback.acknowledgement.toResponse()
} catch (error) {
  if (!(error instanceof SignatureVerificationError)) throw error;
  res.writeHead(400).end('invalid signature');
}
```

- Give the package the raw body: in Express use `express.raw({ type: '*/*' })` on the callback route; in Fastify keep the body as a string (`parseAs: 'string'`) and build `CallbackRequest.from({ body, headers, query })`.
- Check AYA's browser return with `aya.verifyRedirect(request)`.
- For production, store the verified callback, acknowledge immediately, then process it once in the background.

### Check status and handle errors

- `kbz.status(orderId)`, `aya.status(orderId)` and `yoma.status(reference)` return `PaymentStatusResult` with `status` and `isSuccessful()`. Wave Money and CyberSource have no status API.
- Statuses: `PaymentStatus.Successful`, `Pending`, `Failed`, `Canceled`, `Expired`, `Unknown`; `PaymentStatus.isFinal(status)`.
- Gateway failures throw `ApiError` (`gatewayCode`, `gatewayMessage`, `httpStatus`, `raw`; network errors and aborts are the `cause`). All errors extend `PaymentError`.

## Test your app

- Pass a fake `fetch` in the options: `new KbzPay(config, { fetch: async () => new Response('{"Response":{...}}') })`.
- Replay a stored callback with `CallbackRequest.fromJson(payload, headers)` or `CallbackRequest.from({ body, headers, query })`; it is still signature-checked.
- To test your own fulfillment code, build `new PaymentCallback({ orderId: 'ORDER_1', status: 'successful', gatewayStatus: 'PAY_SUCCESS' })` yourself.

## Avoid

- Fulfilling orders from return pages or query strings; fulfill only from a verified callback or a status check.
- Treating `pending` or `unknown` as paid.
- Passing floats or `Number(price)` as amounts; use `Amount.parse()`.
- Building the `CallbackRequest` from `req.body` parsed by `express.json()` instead of the raw body.
- Reusing a Wave `merchantReferenceId`, or calling Yoma `initiate()` twice for one order (use `renewQr()`).
- Opening a KBZ Pay PWA link outside a phone with the KBZ Pay app.
