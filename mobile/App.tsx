import React, {useCallback, useEffect, useRef, useState} from 'react';
import {
  Alert, FlatList, Image, Linking, Modal, Pressable, SafeAreaView, ScrollView,
  StatusBar, StyleSheet, Switch, Text, TextInput, View,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import nodejs from 'nodejs-mobile-react-native';

type ProxyConfig = {enabled: boolean; type: 'socks5' | 'http'; host: string; port: string; username: string; password: string};
type Account = {
  id: string; username: string; host: string; port: string; version: string; skinUrl?: string;
  antiAfk: boolean; antiAfkInterval: string; autoReconnect: boolean; autoReconnectDelay: string;
  autoReconnectMaxAttempts: string; connectOnStartup: boolean; joinMessage: string;
  serverChangeMessage: string; messageDelay: string; proxy: ProxyConfig;
};
type Segment = {text: string; color?: string; bold?: boolean; italic?: boolean; underlined?: boolean; strikethrough?: boolean};
type Log = {id: string; kind: string; message: string; at: number; segments?: Segment[]};
type Telemetry = {health: number; food: number; position: null | {x: number; y: number; z: number}; dimension: string; inventory: Array<{slot: number; displayName: string; count: number}>};
type Session = {status: string; detail: string; logs: Log[]; telemetry?: Telemetry};

const STORAGE_KEY = 'afkdesk.mobile.accounts.v1';
const EMPTY_PROXY: ProxyConfig = {enabled: false, type: 'socks5', host: '', port: '1080', username: '', password: ''};
const blankAccount = (): Account => ({
  id: `${Date.now()}-${Math.random().toString(16).slice(2)}`, username: '', host: '', port: '25565', version: '',
  antiAfk: true, antiAfkInterval: '45', autoReconnect: true, autoReconnectDelay: '5', autoReconnectMaxAttempts: '0',
  connectOnStartup: false, joinMessage: '', serverChangeMessage: '', messageDelay: '2', proxy: {...EMPTY_PROXY},
});

let engineStarted = false;
let requestSequence = 0;
const pending = new Map<number, {resolve: () => void; reject: (error: Error) => void}>();

function engineCommand(command: Record<string, unknown>) {
  const requestId = ++requestSequence;
  return new Promise<void>((resolve, reject) => {
    pending.set(requestId, {resolve, reject});
    nodejs.channel.post('engine-command', {requestId, ...command});
    setTimeout(() => {
      if (!pending.has(requestId)) return;
      pending.delete(requestId);
      reject(new Error('The on-device engine did not respond.'));
    }, 10000);
  });
}

function App(): React.JSX.Element {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [sessions, setSessions] = useState<Record<string, Session>>({});
  const [engineReady, setEngineReady] = useState(false);
  const [editing, setEditing] = useState<Account | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [chat, setChat] = useState('');
  const [loginCode, setLoginCode] = useState<{code: string; verificationUri?: string} | null>(null);
  const accountsRef = useRef(accounts);
  accountsRef.current = accounts;

  const selected = accounts.find(account => account.id === selectedId) || accounts[0];
  const session = selected ? sessions[selected.id] || {status: 'offline', detail: 'Not connected', logs: []} : undefined;

  const updateSession = useCallback((id: string, updater: (old: Session) => Session) => {
    setSessions(old => ({...old, [id]: updater(old[id] || {status: 'offline', detail: 'Not connected', logs: []})}));
  }, []);

  useEffect(() => {
    AsyncStorage.getItem(STORAGE_KEY).then(raw => {
      const restored: Account[] = raw ? JSON.parse(raw) : [];
      setAccounts(restored);
      if (restored[0]) setSelectedId(restored[0].id);
    }).catch(() => Alert.alert('Storage error', 'Saved accounts could not be loaded.'));
  }, []);

  useEffect(() => {
    const onReady = () => setEngineReady(true);
    const onReply = ({requestId, ok, error}: any) => {
      const waiter = pending.get(requestId);
      if (!waiter) return;
      pending.delete(requestId);
      ok ? waiter.resolve() : waiter.reject(new Error(error));
    };
    const onEvent = ({type, accountId, payload}: any) => {
      if (type === 'status') updateSession(accountId, old => ({...old, status: payload.status, detail: payload.detail}));
      if (type === 'log') updateSession(accountId, old => ({...old, logs: [...old.logs.slice(-499), {...payload, id: `${payload.at}-${Math.random()}`}]}));
      if (type === 'telemetry') updateSession(accountId, old => ({...old, telemetry: payload}));
      if (type === 'login-code') setLoginCode(payload);
      if (type === 'identity') {
        setAccounts(old => old.map(item => item.id === accountId ? {...item, username: payload.username || item.username, skinUrl: payload.skinUrl || item.skinUrl} : item));
      }
    };
    nodejs.channel.addListener('engine-ready', onReady);
    nodejs.channel.addListener('engine-reply', onReply);
    nodejs.channel.addListener('engine-event', onEvent);
    if (!engineStarted) {
      engineStarted = true;
      nodejs.start('main.js');
    }
    return () => {
      nodejs.channel.removeListener('engine-ready', onReady);
      nodejs.channel.removeListener('engine-reply', onReply);
      nodejs.channel.removeListener('engine-event', onEvent);
    };
  }, [updateSession]);

  useEffect(() => {
    if (accounts.length) AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(accounts)).catch(() => {});
  }, [accounts]);

  const autoConnected = useRef(false);
  useEffect(() => {
    if (!engineReady || autoConnected.current || !accounts.length) return;
    autoConnected.current = true;
    accounts.filter(account => account.connectOnStartup).forEach(account => {
      engineCommand({action: 'connect', account}).catch(error => Alert.alert('Auto-connect failed', error.message));
    });
  }, [accounts, engineReady]);

  const saveAccount = (account: Account) => {
    if (!account.username.trim() || !account.host.trim()) {
      Alert.alert('Missing details', 'Enter an account label/email and server address.');
      return;
    }
    setAccounts(old => old.some(item => item.id === account.id) ? old.map(item => item.id === account.id ? account : item) : [...old, account]);
    setSelectedId(account.id);
    setEditing(null);
  };

  const connect = async () => {
    if (!selected) return;
    try { await engineCommand({action: 'connect', account: selected}); }
    catch (error: any) { Alert.alert('Connection error', error.message); }
  };
  const disconnect = async () => {
    if (!selected) return;
    try { await engineCommand({action: 'disconnect', accountId: selected.id}); }
    catch (error: any) { Alert.alert('Disconnect error', error.message); }
  };
  const sendChat = async () => {
    const value = chat.trim();
    if (!selected || !value) return;
    setChat('');
    try { await engineCommand({action: 'chat', accountId: selected.id, value}); }
    catch (error: any) { Alert.alert('Cannot send', error.message); }
  };
  const action = (name: string, value?: string) => selected && engineCommand({action: name, accountId: selected.id, value}).catch((error: Error) => Alert.alert('Control unavailable', error.message));
  const reorder = (id: string, delta: number) => setAccounts(old => {
    const index = old.findIndex(item => item.id === id);
    const next = index + delta;
    if (index < 0 || next < 0 || next >= old.length) return old;
    const result = [...old];
    [result[index], result[next]] = [result[next], result[index]];
    return result;
  });

  return <SafeAreaView style={styles.safe}>
    <StatusBar barStyle="light-content" backgroundColor="#090c10" />
    <View style={styles.header}>
      <View><Text style={styles.brand}>AFK Desk</Text><Text style={styles.muted}>{engineReady ? 'On-device Minecraft client' : 'Starting engine…'}</Text></View>
      <Pressable style={styles.smallButton} onPress={() => setSettingsOpen(true)}><Text style={styles.buttonText}>Settings</Text></Pressable>
    </View>

    <View style={styles.accountStrip}>
      <FlatList horizontal data={accounts} keyExtractor={item => item.id} contentContainerStyle={styles.accountStripContent}
        renderItem={({item, index}) => <View style={[styles.accountCard, item.id === selected?.id && styles.accountCardSelected]}>
          <Pressable style={styles.accountSelect} onPress={() => setSelectedId(item.id)}>
            {item.skinUrl ? <Image source={{uri: item.skinUrl}} style={styles.avatar} /> : <View style={styles.avatarFallback}><Text style={styles.avatarLetter}>{item.username.slice(0, 1).toUpperCase()}</Text></View>}
            <View style={styles.accountCopy}><Text numberOfLines={1} style={styles.accountName}>{item.username}</Text><Text numberOfLines={1} style={styles.muted}>{item.host}</Text></View>
            <View style={[styles.dot, (sessions[item.id]?.status === 'online') && styles.dotOnline]} />
          </Pressable>
          <View style={styles.orderRow}>
            <Pressable disabled={index === 0} onPress={() => reorder(item.id, -1)}><Text style={styles.order}>‹</Text></Pressable>
            <Pressable disabled={index === accounts.length - 1} onPress={() => reorder(item.id, 1)}><Text style={styles.order}>›</Text></Pressable>
          </View>
        </View>} />
      <Pressable style={styles.addCard} onPress={() => setEditing(blankAccount())}><Text style={styles.addText}>＋</Text></Pressable>
    </View>

    {!selected ? <View style={styles.empty}><Text style={styles.title}>Add your first account</Text><Text style={styles.muted}>Microsoft sign-in opens in your browser and returns here.</Text><Pressable style={styles.primary} onPress={() => setEditing(blankAccount())}><Text style={styles.primaryText}>Add account</Text></Pressable></View> :
    <ScrollView style={styles.page} contentContainerStyle={styles.pageContent} keyboardShouldPersistTaps="handled">
      <View style={styles.titleRow}><View style={styles.flex}><Text style={styles.title}>{selected.username}</Text><Text style={styles.status}>{session?.status} · {session?.detail}</Text></View>
        <Pressable style={styles.smallButton} onPress={() => setEditing({...selected, proxy: {...selected.proxy}})}><Text style={styles.buttonText}>Edit</Text></Pressable>
        {session?.status === 'offline' ? <Pressable style={styles.primarySmall} onPress={connect}><Text style={styles.primaryText}>Connect</Text></Pressable> : <Pressable style={styles.dangerSmall} onPress={disconnect}><Text style={styles.dangerText}>Disconnect</Text></Pressable>}
      </View>

      <View style={styles.console}>
        <View style={styles.panelHeader}><Text style={styles.panelTitle}>Console</Text><Text style={styles.muted}>{selected.host}:{selected.port}</Text></View>
        <FlatList style={styles.logList} data={session?.logs || []} keyExtractor={item => item.id} initialNumToRender={30} maxToRenderPerBatch={30}
          ListEmptyComponent={<Text style={styles.emptyLog}>Messages will appear here.</Text>}
          renderItem={({item}) => <View style={styles.logLine}><Text style={styles.time}>{new Date(item.at).toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'})}</Text>
            <Text style={[styles.logText, item.kind === 'error' && styles.error, item.kind === 'sent' && styles.sent]}>{item.segments?.length ? item.segments.map((segment, i) => <Text key={i} style={{color: segment.color, fontWeight: segment.bold ? '800' : undefined, fontStyle: segment.italic ? 'italic' : undefined, textDecorationLine: segment.underlined ? 'underline' : segment.strikethrough ? 'line-through' : undefined}}>{segment.text}</Text>) : item.message}</Text>
          </View>} />
        <View style={styles.chatRow}><TextInput value={chat} onChangeText={setChat} onSubmitEditing={sendChat} placeholder="Message or /command" placeholderTextColor="#626d7b" style={styles.chatInput} /><Pressable style={styles.send} onPress={sendChat}><Text style={styles.buttonText}>Send</Text></Pressable></View>
      </View>

      <View style={styles.statsRow}>
        <Stat label="HP" value={`${session?.telemetry?.health ?? '—'} / 20`} />
        <Stat label="Food" value={`${session?.telemetry?.food ?? '—'} / 20`} />
        <Stat label="Coordinates" value={session?.telemetry?.position ? `${session.telemetry.position.x}, ${session.telemetry.position.y}, ${session.telemetry.position.z}` : '—'} wide />
      </View>

      <View style={styles.panel}><View style={styles.panelHeader}><Text style={styles.panelTitle}>Movement</Text><Text style={styles.muted}>Quick taps</Text></View>
        <View style={styles.moveGrid}><View /><Move label="W" onPress={() => action('move', 'forward')} /><View /><Move label="A" onPress={() => action('move', 'left')} /><Move label="S" onPress={() => action('move', 'back')} /><Move label="D" onPress={() => action('move', 'right')} /></View>
        <View style={styles.moveActions}><Move label="Jump" onPress={() => action('move', 'jump')} /><Move label="Look left" onPress={() => action('look', 'left')} /><Move label="Look right" onPress={() => action('look', 'right')} /></View>
      </View>

      <View style={styles.panel}><View style={styles.panelHeader}><Text style={styles.panelTitle}>Inventory</Text><Text style={styles.muted}>{session?.telemetry?.inventory?.length || 0} occupied slots</Text></View>
        <View style={styles.inventory}>{session?.telemetry?.inventory?.length ? session.telemetry.inventory.map(item => <View key={item.slot} style={styles.item}><Text numberOfLines={1} style={styles.itemName}>{item.displayName}</Text><Text style={styles.muted}>Slot {item.slot} · ×{item.count}</Text></View>) : <Text style={styles.emptyLog}>Connect to inspect inventory.</Text>}</View>
      </View>
    </ScrollView>}

    <AccountModal value={editing} onClose={() => setEditing(null)} onSave={saveAccount} onDelete={account => {
      engineCommand({action: 'disconnect', accountId: account.id}).catch(() => {});
      setAccounts(old => old.filter(item => item.id !== account.id)); setSelectedId(accounts.find(item => item.id !== account.id)?.id || ''); setEditing(null);
    }} />
    <SettingsModal visible={settingsOpen} accounts={accounts} onClose={() => setSettingsOpen(false)} onChange={setAccounts} />
    <Modal transparent visible={Boolean(loginCode)} animationType="fade"><View style={styles.backdrop}><View style={styles.modalCard}><Text style={styles.title}>Microsoft sign-in</Text><Text style={styles.modalHelp}>Open Microsoft, switch to the account you want, then enter this code:</Text><Text selectable style={styles.deviceCode}>{loginCode?.code}</Text><Pressable style={styles.primary} onPress={() => Linking.openURL(loginCode?.verificationUri || 'https://microsoft.com/link')}><Text style={styles.primaryText}>Open Microsoft sign-in</Text></Pressable><Pressable style={styles.modalButton} onPress={() => setLoginCode(null)}><Text style={styles.buttonText}>Close</Text></Pressable></View></View></Modal>
  </SafeAreaView>;
}

function Stat({label, value, wide}: {label: string; value: string; wide?: boolean}) { return <View style={[styles.stat, wide && styles.statWide]}><Text style={styles.muted}>{label}</Text><Text numberOfLines={1} style={styles.statValue}>{value}</Text></View>; }
function Move({label, onPress}: {label: string; onPress: () => void}) { return <Pressable style={styles.move} onPress={onPress}><Text style={styles.buttonText}>{label}</Text></Pressable>; }

function Field({label, value, onChange, secret, keyboardType}: any) { return <View style={styles.field}><Text style={styles.fieldLabel}>{label}</Text><TextInput value={value} onChangeText={onChange} secureTextEntry={secret} keyboardType={keyboardType} placeholderTextColor="#626d7b" style={styles.input} /></View>; }
function Toggle({label, value, onChange}: {label: string; value: boolean; onChange: (value: boolean) => void}) { return <View style={styles.toggleRow}><Text style={styles.toggleLabel}>{label}</Text><Switch value={value} onValueChange={onChange} trackColor={{false: '#364150', true: '#48bc7c'}} /></View>; }

function AccountModal({value, onClose, onSave, onDelete}: {value: Account | null; onClose: () => void; onSave: (value: Account) => void; onDelete: (value: Account) => void}) {
  const [draft, setDraft] = useState<Account | null>(value);
  useEffect(() => setDraft(value ? {...value, proxy: {...value.proxy}} : null), [value]);
  const set = (key: keyof Account, next: any) => draft && setDraft({...draft, [key]: next});
  const proxy = (key: keyof ProxyConfig, next: any) => draft && setDraft({...draft, proxy: {...draft.proxy, [key]: next}});
  return <Modal visible={Boolean(value && draft)} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
    {draft && <SafeAreaView style={styles.safe}><View style={styles.modalHeader}><Pressable onPress={onClose}><Text style={styles.link}>Cancel</Text></Pressable><Text style={styles.panelTitle}>Account setup</Text><Pressable onPress={() => onSave(draft)}><Text style={styles.link}>Save</Text></Pressable></View>
      <ScrollView contentContainerStyle={styles.form} keyboardShouldPersistTaps="handled">
        <Text style={styles.sectionTitle}>Connection</Text>
        <Field label="Account label or Microsoft email" value={draft.username} onChange={(v: string) => set('username', v)} />
        <Text style={styles.help}>After sign-in, the app automatically replaces this with the Minecraft IGN and head.</Text>
        <Field label="Server" value={draft.host} onChange={(v: string) => set('host', v)} />
        <Field label="Port" value={draft.port} onChange={(v: string) => set('port', v)} keyboardType="number-pad" />
        <Field label="Minecraft version (blank = auto)" value={draft.version} onChange={(v: string) => set('version', v)} />
        <Text style={styles.sectionTitle}>Automation</Text>
        <Toggle label="Join when the app starts" value={draft.connectOnStartup} onChange={v => set('connectOnStartup', v)} />
        <Toggle label="Auto reconnect" value={draft.autoReconnect} onChange={v => set('autoReconnect', v)} />
        <Field label="Reconnect delay (seconds)" value={draft.autoReconnectDelay} onChange={(v: string) => set('autoReconnectDelay', v)} keyboardType="number-pad" />
        <Field label="Maximum attempts (0 = unlimited)" value={draft.autoReconnectMaxAttempts} onChange={(v: string) => set('autoReconnectMaxAttempts', v)} keyboardType="number-pad" />
        <Toggle label="Anti-AFK movement" value={draft.antiAfk} onChange={v => set('antiAfk', v)} />
        <Field label="Anti-AFK interval (seconds)" value={draft.antiAfkInterval} onChange={(v: string) => set('antiAfkInterval', v)} keyboardType="number-pad" />
        <Field label="Message after joining" value={draft.joinMessage} onChange={(v: string) => set('joinMessage', v)} />
        <Field label="Message after changing servers" value={draft.serverChangeMessage} onChange={(v: string) => set('serverChangeMessage', v)} />
        <Field label="Automatic message delay (seconds)" value={draft.messageDelay} onChange={(v: string) => set('messageDelay', v)} keyboardType="number-pad" />
        <Text style={styles.sectionTitle}>Proxy</Text>
        <Toggle label="Use a proxy for this account" value={draft.proxy.enabled} onChange={v => proxy('enabled', v)} />
        {draft.proxy.enabled && <><View style={styles.segmented}><Pressable style={[styles.segment, draft.proxy.type === 'socks5' && styles.segmentSelected]} onPress={() => proxy('type', 'socks5')}><Text style={styles.buttonText}>SOCKS5</Text></Pressable><Pressable style={[styles.segment, draft.proxy.type === 'http' && styles.segmentSelected]} onPress={() => proxy('type', 'http')}><Text style={styles.buttonText}>HTTP</Text></Pressable></View>
          <Field label="Proxy host" value={draft.proxy.host} onChange={(v: string) => proxy('host', v)} /><Field label="Proxy port" value={draft.proxy.port} onChange={(v: string) => proxy('port', v)} keyboardType="number-pad" /><Field label="Proxy username (optional)" value={draft.proxy.username} onChange={(v: string) => proxy('username', v)} /><Field label="Proxy password (optional)" secret value={draft.proxy.password} onChange={(v: string) => proxy('password', v)} /></>}
        {value && <Pressable style={styles.deleteButton} onPress={() => Alert.alert('Delete account?', 'This removes its local settings.', [{text: 'Cancel'}, {text: 'Delete', style: 'destructive', onPress: () => onDelete(draft)}])}><Text style={styles.dangerText}>Delete account</Text></Pressable>}
      </ScrollView></SafeAreaView>}
  </Modal>;
}

function SettingsModal({visible, accounts, onClose, onChange}: {visible: boolean; accounts: Account[]; onClose: () => void; onChange: (accounts: Account[]) => void}) {
  const allStartup = accounts.length > 0 && accounts.every(account => account.connectOnStartup);
  return <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}><SafeAreaView style={styles.safe}><View style={styles.modalHeader}><Text style={styles.panelTitle}>Settings</Text><Pressable onPress={onClose}><Text style={styles.link}>Done</Text></Pressable></View><View style={styles.form}>
    <Text style={styles.sectionTitle}>Startup</Text><Toggle label="Connect every account on app start" value={allStartup} onChange={value => onChange(accounts.map(account => ({...account, connectOnStartup: value})))} />
    <Text style={styles.sectionTitle}>Background operation</Text><Text style={styles.help}>Android keeps the AFK engine in a foreground service with a persistent notification. iOS can maintain sessions while open, but the operating system may suspend network connections in the background.</Text>
    <Text style={styles.sectionTitle}>Privacy</Text><Text style={styles.help}>Microsoft passwords are never requested or saved. Authentication tokens and account settings stay in this app's private storage.</Text>
  </View></SafeAreaView></Modal>;
}

