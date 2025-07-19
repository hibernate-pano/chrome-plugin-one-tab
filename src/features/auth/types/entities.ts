/**
 * 认证领域实体定义
 * 遵循领域驱动设计(DDD)原则，定义认证相关的核心业务实体和值对象
 */

/**
 * 用户实体 (Entity)
 * 用户是认证领域的核心实体
 */
export interface User {
  // 实体标识
  readonly id: string;
  
  // 基本信息
  email: string;
  username?: string;
  displayName?: string;
  avatar?: string;
  
  // 认证信息
  emailVerified: boolean;
  phoneVerified: boolean;
  
  // 时间戳
  readonly createdAt: string;
  updatedAt: string;
  lastLoginAt?: string;
  
  // 状态
  status: UserStatus;
  
  // 配置文件
  profile: UserProfile;
  
  // 认证提供商信息
  authProviders: AuthProvider[];
  
  // 设备信息
  devices: UserDevice[];
  
  // 权限和角色
  permissions: Permission[];
  roles: Role[];
}

/**
 * 认证会话实体 (Entity)
 * 管理用户的认证会话
 */
export interface AuthSession {
  // 实体标识
  readonly id: string;
  
  // 关联用户
  userId: string;
  
  // 会话信息
  accessToken: string;
  refreshToken?: string;
  expiresAt: string;
  
  // 设备信息
  deviceId: string;
  deviceInfo: DeviceInfo;
  
  // 会话状态
  status: SessionStatus;
  
  // 时间戳
  readonly createdAt: string;
  lastActiveAt: string;
  
  // 安全信息
  ipAddress?: string;
  userAgent?: string;
  location?: GeoLocation;
}

/**
 * 用户配置文件值对象 (Value Object)
 */
export interface UserProfile {
  // 个人信息
  firstName?: string;
  lastName?: string;
  dateOfBirth?: string;
  gender?: 'male' | 'female' | 'other' | 'prefer-not-to-say';
  
  // 联系信息
  phone?: string;
  address?: Address;
  
  // 偏好设置
  language: string;
  timezone: string;
  theme: 'light' | 'dark' | 'auto';
  
  // 通知设置
  notifications: NotificationSettings;
  
  // 隐私设置
  privacy: PrivacySettings;
}

/**
 * 认证提供商值对象 (Value Object)
 */
export interface AuthProvider {
  // 提供商信息
  provider: AuthProviderType;
  providerId: string;
  
  // 认证信息
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: string;
  
  // 提供商特定数据
  providerData: Record<string, any>;
  
  // 状态
  isActive: boolean;
  isPrimary: boolean;
  
  // 时间戳
  connectedAt: string;
  lastUsedAt?: string;
}

/**
 * 用户设备值对象 (Value Object)
 */
export interface UserDevice {
  // 设备标识
  deviceId: string;
  deviceName: string;
  
  // 设备信息
  deviceType: DeviceType;
  platform: string;
  browser?: string;
  
  // 状态
  isActive: boolean;
  isTrusted: boolean;
  
  // 时间戳
  firstSeenAt: string;
  lastSeenAt: string;
  
  // 位置信息
  lastLocation?: GeoLocation;
}

/**
 * 设备信息值对象 (Value Object)
 */
export interface DeviceInfo {
  type: DeviceType;
  platform: string;
  browser?: string;
  version?: string;
  fingerprint: string;
}

/**
 * 地理位置值对象 (Value Object)
 */
export interface GeoLocation {
  country?: string;
  region?: string;
  city?: string;
  latitude?: number;
  longitude?: number;
  accuracy?: number;
}

/**
 * 地址值对象 (Value Object)
 */
export interface Address {
  street?: string;
  city?: string;
  state?: string;
  country?: string;
  postalCode?: string;
}

/**
 * 通知设置值对象 (Value Object)
 */
