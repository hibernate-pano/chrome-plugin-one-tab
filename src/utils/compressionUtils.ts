import * as LZString from 'lz-string';
import { TabGroup } from '@/types/tab';

/**
 * 压缩统计信息接口
 */
export interface CompressionStats {
  originalSize: number;
  compressedSize: number;
  compressionRatio: number;
  compressionTime: number;
}

/**
 * 压缩数据
 * @param data 要压缩的数据
 * @returns 压缩后的字符串和压缩统计信息
 */
export function compressData<T>(data: T): { compressed: string; stats: CompressionStats } {
  const startTime = performance.now();
  
  // 将数据转换为JSON字符串
  const jsonString = JSON.stringify(data);
  const originalSize = new Blob([jsonString]).size;
  
  // 压缩数据
  const compressed = LZString.compressToUTF16(jsonString);
  const compressedSize = new Blob([compressed]).size;
  
  const endTime = performance.now();
  
  // 计算压缩统计信息
  const stats: CompressionStats = {
    originalSize,
    compressedSize,
    compressionRatio: (compressedSize / originalSize) * 100,
    compressionTime: endTime - startTime,
  };
  
  return { compressed, stats };
}

/**
 * 解压数据
 * @param compressed 压缩后的字符串
 * @returns 解压后的数据
 */
export function decompressData<T>(compressed: string): T {
  // 解压数据
  const jsonString = LZString.decompressFromUTF16(compressed);
  if (!jsonString) {
    throw new Error('解压数据失败');
  }
  
  // 将JSON字符串转换回对象
  return JSON.parse(jsonString) as T;
}

/**
 * 压缩标签组数据
 * @param groups 标签组数组
 * @returns 压缩后的字符串和压缩统计信息
 */
export function compressTabGroups(groups: TabGroup[]): { compressed: string; stats: CompressionStats } {
  return compressData(groups);
}

/**
 * 解压标签组数据
 * @param compressed 压缩后的字符串
 * @returns 解压后的标签组数组
 */
export function decompressTabGroups(compressed: string): TabGroup[] {
  return decompressData<TabGroup[]>(compressed);
}

/**
 * 格式化压缩统计信息为可读字符串
 * @param stats 压缩统计信息
 * @returns 格式化后的字符串
 */
export function formatCompressionStats(stats: CompressionStats): string {
  const originalSizeKB = (stats.originalSize / 1024).toFixed(2);
  const compressedSizeKB = (stats.compressedSize / 1024).toFixed(2);
  const savingsPercent = (100 - stats.compressionRatio).toFixed(2);
  
  return `原始大小: ${originalSizeKB} KB, 压缩后: ${compressedSizeKB} KB, 节省: ${savingsPercent}%, 耗时: ${stats.compressionTime.toFixed(2)}ms`;
}
