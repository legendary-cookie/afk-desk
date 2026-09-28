import {AppState, NativeModules, PermissionsAndroid, Platform} from 'react-native';

const ACTIVE = new Set(['connecting', 'connected', 'online', 'reconnecting']);

export function createForegroundSessionSync() {
  let count = 0;
  let permissionRequested = false;
  let pending: Promise<void> = Promise.resolve();
  return (sessions: Record<string, {status: string}>): Promise<void> => {
    if (Platform.OS !== 'android') { return Promise.resolve(); }
    const next = Object.values(sessions).filter(session => ACTIVE.has(session.status)).length;
    pending = pending.catch(() => {}).then(async () => {
      if (next === count) { return; }
      const service = NativeModules.AfkForegroundService;
      if (!service?.setSessionCount) { throw new Error('Rebuild the Android app to enable connection background service support.'); }
      await service.setSessionCount(next);
      count = next;
      if (next > 0 && Number(Platform.Version) >= 33 && !permissionRequested && AppState.currentState === 'active') {
        permissionRequested = true;
        // Notification permission is not required to run the service. A pending
        // permission dialog must not hold up a later disconnect/stop update.
        PermissionsAndroid.check(PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS)
          .then(granted => {
            if (count === 0 || AppState.currentState !== 'active') {
              permissionRequested = false;
              return;
            }
            if (!granted) {
              return PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS, {
                title: 'Connection notifications',
                message: 'Show the number of active Minecraft connections while AFK Desk runs in the background.',
                buttonPositive: 'Continue',
                buttonNegative: 'Not now',
              });
            }
          }).catch(() => { permissionRequested = false; });
      }
    });
    return pending;
  };
}
export const syncForegroundSessions = createForegroundSessionSync();
