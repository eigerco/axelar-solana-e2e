const chai = require("chai");
const solanaWeb3 = require("@solana/web3.js");
const utils = require("../lib/utils.js");
const path = require("path");
const { Buffer } = require("node:buffer");

const { AXELAR_SOLANA_GATEWAY_PROGRAM_ID } = require(
    "@eiger/solana-axelar/anchor/gateway",
);
const { BN } = require("@coral-xyz/anchor");
const {
    ItsInstructions,
    findInterchainTokenPda,
    findMetadataPda,
} = require(
    "@eiger/solana-axelar/its"
);
const { PublicKey } = solanaWeb3;
const { expect } = chai;
const { solidity } = require("ethereum-waffle");
const { utils: { arrayify, solidityPack } } = require("ethers");
const { Metadata } = require("@metaplex-foundation/mpl-token-metadata");
const { getOrCreateAssociatedTokenAccount, TOKEN_2022_PROGRAM_ID } = require(
    "@solana/spl-token",
);
const {
    axelarSolanaMemoProgramProgram,
    AXELAR_SOLANA_MEMO_PROGRAM_PROGRAM_ID,
} = require("@eiger/solana-axelar/anchor/memo-program");
const {
    SolanaAxelarExecutablePayload,
    EncodingSchema
} = require("@eiger/solana-axelar/executable");

chai.use(solidity);

