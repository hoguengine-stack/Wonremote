import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import * as commands from '../src/domain/remoteControlCommands.ts';
import * as input from '../src/domain/viewerInputState.ts';
import { requestFreshClipboardText } from '../src/domain/requestedClipboard.ts';

// Execute the actual React handlers with clipboard and transport spies.
const source = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
const keyboardEvent = source.slice(source.indexOf('type RemoteKeyboardEvent'), source.indexOf('function arrayBufferToBase64'));
const keys = source.slice(source.indexOf('  const commitImeBeforeRemoteKey ='), source.indexOf('  const handleImeCompositionStart ='));
const ime = source.slice(source.indexOf('  const handleImeCompositionStart ='), source.indexOf('  useEffect(() => {', source.indexOf('  const handleImeCompositionStart =')));
const clipboard = source.slice(source.indexOf('  const handleSendClipboard ='), source.indexOf('  // Files', source.indexOf('  const handleSendClipboard =')));
const events = [];
const transfers = [];
const clipboardWrites = [];
let clipboardSubscriptionOptions;
let clipboardSubscriptionStops = 0;
let reads = 0;
const context = vm.createContext({
  ...commands, ...input, isActive: true, remoteInputAvailable: true, isEditableTarget: () => false,
  pressedKeysRef: { current: new Map() }, suppressedKeyUpsRef: { current: new Set() },
  imeInputRef: { current: null }, isClipboardBusyRef: { current: false },
  clipboardRequestAbortRef: { current: null }, AbortController, DOMException,
  panelRef: { current: { focus() {} } },
  imeComposingRef: { current: false }, imeEnterCommittedRef: { current: false },
  imeCompositionValueRef: { current: '' }, suppressNextImeValueRef: { current: '' },
  activeSessionIdRef: { current: 'session' }, sessionId: 'session',
  onInputEvent: command => events.push(command),
  navigator: { clipboard: {
    readText: async () => { reads++; return 'LOCAL'; },
    writeText: async text => { clipboardWrites.push(text); },
  } },
  readClipboardPngBlob: async () => null,
  sendClipboardText: async (...args) => transfers.push(args),
  requestFreshClipboardText,
  subscribeSessionData: (_sessionId, onData, _onError, options, onReady) => {
    clipboardSubscriptionOptions = options;
    onData({ messages: [], clipboards: [{ sender: 'agent', text: 'STALE' }], files: [], receipts: [] });
    onReady();
    queueMicrotask(() => onData({ messages: [], clipboards: [{ sender: 'agent', text: 'REMOTE' }], files: [], receipts: [] }));
    return () => { clipboardSubscriptionStops += 1; };
  },
  alert: () => {}, console,
});
vm.runInContext(ts.transpile(`${keyboardEvent}\n${keys}\n${ime}\n${clipboard}\nglobalThis.handlers = { handleKeyDown, handleKeyUp, handleSendClipboard, handleFetchClipboard, handleImeCompositionStart, handleImeCompositionUpdate, handleImeCompositionEnd, handleImeInput };`), context);
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
for (const [code, shiftKey] of [['Enter', false], ['NumpadEnter', false], ['Enter', true]]) {
  events.length = 0;
  const shift = { ...event('Shift', 'ShiftLeft'), ctrlKey: false, shiftKey: true };
  if (shiftKey) await context.handlers.handleKeyDown(shift);
  const textarea = { value: '한', focus() {} };
  context.imeInputRef.current = textarea;
  context.handlers.handleImeCompositionStart();
  context.handlers.handleImeCompositionUpdate({ data: '하' });
  const enter = { ...event('Process', code), ctrlKey: false, shiftKey, keyCode: 229, nativeEvent: { isComposing: true } };
  await context.handlers.handleKeyDown(enter);
  context.handlers.handleKeyUp(enter);
  context.handlers.handleImeCompositionEnd({ data: '한', currentTarget: textarea });
  textarea.value = '한';
  context.handlers.handleImeInput({ currentTarget: textarea, nativeEvent: {} });
  if (shiftKey) context.handlers.handleKeyUp(shift);
  assert.deepEqual(events, [...(shiftKey ? ['key-down Shift'] : []), commands.buildReplaceUnicodeTextCommand(0, '하'), commands.buildReplaceUnicodeTextCommand(1, '한'), 'key-down Enter', 'key-up Enter', ...(shiftKey ? ['key-up Shift'] : [])]);
}
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
events.length = 0;
await context.handlers.handleFetchClipboard();
assert.deepEqual(events, ['clipboard-request']);
assert.deepEqual(clipboardWrites, ['REMOTE']);
assert.equal(clipboardSubscriptionOptions.chat, false);
assert.equal(clipboardSubscriptionOptions.files, false);
assert.equal(clipboardSubscriptionStops, 1);
assert.equal(context.isClipboardBusyRef.current, false);
assert.ok(!source.includes('isClipboardSyncOn'));
assert.ok(source.includes('{ clipboard: false }'));
assert.ok(!source.includes('window.setTimeout(resolve, 600)'));
assert.ok(!source.includes('fetchClipboardText(sessionId)'));
assert.ok(source.indexOf('aria-label="클립보드 동기화: 내 PC → 원격 PC"') < source.indexOf('data-testid="secondary-tools"'));
console.log('PASS: remote clipboard isolation; Enter/NumpadEnter/Shift+Enter follows final IME text without duplicate composition delivery.');
