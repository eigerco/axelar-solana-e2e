const chai = require("chai");
const solanaWeb3 = require("@solana/web3.js");
const path = require("path");
const { getOrCreateAssociatedTokenAccount } = require(
    "@solana/spl-token",
);
const utils = require("../lib/utils.js");
const { Buffer } = require("node:buffer");

const { AXELAR_SOLANA_GATEWAY_PROGRAM_ID } = require(
    "@eiger/solana-axelar/anchor/gateway",
);
const {
    axelarSolanaMemoProgramProgram,
    AXELAR_SOLANA_MEMO_PROGRAM_PROGRAM_ID,
} = require("@eiger/solana-axelar/anchor/memo-program");
const { BN } = require("@coral-xyz/anchor");
const { SolanaAxelarExecutablePayload, EncodingSchema } = require("@eiger/solana-axelar/executable");
const {
    ItsInstructions,
    interchainTokenId,
    findInterchainTokenPda,
} = require(
    "@eiger/solana-axelar/its",
);
const { PublicKey } = solanaWeb3;
const { TOKEN_2022_PROGRAM_ID } = require(
    "@solana/spl-token",
);
const { expect } = chai;
const { solidity } = require("ethereum-waffle");
const { utils: { hexlify, arrayify, solidityPack } } = require("ethers");

chai.use(solidity);

