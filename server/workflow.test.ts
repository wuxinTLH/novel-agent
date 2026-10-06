import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { createServer } from 'node:net';
import { createServer as createHttpServer } from 'node:http';
import { createProject, starterProject } from './defaults.js';
import {
  buildContext,
  buildProtocolRequest,
  generate,
  parseProtocolResponse,
  Runner,
  SYSTEM_PROMPT,
} from './engine.js';
import { Store } from './store.js';
import type { Project } from '../shared/types.js';

test('context includes assets, upstream results, and only the latest three chapters', () => {
  const p = starterProject();
  const lore = p.steps.find((step) => step.id === 'lore')!;
  lore.output = 'UPSTREAM_LORE';
  lore.status = 'done';
  lore.generationContext = {
    runId: '',
    workflowId: p.activeWorkflowId!,
    number: 5,
    mode: 'create',
    requirements: { instructions: '', requiredText: [], forbiddenText: [] },
    graphRevision: p.workflow!.graphRevision || 0,
  };
  p.steps.find((step) => step.id === 'review')!.output = 'DOWNSTREAM_REVIEW';
  p.chapters = Array.from({ length: 4 }, (_, i) => ({
    id: String(i),
    number: i + 1,
    revision: 1,
    title: `Chapter ${i}`,
    content: `UNIQUE_CHAPTER_${i}`,
    mode: 'demo',
    updatedAt: '',
  }));
  const context = buildContext(p, 'outline');
  assert.match(context, /UPSTREAM_LORE/);
  assert.match(context, /沉钟港/);
  assert.doesNotMatch(context, /DOWNSTREAM_REVIEW|UNIQUE_CHAPTER_0/);
  assert.match(context, /UNIQUE_CHAPTER_3/);
});

