import React, { useState } from 'react';
import { Header } from '@/components/layout/Header';
import { TabList } from '@/components/tabs/TabList';

const App: React.FC = () => {
  const [searchQuery, setSearchQuery] = useState('');

  return (
    <div className="w-[800px] h-[600px] bg-white dark:bg-gray-900">
      <Header onSearch={setSearchQuery} />
      <main className="p-4">
        <TabList searchQuery={searchQuery} />
      </main>
    </div>
  );
};

export default App;
