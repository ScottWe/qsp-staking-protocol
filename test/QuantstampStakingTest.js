/***************************************************************************************************
*                                                                                                  *
* (c) 2018, 2019 Quantstamp, Inc. This content and its use are governed by the license terms at    *
* <https://raw.githubusercontent.com/quantstamp/qsp-staking-protocol/master/LICENSE>               *
*                                                                                                  *
***************************************************************************************************/

const QuantstampStaking = artifacts.require('QuantstampStaking');
const QuantstampStakingData = artifacts.require('QuantstampStakingData');
const QuantstampToken = artifacts.require('QuantstampToken');
const QuantstampStakingRegistry = artifacts.require('test/Registry');
const RegistryWrapper = artifacts.require('TokenCuratedRegistry');
const WhitelistExpertRegistry = artifacts.require('WhitelistExpertRegistry');
const QuantstampParameterizer = artifacts.require('Parameterizer');
const Voting = artifacts.require('plcr-revival/contracts/PLCRVoting.sol');
const ZeroBalancePolicy = artifacts.require('ZeroBalancePolicy');
const CandidateContract = artifacts.require('CandidateContract');
const CandidateAndPolicyContract = artifacts.require('CandidateAndPolicyContract');
const Web3 = require('web3');
const web3 = new Web3(new Web3.providers.HttpProvider("http://127.0.0.1:7545"));
const Util = require('./util.js');
const TCRUtil = require('./tcrutils.js');
const BigNumber = require('bignumber.js');
const uuid = require('uuid');

