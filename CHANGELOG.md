# Changelog

All notable changes to `@laranex/myanmar-payments` (node-myanmar-payments) will be documented in this file.

## v4.0.0 - Unreleased

Initial release. The version number matches the other Laranex Myanmar payments packages (`php-myanmar-payments`, `laravel-myanmar-payments`, `go-myanmar-payments`), and the gateways, flows, validation, signing, status maps, results and errors are a port of them, sharing their test vectors.

### Added
- Gateways: KBZ Pay (`pwa`, `qr`, `app`, `status`), Wave Money (`initiate`), AYA Payment Gateway (`services`, `initiate`, `status`, `verifyRedirect`), Yoma MMQR (`initiate`, `renewQr`, `status`, `forgetToken`) and CyberSource Secure Acceptance (`initiate`); every gateway validates its payment data (`KbzPay.validate()` and so on) and verifies callbacks with `handleCallback`.
- Subpath exports per gateway (`@laranex/myanmar-payments/kbz-pay`, `/wave-money`, `/aya-pay`, `/yoma-mmqr`, `/cyber-source`) next to the root export, as ES modules and CommonJS with type declarations.
- Exact `Amount` type (`Amount.kyat()`, `Amount.parse()`) kept as decimal text, so amounts never pass through a float; payment data also takes a whole-number `number` or `bigint` and rejects fractions. Decimals are accepted only where the gateway documents them (KBZ Pay up to 2 places, CyberSource any); every gateway except CyberSource is MMK only.
- A config class per gateway with `fromEnv(process.env)`, reading the same `*_SANDBOX`, credential and URL variables as the PHP, Laravel and Go packages; a missing credential throws `ConfigurationError`. `MyanmarPayments` builds every gateway lazily from one config object or the environment.
- Result classes: `RedirectPayment`, `FormPayment` (with `toHtml()`), `QrPayment` (with `qrImageDataUri()`) and `AppPayment`; `PaymentCallback` (with a gateway-independent `PaymentStatus` and the `Acknowledgement` each gateway expects, sent with `send(res)` or `toResponse()`) and `PaymentStatusResult`.
- `CallbackRequest.fromNodeRequest()` (node:http, Express, Fastify, Koa), `CallbackRequest.fromWebRequest()` (Fetch API servers such as Next.js, Hono and Bun), `CallbackRequest.from()` and `CallbackRequest.fromJson()`. JSON numbers in callbacks are read without a float conversion, so signatures and amounts keep the gateway's exact text.
- Errors: `PaymentError` and its subclasses `InvalidPaymentDataError` (per-field `errors`), `ApiError` (`gatewayCode`, `gatewayMessage`, `httpStatus`, `raw`, `cause`), `SignatureVerificationError` and `ConfigurationError`.
- No runtime dependencies: the global `fetch` (or an injected `fetch` / `HttpClient`, 30 second default timeout, `AbortSignal` per call) and `node:crypto`; an injectable `TokenCache` with an in-memory default for Yoma's access token.
- Callback, return and cancel URLs only need to be valid absolute http or https URLs; there is no HTTPS-only rule (gateways may still require HTTPS in production).
- Wave Money's sandbox is `https://preprodpayments.wavemoney.io:8107`, with checkout at `https://preprodpayments.wavemoney.io/authenticate`.
- Agent skill in `skills/node-myanmar-payments` so coding agents use the package correctly; install it with `npx skills add laranex/node-myanmar-payments`.
- Requires Node.js 20 or higher.
