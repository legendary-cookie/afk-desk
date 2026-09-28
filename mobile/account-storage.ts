import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Keychain from 'react-native-keychain';

export const ACCOUNT_STORAGE_KEY = 'afkdesk.mobile.accounts.v1';
const SECRET_PREFIX = 'dev.afkdesk.mobile.proxy.';
type AccountRecord = {id: string; proxy?: {password?: string; secretRef?: string}};
let writes: Promise<unknown> = Promise.resolve();
let revision = 0;

function parse(raw: string | null): AccountRecord[] {
  const accounts = raw === null ? [] : JSON.parse(raw);
  if (!Array.isArray(accounts)) throw new Error('Invalid account storage');
  const ids = new Set<string>();
  for (const account of accounts) {
    if (!account || typeof account.id !== 'string' || !account.id || ids.has(account.id)
      || (account.proxy !== undefined && (!account.proxy || typeof account.proxy !== 'object' || Array.isArray(account.proxy)))
      || (account.proxy?.password !== undefined && typeof account.proxy.password !== 'string')
      || (account.proxy?.secretRef !== undefined && (typeof account.proxy.secretRef !== 'string' || !account.proxy.secretRef.startsWith(SECRET_PREFIX)))) {
      throw new Error('Invalid account storage');
    }
    ids.add(account.id);
  }
  return accounts;
}

async function passwordFor(account: AccountRecord): Promise<string> {
  if (!account.proxy?.secretRef) return account.proxy?.password || '';
  const credentials = await Keychain.getGenericPassword({service: account.proxy.secretRef});
  if (!credentials || credentials.username !== account.id) throw new Error('Saved proxy credential is unavailable');
  return credentials.password;
}

export async function loadAccounts<T extends AccountRecord>(): Promise<T[]> {
  await writes;
  const accounts = parse(await AsyncStorage.getItem(ACCOUNT_STORAGE_KEY));
  return Promise.all(accounts.map(async account => {
    if (!account.proxy) return account as T;
    const password = await passwordFor(account);
    const proxy = {...account.proxy};
    delete proxy.secretRef;
    return {...account, proxy: {...proxy, password}} as T;
  }));
}

export function saveAccounts<T extends AccountRecord>(accounts: T[]): Promise<void> {
  // Capture at call time, and share the queue across remounts. A failed write must
  // not poison later retries or allow an older snapshot to finish last.
  const snapshot = JSON.stringify(accounts);
  const operation = writes.then(async () => {
    const previous = parse(await AsyncStorage.getItem(ACCOUNT_STORAGE_KEY));
    const next = parse(snapshot);
    const retained = new Set<string>();
    for (const account of next) {
      if (!account.proxy) continue;
      const password = account.proxy.password || '';
      const old = previous.find(item => item.id === account.id);
      let service: string | undefined;
      if (password) {
        if (old?.proxy?.secretRef && await passwordFor(old) === password) {
          service = old.proxy.secretRef;
        } else {
          do {
            service = `${SECRET_PREFIX}${Date.now()}.${++revision}.${Math.random().toString(36).slice(2)}`;
          } while (await Keychain.getGenericPassword({service}));
          const saved = await Keychain.setGenericPassword(account.id, password, {
            service,
            accessible: Keychain.ACCESSIBLE.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
          });
          const verified = saved && await Keychain.getGenericPassword({service});
          if (!verified || verified.username !== account.id || verified.password !== password) {
            throw new Error('Proxy credential could not be verified in secure storage');
          }
        }
        retained.add(service);
      }
      const proxy = {...account.proxy};
      delete proxy.password;
      delete proxy.secretRef;
      account.proxy = service ? {...proxy, secretRef: service} : proxy;
    }
    // Never remove legacy plaintext or old secret revisions before this commit.
    // If persistence fails ambiguously, new revisions remain recoverable.
    await AsyncStorage.setItem(ACCOUNT_STORAGE_KEY, JSON.stringify(next));
    for (const old of previous) {
      const service = old.proxy?.secretRef;
      if (service && !retained.has(service)) {
        await Keychain.resetGenericPassword({service});
      }
    }
  });
  writes = operation.catch(() => {});
  return operation;
}
