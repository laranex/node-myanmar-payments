// Loads the built ES module entry points and runs a signature, proving the import path works.
import assert from 'node:assert';
import * as root from '@laranex/myanmar-payments';
import { KbzPay } from '@laranex/myanmar-payments/kbz-pay';
import '@laranex/myanmar-payments/wave-pay';
import { WavePayMiniApp } from '@laranex/myanmar-payments/wave-pay-mini-app';
import '@laranex/myanmar-payments/aya-pay';
import '@laranex/myanmar-payments/yoma-mmqr';
import '@laranex/myanmar-payments/cyber-source';

assert.strictEqual(KbzPay, root.KbzPay);
assert.strictEqual(WavePayMiniApp, root.WavePayMiniApp);
const kbz = new KbzPay({
  appId: 'a',
  appKey: 'k',
  merchantCode: 'm',
  apiUrl: 'https://api.kbzpay.com/payment/gateway',
  pwaUrl: 'https://wap.kbzpay.com/pgw/pwa/#/',
  timeToLiveMinutes: 15,
});
assert.strictEqual(kbz.config.timeoutSeconds, root.DEFAULT_TIMEOUT_SECONDS);
assert.strictEqual(root.DEFAULT_TIMEOUT_SECONDS, 30);
assert.match(kbz.signer.sign({ a: '1' }), /^[0-9A-F]{64}$/);
assert.strictEqual(root.Amount.parse('1000.50').toString(), '1000.50');
assert.deepStrictEqual(root.KbzPayConfig.optionsFromEnv({ KBZ_PAY_APP_ID: ' a ' }), { appId: 'a' });
const miniApp = new WavePayMiniApp({
  clientId: 'c',
  clientSecret: 's',
  miniAppId: 'MINI456',
  secretKey: 'test-secret',
  baseUrl: root.WavePayMiniAppConfig.PRODUCTION_URL,
});
assert.strictEqual(
  JSON.stringify(
    miniApp.payment({
      orderId: 'ORDER123',
      callbackUrl: 'https://yourdomain.com/callback',
      items: [{ name: 'Ticket', amount: 5000 }],
      merchantReferenceId: 'MERCHANT789',
    }),
  ),
  '{"amount":5000,"miniAppID":"MINI456","merchantRefID":"MERCHANT789","orderID":"ORDER123","callBackUrl":"https://yourdomain.com/callback","hashValue":"aae8c2959c7d5c4995bcdeb6ec4aa6e4f34fbd7607d039436991f901ed883f6c","items":[{"name":"Ticket","amount":5000}]}',
);
console.log('ES modules OK');