test('interrupted runs recover on restart and cancellation preserves completed results', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'novel-store-'));
  try {
    const store = new Store(dir);
    const p = store.projects[0];
    p.run = { id: 'interrupted', status: 'running', mode: 'demo', startedAt: '' };
    p.steps[0].status = 'running';
    store.save();
    const recovered = new Store(dir);
    assert.equal(recovered.projects[0].run?.status, 'error');
    assert.equal(recovered.projects[0].steps[0].status, 'error');
    const runner = new Runner(recovered);
    const running = runner.run(recovered.projects[0], {
      baseUrl: '',
      model: '',
      apiKey: '',
      hasKey: false,
      mode: 'demo',
    });
    runner.controllers.get(p.id)!.abort();
    await running;
    assert.equal(recovered.projects[0].run?.status, 'cancelled');
    assert.equal(recovered.projects[0].chapters.length, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('model adapter sends context and handles provider failures without exposing response secrets', async () => {
  let responseStatus = 200;
  let captured: Record<string, unknown> = {};
  const server = createHttpServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    captured = JSON.parse(Buffer.concat(chunks).toString());
    assert.equal(req.url, '/v1/chat/completions');
    res.writeHead(responseStatus, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify(
        responseStatus === 200
          ? { choices: [{ message: { content: '模型测试输出' } }] }
          : { error: 'secret-provider-detail' },
      ),
    );
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address() as { port: number };
  const config = {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    model: 'test-model',
    apiKey: 'test-only-key',
    hasKey: true,
    mode: 'live' as const,
    protocol: 'chat-completions' as const,
  };
  try {
    assert.equal(
      await generate(createProject('测试'), 'lore', config, '', new AbortController().signal),
      '模型测试输出',
    );
    assert.equal(captured.model, 'test-model');
    const selected = createProject('资料选择测试');
    selected.assets = [
      {
        id: 'text',
        name: '使用的设定',
        category: 'world',
        content: 'SELECTED_TEXT',
        size: 13,
        createdAt: '',
      },
      {
        id: 'excluded-image',
        name: '未选中的图片',
        category: 'world',
        content: '',
        size: 1,
        mime: 'image/png',
        url: '/uploads/does-not-exist.png',
        createdAt: '',
      },
    ];
    selected.steps.find((step) => step.id === 'lore')!.assetIds = ['text'];
    assert.equal(await generate(selected, 'lore', config, '', new AbortController().signal), '模型测试输出');
    const userMessage = (captured.messages as { role: string; content: unknown }[]).find(
      (message) => message.role === 'user',
    )!;
    assert.equal(typeof userMessage.content, 'string');
    assert.match(userMessage.content as string, /SELECTED_TEXT/);
    assert.doesNotMatch(userMessage.content as string, /未选中的图片/);
    responseStatus = 401;
    await assert.rejects(
      generate(createProject('测试'), 'lore', config, '', new AbortController().signal),
      /HTTP 401/,
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('protocol adapters build official requests and parse nested text without leaking secrets', () => {
  const images = [{ mime: 'image/png', data: 'abc' }];
  const chat = buildProtocolRequest(
    {
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-4.1-mini',
      apiKey: 'secret',
      hasKey: true,
      mode: 'live',
      protocol: 'chat-completions',
    },
    '上下文',
    images,
  );
  assert.equal(chat.url, 'https://api.openai.com/v1/chat/completions');
  assert.equal(chat.headers.Authorization, 'Bearer secret');
  assert.equal(chat.body.max_tokens, 6000);
  assert.ok(!('max_output_tokens' in chat.body));
  const responses = buildProtocolRequest(
    {
      baseUrl: 'https://api.openai.com/v1/',
      model: 'gpt-4.1-mini',
      apiKey: 'secret',
      hasKey: true,
      mode: 'live',
      protocol: 'responses',
    },
    '上下文',
    images,
  );
  assert.equal(responses.url, 'https://api.openai.com/v1/responses');
  assert.equal(responses.body.instructions, SYSTEM_PROMPT);
  assert.equal(responses.body.max_output_tokens, 6000);
  assert.ok(!('messages' in responses.body));
  const anthropic = buildProtocolRequest(
    {
      baseUrl: 'https://api.anthropic.com',
      model: 'claude-opus-5',
      apiKey: 'secret',
      hasKey: true,
      mode: 'live',
      protocol: 'anthropic-messages',
    },
    '上下文',
    images,
  );
  assert.equal(anthropic.url, 'https://api.anthropic.com/v1/messages');
  assert.equal(anthropic.headers['x-api-key'], 'secret');
  assert.equal(anthropic.headers['anthropic-version'], '2023-06-01');
  assert.equal(anthropic.body.system, SYSTEM_PROMPT);
  assert.ok(!('temperature' in anthropic.body));
  assert.equal(parseProtocolResponse('responses', { output_text: '直接文本' }), '直接文本');
  assert.equal(
    parseProtocolResponse('responses', {
      output: [
        {
          content: [
            { type: 'output_text', text: '嵌套A' },
            { type: 'output_text', text: '嵌套B' },
          ],
        },
      ],
    }),
    '嵌套A\n嵌套B',
  );
  assert.equal(
    parseProtocolResponse('anthropic-messages', {
      content: [
        { type: 'text', text: '一' },
        { type: 'tool_use', name: 'x' },
        { type: 'text', text: '二' },
      ],
    }),
    '一二',
  );
  assert.equal(
    parseProtocolResponse('chat-completions', { choices: [{ message: { content: '旧协议默认' } }] }),
    '旧协议默认',
  );
});

test(
  'API supports projects, uploads, dependency checks, execution, editing and persistence',
  { timeout: 25000 },
  async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'novel-api-'));
    const probe = createServer();
    probe.listen(0, '127.0.0.1');
    await once(probe, 'listening');
    const port = (probe.address() as { port: number }).port;
    await new Promise<void>((resolve) => probe.close(() => resolve()));
    const child = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], {
      env: { ...process.env, PORT: String(port), DATA_DIR: dir, MODEL_API_KEY: '' },
      stdio: 'pipe',
    });
    let logs = '';
    child.stderr.on('data', (b) => {
      logs += b.toString();
    });
    let csrfToken = '';
    const request = async (
      url: string,
      method = 'GET',
      body?: unknown,
      extraHeaders: Record<string, string> = {},
    ) =>
      fetch(`http://127.0.0.1:${port}/api${url}`, {
        method,
        headers: {
          ...(body instanceof FormData ? {} : { 'Content-Type': 'application/json' }),
          ...(method !== 'GET' ? { 'X-Platform-CSRF': csrfToken } : {}),
        },
        body: body instanceof FormData ? body : body === undefined ? undefined : JSON.stringify(body),
      });
    try {
      let ready = false;
      for (let i = 0; i < 60; i++) {
        try {
          if ((await request('/health')).ok) {
            ready = true;
            break;
          }
        } catch {}
        await delay(100);
      }
      assert.ok(ready, logs);
      csrfToken = (await (await request('/platforms/session')).json()).csrfToken;
      let response = await request('/projects', 'POST', {
        title: '自动化测试',
        genre: '悬疑',
        description: '测试工作流',
      });
      assert.equal(response.status, 201);
      let p = (await response.json()) as Project;
      const url = `/projects/${p.id}`;
      response = await request(`${url}/run`, 'POST', { stepId: 'draft' });
      assert.equal(response.status, 400);
      const form = new FormData();
      form.append('category', 'world');
      form.append('files', new Blob(['北方是雪山，南方是海港。']), 'map.md');
      response = await request(`${url}/assets/upload`, 'POST', form);
      assert.equal(response.status, 201);
      p = (await response.json()) as Project;
      assert.match(p.assets[0].content, /雪山/);
      const assetId = p.assets[0].id;
      response = await request(`${url}/assets`, 'POST', {
        category: 'characters',
        name: '角色',
        content: '主角名为林夏。',
      });
      assert.equal(response.status, 201);
      const invalid = new FormData();
      invalid.append('category', 'world');
      invalid.append('files', new Blob(['bad']), 'script.exe');
      assert.equal((await request(`${url}/assets/upload`, 'POST', invalid)).status, 400);
      const exactText = new FormData();
      exactText.append('category', 'world');
      exactText.append('files', new Blob([Buffer.alloc(2 * 1024 * 1024, 0x61)]), 'exact.txt');
      assert.equal((await request(`${url}/assets/upload`, 'POST', exactText)).status, 201);
      const overText = new FormData();
      overText.append('category', 'world');
      overText.append('files', new Blob([Buffer.alloc(2 * 1024 * 1024 + 1, 0x61)]), 'over.txt');
      assert.equal((await request(`${url}/assets/upload`, 'POST', overText)).status, 413);
      const multibyte = '字'.repeat(Math.floor((2 * 1024 * 1024) / 3));
      assert.equal(
        (await request(`${url}/assets`, 'POST', { category: 'plot', name: '字节边界', content: multibyte }))
          .status,
        201,
      );
      assert.equal(
        (
          await request(`${url}/assets`, 'POST', {
            category: 'plot',
            name: '超出字节',
            content: `${multibyte}字`,
          })
        ).status,
        413,
      );
      const png = (bytes: number) => {
        const body = Buffer.alloc(bytes);
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(body);
        return new Blob([body]);
      };
      const exactImage = new FormData();
      exactImage.append('category', 'world');
      exactImage.append('files', png(4 * 1024 * 1024), 'exact.png');
      assert.equal((await request(`${url}/assets/upload`, 'POST', exactImage)).status, 201);
      const overImage = new FormData();
      overImage.append('category', 'world');
      overImage.append('files', png(4 * 1024 * 1024 + 1), 'over.png');
      assert.equal((await request(`${url}/assets/upload`, 'POST', overImage)).status, 413);
      response = await request(`${url}/run`, 'POST', {});
      assert.equal(response.status, 202);
      assert.equal((await request(`${url}/run`, 'POST', {})).status, 409);
      assert.equal(
        (await request(`${url}/assets`, 'POST', { category: 'plot', name: '锁测试', content: '不能修改' }))
          .status,
        409,
      );
      for (let i = 0; i < 65; i++) {
        p = (await (await request(url)).json()) as Project;
        if (p.run?.status !== 'running') break;
        await delay(100);
      }
      assert.equal(p.run?.status, 'done', p.run?.error);
      assert.equal(p.steps.filter((s) => s.status === 'done').length, p.steps.length);
      assert.equal(p.chapters.length, 1);
      assert.equal(p.chapters[0].mode, 'demo');
      response = await request(`${url}/chapters/${p.chapters[0].id}`, 'PATCH', {
        title: '章节新标题',
        content: p.chapters[0].content,
        expectedRevision: p.chapters[0].revision,
      });
      assert.equal(response.status, 200);
      p = (await response.json()) as Project;
      assert.ok(p.chapters[0].content.startsWith('章节新标题\n'));
      response = await request(`${url}/chapters/${p.chapters[0].id}`, 'PATCH', {
        title: '编辑后的章节',
        content: '保存后的正文',
        expectedRevision: p.chapters[0].revision,
      });
      assert.equal(response.status, 200);
      p = (await response.json()) as Project;
      assert.equal(p.chapters[0].content, '保存后的正文');
      assert.equal(p.steps.find((s) => s.id === 'draft')?.status, 'idle');
      assert.equal(p.steps.find((s) => s.id === 'draft')?.generationContext, undefined);
      assert.equal(p.steps.find((s) => s.id === 'review')?.status, 'idle');
      response = await request(`${url}/assets/${assetId}`, 'DELETE');
      p = (await response.json()) as Project;
      assert.equal(p.assets.length, 4);
      assert.ok(p.assets.some((asset) => asset.name === '角色'));
      assert.ok(!p.assets.some((asset) => asset.id === assetId));
      assert.equal(p.steps[0].status, 'idle');
      const persisted = new Store(dir);
      assert.equal(persisted.get(p.id)!.chapters[0].content, '保存后的正文');
      const settings = await (
        await request('/settings', 'PUT', {
          baseUrl: 'https://api.openai.com/v1',
          model: 'test',
          mode: 'live',
          apiKey: 'secret-test-key',
        })
      ).json();
      assert.equal(settings.hasKey, true);
      assert.equal(settings.apiKey, undefined);
      assert.equal(settings.protocol, 'chat-completions');
      const createdModel = await (
        await request('/models', 'POST', {
          name: 'Responses',
          baseUrl: 'https://api.openai.com/v1',
          model: 'gpt-4.1-mini',
          protocol: 'responses',
        })
      ).json();
      assert.equal(createdModel.protocol, 'responses');
      assert.equal(createdModel.apiKey, undefined);
      const chapterId = p.chapters[0].id;
      const deletedChapter = await request(`${url}/chapters/${chapterId}`, 'DELETE', {
        expectedRevision: p.chapters[0].revision,
      });
      assert.equal(deletedChapter.status, 200);
      p = (await deletedChapter.json()) as Project;
      assert.equal(p.chapters.length, 0);
      const custom = await request(`${url}/nodes`, 'POST', { title: '润色' });
      assert.equal(custom.status, 201);
      p = (await custom.json()) as Project;
      const customId = p.steps.find((s) => s.id.startsWith('node-'))!.id;
      const startId = p.workflow!.startNodeId!;
      const endId = p.workflow!.endNodeId!;
      response = await request(`${url}/nodes/${startId}`, 'DELETE');
      assert.equal(response.status, 400);
      p = (await (await request(url)).json()) as Project;
      assert.ok(p.steps.some((s) => s.id === startId));
      response = await request(`${url}/nodes`, 'DELETE', {
        nodeIds: [customId, endId],
        edgeIds: [],
      });
      assert.equal(response.status, 400);
      p = (await (await request(url)).json()) as Project;
      assert.ok(p.steps.some((s) => s.id === customId));
      response = await request(`${url}/nodes/${customId}`, 'DELETE');
      assert.equal(response.status, 200);
      p = (await response.json()) as Project;
      assert.equal(
        p.steps.some((s) => s.id === customId),
        false,
      );
      assert.equal(
        p.steps.some((s) => s.id === startId),
        true,
      );
      assert.equal(
        p.steps.some((s) => s.id === endId),
        true,
      );
      response = await request(`${url}/nodes`, 'DELETE', {
        nodeIds: [startId, endId],
        edgeIds: [],
      });
      assert.equal(response.status, 400);
      p = (await (await request(url)).json()) as Project;
      assert.equal(
        p.steps.some((s) => s.id === startId),
        true,
      );
      assert.equal(
        p.steps.some((s) => s.id === endId),
        true,
      );
      const createdWorkflow = await request(`${url}/workflows`, 'POST', {
        name: '第二工作流',
        template: true,
      });
      assert.equal(createdWorkflow.status, 201);
      p = (await createdWorkflow.json()) as Project;
      assert.ok((p.workflows?.length || 0) >= 2);
      const secondStart = p.workflow!.startNodeId!;
      const secondEnd = p.workflow!.endNodeId!;
      const secondOrdinary = p.steps.find((s) => s.id !== secondStart && s.id !== secondEnd)!.id;
      const ordinaryDeleted = await request(`${url}/nodes/${secondOrdinary}`, 'DELETE');
      assert.equal(ordinaryDeleted.status, 200);
      p = (await (await request(url)).json()) as Project;
      const emptied = await request(`${url}/nodes`, 'DELETE', {
        nodeIds: p.steps.filter((s) => s.id !== secondStart && s.id !== secondEnd).map((s) => s.id),
        edgeIds: [],
      });
      assert.equal(emptied.status, 200, JSON.stringify(await emptied.clone().json()));
      p = (await emptied.json()) as Project;
      assert.equal(p.steps.length, 2);
      assert.equal(p.workflow?.startNodeId, secondStart);
      assert.equal(p.workflow?.endNodeId, secondEnd);
      assert.equal((await request(`${url}/nodes/${secondStart}`, 'DELETE')).status, 400);
      const reloaded = new Store(dir).get(p.id)!;
      assert.equal(reloaded.steps.length, 2);
      assert.equal(reloaded.workflow?.startNodeId, secondStart);
      assert.equal(reloaded.workflow?.endNodeId, secondEnd);

      const secondProjectResponse = await request('/projects', 'POST', { title: '待删除作品' });
      assert.equal(secondProjectResponse.status, 201);
      const secondProject = (await secondProjectResponse.json()) as Project;
      const projectsBeforeDelete = (await (await request('/projects')).json()) as Project[];
      assert.equal(projectsBeforeDelete.length, 3);
      const deletedProjects = await request(`/projects/${secondProject.id}`, 'DELETE');
      assert.equal(deletedProjects.status, 200);
      const remainingProjects = (await deletedProjects.json()) as Project[];
      assert.equal(
        remainingProjects.some((item) => item.id === secondProject.id),
        false,
      );
      assert.equal((await request(`/projects/${secondProject.id}`)).status, 404);
      const remainingAfterCurrent = await request(`/projects/${p.id}`, 'DELETE');
      assert.equal(remainingAfterCurrent.status, 200);
      const onlyProject = (await remainingAfterCurrent.json()) as Project[];
      assert.equal(onlyProject.length, 1);
      assert.equal((await request(`/projects/${onlyProject[0].id}`, 'DELETE')).status, 400);
    } finally {
      child.kill();
      await once(child, 'exit');
      fs.rmSync(dir, { recursive: true, force: true });
    }
  },
);
