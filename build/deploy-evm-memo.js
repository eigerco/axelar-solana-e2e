const ethers = require('ethers');
const fs = require('fs');
const path = require('path');
const utils = require('../lib/utils');
const { program } = require('commander');

program
    .option('-c, --chain <chain>', 'chain to deploy to', 'eth-sepolia')
    .argument('<private-key>');

program.parse();

const options = program.opts();
const chain = options.chain;
const privateKey = program.args[0];
const projectRoot = path.resolve(utils.findProjectRoot(__dirname));


const info = utils.getChainsInfo();

const provider = new ethers.providers.JsonRpcProvider(info.chains[chain].rpc);
const wallet = new ethers.Wallet(privateKey, provider);

console.log(info);
const constructorArgs = [
    info['chains'][chain]['contracts']['AxelarGateway']['address'],
    info['chains'][chain]['contracts']['InterchainTokenService']['address']
];

utils.deployEvmContract(wallet, 'AxelarMemo', constructorArgs).then((contract) => {
    const address = contract.address;

    console.log(`AxelarMemo deployed to address: ${address}`);

    let test_contracts = JSON.parse(fs.readFileSync(path.join(projectRoot, 'test-contracts.json'), 'utf8'));
    if (test_contracts['chains'][chain] == undefined) {
        test_contracts['chains'][chain] = info['chains'][chain];
    }

    test_contracts['chains'][chain]['contracts'] = {
        AxelarMemo: {
            address: address,
            gatewayAddress: constructorArgs[0],
            itsAddress: constructorArgs[1]
        }
    };

    const json = JSON.stringify(test_contracts, null, 4);

    fs.writeFileSync(path.join(projectRoot, 'test-contracts.json'), json);
});