export interface NotificationSettings {
  email: {
    enabled: boolean;
    marketing: boolean;
    security: boolean;
    updates: boolean;
  };
  push: {
    enabled: boolean;
    sync: boolean;
    reminders: boolean;
  };
  inApp: {
    enabled: boolean;
    sound: boolean;
    vibration: boolean;
  };
}

/**
 * 隐私设置值对象 (Value Object)
 */
export interface PrivacySettings {
  profileVisibility: 'public' | 'private' | 'friends';
  dataSharing: boolean;
  analytics: boolean;
  advertising: boolean;
  locationTracking: boolean;
}

/**
 * 权限值对象 (Value Object)
 */
export interface Permission {
  id: string;
  name: string;
  resource: string;
  action: string;
  conditions?: Record<string, any>;
}

/**
 * 角色值对象 (Value Object)
 */
export interface Role {
  id: string;
  name: string;
  description?: string;
  permissions: string[]; // Permission IDs
}

/**
 * 枚举类型定义
 */

/**
 * 用户状态枚举
 */
export enum UserStatus {
  ACTIVE = 'active',
  INACTIVE = 'inactive',
  SUSPENDED = 'suspended',
  PENDING_VERIFICATION = 'pending-verification',
  DELETED = 'deleted'
}

/**
 * 会话状态枚举
 */
export enum SessionStatus {
  ACTIVE = 'active',
  EXPIRED = 'expired',
  REVOKED = 'revoked',
  INVALID = 'invalid'
}

/**
 * 认证提供商类型枚举
 */
export enum AuthProviderType {
  EMAIL = 'email',
  GOOGLE = 'google',
  GITHUB = 'github',
  MICROSOFT = 'microsoft',
  APPLE = 'apple',
  WECHAT = 'wechat',
  FACEBOOK = 'facebook',
  TWITTER = 'twitter'
}

/**
 * 设备类型枚举
 */
export enum DeviceType {
  DESKTOP = 'desktop',
  MOBILE = 'mobile',
  TABLET = 'tablet',
  EXTENSION = 'extension',
  UNKNOWN = 'unknown'
}

/**
 * 领域事件定义
 */

/**
 * 用户相关事件
 */
export interface UserRegisteredEvent extends DomainEvent {
  type: 'UserRegistered';
  data: {
    user: User;
    provider: AuthProviderType;
  };
}

export interface UserLoginEvent extends DomainEvent {
  type: 'UserLogin';
  data: {
    userId: string;
    sessionId: string;
    provider: AuthProviderType;
    deviceInfo: DeviceInfo;
  };
}

export interface UserLogoutEvent extends DomainEvent {
  type: 'UserLogout';
  data: {
    userId: string;
    sessionId: string;
    reason: 'manual' | 'timeout' | 'revoked';
  };
}

export interface UserProfileUpdatedEvent extends DomainEvent {
  type: 'UserProfileUpdated';
  data: {
    userId: string;
    changes: Partial<UserProfile>;
    previousProfile: UserProfile;
  };
}

/**
 * 认证相关事件
 */
export interface AuthProviderConnectedEvent extends DomainEvent {
  type: 'AuthProviderConnected';
  data: {
    userId: string;
    provider: AuthProvider;
  };
}

export interface AuthProviderDisconnectedEvent extends DomainEvent {
  type: 'AuthProviderDisconnected';
  data: {
    userId: string;
    provider: AuthProviderType;
    providerId: string;
  };
}

export interface SessionExpiredEvent extends DomainEvent {
  type: 'SessionExpired';
  data: {
    sessionId: string;
    userId: string;
    expirationReason: 'timeout' | 'inactivity' | 'security';
  };
}

/**
 * 基础领域事件接口
 */
export interface DomainEvent {
  readonly id: string;
  readonly type: string;
  readonly aggregateId: string;
  readonly timestamp: string;
  readonly version: number;
  readonly data: Record<string, any>;
}

/**
 * 认证凭据值对象 (Value Object)
 */
