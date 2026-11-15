/**
 * dsh-folder-access — host half.
 *
 * Grants a folder the user picks to the *live* session's workspace-write set:
 *
 *   ctx.sandboxPolicy.registerWritableRoot(session, directory)
 *
 * The returned disposer revokes the grant. Grants are runtime-only: the
 * sandbox policy resolves them per request, so the model sees the folder in
 * its `sandbox:policy` runtime context from the next request on, and the fs
 * tools may write into it. Nothing is persisted; re-grant after a restart.
 *
 * Two entry points share this one capability, as the user-actions rule wants:
 *   - `/folder add|list|remove`  (session command, user typed)
 *   - POST /dsh-folder-access/*  (the composer button in the client half)
 */

import fs from 'node:fs';
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

export function apply(ctx) {
  /** sessionId -> (directory -> disposer) */
  const grants = new Map();

  const tracked = (sessionId) => {
    let map = grants.get(sessionId);
    if (map === undefined) {
      map = new Map();
      grants.set(sessionId, map);
    }
    return map;
  };

  const foldersOf = (sessionId) => [...(grants.get(sessionId)?.keys() ?? [])];

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
    const map = tracked(session.id);
    if (!map.has(directory)) {
      let dispose;
      try {
        dispose = policy.registerWritableRoot(session, directory);
      } catch (error) {
        return { ok: false, code: 'denied', message: `授权失败：${describeError(error)}` };
      }
      map.set(directory, dispose);
    }
    const state = policyState(session);
    const mode = state?.mode;
    if (mode !== undefined && mode !== 'workspace-write' && mode !== 'danger-full-access') {
      return {
        ok: false,
        code: 'mode',
        message: `已记录，但当前会话沙箱模式是 ${mode}，写操作仍然会被拒绝`,
        directory,
        folders: foldersOf(session.id),
        mode,
      };
    }
    return { ok: true, directory, folders: foldersOf(session.id), mode };
  };

  const revoke = (sessionId, input) => {
    const directory = normalizeDirectory(input);
    if (directory === undefined) {
      return { ok: false, code: 'invalid-path', message: `需要一个绝对文件夹路径：${String(input ?? '')}` };
    }
    const map = grants.get(sessionId);
    const dispose = map?.get(directory);
    if (dispose === undefined) {
      return { ok: false, code: 'not-granted', message: `当前对话没有授权过：${directory}`, folders: foldersOf(sessionId) };
    }
    try {
      dispose();
    } catch {
      // Already disposed.
    }
    map.delete(directory);
    return { ok: true, folders: foldersOf(sessionId), directory };
  };

  const revokeAll = (sessionId) => {
    const map = grants.get(sessionId);
    if (map !== undefined) {
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
        description: '把本地文件夹授权给当前对话（AI 可浏览并编辑其中的文件）',
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
              const folders = foldersOf(session.id);
              if (folders.length === 0) return { kind: 'success', text: '当前对话还没有授权任何文件夹。用 /folder add 选择文件夹。' };
              return { kind: 'success', text: ['当前对话已授权的文件夹：', ...folders.map((dir) => `· ${dir}`)].join('\n') };
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
              return { kind: 'success', text: `已授权文件夹：${result.directory}（这个文件夹现在可读可写）` };
            }
            if (verb === 'remove' || verb === 'rm') {
              const result = revoke(session.id, rest);
              if (result.ok !== true) return { kind: 'error', text: result.message };
              return { kind: 'success', text: `已取消授权：${result.directory}` };
            }
            if (verb === 'clear') {
              revokeAll(session.id);
              return { kind: 'success', text: '已取消当前对话的全部文件夹授权' };
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
          if (session === undefined) {
            sendJson(response, 200, { ok: true, folders: [], mode: null });
            return;
          }
          sendJson(response, 200, { ok: true, folders: foldersOf(session.id), mode: policyState(session)?.mode ?? null });
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
            sendJson(response, 200, { ...result, folders: result.folders ?? foldersOf(session.id), mode: result.mode ?? policyState(session)?.mode ?? null });
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
            const result = body.all === true ? revokeAll(session.id) : revoke(session.id, body.path);
            sendJson(response, 200, result);
          } catch (error) {
            sendJson(response, 200, { ok: false, code: 'bad-request', message: describeError(error) });
          }
        },
      }),
    );
  });
}
