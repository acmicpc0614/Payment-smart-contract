/*
    Reference/Minimal client implementation to work with uni-directional payment channels
*/

const assert = require('assert')
const merge = require('lodash').merge
const BN = require('bn.js');
const { randomBytes } = require('crypto')
const {
    signMessage,
    verifySignature,
    toBytes32Buffer,
    toBuffer,
    keccak
} = require('./index.js')

const ChannelImplementation = artifacts.require("ChannelImplementation")

// const TestContract = artifacts.require("TestContract")
const OneToken = web3.utils.toWei(new BN(1), 'ether')

const DEFAULT_CHANNEL_STATE = {
    settled: new BN(0),
    balance: new BN(0),
    promised: new BN(0),
    agreements: {
        // 'agreementID': 0
    }
}

async function createConsumer(registry, identity, hermesId) {
    const channelId = await registry.getChannelAddress(identity.address, hermesId)
    const state = { channels: {} }

    return {
        identity,
        state,
        channelId,
        createExchangeMsg: createExchangeMsg.bind(null, state, identity, channelId)
    }
}

function createProvider(identity, hermes) {
    const state = {
        invoices: {
            // "invoiceId": {
            //     agreementID: 1,
            //     agreementTotal: 0,
            //     r: 'abc',
            //     // paid: false,
            //     exchangeMessage: {}
            // }
        },
        agreements: {
            // 'agreementID': 0 // total amount of this agreement
        },
        lastAgreementId: 0,
        promises: []
    }
    return {
        identity,
        state,
        generateInvoice: generateInvoice.bind(null, state),
        validateExchangeMessage: validateExchangeMessage.bind(null, state, identity.address),
        savePromise: promise => state.promises.push(promise),
        settlePromise: settlePromise.bind(null, state, hermes),
        getBiggestPromise: () => state.promises.reduce((promise, acc) => promise.amount.gt(acc) ? acc : promise, state.promises[0])
    }
}

async function createHermesService(hermes, operator, token) {
    const state = { channels: {} }
    this.getChannelState = async (channelId, agreementId) => {
        if (!state.channels[channelId]) {
            const channel = await ChannelImplementation.at(channelId)
            state.channels[channelId] = Object.assign({}, await channel.hermes(), {
                balance: await token.balanceOf(channelId),
                promised: new BN(0),
                agreements: { [agreementId]: new BN(0) }
            })
        }

        if (!state.channels[channelId].agreements[agreementId]) {
            state.channels[channelId].agreements[agreementId] = new BN(0)
        }

        return state.channels[channelId]
    }
    this.getOutgoingChannel = async (receiver) => {
        const channelId = await hermes.getChannelId(receiver)

        if (!state.channels[channelId]) {
            state.channels[channelId] = merge({}, DEFAULT_CHANNEL_STATE, await hermes.channels(channelId))
        }

        return { outgoingChannelId: channelId, outgoingChannelState: state.channels[channelId] }
    }

    return {
        state,
        exchangePromise: exchangePromise.bind(this, state, operator)
    }
}

function generateInvoice(state, amount, agreementId, fee = new BN(0), R = randomBytes(32)) {
    const hashlock = keccak(R)

    // amount have to be bignumber
    if (typeof amount === 'number') amount = new BN(amount)

    // If no agreement id is given, then it's new one
    if (!agreementId) {
        state.lastAgreementId++
        agreementId = state.lastAgreementId
        state.agreements[agreementId] = new BN(0)
    }

    if (!state.agreements[agreementId]) {
        state.agreements[agreementId] = amount
    } else {
        state.agreements[agreementId] = state.agreements[agreementId].add(amount)
    }

    // save invoice
    state.invoices[hashlock] = { R, agreementId, agreementTotal: state.agreements[agreementId], fee }
    return state.invoices[hashlock]
}

function validateInvoice(invoices, hashlock, agreementId, agreementTotal) {
    const invoice = invoices[hashlock]
    expect(agreementId).to.be.equal(invoice.agreementId)
    agreementTotal.should.be.bignumber.equal(invoice.agreementTotal)
}

