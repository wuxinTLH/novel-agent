import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { hasPermission } from '../../../../../shared/permissions';
const source = readFileSync(new URL('./SiteAppearancePanel.tsx', import.meta.url), 'utf8');
const administration = readFileSync(new URL('./Administration.tsx', import.meta.url), 'utf8');

test('appearance tab and component are explicitly permission gated with local superadmin compatibility', () => {
  assert.match(administration, /appearance: 'appearance.manage'/);
  assert.match(administration, /appearanceOpened && allowed\('appearance.manage'\) &&/);
  assert.equal(hasPermission('superadmin', 'appearance.manage'), true);
  assert.equal(hasPermission('admin', 'appearance.manage'), true);
  assert.equal(hasPermission('operations', 'appearance.manage'), false);
  assert.equal(hasPermission('writer', 'appearance.manage'), false);
  assert.match(administration, /mode === 'local'\s*\? 'superadmin'/);
  assert.match(administration, /dirty=\{databaseDirty \|\| securityDirty \|\| appearanceDirty\}/);
});
test('CAS conflict retains edits, blocks resubmission and requires explicit confirmed reload', () => {
  assert.match(source, /expectedRevision: draft.revision/);
  assert.match(source, /reason.status === 409/);
  assert.match(source, /setConflict\(stale\); setError/);
  assert.match(source, /disabled=\{busy \|\| expired \|\| conflict \|\| !dirty\}/);
  assert.match(source, /dirty && !\(await confirm\(t\('重新载入将丢弃尚未保存的外观编辑，确定继续吗？'\)\)\)/);
  const failure = source.slice(source.indexOf('} catch (reason)'), source.indexOf('} finally {', source.indexOf('} catch (reason)')));
  assert.doesNotMatch(failure, /setDraft|setSaved|publishSiteAppearance/);
});
test('aborts and authority changes suppress late results; successful save updates shared navigation only after validation', () => {
  assert.match(source, /controller.current\?\.abort\(\)/);
  assert.match(source, /novel-auth-expired/);
  assert.match(source, /event.key === 'novel-auth-identity'/);
  assert.match(source, /if \(request.signal.aborted \|\| invalid.current\) return/);
  assert.match(source, /if \(!isSiteAppearance\(value\)\) throw/);
  assert.match(source, /publishSiteAppearance\(value\)/);
  assert.doesNotMatch(source, /dangerouslySetInnerHTML|localStorage|sessionStorage/);
});
