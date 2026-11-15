/**
 * dsh-folder-access — host half.
 *
 * Grants folders the user picks to the workspace-write set of a session:
 *
 *   ctx.sandboxPolicy.registerWritableRoot(session, directory)
 *
 * A grant is durable: it is remembered in the profile's own JSON file and
 * re-applied to every session that starts later, so the model sees the
 * folders in its `sandbox:policy` runtime context without being reminded.
 * Revoking removes the folder everywhere and rewrites the file.
 *
 * Two entry points share this one capability, as the user-actions rule wants:
 *   - `/folder add|list|remove|clear`  (session command, user typed)
 *   - POST /dsh-folder-access/*        (the composer button in the client half)
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROUTES = {
  state: '/dsh-folder-access/state',
  add: '/dsh-folder-access/add',
  remove: '/dsh-folder-access/remove',
};

const MAX_BODY_BYTES = 16 * 1024;

/** Look a service up without tripping over an unloaded fiber. */
function service(ctx, name) {
  try {
    return ctx.get(name) ?? undefined;
  } catch {
    return undefined;
  }
}

function describeError(error) {
  return error instanceof Error ? error.message : String(error);
}

function unquote(value) {
  if (value.length > 1) {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) return value.slice(1, -1);
  }
  return value;
}

/** Absolute, resolved, drive-letter-normalized directory; `undefined` when the input cannot be one. */
export function normalizeDirectory(input) {
  if (typeof input !== 'string') return undefined;
  const value = unquote(input.trim());
  if (value.length === 0 || !path.isAbsolute(value)) return undefined;
  let resolved = path.resolve(value);
  if (process.platform === 'win32') resolved = resolved.replace(/^([a-z]):/, (_, drive) => `${drive.toUpperCase()}:`);
  return resolved;
}

/**
 * The profile-scoped state file. `$DSH_HOME/folder-access/<profile>.json`, so
 * two profiles on one machine keep separate lists. The host process does not
 * always export its profile name, so fall back through the profile directory,
 * the launcher arguments, and a scan of `$DSH_HOME/profiles` for the profile
 * whose dependencies name this package.
 */
let cachedProfile;

function detectProfileFromHome(home) {
  const root = path.join(home, 'profiles');
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return undefined;
  }
  const matches = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      const manifest = JSON.parse(fs.readFileSync(path.join(root, entry.name, 'package.json'), 'utf8'));
      const deps = { ...(manifest?.dependencies ?? {}), ...(manifest?.devDependencies ?? {}) };
      if (Object.prototype.hasOwnProperty.call(deps, 'dsh-folder-access')) matches.push(entry.name);
    } catch {
      // A profile without a readable manifest cannot own this plugin.
    }
  }
  return matches.length === 1 ? matches[0] : undefined;
}

function profileName() {
  if (cachedProfile !== undefined) return cachedProfile;
  cachedProfile = 'default';
  const dir = process.env.DSH_PROFILE_DIR?.trim();
  const name = process.env.DSH_PROFILE?.trim();
  if (dir !== undefined && dir.length > 0) {
    cachedProfile = path.basename(dir);
  } else if (name !== undefined && name.length > 0) {
    cachedProfile = name;
  } else {
    let fromArgs;
    for (let index = 0; index < process.argv.length; index += 1) {
      const arg = process.argv[index];
      if (arg === '--profile') fromArgs = process.argv[index + 1];
      else if (arg.startsWith('--profile=')) fromArgs = arg.slice('--profile='.length);
    }
    const home = process.env.DSH_HOME?.trim() || path.join(os.homedir(), '.dsh');
    cachedProfile = fromArgs || detectProfileFromHome(home) || 'default';
  }
  return cachedProfile;
}

function stateFile() {
  const home = process.env.DSH_HOME?.trim() || path.join(os.homedir(), '.dsh');
  const profile = profileName().replace(/[^A-Za-z0-9._-]/g, '_');
  return path.join(home, 'folder-access', `${profile}.json`);
}

/** Only a loopback Host may reach these routes; a rebinding page carries its own name. */
function isLoopbackHost(header) {
  if (typeof header !== 'string' || header.length === 0) return false;
  const hostname = header
    .replace(/:\d+$/, '')
    .replace(/^\[|\]$/g, '')
    .toLowerCase();
  return hostname === 'localhost' || hostname === '::1' || hostname === '127.0.0.1' || /^127\.\d+\.\d+\.\d+$/.test(hostname);
}

function sendJson(response, status, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  });
  response.end(body);
}

function readJsonBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('body too large'));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      if (chunks.length === 0) {
        resolve({});
        return;
      }
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        resolve(parsed !== null && typeof parsed === 'object' ? parsed : {});
      } catch (error) {
        reject(new Error(`invalid json body: ${describeError(error)}`));
      }
    });
    request.on('error', reject);
  });
}

