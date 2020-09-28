const { BN } = require('@openzeppelin/test-helpers')

const Registry = artifacts.require("Registry")
const ChannelImplementation = artifacts.require("ChannelImplementation")
const HermesImplementation = artifacts.require("HermesImplementation")
const MystToken = artifacts.require("MystToken")

const uniswap = require("../scripts/deployUniswap")
const WETH = require("../scripts/deployWETH")
const uniswapRouter = require('../scripts/UniswapV2Router02.json')

const zeroAddress = '0x0000000000000000000000000000000000000000'

module.exports = async function (deployer, network, accounts) {
    if (network === 'goerli') {
        // We do have MYSTTv2 deployed on Görli already
        const tokenAddress = '0xf74a5ca65E4552CfF0f13b116113cCb493c580C5'

        await deployer.deploy(ChannelImplementation)
        await deployer.deploy(HermesImplementation)
        await deployer.deploy(Registry, tokenAddress, uniswapRouter.contractAddr, 0, ChannelImplementation.address, HermesImplementation.address)
    } else {
        // Deploy WETH token
        await WETH.deploy(web3, accounts[0])

        // Deploy Uniswap smart contracts: Factory, Router, Migrator
        await uniswap.deploy(web3, accounts[0])
    }
}
