const chai = require('chai')
const ethers = require('ethers')
const solanaWeb3 = require('@solana/web3.js')
const utils = require('../lib/utils');

const { AXELAR_SOLANA_GATEWAY_PROGRAM_ID } = require('@native-to-anchor/axelar-solana/gateway');
const { PublicKey } = solanaWeb3;
const { axelarSolanaMemoProgramProgram, AXELAR_SOLANA_MEMO_PROGRAM_PROGRAM_ID } = require('@native-to-anchor/axelar-solana/memo-program');
const { expect } = chai;
const { solidity } = require('ethereum-waffle');
const { utils: { toUtf8Bytes } } = ethers;

chai.use(solidity);

describe('AxelarMemo Flow', function() {
    this.timeout('20m');

    const setup = utils.setupConnections();
    const evmMemoInfo = utils.getContractInfo('AxelarMemo', setup.evm.chainName);
    const solanaMemoInfo = utils.getContractInfo('axelar_solana_memo_program', setup.solana.chainName);

    const [gatewayRootPdaPublicKey,] = PublicKey.findProgramAddressSync(
        [Buffer.from('gateway')],
        AXELAR_SOLANA_GATEWAY_PROGRAM_ID
    );
    const [counterPdaPublicKey,] = PublicKey.findProgramAddressSync(
        [gatewayRootPdaPublicKey.toBuffer()],
        AXELAR_SOLANA_MEMO_PROGRAM_PROGRAM_ID
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
            provider: setup.solana.provider
        });

        evmMemoContract = await utils.getEvmContract(
            setup.evm.wallet,
            'AxelarMemo',
            evmMemoInfo.address
        );
    });

    it('Should send memo from Solana and receive on EVM', async () => {
        const [signingPda,] = PublicKey.findProgramAddressSync(
            [Buffer.from('gtw-call-contract')],
            AXELAR_SOLANA_MEMO_PROGRAM_PROGRAM_ID
        );

        let txHash = await solanaMemoProgram.methods.sendToGateway(
            memo,
            setup.evm.chainName,
            evmMemoInfo.address
        ).accounts({
            id: AXELAR_SOLANA_MEMO_PROGRAM_PROGRAM_ID,
            memoCounterPda: counterPdaPublicKey,
            signingPda0: signingPda,
            gatewayRootPda: gatewayRootPdaPublicKey,
            gatewayProgram: AXELAR_SOLANA_GATEWAY_PROGRAM_ID,
        }).rpc();

        console.log('    > Sent memo from solana to evm:', txHash);

        const gmpDetails = await utils.waitForGmpExecution(txHash, setup.axelar);
        const evmTx = await setup.evm.provider.getTransaction(gmpDetails.executed.transactionHash);

        await expect(evmTx).to.emit(evmMemoContract, 'ReceivedMemo').withArgs(memo);
    });

    it('Should send memo from EVM and receive on Solana', async () => {
        const tx = await evmMemoContract.sendToSolana(
            solanaMemoInfo.address,
            toUtf8Bytes(setup.solana.chainName),
            toUtf8Bytes(memo),
            [{ pubkey: counterPdaPublicKey.toBytes(), isSigner: false, isWritable: true }]
        );

        console.log('    > Sent memo from evm to solana:', tx.hash);

        const gmpDetails = await utils.waitForGmpExecution(tx.hash, setup.axelar);
        const solanaMemoLogs = await setup.solana.connection.getTransaction(
            gmpDetails.executed.transactionHash, {
            maxSupportedTransactionVersion: 0
        }).then((response) => {
            return response.meta.logMessages;
        });

        expect(
            solanaMemoLogs.some(log => log.includes(memo)),
            `expected ${solanaMemoLogs} to have a log that includes ${memo}`
        ).to.be.true;

    });
});
