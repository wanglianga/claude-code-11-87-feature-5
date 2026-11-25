// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';

// jsdom 未实现对象 URL，交付包释放下载会调用；这里给出安全桩
if (!URL.createObjectURL) {
  URL.createObjectURL = vi.fn(() => 'blob:mock-dcp');
}
if (!URL.revokeObjectURL) {
  URL.revokeObjectURL = vi.fn();
}

// 在 jsdom 中把 Worker 客户端替换为直接调用领域实现（Worker 本身由 vite build 单独打包验证）
vi.mock('./state/workerClient', () => ({
  workerApi: {
    compile: async (input: unknown) => {
      const { compileProjection } = await import('./domain/compiler');
      return compileProjection(input as never);
    },
    buildPackage: async (args: unknown) => {
      const { buildDeliveryPackage } = await import('./domain/package');
      return buildDeliveryPackage(args as never);
    },
    validate: async (pkg: unknown, ctx: unknown) => {
      const { validatePackage } = await import('./domain/validator');
      return validatePackage(pkg as never, ctx as never);
    },
  },
}));

import App from './App';
import { StoreProvider } from './state/store';

function renderApp() {
  return render(
    <StoreProvider>
      <App />
    </StoreProvider>,
  );
}

async function bodyMatches(re: RegExp, timeout = 8000) {
  await waitFor(
    () => {
      expect(document.body.textContent ?? '').toMatch(re);
    },
    { timeout, interval: 80 },
  );
}

