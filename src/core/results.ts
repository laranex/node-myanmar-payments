import type { PaymentFlow } from './status.js';

type Raw = Readonly<Record<string, unknown>>;

/** Returned when a payment is initiated. Each flow has its own class; switch on `flow`. */
export type PaymentResult = RedirectPayment | FormPayment | QrPayment | AppPayment;

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

  /** A complete HTML page that posts the form as soon as it loads. Every value is escaped. */
  toHtml(): string {
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
      '<script>document.getElementById("payment-form").submit();</script></body></html>'
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
