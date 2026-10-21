import type { Amount } from './amount.js';
import type { PaymentFlow } from './status.js';

type Raw = Readonly<Record<string, unknown>>;

/** Returned when a payment is initiated. Each flow has its own class; switch on `flow`. */
export type PaymentResult = RedirectPayment | FormPayment | QrPayment | AppPayment | MiniAppPayment;

/**
 * Send the customer's browser to `url` to complete the payment.
 */
export class RedirectPayment {
  /** Always `redirect`. */
  readonly flow: 'redirect' = 'redirect' satisfies PaymentFlow;
  /** Your order id, as sent to the gateway. */
  readonly orderId: string;
  /** The gateway page to redirect the customer to. */
  readonly url: string;
  /** The gateway's id for this attempt (KBZ `prepay_id`, Wave `transaction_id`). */
  readonly gatewayReference: string | undefined;
  /** The gateway's response, for logging. */
  readonly raw: Raw;

  constructor(init: {
    orderId: string;
    url: string;
    gatewayReference?: string | undefined;
    raw?: Raw;
  }) {
    this.orderId = init.orderId;
    this.url = init.url;
    this.gatewayReference = init.gatewayReference;
    this.raw = init.raw ?? {};
  }
}

/** One signed hidden field of a {@link FormPayment}. */
export interface FormField {
  readonly name: string;
  readonly value: string;
}

/**
 * POST `fields` to `action` from the customer's browser. {@link FormPayment.toHtml} renders a page
 * that does this automatically.
 */
export class FormPayment {
  /** Always `form`. */
  readonly flow: 'form' = 'form' satisfies PaymentFlow;
  /** Your order id, as sent to the gateway. */
  readonly orderId: string;
  /** The gateway URL the form posts to. */
  readonly action: string;
  /** The signed hidden fields, in signing order. Post them unchanged. */
  readonly fields: readonly FormField[];
  /** The encoding the gateway expects for the form. */
  readonly enctype: string;

  constructor(init: {
    orderId: string;
    action: string;
    fields: readonly FormField[];
    enctype?: string | undefined;
  }) {
    this.orderId = init.orderId;
    this.action = init.action;
    this.fields = Object.freeze(init.fields.map((field) => Object.freeze({ ...field })));
    this.enctype = init.enctype ?? 'application/x-www-form-urlencoded';
  }

  /** The value of the named field, or `undefined`. */
  field(name: string): string | undefined {
    return this.fields.find((field) => field.name === name)?.value;
  }

  /** The fields as an object, e.g. to render the form with your own template. */
  values(): Record<string, string> {
    return Object.fromEntries(this.fields.map((field) => [field.name, field.value]));
  }

  /**
   * A complete HTML page that posts the form as soon as it loads. Every value is escaped.
   *
   * @param nonce A Content Security Policy nonce for the inline script, added as `nonce="…"` when
   *   set, so the page works under a `script-src 'nonce-…'` policy.
   */
  toHtml(nonce?: string | null): string {
    const inputs = this.fields
      .map(
        (field) =>
          `<input type="hidden" name="${escapeHtml(field.name)}" value="${escapeHtml(field.value)}">`,
      )
      .join('');
    return (
      '<!DOCTYPE html><html><head><meta charset="utf-8"><title>Redirecting to payment</title></head><body>' +
      `<form id="payment-form" method="POST" action="${escapeHtml(this.action)}" enctype="${escapeHtml(this.enctype)}">` +
      inputs +
      '<noscript><button type="submit">Continue to payment</button></noscript></form>' +
      `<script${nonce ? ` nonce="${escapeHtml(nonce)}"` : ''}>` +
      'document.getElementById("payment-form").submit();</script></body></html>'
    );
  }
}

/**
 * Show a QR code for the customer to scan. Gateways return either a payload to encode
 * (`qrString`) or a ready-made image (`qrImage`).
 */
export class QrPayment {
  /** Always `qr`. */
  readonly flow: 'qr' = 'qr' satisfies PaymentFlow;
  /** Your order id, as sent to the gateway. */
  readonly orderId: string;
  /** A QR payload to encode into an image yourself (KBZ Pay). */
  readonly qrString: string | undefined;
  /** A base64 encoded image to display as is (Yoma MMQR). */
  readonly qrImage: string | undefined;
  /** When the QR stops being payable, when the gateway limits it. */
  readonly expiresAt: Date | undefined;
  /** The gateway's id for this QR, used to check its status (Yoma `refLabel`, KBZ `prepay_id`). */
  readonly reference: string | undefined;
  /** The gateway's response, for logging. */
  readonly raw: Raw;

  constructor(init: {
    orderId: string;
    qrString?: string | undefined;
    qrImage?: string | undefined;
    expiresAt?: Date | undefined;
    reference?: string | undefined;
    raw?: Raw;
  }) {
    this.orderId = init.orderId;
    this.qrString = init.qrString;
    this.qrImage = init.qrImage;
    this.expiresAt = init.expiresAt;
    this.reference = init.reference;
    this.raw = init.raw ?? {};
  }

  /** The image as a data URI for an `<img src>`, or `undefined` when there is no image. */
  qrImageDataUri(mimeType = 'image/png'): string | undefined {
    return this.qrImage === undefined ? undefined : `data:${mimeType};base64,${this.qrImage}`;
  }
}

/**
 * Pass these values to your mobile app, which hands them to the wallet's SDK.
 * `JSON.stringify(payment)` writes `orderId`, `orderInfo`, `sign` and `signType`.
 */