function createExchangeMsg(state, operator, channelId, invoice, party) {
    const { agreementId, agreementTotal, fee, R } = invoice
    const channelState = state.channels[channelId] || merge({}, DEFAULT_CHANNEL_STATE)

    const diff = agreementTotal.sub(channelState.agreements[agreementId] || new BN(0))
    const amount = channelState.promised.add(diff).add(fee) // we're signing always increasing amount to settle
    const hashlock = keccak(R)
    const chainId = 1
    const promise = createPromise(chainId, channelId, amount, fee, hashlock, operator)

    // Create and sign exchange message
    const message = Buffer.concat([
        promise.hash,
        toBytes32Buffer(agreementId),
        toBytes32Buffer(agreementTotal),
        Buffer.from(party.slice(2), 'hex')
    ])
    const signature = signMessage(message, operator.privKey)

    // Write state
    channelState.agreements[agreementId] = agreementTotal
    channelState.promised = amount
    state.channels[channelId] = channelState

    return { promise, agreementId, agreementTotal, party, hash: keccak(message), signature }
}

function validateExchangeMessage(state, receiver, exchangeMsg, payerPubKey) {
    const { promise, agreementId, agreementTotal, party, signature } = exchangeMsg

    // Signature have to be valid
    const message = Buffer.concat([
        promise.hash,
        toBytes32Buffer(agreementId),
        toBytes32Buffer(agreementTotal),
        Buffer.from(party.slice(2), 'hex')
    ])
    expect(verifySignature(message, signature, payerPubKey)).to.be.true
    expect(receiver).to.be.equal(party)

    validatePromise(promise, payerPubKey)
    if (state.invoices) validateInvoice(state.invoices, promise.hashlock, agreementId, agreementTotal)
}

async function exchangePromise(state, operator, exchangeMessage, payerPubKey, receiver) {
    validateExchangeMessage(state, receiver, exchangeMessage, payerPubKey)

    const { promise, agreementId, agreementTotal } = exchangeMessage
    const channelState = await this.getChannelState(promise.channelId, agreementId)

    // amount not covered by previous payment promises should be bigger than balance
    const amount = agreementTotal.sub(channelState.agreements[agreementId])
    channelState.balance.should.be.bignumber.gte(amount)

    // Amount in promise should be set properly
    promise.amount.should.be.bignumber.equal(channelState.promised.add(amount))

    // Save updated channel state
    channelState.balance = channelState.balance.sub(amount)
    channelState.agreements[agreementId] = channelState.agreements[agreementId].add(amount)
    channelState.promised = channelState.promised.add(amount)

    // Update outgoing channel state
    const { outgoingChannelId, outgoingChannelState } = await this.getOutgoingChannel(receiver)
    const promiseAmount = outgoingChannelState.promised.add(amount)
    outgoingChannelState.promised = promiseAmount

    // Issue new payment promise for `amount` value
    return createPromise(promise.chainId, outgoingChannelId, promiseAmount, new BN(0), promise.hashlock, operator, receiver)
}

function generatePromise(amountToPay, fee, channelState, operator, receiver) {
    const amount = channelState.settled.add(amountToPay).add(fee) // we're signing always increasing amount to settle
    const R = randomBytes(32)
    const hashlock = keccak(R)
    const chainId = 1  // 1 - mainnet or ganache, 5 - goerli
    return Object.assign({},
        createPromise(chainId, channelState.channelId, amount, fee, hashlock, operator, receiver),
        { lock: R }
    )
}

function createPromise(chainId, channelId, amount, fee, hashlock, operator, receiver) {
    const message = Buffer.concat([
        toBytes32Buffer(chainId),  // chainId, 1 - mainnet or ganache, 5 - goerli
        toBytes32Buffer(channelId, 'address'),  // channelId = channel address
        toBytes32Buffer(amount),   // total promised amount in this channel
        toBytes32Buffer(fee),      // fee to transfer for msg.sender
        hashlock                   // hashlock needed for HTLC scheme
    ])

    // sign and verify the signature
    const signature = signMessage(message, operator.privKey)
    expect(verifySignature(message, signature, operator.pubKey)).to.be.true

    return { chainId, channelId, amount, fee, hashlock, hash: keccak(message), signature, identity: receiver }
}

