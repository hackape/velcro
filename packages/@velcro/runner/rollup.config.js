const { rollupConfigFactory } = require('../../../rollup.config.factory');
const PackageJson = require('./package.json');

module.exports = rollupConfigFactory(__dirname, PackageJson);