describe("EVM -> Solana Native Interchain Token", function() {
    this.timeout("20m");

    const fileName = path.parse(__filename).name;
    const evmKeyEnvVar = utils.toSnakeCaseCapital(fileName);
    const setup = utils.setupConnections(evmKeyEnvVar);
    const evmItsInfo = utils.getContractInfo(
        "InterchainTokenService",
        setup.evm.chainName,
    );
    const evmFactoryInfo = utils.getContractInfo(
        "InterchainTokenFactory",
        setup.evm.chainName,
    );
    const solanaItsInfo = utils.getContractInfo(
        "axelar_solana_its",
        setup.solana.chainName,
    );

    const [gatewayRootPdaPublicKey] = PublicKey.findProgramAddressSync(
        [Buffer.from("gateway")],
        AXELAR_SOLANA_GATEWAY_PROGRAM_ID,
    );

    const name = "MyToken";
    const symbol = "MT";
    const decimals = 6;
    const transferAmount = 1e6;
    const gasValue = 2500000;
    const salt = utils.getRandomBytes32();

    let solanaItsProgram;
    let evmItsContract;
    let evmFactoryContract;

    let token;
    let solanaToken;
    let tokenId;
    let associatedTokenAccount;
    let metadataPda;

    before(async () => {
        solanaItsProgram = new ItsInstructions(
            new PublicKey(solanaItsInfo.address),
            gatewayRootPdaPublicKey,
            setup.solana.provider,
        );

        evmItsContract = await utils.getEvmContract(
            setup.evm.wallet,
            "InterchainTokenService",
            evmItsInfo.address,
        );

        evmFactoryContract = await utils.getEvmContract(
            setup.evm.wallet,
            "InterchainTokenFactory",
            evmFactoryInfo.address,
        );

        tokenId = await evmFactoryContract.interchainTokenId(setup.evm.wallet.address, salt);
        [solanaToken] = findInterchainTokenPda(solanaItsProgram.itsRootPda, arrayify(tokenId));
        [metadataPda] = findMetadataPda(solanaToken);
    });

    it("Should register the token on EVM and deploy remotely on the Solana chain", async () => {
        let deployTx = await evmFactoryContract.deployInterchainToken(
            salt,
            name,
            symbol,
            decimals,
            transferAmount,
            setup.evm.wallet.address,
        );
        await deployTx.wait();

        let approvalTx = await evmFactoryContract.approveDeployRemoteInterchainToken(
            setup.evm.wallet.address,
            salt,
            setup.solana.chainName,
            setup.solana.wallet.payer.publicKey.toBytes(),
        );
        await approvalTx.wait();

        const tx = await evmFactoryContract.deployRemoteInterchainTokenWithMinter(
            salt,
            setup.evm.wallet.address,
            setup.solana.chainName,
            setup.solana.wallet.payer.publicKey.toBytes(),
            gasValue,
            { value: gasValue },
        );

        const srcGmpDetails = await utils.waitForGmpExecution(
            tx.hash,
            setup.axelar,
        );

        await utils.waitForGmpExecution(
            srcGmpDetails.executed.transactionHash,
            setup.axelar,
        );

        const metadata = await Metadata.fromAccountAddress(setup.solana.connection, metadataPda);

        expect(utils.trimNullTermination(metadata.data.name)).to.equal(name);
        expect(utils.trimNullTermination(metadata.data.symbol)).to.equal(symbol);
    });

    describe("InterchainTransfer", () => {
        before(async () => {
            associatedTokenAccount =
                // Native Interchain Tokens are always spl-token-2022
                await getOrCreateAssociatedTokenAccount(
                    setup.solana.connection,
                    setup.solana.wallet.payer,
                    solanaToken,
                    setup.solana.wallet.payer.publicKey,
                    false,
                    null,
                    null,
                    TOKEN_2022_PROGRAM_ID,
                );
            const tokenAddress = await evmItsContract.registeredTokenAddress(tokenId);

            token = await utils.getEvmContract(
                setup.evm.wallet,
                "InterchainToken",
                tokenAddress,
            );
        });

        it("Should be able to transfer tokens from EVM to Solana", async () => {
            const tx = await evmItsContract.interchainTransfer(
                tokenId,
                setup.solana.chainName,
                associatedTokenAccount.address.toBytes(),
                Math.floor(transferAmount),
                "0x",
                gasValue,
                { value: gasValue },
            );

            const srcGmpDetails = await utils.waitForGmpExecution(
                tx.hash,
                setup.axelar,
            );
            await utils.waitForGmpExecution(
                srcGmpDetails.executed.transactionHash,
                setup.axelar,
            );

            const currentBalance = Number(
                (await setup.solana.connection.getTokenAccountBalance(
                    associatedTokenAccount.address,
                ))
                    .value
                    .amount,
            );

            expect(currentBalance).to.equal(transferAmount);
        });

        it("Should be able to transfer tokens from Solana to EVM", async () => {
            const tx = await solanaItsProgram.interchainTransfer({
                payer: setup.solana.wallet.payer.publicKey,
                sourceAccount: associatedTokenAccount.address,
                authority: setup.solana.wallet.payer.publicKey,
                tokenId: arrayify(tokenId),
                destinationChain: setup.evm.chainName,
                destinationAddress: arrayify(setup.evm.wallet.address),
                amount: new BN(transferAmount),
                mint: solanaToken,
                gasValue: new BN(gasValue),
                gasService: setup.solana.gasService,
                gasConfigPda: setup.solana.gasConfigPda,
                tokenProgram: TOKEN_2022_PROGRAM_ID,
            }).transaction();
            const txHash = await utils.sendSolanaTransaction(setup.solana, tx);

            const srcGmpDetails = await utils.waitForGmpExecution(
                txHash,
                setup.axelar,
            );
            const dstGmpDetails = await utils.waitForGmpExecution(
                srcGmpDetails.executed.transactionHash,
                setup.axelar,
            );
            const evmTx = await setup.evm.provider.getTransaction(
                dstGmpDetails.executed.transactionHash,
            );

            await expect(evmTx).to.emit(
                evmItsContract,
                "InterchainTransferReceived",
            ).withNamedArgs({
                tokenId,
                amount: transferAmount,
                sourceChain: setup.solana.chainName,
            });

            expect(
                await token.balanceOf(setup.evm.wallet.address),
            )
                .to.equal(transferAmount);
        });
    });

    describe("Contract call with Token", () => {
        let memoAssociatedTokenAccount;
        let solanaMemoProgram;
        let evmMemoContract;

        // Keep memo shorter than 10 characters, otherwise solana memo program
        // doesn't log it.
        const randomSuffix = utils.generateRandomString(2);
        const memo = "e2e test" + randomSuffix;
        const [counterPdaPublicKey] = PublicKey.findProgramAddressSync(
            [gatewayRootPdaPublicKey.toBuffer()],
            AXELAR_SOLANA_MEMO_PROGRAM_PROGRAM_ID,
        );

        before(async () => {
            const evmMemoInfo = utils.getContractInfo(
                "AxelarMemo",
                setup.evm.chainName,
            );

            const solanaMemoInfo = utils.getContractInfo(
                "axelar_solana_memo_program",
                setup.solana.chainName,
            );

            solanaMemoProgram = axelarSolanaMemoProgramProgram({
                programId: new PublicKey(solanaMemoInfo.address),
                provider: setup.solana.provider,
            });

            evmMemoContract = await utils.getEvmContract(
                setup.evm.wallet,
                "AxelarMemo",
                evmMemoInfo.address,
            );

            // Native Interchain Tokens are always spl-token-2022
            memoAssociatedTokenAccount = await getOrCreateAssociatedTokenAccount(
                setup.solana.connection,
                setup.solana.wallet.payer,
                solanaToken,
                solanaMemoProgram.programId,
                true,
                null,
                null,
                TOKEN_2022_PROGRAM_ID,
            );

            let mintTx = await token.mint(setup.evm.wallet.address, transferAmount);
            await mintTx.wait();

            const tx = await solanaItsProgram.interchainToken.mint({
                tokenId: arrayify(tokenId),
                mint: solanaToken,
                to: associatedTokenAccount.address,
                minter: setup.solana.wallet.payer.publicKey,
                tokenProgram: TOKEN_2022_PROGRAM_ID,
                amount: new BN(transferAmount),
            }).transaction();
            await utils.sendSolanaTransaction(setup.solana, tx);
        });

        it("Should be able to call Memo contract with tokens from EVM to Solana", async () => {
            const memoIx = await solanaMemoProgram.methods
                .processMemo(memo)
                .accounts({ counterPda: counterPdaPublicKey })
                .instruction();
            const executablePayload = new SolanaAxelarExecutablePayload(memoIx, EncodingSchema.ABI);
            const metadataVersion = 0;
            const metadata = solidityPack(['uint32', 'bytes'], [metadataVersion, executablePayload.encode()]);

            const tx = await evmItsContract.interchainTransfer(
                tokenId,
                setup.solana.chainName,
                solanaMemoProgram.programId.toBytes(),
                Math.floor(transferAmount),
                metadata,
                gasValue,
                { value: gasValue },
            );

            const srcGmpDetails = await utils.waitForGmpExecution(
                tx.hash,
                setup.axelar,
            );
            await utils.waitForGmpExecution(
                srcGmpDetails.executed.transactionHash,
                setup.axelar,
            );

            const currentBalance = Number(
                (await setup.solana.connection.getTokenAccountBalance(
                    memoAssociatedTokenAccount.address,
                ))
                    .value
                    .amount,
            );

            expect(currentBalance).to.equal(transferAmount);
        });

        it("Should be able to call Memo contract with tokens from Solana to EVM", async () => {
            const tx = await solanaItsProgram.callContractWithInterchainToken({
                payer: setup.solana.wallet.payer.publicKey,
                sourceAccount: associatedTokenAccount.address,
                authority: setup.solana.wallet.payer.publicKey,
                tokenId: arrayify(tokenId),
                destinationChain: setup.evm.chainName,
                destinationAddress: arrayify(evmMemoContract.address),
                amount: new BN(transferAmount),
                mint: solanaToken,
                data: Buffer.from(memo),
                gasValue: new BN(0),
                gasService: setup.solana.gasService,
                gasConfigPda: setup.solana.gasConfigPda,
                tokenProgram: TOKEN_2022_PROGRAM_ID,
            }).transaction();
            const txHash = await utils.sendSolanaTransaction(setup.solana, tx);

            const srcGmpDetails = await utils.waitForGmpExecution(
                txHash,
                setup.axelar,
            );
            const dstGmpDetails = await utils.waitForGmpExecution(
                srcGmpDetails.executed.transactionHash,
                setup.axelar,
            );
            const evmTx = await setup.evm.provider.getTransaction(
                dstGmpDetails.executed.transactionHash,
            );

            await expect(evmTx).to.emit(
                evmMemoContract,
                "ReceivedMemoWithToken",
            ).withNamedArgs({
                sourceChain: setup.solana.chainName,
                tokenId,
                amount: transferAmount,
                memoMessage: memo
            });

            expect(await token.balanceOf(evmMemoContract.address)).to.equal(transferAmount);
        });
    });
});