function validatePromise(promise, pubKey) {
    const message = Buffer.concat([
        toBytes32Buffer(promise.chainId),  // network specific chainId
        toBytes32Buffer(promise.channelId, 'address'), // channelId = channel address
        toBytes32Buffer(promise.amount),   // total promised amount in this channel
        toBytes32Buffer(promise.fee),      // fee to transfer for msg.sender
        promise.hashlock     // hashlock needed for HTLC scheme
    ])

    expect(verifySignature(message, promise.signature, pubKey)).to.be.true
}

async function settlePromise(state, hermes, promise) {
    // If promise is not given, we're going to use biggest of them
    if (!promise) {
        promise = state.promises.sort((a, b) => b.amount.sub(a.amount).toNumber())[0]
    }

    const invoice = state.invoices[promise.hashlock]
    await hermes.settlePromise(promise.identity, promise.amount, promise.fee, invoice.R, promise.signature)
}

async function signExitRequest(channel, beneficiary, operator) {
    const EXIT_PREFIX = "Exit request:"
    const lastBlockTime = (await web3.eth.getBlock('latest')).timestamp
    const validUntil = lastBlockTime + 1 //DELAY_SECONDS

    const message = Buffer.concat([
        Buffer.from(EXIT_PREFIX),
        Buffer.from(channel.address.slice(2), 'hex'),  // channelId = channel address
        Buffer.from(beneficiary.slice(2), 'hex'),
        toBytes32Buffer(new BN(validUntil))
    ])

    // sign and verify the signature
    const signature = signMessage(message, operator.privKey)
    expect(verifySignature(message, signature, operator.pubKey)).to.be.true

    return {
        channelId: channel.toAddress,
        beneficiary,
        validUntil,
        signature
    }
}

function signFastWithdrawal(chainId, channelId, amount, fee, beneficiary, validUntil, nonce, identity, hermes) {
    const EXIT_PREFIX = "Exit request:"

    const message = Buffer.concat([
        Buffer.from(EXIT_PREFIX),
        toBytes32Buffer(chainId),                // chainId represents blockchain on which this channel is created
        toBytes32Buffer(channelId, 'address'),   // channelId = channel address
        toBytes32Buffer(amount),                 // total promised amount in this channel
        toBytes32Buffer(fee),                    // fee to transfer for msg.sender
        toBytes32Buffer(beneficiary, 'address'), // address of funds beneficiary
        toBytes32Buffer(validUntil),             // block number
        toBytes32Buffer(nonce)                   // latest used nonce + 1 --> reply protection
    ])

    // sign and verify the signature
    const identitySignature = signMessage(message, identity.privKey)
    expect(verifySignature(message, identitySignature, identity.pubKey)).to.be.true

    const hermesSignature = signMessage(message, hermes.privKey)
    expect(verifySignature(message, hermesSignature, hermes.pubKey)).to.be.true

    return { channelId, amount, fee, beneficiary, validUntil, nonce, identitySignature, hermesSignature }
}

function signChannelBeneficiaryChange(chainId, registry, newBeneficiary, registryNonce, identity) {
    const message = Buffer.concat([
        toBytes32Buffer(chainId),
        Buffer.from(registry.slice(2), 'hex'),
        Buffer.from(identity.address.slice(2), 'hex'),
        Buffer.from(newBeneficiary.slice(2), 'hex'),
        toBytes32Buffer(registryNonce),
    ])

    // sign and verify the signature
    const signature = signMessage(message, identity.privKey)
    expect(verifySignature(message, signature, identity.pubKey)).to.be.true

    return signature
}

function singPayAndSettleBeneficiary(chainId, channelId, amount, preimage, beneficiary, identity) {
    const message = Buffer.concat([
        toBytes32Buffer(chainId),
        toBytes32Buffer(channelId, 'address'),
        toBytes32Buffer(amount),
        toBytes32Buffer(preimage),
        Buffer.from(beneficiary.slice(2), 'hex')
    ])

    // sign and verify the signature
    const signature = signMessage(message, identity.privKey)
    expect(verifySignature(message, signature, identity.pubKey)).to.be.true

    return signature
}

