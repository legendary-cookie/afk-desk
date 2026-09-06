module.exports = {
  preset: 'react-native',
  transformIgnorePatterns: ['node_modules/(?!((jest-)?react-native|react-native-url-polyfill|@react-native(-community)?)/)'],
  modulePathIgnorePatterns: ['<rootDir>/android/build/', '<rootDir>/android/app/build/'],
};
