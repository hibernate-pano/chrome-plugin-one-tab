import React, { useState, useEffect, useCallback, Suspense, useDeferredValue } from 'react';
import { Header } from '@/components/layout/Header';
import { TabList } from '@/components/tabs/TabList';
import { useAppDispatch } from '@/store/hooks';
import { loadSettings } from '@/store/slices/settingsSlice';
import { OnboardingGuide } from '@/components/onboarding/OnboardingGuide';
import { shouldShowOnboarding } from '@/utils/onboardingStorage';
import { getAppVersionLabel } from '@/utils/runtimeInfo';
import { AuthModal, AuthTab } from '@/components/auth/AuthModal';
import { useSearchFilters } from '@/components/search/useSearchFilters';

// 导入样式文件
import '@/styles/drag-drop.css';
import '@/styles/animations.css';

/**
 * 主应用组件
 * 负责应用的主要布局和功能
 */
export const MainApp: React.FC = () => {
  const dispatch = useAppDispatch();
  const [searchQuery, setSearchQuery] = useState('');
  const [showOnboarding, setShowOnboarding] = useState(false);
  const deferredSearchQuery = useDeferredValue(searchQuery);

  // 加载用户设置
  useEffect(() => {
    dispatch(loadSettings());
  }, [dispatch]);

  // 检查是否需要显示用户引导
  useEffect(() => {
    shouldShowOnboarding().then(should => {
      if (should) {
        setShowOnboarding(true);
      }
    });
  }, []);

  // 统一使用相同宽度，单栏和双栏布局保持一致
  const getContainerWidthClass = () => {
    return 'layout-double-width';
  };

  // ── 2026-10-20 审计 B-2：用户要能「重看引导」 ──────────────────────────
  // 引导是**一次性**的：跳过后就再也回不去了（onboarding_state 写了
  // hasCompletedOnboarding，但那个字段**从来没有被读过** —— 仓库里
  // grep 不到任何读取点）。用户跳过的常见理由是「现在没空」，
  // 而不是「我不需要」—— 过了两天他想知道「那个云端同步怎么开」，
  // 却没有入口。
  //
  // 所以 ⋯ 菜单里加一项「使用引导」。点了就重放**同一套**引导
  // （OnboardingGuide 组件，不复制一份），走完照常记完成状态。
  const handleReplayOnboarding = useCallback(() => {
    setShowOnboarding(true);
  }, []);

  // ── 2026-10-22 审计 L-11：登录弹窗提升到 MainApp ──────────────────────
  // 弹窗原先寄生在 Header 里 ⇒ **只有顶栏这一个地方能开它**。
  // 而空态（一个会话都没有）需要给「登录 TapStack 云端」一个出口：
  // 换设备的老用户打开扩展看到的是一片空白，
  // 他最该做的那一步（登录 → 自动拉回云端会话）当时无处可点。
  //
  // 提升到 MainApp 后，Header 与空态共用**同一个**弹窗实例 ——
  // 不会出现两个 portal、两个焦点陷阱。
  const [authModal, setAuthModal] = useState<AuthTab | null>(null);
  const handleOpenAuth = useCallback((tab: AuthTab) => {
    setAuthModal(tab);
  }, []);

  // ── 2026-10-22 审计 P1-8：筛选状态**提升到应用层** ──────────────────────
  // 筛选条件原先住在列表层（TabList 里的 useSearchFilters），而顶栏那个
  // 「回到默认视图」的按钮**只清搜索词** ⇒ 它清不掉筛选条件，
  // 而按钮上写的是「回到默认视图」，承诺比兑现多。
  //
  // 症状最刺眼的一种：用户从没输过关键词，只靠筛选在看列表，这时点 Logo
  // ⇒ setSearchValue('') 写回一个本来就是 '' 的值 ⇒ React bail out
  // ⇒ 零 DOM 变化、零提示，界面看起来像**按钮坏了**。
  //
  // 提升到 MainApp 后，Header（清筛选）与 TabList（渲染筛选面板/结果）
  // 拿到的是**同一份**状态，Logo 这一次真的能回到默认视图。
  const filterControls = useSearchFilters();

  return (
    <Suspense
      fallback={
        <div className="app-shell theme-shell min-h-screen dark:text-gray-100 flex flex-col items-center justify-center">
          加载中...
        </div>
      }
    >
      <div className="app-shell theme-shell min-h-screen dark:text-gray-100 flex flex-col">
          <>
            <a href="#tapstack-main" className="skip-to-content">
              跳到会话列表
            </a>
            <Header
              onSearch={setSearchQuery}
              onReplayOnboarding={handleReplayOnboarding}
              onOpenAuth={handleOpenAuth}
              onResetFilters={filterControls.clearFilters}
            />
            <main id="tapstack-main" className={`flex-1 w-full py-3 sm:py-4 ${getContainerWidthClass()}`} tabIndex={-1}>
              <Suspense fallback={<div className="p-4 text-center">加载标签列表...</div>}>
                <TabList
                  searchQuery={deferredSearchQuery}
                  onOpenAuth={handleOpenAuth}
                  filterControls={filterControls}
                />
              </Suspense>
            </main>
              {/* 2026-10-20 审计 D-1：页脚版本号是 12px 小字，硬编码的
                  text-gray-600 / dark:text-gray-400 不跟主题走，在 6 套主题里
                  实测只有 2.43–3.67:1（低于 WCAG AA 的 4.5:1）。
                  改用主题令牌 theme-text-muted（各主题实测 ≥4.5:1）。
                  注意：Tailwind 的 dark: 变体特异性(0,3,0)会盖过 .theme-text-muted
                  (0,1,0)，所以硬编码灰阶必须整段删掉，而不是"再补一个主题类"。 */}
              <footer className="app-shell theme-shell border-t theme-border-default text-xs theme-text-muted">
                {/* 弱信息收进右下小字：版本号低优先级，不占整行居中 */}
                <div className={`w-full py-1.5 ${getContainerWidthClass()} flex justify-end items-center`}>
                  <span className="tab-group-time" title="TapStack 版本">TapStack {getAppVersionLabel()}</span>
                </div>
              </footer>
            </>
        </div>

      {/* 用户引导弹窗 */}
      {showOnboarding && (
        <OnboardingGuide onComplete={() => setShowOnboarding(false)} />
      )}

      {/* ── 2026-10-22 审计 L-11：登录 / 注册弹窗（应用级，portal 到 body）──
          原本挂在 Header 内部（`<AuthModal>` 在 header 末尾）。
          AuthModal 自己 portal 到 body，所以**放在哪一层都不影响定位** ——
          而放在 MainApp 才让空态也能开它（见上方 handleOpenAuth 注释）。 */}
      <AuthModal
        visible={authModal !== null}
        initialTab={authModal ?? 'login'}
        onClose={() => setAuthModal(null)}
      />
    </Suspense>
  );
};