const styles = StyleSheet.create({
  safe: {flex: 1, backgroundColor: '#090c10'}, flex: {flex: 1}, header: {height: 66, paddingHorizontal: 16, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', borderBottomWidth: 1, borderColor: '#252d38'}, brand: {fontSize: 20, fontWeight: '800', color: '#f4f6f8'}, muted: {fontSize: 11, color: '#8f9baa'},
  accountStrip: {height: 84, flexDirection: 'row', borderBottomWidth: 1, borderColor: '#252d38'}, accountStripContent: {padding: 8, gap: 7}, accountCard: {width: 190, flexDirection: 'row', borderRadius: 8, borderWidth: 1, borderColor: '#252d38', backgroundColor: '#11161e'}, accountCardSelected: {borderColor: '#60d394', backgroundColor: '#161c25'}, accountSelect: {flex: 1, minWidth: 0, padding: 8, flexDirection: 'row', alignItems: 'center', gap: 8}, accountCopy: {flex: 1, minWidth: 0}, accountName: {fontWeight: '700', fontSize: 12, color: '#f4f6f8'}, avatar: {width: 36, height: 36, borderRadius: 6}, avatarFallback: {width: 36, height: 36, borderRadius: 6, backgroundColor: '#202833', alignItems: 'center', justifyContent: 'center'}, avatarLetter: {fontWeight: '800', color: '#f4f6f8'}, dot: {width: 7, height: 7, borderRadius: 4, backgroundColor: '#626d7b'}, dotOnline: {backgroundColor: '#60d394'}, orderRow: {width: 24, justifyContent: 'space-evenly', alignItems: 'center', borderLeftWidth: 1, borderColor: '#252d38'}, order: {fontSize: 22, color: '#8f9baa'}, addCard: {width: 52, margin: 8, marginLeft: 0, borderRadius: 8, borderWidth: 1, borderStyle: 'dashed', borderColor: '#364150', alignItems: 'center', justifyContent: 'center'}, addText: {fontSize: 26, color: '#60d394'},
  page: {flex: 1}, pageContent: {padding: 14, gap: 14, paddingBottom: 36}, empty: {flex: 1, alignItems: 'center', justifyContent: 'center', padding: 30, gap: 14}, titleRow: {flexDirection: 'row', alignItems: 'center', gap: 8}, title: {fontSize: 23, fontWeight: '800', color: '#f4f6f8'}, status: {marginTop: 3, color: '#8f9baa', fontSize: 11, textTransform: 'capitalize'}, smallButton: {height: 38, paddingHorizontal: 13, borderRadius: 7, backgroundColor: '#161c25', borderWidth: 1, borderColor: '#364150', alignItems: 'center', justifyContent: 'center'}, primarySmall: {height: 38, paddingHorizontal: 13, borderRadius: 7, backgroundColor: '#60d394', alignItems: 'center', justifyContent: 'center'}, dangerSmall: {height: 38, paddingHorizontal: 13, borderRadius: 7, borderWidth: 1, borderColor: '#7a4045', alignItems: 'center', justifyContent: 'center'}, buttonText: {color: '#f4f6f8', fontWeight: '700', fontSize: 12}, primaryText: {color: '#06120c', fontWeight: '800'}, dangerText: {color: '#f16e74', fontWeight: '700'},
  panel: {borderWidth: 1, borderColor: '#252d38', borderRadius: 10, overflow: 'hidden', backgroundColor: '#11161e'}, console: {height: 440, borderWidth: 1, borderColor: '#252d38', borderRadius: 10, overflow: 'hidden', backgroundColor: '#11161e'}, panelHeader: {minHeight: 52, paddingHorizontal: 13, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', borderBottomWidth: 1, borderColor: '#252d38'}, panelTitle: {fontSize: 14, fontWeight: '800', color: '#f4f6f8'}, logList: {flex: 1, paddingHorizontal: 12}, emptyLog: {padding: 18, color: '#626d7b', textAlign: 'center'}, logLine: {flexDirection: 'row', gap: 8, paddingVertical: 4}, time: {width: 54, color: '#626d7b', fontSize: 10}, logText: {flex: 1, color: '#c5cbd3', fontSize: 11, fontFamily: 'monospace'}, error: {color: '#ff9da2'}, sent: {color: '#8ee7b5'}, chatRow: {height: 56, padding: 8, gap: 8, flexDirection: 'row', borderTopWidth: 1, borderColor: '#252d38'}, chatInput: {flex: 1, paddingHorizontal: 11, borderWidth: 1, borderColor: '#364150', borderRadius: 7, backgroundColor: '#0c1016', color: '#f4f6f8'}, send: {width: 62, borderRadius: 7, backgroundColor: '#161c25', alignItems: 'center', justifyContent: 'center'},
  statsRow: {flexDirection: 'row', flexWrap: 'wrap', gap: 8}, stat: {minWidth: 90, flexGrow: 1, padding: 12, borderRadius: 8, borderWidth: 1, borderColor: '#252d38', backgroundColor: '#11161e'}, statWide: {minWidth: 180}, statValue: {marginTop: 4, color: '#f4f6f8', fontSize: 13, fontWeight: '700'}, moveGrid: {width: 176, alignSelf: 'center', paddingVertical: 18, flexDirection: 'row', flexWrap: 'wrap', gap: 6}, move: {width: 54, height: 46, borderRadius: 7, borderWidth: 1, borderColor: '#364150', backgroundColor: '#161c25', alignItems: 'center', justifyContent: 'center'}, moveActions: {padding: 12, paddingTop: 0, flexDirection: 'row', justifyContent: 'center', gap: 7}, inventory: {padding: 10, flexDirection: 'row', flexWrap: 'wrap', gap: 7}, item: {width: '48%', padding: 9, borderRadius: 7, backgroundColor: '#0c1016', borderWidth: 1, borderColor: '#252d38'}, itemName: {fontSize: 11, color: '#f4f6f8', fontWeight: '700'},
  backdrop: {flex: 1, padding: 24, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(3,5,8,.82)'}, modalCard: {width: '100%', maxWidth: 440, padding: 22, gap: 14, borderRadius: 12, backgroundColor: '#11161e', borderWidth: 1, borderColor: '#364150'}, modalHelp: {color: '#8f9baa', lineHeight: 20}, deviceCode: {padding: 16, borderRadius: 8, backgroundColor: '#090c10', color: '#f4f6f8', fontSize: 28, fontWeight: '800', letterSpacing: 3, textAlign: 'center'}, primary: {minHeight: 46, paddingHorizontal: 16, borderRadius: 7, backgroundColor: '#60d394', alignItems: 'center', justifyContent: 'center'}, modalButton: {minHeight: 44, borderRadius: 7, backgroundColor: '#161c25', alignItems: 'center', justifyContent: 'center'}, modalHeader: {height: 58, paddingHorizontal: 16, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', borderBottomWidth: 1, borderColor: '#252d38'}, link: {color: '#60d394', fontWeight: '700'},
  form: {padding: 18, gap: 12}, sectionTitle: {marginTop: 8, paddingBottom: 6, borderBottomWidth: 1, borderColor: '#252d38', color: '#f4f6f8', fontSize: 14, fontWeight: '800'}, field: {gap: 6}, fieldLabel: {fontSize: 11, fontWeight: '700', color: '#c8cdd4'}, input: {height: 44, paddingHorizontal: 11, borderRadius: 7, borderWidth: 1, borderColor: '#364150', backgroundColor: '#0c1016', color: '#f4f6f8'}, help: {color: '#8f9baa', fontSize: 11, lineHeight: 17}, toggleRow: {minHeight: 46, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between'}, toggleLabel: {flex: 1, color: '#f4f6f8', fontWeight: '600'}, segmented: {height: 42, flexDirection: 'row', padding: 3, borderRadius: 8, backgroundColor: '#0c1016'}, segment: {flex: 1, alignItems: 'center', justifyContent: 'center', borderRadius: 6}, segmentSelected: {backgroundColor: '#364150'}, deleteButton: {height: 46, marginTop: 14, borderRadius: 7, borderWidth: 1, borderColor: '#7a4045', alignItems: 'center', justifyContent: 'center'},
});

export default App;
