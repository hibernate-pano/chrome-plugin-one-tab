import { store } from '../store';
import { updateWechatLoginStatus } from '../store/slices/authSlice';

// 测试微信登录状态更新
describe('WeChat Login', () => {
  beforeEach(() => {
    // 重置状态
    store.dispatch(updateWechatLoginStatus({ status: 'idle' }));
  });

  test('should update WeChat login status correctly', () => {
    // 初始状态
    let state = store.getState().auth;
    expect(state.wechatLoginStatus).toBe('idle');

    // 更新为等待扫码状态
    store.dispatch(updateWechatLoginStatus({ 
      status: 'pending',
      tabId: 123
    }));
    
    state = store.getState().auth;
    expect(state.wechatLoginStatus).toBe('pending');
    expect(state.wechatLoginTabId).toBe(123);

    // 更新为扫码中状态
    store.dispatch(updateWechatLoginStatus({ status: 'scanning' }));
    
    state = store.getState().auth;
    expect(state.wechatLoginStatus).toBe('scanning');
    expect(state.wechatLoginTabId).toBe(123); // tabId应该保持不变

    // 更新为确认中状态
    store.dispatch(updateWechatLoginStatus({ status: 'confirming' }));
    
    state = store.getState().auth;
    expect(state.wechatLoginStatus).toBe('confirming');

    // 更新为成功状态
    store.dispatch(updateWechatLoginStatus({ status: 'success' }));
    
    state = store.getState().auth;
    expect(state.wechatLoginStatus).toBe('success');

    // 更新为失败状态，并带有错误信息
    store.dispatch(updateWechatLoginStatus({ 
      status: 'failed',
      error: '用户取消登录'
    }));
    
    state = store.getState().auth;
    expect(state.wechatLoginStatus).toBe('failed');
    expect(state.error).toBe('用户取消登录');
  });

  test('should handle expired status correctly', () => {
    // 更新为过期状态
    store.dispatch(updateWechatLoginStatus({ 
      status: 'expired',
      error: '登录超时'
    }));
    
    const state = store.getState().auth;
    expect(state.wechatLoginStatus).toBe('expired');
    expect(state.error).toBe('登录超时');
  });
});
