const chai = require("chai");
const ethers = require("ethers");
const solanaWeb3 = require("@solana/web3.js");
const utils = require("../lib/utils.js");
const path = require("path");

const { AXELAR_SOLANA_GATEWAY_PROGRAM_ID } = require(
    "@eiger/solana-axelar/anchor/gateway",
);
const { PublicKey } = solanaWeb3;
const {
    axelarSolanaMemoProgramProgram,
    AXELAR_SOLANA_MEMO_PROGRAM_PROGRAM_ID,
} = require("@eiger/solana-axelar/anchor/memo-program");
const { expect } = chai;
const { solidity } = require("ethereum-waffle");
const { utils: { toUtf8Bytes } } = ethers;

chai.use(solidity);

describe("AxelarMemo Flow", function() {
    this.timeout("60m");

    const fileName = path.parse(__filename).name;
    const evmKeyEnvVar = utils.toSnakeCaseCapital(fileName);
    const setup = utils.setupConnections(evmKeyEnvVar);
    const evmMemoInfo = utils.getContractInfo(
        "AxelarMemo",
        setup.evm.chainName,
    );
    const solanaMemoInfo = utils.getContractInfo(
        "axelar_solana_memo_program",
        setup.solana.chainName,
    );

    const [gatewayRootPdaPublicKey] = PublicKey.findProgramAddressSync(
        [Buffer.from("gateway")],
        AXELAR_SOLANA_GATEWAY_PROGRAM_ID,
    );
    const [counterPdaPublicKey] = PublicKey.findProgramAddressSync(
        [gatewayRootPdaPublicKey.toBuffer()],
        AXELAR_SOLANA_MEMO_PROGRAM_PROGRAM_ID,
    );

    let solanaMemoProgram;
    let evmMemoContract;

    // Keep memo shorter than 10 characters, otherwise solana memo program
    // doesn't log it.
    const randomSuffix = utils.generateRandomString(2);
    const memo = "e2e test" + randomSuffix;

    before(async () => {
        solanaMemoProgram = axelarSolanaMemoProgramProgram({
            programId: new PublicKey(solanaMemoInfo.address),
            provider: setup.solana.provider,
        });

        evmMemoContract = await utils.getEvmContract(
            setup.evm.wallet,
            "AxelarMemo",
            evmMemoInfo.address,
        );
    });

    it("Should send memo from Solana and receive on EVM", async () => {
        const [signingPda] = PublicKey.findProgramAddressSync(
            [Buffer.from("gtw-call-contract")],
            AXELAR_SOLANA_MEMO_PROGRAM_PROGRAM_ID,
        );

        const tx = await solanaMemoProgram.methods.sendToGateway(
            memo,
            setup.evm.chainName,
            evmMemoInfo.address,
        ).accounts({
            id: AXELAR_SOLANA_MEMO_PROGRAM_PROGRAM_ID,
            memoCounterPda: counterPdaPublicKey,
            signingPda0: signingPda,
            gatewayRootPda: gatewayRootPdaPublicKey,
            gatewayProgram: AXELAR_SOLANA_GATEWAY_PROGRAM_ID,
        }).transaction();
        const txHash = await utils.sendSolanaTransaction(setup.solana, tx);

        const gmpDetails = await utils.waitForGmpExecution(
            txHash,
            setup.axelar,
        );
        const evmTx = await setup.evm.provider.getTransaction(
            gmpDetails.executed.transactionHash,
        );

        await expect(evmTx).to.emit(evmMemoContract, "ReceivedMemo").withArgs(
            memo,
        );
    });

    it("Should send memo from EVM and receive on Solana", async () => {
        const tx = await evmMemoContract.sendToSolana(
            solanaMemoInfo.address,
            toUtf8Bytes(setup.solana.chainName),
            toUtf8Bytes(memo),
            [{
                pubkey: counterPdaPublicKey.toBytes(),
                isSigner: false,
                isWritable: true,
            }],
        );
        tx.wait();

        const gmpDetails = await utils.waitForGmpExecution(
            tx.hash,
            setup.axelar,
        );
        const solanaMemoLogs = await setup.solana.connection.getTransaction(
            gmpDetails.executed.transactionHash,
            {
                maxSupportedTransactionVersion: 0,
            },
        ).then((response) => {
            return response.meta.logMessages;
        });

        expect(
            solanaMemoLogs.some((log) => log.includes(memo)),
            `expected ${solanaMemoLogs} to have a log that includes ${memo}`,
        ).to.be.true;
    });
});
