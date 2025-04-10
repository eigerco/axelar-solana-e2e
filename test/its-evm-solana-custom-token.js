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
    TokenManagerType,
} = require(
    "@eiger/solana-axelar/its"
);
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

        const solanaMetadataTxHash = await solanaItsProgram
            .registerTokenMetadata({
                payer: setup.solana.wallet.payer.publicKey,
                mint: solanaToken,
                tokenProgram: TOKEN_PROGRAM_ID,
                gasValue: new BN(gasValue),
                gasService: setup.solana.gasService,
                gasConfigPda: setup.solana.gasConfigPda,
            }).rpc();

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


            await solanaItsProgram.tokenManager.handOverMintAuthority({
                payer: setup.solana.wallet.payer.publicKey,
                tokenId: arrayify(tokenId),
                mint: solanaToken,
                TOKEN_PROGRAM_ID,
            }).rpc();

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
            const txHash = await solanaItsProgram.interchainTransfer({
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
