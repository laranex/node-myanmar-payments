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
- `CallbackRequest.fromNodeRequest()` (node:http, Express), `CallbackRequest.fromWebRequest()` (Fetch API servers such as Next.js, Hono and Bun), `CallbackRequest.from()` and `CallbackRequest.fromJson()`. JSON numbers in callbacks are read without a float conversion, so signatures and amounts keep the gateway's exact text.
- Errors: `PaymentError` and its subclasses `InvalidPaymentDataError` (per-field `errors`), `ApiError` (`gatewayCode`, `gatewayMessage`, `httpStatus`, `raw`, `cause`), `SignatureVerificationError` and `ConfigurationError`.
- No runtime dependencies: the global `fetch` (or an injected `fetch` / `HttpClient`, 30 second default timeout, `AbortSignal` per call) and `node:crypto`; an injectable `TokenCache` with an in-memory default for Yoma's access token.
- CyberSource callbacks trust only the fields listed in `signed_field_names`: `decision` and `req_reference_number` must be signed, and unsigned fields are left out of the result and `raw`.
- AYA Pay reads a `payload` whose `+` signs became spaces in an unencoded return query string.
- Callback, return and cancel URLs only need to be valid absolute http or https URLs; there is no HTTPS-only rule (gateways may still require HTTPS in production).
- Wave Money's sandbox is `https://preprodpayments.wavemoney.io:8107`, with checkout at `https://preprodpayments.wavemoney.io/authenticate`.
- Agent skill in `skills/node-myanmar-payments` so coding agents use the package correctly; install it with `npx skills add laranex/node-myanmar-payments`.
- Requires Node.js 20 or higher.

### Changed since the pre-releases
- `PaymentStatus.Cancelled` is renamed to `PaymentStatus.Canceled` and its value from `'cancelled'` to `'canceled'` (American English), with no alias. Code or stored statuses from the `v4.0.0-dev` pre-releases need the new name; gateway status literals such as Wave Money's `PAYMENT_REQUEST_CANCELLED` are unchanged.
- Callback values that are JSON numbers are kept as their exact text, as strings, in `raw`, `parsedBody()`, `input()`, `queryInput()` and the `raw` of errors (`1000.50` is `'1000.50'`, not `1000.5`), like the PHP SDK.
- A nested value (object or array) in a signed or hashed callback field now fails verification: KBZ Pay (any callback field), Wave Money (the hashed fields), AYA Pay (the signed payload fields) and Yoma MMQR (`status`). Before, KBZ Pay skipped it, Wave Money hashed it as `null` and AYA Pay signed it as empty.
- AYA Pay accepts a base64 `payload` without padding as well as with full padding; partial padding, the URL-safe alphabet, line breaks and payloads that are not UTF-8 are rejected.
- Yoma MMQR caches its access token under `myanmar-payments.yoma-mmqr.token.<sha256 of base URL and client id>` (was `node-myanmar-payments.…`), the same key as the PHP, Go and Python SDKs, and reads `expires_in` from its leading digits.
- `Amount.equals()` compares by value, ignoring leading zeros too (`'01000'` equals `Amount.kyat(1000)`); text that is not plain digits with an optional fraction is never equal.
- `CallbackRequest.rawBody` holds the exact bytes received (a string body is encoded as UTF-8), next to `body` as text, like Python's `raw_body` and Go's `Body`.
- A config's `sandbox` option also takes a string, read like the `*_SANDBOX` variable (`false`, `0`, `f`, `no` or `off` select production).
