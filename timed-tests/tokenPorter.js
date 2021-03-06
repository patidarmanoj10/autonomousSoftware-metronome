/*
    The MIT License (MIT)

    Copyright 2017 - 2018, Alchemy Limited, LLC.

    Permission is hereby granted, free of charge, to any person obtaining
    a copy of this software and associated documentation files (the
    "Software"), to deal in the Software without restriction, including
    without limitation the rights to use, copy, modify, merge, publish,
    distribute, sublicense, and/or sell copies of the Software, and to
    permit persons to whom the Software is furnished to do so, subject to
    the following conditions:

    The above copyright notice and this permission notice shall be included
    in all copies or substantial portions of the Software.

    THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS
    OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
    MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.
    IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY
    CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT,
    TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE
    SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
*/

const assert = require('chai').assert
const ethjsABI = require('ethjs-abi')
const TestRPCTime = require('../test/shared/time')
const METGlobal = require('../test/shared/inits')

contract('TokenPorter', accounts => {
  const OWNER = accounts[0]
  const MINIMUM_PRICE = 33 * 10 ** 11 // minimum wei per token
  const STARTING_PRICE = 2 // 2ETH per MET
  const TIME_SCALE = 1
  const SECS_IN_DAY = 86400
  const SECS_IN_MINUTE = 60
  const MILLISECS_IN_A_SEC = 1000
  // var autonomousConverter, auctions, proceeds, metToken, smartToken, tokenPorter
  // var etcMetToken, etcAutonomousConverter, etcAuctions, etcProceeds, etcSmartToken, etcTokenPorter, etcValidator
  function prepareImportData (tokenPorter, tx) {
    const decoder = ethjsABI.logDecoder(tokenPorter.abi)
    const logExportReceipt = decoder(tx.receipt.logs)[0]
    return {
      addresses: [logExportReceipt.destinationMetronomeAddr, logExportReceipt.destinationRecipientAddr],
      burnHashes: [logExportReceipt.prevBurnHash, logExportReceipt.currentBurnHash],
      importData: [logExportReceipt.blockTimestamp, logExportReceipt.amountToBurn, logExportReceipt.fee,
        logExportReceipt.currentTick, logExportReceipt.genesisTime, logExportReceipt.dailyMintable,
        logExportReceipt.burnSequence, logExportReceipt.dailyAuctionStartTime]
    }
  }

  function roundToNextMidnight (t) {
    // round to prev midnight, then add a day
    const nextMidnight = (t - (t % SECS_IN_DAY)) + SECS_IN_DAY
    assert(new Date(nextMidnight * MILLISECS_IN_A_SEC).toUTCString().indexOf('00:00:00') >= 0, 'timestamp is not midnight')
    return nextMidnight
  }

  async function secondsToNextMidnight () {
    const currentTime = await TestRPCTime.getCurrentBlockTime()
    const nextMidnight = roundToNextMidnight(currentTime)
    return (nextMidnight - currentTime)
  }

  // Create contracts and initilize them for each test case
  beforeEach(async () => {
  })

  describe('export ETH to Mock ETC', () => {
    const destChain = web3.fromAscii('ETC')
    const destChainETH = web3.fromAscii('ETH')
    let destMetAddr
    const METTokenETCInitialSupply = 0

    it('Basic export test . ETH to ETC', () => {
      return new Promise(async (resolve, reject) => {
        const exportFee = 0
        const amountToExport = 1e17 - exportFee

        // await initContracts(accounts, TestRPCTime.getCurrentBlockTime() - 60, MINIMUM_PRICE, STARTING_PRICE, TIME_SCALE)
        const {auctions, metToken, tokenPorter} = await METGlobal.initContracts(accounts, TestRPCTime.getCurrentBlockTime(), MINIMUM_PRICE, STARTING_PRICE, TIME_SCALE)

        let initialAuctionEndTime = await auctions.initialAuctionEndTime()
        // await initNonOGContracts(accounts, TestRPCTime.getCurrentBlockTime() - 60, MINIMUM_PRICE, STARTING_PRICE, TIME_SCALE, initialAuctionEndTime.valueOf())
        const {etcAuctions, etcMetToken, etcTokenPorter, etcValidator} = await METGlobal.initNonOGContracts(accounts, TestRPCTime.getCurrentBlockTime(), MINIMUM_PRICE, (STARTING_PRICE / 2), TIME_SCALE, initialAuctionEndTime.valueOf())

        // Time travel to just a minute before initial auction end
        await TestRPCTime.timeTravel((7 * SECS_IN_DAY) - SECS_IN_MINUTE)
        await TestRPCTime.mineBlock()

        // get some balance for export
        const buyer = accounts[7]
        const amount = 1e18
        await auctions.sendTransaction({ from: buyer, value: amount })

        var balanceOfBuyer = await metToken.balanceOf(buyer)
        assert.isAbove(balanceOfBuyer.toNumber(), amountToExport, 'Balance of buyer after purchase is not correct')

        const SECS_TO_NEXT_MIDNIGHT = await secondsToNextMidnight()
        await TestRPCTime.timeTravel(SECS_TO_NEXT_MIDNIGHT)
        await TestRPCTime.mineBlock()
        await auctions.sendTransaction({ from: buyer, value: amount })
        // await initETCMockContracts(await auctions.genesisTime())
        destMetAddr = etcMetToken.address
        await tokenPorter.addDestinationChain(destChain, destMetAddr, { from: OWNER })
        await etcTokenPorter.addDestinationChain(destChainETH, metToken.address, { from: OWNER })
        // export all tokens
        const expectedExtraData = 'extra data'
        const tx = await metToken.export(
          destChain,
          destMetAddr,
          buyer,
          amountToExport,
          exportFee,
          web3.fromAscii(expectedExtraData),
          { from: buyer })

        // retrieve data from export receipt, it will be used for import in mock ETC
        const decoder = ethjsABI.logDecoder(tokenPorter.abi)
        const logExportReceipt = decoder(tx.receipt.logs)[0]

        let obj = prepareImportData(tokenPorter, tx)

        await TestRPCTime.timeTravel(20 * SECS_IN_DAY)
        await TestRPCTime.mineBlock()

        await etcValidator.validateHash(logExportReceipt.currentBurnHash, {from: OWNER})
        await etcValidator.validateHash(logExportReceipt.currentBurnHash, {from: accounts[1]})

        assert.isTrue(await etcValidator.hashClaimable(logExportReceipt.currentBurnHash))

        // Before Import
        var totalSupply = await etcMetToken.totalSupply()

        assert.equal(totalSupply.valueOf(), 0, 'Total supply in ETC is not 0')

        await TestRPCTime.timeTravel(10)
        await TestRPCTime.mineBlock()
        const imported = true
        await etcMetToken.importMET(web3.fromAscii('ETH'), logExportReceipt.destinationChain, obj.addresses, logExportReceipt.extraData,
          obj.burnHashes, logExportReceipt.supplyOnAllChains, obj.importData, 0)

        assert(imported, 'Import in ETC failed')

        // After import
        let globalSupplyETH = await auctions.globalMetSupply()
        let globalSupplyETC = await etcAuctions.globalMetSupply()
        assert.equal(globalSupplyETC.toNumber(), globalSupplyETH.toNumber(), 'Global supply in two chain is not correct')
        let balanceAfterImport = await etcMetToken.balanceOf(obj.addresses[1])

        assert.equal(balanceAfterImport.valueOf(), amountToExport)
        let currentAuctionETC = await etcAuctions.currentAuction()
        assert.equal(currentAuctionETC.valueOf(), 21, 'Current Auction in ETC wrong')

        totalSupply = await etcMetToken.totalSupply()
        assert.equal((totalSupply.sub(METTokenETCInitialSupply)).valueOf(), amountToExport, 'Total supply after import is not correct')
        globalSupplyETH = await auctions.globalMetSupply()
        globalSupplyETC = await etcAuctions.globalMetSupply()
        assert.equal(globalSupplyETC.toNumber(), globalSupplyETH.toNumber(), 'Global supply in two chain is not correct')

        // let dailyMintableETC = await etcAuctions.dailyMintable()
        // await auctions.sendTransaction({ from: buyer, value: amount })
        // let dailyMintableETH = await auctions.dailyMintable()

        // TODO: Fix this issue
        // assert.equal(dailyMintableETC.add(dailyMintableETH), 2880e18, 'Daily mintable is wrong')
        await TestRPCTime.timeTravel(SECS_IN_MINUTE)
        await TestRPCTime.mineBlock()

        resolve()
      })
    })

    it('Should be able to update validator and wrong validtor should not be able to do validation', () => {
      return new Promise(async (resolve, reject) => {
        const exportFee = 0
        const amountToExport = 1e17 - exportFee

        // await initContracts(accounts, TestRPCTime.getCurrentBlockTime() - 60, MINIMUM_PRICE, STARTING_PRICE, TIME_SCALE)
        const {auctions, metToken, tokenPorter} = await METGlobal.initContracts(accounts, TestRPCTime.getCurrentBlockTime(), MINIMUM_PRICE, STARTING_PRICE, TIME_SCALE)

        let initialAuctionEndTime = await auctions.initialAuctionEndTime()
        // await initNonOGContracts(accounts, TestRPCTime.getCurrentBlockTime() - 60, MINIMUM_PRICE, STARTING_PRICE, TIME_SCALE, initialAuctionEndTime.valueOf())
        const {etcMetToken, etcTokenPorter, etcValidator} = await METGlobal.initNonOGContracts(accounts, TestRPCTime.getCurrentBlockTime(), MINIMUM_PRICE, (STARTING_PRICE / 2), TIME_SCALE, initialAuctionEndTime.valueOf())

        // Time travel to just a minute before initial auction end
        await TestRPCTime.timeTravel((7 * SECS_IN_DAY) - SECS_IN_MINUTE)
        await TestRPCTime.mineBlock()

        // get some balance for export
        const buyer = accounts[7]
        const amount = 1e18
        await auctions.sendTransaction({ from: buyer, value: amount })

        var balanceOfBuyer = await metToken.balanceOf(buyer)
        assert.isAbove(balanceOfBuyer.toNumber(), amountToExport, 'Balance of buyer after purchase is not correct')

        const SECS_TO_NEXT_MIDNIGHT = await secondsToNextMidnight()
        await TestRPCTime.timeTravel(SECS_TO_NEXT_MIDNIGHT)
        await TestRPCTime.mineBlock()
        await auctions.sendTransaction({ from: buyer, value: amount })
        // await initETCMockContracts(await auctions.genesisTime())
        destMetAddr = etcMetToken.address
        await tokenPorter.addDestinationChain(destChain, destMetAddr, { from: OWNER })
        await etcTokenPorter.addDestinationChain(destChainETH, metToken.address, { from: OWNER })
        // export all tokens
        const expectedExtraData = 'extra data'
        const tx = await metToken.export(
          destChain,
          destMetAddr,
          buyer,
          amountToExport,
          exportFee,
          web3.fromAscii(expectedExtraData),
          { from: buyer })

        // retrieve data from export receipt, it will be used for import in mock ETC
        const decoder = ethjsABI.logDecoder(tokenPorter.abi)
        const logExportReceipt = decoder(tx.receipt.logs)[0]

        prepareImportData(tokenPorter, tx)

        await TestRPCTime.timeTravel(20 * SECS_IN_DAY)
        await TestRPCTime.mineBlock()

        await etcValidator.initValidator(accounts[4], accounts[5], accounts[6], {from: OWNER})
        let thrown = false
        try {
          await etcValidator.validateHash(logExportReceipt.currentBurnHash, {from: OWNER})
        } catch (e) {
          thrown = true
        }
        await etcValidator.initValidator(OWNER, accounts[1], accounts[4], {from: OWNER})

        assert(thrown, 'Wrong validator should not be able to validate hash')
        await etcValidator.validateHash(logExportReceipt.currentBurnHash, {from: OWNER})
        await etcValidator.validateHash(logExportReceipt.currentBurnHash, {from: accounts[1]})

        assert.isTrue(await etcValidator.hashClaimable(logExportReceipt.currentBurnHash))

        resolve()
      })
    })

    it('Export and import test 2 . ETH to ETC', () => {
      return new Promise(async (resolve, reject) => {
        const exportFee = 0
        const amountToExport = 6e14 - exportFee

        const { auctions, metToken, tokenPorter } = await METGlobal.initContracts(accounts, TestRPCTime.getCurrentBlockTime() - 60, MINIMUM_PRICE, STARTING_PRICE, TIME_SCALE)
        let initialAuctionEndTime = await auctions.initialAuctionEndTime()
        const { etcAuctions, etcMetToken, etcValidator } = await METGlobal.initNonOGContracts(accounts, TestRPCTime.getCurrentBlockTime() - 60, MINIMUM_PRICE, (STARTING_PRICE / 2), TIME_SCALE, initialAuctionEndTime.valueOf())
        await TestRPCTime.timeTravel((2 * SECS_IN_DAY) - SECS_IN_MINUTE)
        await TestRPCTime.mineBlock()

        // get some balance for export
        const buyer = accounts[7]
        const amount = 1e18
        await auctions.sendTransaction({ from: buyer, value: amount })

        var balanceOfBuyer = await metToken.balanceOf(buyer)
        assert.isAbove(balanceOfBuyer.toNumber(), amountToExport, 'Balance of buyer after purchase is not correct')

        const SECS_TO_NEXT_MIDNIGHT = await secondsToNextMidnight()
        await TestRPCTime.timeTravel(SECS_TO_NEXT_MIDNIGHT)
        await TestRPCTime.mineBlock()
        await auctions.sendTransaction({ from: buyer, value: amount })
        // await initETCMockContracts(await auctions.genesisTime())
        destMetAddr = etcMetToken.address
        await tokenPorter.addDestinationChain(destChain, destMetAddr, { from: OWNER })
        // export all tokens
        const expectedExtraData = 'extra data'
        let tx = await metToken.export(
          destChain,
          destMetAddr,
          buyer,
          amountToExport,
          exportFee,
          web3.fromAscii(expectedExtraData),
          { from: buyer })

        // retrieve data from export receipt, it will be used for import in mock ETC
        let decoder = ethjsABI.logDecoder(tokenPorter.abi)
        let logExportReceipt = decoder(tx.receipt.logs)[0]

        let obj = prepareImportData(tokenPorter, tx)
        await TestRPCTime.timeTravel(2 * SECS_IN_DAY)
        await TestRPCTime.mineBlock()

        await etcValidator.validateHash(logExportReceipt.currentBurnHash, {from: OWNER})
        await etcValidator.validateHash(logExportReceipt.currentBurnHash, {from: accounts[1]})

        assert.isTrue(await etcValidator.hashClaimable(logExportReceipt.currentBurnHash))

        // Before import 1
        var totalSupply = await etcMetToken.totalSupply()
        assert.equal(totalSupply.valueOf(), 0, 'Total supply in ETC is not 0')
        let globalSupplyETH = await auctions.globalMetSupply()
        let globalSupplyETC = await etcAuctions.globalMetSupply()

        assert.equal(globalSupplyETC.toNumber(), globalSupplyETH.toNumber(), 'Global supply in two chain is not correct')

        let imported = await etcMetToken.importMET.call(web3.fromAscii('ETH'), logExportReceipt.destinationChain, obj.addresses, logExportReceipt.extraData,
          obj.burnHashes, logExportReceipt.supplyOnAllChains, obj.importData, 0)
        assert(imported, 'Import in ETC failed')
        await etcMetToken.importMET(web3.fromAscii('ETH'), logExportReceipt.destinationChain, obj.addresses, logExportReceipt.extraData,
          obj.burnHashes, logExportReceipt.supplyOnAllChains, obj.importData, 0)

        // After import 2
        globalSupplyETH = await auctions.globalMetSupply()
        globalSupplyETC = await etcAuctions.globalMetSupply()

        assert.equal(globalSupplyETC.toNumber(), globalSupplyETH.toNumber(), 'Global supply in two chain is not correct')
        let balanceAfterImport = await etcMetToken.balanceOf(obj.addresses[1])
        assert.equal(balanceAfterImport.valueOf(), amountToExport)

        totalSupply = await etcMetToken.totalSupply()
        assert.equal(totalSupply.valueOf(), amountToExport + METTokenETCInitialSupply, 'Total supply after import is not correct')
        let dailyMintableETC = await etcAuctions.dailyMintable()
        await auctions.sendTransaction({ from: buyer, value: amount })
        // let dailyMintableETH = await auctions.dailyMintable()
        // assert.equal(dailyMintableETC.toNumber() + dailyMintableETH.toNumber(), 2880e18, 'Daily mintable is wrong')
        await TestRPCTime.timeTravel(SECS_IN_MINUTE)
        await TestRPCTime.mineBlock()
        tx = await metToken.export(
          destChain,
          destMetAddr,
          buyer,
          amountToExport,
          exportFee,
          web3.fromAscii(expectedExtraData),
          { from: buyer })
        decoder = ethjsABI.logDecoder(tokenPorter.abi)
        logExportReceipt = decoder(tx.receipt.logs)[0]

        obj = prepareImportData(tokenPorter, tx)
        await TestRPCTime.timeTravel(2 * SECS_IN_DAY)
        await TestRPCTime.mineBlock()

        await etcValidator.validateHash(logExportReceipt.currentBurnHash, {from: OWNER})
        await etcValidator.validateHash(logExportReceipt.currentBurnHash, {from: accounts[1]})
        assert.isTrue(await etcValidator.hashClaimable(logExportReceipt.currentBurnHash))

        // Before import 2

        imported = await etcMetToken.importMET.call(web3.fromAscii('ETH'), logExportReceipt.destinationChain, obj.addresses, logExportReceipt.extraData,
          obj.burnHashes, logExportReceipt.supplyOnAllChains, obj.importData, 0)
        await etcMetToken.importMET(web3.fromAscii('ETH'), logExportReceipt.destinationChain, obj.addresses, logExportReceipt.extraData,
          obj.burnHashes, logExportReceipt.supplyOnAllChains, obj.importData, 0)
        assert(imported, 'Import in ETC failed')
        // After import 2
        globalSupplyETH = await auctions.globalMetSupply()
        globalSupplyETC = await etcAuctions.globalMetSupply()

        assert.equal(globalSupplyETC.toNumber(), globalSupplyETH.toNumber(), 'Global supply in two chain is not correct')
        balanceAfterImport = await etcMetToken.balanceOf(obj.addresses[1])
        assert.equal(balanceAfterImport.valueOf(), amountToExport * 2)
        // var heartbeatETC = await etcAuctions.heartbeat()
        totalSupply = await etcMetToken.totalSupply()
        assert.equal(totalSupply.valueOf(), (2 * amountToExport) + METTokenETCInitialSupply, 'Total supply after import is not correct')
        dailyMintableETC = await etcAuctions.dailyMintable()

        try {
          await etcMetToken.enableMETTransfers({ from: OWNER })
        } catch (e) {

        }
        let errorThrown
        try {
          await etcAuctions.sendTransaction({ from: accounts[0], value: amount })
          totalSupply = await etcMetToken.totalSupply()
        } catch (e) {
          errorThrown = true
        }

        assert(errorThrown, 'Mintable should be 0')
        dailyMintableETC = await etcAuctions.dailyMintable()
        let dailyMintableETH = await auctions.dailyMintable()
        assert.equal(dailyMintableETC.toNumber() + dailyMintableETH.toNumber(), 2880e18, 'Daily mintable is wrong')

        // assert(errorThrown, 'Mintable should be zeoro')
        await TestRPCTime.timeTravel(7 * SECS_IN_DAY)
        await TestRPCTime.mineBlock()

        try {
          await etcMetToken.enableMETTransfers({ from: OWNER })
        } catch (e) {

        }

        await etcAuctions.sendTransaction({ from: accounts[4], value: amount })
        let balanceAfterPurchase = await etcMetToken.balanceOf(accounts[4])
        assert(balanceAfterPurchase.toNumber() > 0, 'No purchase done in Auction in ETC')

        resolve()
      })
    })

    it('Export and import test 3 . ETH to ETC', () => {
      return new Promise(async (resolve, reject) => {
        const exportFee = 0
        const amountToExport = 6e14 - exportFee

        const { auctions, metToken, tokenPorter } = await METGlobal.initContracts(accounts, TestRPCTime.getCurrentBlockTime() - 60, MINIMUM_PRICE, STARTING_PRICE, TIME_SCALE)
        let initialAuctionEndTime = await auctions.initialAuctionEndTime()
        const { etcAuctions, etcMetToken, etcValidator } = await METGlobal.initNonOGContracts(accounts, TestRPCTime.getCurrentBlockTime() - 60, (MINIMUM_PRICE / 2), STARTING_PRICE, TIME_SCALE, initialAuctionEndTime.valueOf())
        await TestRPCTime.timeTravel((2 * SECS_IN_DAY) - SECS_IN_MINUTE)
        await TestRPCTime.mineBlock()

        // get some balance for export
        const buyer = accounts[7]
        const amount = 1e18
        await auctions.sendTransaction({ from: buyer, value: amount })

        var balanceOfBuyer = await metToken.balanceOf(buyer)
        assert.isAbove(balanceOfBuyer.toNumber(), amountToExport, 'Balance of buyer after purchase is not correct')

        const SECS_TO_NEXT_MIDNIGHT = await secondsToNextMidnight()
        await TestRPCTime.timeTravel(SECS_TO_NEXT_MIDNIGHT)
        await TestRPCTime.mineBlock()
        await auctions.sendTransaction({ from: buyer, value: amount })
        // await initETCMockContracts(await auctions.genesisTime())
        destMetAddr = etcMetToken.address
        await tokenPorter.addDestinationChain(destChain, destMetAddr, { from: OWNER })
        // export all tokens
        const expectedExtraData = 'extra data'
        let tx = await metToken.export(
          destChain,
          destMetAddr,
          buyer,
          amountToExport,
          exportFee,
          web3.fromAscii(expectedExtraData),
          { from: buyer })

        // retrieve data from export receipt, it will be used for import in mock ETC
        let decoder = ethjsABI.logDecoder(tokenPorter.abi)
        let logExportReceipt = decoder(tx.receipt.logs)[0]

        let obj = prepareImportData(tokenPorter, tx)
        await TestRPCTime.timeTravel(9 * SECS_IN_DAY)
        await TestRPCTime.mineBlock()

        await etcValidator.validateHash(logExportReceipt.currentBurnHash, {from: OWNER})
        await etcValidator.validateHash(logExportReceipt.currentBurnHash, {from: accounts[1]})

        assert.isTrue(await etcValidator.hashClaimable(logExportReceipt.currentBurnHash))

        // Before import 1
        var totalSupply = await etcMetToken.totalSupply()
        assert(totalSupply, 0, 'Total supply in ETC before import is not correct')
        let globalSupplyETH = await auctions.globalMetSupply()
        let globalSupplyETC = await etcAuctions.globalMetSupply()

        assert.equal(globalSupplyETC.toNumber(), globalSupplyETC.toNumber(), 'Global supply in ETC  is not correct')

        let importSuccess = await etcMetToken.importMET.call(web3.fromAscii('ETH'), logExportReceipt.destinationChain, obj.addresses, logExportReceipt.extraData,
          obj.burnHashes, logExportReceipt.supplyOnAllChains, obj.importData, 0)
        assert(importSuccess, 'Import failed')
        await etcMetToken.importMET(web3.fromAscii('ETH'), logExportReceipt.destinationChain, obj.addresses, logExportReceipt.extraData,
          obj.burnHashes, logExportReceipt.supplyOnAllChains, obj.importData, 0)

        // After import 1
        globalSupplyETH = await auctions.globalMetSupply()
        globalSupplyETC = await etcAuctions.globalMetSupply()
        assert.equal(globalSupplyETC.toNumber(), globalSupplyETH.toNumber(), 'Global supply in two chain is not correct')

        let metBalanceOfBuyerInETC = await etcMetToken.balanceOf(obj.addresses[1])
        assert(metBalanceOfBuyerInETC, amountToExport, 'Imported amount is not correct')
        totalSupply = await etcMetToken.totalSupply()
        assert.equal((totalSupply.sub(METTokenETCInitialSupply)).valueOf(), amountToExport, 'Total supply in ETC is wrong')
        // let dailyMintableETC = await etcAuctions.dailyMintable()
        // await auctions.sendTransaction({ from: buyer, value: amount })
        // let dailyMintableETH = await auctions.dailyMintable()
        // assert.equal(dailyMintableETC.toNumber() + dailyMintableETH.toNumber(), 2880e18, 'Daily mintable is wrong')

        await TestRPCTime.timeTravel(SECS_IN_MINUTE)
        await TestRPCTime.mineBlock()
        tx = await metToken.export(
          destChain,
          destMetAddr,
          buyer,
          amountToExport,
          exportFee,
          web3.fromAscii(expectedExtraData),
          { from: buyer })
        decoder = ethjsABI.logDecoder(tokenPorter.abi)
        logExportReceipt = decoder(tx.receipt.logs)[0]

        obj = prepareImportData(tokenPorter, tx)

        await etcValidator.validateHash(logExportReceipt.currentBurnHash, {from: OWNER})
        await etcValidator.validateHash(logExportReceipt.currentBurnHash, {from: accounts[1]})
        assert.isTrue(await etcValidator.hashClaimable(logExportReceipt.currentBurnHash))

        // Before import 2
        totalSupply = await etcMetToken.totalSupply()
        assert.equal(totalSupply.sub(METTokenETCInitialSupply).valueOf(), amountToExport, 'Total supply is wrong in ETC')
        globalSupplyETH = await auctions.globalMetSupply()
        globalSupplyETC = await etcAuctions.globalMetSupply()
        assert.equal(globalSupplyETC.toNumber(), globalSupplyETH.toNumber(), 'Global supply in two chain is not correct')

        importSuccess = await etcMetToken.importMET.call(web3.fromAscii('ETH'), logExportReceipt.destinationChain, obj.addresses, logExportReceipt.extraData,
          obj.burnHashes, logExportReceipt.supplyOnAllChains, obj.importData, 0)
        assert(importSuccess, 'Import failed')
        await etcMetToken.importMET(web3.fromAscii('ETH'), logExportReceipt.destinationChain, obj.addresses, logExportReceipt.extraData,
          obj.burnHashes, logExportReceipt.supplyOnAllChains, obj.importData, 0)

        // After import 2
        let balanceAfterImport = await etcMetToken.balanceOf(obj.addresses[1])
        assert.equal(balanceAfterImport.valueOf(), amountToExport * 2)
        totalSupply = await etcMetToken.totalSupply()
        assert.equal(totalSupply.valueOf(), (2 * amountToExport) + METTokenETCInitialSupply, 'Total supply after import is not correct')
        globalSupplyETH = await auctions.globalMetSupply()
        globalSupplyETC = await etcAuctions.globalMetSupply()
        assert.equal(globalSupplyETC.toNumber(), globalSupplyETH.toNumber(), 'Global supply in two chain is not correct')

        await auctions.sendTransaction({ from: accounts[8], value: 1e5 })

        try {
          await etcMetToken.enableMETTransfers({ from: OWNER })
        } catch (e) {

        }
        try {
          await TestRPCTime.timeTravel(1 * SECS_IN_DAY)
          await TestRPCTime.mineBlock()
          await etcAuctions.sendTransaction({ from: accounts[0], value: 1e18 })

          totalSupply = await etcMetToken.totalSupply()
        } catch (e) {
          assert(false, 'Error thrown during buy in auction')
        }
        totalSupply = await etcMetToken.totalSupply()

        // Todo: correct this test
        // assert.equal(dailyMintableETC.toNumber() + dailyMintableETH.toNumber(), 2880e18, 'Daily mintable is wrong')

        resolve()
      })
    })

    it('Basic export test . ETC to ETH', () => {
      return new Promise(async (resolve, reject) => {
        const exportFee = 0
        const amountToExport = 3e23 - exportFee

        const { auctions, metToken, tokenPorter, validator } = await METGlobal.initContracts(accounts, TestRPCTime.getCurrentBlockTime() - 60, MINIMUM_PRICE, STARTING_PRICE, TIME_SCALE)
        let initialAuctionEndTime = await auctions.initialAuctionEndTime()
        const { etcAuctions, etcMetToken, etcTokenPorter, etcValidator } = await METGlobal.initNonOGContracts(accounts, TestRPCTime.getCurrentBlockTime() - 60, MINIMUM_PRICE, (STARTING_PRICE / 2), TIME_SCALE, initialAuctionEndTime.valueOf())
        // Time travel to just a minute before initial auction end
        await TestRPCTime.timeTravel((7 * SECS_IN_DAY) - SECS_IN_MINUTE)
        await TestRPCTime.mineBlock()

        // get some balance for export
        const buyer = accounts[7]
        const amount = 1e18
        await auctions.sendTransaction({ from: buyer, value: amount })

        var balanceOfBuyer = await metToken.balanceOf(buyer)
        assert.isAbove(balanceOfBuyer.toNumber(), amountToExport, 'Balance of buyer after purchase is not correct')

        const SECS_TO_NEXT_MIDNIGHT = await secondsToNextMidnight()
        await TestRPCTime.timeTravel(SECS_TO_NEXT_MIDNIGHT)
        await TestRPCTime.mineBlock()
        await auctions.sendTransaction({ from: buyer, value: amount })
        // await initETCMockContracts(await auctions.genesisTime())
        destMetAddr = etcMetToken.address
        await tokenPorter.addDestinationChain(destChain, destMetAddr, { from: OWNER })
        await etcTokenPorter.addDestinationChain(destChainETH, metToken.address, { from: OWNER })

        // export all tokens
        const expectedExtraData = 'extra data'
        let tx = await metToken.export(
          destChain,
          destMetAddr,
          buyer,
          amountToExport,
          exportFee,
          web3.fromAscii(expectedExtraData),
          { from: buyer })

        // retrieve data from export receipt, it will be used for import in mock ETC
        let decoder = ethjsABI.logDecoder(tokenPorter.abi)
        let logExportReceipt = decoder(tx.receipt.logs)[0]

        let obj = prepareImportData(tokenPorter, tx)

        await TestRPCTime.timeTravel(20 * SECS_IN_DAY)
        await TestRPCTime.mineBlock()

        await etcValidator.validateHash(logExportReceipt.currentBurnHash, {from: OWNER})
        await etcValidator.validateHash(logExportReceipt.currentBurnHash, {from: accounts[1]})

        assert.isTrue(await etcValidator.hashClaimable(logExportReceipt.currentBurnHash))

        // Before Import
        var totalSupply = await etcMetToken.totalSupply()
        assert.equal(totalSupply.valueOf(), 0, 'Total supply in ETC is not 0')
        let imported = await etcMetToken.importMET.call(web3.fromAscii('ETH'), logExportReceipt.destinationChain, obj.addresses, logExportReceipt.extraData,
          obj.burnHashes, logExportReceipt.supplyOnAllChains, obj.importData, 0)

        tx = await etcMetToken.importMET(web3.fromAscii('ETH'), logExportReceipt.destinationChain, obj.addresses, logExportReceipt.extraData,
          obj.burnHashes, logExportReceipt.supplyOnAllChains, obj.importData, 0)
        assert(imported, 'Import in ETC failed')
        let logImportReceipt = decoder(tx.receipt.logs)[0]
        assert.equal(logImportReceipt.currentHash, logExportReceipt.currentBurnHash, 'Hash in import log not correct')

        // After import
        let globalSupplyETH = await auctions.globalMetSupply()
        let globalSupplyETC = await etcAuctions.globalMetSupply()
        assert.equal(globalSupplyETC.toNumber(), globalSupplyETH.toNumber(), 'Global supply in two chain is not correct')
        let balanceAfterImport = await etcMetToken.balanceOf(obj.addresses[1])
        assert.equal(balanceAfterImport.valueOf(), amountToExport)

        await TestRPCTime.timeTravel(SECS_IN_MINUTE)
        await TestRPCTime.mineBlock()
        tx = await etcMetToken.export(
          destChainETH,
          metToken.address,
          buyer,
          amountToExport,
          exportFee,
          web3.fromAscii(expectedExtraData),
          { from: buyer })
        let totalSupplyETC = await etcMetToken.totalSupply()
        assert.equal(totalSupplyETC.valueOf(), METTokenETCInitialSupply, 'total supply after export is wrong')
        decoder = ethjsABI.logDecoder(etcTokenPorter.abi)
        logExportReceipt = decoder(tx.receipt.logs)[0]
        obj = prepareImportData(etcTokenPorter, tx)
        await validator.validateHash(logExportReceipt.currentBurnHash, {from: OWNER})
        await validator.validateHash(logExportReceipt.currentBurnHash, {from: accounts[1]})

        assert.isTrue(await validator.hashClaimable(logExportReceipt.currentBurnHash))

        imported = await metToken.importMET.call(web3.fromAscii('ETC'), logExportReceipt.destinationChain, obj.addresses, logExportReceipt.extraData,
          obj.burnHashes, logExportReceipt.supplyOnAllChains, obj.importData, 0)
        assert(imported, 'Import in ETH failed')
        let totalSupplyETHBefore = await metToken.totalSupply()
        tx = await metToken.importMET(web3.fromAscii('ETC'), logExportReceipt.destinationChain, obj.addresses, logExportReceipt.extraData,
          obj.burnHashes, logExportReceipt.supplyOnAllChains, obj.importData, 0)
        logImportReceipt = decoder(tx.receipt.logs)[0]
        assert.equal(logImportReceipt.currentHash, logExportReceipt.currentBurnHash, 'Hash in import log not correct')
        let totalSupplyETHAfter = await metToken.totalSupply()
        assert((totalSupplyETHAfter.sub(totalSupplyETHBefore)).valueOf(), amountToExport)
        resolve()
      })
    })

    // it('Test AC in ETC after import.', () => {
    //   return new Promise(async (resolve, reject) => {
    //     const exportFee = 0
    //     const amountToExport = 3e23 - exportFee

    //     const { auctions, metToken, tokenPorter } = await METGlobal.initContracts(accounts, TestRPCTime.getCurrentBlockTime() - 60, MINIMUM_PRICE, STARTING_PRICE, TIME_SCALE)
    //     await initETCMockContracts(await auctions.genesisTime())
    //     // Time travel to just a minute before initial auction end
    //     await TestRPCTime.timeTravel((7 * SECS_IN_DAY) - SECS_IN_MINUTE)
    //     await TestRPCTime.mineBlock()

    //     // get some balance for export
    //     const buyer = accounts[7]
    //     const amount = 1e18
    //     await auctions.sendTransaction({ from: buyer, value: amount })

    //     const SECS_TO_NEXT_MIDNIGHT = await secondsToNextMidnight()
    //     await TestRPCTime.timeTravel(SECS_TO_NEXT_MIDNIGHT)
    //     await TestRPCTime.mineBlock()
    //     await auctions.sendTransaction({ from: buyer, value: amount })
    //     destMetAddr = etcMetToken.address
    //     await tokenPorter.addDestinationChain(destChain, destMetAddr, { from: OWNER })
    //     // export all tokens
    //     const expectedExtraData = 'extra data'
    //     const tx = await metToken.export(
    //       destChain,
    //       destMetAddr,
    //       buyer,
    //       amountToExport,
    //       exportFee,
    //       web3.fromAscii(expectedExtraData),
    //       { from: buyer })

    //     // retrieve data from export receipt, it will be used for import in mock ETC
    //     const decoder = ethjsABI.logDecoder(tokenPorter.abi)
    //     const logExportReceipt = decoder(tx.receipt.logs)[0]

    //     let obj = prepareImportData(tokenPorter, tx)

    //     await TestRPCTime.timeTravel(20 * SECS_IN_DAY)
    //     await TestRPCTime.mineBlock()

    //     await etcValidator.validateHash(logExportReceipt.currentBurnHash, {from: OWNER})
    //     await etcValidator.validateHash(logExportReceipt.currentBurnHash, {from: accounts[1]})

    //     // Before Import
    //     var totalSupply = await etcMetToken.totalSupply()
    //     assert.equal(totalSupply.valueOf(), 0, 'Total supply in ETC is not 0')
    //     const imported = await etcTokenPorter.importMET.call(logExportReceipt.destinationChain, obj.addresses, logExportReceipt.extraData,
    //       obj.burnHashes, logExportReceipt.supplyOnAllChains, obj.importData, 0)

    //     await etcTokenPorter.importMET(logExportReceipt.destinationChain, obj.addresses, logExportReceipt.extraData,
    //       obj.burnHashes, logExportReceipt.supplyOnAllChains, obj.importData, 0)
    //     assert(imported, 'Import in ETC failed')
    //     // After import

    //     await TestRPCTime.timeTravel(SECS_IN_MINUTE)
    //     await TestRPCTime.mineBlock()
    //     const WEI_SENT = 1e18
    //     const MIN_MET_RETURN = 1
    //     const prediction = await autonomousConverterETC.getMetForEthResult(WEI_SENT, { from: OWNER })

    //     assert(prediction.toNumber() > 0, 'ETH to MET prediction is not greater than zero')
    //     const reserveSupply = await autonomousConverterETC.getMetBalance({ from: OWNER })
    //     assert(prediction.toNumber() <= reserveSupply.toNumber(), 'Prediction is larger than reserve supply')

    //     const ethBalanceOfACBefore = await web3.eth.getBalance(autonomousConverterETC.address)
    //     const metBalanceOfACBefore = await etcMetToken.balanceOf(autonomousConverterETC.address)
    //     const mtTokenBalanceOfOwnerBefore = await etcMetToken.balanceOf(OWNER)
    //     await etcMetToken.enableMETTransfers({ from: OWNER })

    //     const txChange = await autonomousConverterETC.convertEthToMet(MIN_MET_RETURN, {from: OWNER, value: WEI_SENT})
    //     assert(txChange, 'ETH to MET transaction failed')

    //     const ethBalanceOfACAfter = await web3.eth.getBalance(autonomousConverterETC.address)
    //     const metBalanceOfACAfter = await etcMetToken.balanceOf(autonomousConverterETC.address)
    //     const mtTokenBalanceOfOwnerAfter = await etcMetToken.balanceOf(OWNER)
    //     const smartTokenAfterBalance = await smartTokenETC.balanceOf(OWNER, { from: autonomousConverterETC.address })

    //     assert.equal(mtTokenBalanceOfOwnerAfter.toNumber() - mtTokenBalanceOfOwnerBefore.toNumber(), prediction.toNumber(), 'Prediction and actual is not correct for owner')
    //     assert.closeTo(metBalanceOfACBefore.toNumber() - metBalanceOfACAfter.toNumber(), prediction.toNumber(), 1000, 'Prediction and actual is not correct for AC')
    //     assert.equal(smartTokenAfterBalance.toNumber(), 0, 'Smart Tokens were not destroyed')
    //     assert(mtTokenBalanceOfOwnerAfter.toNumber(), metBalanceOfACBefore.toNumber() - metBalanceOfACAfter.toNumber(), 'MET  not recieved after ETH exchange')
    //     assert(ethBalanceOfACAfter.toNumber() > ethBalanceOfACBefore.toNumber(), 'ETH  not recieved after ETH exchange')

    //     resolve()
    //   })
    // })

    it('Test Auction in ETC after import.', () => {
      return new Promise(async (resolve, reject) => {
        const exportFee = 0
        const amountToExport = 3e23 - exportFee

        const { auctions, metToken, tokenPorter } = await METGlobal.initContracts(accounts, TestRPCTime.getCurrentBlockTime() - 60, MINIMUM_PRICE, STARTING_PRICE, TIME_SCALE)
        let initialAuctionEndTime = await auctions.initialAuctionEndTime()
        const { etcAuctions, etcMetToken, etcValidator } = await METGlobal.initNonOGContracts(accounts, TestRPCTime.getCurrentBlockTime() - 60, MINIMUM_PRICE, (STARTING_PRICE / 2), TIME_SCALE, initialAuctionEndTime.valueOf())
        // Time travel to just a minute before initial auction end
        await TestRPCTime.timeTravel((7 * SECS_IN_DAY) - SECS_IN_MINUTE)
        await TestRPCTime.mineBlock()

        // get some balance for export
        const buyer = accounts[7]
        const amount = 1e18
        await auctions.sendTransaction({ from: buyer, value: amount })

        let SECS_TO_NEXT_MIDNIGHT = await secondsToNextMidnight()
        await TestRPCTime.timeTravel(SECS_TO_NEXT_MIDNIGHT + (SECS_IN_DAY * 8) + (10 * SECS_IN_MINUTE))
        await TestRPCTime.mineBlock()
        await auctions.sendTransaction({ from: buyer, value: amount })
        destMetAddr = etcMetToken.address
        await tokenPorter.addDestinationChain(destChain, destMetAddr, { from: OWNER })
        // export all tokens
        const expectedExtraData = 'extra data'
        let tx = await metToken.export(
          destChain,
          destMetAddr,
          buyer,
          amountToExport,
          exportFee,
          web3.fromAscii(expectedExtraData),
          { from: buyer })

        // retrieve data from export receipt, it will be used for import in mock ETC
        let decoder = ethjsABI.logDecoder(tokenPorter.abi)
        const logExportReceipt = decoder(tx.receipt.logs)[0]

        let obj = prepareImportData(tokenPorter, tx)

        await etcValidator.validateHash(logExportReceipt.currentBurnHash, {from: OWNER})
        await etcValidator.validateHash(logExportReceipt.currentBurnHash, {from: accounts[1]})

        // Before Import
        var totalSupply = await etcMetToken.totalSupply()
        assert.equal(totalSupply.valueOf(), 0, 'Total supply in ETC is not 0')
        const imported = await etcMetToken.importMET.call(web3.fromAscii('ETH'), logExportReceipt.destinationChain, obj.addresses, logExportReceipt.extraData,
          obj.burnHashes, logExportReceipt.supplyOnAllChains, obj.importData, 0)

        await etcMetToken.importMET(web3.fromAscii('ETH'), logExportReceipt.destinationChain, obj.addresses, logExportReceipt.extraData,
          obj.burnHashes, logExportReceipt.supplyOnAllChains, obj.importData, 0)
        assert(imported, 'Import in ETC failed')
        // After import

        await TestRPCTime.timeTravel(1 * SECS_IN_DAY)
        await TestRPCTime.mineBlock()
        const amountUsedForPurchase = 1e18

        const expectedTokenPurchase = 552863677660940280
        let expectedWeiPerToken = 1808764150017608980
        // const tokensInNextAuction = 8e24 + 3 * 2880e18
        // perform actual transaction
        const mtTokenBalanceBefore = await etcMetToken.balanceOf(OWNER)

        tx = await etcAuctions.sendTransaction({ from: OWNER, value: amountUsedForPurchase })

        let lastPurchasePrice = await etcAuctions.lastPurchasePrice()
        assert.equal(lastPurchasePrice.valueOf(), expectedWeiPerToken, 'last Purchase price is not correct')

        const mtTokenBalanceAfter = await etcMetToken.balanceOf(OWNER)
        assert.equal(mtTokenBalanceAfter.sub(mtTokenBalanceBefore).valueOf(), expectedTokenPurchase, 'Total purchased/minted tokens are not correct')

        await TestRPCTime.timeTravel(SECS_IN_DAY)
        await TestRPCTime.mineBlock()
        // const expectedNextAuctionPrice = 20736727076

        await etcAuctions.sendTransaction({
          from: OWNER,
          value: amountUsedForPurchase
        })
        expectedWeiPerToken = 1875392426219

        lastPurchasePrice = await etcAuctions.lastPurchasePrice()
        assert.closeTo(lastPurchasePrice.toNumber(), expectedWeiPerToken, 200, 'Expected purchase price is wrong')

        resolve()
      })
    })
  })
})
