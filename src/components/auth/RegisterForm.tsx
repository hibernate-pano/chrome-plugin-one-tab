import React, { useState } from 'react';
import { useAppDispatch, useAppSelector } from '@/store/hooks';
import { signUp, signIn, clearError } from '@/store/slices/authSlice';

export const RegisterForm: React.FC = () => {
  const dispatch = useAppDispatch();
  const { isLoading, error } = useAppSelector(state => state.auth);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [passwordError, setPasswordError] = useState('');

  const [isRegistering, setIsRegistering] = useState(false);
  const [registrationSuccess, setRegistrationSuccess] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (password !== confirmPassword) {
      setPasswordError('两次输入的密码不一致');
      return;
    }

    setPasswordError('');
    setIsRegistering(true);

    try {
      if (email && password) {
        // 注册用户
        const result = await dispatch(signUp({ email, password })).unwrap();

        if (result) {
          setRegistrationSuccess(true);
          // 自动登录
          await dispatch(signIn({ email, password }));
        }
      }
    } catch (error) {
      console.error('注册失败:', error);
    } finally {
      setIsRegistering(false);
    }
  };

  return (
    <div className="p-4">
      <h2 className="text-xl font-bold mb-4">注册</h2>
      {registrationSuccess && (
        <div className="bg-green-100 border border-green-400 text-green-700 px-4 py-3 rounded mb-4">
          注册成功！正在自动登录...
        </div>
      )}
      {error && (
        <div className="bg-red-100 border border-red-400 text-red-700 px-4 py-3 rounded mb-4">
          {error}
          <button
            className="float-right"
            onClick={() => dispatch(clearError())}
          >
            &times;
          </button>
        </div>
      )}
      {passwordError && (
        <div className="bg-red-100 border border-red-400 text-red-700 px-4 py-3 rounded mb-4">
          {passwordError}
          <button
            className="float-right"
            onClick={() => setPasswordError('')}
          >
            &times;
          </button>
        </div>
      )}
      <form onSubmit={handleSubmit}>
        <div className="mb-4">
          <label className="block text-sm font-medium mb-1">邮箱</label>
          <input
            type="email"
            className="w-full px-3 py-2 border rounded"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />
        </div>
        <div className="mb-4">
          <label className="block text-sm font-medium mb-1">密码</label>
          <input
            type="password"
            className="w-full px-3 py-2 border rounded"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
        </div>
        <div className="mb-4">
          <label className="block text-sm font-medium mb-1">确认密码</label>
          <input
            type="password"
            className="w-full px-3 py-2 border rounded"
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            required
          />
        </div>
        <button
          type="submit"
          className="w-full bg-blue-500 text-white py-2 rounded hover:bg-blue-600"
          disabled={isLoading || isRegistering}
        >
          {isLoading || isRegistering ? '处理中...' : '注册'}
        </button>
      </form>
    </div>
  );
};
