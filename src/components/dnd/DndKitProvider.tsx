import React from 'react';
import { DndContext, DndContextProps } from '@dnd-kit/core';

interface DndKitProviderProps extends Omit<DndContextProps, 'children'> {
  children: React.ReactNode;
}

export const DndKitProvider: React.FC<DndKitProviderProps> = ({ children, ...props }) => {
  return (
    <DndContext {...props}>
      {children}
    </DndContext>
  );
};