async function clickButton(re: RegExp) {
  const btn = await screen.findByRole('button', { name: re });
  await waitFor(() => expect((btn as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(btn);
  return btn;
}

describe('浏览器全流程冒烟（jsdom + IndexedDB）', () => {
  beforeEach(() => {
    cleanup();
  });

  it('登录后完整推演题目剧本并遍历所有工作台', async () => {
    renderApp();

    // 1) 启动播种 → 登录页
    const loginBtn = await screen.findByRole('button', { name: /登录并进入控制台/ }, { timeout: 15000 });
    fireEvent.click(loginBtn);

    // 2) 进入场景页
    await screen.findByText(/端到端场景推演/, undefined, { timeout: 8000 });

    // 3) 投影自检
    await clickButton(/运行投影自检/);
    await bodyMatches(/施工方仅得到本标段\(B1\) 3 条缺陷/);
    expect(document.body.textContent).toMatch(/低于检出限/);

    // 3.5) 语义门禁：全量消费方（含错误消费者）→ 暂停交付 → 释放被拦截 → 只留合规消费方 → 通过 → 释放成功
    fireEvent.click(screen.getByRole('button', { name: /语义门禁/ }));
    await screen.findByText(/语义行为契约（机器可执行的不变量声明）/);
    await bodyMatches(/受控基准输入集/);
    expect(document.body.textContent).toMatch(/sb-2026\.1/);
    await clickButton(/运行语义交付门禁/);
    await bodyMatches(/DELIVERY_HOLD/);
    expect(document.body.textContent).toMatch(/暂停交付原因/);
    expect(document.body.textContent).toMatch(/单位误读消费方/);

    // 暂停交付期间，签名交付包释放闸门必须拦截（结构签名相同也不放行）
    fireEvent.click(screen.getByRole('button', { name: /签名交付包/ }));
    await bodyMatches(/物化并签名新包/);
    fireEvent.click((await screen.findAllByRole('button', { name: /复核并释放/ }))[0]);
    await bodyMatches(/语义交付门禁处于/, 10000);

    // 回到语义门禁，仅保留合规消费方后重跑 → 通过
    fireEvent.click(screen.getByRole('button', { name: /语义门禁/ }));
    // 选择器内 6 个复选框按 SIMULATED_CONSUMERS 顺序排列，第 1 个为合规消费方（保留）
    const consumerCheckboxes = screen.getAllByRole('checkbox');
    expect(consumerCheckboxes).toHaveLength(6);
    for (let i = 1; i < consumerCheckboxes.length; i++) {
      fireEvent.click(consumerCheckboxes[i]);
    }
    await clickButton(/运行语义交付门禁/);
    await bodyMatches(/PASS · 语义可交付/);

    // 门禁通过后释放成功（真实触发下载桩）
    fireEvent.click(screen.getByRole('button', { name: /签名交付包/ }));
    await bodyMatches(/物化并签名新包/);
    fireEvent.click((await screen.findAllByRole('button', { name: /复核并释放/ }))[0]);
    await bodyMatches(/已释放（第/, 10000);

    // 回到场景页继续剧本
    fireEvent.click(screen.getByRole('button', { name: /场景推演/ }));
    await screen.findByText(/端到端场景推演/);

    // 4) 离线写入固定ID意见
    await clickButton(/切离线并写入意见/);
    await bodyMatches(/状态 local-only/);

    // 5) 撤销许可
    await clickButton(/撤销施工方许可/);
    await bodyMatches(/许可已撤销/);

    // 6) 发布修订2
    await clickButton(/签署并发布修订2/);
    await bodyMatches(/当前修订 r2/);

    // 7) 联网同步合并 → 重审标记
    await clickButton(/恢复联网并同步合并/);
    await bodyMatches(/重审目标\s*r?2/, 10000);

    // 8) 旧包释放被拦截（修订 + 授权双重原因）
    await clickButton(/尝试释放旧的修订1包/);
    await bodyMatches(/已拦截：/, 10000);
    expect(document.body.textContent).toMatch(/报告已修订至 r2/);

    // 9) 传输回执不是语义确认
    await clickButton(/登记.?传输已收到/);
    await bodyMatches(/语义确认=false/);

    // 10) 确认 + 质疑 → 冲突 → 管理员裁定
    await clickButton(/登记语义确认/);
    await clickButton(/同时提出质疑/);
    await bodyMatches(/切换到管理员进行裁定/);
    await clickButton(/切换到管理员进行裁定/);
    await bodyMatches(/裁定：质疑成立（需重审）/);
    await clickButton(/裁定：质疑成立（需重审）/);
    await bodyMatches(/已裁定：质疑成立/);

    // 11) 编译工作台：真实走 mock worker 编译 + 校验
    fireEvent.click(screen.getByRole('button', { name: /交付编译/ }));
    await screen.findByText(/动态投影编译器/);
    await clickButton(/实时生成动态投影并校验/);
    await bodyMatches(/字段级过滤原因账本/, 10000);
    expect(document.body.textContent).toMatch(/包校验器实时报告/);

    // 12) 交付包页
    fireEvent.click(screen.getByRole('button', { name: /签名交付包/ }));
    await bodyMatches(/物化并签名新包/);
    expect(document.body.textContent).toMatch(/PKG_/);

    // 13) 离线审阅页（当前是管理员 → 切换施工方）
    fireEvent.click(screen.getByRole('button', { name: /离线审阅/ }));
    await bodyMatches(/审阅意见必须以施工方或监理/);
    await clickButton(/切换到施工方王建国/);
    await bodyMatches(/可审阅缺陷/);
    fireEvent.click(screen.getByRole('button', { name: /回执草案/ }));
    await bodyMatches(/新建回执草案/);

    // 14) 回执账页
    fireEvent.click(screen.getByRole('button', { name: /回执账/ }));
    await bodyMatches(/登记回执/);
    expect(document.body.textContent).toMatch(/冲突已裁定|冲突裁定队列/);

    // 15) 历史页三个子页签
    fireEvent.click(screen.getByRole('button', { name: /版本与审计/ }));
    await bodyMatches(/修订1 → 修订2 字段差异/);
    fireEvent.click(screen.getByRole('button', { name: /审阅意见历史/ }));
    await bodyMatches(/全部审阅意见/);
    fireEvent.click(screen.getByRole('button', { name: /审计账本/ }));
    await bodyMatches(/审计账本（/);
    expect(document.body.textContent).toMatch(/package_release_blocked/);

    // 16) 契约与授权页 + 模拟器
    fireEvent.click(screen.getByRole('button', { name: /契约与授权/ }));
    await bodyMatches(/字段契约注册表/);
    expect(document.body.textContent).toMatch(/授权六维交集模拟器/);
  }, 120000);

  it('刷新式重新挂载后 IndexedDB 数据仍在（持久化）', async () => {
    // 上一个用例已在同一个 fake-indexeddb 中完成全流程；重新渲染应直接进入已登录态（session 已持久化）
    renderApp();
    // session 中保存的是管理员（最后切换），因此直接看到侧边导航
    const nav = await screen.findAllByRole('button', { name: /场景推演/ }, { timeout: 15000 });
    expect(nav.length).toBeGreaterThan(0);
    await bodyMatches(/当前修订 r2|签署并发布修订2/);
  }, 30000);
});
