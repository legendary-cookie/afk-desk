import {beforeEach, expect, jest, test} from '@jest/globals';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Keychain from 'react-native-keychain';
import {ACCOUNT_STORAGE_KEY as key, loadAccounts, saveAccounts} from '../account-storage';

jest.mock('@react-native-async-storage/async-storage', () => require('@react-native-async-storage/async-storage/jest/async-storage-mock'));
jest.mock('react-native-keychain');
const account = {id: 'secure-account', username: 'login@example.com', proxy: {host: 'localhost', password: 'original-secret'}};
beforeEach(async () => {
  jest.clearAllMocks();
  await AsyncStorage.clear();
  await AsyncStorage.setItem(key, JSON.stringify([account]));
});

test('legacy plaintext migrates only after secure readback and survives reload', async () => {
  const restored = await loadAccounts();
  await saveAccounts(restored);
  const raw = (await AsyncStorage.getItem(key))!;
  expect(raw).not.toContain('original-secret');
  expect(raw).toContain('secretRef');
  expect(await loadAccounts()).toEqual([account]);
});

test('failed secure verification preserves the original plaintext snapshot', async () => {
  const original = await AsyncStorage.getItem(key);
  jest.mocked(Keychain.getGenericPassword).mockResolvedValueOnce(false).mockResolvedValueOnce(false);
  await expect(saveAccounts([account])).rejects.toThrow('could not be verified');
  expect(await AsyncStorage.getItem(key)).toBe(original);
  expect(Keychain.resetGenericPassword).not.toHaveBeenCalled();
});

test('secure write failure never erases the legacy password', async () => {
  jest.mocked(Keychain.setGenericPassword).mockRejectedValueOnce(new Error('Keystore locked'));
  await expect(saveAccounts([account])).rejects.toThrow('Keystore locked');
  expect(await loadAccounts()).toEqual([account]);
  expect((await AsyncStorage.getItem(key))!).toContain('original-secret');
});

test('failed snapshot commit preserves the previous secure password and later writes recover', async () => {
  await saveAccounts([account]);
  const original = await AsyncStorage.getItem(key);
  jest.mocked(AsyncStorage.setItem).mockRejectedValueOnce(new Error('disk full'));
  const updated = {...account, proxy: {...account.proxy, password: 'new-secret'}};
  await expect(saveAccounts([updated])).rejects.toThrow('disk full');
  expect(await AsyncStorage.getItem(key)).toBe(original);
  expect(await loadAccounts()).toEqual([account]);
  expect(Keychain.resetGenericPassword).not.toHaveBeenCalled();
  await saveAccounts([updated]);
  expect(await loadAccounts()).toEqual([updated]);
  expect(Keychain.resetGenericPassword).toHaveBeenCalledTimes(1);
});

test('final delete commits empty accounts before deleting the referenced secure credential', async () => {
  await saveAccounts([account]);
  const service = JSON.parse((await AsyncStorage.getItem(key))!)[0].proxy.secretRef;
  await saveAccounts([]);
  expect(await loadAccounts()).toEqual([]);
  expect(await Keychain.getGenericPassword({service})).toBe(false);
});

test('failed deletion commit retains the referenced secure credential', async () => {
  await saveAccounts([account]);
  jest.mocked(AsyncStorage.setItem).mockRejectedValueOnce(new Error('disk full'));
  await expect(saveAccounts([])).rejects.toThrow('disk full');
  expect(Keychain.resetGenericPassword).not.toHaveBeenCalled();
  expect(await loadAccounts()).toEqual([account]);
});

test('unchanged passwords reuse their verified secure revision', async () => {
  await saveAccounts([account]);
  await saveAccounts([account]);
  expect(Keychain.setGenericPassword).toHaveBeenCalledTimes(1);
});

test('missing secure credentials fail closed instead of restoring an empty password', async () => {
  await saveAccounts([account]);
  const service = JSON.parse((await AsyncStorage.getItem(key))!)[0].proxy.secretRef;
  await Keychain.resetGenericPassword({service});
  await expect(loadAccounts()).rejects.toThrow('unavailable');
  expect((await AsyncStorage.getItem(key))!).toContain(service);
});

test('queued changes finish in order, including final deletion', async () => {
  const first = saveAccounts([account]);
  const last = saveAccounts([]);
  await Promise.all([first, last]);
  expect(await loadAccounts()).toEqual([]);
});
