// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.36;

import {Script} from "forge-std/Script.sol";

import {ARLAnonymousSignal, IARLSignalVerifier} from "../src/ARLAnonymousSignal.sol";
import {HonkVerifier} from "../zk/ARLSemaphoreVerifier.sol";

/// @title Base Mainnet: the anonymous-signal verifier and contract
/// @notice Base Mainnet (8453) and the local chain (31337) only. Deploys the generated verifier
/// and `ARLAnonymousSignal` from the sender. The verifier's two libraries (`RelationsLib`,
/// `ZKTranscriptLib`) are deployed by forge through the canonical CREATE2 deployer, so their
/// addresses follow from their code alone; one that already exists is reused. Neither contract
/// has an owner and the deployer keeps no role: each group's admin is the account that creates
/// it.
///   FOUNDRY_PROFILE=zk forge script zk-script/DeployMainnetSignal.s.sol:DeployMainnetSignal \
///     --rpc-url https://mainnet.base.org --sender <deployer>
/// (a dry run; the owner signs the run file on the app's Deploy screen).
contract DeployMainnetSignal is Script {
    uint256 internal constant BASE_MAINNET = 8453;
    uint256 internal constant LOCAL = 31_337;

    error ChainNotAllowed(uint256 chainId);
    error DeploymentCheckFailed();

    function run() external returns (HonkVerifier verifier, ARLAnonymousSignal signal) {
        if (block.chainid != BASE_MAINNET && block.chainid != LOCAL) {
            revert ChainNotAllowed(block.chainid);
        }
        vm.startBroadcast();
        verifier = new HonkVerifier();
        signal = new ARLAnonymousSignal(IARLSignalVerifier(address(verifier)));
        vm.stopBroadcast();

        if (
            address(signal.verifier()) != address(verifier) || signal.groupCount() != 0
                || address(verifier).code.length == 0
        ) revert DeploymentCheckFailed();
    }
}
