'use strict';

const anchor = require('@coral-xyz/anchor');
const deepMerge = require('deepmerge');
const ethers = require('ethers');
const fs = require('fs');
const path = require('path');
const solanaWeb3 = require('@solana/web3.js')

const { AxelarGMPRecoveryAPI, GMPStatus } = require('@axelar-network/axelarjs-sdk');
const { Keypair } = solanaWeb3;
const { Wallet } = anchor;

require('dotenv').config();

let chainsInfo;

function findProjectRoot(startDir) {
    let currentDir = startDir;

    while (currentDir !== path.parse(currentDir).root) {
        const potentialPackageJson = path.join(currentDir, 'package.json');

        if (fs.existsSync(potentialPackageJson)) {
            return currentDir;
        }

        currentDir = path.resolve(currentDir, '..');
    }

    throw new Error('Unable to find project root');
}

function getChainsInfo() {
    if (chainsInfo == undefined) {
        const projectRoot = findProjectRoot(__dirname);
        const test_contracts = JSON.parse(fs.readFileSync(path.join(projectRoot, 'test-contracts.json'), 'utf8'));
        const amplifier_contracts = JSON.parse(fs.readFileSync(path.join(projectRoot, 'devnet-amplifier.json'), 'utf8'));

        chainsInfo = deepMerge(test_contracts, amplifier_contracts);
    }

    return chainsInfo;
}


function findContractPath(dir, contractName) {
    const files = fs.readdirSync(dir);

    for (const file of files) {
        const filePath = path.join(dir, file);
        const stat = fs.statSync(filePath);

        if (stat && stat.isDirectory()) {
            const recursivePath = findContractPath(filePath, contractName);

            if (recursivePath) {
                return recursivePath;
            }
        } else if (file === `${contractName}.json`) {
            return filePath;
        }
    }
}

function getContractPath(contractName, projectRoot = '') {
    if (projectRoot === '') {
        projectRoot = findProjectRoot(__dirname);
    }

    projectRoot = path.resolve(projectRoot);

    const searchDirs = [
        path.join(projectRoot, '.artifacts', 'evm'),
        path.join(projectRoot, '.artifacts', 'solana'),
    ];

    for (const dir of searchDirs) {
        if (fs.existsSync(dir)) {
            const contractPath = findContractPath(dir, contractName);

            if (contractPath) {
                return contractPath;
            }
        }
    }

    throw new Error(`Contract path for ${contractName} must be entered manually.`);
}

function getContractJSON(contractName, artifactPath) {
    let contractPath;

    if (artifactPath) {
        contractPath = artifactPath.endsWith('.json') ? artifactPath : artifactPath + contractName + '.sol/' + contractName + '.json';
    } else {
        contractPath = getContractPath(contractName);
    }

    try {
        const contractJson = require(contractPath);
        return contractJson;
    } catch (err) {
        throw new Error(`Failed to load contract JSON for ${contractName} at path ${contractPath} with error: ${err}`);
    }
}

async function deployEvmContract(wallet, contractName, args = []) {
    const json = getContractJSON(contractName, '');
    const factory = ethers.ContractFactory.fromSolidity(json, wallet);
    const deployment = await factory.deploy(...args);
    const contract = await deployment.deployed();

    return contract;
}

async function getEvmContract(wallet, contractName, address) {
    const json = getContractJSON(contractName, '');
    const factory = ethers.ContractFactory.fromSolidity(json, wallet);

    let contract = factory.attach(address);

    return contract;
}

async function waitForGmpExecution(txHash, axelar) {
    return await new Promise((resolve, reject) => {
        const subscription = axelar.subscribeToTx(txHash, (event) => {
            if (event.status == GMPStatus.DEST_EXECUTED) {
                resolve(event);
            } else if (event.status == GMPStatus.DEST_EXECUTE_ERROR || event.status == GMPStatus.UNKNOWN_ERROR) {
                reject(new Error('Error executing the transaction'));
            } else {
                console.log('    > Received GMP status update:', event.status);
            }
        });

        subscription.catch((error) => {
            reject(error);
        });
    });
}

function setupConnections() {
    const chainsInfo = getChainsInfo();

    const evmRpc = chainsInfo.chains[process.env.EVM_CHAIN].rpc;
    const evmProvider = new ethers.providers.JsonRpcProvider(evmRpc);
    const evmWallet = new ethers.Wallet(process.env.EVM_KEY, evmProvider);

    const solanaRpc = chainsInfo.chains[process.env.SOLANA_CHAIN].rpc;
    const solanaConnection = new solanaWeb3.Connection(solanaRpc, 'confirmed');
    const solanaWallet = new Wallet(Keypair.fromSecretKey(Uint8Array.from(JSON.parse(process.env.SOLANA_KEY))));
    const solanaProvider = new anchor.AnchorProvider(solanaConnection, solanaWallet, { commitment: 'processed' });

    const axelar = new AxelarGMPRecoveryAPI({ environment: process.env.AXELAR_CHAIN });

    return {
        axelar: axelar,
        evm: {
            chainName: process.env.EVM_CHAIN,
            provider: evmProvider,
            wallet: evmWallet,
        },
        solana: {
            chainName: process.env.SOLANA_CHAIN,
            connection: solanaConnection,
            wallet: solanaWallet,
            provider: solanaProvider,
        }
    }
}

function getContractInfo(contractName, chainName) {
    return chainsInfo.chains[chainName].contracts[contractName];
}

module.exports = {
    deployEvmContract,
    findProjectRoot,
    getChainsInfo,
    getContractInfo,
    getContractJSON,
    getEvmContract,
    setupConnections,
    waitForGmpExecution
};
