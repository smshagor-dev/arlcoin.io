/**
 * Creation code of the anonymous signals contract, its verifier and the verifier libraries as
 * published in public/plans/8453-signal.json (main at 1386589). The tests read that plan against
 * this set. The deploy screen itself accepts only the current build (lib/deployArtifacts.ts).
 * Copied verbatim from that commit's build.
 */
export const SIGNAL_ARTIFACTS = {
  ARLAnonymousSignal: {
    creationHash: "0x552beb4b43eefeef76858f5c85386259b315464529daf3d0575363387adb2aca",
    creationSize: 3496,
    constructorInputs: [
      {
        name: "verifier_",
        type: "address",
        internalType: "contract IARLSignalVerifier",
      },
    ],
  },
} as const;

export const SIGNAL_ZK_ARTIFACTS = {
  libraries: {
    RelationsLib: {
      creationHash: "0x28e4e6a7af9188a823311ae4beed63ce00ed61f9af37d8664d798112eb524bf8",
      creationSize: 7971,
    },
    ZKTranscriptLib: {
      creationHash: "0x18b45449679d6926644217496d3bbdd3cf9f018c5dffab74ce194cd3f1dc713c",
      creationSize: 6150,
    },
  },
  HonkVerifier: {
    blankedCreationHash: "0x1547bc6e238957ad9f5aa73a28be694786d9ed890d9698f1edeff80c57f9f970",
    creationSize: 18389,
    links: [
      {
        library: "ZKTranscriptLib",
        start: 669,
      },
      {
        library: "RelationsLib",
        start: 3375,
      },
    ],
  },
} as const;
