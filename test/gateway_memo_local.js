const solanaWeb3 = require("@solana/web3.js");
const anchor = require("@coral-xyz/anchor");

const { Keypair, PublicKey } = solanaWeb3;
const { Wallet } = anchor;

const SolanaChain = "localnet";
const SolanaRpc = "http://127.0.0.1:8899";
const SolanaKey = "[204,155,157,121,82,50,222,240,73,148,148,33,230,17,186,159,28,168,41,233,236,211,115,247,167,188,69,126,153,80,214,126,13,74,42,170,113,206,235,3,60,84,234,14,188,183,7,103,74,226,232,177,114,40,62,21,157,40,88,249,104,36,211,8]";

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
    it("Dinamo", async () => {
      const connections = setupConnections();
      console.log(connections);
    });
});
