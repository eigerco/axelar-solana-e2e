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
const { utils: { arrayify } } = require("ethers");
const { Metadata } = require("@metaplex-foundation/mpl-token-metadata");
const { getOrCreateAssociatedTokenAccount, TOKEN_2022_PROGRAM_ID } = require(
    "@solana/spl-token",
);

chai.use(solidity);

describe("EVM -> Solana Canonical Interchain Token", function() {
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

        token = await utils.deployEvmContract(
            setup.evm.wallet,
            "CustomTestToken",
            [
                name,
                symbol,
                decimals,
            ],
        );

        let mintTx = await token.mint(setup.evm.wallet.address, transferAmount);
        await mintTx.wait();

        tokenId = await evmFactoryContract.canonicalInterchainTokenId(token.address);
        [solanaToken] = findInterchainTokenPda(solanaItsProgram.itsRootPda, arrayify(tokenId));
        [metadataPda] = findMetadataPda(solanaToken);
    });

    it("Should register the token on EVM and deploy remotely on the Solana chain", async () => {
        let registrationTx = await evmFactoryContract.registerCanonicalInterchainToken(token.address);
        await registrationTx.wait();

        const tx = await evmFactoryContract["deployRemoteCanonicalInterchainToken(address,string,uint256)"](
            token.address,
            setup.solana.chainName,
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
        });

        it("Should be able to transfer tokens from EVM to Solana", async () => {
            const approvalTx = await token.approve(evmItsContract.address, transferAmount);
            await approvalTx.wait();

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
});