contract('QuantstampStaking', function(accounts) {
  const owner = accounts[0];
  const qspAdmin = accounts[1];
  const poolOwner = accounts[3];
  const staker = accounts[4];
  const staker2 = accounts[5];
  const staker3 = accounts[6];
  const poolOwnerBudget = new BigNumber(Util.toQsp(100000));
  const stakerBudget = new BigNumber(Util.toQsp(100000));
  const candidateContractBalance = new BigNumber(Util.toEther(100));
  const PoolState = Object.freeze({
    None : 0,
    Initialized : 1,
    NotViolatedUnderfunded : 2,
    ViolatedUnderfunded : 3,
    NotViolatedFunded : 4,
    ViolatedFunded : 5,
    Cancelled: 6,
    PolicyExpired: 7
  });

  // vars needed for creating pool
  const maxPayoutQspWei = new BigNumber(Util.toQsp(100));
  const minStakeQspWei = new BigNumber(Util.toQsp(10));
  const depositQspWei = new BigNumber(Util.toQsp(10));
  const bonusExpertFactor = new BigNumber(3);
  const bonusFirstExpertFactor = new BigNumber(5);
  const payPeriodInBlocks = new BigNumber(5);
  const minStakeTimeInBlocks = new BigNumber(10);
  const timeoutInBlocks = new BigNumber(5);
  const urlOfAuditReport = "URL";
  const poolUniqueName = () => uuid.v4();
  const maxStakeQspWei = minStakeQspWei.times(2);
  const defaultMaxTotalStake = new BigNumber(Util.toQsp(100000));

  let quantstampStakingData;
  let qspb;
  let quantstampToken;
  let quantstampRegistry;
  let wrapper;
  let candidateContract;
  let contractPolicy;
  let poolState;
  let currentPoolNumber;
  let currentPoolIndex;

  async function mineAndWithdrawUntilDepositLeftLessThan(poolId, balance) {
    // note: this can make the method behave flaky if more than 1 pay periods are to be paid out
    let depositLeft = await quantstampStakingData.getPoolDepositQspWei(poolId);
    await Util.mineNBlocks(payPeriodInBlocks);
    while (depositLeft.gte(balance)) {
      await qspb.withdrawInterest(poolId, {from : staker});
      depositLeft = await quantstampStakingData.getPoolDepositQspWei(poolId);
    }
  }

  describe("constructor", async function() {
    it("should not be able to construct the QuantstampAssurance contract if the token address is 0", async function() {
      quantstampRegistry = await QuantstampStakingRegistry.new();
      quantstampToken = await QuantstampToken.new(qspAdmin, {from: owner});
      quantstampStakingData = await QuantstampStakingData.new(quantstampToken.address);
      wrapper = await RegistryWrapper.new(quantstampRegistry.address);
      await Util.assertTxFail(QuantstampStaking.new(Util.ZERO_ADDRESS, wrapper.address,
        quantstampStakingData.address, {from: owner}));
    });

    it("should fail if a TCR with address zero is passed into the constructor", async function () {
      quantstampToken = await QuantstampToken.new(qspAdmin, {from: owner});
      quantstampStakingData = await QuantstampStakingData.new(quantstampToken.address);
      await Util.assertTxFail(QuantstampStaking.new(quantstampToken.address, Util.ZERO_ADDRESS,
        quantstampStakingData.address, {from: owner}));
    });
  });

  describe("createPool", async function() {
    it("should not create a pool if it cannot transfer the deposit from the pool owner", async function() {
      quantstampStakingData = await QuantstampStakingData.deployed();
      qspb = await QuantstampStaking.deployed();
      await quantstampStakingData.setWhitelistAddress(qspb.address);
      quantstampToken = await QuantstampToken.deployed();
      candidateContract = await CandidateContract.deployed();
      contractPolicy = await ZeroBalancePolicy.deployed();
      await Util.assertTxFail(qspb.createPool(candidateContract.address, contractPolicy.address, maxPayoutQspWei, minStakeQspWei,
        depositQspWei, bonusExpertFactor, bonusFirstExpertFactor, payPeriodInBlocks,
        minStakeTimeInBlocks, timeoutInBlocks, urlOfAuditReport, poolUniqueName(), defaultMaxTotalStake, {from: poolOwner}));
    });

    it("should not find the pool index of a non-existing name", async function() {
      const MAX_INT = new BigNumber(2).pow(256).minus(1);
      assert.equal((await qspb.getPoolIndex(poolUniqueName())).toNumber(), MAX_INT.toNumber());
    });

    it("should add a pool", async function() {
      const poolName = poolUniqueName();
      // enable transfers before any payments are allowed
      await quantstampToken.enableTransfer({from : owner});
      // transfer poolOwnerBudget QSP tokens to the poolOwner
      await quantstampToken.transfer(poolOwner, poolOwnerBudget, {from : owner});
      // allow the qspb contract use up to 1000QSP
      await quantstampToken.approve(qspb.address, Util.toQsp(1000), {from : poolOwner});
      // balance should be 0 in the beginning
      assert.equal(await quantstampStakingData.balanceQspWei(), 0);
      // create pool
      await qspb.createPool(candidateContract.address, contractPolicy.address, maxPayoutQspWei, minStakeQspWei,
        depositQspWei, bonusExpertFactor, bonusFirstExpertFactor, payPeriodInBlocks,
        minStakeTimeInBlocks, timeoutInBlocks, urlOfAuditReport, poolName, defaultMaxTotalStake, {from: poolOwner});
      const timeOfStateInBlocks = new BigNumber((await web3.eth.getBlock("latest")).number);
      const zero = new BigNumber(0);
      // check all pool properties
      assert.equal(await quantstampStakingData.getPoolsLength(), 1);
      assert.equal(await quantstampStakingData.getPoolCandidateContract(0), candidateContract.address);
      assert.equal(await quantstampStakingData.getPoolContractPolicy(0), contractPolicy.address);
      assert.equal(await quantstampStakingData.getPoolOwner(0), poolOwner);
      assert.equal(await quantstampStakingData.getPoolMaxPayoutQspWei(0), maxPayoutQspWei.toNumber());
      assert.equal(minStakeQspWei.toNumber(), (await quantstampStakingData.getPoolMinStakeQspWei(0)).toNumber());
      assert.equal(depositQspWei.toNumber(), (await quantstampStakingData.getPoolDepositQspWei(0)).toNumber());
      assert.equal(await quantstampStakingData.getPoolBonusExpertFactor(0), bonusExpertFactor.toNumber());
      assert.equal(await quantstampStakingData.getPoolBonusFirstExpertFactor(0), bonusFirstExpertFactor.toNumber());
      assert.equal(await quantstampStakingData.getPoolPayPeriodInBlocks(0), payPeriodInBlocks.toNumber());
      assert.equal(minStakeTimeInBlocks.toNumber(), (await quantstampStakingData.getPoolMinStakeTimeInBlocks(0)).toNumber());
      assert.equal(await quantstampStakingData.getPoolTimeoutInBlocks(0), timeoutInBlocks.toNumber());
      assert.equal(await quantstampStakingData.getPoolTimeOfStateInBlocks(0), timeOfStateInBlocks.toNumber());
      assert.equal(await quantstampStakingData.getPoolUrlOfAuditReport(0), urlOfAuditReport);
      assert.equal(await quantstampStakingData.getPoolState(0), PoolState.Initialized);
      assert.equal(await quantstampStakingData.getPoolName(0), poolName);
      assert.equal((await quantstampStakingData.getPoolIndex(poolName)).toNumber(), 0);
      assert.equal((await quantstampStakingData.getPoolMaxTotalStakeQspWei(0)).toNumber(), defaultMaxTotalStake.toNumber());
      const poolParams = await quantstampStakingData.getPoolParams(0);
      poolParams[1] = poolParams[1].map(function(el){ return el.toNumber(); });
      assert.deepEqual(poolParams, [[candidateContract.address, contractPolicy.address, poolOwner, Util.ZERO_ADDRESS],
        [maxPayoutQspWei, minStakeQspWei, defaultMaxTotalStake, bonusExpertFactor, bonusFirstExpertFactor,
          payPeriodInBlocks, minStakeTimeInBlocks, timeoutInBlocks, depositQspWei, timeOfStateInBlocks, zero, zero, zero,
          new BigNumber(PoolState.Initialized)].map(function(el){ return el.toNumber(); }), urlOfAuditReport, poolName]);
      // balance should be increased
      assert.equal(depositQspWei.toNumber(), (await quantstampStakingData.balanceQspWei()).toNumber());
    });

    it("should not create a pool if violation status cannot be checked", async function() {
      // enable transfers before any payments are allowed
      await quantstampToken.enableTransfer({from : owner});
      // transfer poolOwnerBudget QSP tokens to the poolOwner
      await quantstampToken.transfer(poolOwner, poolOwnerBudget, {from : owner});
      // allow the qspb contract use at least depositQspWei
      await quantstampToken.approve(qspb.address, Util.toQsp(1000), {from : poolOwner});
      // create pool. Note: the second parameter is intentionally incompatible with IPolicy
      await Util.assertTxFail(qspb.createPool(candidateContract.address, candidateContract.address, maxPayoutQspWei, minStakeQspWei,
        depositQspWei, bonusExpertFactor, bonusFirstExpertFactor, payPeriodInBlocks,
        minStakeTimeInBlocks, timeoutInBlocks, urlOfAuditReport, poolUniqueName(), defaultMaxTotalStake, {from: poolOwner}));
    });

    it("should not create a pool with the same name of a pool that already exists", async function() {
      const poolName = poolUniqueName();
      // creates a pool successfully
      await qspb.createPool(candidateContract.address, contractPolicy.address, maxPayoutQspWei, minStakeQspWei,
        depositQspWei, bonusExpertFactor, bonusFirstExpertFactor, payPeriodInBlocks,
        minStakeTimeInBlocks, timeoutInBlocks, urlOfAuditReport, poolName, defaultMaxTotalStake, {from: poolOwner});

      await Util.assertTxFail(qspb.createPool(candidateContract.address, contractPolicy.address, maxPayoutQspWei, minStakeQspWei,
        depositQspWei, bonusExpertFactor, bonusFirstExpertFactor, payPeriodInBlocks,
        minStakeTimeInBlocks, timeoutInBlocks, urlOfAuditReport, poolName, defaultMaxTotalStake, {from: poolOwner}));
    });

    it("should not create a pool if the deposit amount is lower than the minimum", async function() {
      // creates a pool successfully
      await qspb.createPool(candidateContract.address, contractPolicy.address, maxPayoutQspWei, minStakeQspWei,
        depositQspWei, bonusExpertFactor, bonusFirstExpertFactor, payPeriodInBlocks,
        minStakeTimeInBlocks, timeoutInBlocks, urlOfAuditReport, poolUniqueName(), defaultMaxTotalStake, {from: poolOwner});

      await qspb.setGlobalMinDepositQspWei(depositQspWei + 1);

      // fails to create a pool
      await Util.assertTxFail(qspb.createPool(candidateContract.address, contractPolicy.address, maxPayoutQspWei, minStakeQspWei,
        depositQspWei, bonusExpertFactor, bonusFirstExpertFactor, payPeriodInBlocks,
        minStakeTimeInBlocks, timeoutInBlocks, urlOfAuditReport, poolUniqueName(), defaultMaxTotalStake, {from: poolOwner}));

      await qspb.setGlobalMinDepositQspWei(0);
    });

    it("should have an owner", async function() {
      assert.equal(await qspb.owner(), owner);
    });

    it("should have the right token address", async function() {
      assert.equal(await qspb.getToken(), quantstampToken.address);
    });

    it("should have the right registry address", async function() {
      const registry = await WhitelistExpertRegistry.deployed();
      assert.equal(await qspb.getStakingRegistry(), registry.address);
    });

    it("should not create a pool if the initial deposit is zero", async function() {
      // This would lead to the risk of stakers never getting payed. Therefore, no one will place a stake
      await Util.assertTxFail(qspb.createPool(candidateContract.address, contractPolicy.address, maxPayoutQspWei,
        minStakeQspWei, 0, bonusExpertFactor, bonusFirstExpertFactor, payPeriodInBlocks,
        minStakeTimeInBlocks, timeoutInBlocks, urlOfAuditReport, poolUniqueName(), defaultMaxTotalStake, {from: poolOwner}));
    });

    it("should not create a pool if the maximum payout per period is zero", async function() {
      // This would mean that the stakeholder would not pay any stakers, which would lead to no stakes
      await Util.assertTxFail(qspb.createPool(candidateContract.address, contractPolicy.address, 0,
        minStakeQspWei, depositQspWei, bonusExpertFactor, bonusFirstExpertFactor, payPeriodInBlocks,
        minStakeTimeInBlocks, timeoutInBlocks, urlOfAuditReport, poolUniqueName(), defaultMaxTotalStake, {from: poolOwner}));
    });

    it("should not create a pool if the minimum stake that needs to be collected is zero", async function() {
      // This would mean that a pool is active without any funds staked, which would not be in the interest of a stakeholder
      await Util.assertTxFail(qspb.createPool(candidateContract.address, contractPolicy.address, maxPayoutQspWei,
        0, depositQspWei, bonusExpertFactor, bonusFirstExpertFactor, payPeriodInBlocks,
        minStakeTimeInBlocks, timeoutInBlocks, urlOfAuditReport, poolUniqueName(), defaultMaxTotalStake, {from: poolOwner}));
    });

    it("should not create a pool if the pay period is zero", async function() {
      // This would lead to a division by zero in the payout computation function and it would mean that
      // payouts are awarded all the time, which could quickly deplate all the deposited funds of the stakeholder
      await Util.assertTxFail(qspb.createPool(candidateContract.address, contractPolicy.address, maxPayoutQspWei,
        minStakeQspWei, depositQspWei, bonusExpertFactor, bonusFirstExpertFactor, 0,
        minStakeTimeInBlocks, timeoutInBlocks, urlOfAuditReport, poolUniqueName(), defaultMaxTotalStake, {from: poolOwner}));
    });

    it("should not create a pool if the minimum staking time is zero", async function() {
      // This would mean that a staker could withdraw their stake at any time from the pool, which would leave the
      // stakeholder unprotected in case an attack is discovered
      await Util.assertTxFail(qspb.createPool(candidateContract.address, contractPolicy.address, maxPayoutQspWei,
        minStakeQspWei, depositQspWei, bonusExpertFactor, bonusFirstExpertFactor, payPeriodInBlocks,
        0, timeoutInBlocks, urlOfAuditReport, poolUniqueName(), defaultMaxTotalStake, {from: poolOwner}));
    });

    it("should not create a pool if the timeout period is zero", async function() {
      // This would place the pool in the cancelled state immediately even if the first interaction is placing a stake
      await Util.assertTxFail(qspb.createPool(candidateContract.address, contractPolicy.address, maxPayoutQspWei,
        minStakeQspWei, depositQspWei, bonusExpertFactor, bonusFirstExpertFactor, payPeriodInBlocks,
        minStakeTimeInBlocks, 0, urlOfAuditReport, poolUniqueName(), defaultMaxTotalStake, {from: poolOwner}));
    });

    it("should create a pool with a zero maximum", async function() {
      assert.equal((await quantstampStakingData.getPoolMaxTotalStakeQspWei(0)).toNumber(), defaultMaxTotalStake.toNumber());
    });
  });

  describe("createPoolWithLimit", async function() {
    it("should create a pool with a specified maximum", async function() {
      // enable transfers before any payments are allowed
      await quantstampToken.enableTransfer({from : owner});
      // transfer poolOwnerBudget QSP tokens to the poolOwner
      await quantstampToken.transfer(poolOwner, poolOwnerBudget, {from : owner});
      // allow the qspb contract use up to 1000QSP
      await quantstampToken.approve(qspb.address, Util.toQsp(1000), {from : poolOwner});
      const limitedPoolName = poolUniqueName();
      // create pool
      const oldPoolLength = parseInt(await quantstampStakingData.getPoolsLength());
      const currentPoolIndex = oldPoolLength;
      await qspb.createPool(candidateContract.address, contractPolicy.address, maxPayoutQspWei, minStakeQspWei,
        depositQspWei, bonusExpertFactor, bonusFirstExpertFactor, payPeriodInBlocks,
        minStakeTimeInBlocks, timeoutInBlocks, urlOfAuditReport, limitedPoolName, maxStakeQspWei, {from: poolOwner});
      // check all pool properties
      assert.equal(await quantstampStakingData.getPoolsLength(), oldPoolLength + 1);
      assert.equal(await quantstampStakingData.getPoolCandidateContract(currentPoolIndex), candidateContract.address);
      assert.equal(await quantstampStakingData.getPoolContractPolicy(currentPoolIndex), contractPolicy.address);
      assert.equal(await quantstampStakingData.getPoolOwner(currentPoolIndex), poolOwner);
      assert.equal(await quantstampStakingData.getPoolMaxPayoutQspWei(currentPoolIndex), maxPayoutQspWei.toNumber());
      assert.equal(minStakeQspWei.toNumber(), (await quantstampStakingData.getPoolMinStakeQspWei(currentPoolIndex)).toNumber());
      assert.equal(depositQspWei.toNumber(), (await quantstampStakingData.getPoolDepositQspWei(currentPoolIndex)).toNumber());
      assert.equal(await quantstampStakingData.getPoolBonusExpertFactor(currentPoolIndex), bonusExpertFactor.toNumber());
      assert.equal(await quantstampStakingData.getPoolBonusFirstExpertFactor(currentPoolIndex), bonusFirstExpertFactor.toNumber());
      assert.equal(await quantstampStakingData.getPoolPayPeriodInBlocks(currentPoolIndex), payPeriodInBlocks.toNumber());
      assert.equal(minStakeTimeInBlocks.toNumber(), (await quantstampStakingData.getPoolMinStakeTimeInBlocks(currentPoolIndex)).toNumber());
      assert.equal(await quantstampStakingData.getPoolTimeoutInBlocks(currentPoolIndex), timeoutInBlocks.toNumber());
      assert.equal(await quantstampStakingData.getPoolTimeOfStateInBlocks(currentPoolIndex), (await web3.eth.getBlock("latest")).number);
      assert.equal(await quantstampStakingData.getPoolUrlOfAuditReport(currentPoolIndex), urlOfAuditReport);
      assert.equal(await quantstampStakingData.getPoolState(currentPoolIndex), PoolState.Initialized);
      assert.equal(await quantstampStakingData.getPoolName(currentPoolIndex), limitedPoolName);
      assert.equal((await quantstampStakingData.getPoolMaxTotalStakeQspWei(currentPoolIndex)).toNumber(), maxStakeQspWei.toNumber());
    });
  });

  describe("withdrawClaim", async function() {

    let quantstampToken;
    let qspb;
    let policy;
    let candidateContract;
    let timeOfStateInBlocks;
    const staker = accounts[4];
    const poolId = 0;
    const stakerBudget = new BigNumber(Util.toQsp(1000));

    // vars needed for creating pool
    const depositQspWei = new BigNumber(Util.toQsp(100));
    const maxPayableQspWei = new BigNumber(10);
    const minStakeQspWei = new BigNumber(1);
    const bonusExpertFactor = new BigNumber(3);
    const bonusFirstExpertFactor = new BigNumber(5);
    const payPeriodInBlocks = new BigNumber(15);
    const minStakeTimeInBlocks = new BigNumber(10000);
    const timeoutInBlocks = new BigNumber(100);
    const urlOfAuditReport = "URL";
    const policyBalance = 1;
    const poolName = poolUniqueName();
    const poolName2 = poolUniqueName();

    beforeEach("setup token and tcr", async function() {
      quantstampToken = await QuantstampToken.new(qspAdmin, {from : owner});
      candidateContract = await CandidateContract.new(policyBalance);
      quantstampRegistry = await QuantstampStakingRegistry.deployed();
      wrapper = await RegistryWrapper.new(quantstampRegistry.address);
      quantstampStakingData = await QuantstampStakingData.new(quantstampToken.address);
      qspb = await QuantstampStaking.new(quantstampToken.address, wrapper.address,
        quantstampStakingData.address);
      await quantstampStakingData.setWhitelistAddress(qspb.address);
      policy = await ZeroBalancePolicy.new();
      // enable transfers before any payments are allowed
      await quantstampToken.enableTransfer({from : owner});
      // transfer 100,000 QSP tokens to the pool owner
      await quantstampToken.transfer(poolOwner, poolOwnerBudget, {from : owner});
      await quantstampToken.transfer(staker, stakerBudget, {from : owner});
      // allow the audit contract use tokens
      await quantstampToken.approve(qspb.address, depositQspWei, {from : poolOwner});
      // create pool
      await qspb.createPool(candidateContract.address, policy.address, maxPayableQspWei, minStakeQspWei,
        depositQspWei, bonusExpertFactor, bonusFirstExpertFactor, payPeriodInBlocks,
        minStakeTimeInBlocks, timeoutInBlocks, urlOfAuditReport, poolName, defaultMaxTotalStake, {from: poolOwner});
      assert.equal(await Util.balanceOf(quantstampToken, poolOwner), poolOwnerBudget.minus(depositQspWei));
    });

    it("should not have any effect when pool is initialized", async function() {
      // the pool state is already intialized
      assert.equal(await quantstampStakingData.getPoolState(poolId), PoolState.Initialized);
      const balancePoolOwner = await Util.balanceOf(quantstampToken, poolOwner);
      const balance = await qspb.getBalanceQspWei();
      await Util.assertTxFail(qspb.withdrawClaim(poolId, {from: poolOwner}));
      assert.equal(await quantstampStakingData.getPoolState(poolId), PoolState.Initialized);
      assert.equal(await Util.balanceOf(quantstampToken, poolOwner), balancePoolOwner);
      assert.equal((await qspb.getBalanceQspWei()).toNumber(), balance.toNumber());
    });

    it("should fail if policy is not violated", async function() {
      await Util.assertTxFail(qspb.checkPolicy(poolId));
    });

    it("should not allow claim withdraw when pool is cancelled", async function() {
      assert.equal(await quantstampStakingData.getPoolState(poolId), PoolState.Initialized);
      // violate policy and cancel pool
      await candidateContract.withdraw(policyBalance);
      await qspb.checkPolicy(poolId);
      assert.equal(await quantstampStakingData.getPoolState(poolId), PoolState.Cancelled);
      await Util.assertTxFail(qspb.withdrawClaim(poolId, {from: poolOwner}));
    });

    it("should not allow claim withdraw by anyone other than the pool owner", async function() {
      // approve and stake funds
      await quantstampToken.approve(qspb.address, minStakeQspWei, {from : staker});
      await qspb.stakeFunds(poolId, minStakeQspWei, {from: staker});
      // this violates the policy
      await candidateContract.withdraw(policyBalance);
      assert.equal(await quantstampStakingData.getPoolState(poolId), PoolState.NotViolatedFunded);
      // switch into the violated stata
      await qspb.checkPolicy(poolId);
      assert.equal(await quantstampStakingData.getPoolState(poolId), PoolState.ViolatedFunded);
      await Util.assertTxFail(qspb.withdrawClaim(poolId, {from: staker}));
      timeOfStateInBlocks = await quantstampStakingData.getPoolTimeOfStateInBlocks(poolId);
      const poolParams = await quantstampStakingData.getPoolParams(0);
      poolParams[1] = poolParams[1].map(function(el){ return el.toNumber(); });
      assert.deepEqual(poolParams, [[candidateContract.address, policy.address, poolOwner, Util.ZERO_ADDRESS],
        [maxPayableQspWei, minStakeQspWei, defaultMaxTotalStake, bonusExpertFactor, bonusFirstExpertFactor,
          payPeriodInBlocks, minStakeTimeInBlocks, timeoutInBlocks, depositQspWei, timeOfStateInBlocks, minStakeQspWei,
          minStakeQspWei, minStakeQspWei, new BigNumber(PoolState.ViolatedFunded)].
          map(function(el){ return el.toNumber(); }), urlOfAuditReport, poolName]);
    });

    it("should not have any effect when pool is not funded", async function() {
      var nextPool = poolId + 1;
      var maxPayout = depositQspWei.plus(10);
      // create another pool with deposit smaller than the payout
      await quantstampToken.approve(qspb.address, depositQspWei, {from : poolOwner});
      await qspb.createPool(candidateContract.address, policy.address, maxPayout, minStakeQspWei,
        depositQspWei, bonusExpertFactor, bonusFirstExpertFactor, payPeriodInBlocks,
        minStakeTimeInBlocks, timeoutInBlocks, urlOfAuditReport, poolName2, defaultMaxTotalStake, {from: poolOwner});
      // approve and stake funds
      await quantstampToken.approve(qspb.address, minStakeQspWei, {from : staker});
      await qspb.stakeFunds(nextPool, minStakeQspWei, {from: staker});
      assert.equal(await quantstampStakingData.getPoolState(nextPool), PoolState.NotViolatedUnderfunded);
      const balancePoolOwner = await Util.balanceOf(quantstampToken, poolOwner);
      const balance = await qspb.getBalanceQspWei();
      await Util.assertTxFail(qspb.withdrawClaim(nextPool, {from: poolOwner}));
      assert.equal((await quantstampStakingData.getPoolState(nextPool)).toNumber(), PoolState.NotViolatedUnderfunded);
      assert.equal(await Util.balanceOf(quantstampToken, poolOwner), balancePoolOwner);
      assert.equal((await qspb.getBalanceQspWei()).toNumber(), balance.toNumber());
    });

    it("should reject withdrawClaim() when pool is not funded and already in violated state", async function() {
      var nextPool = poolId + 1;
      var maxPayout = depositQspWei.plus(10);
      // create another pool with deposit smaller than the payout
      await quantstampToken.approve(qspb.address, depositQspWei, {from : poolOwner});
      await qspb.createPool(candidateContract.address, policy.address, maxPayout, minStakeQspWei,
        depositQspWei, bonusExpertFactor, bonusFirstExpertFactor, payPeriodInBlocks,
        minStakeTimeInBlocks, timeoutInBlocks, urlOfAuditReport, poolName2, defaultMaxTotalStake, {from: poolOwner});
      // approve and stake funds
      await quantstampToken.approve(qspb.address, minStakeQspWei, {from : staker});
      await qspb.stakeFunds(nextPool, minStakeQspWei, {from: staker});
      // violate policy
      await candidateContract.withdraw(policyBalance);
      assert.equal(await quantstampStakingData.getPoolState(nextPool), PoolState.NotViolatedUnderfunded);
      // switch into the violated status
      await qspb.checkPolicy(nextPool);
      assert.equal(await quantstampStakingData.getPoolState(nextPool), PoolState.ViolatedUnderfunded);
      await Util.assertTxFail(qspb.withdrawClaim(nextPool, {from: poolOwner}));
    });

    it("should reject when policy is not violated", async function() {
      // approve and stake funds
      await quantstampToken.approve(qspb.address, minStakeQspWei, {from : staker});
      await qspb.stakeFunds(poolId, minStakeQspWei, {from: staker});
      assert.equal(await quantstampStakingData.getPoolState(poolId), PoolState.NotViolatedFunded);
      const balancePoolOwner = await Util.balanceOf(quantstampToken, poolOwner);
      const balance = await qspb.getBalanceQspWei();
      await Util.assertTxFail(qspb.withdrawClaim(poolId, {from: poolOwner}));
      assert.equal((await quantstampStakingData.getPoolState(poolId)).toNumber(), PoolState.NotViolatedFunded);
      assert.equal(await Util.balanceOf(quantstampToken, poolOwner), balancePoolOwner);
      assert.equal((await qspb.getBalanceQspWei()).toNumber(), balance.toNumber());
    });

    it("pools allows claim withdraw when policy is violated via status and pool is funded",
      async function() {
        var originalBalance = (await Util.balanceOfRaw(quantstampToken, poolOwner)).plus(depositQspWei);
        // approve and stake funds
        await quantstampToken.approve(qspb.address, minStakeQspWei, {from : staker});
        await qspb.stakeFunds(poolId, minStakeQspWei, {from: staker});
        // this violates the policy
        await candidateContract.withdraw(policyBalance);
        assert.equal(await quantstampStakingData.getPoolState(poolId), PoolState.NotViolatedFunded);
        // switch into the violated status
        await qspb.checkPolicy(poolId);
        assert.equal(await quantstampStakingData.getPoolState(poolId), PoolState.ViolatedFunded);
        await qspb.withdrawClaim(poolId, {from: poolOwner});
        assert.equal(await Util.balanceOf(quantstampToken, poolOwner), originalBalance.plus(minStakeQspWei));
        assert.equal(await Util.balanceOf(quantstampToken, qspb.address), 0);
        assert.equal(await qspb.getBalanceQspWei(), 0);
      }
    );

    it("pools allows claim withdraw when policy is violated via policy and pool is funded",
      async function() {
        var originalBalance = (await Util.balanceOfRaw(quantstampToken, poolOwner)).plus(depositQspWei);
        // approve and stake funds
        await quantstampToken.approve(qspb.address, minStakeQspWei, {from : staker});
        await qspb.stakeFunds(poolId, minStakeQspWei, {from: staker});
        // this violates the policy
        await candidateContract.withdraw(policyBalance);
        assert.equal(await quantstampStakingData.getPoolState(poolId), PoolState.NotViolatedFunded);
        await qspb.withdrawClaim(poolId, {from: poolOwner});
        assert.equal(await quantstampStakingData.getPoolState(poolId), PoolState.ViolatedFunded);
        assert.equal(await Util.balanceOf(quantstampToken, poolOwner), originalBalance.plus(minStakeQspWei));
        assert.equal(await Util.balanceOf(quantstampToken, qspb.address), 0);
        assert.equal(await qspb.getBalanceQspWei(), 0);
      }
    );

    it("should only withdraw funds from the right pool and no other pool", async function() {
      var anotherDepositQspWei = Util.toQsp(300);
      var nextPool = poolId + 1;
      // create another pool
      await quantstampToken.approve(qspb.address, anotherDepositQspWei, {from : poolOwner});
      await qspb.createPool(candidateContract.address, policy.address, maxPayableQspWei, minStakeQspWei,
        anotherDepositQspWei, bonusExpertFactor, bonusFirstExpertFactor, payPeriodInBlocks,
        minStakeTimeInBlocks, timeoutInBlocks, urlOfAuditReport, poolName2, defaultMaxTotalStake, {from: poolOwner});

      // approve and stake funds into the new pool
      await quantstampToken.approve(qspb.address, minStakeQspWei, {from : staker});
      await qspb.stakeFunds(nextPool, minStakeQspWei, {from: staker});

      await candidateContract.withdraw(policyBalance);
      await qspb.withdrawClaim(nextPool, {from: poolOwner});
      assert.equal(await quantstampStakingData.getPoolState(nextPool), PoolState.ViolatedFunded);
      // there was one more pool created so we are subtracting one depositQspWei
      assert.equal(await Util.balanceOf(quantstampToken, poolOwner), poolOwnerBudget.minus(depositQspWei));
      assert.equal(await quantstampStakingData.getPoolState(poolId), PoolState.Initialized);
    });
  });

  describe("isExpert", async function() {

    it("should return true if the expert is on the list", async function() {
      const voting = await Voting.deployed();
      await voting.init(QuantstampToken.address);

      const quantstampParameterizer = await QuantstampParameterizer.deployed();
      await quantstampParameterizer.init(QuantstampToken.address, voting.address, TCRUtil.parameters);
      await quantstampRegistry.init(QuantstampToken.address, voting.address, quantstampParameterizer.address, 'QSPtest');
      const wrapper = await RegistryWrapper.deployed();
      await qspb.setStakingRegistry(wrapper.address, {from: owner});

      const applicant = accounts[4];
      const listing = applicant;
      const minDeposit = TCRUtil.minDep;

      await quantstampToken.enableTransfer({from : owner});
      // transfer the minimum number of tokens to the requestor
      await quantstampToken.transfer(applicant, minDeposit, {from : owner});

      // allow the registry contract use up to minDeposit for audits
      await quantstampToken.approve(quantstampRegistry.address, Util.toQsp(minDeposit), {from : applicant});

      // allow the voting contract use up to minDeposit for audits
      await quantstampToken.approve(voting.address,  Util.toQsp(minDeposit), {from : applicant});

      await TCRUtil.addToWhitelist(listing, minDeposit, applicant, quantstampRegistry);

      assert.strictEqual(await qspb.isExpert(applicant), true, 'Applicant was not set as expert');
    });

    it("should return false if the expert is not on the list", async function() {
      assert.strictEqual(await qspb.isExpert(Util.ZERO_ADDRESS), false, 'Zero address was apparently an expert');
    });
  });

  describe("setRegistry", async function() {
    beforeEach("when staking funds", async function() {
      quantstampToken = await QuantstampToken.new(qspAdmin, {from: owner});
      const voting = await Voting.new(quantstampToken.address);
      const quantstampParameterizer = await QuantstampParameterizer.new();
      await quantstampParameterizer.init(quantstampToken.address, voting.address, TCRUtil.parameters);
      const quantstampRegistry = await QuantstampStakingRegistry.new();
      await quantstampRegistry.init(quantstampToken.address, voting.address, quantstampParameterizer.address, 'QSPtest');
      const wrapper = await RegistryWrapper.new(quantstampRegistry.address);
      qspb = await QuantstampStaking.new(quantstampToken.address, wrapper.address,
        quantstampStakingData.address, {from: owner});
    });

    it("should allow replacement of the TCR", async function() {
      const newAddress = "0xFFFFDDDD";
      const returnFormat = "0x00000000000000000000000000000000ffffdddd";
      await qspb.setStakingRegistry(newAddress, {from: owner});
      assert.equal(await qspb.getStakingRegistry(), returnFormat);
    });

    it("should not allow replacement of the if not an owner", async function() {
      const newAddress = "0xFFFFDDDD";
      await Util.assertTxFail(qspb.setStakingRegistry(newAddress, {from: staker2}));
    });
  });

  describe("stakeFunds", async function() {
    beforeEach("when staking funds", async function() {
      const minDeposit = TCRUtil.minDep;
      quantstampToken = await QuantstampToken.new(qspAdmin, {from: owner});
      const voting = await Voting.new(quantstampToken.address);
      const quantstampParameterizer = await QuantstampParameterizer.new();
      await quantstampParameterizer.init(quantstampToken.address, voting.address, TCRUtil.parameters);
      const quantstampRegistry = await QuantstampStakingRegistry.new();
      await quantstampRegistry.init(quantstampToken.address, voting.address, quantstampParameterizer.address, 'QSPtest');
      const wrapper = await RegistryWrapper.new(quantstampRegistry.address);
      quantstampStakingData = await QuantstampStakingData.new(quantstampToken.address);
      qspb = await QuantstampStaking.new(quantstampToken.address, wrapper.address,
        quantstampStakingData.address, {from: owner});
      await quantstampStakingData.setWhitelistAddress(qspb.address);
      // enable transfers before any payments are allowed
      await quantstampToken.enableTransfer({from : owner});
      await quantstampToken.transfer(poolOwner, poolOwnerBudget, {from : owner});
      await quantstampToken.approve(qspb.address, poolOwnerBudget, {from : poolOwner});
      await quantstampToken.transfer(staker, stakerBudget, {from : owner});
      await quantstampToken.approve(qspb.address, stakerBudget, {from : staker});
      await quantstampToken.transfer(staker2, stakerBudget.plus(new BigNumber(Util.toQsp(minDeposit)).times(2)), {from : owner});
      await quantstampToken.approve(qspb.address, stakerBudget, {from : staker2});
      await quantstampToken.approve(quantstampRegistry.address, Util.toQsp(minDeposit), {from : staker2});
      await quantstampToken.approve(voting.address,  Util.toQsp(minDeposit), {from : staker2});
      await TCRUtil.addToWhitelist(staker2, minDeposit, staker2, quantstampRegistry);
      await quantstampToken.transfer(staker3, stakerBudget.plus(new BigNumber(Util.toQsp(minDeposit)).times(2)), {from : owner});
      await quantstampToken.approve(qspb.address, stakerBudget, {from : staker3});
      await quantstampToken.approve(quantstampRegistry.address, Util.toQsp(minDeposit), {from : staker3});
      await quantstampToken.approve(voting.address,  Util.toQsp(minDeposit), {from : staker3});
      await TCRUtil.addToWhitelist(staker3, minDeposit, staker3, quantstampRegistry);
      await qspb.createPool(candidateContract.address, contractPolicy.address, maxPayoutQspWei, minStakeQspWei,
        depositQspWei, bonusExpertFactor, bonusFirstExpertFactor, payPeriodInBlocks,
        minStakeTimeInBlocks, timeoutInBlocks, urlOfAuditReport, poolUniqueName(), defaultMaxTotalStake, {from: poolOwner});
      currentPoolNumber = await quantstampStakingData.getPoolsLength();
      currentPoolIndex = currentPoolNumber - 1;
    });

    it("should stake funds and keep the pool in the Initialized state", async function() {
      await qspb.stakeFunds(currentPoolIndex, minStakeQspWei.dividedBy(2), {from: staker});
      assert.equal(await quantstampStakingData.getPoolState(currentPoolIndex), PoolState.Initialized);
      assert.equal(depositQspWei.plus(minStakeQspWei.dividedBy(2)).toNumber(), (await qspb.getBalanceQspWei()).toNumber());
      assert.equal(minStakeQspWei.dividedBy(2).toNumber(), (await quantstampStakingData.getPoolTotalStakeQspWei(currentPoolIndex)).toNumber());
      assert.equal(await quantstampStakingData.getPoolStakeCount(currentPoolIndex), 1);
      assert.equal(minStakeQspWei.dividedBy(2).toNumber(), (await quantstampStakingData.getPoolSizeQspWei(currentPoolIndex)).toNumber());
    });

    it("should not allow funds to be staked because the timeout has occured", async function() {
      await Util.mineNBlocks(timeoutInBlocks);
      await qspb.stakeFunds(currentPoolIndex, minStakeQspWei, {from: staker});
      assert.equal(await quantstampStakingData.getPoolState(currentPoolIndex), PoolState.Cancelled);
      // should throw an error since stakes cannot be made in the Cancelled state
      await Util.assertTxFail(qspb.stakeFunds(currentPoolIndex, minStakeQspWei, {from: staker}));
      assert.equal(depositQspWei.toNumber(), (await qspb.getBalanceQspWei()).toNumber());
      assert.equal(await quantstampStakingData.getPoolTotalStakeQspWei(currentPoolIndex), 0);
      assert.equal(await quantstampStakingData.getPoolStakeCount(currentPoolIndex), 0);
      assert.equal(await quantstampStakingData.getPoolSizeQspWei(currentPoolIndex), 0);
    });

    it("should stake funds and set pool to NotViolatedUnderfunded", async function() {
      await qspb.stakeFunds(currentPoolIndex, minStakeQspWei, {from: staker});
      assert.equal(await quantstampStakingData.getPoolState(currentPoolIndex), PoolState.NotViolatedUnderfunded);
      assert.equal(depositQspWei.plus(minStakeQspWei).toNumber(), (await qspb.getBalanceQspWei()).toNumber());
      assert.equal(minStakeQspWei.toNumber(), (await quantstampStakingData.getPoolTotalStakeQspWei(currentPoolIndex)).toNumber());
      assert.equal(await quantstampStakingData.getPoolStakeCount(currentPoolIndex), 1);
      assert.equal(minStakeQspWei.toNumber(), (await quantstampStakingData.getPoolSizeQspWei(currentPoolIndex)).toNumber());
    });

    it("minStakeStartBlock should remain uninitialized when pool first switches to NotViolatedUnderfunded", async function() {
      assert.equal(await quantstampStakingData.getPoolState(currentPoolIndex), PoolState.Initialized);
      assert.equal(await quantstampStakingData.getPoolMinStakeStartBlock(currentPoolIndex), 0);
      // stake funds
      await qspb.stakeFunds(currentPoolIndex, minStakeQspWei, {from: staker});
      assert.equal(await quantstampStakingData.getPoolState(currentPoolIndex), PoolState.NotViolatedUnderfunded);
      assert.equal(await quantstampStakingData.getPoolMinStakeStartBlock(currentPoolIndex), 0);
    });

    it("minStakeStartBlock should be only set once", async function() {
      const testValue = 123;
      assert.equal(await quantstampStakingData.getPoolMinStakeStartBlock(currentPoolIndex), 0);
      await quantstampStakingData.setWhitelistAddress(owner);
      await quantstampStakingData.setPoolMinStakeStartBlock(currentPoolIndex, testValue, {from: owner});
      assert.equal(await quantstampStakingData.getPoolMinStakeStartBlock(currentPoolIndex), testValue);
      await quantstampStakingData.setPoolMinStakeStartBlock(currentPoolIndex, testValue + 1, {from: owner});
      assert.equal(await quantstampStakingData.getPoolMinStakeStartBlock(currentPoolIndex), testValue);
    });

    it("minStakeStartBlock should not be set to 0", async function() {
      await quantstampStakingData.setWhitelistAddress(owner);
      assert.equal(await quantstampStakingData.getPoolMinStakeStartBlock(currentPoolIndex), 0);
      await Util.assertTxFail(quantstampStakingData.setPoolMinStakeStartBlock(currentPoolIndex, 0, {from: owner}));
    });

    it("should set minStakeStartBlock to block.number when pool first switches to NotViolatedFunded", async function() {
      // make deposit such that the current pool is funded
      await qspb.depositFunds(currentPoolIndex, maxPayoutQspWei, {from: poolOwner});

      // get the current block
      const currentBlock = new BigNumber((await web3.eth.getBlock("latest")).number);

      // stake funds
      await qspb.stakeFunds(currentPoolIndex, minStakeQspWei, {from: staker});
      assert.equal(await quantstampStakingData.getPoolState(currentPoolIndex), PoolState.NotViolatedFunded);

      // ensure getMinStakeStartBlock is set to (at least) the current block
      assert.isTrue(currentBlock.lte(
        await quantstampStakingData.getPoolMinStakeStartBlock(currentPoolIndex)
      ));
    });

    it("should keep the value of minStakeStartBlock when pool switches from NotViolatedFunded and back", async function() {
      // make deposit such that the current pool is funded
      await qspb.depositFunds(currentPoolIndex, maxPayoutQspWei - 1, {from: poolOwner});

      // stake funds
      await qspb.stakeFunds(currentPoolIndex, minStakeQspWei, {from: staker});
      assert.equal(await quantstampStakingData.getPoolState(currentPoolIndex), PoolState.NotViolatedFunded);
      const minStakeStartBlockBefore = await quantstampStakingData.getPoolMinStakeStartBlock(currentPoolIndex);

      await mineAndWithdrawUntilDepositLeftLessThan(currentPoolIndex, maxPayoutQspWei - 2);

      // make a small stake to cause the transition to NotViolatedUnderfunded
      await qspb.stakeFunds(currentPoolIndex, 1, {from: staker});

      assert.equal(await quantstampStakingData.getPoolState(currentPoolIndex), PoolState.NotViolatedUnderfunded);

      // make sure the value does not change
      assert.isTrue((await quantstampStakingData.getPoolMinStakeStartBlock(currentPoolIndex)).eq(
        minStakeStartBlockBefore));

      // make a migger stake to cause the transition to NotViolatedFunded
      await qspb.stakeFunds(currentPoolIndex, minStakeQspWei - 1, {from: staker});

      // make sure the value does not change
      assert.isTrue((await quantstampStakingData.getPoolMinStakeStartBlock(currentPoolIndex)).eq(
        minStakeStartBlockBefore));
    });

    it("should stake funds and set pool to NotViolatedFunded", async function() {
      // make deposit such that the current pool is funded
      await qspb.depositFunds(currentPoolIndex, maxPayoutQspWei, {from: poolOwner});
      // stake funds
      await qspb.stakeFunds(currentPoolIndex, minStakeQspWei, {from: staker});
      assert.equal(await quantstampStakingData.getPoolState(currentPoolIndex), PoolState.NotViolatedFunded);
      assert.equal(depositQspWei.plus(minStakeQspWei).plus(maxPayoutQspWei).toNumber(), (await qspb.getBalanceQspWei()).toNumber());
      assert.equal(minStakeQspWei.toNumber(), (await quantstampStakingData.getPoolTotalStakeQspWei(currentPoolIndex)).toNumber());
      assert.equal(await quantstampStakingData.getPoolStakeCount(currentPoolIndex), 1);
      assert.equal(minStakeQspWei.toNumber(), (await quantstampStakingData.getPoolSizeQspWei(currentPoolIndex)).toNumber());
    });

    it("should set the first expert staker of the pool correctly", async function() {
      await qspb.stakeFunds(currentPoolIndex, minStakeQspWei, {from: staker});
      assert.equal(await qspb.isExpert(staker), false);
      await qspb.stakeFunds(currentPoolIndex, minStakeQspWei, {from: staker2});
      assert.equal(await qspb.isExpert(staker2), true);
      await qspb.stakeFunds(currentPoolIndex, minStakeQspWei, {from: staker3});
      assert.equal(await qspb.isExpert(staker3), true);
      await qspb.stakeFunds(currentPoolIndex, minStakeQspWei, {from: staker2});
      // the first expert staker is staker2
      assert.equal(await quantstampStakingData.getPoolFirstExpertStaker(currentPoolIndex), staker2);
      assert.equal(await quantstampStakingData.getPoolStakeCount(currentPoolIndex), 4);
      assert.deepEqual(await quantstampStakingData.getPoolStakersList(currentPoolIndex), [[staker, staker2, staker3], [false, true, true]]);
      // compute what the pool size should be according to the bonuses and stakes in the pool
      const bonusExpert = new BigNumber(bonusExpertFactor);
      const bonusFirstExpert = new BigNumber(bonusFirstExpertFactor);
      var poolSize = new BigNumber(minStakeQspWei);
      poolSize = poolSize.
        plus(poolSize.times(bonusExpert.pow(2).plus(new BigNumber(100).pow(2))).times(bonusFirstExpert.plus(100)).dividedBy(new BigNumber(100).pow(3))).
        plus(poolSize.times(bonusExpert.pow(3).plus(new BigNumber(100).pow(3))).dividedBy(new BigNumber(100).pow(3))).
        plus(poolSize.times(bonusExpert.pow(4).plus(new BigNumber(100).pow(4))).dividedBy(new BigNumber(100).pow(4)));
      assert.equal((await quantstampStakingData.getPoolSizeQspWei(currentPoolIndex)).toString(), poolSize.toString());
    });

    it("should not over-stake for a pool with a maximum", async function () {
      await qspb.createPool(candidateContract.address, contractPolicy.address, maxPayoutQspWei, minStakeQspWei,
        depositQspWei, bonusExpertFactor, bonusFirstExpertFactor, payPeriodInBlocks,
        minStakeTimeInBlocks, timeoutInBlocks, urlOfAuditReport, poolUniqueName(), maxStakeQspWei, {from: poolOwner});
      currentPoolNumber = await quantstampStakingData.getPoolsLength();
      currentPoolIndex = currentPoolNumber - 1;
      const balanceOfStakerOneBeforeStake = await Util.balanceOf(quantstampToken, staker);
      await qspb.stakeFunds(currentPoolIndex, minStakeQspWei.times(3), {from: staker});
      const balanceOfStakerOneAfterStake = await Util.balanceOf(quantstampToken, staker);
      const expectedBalanceOfStaker = (new BigNumber(balanceOfStakerOneBeforeStake)).sub(maxStakeQspWei);
      assert.isTrue((new BigNumber(expectedBalanceOfStaker)).eq(new BigNumber(balanceOfStakerOneAfterStake)));
      assert.equal((await quantstampStakingData.getPoolTotalStakeQspWei(currentPoolIndex)).toNumber(), maxStakeQspWei.toNumber());
    });

    it("should allow staking in a pool with a maximum that has not yet been reached", async function () {
      await qspb.createPool(candidateContract.address, contractPolicy.address, maxPayoutQspWei, minStakeQspWei,
        depositQspWei, bonusExpertFactor, bonusFirstExpertFactor, payPeriodInBlocks,
        minStakeTimeInBlocks, timeoutInBlocks, urlOfAuditReport, poolUniqueName(), maxStakeQspWei, {from: poolOwner});
      currentPoolNumber = await quantstampStakingData.getPoolsLength();
      currentPoolIndex = currentPoolNumber - 1;
      const balanceOfStakerOneBeforeStake = await Util.balanceOf(quantstampToken, staker);
      await qspb.stakeFunds(currentPoolIndex, minStakeQspWei, {from: staker});
      const balanceOfStakerOneAfterStake = await Util.balanceOf(quantstampToken, staker);
      const expectedBalanceOfStaker = (new BigNumber(balanceOfStakerOneBeforeStake)).sub(minStakeQspWei);
      assert.isTrue((new BigNumber(expectedBalanceOfStaker)).eq(new BigNumber(balanceOfStakerOneAfterStake)));
      assert.equal((await quantstampStakingData.getPoolTotalStakeQspWei(currentPoolIndex)).toNumber(), minStakeQspWei);
    });

    it("should not allow staking because the policy is violated", async function() {
      await candidateContract.withdraw(await candidateContract.balance());
      await Util.assertTxFail(qspb.stakeFunds(currentPoolIndex-2, minStakeQspWei, {from: staker}));
      assert.equal(depositQspWei.toNumber(), (await qspb.getBalanceQspWei()).toNumber());
      assert.equal(await quantstampStakingData.getPoolTotalStakeQspWei(currentPoolIndex-2), 0);
      assert.equal(await quantstampStakingData.getPoolStakeCount(currentPoolIndex-2), 0);
      assert.equal(await quantstampStakingData.getPoolSizeQspWei(currentPoolIndex-2), 0);
    });

    it("should allow staking in a pool when candidate contract and policy contract have the same address", async function () {
      const candidateAndPolicyContract = await CandidateAndPolicyContract.new(quantstampStakingData.address, 0);
      await qspb.createPool(candidateAndPolicyContract.address, candidateAndPolicyContract.address, maxPayoutQspWei, minStakeQspWei,
        depositQspWei, bonusExpertFactor, bonusFirstExpertFactor, payPeriodInBlocks,
        minStakeTimeInBlocks, timeoutInBlocks, urlOfAuditReport, poolUniqueName(), maxStakeQspWei, {from: poolOwner});
      currentPoolNumber = await quantstampStakingData.getPoolsLength();
      currentPoolIndex = currentPoolNumber - 1;
      const balanceOfStakerOneBeforeStake = await Util.balanceOf(quantstampToken, staker);
      await qspb.stakeFunds(currentPoolIndex, minStakeQspWei, {from: staker});
      const balanceOfStakerOneAfterStake = await Util.balanceOf(quantstampToken, staker);
      const expectedBalanceOfStaker = (new BigNumber(balanceOfStakerOneBeforeStake)).sub(minStakeQspWei);
      assert.isTrue((new BigNumber(expectedBalanceOfStaker)).eq(new BigNumber(balanceOfStakerOneAfterStake)));
      assert.equal((await quantstampStakingData.getPoolTotalStakeQspWei(currentPoolIndex)).toNumber(), minStakeQspWei);
    });
  });

  describe("withdrawStake", async function() {
    beforeEach("when withdrawing stakes", async function() {
      quantstampToken = await QuantstampToken.new(qspAdmin, {from: owner});
      quantstampRegistry = await QuantstampStakingRegistry.new();
      wrapper = await RegistryWrapper.new(quantstampRegistry.address);
      quantstampStakingData = await QuantstampStakingData.new(quantstampToken.address);
      qspb = await QuantstampStaking.new(quantstampToken.address, wrapper.address,
        quantstampStakingData.address, {from: owner});
      await quantstampStakingData.setWhitelistAddress(qspb.address);
      candidateContract = await CandidateContract.new(candidateContractBalance);
      contractPolicy = await ZeroBalancePolicy.new();
      // enable transfers before any payments are allowed
      await quantstampToken.enableTransfer({from : owner});
      await quantstampToken.transfer(poolOwner, poolOwnerBudget, {from : owner});
      await quantstampToken.approve(qspb.address, poolOwnerBudget, {from : poolOwner});
      await quantstampToken.transfer(staker, stakerBudget, {from : owner});
      await quantstampToken.approve(qspb.address, stakerBudget, {from : staker});
      await quantstampToken.transfer(staker2, stakerBudget, {from : owner});
      await quantstampToken.approve(qspb.address, stakerBudget, {from : staker2});

      // create pool and stake funds
      await qspb.createPool(candidateContract.address, contractPolicy.address, maxPayoutQspWei, minStakeQspWei,
        depositQspWei, bonusExpertFactor, bonusFirstExpertFactor, payPeriodInBlocks,
        minStakeTimeInBlocks, timeoutInBlocks, urlOfAuditReport, poolUniqueName(), defaultMaxTotalStake, {from: poolOwner});
      currentPoolNumber = await quantstampStakingData.getPoolsLength();
      currentPoolIndex = currentPoolNumber - 1;
    });

    it("should not withdraw stake, since calling staker did not place any stake", async function() {
      await qspb.stakeFunds(currentPoolIndex, minStakeQspWei, {from: staker});
      assert.equal(depositQspWei.plus(minStakeQspWei).toNumber(), (await qspb.getBalanceQspWei()).toNumber());
      poolState = await quantstampStakingData.getPoolState(currentPoolIndex);
      await qspb.withdrawStake(currentPoolIndex, {from: staker2});
      assert.equal(depositQspWei.plus(minStakeQspWei).toNumber(), (await qspb.getBalanceQspWei()).toNumber());
      assert.equal(parseInt(await quantstampStakingData.getPoolState(currentPoolIndex)), parseInt(poolState));
      assert.equal(minStakeQspWei.toNumber(), (await quantstampStakingData.getPoolTotalStakeQspWei(currentPoolIndex)).toNumber());
      assert.equal(minStakeQspWei.toNumber(), (await quantstampStakingData.getPoolSizeQspWei(currentPoolIndex)).toNumber());
    });

    it("should withdraw stake and pool should switch to Cancelled state", async function() {
      await qspb.stakeFunds(currentPoolIndex, minStakeQspWei, {from: staker});
      await qspb.withdrawStake(currentPoolIndex, {from: staker});
      assert.equal(await quantstampStakingData.getPoolState(currentPoolIndex), PoolState.Cancelled);
      assert.equal(await quantstampStakingData.getPoolTotalStakeQspWei(currentPoolIndex), 0);
      assert.equal(await quantstampStakingData.getPoolSizeQspWei(currentPoolIndex), 0);
    });

    it("should withdraw stake and pool should remain in same state", async function() {
      await qspb.stakeFunds(currentPoolIndex, minStakeQspWei, {from: staker});
      await qspb.stakeFunds(currentPoolIndex, minStakeQspWei, {from: staker2});
      poolState = await quantstampStakingData.getPoolState(currentPoolIndex);
      await qspb.withdrawStake(currentPoolIndex, {from: staker});
      assert.deepEqual(await quantstampStakingData.getPoolStakersList(currentPoolIndex), [[Util.ZERO_ADDRESS, staker2], [false, false]]);
      assert.equal(parseInt(await quantstampStakingData.getPoolState(currentPoolIndex)), parseInt(poolState));
      assert.equal(minStakeQspWei.toNumber(), (await quantstampStakingData.getPoolTotalStakeQspWei(currentPoolIndex)).toNumber());
      assert.equal(minStakeQspWei.toNumber(), (await quantstampStakingData.getPoolSizeQspWei(currentPoolIndex)).toNumber());
    });

    it("should withdraw stake when state is NotViolatedUnderfunded and policy is violated", async function() {
      await qspb.stakeFunds(currentPoolIndex, minStakeQspWei, {from: staker});
      await candidateContract.withdraw(await candidateContract.balance());
      assert.equal(await quantstampStakingData.getPoolState(currentPoolIndex), PoolState.NotViolatedUnderfunded);
      await qspb.withdrawStake(currentPoolIndex, {from: staker});
      assert.equal(await quantstampStakingData.getPoolTotalStakeQspWei(currentPoolIndex), 0);
      assert.equal(await quantstampStakingData.getPoolSizeQspWei(currentPoolIndex), 0);
    });

    it("should not withdraw stake and not fail when state is NotViolatedFunded and policy is violated", async function() {
      await qspb.stakeFunds(currentPoolIndex, minStakeQspWei, {from: staker});
      await qspb.depositFunds(currentPoolIndex, maxPayoutQspWei, {from: poolOwner});
      await candidateContract.withdraw(await candidateContract.balance());
      assert.equal((await quantstampStakingData.getPoolState(currentPoolIndex)).toNumber(), PoolState.NotViolatedFunded);
      await qspb.withdrawStake(currentPoolIndex, {from: staker});
      assert.equal((await quantstampStakingData.getPoolState(currentPoolIndex)).toNumber(), PoolState.ViolatedFunded);
      assert.equal(depositQspWei.plus(minStakeQspWei).plus(maxPayoutQspWei).toNumber(), (await qspb.getBalanceQspWei()).toNumber());
      assert.equal(minStakeQspWei.toNumber(), (await quantstampStakingData.getPoolTotalStakeQspWei(currentPoolIndex)).toNumber());
      assert.equal(minStakeQspWei.toNumber(), (await quantstampStakingData.getPoolSizeQspWei(currentPoolIndex)).toNumber());
    });

    it("should not withdraw stake before the policy period", async function() {
      await qspb.stakeFunds(currentPoolIndex, minStakeQspWei, {from: staker});
      await qspb.depositFunds(currentPoolIndex, maxPayoutQspWei, {from: poolOwner});
      assert.equal(await quantstampStakingData.getPoolState(currentPoolIndex), PoolState.NotViolatedFunded);
      await Util.assertTxFail(qspb.withdrawStake(currentPoolIndex, {from: staker}));
    });

    it("should withdraw stake after the policy period", async function() {
      await qspb.stakeFunds(currentPoolIndex, minStakeQspWei, {from: staker});
      await qspb.depositFunds(currentPoolIndex, maxPayoutQspWei, {from: poolOwner});
      assert.equal(await quantstampStakingData.getPoolState(currentPoolIndex), PoolState.NotViolatedFunded);
      await Util.mineNBlocks(minStakeTimeInBlocks);
      await qspb.withdrawStake(currentPoolIndex, {from: staker});
      assert.equal(await quantstampStakingData.getPoolState(currentPoolIndex), PoolState.PolicyExpired);
      assert.equal(depositQspWei.plus(maxPayoutQspWei).toNumber(), (await qspb.getBalanceQspWei()).toNumber());
      assert.equal(await quantstampStakingData.getPoolTotalStakeQspWei(currentPoolIndex), 0);
      assert.equal(await quantstampStakingData.getPoolSizeQspWei(currentPoolIndex), 0);
    });
  });

  describe("isStaker", async function() {
    beforeEach("when the GUI needs to check if the current user is a staker in a pool", async function() {
      quantstampToken = await QuantstampToken.new(qspAdmin, {from: owner});
      quantstampRegistry = await QuantstampStakingRegistry.new();
      wrapper = await RegistryWrapper.new(quantstampRegistry.address);
      quantstampStakingData = await QuantstampStakingData.new(quantstampToken.address);
      qspb = await QuantstampStaking.new(quantstampToken.address, wrapper.address,
        quantstampStakingData.address, {from: owner});
      await quantstampStakingData.setWhitelistAddress(qspb.address);
      candidateContract = await CandidateContract.new(candidateContractBalance);
      contractPolicy = await ZeroBalancePolicy.new();
      // enable transfers before any payments are allowed
      await quantstampToken.enableTransfer({from : owner});
      await quantstampToken.transfer(poolOwner, poolOwnerBudget, {from : owner});
      await quantstampToken.approve(qspb.address, poolOwnerBudget, {from : poolOwner});
      await quantstampToken.transfer(staker, stakerBudget, {from : owner});
      await quantstampToken.approve(qspb.address, stakerBudget, {from : staker});

      // create pool and stake funds
      await qspb.createPool(candidateContract.address, contractPolicy.address, maxPayoutQspWei, minStakeQspWei,
        depositQspWei, bonusExpertFactor, bonusFirstExpertFactor, payPeriodInBlocks,
        minStakeTimeInBlocks, timeoutInBlocks, urlOfAuditReport, poolUniqueName(), defaultMaxTotalStake, {from: poolOwner});
      currentPoolNumber = await quantstampStakingData.getPoolsLength();
      currentPoolIndex = currentPoolNumber - 1;
    });

    it("should return false for a pool that does not exist", async function() {
      assert.equal(await quantstampStakingData.isStaker(currentPoolIndex + 10, staker), false);
    });

    it("should return false if the pool does not have any stakes yet", async function() {
      assert.equal(await quantstampStakingData.isStaker(currentPoolIndex, staker), false);
    });

    it("should return true if the staker has a stake in the pool", async function() {
      await qspb.stakeFunds(currentPoolIndex, minStakeQspWei, {from: staker});
      assert.equal(await quantstampStakingData.isStaker(currentPoolIndex, staker), true);
    });

    it("should return false if the staker has withdrawn his stake from the pool", async function() {
      await qspb.stakeFunds(currentPoolIndex, minStakeQspWei, {from: staker});
      await Util.mineNBlocks(minStakeTimeInBlocks.dividedBy(2));
      await qspb.withdrawStake(currentPoolIndex, {from: staker});
      assert.deepEqual(await quantstampStakingData.getPoolStakersList(currentPoolIndex), [[Util.ZERO_ADDRESS], [false]]);
      assert.equal(await quantstampStakingData.isStaker(currentPoolIndex, staker), false);
    });
  });
});
