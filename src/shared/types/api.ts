/**
 * API相关类型定义
 * 提供类型安全的API客户端和请求/响应类型
 */

import { ApiResponse, PaginationParams, PaginatedResult } from './common';

/**
 * HTTP方法枚举
 */
export enum HttpMethod {
  GET = 'GET',
  POST = 'POST',
  PUT = 'PUT',
  PATCH = 'PATCH',
  DELETE = 'DELETE',
  HEAD = 'HEAD',
  OPTIONS = 'OPTIONS'
}

/**
 * 请求配置接口
 */
export interface RequestConfig {
  method: HttpMethod;
  url: string;
  headers?: Record<string, string>;
  params?: Record<string, any>;
  data?: any;
  timeout?: number;
  retries?: number;
  retryDelay?: number;
  signal?: AbortSignal;
  validateStatus?: (status: number) => boolean;
  transformRequest?: (data: any) => any;
  transformResponse?: (data: any) => any;
}

/**
 * 响应接口
 */
export interface Response<T = any> {
  data: T;
  status: number;
  statusText: string;
  headers: Record<string, string>;
  config: RequestConfig;
  request?: any;
}

/**
 * 错误响应接口
 */
export interface ErrorResponse {
  message: string;
  code: string;
  status: number;
  details?: Record<string, any>;
  timestamp: string;
  path: string;
}

/**
 * API客户端接口
 */
export interface ApiClient {
  // 基础请求方法
  request<T = any>(config: RequestConfig): Promise<Response<T>>;
  
  // HTTP方法快捷方式
  get<T = any>(url: string, config?: Partial<RequestConfig>): Promise<Response<T>>;
  post<T = any>(url: string, data?: any, config?: Partial<RequestConfig>): Promise<Response<T>>;
  put<T = any>(url: string, data?: any, config?: Partial<RequestConfig>): Promise<Response<T>>;
  patch<T = any>(url: string, data?: any, config?: Partial<RequestConfig>): Promise<Response<T>>;
  delete<T = any>(url: string, config?: Partial<RequestConfig>): Promise<Response<T>>;
  head<T = any>(url: string, config?: Partial<RequestConfig>): Promise<Response<T>>;
  options<T = any>(url: string, config?: Partial<RequestConfig>): Promise<Response<T>>;
  
  // 拦截器
  interceptors: {
    request: {
      use(onFulfilled: (config: RequestConfig) => RequestConfig | Promise<RequestConfig>): number;
      eject(id: number): void;
    };
    response: {
      use<T>(
        onFulfilled: (response: Response<T>) => Response<T> | Promise<Response<T>>,
        onRejected?: (error: any) => any
      ): number;
      eject(id: number): void;
    };
  };
  
  // 默认配置
  defaults: Partial<RequestConfig>;
  
  // 创建实例
  create(config?: Partial<RequestConfig>): ApiClient;
}

/**
 * API端点定义
 */
export interface ApiEndpoints {
  // 认证相关
  auth: {
    login: { method: HttpMethod.POST; path: '/auth/login' };
    logout: { method: HttpMethod.POST; path: '/auth/logout' };
    refresh: { method: HttpMethod.POST; path: '/auth/refresh' };
    profile: { method: HttpMethod.GET; path: '/auth/profile' };
  };
  
  // 标签组相关
  tabGroups: {
    list: { method: HttpMethod.GET; path: '/tab-groups' };
    create: { method: HttpMethod.POST; path: '/tab-groups' };
    get: { method: HttpMethod.GET; path: '/tab-groups/:id' };
    update: { method: HttpMethod.PUT; path: '/tab-groups/:id' };
    delete: { method: HttpMethod.DELETE; path: '/tab-groups/:id' };
    sync: { method: HttpMethod.POST; path: '/tab-groups/:id/sync' };
  };
  
  // 标签相关
  tabs: {
    list: { method: HttpMethod.GET; path: '/tabs' };
    create: { method: HttpMethod.POST; path: '/tabs' };
    get: { method: HttpMethod.GET; path: '/tabs/:id' };
    update: { method: HttpMethod.PUT; path: '/tabs/:id' };
    delete: { method: HttpMethod.DELETE; path: '/tabs/:id' };
    move: { method: HttpMethod.POST; path: '/tabs/:id/move' };
  };
  
