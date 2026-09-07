import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import * as commands from '../src/domain/remoteControlCommands.ts';
import * as input from '../src/domain/viewerInputState.ts';

// Execute the actual React handlers with clipboard and transport spies.
const source = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
const keys = source.slice(source.indexOf('  const handleKeyDown = async'), source.indexOf('  const handleImeCompositionStart ='));
const clipboard = source.slice(source.indexOf('  const handleSendClipboard ='), source.indexOf('  // Files', source.indexOf('  const handleSendClipboard =')));
const events = [];
const transfers = [];
let reads = 0;
const context = vm.createContext({
  ...commands, ...input, isActive: true, isEditableTarget: () => false,
  pressedKeysRef: { current: new Map() }, suppressedKeyUpsRef: { current: new Set() },
  imeInputRef: { current: null }, isClipboardBusyRef: { current: false },
  activeSessionIdRef: { current: 'session' }, sessionId: 'session',
  onInputEvent: command => events.push(command),
  navigator: { clipboard: { readText: async () => { reads++; return 'LOCAL'; } } },
  readClipboardPngBlob: async () => null,
  sendClipboardText: async (...args) => transfers.push(args),
  alert: () => {}, console,
});
vm.runInContext(ts.transpile(`${keys}\n${clipboard}\nglobalThis.handlers = { handleKeyDown, handleKeyUp, handleSendClipboard };`), context);
const event = (key, code) => ({ key, code, ctrlKey: true, nativeEvent: {}, preventDefault() {} });
for (const letter of ['c', 'v']) {
  await context.handlers.handleKeyDown(event('Control', 'ControlLeft'));
  await context.handlers.handleKeyDown(event(letter, `Key${letter.toUpperCase()}`));
  context.handlers.handleKeyUp(event(letter, `Key${letter.toUpperCase()}`));
  context.handlers.handleKeyUp(event('Control', 'ControlLeft'));
}
assert.equal(reads, 0);
assert.equal(transfers.length, 0);
assert.deepEqual(events, ['key-down Ctrl','key-down C','key-up C','key-up Ctrl','key-down Ctrl','key-down V','key-up V','key-up Ctrl']);
await context.handlers.handleSendClipboard();
assert.equal(reads, 1);
assert.deepEqual(transfers, [['session','LOCAL','viewer']]);
let releaseRead;
context.navigator.clipboard.readText = () => new Promise(resolve => { releaseRead = resolve; });
const pending = context.handlers.handleSendClipboard();
await Promise.resolve();
await Promise.resolve();
await context.handlers.handleSendClipboard();
context.activeSessionIdRef.current = null;
releaseRead('LATE');
await pending;
assert.equal(transfers.length, 1);
assert.equal(context.isClipboardBusyRef.current, false);
context.activeSessionIdRef.current = 'session';
context.navigator.clipboard.readText = async () => { throw new Error('denied'); };
await context.handlers.handleSendClipboard();
assert.equal(transfers.length, 1);
assert.equal(context.isClipboardBusyRef.current, false);
assert.ok(!source.includes('isClipboardSyncOn'));
assert.ok(source.includes('{ clipboard: false }'));
assert.ok(source.indexOf('aria-label="클립보드 동기화: 내 PC → 원격 PC"') < source.indexOf('data-testid="secondary-tools"'));
console.log('PASS: actual Ctrl+C/V handlers send remote key down/up without local clipboard access; explicit send transfers once; automatic sync removed.');
