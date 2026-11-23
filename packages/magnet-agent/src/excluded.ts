// Addresses the buyer agent never pays: ARL's Safes (docs/mainnet-plan.md), the Safe owners and
// deployers, the arbiter Safe and its owners, and the operator validators. All of them are public
// on Base already (Safe owners, deployer transactions, contracts/deploy/*.json). A listing whose
// owner or payee is one of these is skipped, so the agent's budget only reaches outside agents.

import { getAddress, type Address } from "viem";

const RAW = [
  // Allocation Safes.
  "0x7816Ee6349AeA591B351772eB951A6CF8b223E5c", // Founder
  "0x183A501A6dEb7D575F870a12c36a2266666F8e8a", // Investors
  "0x31b8662Bfe4F2c9F9B400D407524356FADc8cC75", // Strategic Partnerships
  "0x4d9be214f71b391574a3A8dbE145AeF142eB0c13", // Treasury
  "0xB521d1E4eF0dA060e3B6C5d8667DE711abc4D120", // Guardian
  "0x42A0E39399aAd8e088f9561ceC1512EA93D18E05", // Public Launch
  "0xfF12597A671ebAF0cAe37999EE659e03c4f444B5", // Community & Staking
  "0x90D8c082e9AdABE96804Ae9c6117Fd5b245F4cb1", // Ecosystem & Growth
  "0x8894C0bc9A83Aa497Cf35618b72100dCa459C1AC", // Liquidity
  "0xe5C7F7BDd59286C9baE7FfE85F3CF99382F8989D", // Team
  "0xdBa5CfeD6E6076DabAbb4a6D851605cC5C8bb47D", // Early Users
  "0xA1B52BA110A2738E5769dE3F9d0BE70E1b0604A3", // Grants & Bug Bounty
  // Safe owners, deployers and operator.
  "0x380A7f9B512d9ac7364be3EdFf5feAfD36659c25",
  "0x5CD124a418FED1fc5614aEAd5601348EeDd0cC74",
  "0xCefc623Afe379F390E0C434D28D16d6dc1C6641D",
  "0x4F80ff7701d6fD69523198376021E9FbC2609eAa",
  "0x3c3f71d694f709cBe60f015717c54A795636b165",
  "0xEC4bA7bB082eB4F4927bBB82816F4Ac4331036a0",
  "0xD1913f39F9a3A5c91143fdD94cEC91C6e3CCC541",
  "0x5a7F207B3764113c68c50219e31D2a7c22132F52",
  "0xe033104AE32fc7e13263B7AED577Ab20d6E47eAA",
  "0x26DEAaCAa112cA495bD7CC8Cb92c91cD85e1A2a0",
  // Arbiter Safe and its owners.
  "0x8FF6c3aD0991Ac848BFf5d0acD78BBc5e190466f",
  "0x6dcBD851E982C4f2196D85005A7A9a104C4C9DAd",
  "0x5598E36b61b8F513e163D289E3092DF0F9f990a4",
  "0x9065d7e4E5e63e91174A275Aae1a693082Edd0a1",
  // Operator validators.
  "0x7E8e18bf48F07B82F64b846b0d509ad79FD86244",
  "0x394846C9E1161A07471F9e8baEda77E4AEa85fa1",
  "0xdAa1EFD5E765Baf67D8013C1c67039945819B760",
  // ARL's own provider agent (agent 1221687).
  "0x69CF9b31076E6d4F581A79045eBAbc624E3cd4bf",
  // ARL's own GPU and model provider (the team's office machine).
  "0xc00E760552220D7bdd1473c8f2E9E7f68E2bfBcF",
] as const;

export const EXCLUDED: readonly Address[] = RAW.map((a) => getAddress(a));