export interface AuthCredentials {
  type: 'password' | 'oauth' | 'token' | 'biometric';
  value: string;
  metadata?: Record<string, any>;
}

/**
 * OAuth状态值对象 (Value Object)
 */
export interface OAuthState {
  state: string;
  provider: AuthProviderType;
  redirectUri: string;
  scopes: string[];
  expiresAt: string;
  codeChallenge?: string;
  codeChallengeMethod?: string;
}

/**
 * 创建数据传输对象
 */
export interface CreateUserData {
  email: string;
  username?: string;
  displayName?: string;
  password?: string;
  provider: AuthProviderType;
  providerData?: Record<string, any>;
  profile?: Partial<UserProfile>;
}

export interface CreateSessionData {
  userId: string;
  deviceInfo: DeviceInfo;
  ipAddress?: string;
  userAgent?: string;
  location?: GeoLocation;
  expiresIn?: number; // seconds
}

/**
 * 查询对象
 */
export interface UserQuery {
  email?: string;
  username?: string;
  status?: UserStatus;
  provider?: AuthProviderType;
  dateRange?: {
    start: string;
    end: string;
  };
  limit?: number;
  offset?: number;
  sortBy?: 'createdAt' | 'lastLoginAt' | 'email' | 'username';
  sortOrder?: 'asc' | 'desc';
}

export interface SessionQuery {
  userId?: string;
  deviceId?: string;
  status?: SessionStatus;
  dateRange?: {
    start: string;
    end: string;
  };
  limit?: number;
  offset?: number;
  sortBy?: 'createdAt' | 'lastActiveAt' | 'expiresAt';
  sortOrder?: 'asc' | 'desc';
}

/**
 * 仓储接口定义
 */
export interface UserRepository {
  findById(id: string): Promise<User | null>;
  findByEmail(email: string): Promise<User | null>;
  findByUsername(username: string): Promise<User | null>;
  findByQuery(query: UserQuery): Promise<User[]>;
  save(user: User): Promise<void>;
  delete(id: string): Promise<void>;
  count(query?: UserQuery): Promise<number>;
}

export interface SessionRepository {
  findById(id: string): Promise<AuthSession | null>;
  findByUserId(userId: string): Promise<AuthSession[]>;
  findByQuery(query: SessionQuery): Promise<AuthSession[]>;
  save(session: AuthSession): Promise<void>;
  delete(id: string): Promise<void>;
  deleteExpired(): Promise<number>;
  count(query?: SessionQuery): Promise<number>;
}

/**
 * 领域服务接口
 */
export interface UserDomainService {
  createUser(data: CreateUserData): Promise<User>;
  updateUser(id: string, updates: Partial<User>): Promise<User>;
  deleteUser(id: string): Promise<void>;
  validateUser(user: User): ValidationResult;
  changePassword(userId: string, oldPassword: string, newPassword: string): Promise<void>;
  verifyEmail(userId: string, token: string): Promise<void>;
}

export interface AuthDomainService {
  authenticate(credentials: AuthCredentials): Promise<AuthSession>;
  createSession(data: CreateSessionData): Promise<AuthSession>;
  refreshSession(sessionId: string): Promise<AuthSession>;
  revokeSession(sessionId: string): Promise<void>;
  validateSession(sessionId: string): Promise<boolean>;
}

/**
 * 验证结果接口
 */
export interface ValidationResult {
  isValid: boolean;
  errors: ValidationError[];
  warnings: ValidationWarning[];
}

export interface ValidationError {
  field: string;
  message: string;
  code: string;
}

export interface ValidationWarning {
  field: string;
  message: string;
  code: string;
}

/**
 * 工厂接口
 */
export interface UserFactory {
  createUser(data: CreateUserData): User;
  createUserFromOAuth(provider: AuthProviderType, oauthData: Record<string, any>): User;
}

export interface SessionFactory {
  createSession(data: CreateSessionData): AuthSession;
  createSessionFromToken(token: string, deviceInfo: DeviceInfo): AuthSession;
}
