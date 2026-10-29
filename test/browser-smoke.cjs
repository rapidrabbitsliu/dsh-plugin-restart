const { readFileSync } = require('node:fs');
const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
(async () => {
  const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH || undefined });
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    let supported = true, restarts = 0;
    await page.route('http://restart.test/**', route => {
      const path = new URL(route.request().url()).pathname;
      if (path === '/') return route.fulfill({ contentType: 'text/html', body: '<html><body><div id="root"></div></body></html>' });
      if (path === '/dsh-restart/restart') {
        restarts++;
        assert.deepEqual(route.request().postDataJSON(), { nonce: 'ticket', confirmed: true });
        assert.equal(route.request().headers()['x-dsh-restart'], '1');
      }
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify(path.endsWith('/prepare') ? { nonce: 'ticket', instance: 'old' } : { supported, instance: 'old' }) });
    });
    await page.goto('http://restart.test/');
    await page.addScriptTag({ content: readFileSync(process.env.REACT_UMD, 'utf8') });
    await page.addScriptTag({ content: readFileSync(process.env.REACT_DOM_UMD, 'utf8') });
    await page.evaluate(() => {
      const dictionaries = {};
      window.stops = [];
      window.__ModuleLoader__ = { load(module) {
        const plugin = module.factory(name => { if (name === 'react') return window.React; throw new Error(name); });
        plugin.apply({
          effect(fn) { window.stops.push(fn()); },
          locale: { register(ns, lang, dict) { dictionaries[lang] = dict; return () => {}; }, subscribe: () => () => {}, getSnapshot: () => 'zh', bind: () => key => dictionaries.zh[key] },
          slots: { inject(name, fn) { window.stops.push(fn()); }, register(options, Component) {
            window.root = ReactDOM.createRoot(document.querySelector('#root'));
            root.render(React.createElement(Component, { wide: true }));
            return () => root.unmount();
          } },
        });
      } };
    });
    await page.addScriptTag({ content: readFileSync('client.js', 'utf8') });
    await page.getByRole('button', { name: '重启 DSH', exact: true }).click();
    await page.getByRole('button', { name: '确认重启', exact: true }).waitFor();
    assert.equal(restarts, 0);
    assert.equal(await page.evaluate(() => document.activeElement.textContent), '取消');
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('dialog').evaluate(e => e.open), false);
    assert.equal(restarts, 0);
    supported = false;
    await page.getByRole('button', { name: '重启 DSH', exact: true }).click();
    await page.getByText(/当前 DSH 未由重启包装器启动/).waitFor();
    assert.equal(await page.getByRole('button', { name: '确认重启', exact: true }).count(), 0);
    await page.getByRole('button', { name: '关闭', exact: true }).click();
    supported = true;
    await page.getByRole('button', { name: '重启 DSH', exact: true }).click();
    await page.getByRole('button', { name: '确认重启', exact: true }).click();
    await page.getByText('重启请求已提交，正在等待服务重新上线…').waitFor();
    assert.equal(restarts, 1);
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('dialog').evaluate(e => e.open), true);
    await page.evaluate(() => { for (const stop of stops.reverse()) stop?.(); });
    assert.equal(await page.locator('.dsh-restart-trigger').count(), 0);
    assert.deepEqual(errors, []);
    console.log('PASS browser: localized sidebar entry, cancel-focused native modal, Escape cancellation, unsupported host, confirmed one-shot POST, busy protection, disposal');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
