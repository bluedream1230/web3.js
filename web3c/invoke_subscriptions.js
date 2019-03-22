/**
 * InvokeSubscription is part of the private API. It's a convenience
 * class to encapsulate the state for managing subscriptions for the
 * purpose of the implementation of invoke
 *
 * These are the following challenges that this class attempts to
 * address
 *  - manage the lifecycle of all subscriptions related to `invoke`
 *  calls. The subscriptions should not be exposed and this class
 *  needs to act as interface for them
 *
 *  - We do not know the order in which we will receive first either
 *  the hash of a transaction or an event for the transaction. This
 *  means that we need to cache the events that InvokeSubscriptions
 *  receive, but at the same time have a policy to cleaning up the
 *  cache.
 */
class InvokeSubscriptions {
  constructor(options) {
    this.oasis = options.oasis;
    this.subscriptions = {};
  }

  // it makes sure that a subscription exists for the provided
  // address
  prepareSubscription(fromAddress) {
    this.getSubscription(fromAddress);
  }

  getSubscription(fromAddress) {
    if (this.subscriptions[fromAddress]) {
      return this.subscriptions[fromAddress];

    } else {
      return this.createNewSubscription(fromAddress);
    }
  }

  createNewSubscription(fromAddress) {
    if (this.subscriptions[fromAddress]) {
      throw new Error('subscription already exists');
    }

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
      this.handleError(fromAddress, err));

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

  removeExpectedTransaction(fromAddress, transactionHash) {
    const subscription = this.subscriptions[fromAddress];
    if (!subscription) {
      return;
    }

    delete subscription.expectedTransactions[transactionHash];
  }

  pushExpectedTransaction(fromAddress, expectedTransaction) {

    const subscription = this.getSubscription(fromAddress);
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

  cleanupSubscription(fromAddress, err) {
    const subscription = this.subscriptions[fromAddress];
    if (!subscription) {
      return;
    }

    // delete subscription from main subscriptions dictionary
    delete this.subscriptions[fromAddress];

    // complete all pending promises with the appropriate error
    // since we may not be able to satisfy them
    Object.keys(subscription.expectedTransactions).forEach(key => {
      const expectedTransaction = subscription.expectedTransactions[key];
      delete subscription.expectedTransactions[key];
      const promiseErr = new Error('expected transaction ' +
       'could not be satisfied because subscription failed' +
       'with error' + err);
      expectedTransaction.promise.resolver.reject(promiseErr);
    });
  }

  handleError(fromAddress, err) {
    if (!this.subscriptions[fromAddress]) {
      return;
    }

    this.cleanupSubscription(fromAddress, err);
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

module.exports = InvokeSubscriptions;