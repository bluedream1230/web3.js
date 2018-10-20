const assert = require('assert');
const keymanager = require('../web3c/keymanager');

describe('Key Manager', function() {
  it('can encrypt and decrypt', async function() {
    let km1 = new keymanager();
    km1.getSecretKey();
    let km2 = new keymanager();
    km2.getSecretKey();

    let pubkey = km2.getPublicKey();

    let cyphertext = await km1.encrypt("0x1234abcdef", pubkey);

    let recover = await km2.decrypt(cyphertext);
    assert.equal("0x1234abcdef", recover);
  });
});
