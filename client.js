// Lazy-CJS registration consumed by DSH's client module system; no build tool required.
window.__ModuleLoader__.load({
  id: 'dsh-plugin-web-restart',
  factory(require) {
    const React = require('react');
    const { createElement: h, useState, useEffect, useRef } = React;
    const dictionaries = {
      zh: { label: '重启 DSH', title: '确认重启 DSH 服务？', warning: '这将重启整个 DSH 服务，影响所有连接的页面和会话。正在运行的回答、工具和后台任务会被中断；重启不保证自动恢复这些任务。请先保存编辑并等待重要任务结束。', cancel: '取消', confirm: '确认重启', checking: '正在检查重启能力…', unsupported: '当前 DSH 未由重启包装器启动。首次需按插件说明使用 supervisor.js 启动，之后即可在此重启。', waiting: '重启请求已提交，正在等待服务重新上线…', unknown: '请求结果尚未确认。正在检查服务是否已重启；为避免重复重启，不会自动重发。', timeout: '暂未检测到新的服务实例。请检查启动终端；可继续检查，但不会重复发送重启请求。', check: '继续检查', close: '关闭', failed: '操作失败：', expired: '确认已过期，请关闭后重试。' },
      en: { label: 'Restart DSH', title: 'Restart the DSH service?', warning: 'This restarts the entire DSH service and affects all connected pages and sessions. Running answers, tools and background jobs will be interrupted and may not resume automatically. Save edits and wait for important work to finish first.', cancel: 'Cancel', confirm: 'Confirm restart', checking: 'Checking restart support…', unsupported: 'This DSH host was not started by the restart supervisor. Start it once with supervisor.js as documented, then restart here.', waiting: 'Restart submitted. Waiting for the service to return…', unknown: 'Request outcome is unknown. Checking for a restarted service; the restart request will not be sent again automatically.', timeout: 'No new service instance detected yet. Check the launch terminal. You can keep checking without sending another restart.', check: 'Keep checking', close: 'Close', failed: 'Request failed: ', expired: 'Confirmation expired. Close and try again.' },
    };
    const style = `.dsh-restart-trigger{display:inline-flex;align-items:center;justify-content:center;gap:8px;min-width:36px;min-height:36px;padding:8px;border:0;border-radius:9px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;font:inherit}.dsh-restart-trigger:hover{background:var(--dsw-alias-bg-layer-2)}.dsh-restart-dialog{box-sizing:border-box;width:min(470px,calc(100vw - 32px));max-height:calc(100dvh - 32px);overflow:auto;border:1px solid var(--dsw-alias-border-l1);border-radius:16px;padding:24px;background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary,#222);font:inherit;box-shadow:0 16px 64px #0003}.dsh-restart-dialog::backdrop{background:#0006;backdrop-filter:blur(3px)}.dsh-restart-dialog h2{font-size:18px;margin:0 0 14px}.dsh-restart-dialog p{line-height:1.65;white-space:pre-wrap;overflow-wrap:anywhere}.dsh-restart-actions{display:flex;justify-content:flex-end;gap:10px;margin-top:24px}.dsh-restart-actions button{border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:8px 14px;background:var(--dsw-alias-bg-layer-2);color:inherit;font:inherit;cursor:pointer}.dsh-restart-actions .danger{background:#c73535;color:#fff;border-color:transparent}.dsh-restart-actions button:disabled{opacity:.5;cursor:default}.dsh-restart-trigger:focus-visible,.dsh-restart-actions button:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#5b64ed);outline-offset:3px}`;
    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        for (const [lang, dictionary] of Object.entries(dictionaries)) ctx.effect(() => ctx.locale.register('dshRestart', lang, dictionary));
        function RestartButton({ wide }) {
          React.useSyncExternalStore(fn => ctx.locale.subscribe(fn), () => ctx.locale.getSnapshot());
          const t = ctx.locale.bind('dshRestart');
          const [phase, setPhase] = useState('closed');
          const [detail, setDetail] = useState('');
          const dialog = useRef(null);
          const ticket = useRef(null);
          const locked = useRef(false);
          const mounted = useRef(true);
          const poll = useRef(null);
          const generation = useRef(0);
          useEffect(() => () => { mounted.current = false; generation.current++; clearTimeout(poll.current); }, []);
          async function api(path, body) {
            const response = await fetch(new URL(`dsh-restart/${path}`, document.baseURI), {
              method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin', cache: 'no-store',
              headers: body === undefined ? {} : { 'Content-Type': 'application/json', 'X-DSH-Restart': '1' },
              body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(4000),
            });
            const value = await response.json();
            if (!response.ok) throw new Error(value.error || `HTTP ${response.status}`);
            return value;
          }
          useEffect(() => {
            if (phase !== 'closed' && !dialog.current.open) dialog.current.showModal();
            if (phase === 'closed' && dialog.current.open) dialog.current.close();
          }, [phase]);
          function close() {
            if (locked.current) return;
            generation.current++; clearTimeout(poll.current); ticket.current = null; setPhase('closed');
          }
          async function open() {
            if (phase !== 'closed') return;
            const round = ++generation.current;
            setPhase('checking'); setDetail('');
            try {
              const status = await api('status');
              if (!mounted.current || round !== generation.current) return;
              if (!status.supported) { setPhase('unsupported'); return; }
              if (status.pending) { ticket.current = { instance: status.instance }; setPhase('waiting'); watch(); return; }
              const prepared = await api('prepare', {});
              if (!mounted.current || round !== generation.current) return;
              ticket.current = { ...prepared, expires: Date.now() + 55000 };
              setPhase('confirm');
            } catch (error) { if (mounted.current && round === generation.current) { setDetail(error.message); setPhase('error'); } }
          }
          function watch() {
            clearTimeout(poll.current);
            const round = generation.current;
            const deadline = Date.now() + 90000;
            async function check() {
              try {
                const status = await api('status');
                if (!mounted.current || round !== generation.current) return;
                if (status.instance && status.instance !== ticket.current?.instance) { window.location.reload(); return; }
              } catch (error) { /* Service downtime is expected; only a new instance confirms recovery. */ }
              if (!mounted.current || round !== generation.current) return;
              if (Date.now() >= deadline) { locked.current = false; setPhase('timeout'); return; }
              poll.current = setTimeout(check, 1200);
            }
            poll.current = setTimeout(check, 1000);
          }
          async function confirm() {
            if (locked.current || phase !== 'confirm') return;
            if (Date.now() >= ticket.current.expires) { setDetail(t('expired')); setPhase('error'); return; }
            locked.current = true; setPhase('waiting');
            try { await api('restart', { nonce: ticket.current.nonce, confirmed: true }); }
            catch (error) { if (mounted.current) setPhase('unknown'); }
            if (mounted.current) watch();
          }
          const busy = ['waiting', 'unknown'].includes(phase);
          const text = phase === 'confirm' ? t('warning') : phase === 'error' ? t('failed') + detail : phase === 'closed' ? '' : t(phase);
          return h(React.Fragment, null,
            h('style', null, style),
            h('button', { type: 'button', className: 'dsh-restart-trigger', title: t('label'), 'aria-label': t('label'), onClick: open },
              h('svg', { width: 20, height: 20, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, 'aria-hidden': true }, h('path', { d: 'M20 7v5h-5M19.1 12a7.2 7.2 0 1 0-1.8 5M20 12a8 8 0 0 0-2.5-6' })), wide && h('span', null, t('label'))),
            h('dialog', { ref: dialog, className: 'dsh-restart-dialog', 'aria-labelledby': 'dsh-restart-title', 'aria-describedby': 'dsh-restart-description', 'aria-busy': busy, 'data-shortcut-modal': 'dsh-restart', onCancel: e => { e.preventDefault(); close(); } },
              h('h2', { id: 'dsh-restart-title' }, phase === 'confirm' ? t('title') : t('label')),
              h('p', { id: 'dsh-restart-description', role: phase === 'error' ? 'alert' : 'status' }, text),
              h('div', { className: 'dsh-restart-actions' },
                h('button', { type: 'button', autoFocus: true, disabled: busy, onClick: close }, phase === 'confirm' ? t('cancel') : t('close')),
                phase === 'confirm' && h('button', { type: 'button', className: 'danger', onClick: confirm }, t('confirm')),
                phase === 'timeout' && h('button', { type: 'button', onClick: () => { locked.current = true; setPhase('waiting'); watch(); } }, t('check')))));
        }
        ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({ name: 'sidebar.footer.action', id: 'dsh-restart', order: 900 }, RestartButton));
      },
    };
  },
});
