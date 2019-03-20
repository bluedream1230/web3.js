const EventEmitter = require('events');
const DeployHeader = require('./deploy_header');
const KeyManager = require('./key_manager');
const Signer = require('./signer');
const OasisProvider = require('./oasis_provider');
const ProviderConfidentialBackend = require('./provider_confidential_backend');
const ConfidentialSendTransform = ProviderConfidentialBackend.private.ConfidentialSendTransform;
const makeContractFactory = require('./contract_factory');
const Subscriptions = require('web3-core-subscriptions').subscriptions;
const bytes = require('./bytes');

/**
 * InvokeSubscription is part of the private API. It's a convenience
 * class to encapsulate the state for managing subscriptions for the
 * purpose of the implementation of invoke
 */
class InvokeSubscription {
  constructor(options) {
    this.oasis = options.oasis;
    this.subscriptions = {};
  }

  getSubscription(fromAddress) {
    if (this.subscriptions[fromAddress]) {
      return this.subscriptions[fromAddress];

    } else {
      return this.createNewSubscription(fromAddress);
    }
  }

  createNewSubscription(fromAddress) {
    const emitter = this.oasis.subscribe('completedTransaction', {
      fromAddress: fromAddress
    });

    const subscription = {
      fromAddress: fromAddress,
      emitter: emitter,
      receivedTransactions: {},
      expectedTransactions: {}
    };

    // forward all events generated by the emitter to the
    // emitter provided to the user
    emitter.on('data', data =>
      this.handleData(fromAddress, data));
    emitter.on('error', err =>
      this.forwardEvent(fromAddress, 'error', err));

    this.subscriptions[fromAddress] = subscription;
    return this.subscriptions[fromAddress];
  }

  async forwardData(data, toAddress, promise) {
    let isConfidential;
    try {
      isConfidential = await this.oasis.isConfidential(toAddress);
    } catch (e) {
      let err = new Error('failed to verify if transaction comes from a' +
                          ' confidential contract call: ' + e.message);
      promise.resolver.reject(err);
      return;
    }

    if (isConfidential) {
      try {
        const returnData = await this.oasis.keyManager.decrypt(data.returnData);
        promise.resolver.resolve(returnData);

      } catch (e) {
        let err = new Error('failed to decrypt returnData field: ' + e.message);
        promise.resolver.reject(err);
      }

    } else {
      promise.resolver.resolve(data.returnData);
    }
  }

  createResolvablePromise() {
    const resolver = {};
    const promise = new Promise((resolve, reject) => {
      resolver.resolve = resolve;
      resolver.reject = reject;
    });
    promise.resolver = resolver;
    return promise;
  }

  pushExpectedTransaction(fromAddress, expectedTransaction) {
    const subscription = this.subscriptions[fromAddress];
    if (!subscription) {
      throw new Error('subscription not found');
    }

    const hash = expectedTransaction.transactionHash;
    const toAddress = expectedTransaction.toAddress;
    const promise = expectedTransaction.promise;

    if (subscription.receivedTransactions[hash]) {
      // in the case that we have already received the transaction
      // we can resolve the promise here and now
      const data = subscription.receivedTransactions[hash];
      delete subscription.receivedTransactions[hash];

      this.forwardData(data, toAddress, promise);
      return promise;
    }

    if (subscription.expectedTransactions[hash]) {
      throw new Error('already expecting transaction');
    }

    subscription.expectedTransactions[hash] = {
      transactionHash: hash,
      toAddress: toAddress,
      promise: promise
    };

    return promise;
  }

  forwardEvent(fromAddress, eventName, payload) {
    const subscription = this.subscriptions[fromAddress];
    if (!subscription) {
      // received data for an unknown subscription
      // so just ignore
      return;
    }

    subscription.emitter.emit(eventName, payload);
  }

  handleData(fromAddress, data) {
    const subscription = this.subscriptions[fromAddress];
    if (!subscription) {
      // received data for an unknown subscription
      // so just ignore
      return;
    }

    if (subscription.expectedTransactions[data.transactionHash]) {
      const expectedTransaction = this.expectedTransactions[data.transactionHash];
      delete subscription.expectedTransactions[data.transactionHash];
      this.forwardData(data, expectedTransaction.toAddress, expectedTransaction.promise);

    } else {
      subscription.receivedTransactions[data.transactionHash] = data;
    }
  }
}

