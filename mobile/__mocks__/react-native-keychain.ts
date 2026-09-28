import {jest} from '@jest/globals';
type Credential = {username: string; password: string; service: string; storage: string};
const entries = new Map<string, Credential>();
export const ACCESSIBLE = {AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: 'AfterFirstUnlockThisDeviceOnly'};
export const getGenericPassword = jest.fn(async ({service}: {service: string}) => entries.get(service) || false);
export const setGenericPassword = jest.fn(async (username: string, password: string, {service}: {service: string}) => {
  entries.set(service, {username, password, service, storage: 'test'});
  return {service, storage: 'test'};
});
export const resetGenericPassword = jest.fn(async ({service}: {service: string}) => { entries.delete(service); return true; });