/** Read the durable folder list; a broken file reads as empty instead of blocking the plugin. */
function loadBookmarks(logger) {
  const file = stateFile();
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  try {
    const parsed = JSON.parse(raw);
    const list = Array.isArray(parsed?.folders) ? parsed.folders : [];
    const seen = new Set();
    const folders = [];
    for (const item of list) {
      const directory = normalizeDirectory(typeof item === 'string' ? item : item?.path);
      if (directory === undefined || seen.has(directory)) continue;
      seen.add(directory);
      folders.push({ path: directory, addedAt: typeof item?.addedAt === 'string' ? item.addedAt : undefined });
    }
    return folders;
  } catch (error) {
    logger?.warn?.(`[folder-access] ignoring unreadable ${file}: ${describeError(error)}`);
    return [];
  }
}

/** Persist the folder list atomically (write-next-to-then-rename). */
function saveBookmarks(folders, logger) {
  const file = stateFile();
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temp, JSON.stringify({ version: 1, folders }, null, 2), 'utf8');
    fs.renameSync(temp, file);
    return true;
  } catch (error) {
    logger?.warn?.(`[folder-access] cannot write ${file}: ${describeError(error)}`);
    return false;
  }
}

export function apply(ctx) {
  const logger = service(ctx, 'logger');

  /** sessionId -> (directory -> disposer) */
  const grants = new Map();

  /** Durable folder list, in the order the user added them. */
  let bookmarks = loadBookmarks(logger);

  const tracked = (sessionId) => {
    let map = grants.get(sessionId);
    if (map === undefined) {
      map = new Map();
      grants.set(sessionId, map);
    }
    return map;
  };

  const foldersOf = () => bookmarks.map((entry) => entry.path);

  const dropGrant = (sessionId, directory) => {
    const map = grants.get(sessionId);
    const dispose = map?.get(directory);
    if (dispose === undefined) return false;
    try {
      dispose();
    } catch {
      // Already disposed.
    }
    map.delete(directory);
    return true;
  };

  const policyState = (session) => {
    const policy = service(ctx, 'sandboxPolicy');
    if (policy === undefined || typeof policy.resolve !== 'function') return undefined;
    try {
      return policy.resolve({ session });
    } catch {
      return undefined;
    }
  };

  ctx.effect(() => () => {
    for (const map of grants.values()) {
      for (const dispose of map.values()) {
        try {
          dispose();
        } catch {
          // A fiber that is already gone cannot revoke twice.
        }
      }
    }
    grants.clear();
  });

  /**
   * Apply the durable list to one live session. Called when a session is
   * created, when the plugin remounts, and after every change, so a new
   * conversation already carries the folders on its first model request.
   */
  const ensureFor = (session) => {
    if (session === undefined || typeof session?.id !== 'string') return;
    const policy = service(ctx, 'sandboxPolicy');
    if (policy === undefined || typeof policy.registerWritableRoot !== 'function') return;
    const map = tracked(session.id);
    for (const entry of bookmarks) {
      if (map.has(entry.path)) continue;
      let dispose;
      try {
        dispose = policy.registerWritableRoot(session, entry.path);
      } catch {
        continue;
      }
      map.set(entry.path, dispose);
    }
  };

  const liveSessions = () => {
    const sessions = service(ctx, 'sessions');
    if (sessions === undefined || typeof sessions.list !== 'function') return [];
    try {
      return [...(sessions.list() ?? [])];
    } catch {
      return [];
    }
  };

  const ensureEverywhere = () => {
    for (const session of liveSessions()) ensureFor(session);
  };

  // A session that starts after the grant inherits it before its first turn.
  ctx.effect(() => ctx.on('session/created', (session) => {
    try {
      ensureFor(session);
    } catch {
      // Never let a listener failure roll back session creation.
    }
  }, { global: true }));

  // Keep the grant table from outliving its sessions.
  ctx.effect(() => ctx.on('session/disposed', (session) => {
    if (typeof session?.id === 'string') grants.delete(session.id);
  }, { global: true }));

  // Folders granted in an earlier run (or before this fiber) apply right away.
  ensureEverywhere();

  const grant = (session, input) => {
    const directory = normalizeDirectory(input);
    if (directory === undefined) {
      return { ok: false, code: 'invalid-path', message: `需要一个绝对文件夹路径：${String(input ?? '')}` };
    }
    let stat;
    try {
      stat = fs.statSync(directory);
    } catch {
      return { ok: false, code: 'missing', message: `文件夹不存在：${directory}` };
    }
    if (!stat.isDirectory()) {
      return { ok: false, code: 'not-directory', message: `这不是文件夹：${directory}` };
    }
    const policy = service(ctx, 'sandboxPolicy');
    if (policy === undefined || typeof policy.registerWritableRoot !== 'function') {
      return { ok: false, code: 'unavailable', message: '沙箱策略服务 sandboxPolicy 不可用，无法授权文件夹' };
    }
    if (!bookmarks.some((entry) => entry.path === directory)) {
      bookmarks.push({ path: directory, addedAt: new Date().toISOString() });
      saveBookmarks(bookmarks, logger);
    }
    ensureFor(session);
    ensureEverywhere();
    const state = policyState(session);
    const mode = state?.mode;
    if (mode !== undefined && mode !== 'workspace-write' && mode !== 'danger-full-access') {
      return {
        ok: false,
        code: 'mode',
        message: `已记录，但当前会话沙箱模式是 ${mode}，写操作仍然会被拒绝`,
        directory,
        folders: foldersOf(),
        mode,
      };
    }
    return { ok: true, directory, folders: foldersOf(), mode };
  };

  const revoke = (sessionId, input) => {
    const directory = normalizeDirectory(input);
    if (directory === undefined) {
      return { ok: false, code: 'invalid-path', message: `需要一个绝对文件夹路径：${String(input ?? '')}` };
    }
    const known = bookmarks.some((entry) => entry.path === directory);
    if (!known && grants.get(sessionId)?.has(directory) !== true) {
      return { ok: false, code: 'not-granted', message: `没有授权过：${directory}`, folders: foldersOf() };
    }
    bookmarks = bookmarks.filter((entry) => entry.path !== directory);
    saveBookmarks(bookmarks, logger);
    for (const id of [...grants.keys()]) dropGrant(id, directory);
    return { ok: true, folders: foldersOf(), directory };
  };

  const revokeAll = () => {
    bookmarks = [];
    saveBookmarks(bookmarks, logger);
    for (const map of grants.values()) {
      for (const dispose of map.values()) {
        try {
          dispose();
        } catch {
          // Already disposed.
        }
      }
      map.clear();
    }
    return { ok: true, folders: [] };
  };

  /** Open the composed directory chooser (native dialog on a desktop host). */
  const pickDirectory = async () => {
    const picker = service(ctx, 'directoryPicker');
    if (picker === undefined || typeof picker.capability !== 'function') {
      return { ok: false, code: 'picker-unavailable', message: '当前没有可用的目录选择器' };
    }
    let capability;
    try {
      capability = picker.capability();
    } catch (error) {
      return { ok: false, code: 'picker-unavailable', message: `目录选择器不可用：${describeError(error)}` };
    }
    if (capability === undefined || capability === null || typeof capability.pick !== 'function') {
      return { ok: false, code: 'picker-unavailable', message: '当前目录选择器不支持弹出对话框' };
    }
    try {
      const picked = await capability.pick(new AbortController().signal);
      if (picked === null || picked === undefined) return { ok: false, code: 'cancelled' };
      return { ok: true, directory: String(picked) };
    } catch (error) {
      return { ok: false, code: 'picker-failed', message: `选择文件夹失败：${describeError(error)}` };
    }
  };

  const liveSession = (sessionId) => {
    if (typeof sessionId !== 'string' || sessionId.length === 0) return undefined;
    const sessions = service(ctx, 'sessions');
    if (sessions === undefined || typeof sessions.get !== 'function') return undefined;
    try {
      return sessions.get(sessionId) ?? undefined;
    } catch {
      return undefined;
    }
  };

  // ---- session command: /folder -------------------------------------------

  // Mounted lazily: the loader may compose this plugin before `commands` and
  // `webServer` exist, and reading them eagerly at apply time would silently
  // skip the registration (no /folder, and the composer button getting the
  // shell's 405 for a POST it does not route).
  ctx.inject(['commands'], (host) => {
    const commands = host.get('commands');
    if (commands === undefined || typeof commands.register !== 'function') return;
    host.effect(() =>
      commands.register({
        name: 'folder',
        description: '把本地文件夹授权给 AI（可浏览并编辑其中的文件，所有对话通用）',
        input: { hint: '[add [路径] | list | remove <路径> | clear]' },
        handler: async ({ agent, rawInput }) => {
          const session = agent?.session;
          if (session === undefined) return { kind: 'error', text: '当前对话不可用' };
          const raw = String(rawInput ?? '').trim();
          const [head] = raw.split(/\s+/, 1);
          const rest = raw.slice(head.length).trim();
          const verb = head.toLowerCase();
          try {
            if (verb === '' || verb === 'list') {
              const folders = foldersOf();
              if (folders.length === 0) return { kind: 'success', text: '还没有授权任何文件夹。用 /folder add 选择文件夹。' };
              return { kind: 'success', text: ['已授权的文件夹（新对话自动生效）：', ...folders.map((dir) => `· ${dir}`)].join('\n') };
            }
            if (verb === 'add') {
              let directory = rest;
              if (directory === '') {
                const picked = await pickDirectory();
                if (picked.ok !== true) return { kind: 'error', text: picked.message ?? '没有选择文件夹' };
                directory = picked.directory;
              }
              const result = grant(session, directory);
              if (result.ok !== true) return { kind: 'error', text: result.message };
              return { kind: 'success', text: `已授权文件夹：${result.directory}（这个文件夹现在可读可写，新对话也生效）` };
            }
            if (verb === 'remove' || verb === 'rm') {
              const result = revoke(session.id, rest);
              if (result.ok !== true) return { kind: 'error', text: result.message };
              return { kind: 'success', text: `已取消授权：${result.directory}` };
            }
            if (verb === 'clear') {
              revokeAll();
              return { kind: 'success', text: '已取消全部文件夹授权' };
            }
            return { kind: 'error', text: `不认识的子命令 "${head}"，可用：add / list / remove / clear` };
          } catch (error) {
            return { kind: 'error', text: `文件夹授权失败：${describeError(error)}` };
          }
        },
      }),
    );
  });

  // ---- HTTP routes for the composer button --------------------------------

  ctx.inject(['webServer'], (host) => {
    const webServer = host.get('webServer');
    if (webServer === undefined || typeof webServer.register !== 'function') return;
    const admit = (request, response) => {
      if (!isLoopbackHost(request.headers.host)) {
        sendJson(response, 403, { ok: false, code: 'forbidden', message: 'loopback only' });
        return false;
      }
      const site = request.headers['sec-fetch-site'];
      if (typeof site === 'string' && site !== 'same-origin' && site !== 'none') {
        sendJson(response, 403, { ok: false, code: 'forbidden', message: 'same-origin only' });
        return false;
      }
      return true;
    };

    host.effect(() =>
      webServer.register({
        kind: 'exact',
        path: ROUTES.state,
        handler: (request, response) => {
          if (!admit(request, response)) return;
          if (request.method !== 'GET' && request.method !== 'HEAD') {
            sendJson(response, 405, { ok: false, code: 'method', message: 'GET only' });
            return;
          }
          let sessionId = '';
          try {
            sessionId = new URL(request.url ?? '/', 'http://127.0.0.1').searchParams.get('sessionId') ?? '';
          } catch {
            sessionId = '';
          }
          const session = liveSession(sessionId);
          if (session !== undefined) ensureFor(session);
          sendJson(response, 200, {
            ok: true,
            folders: foldersOf(),
            mode: session === undefined ? null : policyState(session)?.mode ?? null,
          });
        },
      }),
    );

    host.effect(() =>
      webServer.register({
        kind: 'exact',
        path: ROUTES.add,
        handler: async (request, response) => {
          if (!admit(request, response)) return;
          if (request.method !== 'POST') {
            sendJson(response, 405, { ok: false, code: 'method', message: 'POST only' });
            return;
          }
          try {
            const body = await readJsonBody(request);
            const session = liveSession(body.sessionId);
            if (session === undefined) {
              sendJson(response, 200, { ok: false, code: 'no-session', message: '这个对话已经不在运行了，请刷新页面' });
              return;
            }
            let directory = body.path;
            if (directory === undefined || directory === null || directory === '') {
              const picked = await pickDirectory();
              if (picked.ok !== true) {
                sendJson(response, 200, picked);
                return;
              }
              directory = picked.directory;
            }
            const result = grant(session, directory);
            sendJson(response, 200, { ...result, folders: result.folders ?? foldersOf(), mode: result.mode ?? policyState(session)?.mode ?? null });
          } catch (error) {
            sendJson(response, 200, { ok: false, code: 'bad-request', message: describeError(error) });
          }
        },
      }),
    );

    host.effect(() =>
      webServer.register({
        kind: 'exact',
        path: ROUTES.remove,
        handler: async (request, response) => {
          if (!admit(request, response)) return;
          if (request.method !== 'POST') {
            sendJson(response, 405, { ok: false, code: 'method', message: 'POST only' });
            return;
          }
          try {
            const body = await readJsonBody(request);
            const session = liveSession(body.sessionId);
            if (session === undefined) {
              sendJson(response, 200, { ok: false, code: 'no-session', message: '这个对话已经不在运行了，请刷新页面' });
              return;
            }
            const result = body.all === true ? revokeAll() : revoke(session.id, body.path);
            sendJson(response, 200, result);
          } catch (error) {
            sendJson(response, 200, { ok: false, code: 'bad-request', message: describeError(error) });
          }
        },
      }),
    );
  });
}
