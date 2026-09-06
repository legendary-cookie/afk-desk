import {afterEach, expect, jest, test} from '@jest/globals';
import {Alert, Linking} from 'react-native';
import {openExternalUrl, openMicrosoftSignIn, safeExternalUrl} from '../external-links';

afterEach(() => { jest.restoreAllMocks(); });
test.each(['javascript:alert(1)', 'file:///data/secret', 'intent://anything', 'https://user:pass@example.com', 'https://', 'https:\\example.com', 'https://example.com\n.evil', '//example.com'])('rejects unsafe external destination %s', async value => {
  const open = jest.spyOn(Linking, 'openURL').mockResolvedValue(undefined);
  const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  await openExternalUrl(value);
  expect(open).not.toHaveBeenCalled();
  expect(alert).toHaveBeenCalled();
});
test('normal web links open and native failures are caught', async () => {
  expect(safeExternalUrl('https://example.com/a?x=1')).toBe('https://example.com/a?x=1');
  const open = jest.spyOn(Linking, 'openURL').mockRejectedValueOnce(new Error('no browser'));
  const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  await expect(openExternalUrl('http://example.com')).resolves.toBeUndefined();
  expect(open).toHaveBeenCalledWith('http://example.com/');
  expect(alert).toHaveBeenCalled();
});
test('Microsoft sign-in uses only the fixed HTTPS destination', async () => {
  const open = jest.spyOn(Linking, 'openURL').mockResolvedValue(undefined);
  await openMicrosoftSignIn();
  expect(open).toHaveBeenCalledWith('https://microsoft.com/link');
});
