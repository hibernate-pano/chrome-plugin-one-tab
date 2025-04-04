import React from 'react';
import { Header } from '@/components/layout/Header';
import { TabList } from '@/components/tabs/TabList';
import { SearchBar } from '@/components/search/SearchBar';

const App: React.FC = () => {
  return (
    <div className="w-[800px] h-[600px] bg-white dark:bg-gray-900">
      <Header />
      <main className="p-4">
        <SearchBar />
        <TabList />
      </main>
    </div>
  );
};

export default App; 