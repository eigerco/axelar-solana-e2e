const solanaWeb3 = require("@solana/web3.js");
const anchor = require("@coral-xyz/anchor");
const utils = require("../lib/utils.js");
const {
    axelarSolanaMemoProgramProgram,
    AXELAR_SOLANA_MEMO_PROGRAM_PROGRAM_ID,
} = require("@eiger/solana-axelar/anchor/memo-program");
const { AXELAR_SOLANA_GATEWAY_PROGRAM_ID } = require(
    "@eiger/solana-axelar/anchor/gateway",
);

const { Keypair, PublicKey } = solanaWeb3;
const { Wallet } = anchor;

const EvmChain = "avalanche-fuji";

const SolanaChain = "localnet";
const SolanaRpc = "http://127.0.0.1:8899";
const SolanaKey = "[204,155,157,121,82,50,222,240,73,148,148,33,230,17,186,159,28,168,41,233,236,211,115,247,167,188,69,126,153,80,214,126,13,74,42,170,113,206,235,3,60,84,234,14,188,183,7,103,74,226,232,177,114,40,62,21,157,40,88,249,104,36,211,8]";

const MemoAddress = "mem7LhKWbKydCPk1TwNzeCvVSpoVx2mqxNuvjGgWAbG";

function setupConnections() {
    const solanaConnection = new solanaWeb3.Connection(SolanaRpc, {
        commitment: "finalized",
        /** time to allow for the server to initially process a transaction (in milliseconds) */
        confirmTransactionInitialTimeout: 900000,
    });
    const solanaWallet = new Wallet(
        Keypair.fromSecretKey(
            Uint8Array.from(JSON.parse(SolanaKey)),
        ),
    );
    const solanaProvider = new anchor.AnchorProvider(
        solanaConnection,
        solanaWallet,
        { commitment: "finalized" },
    );
    const solanaGasServiceInfo = {
        address: "gasFkyvr4LjK3WwnMGbao3Wzr67F88TmhKmi4ZCXF9K",
        config_pda: "GNNNDeAMMdYfN5RGizXN4DdpTpBXWa9UvFLg4JyvivvK"
    };

    return {
        solana: {
            chainName: SolanaChain,
            connection: solanaConnection,
            wallet: solanaWallet,
            provider: solanaProvider,
            gasService: new PublicKey(solanaGasServiceInfo.address),
            gasConfigPda: new PublicKey(solanaGasServiceInfo.config_pda),
        },
    };
}

describe("Gateway Memo Interaction", function() {
    const setup = setupConnections();
    const evmMemoInfoAddress = "0x8c85fB64504F72367E4bcECC8ea5D9DEac7977DA";

    before(async () => {
        solanaMemoProgram = axelarSolanaMemoProgramProgram({
            programId: new PublicKey(MemoAddress),
            provider: setup.solana.provider,
        });
    });

    it("Dinamo", async () => {
      const memo = "Dinamo";

      const [gatewayRootPdaPublicKey] = PublicKey.findProgramAddressSync(
          [Buffer.from("gateway")],
          AXELAR_SOLANA_GATEWAY_PROGRAM_ID,
      );
      const [counterPdaPublicKey] = PublicKey.findProgramAddressSync(
          [gatewayRootPdaPublicKey.toBuffer()],
          AXELAR_SOLANA_MEMO_PROGRAM_PROGRAM_ID,
      );
      const [signingPda] = PublicKey.findProgramAddressSync(
          [Buffer.from("gtw-call-contract")],
          AXELAR_SOLANA_MEMO_PROGRAM_PROGRAM_ID,
      );

      const tx = await solanaMemoProgram.methods.sendToGateway(
          memo,
          EvmChain,
          evmMemoInfoAddress,
      ).accounts({
          id: AXELAR_SOLANA_MEMO_PROGRAM_PROGRAM_ID,
          memoCounterPda: counterPdaPublicKey,
          signingPda0: signingPda,
          gatewayRootPda: gatewayRootPdaPublicKey,
          gatewayProgram: AXELAR_SOLANA_GATEWAY_PROGRAM_ID,
      }).transaction();
      const txHash = await utils.sendSolanaTransaction(setup.solana, tx);
    });
});
