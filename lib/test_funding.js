const ethers = require("ethers");
const fs = require("fs");
const path = require("path");
const utils = require("./utils");

const chainsInfo = utils.getChainsInfo();
const evmRpc = chainsInfo.chains[process.env.EVM_CHAIN].rpc;
const evmProvider = new ethers.providers.JsonRpcProvider(evmRpc);
const evmWallet = new ethers.Wallet(process.env.EVM_KEY, evmProvider);

let wallets = [];

async function mochaGlobalSetup() {
    let files = fs.readdirSync("./test/");
    let env = "";

    for (const file of files) {
        const baseName = path.parse(file).name;
        const envKey = utils.toSnakeCaseCapital(baseName);
        const wallet = ethers.Wallet.createRandom();

        let tx = await evmWallet.sendTransaction({
            to: wallet.address, value: ethers.utils.parseEther("0.2")
        });

        await tx.wait();

        wallets.push(wallet.privateKey);

        env += `${envKey}=${wallet.privateKey}\n`;
    }

    fs.writeFileSync("./.env.test", env);
};

async function mochaGlobalTeardown() {
    for (const key of wallets) {
        let wallet = new ethers.Wallet(key, evmProvider);

        const balance = await wallet.getBalance();
        const gasPrice = await evmProvider.getGasPrice();

        const gasEstimation = await evmWallet.estimateGas({
            to: evmWallet.address,
            value: 0
        });

        const fee = gasPrice.mul(gasEstimation);
        const valueToSend = balance.sub(fee);

        let txData = {
            to: evmWallet.address,
            value: valueToSend,
            gasPrice,
            gasLimit: gasEstimation
        };

        const tx = await wallet.sendTransaction(txData);
        await tx.wait();
    }

    fs.unlinkSync("./.env.test");
}

module.exports = {
    mochaGlobalSetup,
    mochaGlobalTeardown
}