describe("Solana -> EVM Native Interchain Token", function() {
    this.timeout("20m");

    const fileName = path.parse(__filename).name;
    const evmKeyEnvVar = utils.toSnakeCaseCapital(fileName);
    const setup = utils.setupConnections(evmKeyEnvVar);
    const evmItsInfo = utils.getContractInfo(
        "InterchainTokenService",
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

    const name = "MyInterchainToken";
    const symbol = "MIT";
    const decimals = 6;
    const transferAmount = 100;
    const gasValue = 2500000;
    const salt = utils.getRandomBytes32();

    let solanaItsProgram;
    let evmItsContract;

    let token;
    let tokenId;
    let associatedTokenAccount;

    let evmTokenContract;
    let evmTokenAddress;

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
    });

    it("Should register the token on Solana and deploy remotely on the EVM chain", async () => {
        tokenId = interchainTokenId(
            setup.solana.wallet.payer.publicKey,
            salt,
        );
        [token] = findInterchainTokenPda(
            solanaItsProgram.itsRootPda,
            tokenId,
        );

        await solanaItsProgram.deployInterchainToken({
            payer: setup.solana.wallet.payer.publicKey,
            salt: Array.from(salt),
            name,
            symbol,
            decimals,
            minter: setup.solana.wallet.payer.publicKey,
        }).rpc();

        await solanaItsProgram.approveDeployRemoteInterchainToken({
            payer: setup.solana.wallet.payer.publicKey,
            deployer: setup.solana.wallet.payer.publicKey,
            salt: Array.from(salt),
            destinationChain: setup.evm.chainName,
            destinationMinter: arrayify(setup.evm.wallet.address),
        }).rpc();

        const txHash = await solanaItsProgram.deployRemoteInterchainTokenWithMinter({
            payer: setup.solana.wallet.payer.publicKey,
            salt: Array.from(salt),
            minter: setup.solana.wallet.payer.publicKey,
            destinationChain: setup.evm.chainName,
            destinationMinter: arrayify(setup.evm.wallet.address),
            gasValue: new BN(gasValue),
            gasService: setup.solana.gasService,
            gasConfigPda: setup.solana.gasConfigPda,
        }).rpc();

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
            "InterchainTokenDeployed",
        ).withNamedArgs({
            tokenId: hexlify(tokenId),
            name,
            symbol,
            decimals,
        });


    });

    describe("InterchainTransfer", () => {
        before(async () => {
            evmTokenAddress = await evmItsContract
                .registeredTokenAddress(
                    hexlify(tokenId),
                );

            evmTokenContract = await utils.getEvmContract(
                setup.evm.wallet,
                "InterchainToken",
                evmTokenAddress,
            );

            associatedTokenAccount =
                // Native Interchain Tokens are always spl-token-2022
                await getOrCreateAssociatedTokenAccount(
                    setup.solana.connection,
                    setup.solana.wallet.payer,
                    token,
                    setup.solana.wallet.payer.publicKey,
                    false,
                    null,
                    null,
                    TOKEN_2022_PROGRAM_ID,
                );

            // Minting needs to go through ITS
            await solanaItsProgram.interchainToken.mint({
                tokenId,
                mint: token,
                to: associatedTokenAccount.address,
                minter: setup.solana.wallet.payer.publicKey,
                tokenProgram: TOKEN_2022_PROGRAM_ID,
                amount: new BN(transferAmount),
            }).rpc();
        });

        it("Should be able to transfer tokens from Solana to EVM", async () => {
            const txHash = await solanaItsProgram.interchainTransfer({
                payer: setup.solana.wallet.payer.publicKey,
                sourceAccount: associatedTokenAccount.address,
                authority: setup.solana.wallet.payer.publicKey,
                tokenId,
                destinationChain: setup.evm.chainName,
                destinationAddress: arrayify(setup.evm.wallet.address),
                amount: new BN(transferAmount),
                mint: token,
                gasValue: new BN(gasValue),
                gasService: setup.solana.gasService,
                gasConfigPda: setup.solana.gasConfigPda,
                tokenProgram: TOKEN_2022_PROGRAM_ID,
            }).rpc();

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
                tokenId: hexlify(tokenId),
                amount: transferAmount,
                sourceChain: setup.solana.chainName,
            });

            expect(
                await evmTokenContract.balanceOf(setup.evm.wallet.address),
            )
                .to.equal(transferAmount);
        });

        it("Should be able to transfer tokens from EVM to Solana", async () => {
            const tx = await evmItsContract.interchainTransfer(
                hexlify(tokenId),
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

            const expectedBalance = transferAmount;
            const currentBalance = Number(
                (await setup.solana.connection.getTokenAccountBalance(
                    associatedTokenAccount.address,
                ))
                    .value
                    .amount,
            );

            expect(currentBalance).to.equal(expectedBalance);
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
            // Minting needs to go through ITS
            await solanaItsProgram.interchainToken.mint({
                tokenId,
                mint: token,
                to: associatedTokenAccount.address,
                minter: setup.solana.wallet.payer.publicKey,
                tokenProgram: TOKEN_2022_PROGRAM_ID,
                amount: new BN(transferAmount),
            }).rpc();

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
                token,
                solanaMemoProgram.programId,
                true,
                null,
                null,
                TOKEN_2022_PROGRAM_ID,
            );
        });

        it("Should be able to call Memo contract with tokens from Solana to EVM", async () => {
            const txHash = await solanaItsProgram.callContractWithInterchainToken({
                payer: setup.solana.wallet.payer.publicKey,
                sourceAccount: associatedTokenAccount.address,
                authority: setup.solana.wallet.payer.publicKey,
                tokenId,
                destinationChain: setup.evm.chainName,
                destinationAddress: arrayify(evmMemoContract.address),
                amount: new BN(transferAmount),
                mint: token,
                data: Buffer.from(memo),
                gasValue: new BN(gasValue),
                gasService: setup.solana.gasService,
                gasConfigPda: setup.solana.gasConfigPda,
                tokenProgram: TOKEN_2022_PROGRAM_ID,
            }).rpc();

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
                tokenId: hexlify(tokenId),
                amount: transferAmount,
                memoMessage: memo
            });

            expect(
                await evmTokenContract.balanceOf(evmMemoContract.address),
            )
                .to.equal(transferAmount);
        });


        it("Should be able to call Memo contract with tokens from EVM to Solana", async () => {
            const evmTokenAddress = await evmItsContract
                .registeredTokenAddress(
                    hexlify(tokenId),
                );
            const evmTokenContract = await utils.getEvmContract(
                setup.evm.wallet,
                "InterchainToken",
                evmTokenAddress,
            );

            let evmCall = await evmTokenContract.mint(setup.evm.wallet.address, transferAmount);
            evmCall = await evmCall.wait();

            const memoIx = await solanaMemoProgram.methods
                .processMemo(memo)
                .accounts({ counterPda: counterPdaPublicKey })
                .instruction();
            const executablePayload = new SolanaAxelarExecutablePayload(memoIx, EncodingSchema.BORSH);
            const metadataVersion = 0;
            const metadata = solidityPack(['uint32', 'bytes'], [metadataVersion, executablePayload.encode()]);

            const tx = await evmItsContract.interchainTransfer(
                hexlify(tokenId),
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
    });
});
