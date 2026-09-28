import React from 'react';
import {afterEach, beforeEach, expect, jest, test} from '@jest/globals';
import renderer, {act} from 'react-test-renderer';
import {Alert, Pressable, Text} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import nodejs from 'nodejs-mobile-react-native';
import App from '../App';

jest.setTimeout(30000);

jest.mock('@react-native-async-storage/async-storage', () => require('@react-native-async-storage/async-storage/jest/async-storage-mock'));
jest.mock('react-native-keychain');
jest.mock('nodejs-mobile-react-native', () => ({
  start: jest.fn(),
  channel: {addListener: jest.fn(() => ({remove: jest.fn()})), post: jest.fn()},
}));

const key = 'afkdesk.mobile.accounts.v1';
const account = {id: 'saved-account', username: 'user@example.com', host: 'localhost', connectOnStartup: false};
type EngineEvent = {type: string; accountId: string; payload: {username: string}};
type ListenerRegistration = (name: string, listener: (event: EngineEvent) => void) => void;
type CommandPost = (name: string, payload: {action: string; account: {username: string}}) => void;
let app: renderer.ReactTestRenderer;

function engineListener() {
  return (nodejs.channel.addListener as jest.Mock<ListenerRegistration>).mock.calls.find(([name]) => name === 'engine-event')![1];
}

async function mount() {
  await act(async () => { app = renderer.create(<App />); });
}
async function press(label: string) {
  const button = app.root.findAllByType(Pressable).find(element =>
    element.findAllByType(Text).some(text => text.props.children === label));
  expect(button).toBeDefined();
  await act(async () => { button!.props.onPress(); });
}
beforeEach(async () => {
  jest.useFakeTimers();
  jest.clearAllMocks();
  await AsyncStorage.clear();
  await AsyncStorage.setItem(key, JSON.stringify([account]));
});
afterEach(() => {
  if (app) { act(() => app.unmount()); }
  jest.clearAllTimers();
  jest.useRealTimers();
  jest.restoreAllMocks();
});

test('unmount removes all three bridge subscriptions', async () => {
  await mount();
  const subscriptions = (nodejs.channel.addListener as jest.Mock).mock.results.map(result => result.value as {remove: jest.Mock});
  expect(subscriptions).toHaveLength(3);
  act(() => app.unmount());
  for (const subscription of subscriptions) expect(subscription.remove).toHaveBeenCalledTimes(1);
});

test('deleting the final account survives remount', async () => {
  jest.spyOn(Alert, 'alert').mockImplementation((_title, _message, buttons) => {
    buttons?.find(button => button.text === 'Delete')?.onPress?.();
  });
  await mount();
  await press('Edit');
  await press('Delete account');
  act(() => app.unmount());
  await mount();
  expect(app.root.findAllByType(Text).some(text => text.props.children === 'Add your first account')).toBe(true);
});

test('identity updates preserve the Microsoft login principal on the next connection', async () => {
  await mount();
  const listener = engineListener();
  await act(async () => listener({type: 'identity', accountId: account.id, payload: {username: 'MinecraftIGN'}}));
  act(() => app.unmount());
  await mount();
  await press('Connect');
  const command = (nodejs.channel.post as jest.Mock<CommandPost>).mock.calls.find(([, payload]) => payload.action === 'connect')![1];
  expect(command.account.username).toBe('user@example.com');
  expect(app.root.findAllByType(Text).some(text => text.props.children === 'MinecraftIGN')).toBe(true);
});

test('pending hydration never replaces saved accounts with the initial empty state', async () => {
  let finishLoad!: (raw: string) => void;
  (AsyncStorage.getItem as jest.Mock).mockImplementationOnce(() => new Promise(resolve => { finishLoad = resolve; }));
  (AsyncStorage.setItem as jest.Mock).mockClear();
  await mount();
  expect(AsyncStorage.setItem).not.toHaveBeenCalled();
  await act(async () => { finishLoad(JSON.stringify([account])); });
  expect(app.root.findAllByType(Text).some(text => text.props.children === account.username)).toBe(true);
});

test('corrupt saved data is preserved and reported instead of overwritten', async () => {
  await AsyncStorage.setItem(key, '{broken');
  const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  await mount();
  expect(await AsyncStorage.getItem(key)).toBe('{broken');
  expect(alert).toHaveBeenCalledWith('Storage error', 'Saved accounts could not be loaded.');
  await press('Add account');
  await press('Save');
  expect(alert).toHaveBeenCalledWith('Storage unavailable', expect.stringContaining('not been loaded'));
  expect(await AsyncStorage.getItem(key)).toBe('{broken');
});

test('failed writes are visible and later account changes can still persist', async () => {
  const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  (AsyncStorage.setItem as jest.Mock<typeof AsyncStorage.setItem>).mockRejectedValueOnce(new Error('Storage full'));
  await mount();
  expect(alert).toHaveBeenCalledWith('Storage error', expect.stringContaining('could not be saved'));
  const listener = engineListener();
  await act(async () => listener({type: 'identity', accountId: account.id, payload: {username: 'Recovered'}}));
  act(() => app.unmount());
  await mount();
  expect(app.root.findAllByType(Text).some(text => text.props.children === 'Recovered')).toBe(true);
});
