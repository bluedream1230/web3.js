// Browser based Siv_Ctr implementation based on subtle crypto.

// See http://web.cs.ucdavis.edu/~rogaway/papers/keywrap.pdf for the
// design of the SIV cryptographic scheme here.

const subtle = window.crypto.subtle;
const TagSize = 16;

// merge is a variadic function.  Instead of having named arguments,
// it uses the arguments Array-like object
// (https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Functions/arguments)
// to access the actual arguments by indexing.
var merge = function() {
  var length = 0;
  for (let i = 0; i < arguments.length; i++) {
    length += arguments[i].length;
  }
  var out = new Uint8Array(length);
  var offset = 0;
  for (let i = 0; i < arguments.length; i++) {
    out.set(arguments[i], offset);
    offset += arguments[i].length;
  }
  return out;
};

var equals = function (a, b) {
  if (a.byteLength != b.byteLength) {
    return false;
  }
  for (var i = 0; i < a.byteLength; i++) {
    if (a[i] != b[i]) {
      return false;
    }
  }
  return true;
}

// Algorithm $\tilde{\mathcal{E}}$ (page 7)
var Encrypt = async function (Key, Nonce, Plaintext, AdditionalData) {
  let MACKey = await subtle.importKey(
    'raw', new Uint8Array(Key).slice(0, 32), {
      name: 'HMAC',
      hash: {name: 'SHA-256'}
    },
    false,
    ['sign']
  );
  let EncKey = await subtle.importKey(
    'raw', new Uint8Array(Key).slice(32, 48), {
      name: 'AES-CTR'
    },
    false,
    ['encrypt']
  );
  let AdditionalDataLength = new ArrayBuffer(4);
  new DataView(AdditionalDataLength).setUint32(0, AdditionalData.byteLength, false);
  let PlaintextLength = new ArrayBuffer(4);
  new DataView(PlaintextLength).setUint32(0, Plaintext.byteLength, false);
  let SivData = merge(Nonce, new Uint8Array(AdditionalDataLength), new Uint8Array(PlaintextLength), AdditionalData, Plaintext);
  let Siv = await subtle.sign(
    {name: 'HMAC'},
    MACKey,
    SivData
  );

  let Cyphertext = await subtle.encrypt(
    {
      name: 'AES-CTR',
      counter: new Uint8Array(Siv).slice(0, TagSize),
      length: 128
    },
    EncKey,
    Plaintext
  );
  return merge(new Uint8Array(Cyphertext), new Uint8Array(Siv).slice(0, TagSize));
};

// Algorithm $\tilde{\mathcal{D}}$ (page 7)
var Decrypt = async function (Key, Nonce, Ciphertext, AdditionalData) {
  let MACKey = await subtle.importKey(
    'raw', new Uint8Array(Key).slice(0, 32), {
      name: 'HMAC',
      hash: {name: 'SHA-256'}
    },
    false,
    ['sign']
  );
  let DecKey = await subtle.importKey(
    'raw', new Uint8Array(Key).slice(32, 48), {
      name: 'AES-CTR'
    },
    false,
    ['decrypt']
  );
  let CiphertextLength = Ciphertext.byteLength;
  let Tag = Ciphertext.slice(CiphertextLength - TagSize, CiphertextLength);

  let Plaintext = await subtle.decrypt(
    {
      name: 'AES-CTR',
      counter: Tag,
      length: 128
    },
    DecKey,
    Ciphertext.slice(0, CiphertextLength - TagSize)
  );

  let AdditionalDataLength = new ArrayBuffer(4);
  new DataView(AdditionalDataLength).setUint32(0, AdditionalData.byteLength, false);
  let PlaintextLength = new ArrayBuffer(4);
  new DataView(PlaintextLength).setUint32(0, Plaintext.byteLength, false);
  let SivData = merge(Nonce, new Uint8Array(AdditionalDataLength), new Uint8Array(PlaintextLength), AdditionalData, new Uint8Array(Plaintext));
  let Siv = await subtle.sign(
    {name: 'HMAC'},
    MACKey,
    SivData
  );

  if (!equals(Tag, new Uint8Array(Siv.slice(0, TagSize)))) {
    throw new Error('Incorrect Signature');
  }

  return new Uint8Array(Plaintext);
};

module.exports = {
  TagSize: TagSize,
  Encrypt: Encrypt,
  Decrypt: Decrypt
};
