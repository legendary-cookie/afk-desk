import {beforeEach, expect, jest, test} from '@jest/globals';
import {AppState, NativeModules, PermissionsAndroid, Platform} from 'react-native';
import {createForegroundSessionSync} from '../foreground-service';

const setSessionCount = jest.fn<(count: number) => Promise<void>>();
beforeEach(() => {
  jest.restoreAllMocks();
  setSessionCount.mockReset().mockResolvedValue(undefined);
  NativeModules.AfkForegroundService = {setSessionCount};
  Object.defineProperty(Platform, 'OS', {configurable: true, value: 'android'});
  Object.defineProperty(Platform, 'Version', {configurable: true, value: 35});
  Object.defineProperty(AppState, 'currentState', {configurable: true, value: 'active'});
  jest.spyOn(PermissionsAndroid, 'check').mockResolvedValue(false);
  jest.spyOn(PermissionsAndroid, 'request').mockResolvedValue(PermissionsAndroid.RESULTS.DENIED);
});

test('idle launch does not start a service or prompt permission; active sessions update and zero stops', async () => {
  const sync = createForegroundSessionSync();
  await sync({});
  expect(setSessionCount).not.toHaveBeenCalled();
  expect(PermissionsAndroid.request).not.toHaveBeenCalled();
  await sync({a: {status: 'connecting'}, b: {status: 'offline'}});
  await sync({a: {status: 'connected'}});
  await sync({a: {status: 'online'}, b: {status: 'reconnecting'}});
  await sync({a: {status: 'offline'}, b: {status: 'offline'}});
  expect(setSessionCount.mock.calls).toEqual([[1], [2], [0]]);
  expect(PermissionsAndroid.request).toHaveBeenCalledTimes(1);
});

test('an unanswered notification prompt cannot delay stopping the service', async () => {
  jest.mocked(PermissionsAndroid.request).mockImplementation(() => new Promise(() => {}));
  const sync = createForegroundSessionSync();
  await sync({a: {status: 'connecting'}});
  await sync({});
  expect(setSessionCount.mock.calls).toEqual([[1], [0]]);
});

test('native errors are reported and later updates can retry', async () => {
  setSessionCount.mockRejectedValueOnce(new Error('Background start disallowed'));
  const sync = createForegroundSessionSync();
  await expect(sync({a: {status: 'connecting'}})).rejects.toThrow('Background start disallowed');
  await sync({a: {status: 'connecting'}});
  expect(setSessionCount).toHaveBeenCalledTimes(2);
});

test('iOS never calls the Android service or notification permission', async () => {
  Object.defineProperty(Platform, 'OS', {configurable: true, value: 'ios'});
  await createForegroundSessionSync()({a: {status: 'online'}});
  expect(setSessionCount).not.toHaveBeenCalled();
  expect(PermissionsAndroid.request).not.toHaveBeenCalled();
});

test('Android before 13 starts sessions without requesting runtime notification permission', async () => {
  Object.defineProperty(Platform, 'Version', {configurable: true, value: 32});
  await createForegroundSessionSync()({a: {status: 'online'}});
  expect(setSessionCount).toHaveBeenCalledWith(1);
  expect(PermissionsAndroid.request).not.toHaveBeenCalled();
});

test('a late permission check does not prompt after the final disconnect', async () => {
  let finishCheck!: (granted: boolean) => void;
  jest.mocked(PermissionsAndroid.check).mockImplementation(() => new Promise(resolve => { finishCheck = resolve; }));
  const sync = createForegroundSessionSync();
  await sync({a: {status: 'connecting'}});
  await sync({});
  finishCheck(false);
  await Promise.resolve();
  await Promise.resolve();
  expect(PermissionsAndroid.request).not.toHaveBeenCalled();
});
