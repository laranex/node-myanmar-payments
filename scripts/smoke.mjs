// Loads the built ES module entry points and runs a signature, proving the import path works.
import assert from 'node:assert';
import * as root from '@laranex/myanmar-payments';
import { KbzPay } from '@laranex/myanmar-payments/kbz-pay';
import '@laranex/myanmar-payments/wave-money';
import '@laranex/myanmar-payments/aya-pay';
import '@laranex/myanmar-payments/yoma-mmqr';
import '@laranex/myanmar-payments/cyber-source';

assert.strictEqual(KbzPay, root.KbzPay);
const kbz = new KbzPay({ appId: 'a', appKey: 'k', merchantCode: 'm', timeoutSeconds: 30 });
assert.match(kbz.signer.sign({ a: '1' }), /^[0-9A-F]{64}$/);
assert.strictEqual(root.Amount.parse('1000.50').toString(), '1000.50');
console.log('ES modules OK');
