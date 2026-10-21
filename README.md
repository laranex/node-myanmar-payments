# Node Myanmar Payments

[![npm](https://img.shields.io/npm/v/@laranex/myanmar-payments.svg?style=flat-square)](https://www.npmjs.com/package/@laranex/myanmar-payments)
[![Tests](https://github.com/laranex/node-myanmar-payments/actions/workflows/tests.yml/badge.svg)](https://github.com/laranex/node-myanmar-payments/actions/workflows/tests.yml)
[![License](https://img.shields.io/npm/l/@laranex/myanmar-payments.svg?style=flat-square)](LICENSE.md)

Node.js SDK for Myanmar payment gateways: KBZ Pay, Wave Pay, Wave Pay Mini App, AYA Pay, Yoma MMQR and CyberSource. Typed requests and results, exact amounts, no runtime dependencies. Built for humans and AI agents.

Every Myanmar payment gateway signs its requests and callbacks its own way, reports its own status codes and has its own rules for amounts. Node Myanmar Payments handles all of that behind one typed API for Node.js and any framework: build the payment data, start the payment, then verify the callback the gateway sends back.

## Why Node Myanmar Payments

- **Five gateways, one pattern.** KBZ Pay (PWA, QR and in-app), Wave Pay, AYA Pay, Yoma MMQR and CyberSource, each with its own class and the same three steps.
- **One typed result per flow.** `RedirectPayment`, `FormPayment`, `QrPayment` or `AppPayment` holds exactly what the next step needs: a URL to redirect to, an auto-submitting form, a QR code or the signed order for the KBZ Pay mobile SDK. See [Payment Flows](https://laranex.vercel.app/node-myanmar-payments/payment-flows).
- **Exact amounts, checked against each gateway's rules.** An `Amount` is kept as decimal text, takes a `bigint` of any size and never passes through a fractional `number`. Decimals, currency and limits follow each gateway's official documentation and are checked before any request is sent. See [Amounts](https://laranex.vercel.app/node-myanmar-payments/amounts).
- **Verified callbacks.** `handleCallback()` checks the gateway's signature without a network call, maps its status onto one `PaymentStatus` and gives you the acknowledgement the gateway expects. When a callback is late, ask KBZ Pay, AYA Pay or Yoma MMQR with `status()`. See [Callbacks & Status](https://laranex.vercel.app/node-myanmar-payments/callbacks).
- **Errors that say what went wrong.** A missing setting, an invalid field, a gateway error and a bad signature each throw their own error class, with a message that names the setting, the field or the gateway's code.
- **No runtime dependencies.** Requests go through the global `fetch` (or any `HttpClient` you pass) and signing uses `node:crypto`. ES modules and CommonJS both ship with TypeScript types, and callbacks are read from Node's request or a web `Request`, so Express, Fastify, Next.js and Hono all work. NestJS apps use [NestJS Myanmar Payments](https://laranex.vercel.app/nestjs-myanmar-payments/introduction), which wraps this package.
- **Same behavior in every language.** The PHP, Go, Node.js and Python SDKs pass one shared set of test vectors for signing and callback verification, and read the same environment variables, so one `.env` file and one Yoma MMQR token cache serve them all.
- **Nothing stored for you.** The package keeps no tables and no webhook log. [Handling Webhooks](https://laranex.vercel.app/node-myanmar-payments/webhooks) shows the recommended flow as code you copy: verify, store, acknowledge, then process each call once.
- **Easy to test.** Every gateway call goes through the `fetch` or client you pass, so your tests fake the responses, replay signed callbacks and never touch the network. See [Testing](https://laranex.vercel.app/node-myanmar-payments/testing).

## Installation

> **Requires** Node.js 20+. No runtime dependencies: it sends the gateway requests with the global `fetch` and signs with `node:crypto`.

```bash
npm install @laranex/myanmar-payments
```

```bash
pnpm add @laranex/myanmar-payments
```

```bash
yarn add @laranex/myanmar-payments
```

## Documentation

The full documentation lives at **[laranex.vercel.app/node-myanmar-payments](https://laranex.vercel.app/node-myanmar-payments)**:

- [Introduction](https://laranex.vercel.app/node-myanmar-payments/introduction): why the package exists and what it covers
- [Installation](https://laranex.vercel.app/node-myanmar-payments/installation): requirements, install command and a quick start
- [AI Agent Skill](https://laranex.vercel.app/node-myanmar-payments/ai-agent-skill): the skill that teaches coding agents to use the package
- [Configuration](https://laranex.vercel.app/node-myanmar-payments/configuration): credentials, environment variables, endpoints, UAT, HTTP client and token cache
- [Amounts](https://laranex.vercel.app/node-myanmar-payments/amounts): exact amounts and each gateway's amount rules
- [Payment Flows](https://laranex.vercel.app/node-myanmar-payments/payment-flows): redirect, form, QR and in-app payments
- [Callbacks & Status](https://laranex.vercel.app/node-myanmar-payments/callbacks): verified callbacks, payment statuses and status checks
- [Handling Webhooks](https://laranex.vercel.app/node-myanmar-payments/webhooks): the recommended verify, store, acknowledge, process-once flow
- [Framework Integration](https://laranex.vercel.app/node-myanmar-payments/framework-integration): Express, Fastify, Next.js and Hono
- [Testing](https://laranex.vercel.app/node-myanmar-payments/testing): faking gateway calls and replaying signed callbacks in your tests
- [KBZ Pay](https://laranex.vercel.app/node-myanmar-payments/drivers/kbz-pay): PWA redirect, QR and in-app payments, status checks and callbacks
- [Wave Pay](https://laranex.vercel.app/node-myanmar-payments/drivers/wave-pay): redirect payments with line items and verified callbacks
- [Wave Pay Mini App](https://laranex.vercel.app/node-myanmar-payments/drivers/wave-pay-mini-app): access tokens, signed payment payloads for Wave's JavaScript SDK and verified callbacks
- [AYA Pay](https://laranex.vercel.app/node-myanmar-payments/drivers/aya-pay): hosted checkout for AYA Pay, other wallets and cards, with status checks
- [Yoma MMQR](https://laranex.vercel.app/node-myanmar-payments/drivers/yoma-mmqr): QR images, QR renewal, status checks and verified callbacks
- [CyberSource](https://laranex.vercel.app/node-myanmar-payments/drivers/cyber-source): Secure Acceptance card payments through a signed hosted checkout form
- [Results](https://laranex.vercel.app/node-myanmar-payments/references/results): every property of the payment result types
- [PaymentCallback & Status](https://laranex.vercel.app/node-myanmar-payments/references/payment-callback): callbacks, status results, acknowledgements and the PaymentStatus values
- [Errors](https://laranex.vercel.app/node-myanmar-payments/references/errors): validation, API, signature and configuration errors

## License

MIT. See [LICENSE](LICENSE.md).
