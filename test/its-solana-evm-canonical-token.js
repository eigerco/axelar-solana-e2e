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
    InterchainTokenDeploymentStarted,
    InterchainTokenIdClaimed,
    InterchainTransfer,
    InterchainTransferReceived,
    ItsInstructions,
    TokenManagerDeployed,
    TokenManagerType,
    canonicalInterchainTokenId,
} = require(
    "@eiger/solana-axelar/its"
);
const {
    parseEventsFromLogs
} = require("@eiger/solana-axelar/event-utils");
const { PublicKey } = solanaWeb3;
const { TOKEN_PROGRAM_ID } = require(
    "@solana/spl-token",
);
const { expect } = chai;
const { solidity } = require("ethereum-waffle");
const { utils: { hexlify, arrayify } } = require("ethers");

chai.use(solidity);

describe("Solana -> EVM Canonical Interchain Token", function() {
    this.timeout("60m");

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

    const name = "MyToken";
    const symbol = "MT";
    const decimals = 6;
    const transferAmount = 1e6;
    const gasValue = 2500000;

    let solanaItsProgram;
    let evmItsContract;

    let token;
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

        [token, associatedTokenAccount, _metadataPda] = await utils
            .setupSolanaMint(
                setup.solana,
                name,
                symbol,
                decimals,
                transferAmount,
            );
    });

    it("Should register the token on Solana and deploy remotely on the EVM chain", async () => {
        tokenId = canonicalInterchainTokenId(token);
        const tx = await solanaItsProgram.registerCanonicalInterchainToken({
            payer: setup.solana.wallet.payer.publicKey,
            mint: token,
            tokenProgram: TOKEN_PROGRAM_ID,
        }).transaction();
        var txHash = await utils.sendSolanaTransaction(setup.solana, tx);

        const registrationTx = await setup.solana.connection.getTransaction(txHash, {
            maxSupportedTransactionVersion: 0,
        });
        var emittedEvents = parseEventsFromLogs(
            registrationTx.meta.logMessages,
            ITS_EVENT_PARSER_MAP,
        );

        const interchainTokenIdClaimed = emittedEvents.find(event => event instanceof InterchainTokenIdClaimed);
        expect(interchainTokenIdClaimed).to.exist;
        expect(interchainTokenIdClaimed.tokenId.equals(tokenId)).to.be.true;
        expect(interchainTokenIdClaimed.deployer.equals(setup.solana.wallet.payer.publicKey)).to.be.true;

        const tokenManagerDeployedEvent = emittedEvents.find(event => event instanceof TokenManagerDeployed);
        expect(tokenManagerDeployedEvent).to.exist;
        expect(tokenManagerDeployedEvent.tokenId.equals(tokenId)).to.be.true;
        expect(tokenManagerDeployedEvent.tokenManagerType).to.equal(TokenManagerType.LockUnlock);


        const deployTx = await solanaItsProgram
            .deployRemoteCanonicalInterchainToken({
                payer: setup.solana.wallet.payer.publicKey,
                mint: token,
                destinationChain: setup.evm.chainName,
                gasValue: new BN(gasValue),
                gasService: setup.solana.gasService,
                gasConfigPda: setup.solana.gasConfigPda,
                tokenProgram: TOKEN_PROGRAM_ID,
            }).transaction();
        txHash = await utils.sendSolanaTransaction(setup.solana, deployTx);
        const deploy = await setup.solana.connection.getTransaction(txHash, {
            maxSupportedTransactionVersion: 0,
        });
        emittedEvents = parseEventsFromLogs(
            deploy.meta.logMessages,
            ITS_EVENT_PARSER_MAP,
        );

        const deploymentStartedEvent = emittedEvents.find(event => event instanceof InterchainTokenDeploymentStarted);
        expect(deploymentStartedEvent).to.exist;
        expect(deploymentStartedEvent.tokenId.equals(tokenId)).to.be.true;
        expect(deploymentStartedEvent.destinationChain).to.equal(setup.evm.chainName);
        expect(deploymentStartedEvent.tokenName).to.equal(name);
        expect(deploymentStartedEvent.tokenSymbol).to.equal(symbol);
        expect(deploymentStartedEvent.tokenDecimals).to.equal(decimals);

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
        it("Should be able to transfer tokens from Solana to EVM", async () => {
            const tx = await solanaItsProgram.interchainTransfer({
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
            expect(interchainTransferEvent.tokenId.equals(tokenId)).to.be.true;
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
                tokenId: hexlify(tokenId),
                amount: transferAmount,
                sourceChain: setup.solana.chainName,
            });

            const evmTokenAddress = await evmItsContract
                .registeredTokenAddress(
                    hexlify(tokenId),
                );
            const evmTokenContract = await utils.getEvmContract(
                setup.evm.wallet,
                "InterchainToken",
                evmTokenAddress,
            );

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
            expect(interchainTransferReceivedEvent.tokenId.equals(tokenId)).to.be.true;
            expect(interchainTransferReceivedEvent.sourceAddress.equals(arrayify(setup.evm.wallet.address))).to.be.true;
            expect(interchainTransferReceivedEvent.amount).to.equal(transferAmount);
            expect(interchainTransferReceivedEvent.destinationAddress.equals(associatedTokenAccount.address)).to.be.true;
        });
    });
});
