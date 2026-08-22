import fs from 'node:fs';
import path from 'node:path';
import {expect, it} from '@jest/globals';

it('ships the standalone mobile controls and a fixed scrolling chat viewport', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'App.tsx'), 'utf8');
  expect(source).toContain('Microsoft sign-in');
  expect(source).toContain('Auto reconnect');
  expect(source).toContain('Message after changing servers');
  expect(source).toContain('Inventory');
  expect(source).toContain('Auto-deposit inventory');
  expect(source).toContain('Auto-deposit range (1–16 blocks)');
  expect(source).toContain('Nearest container');
  expect(source).toContain('AFK Desk 0.8.2');
  expect(source).toContain('console: {height: 440');
  expect(source).toContain('<FlatList style={styles.logList}');
});