  // 同步相关
  sync: {
    status: { method: HttpMethod.GET; path: '/sync/status' };
    start: { method: HttpMethod.POST; path: '/sync/start' };
    conflicts: { method: HttpMethod.GET; path: '/sync/conflicts' };
    resolve: { method: HttpMethod.POST; path: '/sync/conflicts/:id/resolve' };
  };
  
  // 设置相关
  settings: {
    get: { method: HttpMethod.GET; path: '/settings' };
    update: { method: HttpMethod.PUT; path: '/settings' };
    reset: { method: HttpMethod.POST; path: '/settings/reset' };
  };
  
  // 搜索相关
  search: {
    tabs: { method: HttpMethod.GET; path: '/search/tabs' };
    groups: { method: HttpMethod.GET; path: '/search/groups' };
    history: { method: HttpMethod.GET; path: '/search/history' };
  };
  
  // 导入导出相关
  import: {
    upload: { method: HttpMethod.POST; path: '/import/upload' };
    process: { method: HttpMethod.POST; path: '/import/process' };
    status: { method: HttpMethod.GET; path: '/import/status/:id' };
  };
  
  export: {
    create: { method: HttpMethod.POST; path: '/export/create' };
    download: { method: HttpMethod.GET; path: '/export/download/:id' };
    status: { method: HttpMethod.GET; path: '/export/status/:id' };
  };
}

/**
 * 请求/响应类型映射
 */
export interface ApiTypeMap {
  // 认证相关
  'POST /auth/login': {
    request: { email: string; password: string };
    response: { token: string; refreshToken: string; user: any };
  };
  
  'POST /auth/logout': {
    request: {};
    response: { success: boolean };
  };
  
  'POST /auth/refresh': {
    request: { refreshToken: string };
    response: { token: string; refreshToken: string };
  };
  
  'GET /auth/profile': {
    request: {};
    response: any; // User type
  };
  
  // 标签组相关
  'GET /tab-groups': {
    request: PaginationParams & { search?: string; sortBy?: string };
    response: PaginatedResult<any>; // TabGroup type
  };
  
  'POST /tab-groups': {
    request: { name: string; tabs?: any[]; metadata?: Record<string, any> };
    response: any; // TabGroup type
  };
  
  'GET /tab-groups/:id': {
    request: { id: string };
    response: any; // TabGroup type
  };
  
  'PUT /tab-groups/:id': {
    request: { id: string; name?: string; metadata?: Record<string, any> };
    response: any; // TabGroup type
  };
  
  'DELETE /tab-groups/:id': {
    request: { id: string };
    response: { success: boolean };
  };
  
  'POST /tab-groups/:id/sync': {
    request: { id: string; force?: boolean };
    response: { syncId: string; status: string };
  };
  
  // 标签相关
  'GET /tabs': {
    request: PaginationParams & { groupId?: string; search?: string };
    response: PaginatedResult<any>; // Tab type
  };
  
  'POST /tabs': {
    request: { url: string; title: string; groupId?: string; metadata?: Record<string, any> };
    response: any; // Tab type
  };
  
  'GET /tabs/:id': {
    request: { id: string };
    response: any; // Tab type
  };
  
  'PUT /tabs/:id': {
    request: { id: string; title?: string; url?: string; metadata?: Record<string, any> };
    response: any; // Tab type
  };
  
  'DELETE /tabs/:id': {
    request: { id: string };
    response: { success: boolean };
  };
  
  'POST /tabs/:id/move': {
    request: { id: string; targetGroupId: string; position?: number };
    response: { success: boolean };
  };
  
  // 同步相关
  'GET /sync/status': {
    request: {};
    response: {
      status: 'idle' | 'syncing' | 'error';
      lastSync?: string;
      conflicts: number;
    };
  };
  
  'POST /sync/start': {
    request: { force?: boolean };
    response: { syncId: string; status: string };
  };
  