/**
 * Oasis
 *
 * This module exports the `web3.oasis` namespace. It defines the parameters
 * of the raw underlying web3 methods added to the web3 protocol, and exposes
 * the Oasis contract interface by creating an extended verison of web3.eth.Contract
 * with the ability to deploy with custom header speciying properties like
 * condientiality and expiry.
 *
 * @param {Object} options is the set of arguments to configure the Oasis namespace.
 *                 Required: web3, storage, mrae.
 *                 Optional: keyManagerPublicKey.
 */
class Oasis {

  constructor(options) {
    this.utils = new OasisUtils();
    this._setupKeyManager(options);
    this._setupRpcs(options);
    this._setupContract(options);
    this._setupWrappedAccounts(options);
    this._setupSubscribe(options);
    this._setupInvoke(options);
  }

  _setupKeyManager(options) {
    let signer = undefined;
    if (options.keyManagerPublicKey) {
      signer = new Signer(options.keyManagerPublicKey);
    }
    this.keyManager = new KeyManager(
      options.web3,
      options.storage,
      options.mraebox,
      signer
    );
  }

  /**
   * Creates methods on the confidential namespace that make requests to the oasis_*
   * web3c rpc endpoints. For example, one may do `web3c.oasis.getPublicKey(address)`.
   */
  _setupRpcs(options) {
    let web3 = options.web3;

    let methods = [
      // Second parameter - the long-term key - is intercepted by the provider.
      new web3.extend.Method({
        name: 'getPublicKey',
        call: 'oasis_getPublicKey',
        params: 1,
        inputFormatter: [web3.extend.formatters.inputAddressFormatter],
        outputFormatter: (pk) => getPublicKeyOutputFormatter(pk, options)
      }),
      new web3.extend.Method({
        name: 'call',
        call: 'oasis_call_enc',
        params: 2,
        inputFormatter: [
          web3.extend.formatters.inputCallFormatter,
          web3.extend.formatters.inputDefaultBlockNumberFormatter
        ],
        outputFormatter: callOutputFormatter
      }),
      new web3.extend.Method({
        name: 'expiry',
        call: 'oasis_getExpiry',
        params: 1,
        inputFormatter: [(address) => {
          if (!address) {
            throw Error('An address must be provided to retrieve contract expiry');
          }
          return web3.extend.formatters.inputAddressFormatter(address);
        }],
        outputFormatter: (res) => res
      })
    ];

    methods.forEach((method) => {
      method.setRequestManager(web3._requestManager);
      method.attachToObject(this);
    });
  }

  /**
   * Creates the Oasis `Contract` constructor on the `oasis` namespace.
   * The `Contract` behaves in the same way as the eth `Contract` object, except
   * that it adds the ability to speciy custom properties likes expriy and
   * confidentiality. If confidentiality is set, then transparently encrypts/decrypts
   * all outgoing/incoming requests according to the web3c spec.
   */
  _setupContract(options) {
    const web3 = options.web3;
    const factoryOptions = {
      web3,
      invokeProvider: this
    };

    this.Contract = makeContractFactory(factoryOptions, (address, contractOptions) => {
      let provider = new OasisProvider(this.keyManager, web3._requestManager);

      let keymanager = this.keyManager;

      if (contractOptions && contractOptions.saveSession === false) {
        let signer = undefined;
        if (options.keyManagerPublicKey) {
          signer = new Signer(options.keyManagerPublicKey);
        }
        keymanager = new KeyManager(web3, undefined, options.mraebox, signer);
        provider = new OasisProvider(keymanager, web3._requestManager);
      }

      if (contractOptions && contractOptions.key) {
        keymanager.add(address, contractOptions.key);
      }

      if (address) {
        this.isConfidential(address).then((isConfidential) => {
          provider.selectBackend({ confidential: isConfidential });
        }).catch((err) => {
          throw new Error(`${err}`);
        });
      }

      return provider;
    });
  }

