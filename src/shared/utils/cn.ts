/**
 * Tailwind CSS类名合并工具
 * 智能合并和去重CSS类名
 */
import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}