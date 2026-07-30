const {getDefaultConfig, mergeConfig} = require('@react-native/metro-config');
const exclusionList = require('metro-config/src/defaults/exclusionList');

/**
 * Metro configuration
 * https://reactnative.dev/docs/metro
 *
 * @type {import('metro-config').MetroConfig}
 */
const config = {
  resolver: {
    blockList: exclusionList([
      /nodejs-assets\/nodejs-project\/.*/,
      /android\/app\/src\/main\/assets\/nodejs-project\/.*/,
    ]),
  },
};

module.exports = mergeConfig(getDefaultConfig(__dirname), config);
