import React, { useState } from 'react';
import { useAppSelector } from '@/store/hooks';
import { LoginForm } from './LoginForm';
import { RegisterForm } from './RegisterForm';
import { UserProfile } from './UserProfile';

export const AuthContainer: React.FC = () => {
  const { isAuthenticated } = useAppSelector(state => state.auth);
  const [activeTab, setActiveTab] = useState<'login' | 'register'>('login');
  
  if (isAuthenticated) {
    return <UserProfile />;
  }
  
  return (
    <div className="border-b">
      <div className="flex border-b">
        <button
          className={`flex-1 py-2 ${activeTab === 'login' ? 'border-b-2 border-blue-500' : ''}`}
          onClick={() => setActiveTab('login')}
        >
          登录
        </button>
        <button
          className={`flex-1 py-2 ${activeTab === 'register' ? 'border-b-2 border-blue-500' : ''}`}
          onClick={() => setActiveTab('register')}
        >
          注册
        </button>
      </div>
      {activeTab === 'login' ? <LoginForm /> : <RegisterForm />}
    </div>
  );
};
