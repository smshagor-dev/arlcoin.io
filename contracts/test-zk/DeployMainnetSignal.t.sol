// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.36;

import {Test} from "forge-std/Test.sol";

import {ARLAnonymousSignal} from "../src/ARLAnonymousSignal.sol";
import {HonkVerifier} from "../zk/ARLSemaphoreVerifier.sol";
import {DeployMainnetSignal} from "../zk-script/DeployMainnetSignal.s.sol";

/// @notice The Base Mainnet deployment of the anonymous signals: allowed chains only, and the
/// contract it creates uses the verifier it creates and starts with no group.
contract DeployMainnetSignalTest is Test {
    DeployMainnetSignal internal script;

    function setUp() public {
        script = new DeployMainnetSignal();
    }

    function test_deploysTheVerifierAndTheContract() public {
        (HonkVerifier verifier, ARLAnonymousSignal signal) = script.run();
        assertEq(address(signal.verifier()), address(verifier));
        assertEq(signal.groupCount(), 0);
        assertGt(address(verifier).code.length, 0);
    }

    function test_runsOnBaseMainnet() public {
        vm.chainId(8453);
        (, ARLAnonymousSignal signal) = script.run();
        assertEq(signal.groupCount(), 0);
    }

    function test_refusesOtherChains() public {
        vm.chainId(84_532);
        vm.expectRevert(
            abi.encodeWithSelector(DeployMainnetSignal.ChainNotAllowed.selector, 84_532)
        );
        script.run();
        vm.chainId(1);
        vm.expectRevert(abi.encodeWithSelector(DeployMainnetSignal.ChainNotAllowed.selector, 1));
        script.run();
    }
}
