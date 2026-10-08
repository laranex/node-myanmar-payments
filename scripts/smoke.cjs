// Loads the built CommonJS entry points and runs a signature, proving the require() path works.
const assert = require('node:assert');
const root = require('@laranex/myanmar-payments');
const { KbzPay } = require('@laranex/myanmar-payments/kbz-pay');
for (const path of ['wave-money', 'aya-pay', 'yoma-mmqr', 'cyber-source']) {
  require(`@laranex/myanmar-payments/${path}`);
}
assert.strictEqual(KbzPay, root.KbzPay);
const kbz = new KbzPay({ appId: 'a', appKey: 'k', merchantCode: 'm' });
assert.match(kbz.signer.sign({ a: '1' }), /^[0-9A-F]{64}$/);
assert.strictEqual(root.Amount.parse('1000.50').toString(), '1000.50');
console.log('CommonJS OK');