  'GET /sync/conflicts': {
    request: PaginationParams;
    response: PaginatedResult<any>; // SyncConflict type
  };
  
  'POST /sync/conflicts/:id/resolve': {
    request: { id: string; resolution: 'local' | 'remote' | 'merge'; data?: any };
    response: { success: boolean };
  };
  
  // 设置相关
  'GET /settings': {
    request: {};
    response: any; // UserSettings type
  };
  
  'PUT /settings': {
    request: Partial<any>; // UserSettings type
    response: any; // UserSettings type
  };
  
  'POST /settings/reset': {
    request: { section?: string };
    response: { success: boolean };
  };
  
  // 搜索相关
  'GET /search/tabs': {
    request: {
      query: string;
      filters?: Record<string, any>;
      pagination?: PaginationParams;
    };
    response: PaginatedResult<any>; // Tab type
  };
  
  'GET /search/groups': {
    request: {
      query: string;
      filters?: Record<string, any>;
      pagination?: PaginationParams;
    };
    response: PaginatedResult<any>; // TabGroup type
  };
  
  'GET /search/history': {
    request: PaginationParams;
    response: PaginatedResult<{ query: string; timestamp: string; results: number }>;
  };
  
  // 导入导出相关
  'POST /import/upload': {
    request: FormData;
    response: { uploadId: string; filename: string; size: number };
  };
  
  'POST /import/process': {
    request: { uploadId: string; format: string; options?: Record<string, any> };
    response: { processId: string; status: string };
  };
  
  'GET /import/status/:id': {
    request: { id: string };
    response: {
      status: 'pending' | 'processing' | 'completed' | 'failed';
      progress?: number;
      result?: { imported: number; errors: number; warnings: number };
      error?: string;
    };
  };
  
  'POST /export/create': {
    request: {
      format: string;
      filters?: Record<string, any>;
      options?: Record<string, any>;
    };
    response: { exportId: string; status: string };
  };
  
  'GET /export/download/:id': {
    request: { id: string };
    response: Blob;
  };
  
  'GET /export/status/:id': {
    request: { id: string };
    response: {
      status: 'pending' | 'processing' | 'completed' | 'failed';
      progress?: number;
      downloadUrl?: string;
      error?: string;
    };
  };
}

/**
 * 类型安全的API客户端
 */
export interface TypedApiClient {
  // 类型安全的请求方法
  request<K extends keyof ApiTypeMap>(
    endpoint: K,
    data: ApiTypeMap[K]['request'],
    config?: Partial<RequestConfig>
  ): Promise<ApiResponse<ApiTypeMap[K]['response']>>;
  
  // 批量请求
  batch<K extends keyof ApiTypeMap>(
    requests: Array<{
      endpoint: K;
      data: ApiTypeMap[K]['request'];
      config?: Partial<RequestConfig>;
    }>
  ): Promise<Array<ApiResponse<ApiTypeMap[K]['response']>>>;
  
  // 流式请求
  stream<K extends keyof ApiTypeMap>(
    endpoint: K,
    data: ApiTypeMap[K]['request'],
    config?: Partial<RequestConfig>
  ): AsyncIterable<ApiTypeMap[K]['response']>;
}

/**
 * API错误类型
 */
export class ApiError extends Error {
  constructor(
    public response: ErrorResponse,
    public config: RequestConfig
  ) {
    super(response.message);
    this.name = 'ApiError';
  }
}

/**
 * 网络错误类型
 */
export class NetworkError extends Error {
  constructor(
    message: string,
    public config: RequestConfig
  ) {
    super(message);
    this.name = 'NetworkError';
  }
}

/**
 * 超时错误类型
 */
export class TimeoutError extends Error {
  constructor(
    public timeout: number,
    public config: RequestConfig
  ) {
    super(`Request timeout after ${timeout}ms`);
    this.name = 'TimeoutError';
  }
}

/**
 * 取消错误类型
 */
export class CancelError extends Error {
  constructor(message: string = 'Request was cancelled') {
    super(message);
    this.name = 'CancelError';
  }
}
