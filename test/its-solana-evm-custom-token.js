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
    linkedTokenId,
} = require(
    "@eiger/solana-axelar/its"
);
const { PublicKey } = solanaWeb3;
const { TOKEN_PROGRAM_ID } = require(
    "@solana/spl-token",
);
const { expect } = chai;
const { solidity } = require("ethereum-waffle");
const { utils: { hexlify, arrayify } } = require("ethers");

chai.use(solidity);

describe("Solana -> EVM Existing Custom Token", function() {
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

    const name = "MyToken";
    const symbol = "MT";
    const decimals = 6;
    const transferAmount = 1e6;
    const gasValue = 2500000;
    const salt = utils.getRandomBytes32();
    const tokenId = linkedTokenId(
        setup.solana.wallet.payer.publicKey,
        salt,
    );

    let solanaItsProgram;
    let evmItsContract;

    let token;
    let associatedTokenAccount;
    let evmToken;

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

        const solanaMetadataTx = await solanaItsProgram
            .registerTokenMetadata({
                payer: setup.solana.wallet.payer.publicKey,
                mint: token,
                tokenProgram: TOKEN_PROGRAM_ID,
                gasValue: new BN(0),
                gasService: setup.solana.gasService,
                gasConfigPda: setup.solana.gasConfigPda,
            }).transaction();
        const solanaMetadataTxHash = await utils.sendSolanaTransaction(setup.solana, solanaMetadataTx);

        evmToken = await utils.deployEvmContract(
            setup.evm.wallet,
            "CustomTestToken",
            [
                name,
                symbol,
                decimals,
            ],
        );

        const evmMetadataTx = await evmItsContract.registerTokenMetadata(
            evmToken.address,
            gasValue,
            {
                value: gasValue,
            },
        );
        await evmMetadataTx.wait();

        const evmTokenManagerAddress = await evmItsContract
            .tokenManagerAddress(tokenId);
        await evmToken.addMinter(evmTokenManagerAddress);

        await utils.waitForGmpExecution(
            evmMetadataTx.hash,
            setup.axelar,
        );

        await utils.waitForGmpExecution(
            solanaMetadataTxHash,
            setup.axelar,
        );
    });

    it("Should register the token on Solana and deploy remotely on the EVM chain", async () => {
        const registrationTx = await solanaItsProgram
            .registerCustomToken({
                payer: setup.solana.wallet.payer.publicKey,
                salt,
                mint: token,
                tokenManagerType: TokenManagerType.MintBurn,
                tokenProgram: TOKEN_PROGRAM_ID,
                operator: setup.solana.wallet.payer.publicKey,
            }).transaction();
        await utils.sendSolanaTransaction(setup.solana, registrationTx);

        const handOverMintAuthorityTx = await solanaItsProgram.tokenManager.handOverMintAuthority({
            payer: setup.solana.wallet.payer.publicKey,
            tokenId,
            mint: token,
            TOKEN_PROGRAM_ID,
        }).transaction();
        await utils.sendSolanaTransaction(setup.solana, handOverMintAuthorityTx);

        const tx = await solanaItsProgram.linkToken({
            payer: setup.solana.wallet.payer.publicKey,
            salt,
            destinationChain: setup.evm.chainName,
            destinationTokenAddress: arrayify(evmToken.address),
            tokenManagerType: TokenManagerType.MintBurn,
            linkParams: arrayify(setup.evm.wallet.address),
            gasValue: new BN(0),
            gasService: setup.solana.gasService,
            gasConfigPda: setup.solana.gasConfigPda,
            tokenProgram: TOKEN_PROGRAM_ID,
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
            "TokenManagerDeployed",
        ).withNamedArgs({
            tokenId: hexlify(tokenId),
            tokenManagerType: TokenManagerType.MintBurn,
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
                gasValue: new BN(0),
                gasService: setup.solana.gasService,
                gasConfigPda: setup.solana.gasConfigPda,
                tokenProgram: TOKEN_PROGRAM_ID,
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
                tokenId: hexlify(tokenId),
                amount: transferAmount,
                sourceChain: setup.solana.chainName,
            });

            expect(await evmToken.balanceOf(setup.evm.wallet.address)).to.equal(transferAmount);
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

            const currentBalance = Number(
                (await setup.solana.connection.getTokenAccountBalance(
                    associatedTokenAccount.address,
                ))
                    .value
                    .amount,
            );

            expect(currentBalance).to.equal(transferAmount);
        });
    });
});
