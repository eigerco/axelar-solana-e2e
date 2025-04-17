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
    ITS_EVENT_PARSER_MAP,
    InterchainTransfer,
    InterchainTransferReceived,
    ItsInstructions,
    TokenManagerDeployed,
    TokenManagerType,
    TokenMetadataRegistered,
} = require(
    "@eiger/solana-axelar/its"
);
const {
    parseEventsFromLogs
} = require("@eiger/solana-axelar/event-utils");
const { PublicKey } = solanaWeb3;
const { expect } = chai;
const { solidity } = require("ethereum-waffle");
const { utils: { arrayify } } = require("ethers");
const { getOrCreateAssociatedTokenAccount, TOKEN_PROGRAM_ID } = require(
    "@solana/spl-token",
);
const { GMPStatus } = require(
    "@axelar-network/axelarjs-sdk",
);

chai.use(solidity);

describe("EVM -> Solana Existing Custom Token", function() {
    this.timeout("60m");

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
    let _metadataPda;

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

        [solanaToken, associatedTokenAccount, _metadataPda] = await utils
            .setupSolanaMint(
                setup.solana,
                name,
                symbol,
                decimals,
                0
            );

    });

    it("Should register metadata", async () => {
        const solanaMetadataTx = await solanaItsProgram
            .registerTokenMetadata({
                payer: setup.solana.wallet.payer.publicKey,
                mint: solanaToken,
                tokenProgram: TOKEN_PROGRAM_ID,
                gasValue: new BN(gasValue),
                gasService: setup.solana.gasService,
                gasConfigPda: setup.solana.gasConfigPda,
            }).transaction();
        const solanaMetadataTxHash = await utils.sendSolanaTransaction(setup.solana, solanaMetadataTx);
        const solanaTransaction = await setup.solana.connection.getTransaction(solanaMetadataTxHash, {
            maxSupportedTransactionVersion: 0,
        });
        let emittedEvents = parseEventsFromLogs(
            solanaTransaction.meta.logMessages,
            ITS_EVENT_PARSER_MAP,
        );

        const tokenMetadataRegisteredEvent = emittedEvents.find(event => event instanceof TokenMetadataRegistered);
        expect(tokenMetadataRegisteredEvent).to.exist;
        expect(tokenMetadataRegisteredEvent.tokenAddress.equals(solanaToken)).to.be.true;
        expect(tokenMetadataRegisteredEvent.decimals).to.be.equal(decimals);

        token = await utils.deployEvmContract(
            setup.evm.wallet,
            "CustomTestToken",
            [
                name,
                symbol,
                decimals,
            ],
        );

        const evmMetadataTx = await evmItsContract.registerTokenMetadata(
            token.address,
            gasValue,
            { value: gasValue },
        );
        await evmMetadataTx.wait();


        await utils.waitForGmpExecution(
            evmMetadataTx.hash,
            setup.axelar,
        );

        await utils.waitForGmpExecution(
            solanaMetadataTxHash,
            setup.axelar,
        );


        tokenId = await evmFactoryContract.linkedTokenId(setup.evm.wallet.address, salt);
    });

    it("Should register the token on EVM and deploy remotely on the Solana chain", async () => {
        let registrationTx = await evmFactoryContract.registerCustomToken(
            salt,
            token.address,
            TokenManagerType.MintBurn,
            setup.evm.wallet.address
        );
        await registrationTx.wait();

        const tx = await evmFactoryContract.linkToken(
            salt,
            setup.solana.chainName,
            solanaToken.toBytes(),
            TokenManagerType.MintBurn,
            setup.evm.wallet.address,
            gasValue,
            { value: gasValue }
        );

        const srcGmpDetails = await utils.waitForGmpExecution(
            tx.hash,
            setup.axelar,
        );

        const dstGmpDetails = await utils.waitForGmpExecution(
            srcGmpDetails.executed.transactionHash,
            setup.axelar,
        );

        expect(dstGmpDetails.status).to.be.equal(GMPStatus.DEST_EXECUTED);

        const solanaTransaction = await setup.solana.connection.getTransaction(dstGmpDetails.executed.transactionHash, {
            maxSupportedTransactionVersion: 0,
        });
        let emittedEvents = parseEventsFromLogs(
            solanaTransaction.meta.logMessages,
            ITS_EVENT_PARSER_MAP,
        );

        const tokenManagerDeployedEvent = emittedEvents.find(event => event instanceof TokenManagerDeployed);
        expect(tokenManagerDeployedEvent).to.exist;
        expect(tokenManagerDeployedEvent.tokenId.equals(arrayify(tokenId))).to.be.true;
        expect(tokenManagerDeployedEvent.tokenManagerType).to.equal(TokenManagerType.MintBurn);
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
                    TOKEN_PROGRAM_ID,
                );

            let mintTx = await token.mint(setup.evm.wallet.address, transferAmount);
            await mintTx.wait();

            const evmTokenManagerAddress = await evmItsContract
                .tokenManagerAddress(tokenId);

            let mintershipTransferTx = await token.transferMintership(evmTokenManagerAddress);
            await mintershipTransferTx.wait();


            const tx = await solanaItsProgram.tokenManager.handOverMintAuthority({
                payer: setup.solana.wallet.payer.publicKey,
                tokenId: arrayify(tokenId),
                mint: solanaToken,
                TOKEN_PROGRAM_ID,
            }).transaction();
            await utils.sendSolanaTransaction(setup.solana, tx);

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
            const dstGmpDetails = await utils.waitForGmpExecution(
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

            const solanaTransaction = await setup.solana.connection.getTransaction(dstGmpDetails.executed.transactionHash, {
                maxSupportedTransactionVersion: 0,
            });
            let emittedEvents = parseEventsFromLogs(
                solanaTransaction.meta.logMessages,
                ITS_EVENT_PARSER_MAP,
            );

            const interchainTransferReceivedEvent = emittedEvents.find(event => event instanceof InterchainTransferReceived);
            expect(interchainTransferReceivedEvent).to.exist;
            expect(interchainTransferReceivedEvent.tokenId.equals(arrayify(tokenId))).to.be.true;
            expect(interchainTransferReceivedEvent.sourceAddress.equals(arrayify(setup.evm.wallet.address))).to.be.true;
            expect(interchainTransferReceivedEvent.amount).to.equal(transferAmount);
            expect(interchainTransferReceivedEvent.destinationAddress.equals(associatedTokenAccount.address)).to.be.true;
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
                tokenProgram: TOKEN_PROGRAM_ID,
            }).transaction();
            const txHash = await utils.sendSolanaTransaction(setup.solana, tx);

            const solanaTransaction = await setup.solana.connection.getTransaction(txHash, {
                maxSupportedTransactionVersion: 0,
            });
            let emittedEvents = parseEventsFromLogs(
                solanaTransaction.meta.logMessages,
                ITS_EVENT_PARSER_MAP,
            );

            const interchainTransferEvent = emittedEvents.find(event => event instanceof InterchainTransfer);
            expect(interchainTransferEvent).to.exist;
            expect(interchainTransferEvent.tokenId.equals(arrayify(tokenId))).to.be.true;
            expect(interchainTransferEvent.destinationAddress.equals(arrayify(setup.evm.wallet.address))).to.be.true;
            expect(interchainTransferEvent.destinationChain).to.equal(setup.evm.chainName);
            expect(interchainTransferEvent.amount).to.equal(transferAmount);

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
});