  _setupWrappedAccounts(options) {
    let accounts = options.web3.eth.accounts;
    let wrappedSigner = accounts.signTransaction.bind(accounts);
    let keyManager = this.keyManager;
    accounts.signTransaction = (tx, from, callback) => {
      // Transaction to existing address, so we check it's confidential by asking the key manager.
      if (tx.to) {
        return new Promise(async (resolve, reject) => {
          if (!await this.isConfidential(tx.to)) {
            return wrappedSigner(tx, from, callback).then(resolve, reject);
          }

          const transformer = new ProviderConfidentialBackend.private.ConfidentialSendTransform(
            options.web3._requestManager.provider,
            keyManager
          );
          transformer.encryptTx(tx, function finishSignConfidentialTransaction(err) {
            if (err) {
              reject(err);
            }
            try {
              return wrappedSigner(tx, from, callback).then(resolve, reject);
            } catch (e) {
              reject(e);
            }
          });
        });
      }
      // Deploy transaction, so just add the deploy header.
      (new OasisProvider(keyManager, options.web3._requestManager))
        .getBackend(tx.header)
        .addOasisDeployHeader(tx);
      return wrappedSigner(tx, from, callback);
    };

    this.accounts = accounts;
  }

  _setupSubscribe(options) {
    this._subscriptions = {};
    this._oasisExclusiveSubscriptions = {};
    const completedTransaction = new Subscriptions({
      name: 'subscribe',
      type: 'eth',
      subscriptions: {
        completedTransaction: {
          subscriptionName: 'completedTransaction',
          params: 1,
        }
      }
    });

    completedTransaction.setRequestManager(options.web3._requestManager);
    completedTransaction.attachToObject(this._oasisExclusiveSubscriptions);

    // the behaviour of _subscribeCompletedTransaction is a bit tricky
    // to handle:
    //  * when filter contains `address`, it will use that `address` to
    //   find out if the data received needs to be decrypted.
    //
    //  * when the filter is used to filter on a transactionHash, the
    //   use of the `address` field is consistent, because it is easy to
    //   pass on the address of the contract that the transaction executes.
    //
    // * when the filter is used to filter on fromAddress, it is possible
    //   that the subscription receives confidential transactions as well
    //   as non confidential ones through the same subscription. This means
    //   that in that case the use of `address` is discouraged. It should be
    //   the developer who implements the logic to only decrypt the data
    //   of the transactions they know are for confidential contracts.
    this._subscribeCompletedTransaction = function(filter) {
      const address = filter && filter.address ? filter.address : null;
      if (address) {
        // remove address from filter which is not a property expected in the
        // filter by the backend, this is a property used in web3c to
        // identify whether the subscription is for a confidential transaction
        delete filter.address;
      }

      const emitter = new EventEmitter();
      // undefined means that we need to initialize it later in a lazy way,
      // false means that the subscription is assumed to be for a non
      // confidential transaction
      let isConfidential = address ? undefined : false;

      const handleData = async data => {
        // initialize lazily isConfidential. We need to return the EventEmitter
        // from _subscribeCompletedTransaction because this is the contract of a
        // subscribe call, we cannot return a promise. So, we initialize lazily
        // the `isConfidential` in the first call
        if (isConfidential === undefined) {
          try {
            isConfidential = await this.isConfidential(address);

          } catch (e) {
            isConfidential = false;
            let err = new Error('failed to verify if transaction comes from a' +
                                ' confidential contract call: ' + e.message);
            emitter.emit('error', err);
          }
        }

        if (isConfidential) {
          try {
            const returnData = await this.keyManager.decrypt(bytes.toHex(data.returnData));
            data.returnData = returnData;
            emitter.emit('data', data);

          } catch (e) {
            let err = new Error('failed to decrypt returnData field: ' + e.message);
            emitter.emit('error', err);
          }

        } else {
          data.returnData = bytes.toHex(data.returnData);
          emitter.emit('data', data);
        }
      };

      this._oasisExclusiveSubscriptions.subscribe('completedTransaction', filter)
        .on('data', handleData)
        .on('error', (err) => emitter.emit('error', err));

      return emitter;

    };

    this.subscribe = function() {
      // expected arguments -> (type, filter, callback)

      // web3.eth.subscribe is strict when it comes to how many arguments are
      // provided for a call to subscribe. We need to make sure that in the
      // call we provide exactly the same arguments to web3.eth.subscribe
      // as they are provided to this.subscribe
      const args = Array.prototype.slice.call(arguments);
      if (args.length === 0) {
        throw new Error('subscription type must be provided');
      }

      const type = args[0];

      if (type === 'completedTransaction') {
        return this._subscribeCompletedTransaction(args[1]);

      } else if (type !== 'logs') {
        return options.web3.eth.subscribe.apply(options.web3.eth, args);
      }

      let wrappedEmitter = new EventEmitter();

      let decryptSubscriptionLog = async (msg, log) => {
        try {
          if (await this.isConfidential(log.address)) {
            let transform = new ConfidentialSendTransform(null, this.keyManager);
            await transform.tryDecryptLogs([log], false);
            wrappedEmitter.emit(msg, log);
          } else {
            wrappedEmitter.emit(msg, log);
          }
        } catch (err) {
          wrappedEmitter.emit('error', err);
        }
      };

      let wrappedCallback = undefined;
      if (args.length > 2 && typeof args[2] === 'function') {
        const callback = args[2];
        wrappedCallback = async (err, log) => {
          if (err) {
            return callback(err);
          }
          if (await this.isConfidential(log.address)) {
            let transform = new ConfidentialSendTransform(null, this.keyManager);
            await transform.tryDecryptLogs([log], false);
            return callback(null, log);
          } else {
            return callback(null, log);
          }
        };

        args[2] = wrappedCallback;
      }

      options.web3
        .eth
        .subscribe.apply(options.web3.eth, args)
        .on('data', decryptSubscriptionLog.bind(this, 'data'))
        .on('changed', decryptSubscriptionLog.bind(this, 'changed'))
        .on('error', (err) => {
          wrappedEmitter.emit('error', err);
        });

      return wrappedEmitter;
    };
  }

