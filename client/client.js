/**
 * dsh-folder-access — client half.
 *
 * A compact button on the composer tool row opens the host's directory
 * chooser and grants the chosen folder to the current session; a row above
 * the composer lists the granted folders and lets the user revoke one.
 *
 * The host half owns every bit of authority: these components only call
 * /dsh-folder-access/*, and the host validates the session + loopback origin.
 */
window.__ModuleLoader__.load({
  id: 'dsh-folder-access',
  factory: function (require) {
    var module = { exports: {} };
    var exports = module.exports;
    var React = require('react');
    var h = React.createElement;

    var STATE_URL = '/dsh-folder-access/state';
    var ADD_URL = '/dsh-folder-access/add';
    var REMOVE_URL = '/dsh-folder-access/remove';

    var CSS = [
      '.dfa-btn{display:inline-flex;align-items:center;justify-content:center;gap:4px;height:26px;padding:0 8px;border-radius:999px;border:.5px solid var(--dsw-alias-border-l1,rgba(127,127,127,.28));background:transparent;color:var(--dsw-alias-label-primary,inherit);font:inherit;font-size:12px;line-height:1;cursor:pointer;opacity:.85;white-space:nowrap}',
      '.dfa-btn:hover{background:var(--dsw-alias-card-fill-hover,rgba(127,127,127,.1));opacity:1}',
      '.dfa-btn[disabled]{cursor:default;opacity:.5}',
      '.dfa-bar{display:flex;align-items:center;flex-wrap:wrap;gap:6px;padding:2px 0 6px;font-size:12px;color:var(--dsw-alias-label-primary,inherit)}',
      '.dfa-bar-label{opacity:.55}',
      '.dfa-chip{display:inline-flex;align-items:center;gap:2px;max-width:340px;height:22px;padding:0 4px 0 8px;border-radius:999px;border:.5px solid var(--dsw-alias-border-l1,rgba(127,127,127,.28));background:var(--dsw-alias-card-fill,rgba(127,127,127,.08))}',
      '.dfa-chip-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dfa-chip-x{display:inline-flex;align-items:center;justify-content:center;width:16px;height:16px;border:0;border-radius:50%;background:transparent;color:inherit;opacity:.55;cursor:pointer;font-size:13px;line-height:1;padding:0}',
      '.dfa-chip-x:hover{opacity:1;background:var(--dsw-alias-card-fill-hover,rgba(127,127,127,.16))}',
      '.dfa-notice{color:#d97706}',
    ].join('');

    var STRINGS = {
      zh: {
        add: '文件夹',
        addHint: '把本地文件夹授权给当前对话：AI 可以浏览、读取并编辑其中的文件',
        granted: '已授权',
        remove: '取消授权',
        busy: '授权中…',
        pickerUnavailable: '这个环境弹不出文件夹对话框，请直接输入文件夹的绝对路径',
        needPath: '文件夹的绝对路径（例如 D:\\projects\\demo）',
        unreachable: '连不上宿主进程，文件夹授权不可用',
      },
      en: {
        add: 'Folder',
        addHint: 'Grant a local folder to this conversation: the agent may browse, read and edit its files',
        granted: 'Granted',
        remove: 'Revoke',
        busy: 'Granting…',
        pickerUnavailable: 'No folder dialog in this environment — type the absolute path instead',
        needPath: 'Absolute path of the folder (for example D:\\projects\\demo)',
        unreachable: 'Cannot reach the host process; folder access is unavailable',
      },
    };

    function pickStrings() {
      try {
        var lang = (document.documentElement.getAttribute('lang') || navigator.language || 'en').toLowerCase();
        return lang.indexOf('zh') === 0 ? STRINGS.zh : STRINGS.en;
      } catch (error) {
        return STRINGS.en;
      }
    }

    function ensureStyle() {
      if (typeof document === 'undefined') return;
      if (document.querySelector('style[data-plugin-css="dsh-folder-access"]') !== null) return;
      var tag = document.createElement('style');
      tag.dataset.pluginCss = 'dsh-folder-access';
      tag.textContent = CSS;
      document.head.appendChild(tag);
    }

    /** Resolve a route against the page the shell is served from. */
    function api(route) {
      var relative = route.replace(/^\/+/, '');
      try {
        if (typeof document === 'undefined' || !document.baseURI) return '/' + relative;
        return new URL(relative, document.baseURI).pathname;
      } catch (error) {
        return '/' + relative;
      }
    }

    async function readJson(response) {
      try {
        return await response.json();
      } catch (error) {
        return undefined;
      }
    }

    async function postJson(route, body) {
      var response = await fetch(api(route), {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(body),
      });
      var data = await readJson(response);
      if (data !== undefined) return data;
      return { ok: false, code: 'http-' + response.status, message: 'HTTP ' + response.status };
    }

    // ---- per-session state -------------------------------------------------

    var foldersBySession = new Map();
    var noticesBySession = new Map();
    var listeners = new Set();
    var pending = new Map();

    function emit() {
      listeners.forEach(function (listener) {
        try {
          listener();
        } catch (error) {
          // A dead subscriber must not break the others.
        }
      });
    }

    function setFolders(sessionId, folders) {
      foldersBySession.set(sessionId, Array.isArray(folders) ? folders.slice() : []);
      emit();
    }

    function foldersOfSession(sessionId) {
      return foldersBySession.get(sessionId) || [];
    }

    function noticeOfSession(sessionId) {
      return noticesBySession.get(sessionId);
    }

    function showNotice(sessionId, text) {
      noticesBySession.set(sessionId, text);
      emit();
      window.setTimeout(function () {
        if (noticesBySession.get(sessionId) === text) {
          noticesBySession.delete(sessionId);
          emit();
        }
      }, 6000);
    }

    function useSessionState(sessionId) {
      var pair = React.useState(0);
      var version = pair[0];
      var rerender = pair[1];
      React.useEffect(function () {
        var listener = function () {
          rerender(function (value) {
            return value + 1;
          });
        };
        listeners.add(listener);
        return function () {
          listeners.delete(listener);
        };
      }, [sessionId]);
      React.useEffect(function () {
        if (typeof sessionId !== 'string' || sessionId.length === 0) return;
        if (pending.get(sessionId) === true) return;
        pending.set(sessionId, true);
        (async function () {
          try {
            var response = await fetch(api(STATE_URL + '?sessionId=' + encodeURIComponent(sessionId)), {
              credentials: 'same-origin',
              headers: { accept: 'application/json' },
            });
            var data = await readJson(response);
            if (data !== undefined && data.ok === true) setFolders(sessionId, data.folders);
          } catch (error) {
            // Offline shell or a host without the route: keep whatever we have.
          } finally {
            pending.delete(sessionId);
          }
        })();
      }, [sessionId]);
      return {
        folders: foldersOfSession(sessionId),
        notice: noticeOfSession(sessionId),
        version: version,
      };
    }

    // ---- actions -----------------------------------------------------------

    async function addFolder(sessionId, strings) {
      var result = await postJson(ADD_URL, { sessionId: sessionId });
      if (result.ok === true) {
        setFolders(sessionId, result.folders || []);
        return;
      }
      if (result.code === 'picker-unavailable' || result.code === 'picker-failed') {
        var typed = window.prompt(strings.pickerUnavailable + '\n' + strings.needPath, '');
        if (typed === null || typed.trim() === '') return;
        var second = await postJson(ADD_URL, { sessionId: sessionId, path: typed });
        if (second.ok === true) {
          setFolders(sessionId, second.folders || []);
          return;
        }
        showNotice(sessionId, second.message || strings.unreachable);
        return;
      }
      if (result.code === 'cancelled') return;
      showNotice(sessionId, result.message || strings.unreachable);
    }

    async function removeFolder(sessionId, directory, strings) {
      var result = await postJson(REMOVE_URL, { sessionId: sessionId, path: directory });
      if (result.ok === true) {
        setFolders(sessionId, result.folders || []);
        return;
      }
      showNotice(sessionId, result.message || strings.unreachable);
    }

    function baseName(directory) {
      var parts = String(directory).split(/[\\/]+/).filter(function (part) {
        return part.length > 0;
      });
      return parts.length > 0 ? parts[parts.length - 1] : String(directory);
    }

    function FolderIcon() {
      return h(
        'svg',
        { width: 13, height: 13, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': 'true' },
        h('path', { d: 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z' }),
        h('path', { d: 'M12 11v6M9 14h6' }),
      );
    }

    // ---- components --------------------------------------------------------

    function AddFolderButton(props) {
      var strings = pickStrings();
      var sessionId = props.sessionId;
      var busyPair = React.useState(false);
      var busy = busyPair[0];
      var setBusy = busyPair[1];
      if (typeof sessionId !== 'string' || sessionId.length === 0) return null;
      var onClick = async function () {
        if (busy) return;
        setBusy(true);
        try {
          await addFolder(sessionId, strings);
        } catch (error) {
          showNotice(sessionId, strings.unreachable);
        } finally {
          setBusy(false);
        }
      };
      return h(
        'button',
        {
          type: 'button',
          className: 'dfa-btn',
          title: strings.addHint,
          'aria-label': strings.addHint,
          disabled: busy,
          onClick: onClick,
        },
        h(FolderIcon, null),
        h('span', null, busy ? strings.busy : strings.add),
      );
    }

    function GrantedFoldersBar(props) {
      var strings = pickStrings();
      var sessionId = props.sessionId;
      var state = useSessionState(sessionId);
      if (typeof sessionId !== 'string' || sessionId.length === 0) return null;
      if (state.folders.length === 0 && state.notice === undefined) return null;
      return h(
        'div',
        { className: 'dfa-bar' },
        state.folders.length > 0 ? h('span', { className: 'dfa-bar-label' }, strings.granted) : null,
        state.folders.map(function (directory) {
          return h(
            'span',
            { className: 'dfa-chip', key: directory, title: directory },
            h('span', { className: 'dfa-chip-name' }, baseName(directory)),
            h(
              'button',
              {
                type: 'button',
                className: 'dfa-chip-x',
                title: strings.remove,
                'aria-label': strings.remove,
                onClick: function () {
                  removeFolder(sessionId, directory, strings).catch(function () {
                    showNotice(sessionId, strings.unreachable);
                  });
                },
              },
              '\u00d7',
            ),
          );
        }),
        state.notice === undefined ? null : h('span', { className: 'dfa-notice' }, state.notice),
      );
    }

    // ---- plugin entry ------------------------------------------------------

    function apply(ctx) {
      ensureStyle();
      var slots = ctx.slots;
      slots.inject('conversation.input.left', function () {
        return slots.register(
          {
            name: 'conversation.input.left',
            id: 'dsh-folder-access:add',
            order: 40,
            inject: function (sessionId) {
              return { sessionId: sessionId };
            },
          },
          AddFolderButton,
        );
      });
      slots.inject('conversation.input.dock', function () {
        return slots.register(
          {
            name: 'conversation.input.dock',
            id: 'dsh-folder-access:granted',
            order: 40,
            inject: function (sessionId) {
              return { sessionId: sessionId };
            },
          },
          GrantedFoldersBar,
        );
      });
    }

    exports.apply = apply;
    exports.inject = ['slots'];
    return module.exports;
  },
});
