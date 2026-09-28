import {Alert, Linking} from 'react-native';
import {URL} from 'react-native-url-polyfill';

export function safeExternalUrl(value: string): string {
  if (typeof value !== 'string' || value.length > 4096 || !/^https?:\/\//i.test(value)
    || /[\s\\\u0000-\u001f\u007f]/.test(value)) throw new Error('Only valid HTTP or HTTPS links are allowed.');
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password) {
    throw new Error('Links containing credentials or non-web protocols are not allowed.');
  }
  return url.toString();
}

export async function openExternalUrl(value: string): Promise<void> {
  try { await Linking.openURL(safeExternalUrl(value)); }
  catch { Alert.alert('Link unavailable', 'This link is invalid or could not be opened safely.'); }
}

export function openMicrosoftSignIn(): Promise<void> {
  // Never trust a server/bridge-provided destination for account authentication.
  return openExternalUrl('https://microsoft.com/link');
}