  _setupInvoke(options = {}) {
    // for invoke to work, we need to keep track of which subscriptions are currently
    // available to avoid recreating subscriptions.
    options.oasis = this;
    this._invokeSubscription = new InvokeSubscription(options);

    this._executeSend = async (subscription, send, contract, sendArgs) => {
      const promise = this._invokeSubscription.createResolvablePromise();
      const address = contract.address ? contract.address : contract.options.address;
      await send.apply(contract, sendArgs)
        .on('transactionHash', hash => {
          this._invokeSubscription.pushExpectedTransaction(subscription.fromAddress, {
            transactionHash: hash,
            toAddress: address,
            promise: promise
          });
        });

      return promise;
    };

    this.invoke = async function(fromAddress, contract, send, ...sendArgs) {
      if (typeof send !== 'function') {
        throw new Error('type of send must be a function');
      }

      const subscription = await this._invokeSubscription.getSubscription(fromAddress);
      return this._executeSend(subscription, send, contract, sendArgs);
    };
  }

  resetKeymanager() {
    this.keyManager.reset();
  }

  /**
   * @returns true iff the contract at address is confidential.
   */
  isConfidential(address) {
    return new Promise((resolve, reject) => {
      this.keyManager.get(address, (err, publicKey) => {
        if (err) {
          reject(err);
        }
        let confidential = publicKey !== null && publicKey !== undefined;
        resolve(confidential);
      });
    });
  }
}

class OasisUtils {
  constructor() {
    this.DeployHeader = DeployHeader;
  }
}

function getPublicKeyOutputFormatter (t, options) {
  // We called oasis_getPublicKey on a non-confidential contract.
  if (!t) {
    return t;
  }
  let signer = undefined;
  if (options.keyManagerPublicKey) {
    signer = new Signer(options.keyManagerPublicKey);
  } else {
    signer = new Signer(KeyManager.publicKey());
  }
  let err = signer.verify(t.signature, t.public_key, t.timestamp);
  if (err) {
    throw err;
  }
  return t;
}

function callOutputFormatter (t) {
  return t;
}

module.exports = Oasis;
