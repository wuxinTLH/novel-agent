import type { Translator } from '../../locals/core';
import { ApiError } from '../../services/api';

// Only known system-owned fields are passed here; user-authored content is never translated.
const systemKeys = [
  "起点中文网",
  "七猫中文网",
  "番茄小说",
  "本地 Mock 测试",
  "未取得可核验的官方作者接口、应用资质及授权文档。接入须提供平台许可、测试账号、权限范围和回执规范；当前不提供 token/OAuth、作品或发布能力。",
  "第三方本机辅助工具；人工登录并绑定作品后，save_draft 仅保存并全文回读草稿，submit_review 须单独批准和明确 AI 声明并核验送审回执，不代表审核通过或正式发布。扩展仅支持双确认配对；页面结构变化时失败关闭。",
  "仅模拟作品管理，不连接真实账号，不产生真实草稿或发布记录。",
  "已实现基于番茄作者页的人工登录、作品读取、草稿编辑器写入、回读核验和远端草稿删除；页面结构变化时会失败关闭。",
  "扩展配对不验证账号，不授予作品读取、草稿保存、送审或发布权限。正式发布能力保持关闭。",
  "在番茄标签页打开扩展，输入配对码并明确批准，然后返回本应用确认扩展 ID。",
  "扩展会话已断开或到期；请重新配对。",
  "扩展已批准，尚未配对。请核对扩展 ID 与标签页编号并在应用确认。",
  "应用已确认，请返回扩展点击完成配对。配对不等于账号验证。",
  "扩展已配对；账号身份、作品读取和草稿保存仍待真实页面核验。",
  "扩展配对已撤销。",
  "请在独立浏览器内自行登录，不要在应用中输入密码或 Cookie。窗口保持打开直到手动关闭或服务停止；核验后每五分钟只读刷新登录态。",
  "账号身份已核验，会话已保存。",
  "人工登录已关闭；没有上传章节。",
  "确认后才允许打开可能自动存稿的编辑器并填写本章。仅保存草稿，不正式发布。语义和风格要求仍需作者确认。",
  "平台存储或密钥不可用，请检查 PLATFORM_SECRETS_KEY 与数据文件；原文件不会被覆盖。写作功能仍可使用。",
  "已实现基于番茄作者页的人工登录、作品读取、草稿编辑器写入、回读核验和远端草稿删除；页面结构变化时会失败关闭。 扩展配对不验证账号，不授予作品读取、草稿保存、送审或发布权限。正式发布能力保持关闭。"
] as const;
const errorKeys = {
  "PLATFORM_ORPHAN_UNKNOWN": "此账号作品有已删除作品保留的未知平台记录，禁止新增远端写入。",
  "PLATFORM_BUSY": "平台任务正在进行，请先核对状态。",
  "PLATFORM_REAUTH_REQUIRED": "平台登录已失效，请重新人工登录。",
  "PLATFORM_ACCOUNT_MISMATCH": "平台账号不匹配，操作已阻止。",
  "PLATFORM_LOGIN_CLOSED": "人工登录已关闭。",
  "PLATFORM_LOCK_UNAVAILABLE": "无法取得平台账号锁；请核对运行状态。",
  "PLATFORM_PAGE_LOAD_FAILED": "平台页面加载失败；未自动重试。",
  "PLATFORM_DOM_MISMATCH": "平台页面结构不匹配，操作已安全停止。",
  "PLATFORM_DOM_VERIFICATION_REQUIRED": "平台页面需要人工核验。",
  "PLATFORM_WORK_NOT_FOUND": "平台作品不存在或无法读取。",
  "PLATFORM_BINDING_CHANGED": "作品绑定已变化，请重新预览。",
  "PLATFORM_PREVIEW_CHANGED": "预览已变化，请重新核对批准。",
  "PUBLICATION_REMOTE_CHANGED": "远端内容已变化，请只读核对后重新预览。",
  "PROJECT_RUNNING": "工作流运行中，平台操作暂时停用。",
  "EXTENSION_AUTH_MODE_UNSUPPORTED": "当前运行模式不支持浏览器扩展配对。"
} as const;
export function platformSystemText(t: Translator, message: string, code?: string): string {
  const errorKey = code && Object.prototype.hasOwnProperty.call(errorKeys, code) ? errorKeys[code as keyof typeof errorKeys] : undefined;
  if (errorKey) return t(errorKey);
  const key = systemKeys.find(key => key === message);
  return key ? t(key) : message;
}
export function platformErrorText(t: Translator, error: unknown, fallback: Parameters<Translator>[0]): string {
  return error instanceof Error ? platformSystemText(t, error.message, error instanceof ApiError ? error.code : undefined) : t(fallback);
}
