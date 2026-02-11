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
    <div className="bg-gray-50 dark:bg-gray-800 border-t border-gray-200 dark:border-gray-700">
      <div className="container mx-auto max-w-6xl">
        <div className="flex border-b border-gray-200 dark:border-gray-700">
          <button
            className={`px-6 py-3 transition-all font-medium flat-interaction ${activeTab === 'login' ? 'text-primary-600 dark:text-primary-400 border-b-2 border-primary-600 dark:border-primary-400' : 'text-gray-600 dark:text-gray-300 hover:text-primary-600 dark:hover:text-primary-400'}`}
            onClick={() => setActiveTab('login')}
          >
            登录
          </button>
          <button
            className={`px-6 py-3 transition-all font-medium flat-interaction ${activeTab === 'register' ? 'text-primary-600 dark:text-primary-400 border-b-2 border-primary-600 dark:border-primary-400' : 'text-gray-600 dark:text-gray-300 hover:text-primary-600 dark:hover:text-primary-400'}`}
            onClick={() => setActiveTab('register')}
          >
            注册
          </button>
        </div>
        <div className="py-6 px-4">
          {activeTab === 'login' ? <LoginForm /> : <RegisterForm />}
        </div>
      </div>
    </div>
  );
};
