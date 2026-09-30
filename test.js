'use strict';
// Node 内置测试框架运行：node --test
// 从 index.html 提取 CORE-BEGIN/END 之间的核心逻辑（无 DOM 依赖），
// 在 vm 沙箱中注入可替换的 Mock 文件句柄与内存草稿存储进行测试。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { webcrypto } = require('node:crypto');
const { TextEncoder } = require('node:util');

const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
const m = html.match(/\/\* == CORE-BEGIN == \*\/([\s\S]*?)\/\* == CORE-END == \*\//);
assert.ok(m, 'index.html 中应存在 CORE-BEGIN/END 标记');

function createDrafts() {
  const rows = new Map();
  return {
    _rows: rows,
    put: async (rec) => { rows.set(rec.id, { ...rec }); },
    get: async (id) => (rows.has(id) ? { ...rows.get(id) } : undefined),
    all: async () => [...rows.values()].map((r) => ({ ...r })),
    delete: async (id) => { rows.delete(id); },
  };
}

function AbortError() { const e = new Error('The user aborted a request.'); e.name = 'AbortError'; return e; }
function NotAllowedError(msg) { const e = new Error(msg || 'Permission denied'); e.name = 'NotAllowedError'; return e; }

/* ---- 可操纵的 Mock 文件句柄：撤权 / 外部改写 / 阻塞式迟到读取 / 阻塞式写入 ---- */
class MockHandle {
  constructor(file) {
    this.file = file;
    this.name = file.name;
    this.uid = file.uid;
    this.revoked = false;
  }
  async isSameEntry(other) { return other && other.uid === this.uid; }
  async getFile() {
    return { name: this.file.name, text: async () => this.file.content };
  }
  async createWritable() {
    // gate 代表写操作整体（含核心层“锁内重读 → 比对 → 写”）的挂起点
    if (this.file.writeGate) await this.file.writeGate.promise;
    if (this.file.writeError) throw this.file.writeError;
    return {
      write: async (data) => {
        if (this.revoked) throw NotAllowedError('write after revocation');
        if (this.file.writeError) throw this.file.writeError;
        this.file.writes.push(data);
        this.file.content = data;
      },
      close: async () => { this.file.closed = true; },
      abort: async () => { this.file.aborted = true; },
    };
  }
}

function createMockFs() {
  const files = new Map(); // uid -> {uid,name,content,permission,writes,revokeAtWrite}
  let uidSeq = 0;

  function createFile(name, content) {
    const f = {
      uid: 'f' + (++uidSeq), name, content,
      permission: 'granted', writes: [], readGate: null,
    };
    files.set(f.uid, f);
    return f;
  }

  function adapter() {
    let nextHandle = null;
    let nextSaveHandle = null;
    let pickAbort = false, saveAbort = false;
    let prepareGate = null;       // {uid, gate}：写锁内“重读 → 比对”在该文件上挂起
    return {
      supported: () => true,

      /* 测试操纵点 */
      _files: files,
      handle(f) { return new MockHandle(f); },
      setNextPick(f, { abort = false } = {}) { nextHandle = f; pickAbort = abort; },
      setNextSave(f, { abort = false } = {}) { nextSaveHandle = f; saveAbort = abort; },
      setPrepareGate(f, g) { prepareGate = g ? { uid: f.uid, gate: g } : null; },

      async open() {
        if (pickAbort) { pickAbort = false; throw AbortError(); }
        const f = nextHandle; nextHandle = null;
        return new MockHandle(f);
      },
      async saveAs() {
        if (saveAbort) { saveAbort = false; throw AbortError(); }
        const f = nextSaveHandle; nextSaveHandle = null;
        return new MockHandle(f);
      },
      async read(handle) {
        if (prepareGate && prepareGate.uid === handle.file.uid) await prepareGate.gate.promise;
        if (handle.file.readGate) await handle.file.readGate.promise;
        return handle.file.content;
      },
      async write(handle, text) {
        const w = await handle.createWritable();
        await w.write(text);
        await w.close();
      },
      async queryPermission(handle, mode) {
        if (handle.revoked || handle.file.permission === 'denied') return 'denied';
        return handle.file.permission === 'prompt' ? 'prompt' : 'granted';
      },
      async requestPermission(handle, mode) {
        if (handle.revoked) return 'denied';
        return handle.file.permission === 'denied' ? 'denied' : 'granted';
      },
      download() { throw new Error('FS 适配器下不应调用 download'); },
    };
  }

  return { createFile, adapter };
}

function gate() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

/* ---- 构造沙箱与控制器 ---- */
function buildEnv() {
  const sandbox = {
    crypto: webcrypto,
    TextEncoder,
    setTimeout, clearTimeout,
    console,
    Promise, Error, Object, Array, String, Number, Math, Date, JSON,
    globalThis: undefined,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(m[1], sandbox, { filename: 'core.js' });
  return sandbox.MDE;
}

const MDE = buildEnv();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function makeHarness(extra = {}) {
  const fsMock = createMockFs();
  const drafts = createDrafts();
  let now = 1_700_000_000_000;
  const adapter = fsMock.adapter();
  const ctrl = MDE.createController({
    adapter, drafts,
    debounceMs: extra.debounceMs ?? 10,
    clock: () => now,
  });
  const events = [];
  ctrl.subscribe((s) => { events.push(s.code); });
  const tick = async (ms = 30) => { now += ms; await sleep(ms); };
  return { ctrl, adapter, drafts, fs: fsMock, events, tick, now: () => now };
}

async function openFresh(h, name = 'notes.md', content = '原始内容 v1\n') {
  const f = h.fs.createFile(name, content);
  h.adapter.setNextPick(f);
  await h.ctrl.openFile();
  return f;
}

test('1. 打开 → 编辑 → 保存：干净时无草稿，保存后基线更新', async () => {
  const h = makeHarness();
  await h.ctrl.init();
  const f = await openFresh(h);
  h.ctrl.setText('原始内容 v1\n加上编辑\n');
  await h.tick();
  assert.equal(h.drafts._rows.size, 1, '脏状态下应保留草稿');

  await h.ctrl.save();
  assert.equal(h.events.at(-1), 'saved');
  assert.equal(f.content, '原始内容 v1\n加上编辑\n');
  assert.equal(f.writes.length, 1);
  assert.equal(h.drafts._rows.size, 0, '保存成功后应删除草稿');
  const st = h.ctrl.getState();
  assert.equal(st.session.dirty, false);
  assert.equal(st.session.baseDigest, await MDE.sha256(f.content));
});

test('2. 外部改写后保存：写入被暂停，弹出磁盘版/草稿版对比，磁盘未被写', async () => {
  const h = makeHarness();
  await h.ctrl.init();
  const f = await openFresh(h);
  h.ctrl.setText('原始内容 v1\n加上编辑\n');
  await h.tick();

  f.content = '别人在磁盘上写的 v2\n';        // 外部改写
  await h.ctrl.save();

  assert.equal(h.events.at(-1), 'conflict');
  assert.equal(f.content, '别人在磁盘上写的 v2\n', '冲突时不得写入');
  assert.equal(f.writes.length, 0);
  const st = h.ctrl.getState();
  assert.ok(st.conflict, '应处于冲突状态');
  assert.equal(st.conflict.diskText, '别人在磁盘上写的 v2\n');
  assert.equal(st.saving, false);
  assert.equal(h.drafts._rows.size, 1, '冲突期间草稿必须保留');
  assert.equal(h.drafts._rows.values().next().value.draftText, '原始内容 v1\n加上编辑\n');
  assert.equal(h.drafts._rows.values().next().value.baseDigest,
    await MDE.sha256('原始内容 v1\n'), '草稿记录应标明它所属的文件版本（基线摘要）');
});

test('3a. 冲突解决：用磁盘版替换草稿 → 基线更新、草稿删除、不写入', async () => {
  const h = makeHarness();
  await h.ctrl.init();
  const f = await openFresh(h);
  h.ctrl.setText('我的编辑\n');
  f.content = '磁盘 v2\n';
  await h.ctrl.save();
  assert.ok(h.ctrl.getState().conflict);

  await h.ctrl.resolveConflict('use-disk');
  assert.equal(h.ctrl.getState().status.code, 'loaded-disk');
  assert.equal(h.ctrl.getState().session.draftText, '磁盘 v2\n');
  assert.equal(h.ctrl.getState().session.dirty, false);
  assert.equal(f.writes.length, 0);
  assert.equal(h.drafts._rows.size, 0);
});

test('3b. 冲突解决：仍用草稿覆盖 → 写回磁盘；弹窗期间再次外部改写则要求重新确认', async () => {
  const h = makeHarness();
  await h.ctrl.init();
  const f = await openFresh(h);
  h.ctrl.setText('我的编辑\n');
  f.content = '磁盘 v2\n';
  await h.ctrl.save();

  // 弹窗还开着，磁盘又变了
  f.content = '磁盘 v3（又来了一次外部修改）\n';
  await h.ctrl.resolveConflict('overwrite');
  assert.equal(h.events.at(-1), 'conflict', '磁盘再变应刷新冲突而非写入');
  assert.equal(f.writes.length, 0);
  assert.equal(h.ctrl.getState().conflict.diskText, '磁盘 v3（又来了一次外部修改）\n');

  await h.ctrl.resolveConflict('overwrite');
  assert.equal(h.events.at(-1), 'saved');
  assert.equal(f.content, '我的编辑\n');
});

test('3c. 冲突解决：取消保存 → 草稿保留、磁盘不变；之后可再次保存重新比对', async () => {
  const h = makeHarness();
  await h.ctrl.init();
  const f = await openFresh(h);
  h.ctrl.setText('我的编辑\n');
  f.content = '磁盘 v2\n';
  await h.ctrl.save();

  await h.ctrl.resolveConflict('cancel');
  assert.equal(h.ctrl.getState().status.code, 'save-cancelled');
  assert.equal(h.ctrl.getState().conflict, null);
  assert.equal(h.drafts._rows.size, 1);

  // 外部把磁盘改回与基线一致后，再次保存应成功
  f.content = '原始内容 v1\n';
  await h.ctrl.save();
  assert.equal(h.events.at(-1), 'saved');
  assert.equal(f.content, '我的编辑\n');
});

test('3d. 冲突解决：另存为 → 写到新文件，原磁盘文件不动，草稿迁移删除', async () => {
  const h = makeHarness();
  await h.ctrl.init();
  const f = await openFresh(h, 'old.md');
  h.ctrl.setText('我的编辑\n');
  f.content = '磁盘 v2\n';
  await h.ctrl.save();

  const f2 = h.fs.createFile('new.md', '');
  h.adapter.setNextSave(f2);
  await h.ctrl.resolveConflict('saveas');
  assert.equal(h.events.at(-1), 'saved-as');
  assert.equal(f2.content, '我的编辑\n');
  assert.equal(f.content, '磁盘 v2\n', '原文件必须保持未改动');
  assert.equal(h.drafts._rows.size, 0);
  const st = h.ctrl.getState();
  assert.equal(st.session.name, 'new.md');
});

test('4. 授权撤销后保存：不写入，草稿保留；重新授权后磁盘较新也不自动覆盖', async () => {
  const h = makeHarness();
  await h.ctrl.init();
  const f = await openFresh(h);
  h.ctrl.setText('我的编辑\n');
  await h.tick();

  f.permission = 'denied';                       // 权限丢失
  f.content = '磁盘上的新版本\n';
  await h.ctrl.save();

  assert.equal(h.events.at(-1), 'permission-denied');
  assert.equal(f.writes.length, 0);
  assert.equal(h.drafts._rows.size, 1, '撤权后草稿仍保留');
  assert.equal(h.ctrl.getState().saving, false);

  // 权限恢复（模拟重新授权），但磁盘比基线新
  f.permission = 'granted';
  const ok = await h.ctrl.reauthorize();
  assert.equal(ok, true);
  assert.equal(h.events.at(-1), 'reauth-disk-newer', '重新授权只读取比对，绝不自动写入');
  assert.equal(f.content, '磁盘上的新版本\n');
  assert.equal(f.writes.length, 0);

  // 用户明确发起保存 → 走冲突流程，依旧不直接写
  await h.ctrl.save();
  assert.equal(h.events.at(-1), 'conflict');
  assert.equal(f.writes.length, 0);

  // 用户明确选择覆盖才写入
  await h.ctrl.resolveConflict('overwrite');
  assert.equal(f.content, '我的编辑\n');
});

test('5. 迟到读取：保存 A 被阻塞期间发起保存 B；A 迟到后不弹窗、不写入', async () => {
  const h = makeHarness();
  await h.ctrl.init();
  const f = await openFresh(h);
  h.ctrl.setText('编辑 A\n');
  const g = gate();
  f.readGate = g;                               // 保存 A 的读取挂起

  const pA = h.ctrl.save();
  await h.tick(5);
  assert.equal(h.ctrl.getState().saving, true);

  // 外部改写，同时用户又发起保存 B（A 仍挂着）
  f.content = '外部改写 v2\n';
  h.ctrl.setText('编辑 A + 更多\n');
  const pB = h.ctrl.save();                    // token 递增，A 已作废
  await h.tick(5);
  assert.equal(g === f.readGate, true);

  g.resolve();                                  // A 的读取迟到返回
  await pA;
  // A 拿到的是放行后的当前内容（v2），但 token 过期 → 静默丢弃：不得写盘
  assert.equal(f.writes.length, 0);
  assert.equal(h.ctrl.getState().saving, true, 'B 仍在进行中');

  // B 的读取返回（此时已无 gate，内容为 v2）→ 与基线不同 → 冲突
  await pB;
  assert.equal(h.events.at(-1), 'conflict');
  assert.equal(h.ctrl.getState().conflict.diskDigest, await MDE.sha256('外部改写 v2\n'));
});

test('6. 写入失败（含撤销后写入）：错误透出，草稿保留，可重试', async () => {
  const h = makeHarness();
  await h.ctrl.init();
  const f = await openFresh(h);
  h.ctrl.setText('我的编辑\n');

  f.writeError = (() => { const e = new Error('disk full'); e.name = 'IOError'; return e; })();
  await h.ctrl.save();
  assert.equal(h.events.at(-1), 'write-failed');
  assert.equal(h.drafts._rows.size, 1);
  assert.equal(h.ctrl.getState().saving, false);

  f.writeError = null;
  await h.ctrl.save();
  assert.equal(h.events.at(-1), 'saved', '磁盘未变时修复后重试应成功');
  assert.equal(f.content, '我的编辑\n');
  assert.equal(h.drafts._rows.size, 0);
});

test('7. 跨“重启”恢复：句柄与草稿存入存储；恢复时磁盘较新会明确标注', async () => {
  const h = makeHarness();
  await h.ctrl.init();
  const f = await openFresh(h, 'recover.md', '打开时内容\n');
  h.ctrl.setText('打开时内容\n未保存编辑\n');
  await h.tick();
  await h.ctrl._persistNow();
  const id = h.ctrl.getState().session.id;
  const rec = await h.drafts.get(id);
  assert.ok(rec.handle, '草稿应带文件句柄（浏览器中即 FileSystemFileHandle）');
  assert.equal(rec.baseDigest, await MDE.sha256('打开时内容\n'));

  // 模拟新页面：同一磁盘文件的新句柄
  const h2 = makeHarness();
  for (const [k, v] of h.drafts._rows) h2.drafts._rows.set(k, v);
  await h2.ctrl.init();

  f.content = '别人保存的新内容\n';
  const rec2 = await h2.ctrl.restore(id);
  assert.ok(rec2);
  assert.equal(h2.events.at(-1), 'restored-disk-newer');
  const st = h2.ctrl.getState();
  assert.equal(st.session.draftText, '打开时内容\n未保存编辑\n');
  assert.equal(st.session.diskDigest, await MDE.sha256('别人保存的新内容\n'));
  assert.notEqual(st.session.diskDigest, st.session.baseDigest);
  assert.equal(f.writes.length, 0, '恢复过程绝不能写入');

  // 即使磁盘一致，恢复后也不应自动保存（dirty 仍在，等待用户操作）
  f.content = '打开时内容\n';
  const h3 = makeHarness();
  for (const [k, v] of h2.drafts._rows) h3.drafts._rows.set(k, v);
  await h3.ctrl.init();
  await h3.ctrl.restore(id);
  assert.equal(h3.events.at(-1), 'restored-draft-current');
  assert.equal(h3.ctrl.getState().session.dirty, true);
  assert.equal(f.writes.length, 0);
});

test('8. 恢复后授权已撤销：提示重新授权，授权前后均无自动写入', async () => {
  const h = makeHarness();
  await h.ctrl.init();
  const f = await openFresh(h, 'revoked.md');
  h.ctrl.setText('编辑\n');
  await h.tick();
  await h.ctrl._persistNow();
  const id = h.ctrl.getState().session.id;

  f.permission = 'denied';
  const h2 = makeHarness();
  for (const [k, v] of h.drafts._rows) h2.drafts._rows.set(k, v);
  await h2.ctrl.init();
  await h2.ctrl.restore(id);
  assert.equal(h2.events.at(-1), 'restored-need-auth');
  assert.equal(f.writes.length, 0);

  await h2.ctrl.save();
  assert.equal(h2.events.at(-1), 'permission-denied');
  assert.equal(f.writes.length, 0);

  f.permission = 'granted';                 // 用户在浏览器授权提示中同意
  await h2.ctrl.reauthorize();
  assert.equal(h2.events.at(-1), 'reauthorized', '磁盘没变 → 仅授权恢复');
  assert.equal(f.writes.length, 0, '重新授权本身不得写入');

  await h2.ctrl.save();                     // 用户显式保存才写
  assert.equal(h2.events.at(-1), 'saved');
  assert.equal(f.content, '编辑\n');
});

test('9. 不支持 FS API：导入 → 下载副本，状态文案不得声称写回原文件', async () => {
  const drafts = createDrafts();
  const downloads = [];
  let now = 1000;
  const fallbackAdapter = {
    supported: () => false,
    download: (name, text) => downloads.push({ name, text }),
  };
  const ctrl = MDE.createController({ adapter: fallbackAdapter, drafts, clock: () => now });
  const events = [];
  ctrl.subscribe((s) => events.push(s.code));
  await ctrl.init();

  await ctrl.importText('report.md', '# 标题\n正文\n');
  assert.equal(events.at(-1), 'imported');
  ctrl.setText('# 标题\n正文（改过）\n');
  ctrl.save();                                 // 兼容模式下保存 = 下载副本
  assert.equal(events.at(-1), 'downloaded');
  assert.deepEqual(downloads, [{ name: 'report.md', text: '# 标题\n正文（改过）\n' }]);

  const text = MDE.STATUS_TEXT.downloaded;
  assert.ok(!/已保存到原文件/.test(text), '下载提示不得说“已保存到原文件”');
  assert.ok(/未写回|原文件/.test(text));
  // 只有真实写回的状态码允许说保存到原文件
  assert.equal(MDE.STATUS_TEXT.saved, '已保存到原文件');
  assert.ok(!/已保存到原文件/.test(MDE.STATUS_TEXT['saved-as']));
});

test('10. 再次打开同文件发现未完成草稿：自动恢复并标注磁盘更新，不覆盖', async () => {
  const h = makeHarness();
  await h.ctrl.init();
  const f = await openFresh(h);
  h.ctrl.setText('未保存的改动\n');
  await h.tick();
  const id = h.ctrl.getState().session.id;

  // 新会话重新打开同一文件，磁盘已被他人更新
  f.content = '磁盘上更新后的内容\n';
  h.adapter.setNextPick(f);
  await h.ctrl.openFile();
  assert.equal(h.ctrl.getState().status.code, 'restored-disk-newer');
  const st = h.ctrl.getState();
  assert.equal(st.session.id, id, '应复用原草稿记录');
  assert.equal(st.session.draftText, '未保存的改动\n');
  assert.equal(st.session.dirty, true);
  assert.equal(f.writes.length, 0);

  // 若磁盘没变则是 current；但也不自动保存
  f.content = '原始内容 v1\n';
  h.adapter.setNextPick(f);
  await h.ctrl.openFile();
  assert.equal(h.ctrl.getState().status.code, 'restored-draft-current');
  assert.equal(f.writes.length, 0);
});

test('11. 本地未关联文件的草稿：编辑即保留，恢复后可下载/另存', async () => {
  const h = makeHarness();
  await h.ctrl.init();
  h.ctrl.setText('# 临时笔记\n');
  await h.tick();
  assert.equal(h.drafts._rows.size, 1);
  const id = h.ctrl.getState().session.id;
  assert.equal(h.drafts._rows.values().next().value.kind, 'local');

  const h2 = makeHarness();
  for (const [k, v] of h.drafts._rows) h2.drafts._rows.set(k, v);
  await h2.ctrl.init();
  await h2.ctrl.restore(id);
  assert.equal(h2.events.at(-1), 'restored-local');
  assert.equal(h2.ctrl.getState().session.draftText, '# 临时笔记\n');

  const ok = await h2.ctrl.reauthorize(id);
  assert.equal(ok, false);
  assert.equal(h2.events.at(-1), 'reauth-unavailable');
});

test('12. 保存途中继续输入：旧快照写入后不得谎称全部已保存，新输入仍是未保存草稿', async () => {
  const h = makeHarness();
  await h.ctrl.init();
  const f = await openFresh(h, 'race-edit.md', 'v1\n');
  h.ctrl.setText('v2\n');
  await h.tick();

  const g = gate();
  f.writeGate = g;                            // 写入挂起
  const p = h.ctrl.save();
  await h.tick(5);
  assert.equal(h.ctrl.getState().saving, true);

  h.ctrl.setText('v3（保存期间又输入）\n');
  await h.tick(30);                           // 等防抖草稿落盘
  assert.equal(h.drafts._rows.size, 1, '新输入必须已进入草稿备份');

  g.resolve();                                // 迟到的写入结果返回
  await p;
  const st = h.ctrl.getState();
  assert.equal(f.content, 'v2\n', '磁盘只收到保存发起时的快照');
  assert.equal(st.status.code, 'saved-stale', '不得标记为“已保存”，应明确警示');
  assert.equal(st.session.dirty, true, '后续编辑仍是未保存状态');
  assert.equal(h.drafts._rows.size, 1, '草稿不得被删除');
  assert.equal(h.drafts._rows.values().next().value.draftText, 'v3（保存期间又输入）\n');
  // 基线已前进到磁盘上的 v2，便于下一次保存正确比对
  assert.equal(st.session.baseDigest, await MDE.sha256('v2\n'));
});

test('13. 12 之后再次保存：基线为旧快照，无外部修改时新内容正常写回并清草稿', async () => {
  const h = makeHarness();
  await h.ctrl.init();
  const f = await openFresh(h, 'race-edit2.md', 'v1\n');
  h.ctrl.setText('v2\n');
  await h.tick();
  const g = gate();
  f.writeGate = g;
  const p = h.ctrl.save();
  await h.tick(5);
  h.ctrl.setText('v3\n');
  await h.tick(30);
  g.resolve();
  await p;
  assert.equal(h.ctrl.getState().status.code, 'saved-stale');

  await h.ctrl.save();
  const st = h.ctrl.getState();
  assert.equal(st.status.code, 'saved');
  assert.equal(f.content, 'v3\n');
  assert.equal(st.session.dirty, false);
  assert.equal(h.drafts._rows.size, 0);
});

test('14. 保存 A 途中切换到文档 B：A 的迟到结果不改 B 的状态，A 完整保存后草稿静默清理', async () => {
  const h = makeHarness();
  await h.ctrl.init();
  const fa = await openFresh(h, 'a.md', 'A-v1\n');
  h.ctrl.setText('A-v2\n');
  await h.tick();
  const idA = h.ctrl.getState().session.id;

  const g = gate();
  fa.writeGate = g;
  const pA = h.ctrl.save();
  await h.tick(5);
  assert.equal(h.ctrl.getState().saving, true);

  const fb = h.fs.createFile('b.md', 'B 内容\n');
  h.adapter.setNextPick(fb);
  await h.ctrl.openFile();                    // A 写入挂起期间切到 B
  assert.equal(h.ctrl.getState().session.name, 'b.md');
  assert.equal(h.ctrl.getState().status.code, 'opened');
  assert.equal(h.ctrl.getState().saving, false);

  h.ctrl.setText('B 内容（改了）\n');
  await h.tick(30);

  g.resolve();                                // A 的写入迟到
  await pA;
  await h.tick(5);
  const st = h.ctrl.getState();
  assert.equal(st.session.name, 'b.md');
  assert.notEqual(st.status.code, 'saved', 'A 的结果不得把 B 标为已保存');
  assert.notEqual(st.status.code, 'saved-stale');
  assert.equal(st.session.dirty, true, 'B 的编辑不受 A 影响');
  assert.equal(fa.content, 'A-v2\n', 'A 的快照正常落盘');
  assert.equal(fb.content, 'B 内容\n', 'B 磁盘未被触碰');
  const recA = await h.drafts.get(idA);
  assert.equal(recA, undefined, 'A 已完整保存，其草稿应被静默删除');
});

test('15. 保存 A 途中切换文档且磁盘在锁内被外部修改：A 不被覆盖、草稿静默保留，绝不弹到 B', async () => {
  const h = makeHarness();
  await h.ctrl.init();
  const fa = await openFresh(h, 'a2.md', 'A-v1\n');
  h.ctrl.setText('A-v2\n');
  await h.tick();
  const idA = h.ctrl.getState().session.id;

  const g = gate();
  h.adapter.setPrepareGate(fa, g);              // 写临界区（锁内重读）挂起
  const pA = h.ctrl.save();
  await h.tick(5);

  const fb = h.fs.createFile('b2.md', 'B\n');
  h.adapter.setNextPick(fb);
  fa.content = '外部在 A 保存途中改了 A\n';       // A 锁内 final check 会发现变化
  await h.ctrl.openFile();

  h.adapter.setPrepareGate(fa, null);
  g.resolve();
  await pA;
  await h.tick(5);
  const st = h.ctrl.getState();
  assert.equal(st.session.name, 'b2.md');
  assert.equal(st.conflict, null, 'A 的冲突不得弹到 B 的界面上');
  assert.equal(fa.content, '外部在 A 保存途中改了 A\n', '检测到变化时 A 不得被覆盖写');
  const recA = await h.drafts.get(idA);
  assert.ok(recA && recA.draftText === 'A-v2\n', 'A 的草稿静默保留，等用户回来处理');
});

test('16. 同会话连点保存：读挂起时旧尝试作废；覆盖写入持锁期间再保存也不会并发互相覆盖', async () => {
  const h = makeHarness();
  await h.ctrl.init();
  const f = await openFresh(h, 'double.md', 'v1\n');
  h.ctrl.setText('编辑 A\n');
  const gRead = gate();
  f.readGate = gRead;

  const pA = h.ctrl.save();
  await h.tick(5);
  f.content = '外部改写 v2\n';
  h.ctrl.setText('编辑 A + 更多\n');
  const pB = h.ctrl.save();                   // A 的读取仍挂着，B 使 A 的 token 作废
  await h.tick(5);

  gRead.resolve();
  await pA;
  assert.equal(f.writes.length, 0, 'A 迟到后不得写盘');
  assert.equal(h.ctrl.getState().saving, true, 'B 继续');

  await pB;
  assert.equal(h.events.at(-1), 'conflict', 'B 读到外部改写 → 冲突（与用例 5 一致）');

  // 用户选择覆盖：写锁保证“再读 → 写”期间不会被其他写插入
  const gWrite = gate();
  f.writeGate = gWrite;
  const pOv = h.ctrl.resolveConflict('overwrite');
  await h.tick(5);
  // 覆盖写入挂起期间再次触发保存（连点 / Ctrl+S）：旧覆盖持锁写入，新保存锁内重比
  const pC = h.ctrl.save();
  await h.tick(5);
  gWrite.resolve();
  await pOv;
  await pC;
  assert.equal(f.content, '编辑 A + 更多\n');
  assert.equal(h.ctrl.getState().session.dirty, false);
});

test('17. 另存为途中继续输入：新文件只含旧快照，新输入仍是未保存草稿并给出警示', async () => {
  const h = makeHarness();
  await h.ctrl.init();
  await openFresh(h, 'old.md', 'v1\n');
  h.ctrl.setText('v2\n');
  await h.tick();

  const f2 = h.fs.createFile('new.md', '');
  const g = gate();
  f2.writeGate = g;
  h.adapter.setNextSave(f2);
  const p = h.ctrl.saveAs();
  await h.tick(5);
  h.ctrl.setText('v3（另存期间输入）\n');
  await h.tick(30);
  g.resolve();
  await p;

  const st = h.ctrl.getState();
  assert.equal(f2.content, 'v2\n');
  assert.equal(st.status.code, 'saved-as-stale');
  assert.equal(st.session.dirty, true);
  assert.equal(st.session.name, 'new.md');
  assert.equal(h.drafts._rows.size, 1, '后续输入的草稿保留（已关联到新文件）');
  assert.equal(h.drafts._rows.values().next().value.draftText, 'v3（另存期间输入）\n');
});
