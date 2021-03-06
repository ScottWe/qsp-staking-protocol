/***************************************************************************************************
*                                                                                                  *
* (c) 2018, 2019 Quantstamp, Inc. This content and its use are governed by the license terms at    *
* <https://raw.githubusercontent.com/quantstamp/qsp-staking-protocol/master/LICENSE>               *
*                                                                                                  *
***************************************************************************************************/

pragma solidity 0.4.24;

import "openzeppelin-solidity/contracts/math/SafeMath.sol";
import "openzeppelin-solidity/contracts/ownership/Ownable.sol";

/// @title CandidateContract - an example contract that must be protected according to a policy

contract CandidateContract is Ownable {

    using SafeMath for uint256;

    // state of the contract's lifecycle
    enum ContractState {
        Unlocked,
        Locked
    }

    uint public balance;
    ContractState public state;

    event Withdraw(uint amount);

    constructor(uint _balance) public {
        balance = _balance;
        state = ContractState.Unlocked;
    }

    function withdraw(uint amount) public {
        require(state == ContractState.Unlocked);
        balance = balance.sub(amount);
        emit Withdraw(amount);
    }

    // Real contracts wouldn't have such a public function.
    function lockContract() public {
      state = ContractState.Locked;
    }

}