export class AppPayment {
  /** Always `app`. */
  readonly flow: 'app' = 'app' satisfies PaymentFlow;
  /** Your order id, as sent to the gateway. */
  readonly orderId: string;
  /** The signed order string the SDK expects. */
  readonly orderInfo: string;
  /** The signature of `orderInfo`. */
  readonly sign: string;
  /** The signature algorithm, e.g. `SHA256`. */
  readonly signType: string;
  /** The gateway's response, for logging. Left out of `toJSON()`. */
  readonly raw: Raw;

  constructor(init: {
    orderId: string;
    orderInfo: string;
    sign: string;
    signType: string;
    raw?: Raw;
  }) {
    this.orderId = init.orderId;
    this.orderInfo = init.orderInfo;
    this.sign = init.sign;
    this.signType = init.signType;
    this.raw = init.raw ?? {};
  }

  /** The values your app needs: `orderId`, `orderInfo`, `sign` and `signType`. */
  toJSON(): { orderId: string; orderInfo: string; sign: string; signType: string } {
    return {
      orderId: this.orderId,
      orderInfo: this.orderInfo,
      sign: this.sign,
      signType: this.signType,
    };
  }
}

/** One line item of a {@link MiniAppPayment}. */
export interface MiniAppPaymentItem {
  /** The item name. */
  readonly name: string;
  /** The item amount in whole units. */
  readonly amount: Amount;
}

/**
 * The object a mini app page passes to the wallet's JavaScript SDK (Wave Pay Mini App:
 * `WaveJsSDK.paymentModule.makePayment(payload)`), in Wave's key order with amounts as integers.
 */
export interface MiniAppPaymentPayload {
  amount: number;
  miniAppID: string;
  merchantRefID: string;
  orderID: string;
  callBackUrl: string;
  hashValue: string;
  items: { name: string; amount: number }[];
}

/**
 * Pass `JSON.stringify(payment)` (or {@link MiniAppPayment.toJsonString}) to your mini app page,
 * which hands the object unchanged to the wallet's JavaScript SDK (Wave Pay Mini App:
 * `WaveJsSDK.paymentModule.makePayment(payload)`). No request is sent to the gateway.
 */
export class MiniAppPayment {
  /** Always `mini_app`. */
  readonly flow: 'mini_app' = 'mini_app' satisfies PaymentFlow;
  /** Your order id (`orderID`). */
  readonly orderId: string;
  /** The signed total, in whole units. */
  readonly amount: Amount;
  /** The configured mini app id (`miniAppID`). */
  readonly miniAppId: string;
  /** Your reference for this attempt (`merchantRefID`). Store it with the order. */
  readonly merchantReferenceId: string;
  /** The signed callback URL (`callBackUrl`). */
  readonly callbackUrl: string;
  /** The payload's hash (`hashValue`). */
  readonly hashValue: string;
  /** The line items. */
  readonly items: readonly MiniAppPaymentItem[];

  constructor(init: {
    orderId: string;
    amount: Amount;
    miniAppId: string;
    merchantReferenceId: string;
    callbackUrl: string;
    hashValue: string;
    items: readonly MiniAppPaymentItem[];
  }) {
    this.orderId = init.orderId;
    this.amount = init.amount;
    this.miniAppId = init.miniAppId;
    this.merchantReferenceId = init.merchantReferenceId;
    this.callbackUrl = init.callbackUrl;
    this.hashValue = init.hashValue;
    this.items = Object.freeze(init.items.map((item) => Object.freeze({ ...item })));
  }

  /**
   * Exactly the object `makePayment` takes: `amount`, `miniAppID`, `merchantRefID`, `orderID`,
   * `callBackUrl`, `hashValue` and `items` (`name`, `amount`), with the amounts as numbers. An
   * amount above `Number.MAX_SAFE_INTEGER` is written with every digit through `JSON.rawJSON`
   * (Node.js 21+); where that is missing it throws a `RangeError`: use {@link toJsonString}.
   */
  toJSON(): MiniAppPaymentPayload {
    return {
      amount: integer(this.amount),
      miniAppID: this.miniAppId,
      merchantRefID: this.merchantReferenceId,
      orderID: this.orderId,
      callBackUrl: this.callbackUrl,
      hashValue: this.hashValue,
      items: this.items.map((item) => ({ name: item.name, amount: integer(item.amount) })),
    };
  }

  /**
   * The `makePayment` object as compact JSON text, with the amounts as JSON integers holding every
   * digit (no integer limit) on every Node.js version.
   */
  toJsonString(): string {
    const items = this.items
      .map((item) => `{"name":${JSON.stringify(item.name)},"amount":${item.amount.wholePart()}}`)
      .join(',');
    return (
      `{"amount":${this.amount.wholePart()}` +
      `,"miniAppID":${JSON.stringify(this.miniAppId)}` +
      `,"merchantRefID":${JSON.stringify(this.merchantReferenceId)}` +
      `,"orderID":${JSON.stringify(this.orderId)}` +
      `,"callBackUrl":${JSON.stringify(this.callbackUrl)}` +
      `,"hashValue":${JSON.stringify(this.hashValue)}` +
      `,"items":[${items}]}`
    );
  }
}

/** A whole amount as a number, or as raw JSON digits when it is beyond a safe integer. */
function integer(amount: Amount): number {
  const digits = amount.wholePart();
  const value = Number(digits);
  if (Number.isSafeInteger(value)) {
    return value;
  }
  const rawJSON = (JSON as { rawJSON?: (text: string) => unknown }).rawJSON;
  if (typeof rawJSON !== 'function') {
    throw new RangeError(
      `The amount ${digits} is too large for a JavaScript number; use toJsonString() to keep every digit.`,
    );
  }
  return rawJSON(digits) as number;
}

const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&#34;',
  "'": '&#39;',
};

/** Escapes text for HTML content and attribute values. @internal */
export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => HTML_ESCAPES[char] as string);
}