function signChannelLoanReturnRequest(channelId, amount, fee, channelNonce, identity, chainId = 1) {
    const LOAN_RETURN_PREFIX = "Stake return request"
    const message = Buffer.concat([
        Buffer.from(LOAN_RETURN_PREFIX),
        toBytes32Buffer(chainId),
        Buffer.from(channelId.slice(2), 'hex'),
        toBytes32Buffer(amount),
        toBytes32Buffer(fee),
        toBytes32Buffer(channelNonce)
    ])

    // sign and verify the signature
    const signature = signMessage(message, identity.privKey)
    expect(verifySignature(message, signature, identity.pubKey)).to.be.true

    return signature
}

function signIdentityRegistration(registryAddress, hermesId, stake, fee, beneficiary, identity) {
    const message = Buffer.concat([
        toBytes32Buffer(1), // ChainID = 1
        Buffer.from(registryAddress.slice(2), 'hex'),
        Buffer.from(hermesId.slice(2), 'hex'),
        toBytes32Buffer(stake),
        toBytes32Buffer(fee),
        Buffer.from(beneficiary.slice(2), 'hex')
    ])

    // sign and verify the signature
    const signature = signMessage(message, identity.privKey)
    expect(verifySignature(message, signature, identity.pubKey)).to.be.true

    return signature
}

function signConsumerChannelOpening(registryAddress, hermesId, fee, identity) {
    const message = Buffer.concat([
        toBytes32Buffer(1), // ChainID = 1
        Buffer.from(registryAddress.slice(2), 'hex'),
        Buffer.from(hermesId.slice(2), 'hex'),
        toBytes32Buffer(fee)
    ])

    // sign and verify the signature
    const signature = signMessage(message, identity.privKey)
    expect(verifySignature(message, signature, identity.pubKey)).to.be.true

    return signature
}

function signUrlUpdate(registryAddress, hermesId, url, nonce, identity) {
    const message = Buffer.concat([
        Buffer.from(registryAddress.slice(2), 'hex'),
        Buffer.from(hermesId.slice(2), 'hex'),
        Buffer.from(url),
        toBytes32Buffer(nonce)
    ])

    // sign and verify the signature
    const signature = signMessage(message, identity.privKey)
    expect(verifySignature(message, signature, identity.pubKey)).to.be.true

    return signature
}

function signStakeGoalUpdate(chainId, channelId, stakeGoal, channelNonce, identity) {
    const STAKE_GOAL_UPDATE_PREFIX = "Stake goal update request"

    const message = Buffer.concat([
        Buffer.from(STAKE_GOAL_UPDATE_PREFIX),
        toBytes32Buffer(chainId),
        Buffer.from(channelId.slice(2), 'hex'),
        toBytes32Buffer(stakeGoal),
        toBytes32Buffer(channelNonce)
    ])

    // sign and verify the signature
    const signature = signMessage(message, identity.privKey)
    expect(verifySignature(message, signature, identity.pubKey)).to.be.true

    return signature
}

// We're using signature as bytes array (`bytes memory`), so we have properly construct it.
function serialiseSignature(signature) {
    const bytesArrayPosition = toBytes32Buffer(new BN(160))
    const bytesArrayLength = toBytes32Buffer(new BN(65))
    const bytesArrayFooter = Buffer.from('00000000000000000000000000000000000000000000000000000000000000', 'hex')

    return Buffer.concat([
        bytesArrayPosition,
        bytesArrayLength,
        toBuffer(signature),
        bytesArrayFooter
    ])
}

function constructPayload(obj) {
    // Convert signature into `bytes memory`
    if (obj.signature)
        obj.signature = serialiseSignature(obj.signature)

    const methodNameHash = '0x8e24280c' // settlePromise(uint256,uint256,bytes32,bytes32,bytes memory)
    const message = Buffer.concat(Object.keys(obj).map(key => toBuffer(obj[key])))
    return methodNameHash + message.toString('hex')
}

module.exports = {
    constructPayload,
    createHermesService,
    createConsumer,
    createProvider,
    createPromise,
    generatePromise,
    signChannelBeneficiaryChange,
    singPayAndSettleBeneficiary,
    signChannelLoanReturnRequest,
    signExitRequest,
    signFastWithdrawal,
    signIdentityRegistration,
    signConsumerChannelOpening,
    signStakeGoalUpdate,
    signUrlUpdate,
    validatePromise
}
