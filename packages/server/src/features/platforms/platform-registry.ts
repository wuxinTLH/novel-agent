import { randomUUID } from 'node:crypto';
import type { PlatformWork } from '../../../../../shared/platforms.js';
import type { PlatformStore } from './platform-store.js';
import {
  PlatformError,
  provider,
  unsupported,
  type DraftBrowserAdapter,
  type PlatformAdapter,
} from './platforms-types.js';

export function createPlatformRegistry(store: PlatformStore | undefined, browser: DraftBrowserAdapter) {
  const unavailable = [
    provider('qidian', '起点中文网', false, '未取得可核验的官方作者接口、应用资质及授权文档。接入须提供平台许可、测试账号、权限范围和回执规范；当前不提供 token/OAuth、作品或发布能力。'),
    provider('qimao', '七猫中文网', false, '未取得可核验的官方作者接口、应用资质及授权文档。接入须提供平台许可、测试账号、权限范围和回执规范；当前不提供 token/OAuth、作品或发布能力。'),
  ];
  const tomato = provider(
    'tomato',
    '番茄小说',
    true,
    '第三方本机辅助工具；人工登录并绑定作品后，save_draft 仅保存并全文回读草稿，submit_review 须单独批准和明确 AI 声明并核验送审回执，不代表审核通过或正式发布。扩展仅支持双确认配对；页面结构变化时失败关闭。',
    {
      manualLogin: browser.readiness === 'ready',
      extensionPairing: true,
      listWorks: browser.readiness === 'ready',
      getWork: browser.readiness === 'ready',
      syncWork: browser.readiness === 'ready',
      saveDraft: browser.readiness === 'ready',
      readDraft: browser.readiness === 'ready',
      deleteDraft: browser.readiness === 'ready',
    },
    browser.readiness,
  );
  for (const item of unavailable) item.readinessReason = item.description;
  tomato.authMethods = ['manual_browser', 'browser_extension'];
  tomato.readinessReason = `${browser.reason} 扩展配对不验证账号，不授予作品读取、草稿保存、送审或发布权限。正式发布能力保持关闭。`;
  const mock = provider(
    'mock',
    '本地 Mock 测试',
    true,
    '仅模拟作品管理，不连接真实账号，不产生真实草稿或发布记录。',
    {
      connectToken: true,
      listWorks: true,
      getWork: true,
      createWork: true,
      updateWork: true,
      syncWork: true,
    },
    'mock',
  );
  mock.authMethods = ['api_token'];
  const validate = (token: string) => {
    if (!token.trim()) throw new PlatformError(401, 'PLATFORM_REAUTH_REQUIRED', '请重新连接平台。');
    if (!store) throw new PlatformError(503, 'PLATFORM_STORAGE_UNAVAILABLE', '平台存储不可用。');
  };
  const adapters = new Map<string, PlatformAdapter>();
  for (const item of [...unavailable, tomato])
    adapters.set(item.id, {
      provider: item,
      async connect() {
        return unsupported(item, 'connectToken');
      },
      // Real browser operations exclusively pass through PlatformRuntime identity checks/locks.
      async listWorks() {
        return unsupported(item, 'listWorks');
      },
    });
  adapters.set('mock', {
    provider: mock,
    async connect(credential) {
      validate(credential.token);
      return { accountId: 'mock-author', accountName: 'Mock 测试作者' };
    },
    async listWorks(credential, connectionId) {
      validate(credential.token);
      return store!.works(connectionId);
    },
    async createWork(credential, input, connectionId) {
      validate(credential.token);
      const work: PlatformWork = {
        ...input,
        id: randomUUID(),
        providerId: 'mock',
        revision: '1',
        chapterCount: 0,
        updatedAt: new Date().toISOString(),
      };
      store!.putWork(connectionId, work);
      return work;
    },
    async updateWork(credential, work, input) {
      validate(credential.token);
      return {
        ...work,
        ...input,
        revision: String(Number(work.revision) + 1),
        updatedAt: new Date().toISOString(),
      };
    },
    async syncWork(credential, work) {
      validate(credential.token);
      return work;
    },
  });
  return {
    providers: () => structuredClone([...adapters.values()].map((a) => a.provider)),
    get(id: string) {
      const adapter = adapters.get(id);
      if (!adapter) throw new PlatformError(404, 'PLATFORM_NOT_FOUND', '平台不存在。');
      return adapter;
    },
  };
}
