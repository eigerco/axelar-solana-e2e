# axelar-solana-e2e

## Requirements

- [node.js and npm](https://docs.npmjs.com/downloading-and-installing-node-js-and-npm)
- [forge (shipped with foundry)](https://book.getfoundry.sh/getting-started/installation)

## Before running the tests

Before running the tests some preconditions need to be fulfilled:

- Make sure you have the `solana-axelar` submodule set up and updated (i.e.: `git submodule update --init --recursive`)
- Run `npm install` to install the required `node` dependencies
- Run `node build/build.js -c evm` to build the evm contracts from `solana-axelar/evm-contracts` and link them under `.artifacts`
- The programs/contracts being tested should already be deployed on the chains involved in the tests, no automatically deployment is performed
- Information about the chains and the contracts are fetched from `test-contracts.json` and `devnet-amplifier.json` (these files are merged at run-time), thus, **if you deploy new contracts or use a chain that does not exist in any of these two files, make sure to update these files**
  - `devnet-amplifier.json` copied from [axelar-contract-deployments repo](https://github.com/axelarnetwork/axelar-contract-deployments/blob/main/axelar-chains-config/info/devnet-amplifier.json) and that's the reason for two separate files, otherwise we would lose the info about our contracts when copying a new `devnet-amplifier.json`.
  - A script to deploy the `AxelarMemo` EVM contract was added to `build/` which automatically deploys and updates the `test-contracts.json` file.
- Some environment variables need to be set (or `.env` file present), check the `dotenv.tmpl` file
- The wallets used (derived from the keys specified in the environment, see above) should be funded

## Running the tests

The project uses `mocha.js` as test harness. To run the tests, execute:

```bash
npm test
```
