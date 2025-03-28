const fs = require('fs');
const { exec } = require('child_process');
const { program } = require('commander');

program
    .option('-c, --chain-type [CHAIN_TYPE]', 'which contracts to build: evm, solana, all (default)', 'all');

program.parse();

const options = program.opts();
const type = options.chainType;

if (fs.existsSync('.artifacts')) {
    fs.rmSync('.artifacts', { recursive: true });
}

fs.mkdirSync('.artifacts/');

switch (type) {
    case 'all':
        buildEvm();
        buildSolana();
        break;
    case 'evm':
        buildEvm();
        break;
    case 'solana':
        buildSolana();
        break;
    default:
        console.log('Invalid chain type: ', type);
}

function buildEvm() {
    exec('cd solana-axelar/evm-contracts/ && forge build', (err, stdout, stderr) => {

        if (err) {
            console.error(err);
            console.log(stderr);

            return -1;
        } else {
            fs.symlinkSync('../solana-axelar/evm-contracts/out/', '.artifacts/evm');
        }
    });

}

function buildSolana() {
    exec('cd solana-axelar/solana/ && cargo xtask build', (err, stdout, stderr) => {
        if (err) {
            console.error(err);
            console.log(stderr);

            return -1;
        } else {
            fs.symlinkSync('../solana-axelar/solana/target/sbf-solana-solana/release', '.artifacts/solana');
        }
    });
}
