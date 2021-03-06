/***************************************************************************************************
*                                                                                                  *
* (c) 2018, 2019 Quantstamp, Inc. This content and its use are governed by the license terms at    *
* <https://raw.githubusercontent.com/quantstamp/qsp-staking-protocol/master/LICENSE>               *
*                                                                                                  *
***************************************************************************************************/

const util = require('../test/util.js');

// TCR parameters are desccribed here:
// https://quantstamp.atlassian.net/wiki/spaces/QUAN/pages/138444953/Token-Curated+Registry+TCR

module.exports = {
  paramDefaults: {
    minDeposit: util.toQsp('5000'),
    pMinDeposit: util.toQsp('10000'),
    applyStageLength: util.daysToSeconds('3'),
    pApplyStageLength: util.daysToSeconds('7'),
    commitStageLength: util.daysToSeconds('3'),
    pCommitStageLength: util.daysToSeconds('7'),
    revealStageLength: util.daysToSeconds('3'),
    pRevealStageLength: util.daysToSeconds('3'),
    dispensationPct: 100,
    pDispensationPct: 100,
    voteQuorum: 50,
    pVoteQuorum: 66,
    exitTimeDelay: 0,
    exitPeriodLen: 0
  },
  name: "Staking Protocol Registry"
};
