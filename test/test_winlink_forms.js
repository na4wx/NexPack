#!/usr/bin/env node
// Real end-to-end coverage of PatManager's Winlink Standard Forms support
// (ICS-213, radiograms, etc.) — verified against the real bundled pat
// binary and the real official form templates downloaded from winlink.org
// (same CDN pat's own `templates update` uses), not mocked. The exact
// mechanism (GET /api/formcatalog, POST /api/formsUpdate, GET /api/forms,
// the "forminstance" cookie correlating a form's own real <form
// method="post" action="/api/form?..."> submission with a later GET
// /api/form poll) was reverse-engineered by running the real binary and
// reading its actual bundled web GUI's JS — see PatManager.js's own
// comment above these methods for the full write-up.
const assert = require('assert');
const os = require('os');
const fs = require('fs');
const path = require('path');
const PatManager = require('../electron/main/winlink/PatManager');

let pass = 0, fail = 0;
async function test(name, fn) {
  try { await fn(); console.log(`✅ PASS: ${name}`); pass++; }
  catch (e) { console.error(`❌ FAIL: ${name}\n   ${e.stack || e.message}`); fail++; }
}

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexpack-winlink-forms-test-'));
  const mgr = new PatManager({ userDataDir: dir });
  await mgr.saveSettings({ callsign: 'N0CALL', winlinkPassword: '', connectAliases: {} });
  await mgr.start();

  let icsFormPath = null;

  try {
    await test('updateForms() downloads the real official template set from winlink.org', async () => {
      const result = await mgr.updateForms();
      assert.strictEqual(result.action, 'update', `expected a fresh download on an empty forms dir, got: ${JSON.stringify(result)}`);
    });

    await test('listFormCatalog() returns the real downloaded catalog, with real categories and forms', async () => {
      const catalog = await mgr.listFormCatalog();
      assert.ok(catalog.form_count > 100, `expected a substantial real form library, got form_count=${catalog.form_count}`);
      assert.ok(Array.isArray(catalog.folders) && catalog.folders.length > 5, 'expected real category folders');
      // Find a real, well-known form (ICS-213) anywhere in the tree.
      const find = (node) => {
        for (const f of node.forms || []) if (/ics213/i.test(f.template_path.replace(/[ -]/g, ''))) return f;
        for (const sub of node.folders || []) { const found = find(sub); if (found) return found; }
        return null;
      };
      const ics213 = find(catalog);
      assert.ok(ics213, 'expected to find a real ICS-213 form in the official catalog');
      icsFormPath = ics213.template_path;
    });

    await test('formUrl() + a real request to it renders the actual, real HTML form (not a stub)', async () => {
      const res = await fetch(mgr.formUrl(icsFormPath));
      assert.strictEqual(res.status, 200);
      const html = await res.text();
      assert.ok(html.length > 5000, 'expected a substantial real rendered form page');
      assert.ok(/<input|<textarea/i.test(html), 'expected real form fields in the rendered HTML');
      assert.ok(new RegExp(`action="/api/form\\?template=`).test(html), 'the real form should submit back to pat\'s own /api/form endpoint');
    });

    await test('getFormResult() returns null (not an error) before anything has been submitted', async () => {
      const result = await mgr.getFormResult('999999999');
      assert.strictEqual(result, null);
    });

    await test('a real form submission (matching the real <form> in the rendered HTML) is correctly retrievable via getFormResult() with the matching forminstance cookie', async () => {
      const forminstanceId = '424242';
      const form = new FormData();
      form.append('MsgSubject', 'Test ICS-213 subject');
      form.append('FormData', 'test form body content from the automated test');
      // The real rendered form's own <form action="..."> posts to the
      // SINGULAR /api/form (not /api/forms, which only ever renders the
      // form for GET) — this is what the browser does automatically when
      // the user clicks Submit; formUrl() is only for the GET side.
      const postRes = await fetch(`${mgr._url('/api/form')}?template=${encodeURIComponent(icsFormPath)}`, {
        method: 'POST',
        headers: { Cookie: `forminstance=${forminstanceId}` },
        body: form
      });
      assert.strictEqual(postRes.status, 200);
      const postText = await postRes.text();
      assert.ok(/window\.close\(\)/.test(postText), 'a real successful form submission should tell the window to close itself');

      const result = await mgr.getFormResult(forminstanceId);
      assert.ok(result, 'expected a composed message result');
      assert.ok('msg_body' in result && 'msg_subject' in result, 'expected the real msg_* fields the Compose dialog is pre-filled from');
    });

    await test('getFormResult() for a DIFFERENT forminstance id still returns null — results are correctly isolated per form instance', async () => {
      const result = await mgr.getFormResult('111111111');
      assert.strictEqual(result, null);
    });
  } finally {
    console.log(`\nTests passed: ${pass}`);
    console.log(`Tests failed: ${fail}`);
    await mgr.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => { console.error('TEST FAILED:', e); process.exit(1); });
